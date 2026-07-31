import { inflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP reader built on node:zlib.
 *
 * DOCX, XLSX, PPTX, EPUB and .zip archives are all ZIP containers, so one
 * ~150-line reader covers every office and ebook format without pulling in a
 * parsing dependency per file type. Only the two compression methods that
 * matter in practice are supported: stored (0) and deflate (8).
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  offset: number;
}

export class ZipArchive {
  private constructor(
    private readonly buffer: Buffer,
    readonly entries: ZipEntry[],
  ) {}

  static open(buffer: Buffer): ZipArchive {
    const eocdOffset = findEocd(buffer);
    if (eocdOffset === -1) {
      throw new Error('This file is not a readable ZIP container.');
    }

    let entryCount = buffer.readUInt16LE(eocdOffset + 10);
    let centralOffset = buffer.readUInt32LE(eocdOffset + 16);

    // ZIP64: the 32-bit fields are saturated and the real values live in the
    // ZIP64 record that precedes the locator.
    if (entryCount === 0xffff || centralOffset === 0xffffffff) {
      const zip64 = findZip64Eocd(buffer, eocdOffset);
      if (zip64 !== -1) {
        entryCount = Number(buffer.readBigUInt64LE(zip64 + 32));
        centralOffset = Number(buffer.readBigUInt64LE(zip64 + 48));
      }
    }

    const entries: ZipEntry[] = [];
    let cursor = centralOffset;
    for (let i = 0; i < entryCount; i += 1) {
      if (cursor + 46 > buffer.length) break;
      if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;

      const method = buffer.readUInt16LE(cursor + 10);
      const compressedSize = buffer.readUInt32LE(cursor + 20);
      const uncompressedSize = buffer.readUInt32LE(cursor + 24);
      const nameLength = buffer.readUInt16LE(cursor + 28);
      const extraLength = buffer.readUInt16LE(cursor + 30);
      const commentLength = buffer.readUInt16LE(cursor + 32);
      const offset = buffer.readUInt32LE(cursor + 42);
      const name = buffer
        .subarray(cursor + 46, cursor + 46 + nameLength)
        .toString('utf8');

      entries.push({
        name,
        compressedSize,
        uncompressedSize,
        method,
        offset,
      });
      cursor += 46 + nameLength + extraLength + commentLength;
    }

    return new ZipArchive(buffer, entries);
  }

  has(name: string): boolean {
    return this.entries.some((entry) => entry.name === name);
  }

  /** Entries whose name matches a predicate, in archive order. */
  find(predicate: (name: string) => boolean): ZipEntry[] {
    return this.entries.filter((entry) => predicate(entry.name));
  }

  read(name: string): Buffer | null {
    const entry = this.entries.find((candidate) => candidate.name === name);
    return entry ? this.readEntry(entry) : null;
  }

  readText(name: string): string | null {
    const data = this.read(name);
    return data ? data.toString('utf8') : null;
  }

  readEntry(entry: ZipEntry): Buffer | null {
    const { buffer } = this;
    const header = entry.offset;
    if (header + 30 > buffer.length) return null;
    const nameLength = buffer.readUInt16LE(header + 26);
    const extraLength = buffer.readUInt16LE(header + 28);
    const start = header + 30 + nameLength + extraLength;

    // Prefer the central-directory size, but fall back to reading to the end
    // when a streamed entry recorded zero there.
    const size =
      entry.compressedSize > 0
        ? entry.compressedSize
        : buffer.length - start;
    const slice = buffer.subarray(start, start + size);

    try {
      if (entry.method === 0) return Buffer.from(slice);
      if (entry.method === 8) return inflateRawSync(slice);
      return null;
    } catch {
      return null;
    }
  }
}

function findEocd(buffer: Buffer): number {
  // The EOCD is within the last 64 KiB (comment field max) plus its own size.
  const start = Math.max(0, buffer.length - 66_000);
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

function findZip64Eocd(buffer: Buffer, eocdOffset: number): number {
  const start = Math.max(0, eocdOffset - 100);
  for (let i = eocdOffset - 20; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === ZIP64_EOCD_SIGNATURE) return i;
  }
  return -1;
}

/** Strip XML tags, decode the five predefined entities, collapse whitespace. */
export function xmlText(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Collect the text content of every occurrence of one element. */
export function collectElements(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) out.push(match[1]);
  return out;
}
