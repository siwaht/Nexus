import path from 'node:path';

import { db, fileChunksTable, filesTable, type FileRow } from '@workspace/db';
import { eq } from 'drizzle-orm';

import {
  completeChat,
  logUsage,
  ProviderError,
  resolveModelForTask,
  transcribe,
} from '../ai';
import { extractFromHtml } from '../browser/html';
import { publish } from '../events';
import { chunkSegments, embedChunks, type SourceSegment } from '../rag';
import { safeExtension, sanitizeFilename, storage } from '../storage';
import {
  expandArchive,
  extractDocx,
  extractEpub,
  extractPptx,
  extractXlsx,
  type ExtractedDocument,
} from './office';
import { extractPdf } from './pdf';
import {
  extractKeyframes,
  formatTimestamp,
  mediaToolsAvailable,
  probeMedia,
  splitAudio,
  toWav16kMono,
} from './media';

/**
 * One ingestion pipeline, branched by file type.
 *
 * Every path converges on the same tail: segments → chunks → embeddings →
 * ready. Status moves queued → extracting → chunking → embedding → ready, or
 * failed with a reason the user can act on. Nothing here blocks the chat UI;
 * the route kicks this off and returns immediately.
 */

export type FileKind =
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'ebook'
  | 'text'
  | 'code'
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'other';

export const MAX_UPLOAD_BYTES = Number(
  process.env.MAX_UPLOAD_BYTES ?? 200 * 1024 * 1024,
);

const EXTENSION_KINDS: Record<string, FileKind> = {
  '.pdf': 'pdf',
  '.docx': 'document',
  '.doc': 'document',
  '.rtf': 'text',
  '.odt': 'document',
  '.xlsx': 'spreadsheet',
  '.xlsm': 'spreadsheet',
  '.pptx': 'presentation',
  '.epub': 'ebook',
  '.mobi': 'ebook',
  '.azw3': 'ebook',
  '.txt': 'text',
  '.md': 'text',
  '.markdown': 'text',
  '.csv': 'text',
  '.tsv': 'text',
  '.json': 'code',
  '.yaml': 'code',
  '.yml': 'code',
  '.xml': 'code',
  '.html': 'text',
  '.htm': 'text',
  '.ts': 'code',
  '.tsx': 'code',
  '.js': 'code',
  '.jsx': 'code',
  '.py': 'code',
  '.rb': 'code',
  '.go': 'code',
  '.rs': 'code',
  '.java': 'code',
  '.kt': 'code',
  '.swift': 'code',
  '.c': 'code',
  '.h': 'code',
  '.cpp': 'code',
  '.cs': 'code',
  '.php': 'code',
  '.sh': 'code',
  '.sql': 'code',
  '.css': 'code',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.bmp': 'image',
  '.heic': 'image',
  '.svg': 'image',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.ogg': 'audio',
  '.oga': 'audio',
  '.flac': 'audio',
  '.aac': 'audio',
  '.mp4': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.mkv': 'video',
  '.avi': 'video',
  '.zip': 'archive',
};

/** Mirrors the vision providers' accepted image types. */
const VISION_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export function classifyFile(filename: string, mime: string): FileKind {
  const extension = path.extname(filename).toLowerCase();
  const byExtension = EXTENSION_KINDS[extension];
  if (byExtension) return byExtension;

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/zip') return 'archive';
  if (mime.startsWith('text/')) return 'text';
  if (mime.includes('json') || mime.includes('xml')) return 'code';
  if (mime.includes('wordprocessingml')) return 'document';
  if (mime.includes('spreadsheetml')) return 'spreadsheet';
  if (mime.includes('presentationml')) return 'presentation';
  if (mime.includes('epub')) return 'ebook';
  return 'other';
}

