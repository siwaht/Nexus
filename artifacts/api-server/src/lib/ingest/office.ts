import { extractFromHtml } from '../browser/html';
import type { SourceSegment } from '../rag/chunk';
import { collectElements, xmlText, ZipArchive } from './zip';

/**
 * Extractors for the ZIP-container formats: DOCX, XLSX, PPTX and EPUB.
 *
 * Each returns segments carrying a citation anchor — a heading, a sheet name, a
 * slide number, a chapter title — so retrieved passages can always point back
 * at a location a human can find.
 */

export interface ExtractedDocument {
  segments: SourceSegment[];
  metadata: Record<string, unknown>;
  pageCount: number | null;
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

export function extractDocx(buffer: Buffer): ExtractedDocument {
  const zip = ZipArchive.open(buffer);
  const xml = zip.readText('word/document.xml');
  if (!xml) {
    throw new Error('This DOCX has no readable document body.');
  }

  // One <w:p> is one paragraph; <w:tbl> rows become markdown-ish lines.
  const blocks: string[] = [];
  const bodyPattern = /<w:(p|tbl)(?:\s[^>]*)?>([\s\S]*?)<\/w:\1>/g;
  let match: RegExpExecArray | null;

  while ((match = bodyPattern.exec(xml)) !== null) {
    const [, kind, inner] = match;
    if (kind === 'p') {
      const runs = collectElements(inner, 'w:t')
        .map((run) => xmlText(run))
        .join('');
      const heading = /<w:pStyle[^>]+w:val="Heading(\d)"/.exec(inner);
      const text = runs.trim();
      if (!text) continue;
      blocks.push(heading ? `${'#'.repeat(Number(heading[1]))} ${text}` : text);
    } else {
      const rows = collectElements(inner, 'w:tr').map((row) =>
        collectElements(row, 'w:tc')
          .map((cell) =>
            collectElements(cell, 'w:t')
              .map((run) => xmlText(run))
              .join('')
              .replace(/\|/g, '\\|')
              .trim(),
          )
          .join(' | '),
      );
      if (rows.length > 0) blocks.push(rows.map((row) => `| ${row} |`).join('\n'));
    }
  }

  // Split into segments at headings so citations name a section.
  const segments: SourceSegment[] = [];
  let currentHeading: string | null = null;
  let buffered: string[] = [];
  const flush = () => {
    const text = buffered.join('\n\n').trim();
    if (text) segments.push({ locator: currentHeading, text });
    buffered = [];
  };
  for (const block of blocks) {
    if (block.startsWith('#')) {
      flush();
      currentHeading = block.replace(/^#+\s*/, '').slice(0, 120);
    }
    buffered.push(block);
  }
  flush();

  const core = zip.readText('docProps/core.xml') ?? '';
  const title = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(core)?.[1];
  const author = /<dc:creator>([\s\S]*?)<\/dc:creator>/.exec(core)?.[1];

  return {
    segments:
      segments.length > 0
        ? segments
        : [{ locator: null, text: blocks.join('\n\n') }],
    metadata: {
      title: title ? xmlText(title) : null,
      author: author ? xmlText(author) : null,
    },
    pageCount: null,
  };
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference)?.[1] ?? 'A';
  let index = 0;
  for (const character of letters) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }
  return index - 1;
}

