import type { SourceSegment } from '../rag/chunk';
import type { ExtractedDocument } from './office';

/**
 * PDF text extraction, page by page.
 *
 * Page numbers are kept as citation anchors. Pages with no text layer (scans)
 * are reported back so the caller can run them through the vision model as an
 * OCR fallback — the pipeline never silently returns an empty document for a
 * scanned PDF.
 *
 * pdf.js is loaded dynamically so a missing or moved build only disables PDF
 * ingestion rather than breaking the whole server at import time.
 */

interface PdfTextItem {
  str?: string;
  transform?: number[];
  hasEOL?: boolean;
}

interface PdfPage {
  getTextContent: () => Promise<{ items: PdfTextItem[] }>;
  getViewport: (options: { scale: number }) => { width: number; height: number };
}

interface PdfDocument {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
  getMetadata: () => Promise<{ info?: Record<string, unknown> }>;
  destroy: () => Promise<void>;
}

interface PdfJsModule {
  getDocument: (options: Record<string, unknown>) => { promise: Promise<PdfDocument> };
  GlobalWorkerOptions?: { workerSrc?: string };
}

let cachedModule: PdfJsModule | null = null;

async function loadPdfJs(): Promise<PdfJsModule> {
  if (cachedModule) return cachedModule;
  // The legacy build is the Node-friendly one; the specifier has moved between
  // major versions, so try the known paths in order.
  const candidates = [
    'pdfjs-dist/legacy/build/pdf.mjs',
    'pdfjs-dist/legacy/build/pdf.js',
    'pdfjs-dist/build/pdf.mjs',
    'pdfjs-dist',
  ];
  const failures: string[] = [];
  for (const specifier of candidates) {
    try {
      const loaded = (await import(specifier)) as Record<string, unknown>;
      const candidate = (
        typeof loaded.getDocument === 'function'
          ? loaded
          : (loaded.default as Record<string, unknown> | undefined)
      ) as PdfJsModule | undefined;
      if (candidate && typeof candidate.getDocument === 'function') {
        const module = candidate;
        // No worker in Node — run everything on the main thread.
        if (module.GlobalWorkerOptions) module.GlobalWorkerOptions.workerSrc = '';
        cachedModule = module;
        return module;
      }
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(
    `PDF support needs the pdfjs-dist package. Install it with "pnpm --filter @workspace/api-server add pdfjs-dist". (${failures[0] ?? 'module not found'})`,
  );
}

export interface PdfExtraction extends ExtractedDocument {
  /** 1-based page numbers that produced no text and may need OCR. */
  pagesWithoutText: number[];
}

/** Group text items into lines using their y coordinate, then join with spaces. */
function itemsToText(items: PdfTextItem[]): string {
  const lines: Array<{ y: number; parts: string[] }> = [];
  const tolerance = 2.5;

  for (const item of items) {
    const text = item.str ?? '';
    if (!text) continue;
    const y = item.transform?.[5] ?? 0;
    const existing = lines.find((line) => Math.abs(line.y - y) <= tolerance);
    if (existing) existing.parts.push(text);
    else lines.push({ y, parts: [text] });
  }

  return lines
    .sort((a, b) => b.y - a.y)
    .map((line) => line.parts.join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export async function extractPdf(buffer: Buffer): Promise<PdfExtraction> {
  const pdfjs = await loadPdfJs();
  const document = await pdfjs
    .getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      // Keep ingestion self-contained and offline.
      disableFontFace: true,
      isEvalSupported: false,
    })
    .promise;

  try {
    const segments: SourceSegment[] = [];
    const pagesWithoutText: number[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = itemsToText(content.items);
      if (text.trim().length === 0) {
        pagesWithoutText.push(pageNumber);
        continue;
      }
      segments.push({ locator: `p. ${pageNumber}`, text });
    }

    const metadata = await document.getMetadata().catch(() => ({ info: {} }));
    const info = (metadata.info ?? {}) as Record<string, unknown>;

    return {
      segments,
      pagesWithoutText,
      pageCount: document.numPages,
      metadata: {
        title: typeof info.Title === 'string' ? info.Title : null,
        author: typeof info.Author === 'string' ? info.Author : null,
        producer: typeof info.Producer === 'string' ? info.Producer : null,
        pageCount: document.numPages,
      },
    };
  } finally {
    await document.destroy().catch(() => undefined);
  }
}

/**
 * Render specific pages to PNG for the OCR fallback.
 *
 * Rasterising needs a canvas implementation, which isn't a dependency here.
 * Rather than pretend, this reports honestly so the pipeline can tell the user
 * exactly why a scanned page wasn't read and what to do about it.
 */
export async function renderPdfPages(): Promise<never> {
  throw new Error(
    'Rasterising scanned PDF pages needs a canvas backend, which is not installed. Upload the page images directly and the vision model will read them.',
  );
}
