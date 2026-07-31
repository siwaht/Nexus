import { estimateTokens } from '../ai';

/**
 * Chunking for retrieval.
 *
 * ~800 tokens per chunk with 15% overlap, and hard breaks at segment
 * boundaries so a chunk never straddles two pages or chapters. That boundary
 * discipline is what makes citations trustworthy: every chunk can name exactly
 * one page number, chapter title, or timestamp.
 */

export const TARGET_TOKENS = 800;
export const OVERLAP_RATIO = 0.15;

/** One page, chapter, slide, sheet or transcript window from an extractor. */
export interface SourceSegment {
  /** Citation anchor: "p. 12", "Chapter 3 — Method", "04:12". */
  locator: string | null;
  text: string;
}

export interface Chunk {
  ordinal: number;
  locator: string | null;
  text: string;
  tokenEstimate: number;
}

/** Split on paragraph breaks, then sentences, then hard-wrap as a last resort. */
function splitToUnits(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const units: string[] = [];
  for (const paragraph of paragraphs) {
    if (estimateTokens(paragraph) <= TARGET_TOKENS) {
      units.push(paragraph);
      continue;
    }
    const sentences = paragraph
      .split(/(?<=[.!?])\s+(?=[A-Z(["'\u201c])/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const sentence of sentences) {
      if (estimateTokens(sentence) <= TARGET_TOKENS) {
        units.push(sentence);
        continue;
      }
      // A single sentence longer than a whole chunk (minified code, tables) —
      // wrap it on character count.
      const size = TARGET_TOKENS * 4;
      for (let i = 0; i < sentence.length; i += size) {
        units.push(sentence.slice(i, i + size));
      }
    }
  }
  return units;
}

function chunkSegment(
  segment: SourceSegment,
  startOrdinal: number,
): Chunk[] {
  const units = splitToUnits(segment.text);
  if (units.length === 0) return [];

  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  let ordinal = startOrdinal;

  const flush = () => {
    if (current.length === 0) return;
    const text = current.join('\n\n').trim();
    if (text) {
      chunks.push({
        ordinal: ordinal++,
        locator: segment.locator,
        text,
        tokenEstimate: estimateTokens(text),
      });
    }
  };

  for (const unit of units) {
    const unitTokens = estimateTokens(unit);
    if (currentTokens + unitTokens > TARGET_TOKENS && current.length > 0) {
      flush();
      // Carry the tail of the previous chunk forward as overlap so a fact
      // split across the boundary is still retrievable from both sides.
      const overlapBudget = Math.floor(TARGET_TOKENS * OVERLAP_RATIO);
      const carried: string[] = [];
      let carriedTokens = 0;
      for (let i = current.length - 1; i >= 0; i -= 1) {
        const tokens = estimateTokens(current[i]);
        if (carriedTokens + tokens > overlapBudget) break;
        carried.unshift(current[i]);
        carriedTokens += tokens;
      }
      current = carried;
      currentTokens = carriedTokens;
    }
    current.push(unit);
    currentTokens += unitTokens;
  }
  flush();
  return chunks;
}

/** Chunk a document's segments, keeping ordinals continuous across segments. */
export function chunkSegments(segments: SourceSegment[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const segment of segments) {
    if (!segment.text.trim()) continue;
    const produced = chunkSegment(segment, chunks.length);
    chunks.push(...produced);
  }
  // Re-number so ordinals are dense and monotonic regardless of empty segments.
  return chunks.map((chunk, index) => ({ ...chunk, ordinal: index }));
}

/** Convenience for extractors that only produce one flat blob of text. */
export function chunkText(text: string, locator: string | null = null): Chunk[] {
  return chunkSegments([{ locator, text }]);
}