export function extractXlsx(buffer: Buffer): ExtractedDocument {
  const zip = ZipArchive.open(buffer);

  const sharedStrings: string[] = [];
  const sharedXml = zip.readText('xl/sharedStrings.xml');
  if (sharedXml) {
    for (const si of collectElements(sharedXml, 'si')) {
      sharedStrings.push(
        collectElements(si, 't')
          .map((t) => xmlText(t))
          .join(''),
      );
    }
  }

  // Sheet display names live in the workbook; files are sheet1.xml, sheet2.xml…
  const workbookXml = zip.readText('xl/workbook.xml') ?? '';
  const sheetNames: string[] = [];
  const namePattern = /<sheet[^>]+name="([^"]+)"/g;
  let nameMatch: RegExpExecArray | null;
  while ((nameMatch = namePattern.exec(workbookXml)) !== null) {
    sheetNames.push(xmlText(nameMatch[1]));
  }

  const sheetEntries = zip
    .find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => {
      const order = (value: string) =>
        Number(/sheet(\d+)\.xml$/.exec(value)?.[1] ?? 0);
      return order(a.name) - order(b.name);
    });

  const segments: SourceSegment[] = [];
  sheetEntries.forEach((entry, sheetIndex) => {
    const xml = zip.readEntry(entry)?.toString('utf8');
    if (!xml) return;
    const sheetName = sheetNames[sheetIndex] ?? `Sheet${sheetIndex + 1}`;

    const rows: string[][] = [];
    for (const rowXml of collectElements(xml, 'row')) {
      const cells: string[] = [];
      const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellPattern.exec(rowXml)) !== null) {
        const attributes = cellMatch[1] ?? cellMatch[3] ?? '';
        const body = cellMatch[2] ?? '';
        const reference = /r="([A-Z]+\d+)"/.exec(attributes)?.[1] ?? 'A1';
        const type = /t="([^"]+)"/.exec(attributes)?.[1];
        const rawValue =
          /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ??
          collectElements(body, 't')
            .map((t) => xmlText(t))
            .join('');

        let value = xmlText(rawValue ?? '');
        if (type === 's') {
          const index = Number.parseInt(value, 10);
          value = Number.isFinite(index) ? (sharedStrings[index] ?? '') : '';
        }
        const target = columnIndex(reference);
        while (cells.length < target) cells.push('');
        cells[target] = value.replace(/\|/g, '\\|');
      }
      if (cells.some((cell) => cell.trim().length > 0)) rows.push(cells);
    }

    if (rows.length === 0) return;
    const width = Math.max(...rows.map((row) => row.length));
    const pad = (row: string[]) =>
      `| ${[...row, ...Array(width - row.length).fill('')].join(' | ')} |`;
    const [head, ...body] = rows;
    const table = [
      pad(head),
      `| ${Array(width).fill('---').join(' | ')} |`,
      ...body.map(pad),
    ].join('\n');

    segments.push({
      locator: sheetName,
      text: `## ${sheetName}\n\n${table}`,
    });
  });

  if (segments.length === 0) {
    throw new Error('This spreadsheet has no readable cells.');
  }
  return {
    segments,
    metadata: { sheets: segments.map((segment) => segment.locator) },
    pageCount: segments.length,
  };
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