export function isUploadAllowed(
  filename: string,
  mime: string,
): { ok: true } | { ok: false; reason: string } {
  const kind = classifyFile(filename, mime);
  if (kind === 'other') {
    return {
      ok: false,
      reason: `"${path.extname(filename) || mime || 'this file type'}" isn't supported. Nexus reads PDF, Office and OpenDocument files, ebooks, text and code, images, audio, video, and zip archives.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type IngestStatus =
  | 'queued'
  | 'extracting'
  | 'chunking'
  | 'embedding'
  | 'ready'
  | 'failed';

function fileChannel(fileId: number): string {
  return `file:${fileId}`;
}

async function setStatus(
  fileId: number,
  status: IngestStatus,
  patch: Partial<FileRow> = {},
): Promise<void> {
  await db
    .update(filesTable)
    .set({ status, ...patch })
    .where(eq(filesTable.id, fileId));
  publish(fileChannel(fileId), 'status', { fileId, status, ...patch });
}

// ---------------------------------------------------------------------------
// Text-ish extraction
// ---------------------------------------------------------------------------

function extractPlainText(
  buffer: Buffer,
  filename: string,
  kind: FileKind,
): ExtractedDocument {
  const raw = buffer.toString('utf8');
  const extension = path.extname(filename).toLowerCase();

  if (extension === '.html' || extension === '.htm') {
    const page = extractFromHtml(raw);
    return {
      segments: [{ locator: null, text: page.markdown }],
      metadata: { title: page.title },
      pageCount: null,
    };
  }

  if (extension === '.csv' || extension === '.tsv') {
    const delimiter = extension === '.tsv' ? '\t' : ',';
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length > 0) {
      const rows = lines.slice(0, 5000).map((line) =>
        line.split(delimiter).map((cell) => cell.replace(/\|/g, '\\|').trim()),
      );
      const width = Math.max(...rows.map((row) => row.length));
      const pad = (row: string[]) =>
        `| ${[...row, ...Array(width - row.length).fill('')].join(' | ')} |`;
      const [head, ...body] = rows;
      const table = [
        pad(head),
        `| ${Array(width).fill('---').join(' | ')} |`,
        ...body.map(pad),
      ].join('\n');
      return {
        segments: [{ locator: null, text: table }],
        metadata: { rows: rows.length, columns: width },
        pageCount: null,
      };
    }
  }

  if (kind === 'code') {
    // Keep line numbers so a citation can point at a line.
    const lines = raw.split(/\r?\n/);
    const language = extension.replace('.', '');
    const numbered = lines
      .map((line, index) => `${String(index + 1).padStart(4)} ${line}`)
      .join('\n');
    return {
      segments: [{ locator: null, text: `\`\`\`${language}\n${numbered}\n\`\`\`` }],
      metadata: { language, lineCount: lines.length },
      pageCount: null,
    };
  }

  // Markdown and plain text: split on top-level headings for citations.
  const sections = raw.split(/\n(?=#{1,3}\s)/);
  if (sections.length > 1) {
    return {
      segments: sections
        .map((section) => ({
          locator: /^#{1,3}\s*(.+)$/m.exec(section)?.[1]?.slice(0, 120) ?? null,
          text: section.trim(),
        }))
        .filter((segment) => segment.text.length > 0),
      metadata: {},
      pageCount: null,
    };
  }
  return {
    segments: [{ locator: null, text: raw }],
    metadata: {},
    pageCount: null,
  };
}

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

const VISION_PROMPT =
  'Describe this image in detail and transcribe every piece of visible text verbatim. If there is no text, say so. Structure your answer as: Description, then Text.';

async function describeImage(
  userId: string,
  data: Buffer,
  mime: string,
  prompt = VISION_PROMPT,
): Promise<string> {
  const modelRef = await resolveModelForTask(userId, 'vision');
  const usableMime = VISION_MIMES.has(mime) ? mime : 'image/png';
  const dataUrl = `data:${usableMime};base64,${data.toString('base64')}`;
  const started = Date.now();

  const result = await completeChat(userId, {
    modelRef,
    temperature: 0.2,
    maxTokens: 1200,
    messages: [
      {
        role: 'user',
        content: prompt,
        attachments: [{ imageUrl: dataUrl }],
      },
    ],
  });
  await logUsage({
    userId,
    modelRef,
    operation: 'chat',
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    latencyMs: Date.now() - started,
  });
  return result.content.trim();
}

// ---------------------------------------------------------------------------
// Audio and video
// ---------------------------------------------------------------------------

interface TranscriptOutcome {
  segments: SourceSegment[];
  durationS: number | null;
  transcriptSegments: Array<{ start: number; end: number; text: string }>;
}

async function transcribeMedia(
  userId: string,
  data: Buffer,
  filename: string,
  mime: string,
): Promise<TranscriptOutcome> {
  const modelRef = await resolveModelForTask(userId, 'transcription');
  const extension = safeExtension(filename) || '.bin';
  const tools = await mediaToolsAvailable();

  // Long recordings are windowed so a model with a duration cap still works.
  let windows: Array<{ startS: number; data: Buffer; mime: string }>;
  if (tools.ffmpeg) {
    const chunks = await splitAudio(data, extension);
    windows =
      chunks.length > 0
        ? chunks.map((chunk) => ({
            startS: chunk.startS,
            data: chunk.data,
            mime: 'audio/wav',
          }))
        : [{ startS: 0, data: await toWav16kMono(data, extension), mime: 'audio/wav' }];
  } else {
    // Without ffmpeg, send the original bytes and let the provider decide.
    windows = [{ startS: 0, data, mime }];
  }

  const allSegments: Array<{ start: number; end: number; text: string }> = [];
  let totalDuration = 0;

  for (const window of windows) {
    const started = Date.now();
    const result = await transcribe(userId, {
      modelRef,
      audio: window.data,
      mime: window.mime,
      filename: `chunk${window.startS}.wav`,
    });
    await logUsage({
      userId,
      modelRef,
      operation: 'transcribe',
      units: result.durationS,
      latencyMs: Date.now() - started,
    });

    if (result.segments.length > 0) {
      for (const segment of result.segments) {
        allSegments.push({
          start: segment.start + window.startS,
          end: segment.end + window.startS,
          text: segment.text,
        });
      }
    } else if (result.text) {
      allSegments.push({
        start: window.startS,
        end: window.startS + (result.durationS ?? 0),
        text: result.text,
      });
    }
    totalDuration = Math.max(
      totalDuration,
      window.startS + (result.durationS ?? 0),
    );
  }

  // Group transcript segments into ~2-minute passages so each chunk carries a
  // timestamp a user can click.
  const GROUP_S = 120;
  const grouped: SourceSegment[] = [];
  let bucketStart = 0;
  let bucket: string[] = [];
  const flush = () => {
    const text = bucket.join(' ').trim();
    if (text) {
      grouped.push({ locator: formatTimestamp(bucketStart), text });
    }
    bucket = [];
  };
  for (const segment of allSegments) {
    if (bucket.length > 0 && segment.start - bucketStart >= GROUP_S) {
      flush();
      bucketStart = segment.start;
    }
    if (bucket.length === 0) bucketStart = segment.start;
    bucket.push(segment.text);
  }
  flush();

  return {
    segments: grouped,
    durationS: totalDuration > 0 ? totalDuration : null,
    transcriptSegments: allSegments,
  };
}

async function captionKeyframes(
  userId: string,
  data: Buffer,
  filename: string,
): Promise<SourceSegment[]> {
  const extension = safeExtension(filename) || '.mp4';
  const frames = await extractKeyframes(data, extension).catch(() => []);
  const segments: SourceSegment[] = [];

  for (const frame of frames) {
    try {
      const caption = await describeImage(
        userId,
        frame.png,
        'image/png',
        'Describe what is on screen in this video frame, including any visible text, slides, charts or code. Be concise.',
      );
      if (caption) {
        segments.push({
          locator: `${formatTimestamp(frame.atS)} (frame)`,
          text: `On screen at ${formatTimestamp(frame.atS)}: ${caption}`,
        });
      }
    } catch {
      // One failed frame shouldn't abort the whole ingestion.
    }
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface IngestOutcome {
  fileId: number;
  status: 'ready' | 'failed';
  chunkCount: number;
  error: string | null;
}

/**
 * Run the pipeline for one uploaded file. Called fire-and-forget from the
 * upload route; every failure is recorded on the row with a readable reason.
 */
export async function ingestFile(
  userId: string,
  fileId: number,
): Promise<IngestOutcome> {
  const [row] = await db
    .select()
    .from(filesTable)
    .where(eq(filesTable.id, fileId));
  if (!row || row.userId !== userId) {
    return { fileId, status: 'failed', chunkCount: 0, error: 'File not found.' };
  }

  try {
    await setStatus(fileId, 'extracting', { progress: 10, error: null });
    const buffer = await storage.get(row.storageKey);
    const kind = row.kind as FileKind;

    let extracted: ExtractedDocument;
    let durationS: number | null = null;
    let extraMetadata: Record<string, unknown> = {};

    switch (kind) {
      case 'pdf': {
        const pdf = await extractPdf(buffer);
        extracted = pdf;
        if (pdf.segments.length === 0) {
          throw new Error(
            `No text layer found on any of the ${pdf.pageCount ?? 0} pages — this looks like a scanned PDF. Export it with OCR, or upload the pages as images so the vision model can read them.`,
          );
        }
        if (pdf.pagesWithoutText.length > 0) {
          extraMetadata.pagesWithoutText = pdf.pagesWithoutText;
        }
        break;
      }
      case 'document':
        extracted = extractDocx(buffer);
        break;
      case 'spreadsheet':
        extracted = extractXlsx(buffer);
        break;
      case 'presentation':
        extracted = extractPptx(buffer);
        break;
      case 'ebook':
        extracted = extractEpub(buffer);
        break;
      case 'text':
      case 'code':
        extracted = extractPlainText(buffer, row.filename, kind);
        break;
      case 'image': {
        const description = await describeImage(userId, buffer, row.mime);
        if (!description) throw new Error('The vision model returned no description.');
        extracted = {
          segments: [{ locator: null, text: description }],
          metadata: { visionDescribed: true },
          pageCount: null,
        };
        break;
      }
      case 'audio': {
        const outcome = await transcribeMedia(
          userId,
          buffer,
          row.filename,
          row.mime,
        );
        if (outcome.segments.length === 0) {
          throw new Error('The transcription came back empty.');
        }
        extracted = {
          segments: outcome.segments,
          metadata: { transcriptSegments: outcome.transcriptSegments },
          pageCount: null,
        };
        durationS = outcome.durationS;
        break;
      }
      case 'video': {
        const info = await probeMedia(
          buffer,
          safeExtension(row.filename) || '.mp4',
        ).catch(() => null);
        const segments: SourceSegment[] = [];
        let transcriptSegments: Array<{
          start: number;
          end: number;
          text: string;
        }> = [];

        if (info?.hasAudio !== false) {
          const outcome = await transcribeMedia(
            userId,
            buffer,
            row.filename,
            row.mime,
          );
          segments.push(...outcome.segments);
          transcriptSegments = outcome.transcriptSegments;
          durationS = outcome.durationS ?? info?.durationS ?? null;
        } else {
          durationS = info?.durationS ?? null;
        }

        const frames = await captionKeyframes(userId, buffer, row.filename);
        segments.push(...frames);

        if (segments.length === 0) {
          throw new Error(
            'Nothing could be extracted — no speech was transcribed and no frames could be sampled. Check that ffmpeg is installed.',
          );
        }
        extracted = {
          segments,
          metadata: {
            transcriptSegments,
            frameCount: frames.length,
            // The UI states this plainly so nobody assumes native video understanding.
            handling: 'audio transcript plus sampled frame captions',
          },
          pageCount: null,
        };
        break;
      }
      case 'archive': {
        const members = expandArchive(buffer, (name) => {
          const memberKind = classifyFile(name, '');
          return memberKind !== 'other' && memberKind !== 'archive';
        });
        if (members.length === 0) {
          throw new Error('This archive has no files Nexus can read.');
        }
        const created: number[] = [];
        for (const member of members) {
          const childId = await createFileRecord(userId, {
            filename: `${row.filename}/${member.name}`,
            mime: '',
            data: member.data,
          });
          created.push(childId);
          void ingestFile(userId, childId);
        }
        await setStatus(fileId, 'ready', {
          progress: 100,
          extractedText: `Archive expanded into ${created.length} files.`,
          metadataJson: { expandedInto: created },
        });
        return { fileId, status: 'ready', chunkCount: 0, error: null };
      }
      default:
        throw new Error('This file type is not supported.');
    }

    const fullText = extracted.segments
      .map((segment) =>
        segment.locator ? `[${segment.locator}]\n${segment.text}` : segment.text,
      )
      .join('\n\n');

    await setStatus(fileId, 'chunking', {
      progress: 45,
      extractedText: fullText.slice(0, 4_000_000),
      segmentsJson: extracted.segments.map((segment) => ({
        locator: segment.locator,
        length: segment.text.length,
      })),
      metadataJson: { ...extracted.metadata, ...extraMetadata },
      pageCount: extracted.pageCount,
      durationS,
    });

    const chunks = chunkSegments(extracted.segments);
    if (chunks.length === 0) {
      throw new Error('The file produced no text worth indexing.');
    }

    await db.delete(fileChunksTable).where(eq(fileChunksTable.fileId, fileId));
    const inserted = await db
      .insert(fileChunksTable)
      .values(
        chunks.map((chunk) => ({
          fileId,
          userId,
          ordinal: chunk.ordinal,
          pageOrTimestamp: chunk.locator,
          text: chunk.text,
          tokenEstimate: chunk.tokenEstimate,
        })),
      )
      .returning({ id: fileChunksTable.id, text: fileChunksTable.text });

    await setStatus(fileId, 'embedding', { progress: 70 });
    try {
      await embedChunks(
        userId,
        inserted.map((chunk) => chunk.id),
        inserted.map((chunk) => chunk.text),
      );
    } catch (err) {
      // The file is still readable and searchable by keyword without vectors,
      // so record the problem rather than discarding the whole ingestion.
      const reason =
        err instanceof ProviderError
          ? `${err.message}${err.hint ? ` ${err.hint}` : ''}`
          : 'Embedding failed.';
      await setStatus(fileId, 'ready', {
        progress: 100,
        error: `Indexed without embeddings: ${reason} Semantic search over this file won't work until you set an embedding model and re-index.`,
      });
      return {
        fileId,
        status: 'ready',
        chunkCount: inserted.length,
        error: reason,
      };
    }

    await setStatus(fileId, 'ready', { progress: 100, error: null });
    return { fileId, status: 'ready', chunkCount: inserted.length, error: null };
  } catch (err) {
    const message =
      err instanceof ProviderError
        ? `${err.message}${err.hint ? ` ${err.hint}` : ''}`
        : err instanceof Error
          ? err.message
          : 'Ingestion failed.';
    await setStatus(fileId, 'failed', { error: message.slice(0, 2000) });
    return { fileId, status: 'failed', chunkCount: 0, error: message };
  }
}

export interface CreateFileInput {
  filename: string;
  mime: string;
  data: Buffer;
}

/** Store bytes and create the DB row. Returns the new file id. */
export async function createFileRecord(
  userId: string,
  input: CreateFileInput,
): Promise<number> {
  const filename = sanitizeFilename(input.filename);
  const kind = classifyFile(filename, input.mime);
  const storageKey = await storage.put(input.data, {
    extension: safeExtension(filename),
    prefix: 'files',
  });

  const [row] = await db
    .insert(filesTable)
    .values({
      userId,
      filename,
      mime: input.mime || 'application/octet-stream',
      size: input.data.length,
      storageKey,
      kind,
      status: 'queued',
      progress: 0,
    })
    .returning({ id: filesTable.id });
  publish(fileChannel(row.id), 'status', {
    fileId: row.id,
    status: 'queued',
  });
  return row.id;
}

export async function reindexFile(
  userId: string,
  fileId: number,
): Promise<IngestOutcome> {
  await setStatus(fileId, 'queued', { progress: 0, error: null });
  return ingestFile(userId, fileId);
}

export { mediaToolsAvailable, ffmpegMissingMessage } from './media';
export { formatTimestamp } from './media';
