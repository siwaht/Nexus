import crypto from 'crypto';

/**
 * AES-256-GCM encryption for provider credentials at rest.
 *
 * The key is derived from ENCRYPTION_KEY (falling back to SESSION_SECRET)
 * via SHA-256, so any sufficiently long random string works. Self-hosted
 * installs should set ENCRYPTION_KEY explicitly.
 *
 * Stored format: base64(iv).base64(authTag).base64(ciphertext)
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'ENCRYPTION_KEY (or SESSION_SECRET) must be set to store provider credentials.',
    );
  }
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}

export function decrypt(payload: string): string {
  const [ivB64, authTagB64, dataB64] = payload.split('.');
  if (!ivB64 || !authTagB64 || !dataB64) {
    throw new Error('Malformed encrypted payload');
  }
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Returns a masked preview like "••••4f2a" — never more than the last 4 chars. */
export function maskPreview(value: string): string {
  const tail = value.slice(-4);
  return `••••${tail}`;
}
