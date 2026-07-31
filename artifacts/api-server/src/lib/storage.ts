import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * File storage behind one driver interface.
 *
 * The local-disk driver is the default and works everywhere (Replit, a VM,
 * the user's own machine). Storage keys are server-generated random names, so
 * a hostile filename can never influence the path on disk. `STORAGE_DIR`
 * relocates the root; nothing else in the app knows where bytes live.
 */

export interface StorageDriver {
  put(data: Buffer, opts: { extension?: string; prefix?: string }): Promise<string>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Absolute filesystem path, when the driver is disk-backed. */
  localPath(key: string): string | null;
}

const ROOT = path.resolve(process.env.STORAGE_DIR ?? './uploads');

/** Keys are `<prefix>/<32 hex chars><ext>` — validate before touching disk. */
const KEY_PATTERN = /^[a-z0-9-]{1,32}\/[a-f0-9]{32}(\.[a-z0-9]{1,12})?$/;

function assertValidKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error('Invalid storage key.');
  }
}

function resolveKey(key: string): string {
  assertValidKey(key);
  const full = path.resolve(ROOT, key);
  // Defence in depth: the resolved path must stay inside the root.
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    throw new Error('Invalid storage key.');
  }
  return full;
}

/** Normalize a user-supplied extension; unknown or hostile input is dropped. */
export function safeExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '';
}

/** Strip directories and control characters from a display filename. */
export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[\u0000-\u001f\u007f]/g, '');
  const cleaned = base.replace(/[/\\:*?"<>|]/g, '_').trim();
  return (cleaned || 'upload').slice(0, 200);
}

class LocalDiskStorage implements StorageDriver {
  async put(
    data: Buffer,
    { extension = '', prefix = 'files' }: { extension?: string; prefix?: string },
  ): Promise<string> {
    const safePrefix = prefix.replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'files';
    const ext = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '';
    const key = `${safePrefix}/${crypto.randomBytes(16).toString('hex')}${ext}`;
    const full = resolveKey(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
    return key;
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(resolveKey(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(resolveKey(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }

  localPath(key: string): string {
    return resolveKey(key);
  }
}

export const storage: StorageDriver = new LocalDiskStorage();

/** Ensure the storage root exists at boot so the first upload can't fail. */
export async function initStorage(): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true });
}

export function storageRoot(): string {
  return ROOT;
}