export function extractPptx(buffer: Buffer): ExtractedDocument {
  const zip = ZipArchive.open(buffer);
  const slideEntries = zip
    .find((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const order = (value: string) =>
        Number(/slide(\d+)\.xml$/.exec(value)?.[1] ?? 0);
      return order(a.name) - order(b.name);
    });

  const segments: SourceSegment[] = [];
  slideEntries.forEach((entry, index) => {
    const xml = zip.readEntry(entry)?.toString('utf8');
    if (!xml) return;
    // Each <a:p> is a text paragraph; <a:t> holds the runs.
    const lines = collectElements(xml, 'a:p')
      .map((paragraph) =>
        collectElements(paragraph, 'a:t')
          .map((run) => xmlText(run))
          .join('')
          .trim(),
      )
      .filter(Boolean);

    // The slide's notes page, when present, is genuinely useful context.
    const notesXml = zip.readText(`ppt/notesSlides/notesSlide${index + 1}.xml`);
    const notes = notesXml
      ? collectElements(notesXml, 'a:t')
          .map((run) => xmlText(run))
          .join(' ')
          .trim()
      : '';

    if (lines.length === 0 && !notes) return;
    const locator = `Slide ${index + 1}`;
    segments.push({
      locator,
      text: [
        `## ${locator}`,
        ...lines,
        notes ? `\nSpeaker notes: ${notes}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });
  });

  if (segments.length === 0) {
    throw new Error('This presentation has no readable text.');
  }
  return {
    segments,
    metadata: { slideCount: segments.length },
    pageCount: segments.length,
  };
}

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------

export function extractEpub(buffer: Buffer): ExtractedDocument {
  const zip = ZipArchive.open(buffer);

  const container = zip.readText('META-INF/container.xml');
  const opfPath =
    /full-path="([^"]+)"/.exec(container ?? '')?.[1] ??
    zip.find((name) => name.endsWith('.opf'))[0]?.name;
  if (!opfPath) {
    throw new Error('This EPUB has no package document.');
  }
  const opf = zip.readText(opfPath);
  if (!opf) throw new Error('This EPUB package document could not be read.');

  const basePath = opfPath.includes('/')
    ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1)
    : '';

  // manifest id → href, then walk the spine so chapters stay in reading order.
  const manifest = new Map<string, string>();
  const itemPattern = /<item\b([^>]*)\/?>/g;
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemPattern.exec(opf)) !== null) {
    const attributes = itemMatch[1];
    const id = /id="([^"]+)"/.exec(attributes)?.[1];
    const href = /href="([^"]+)"/.exec(attributes)?.[1];
    if (id && href) manifest.set(id, href);
  }

  const spine: string[] = [];
  const itemrefPattern = /<itemref\b[^>]*idref="([^"]+)"/g;
  let refMatch: RegExpExecArray | null;
  while ((refMatch = itemrefPattern.exec(opf)) !== null) {
    const href = manifest.get(refMatch[1]);
    if (href) spine.push(href);
  }
  const order =
    spine.length > 0
      ? spine
      : [...manifest.values()].filter((href) => /\.x?html?$/i.test(href));

  const title = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf)?.[1];
  const author = /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/.exec(opf)?.[1];

  const segments: SourceSegment[] = [];
  order.forEach((href, index) => {
    const cleanHref = href.split('#')[0];
    const html =
      zip.readText(`${basePath}${cleanHref}`) ?? zip.readText(cleanHref);
    if (!html) return;
    const extracted = extractFromHtml(html);
    const text = extracted.markdown.trim();
    if (text.length < 20) return;
    const chapterTitle =
      extracted.title?.trim() ||
      /^#+\s*(.+)$/m.exec(text)?.[1]?.trim() ||
      `Chapter ${index + 1}`;
    segments.push({
      locator: chapterTitle.slice(0, 120),
      text,
    });
  });

  if (segments.length === 0) {
    throw new Error('This EPUB has no readable chapters.');
  }
  return {
    segments,
    metadata: {
      title: title ? xmlText(title) : null,
      author: author ? xmlText(author) : null,
      chapters: segments.map((segment) => segment.locator),
    },
    pageCount: segments.length,
  };
}

// ---------------------------------------------------------------------------
// Generic ZIP archive
// ---------------------------------------------------------------------------

export interface ArchiveMember {
  name: string;
  data: Buffer;
}

/** Expand an archive's supported members so each can be ingested on its own. */
export function expandArchive(
  buffer: Buffer,
  isSupported: (name: string) => boolean,
  limits: { maxMembers?: number; maxBytes?: number } = {},
): ArchiveMember[] {
  const zip = ZipArchive.open(buffer);
  const maxMembers = limits.maxMembers ?? 50;
  const maxBytes = limits.maxBytes ?? 50 * 1024 * 1024;

  const members: ArchiveMember[] = [];
  let totalBytes = 0;

  for (const entry of zip.entries) {
    if (members.length >= maxMembers) break;
    if (entry.name.endsWith('/')) continue;
    // Reject path traversal and absolute paths outright.
    if (entry.name.includes('..') || entry.name.startsWith('/')) continue;
    if (/^__MACOSX\//i.test(entry.name)) continue;
    if (!isSupported(entry.name)) continue;
    // Guard against decompression bombs before inflating.
    if (totalBytes + entry.uncompressedSize > maxBytes) continue;

    const data = zip.readEntry(entry);
    if (!data) continue;
    totalBytes += data.length;
    members.push({ name: entry.name.split('/').pop() ?? entry.name, data });
  }
  return members;
}
