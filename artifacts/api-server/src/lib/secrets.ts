import { db, secretsTable, type SecretRow } from '@workspace/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { decrypt, encrypt, maskPreview } from './crypto';

/**
 * Generic encrypted secret vault.
 *
 * Distinct from `providers`, which holds model-provider credentials only.
 * This is where keys for tools and MCP servers live — a Brave Search key, a
 * GitHub token, a Browserbase key, a customer's own API. Same guarantees:
 * AES-256-GCM at rest, write-only over the API, only masked previews leave
 * the server, values never logged.
 */

export interface SecretView {
  id: number;
  name: string;
  label: string | null;
  description: string | null;
  maskedPreview: string;
  scope: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Secret names are referenced from configs, so keep them predictable. */
export function normalizeSecretName(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

export function toSecretView(row: SecretRow): SecretView {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    description: row.description,
    maskedPreview: row.maskedPreview,
    scope: row.scope,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listSecrets(userId: string): Promise<SecretView[]> {
  const rows = await db
    .select()
    .from(secretsTable)
    .where(eq(secretsTable.userId, userId))
    .orderBy(asc(secretsTable.name));
  return rows.map(toSecretView);
}

export async function upsertSecret(
  userId: string,
  input: {
    name: string;
    value: string;
    label?: string | null;
    description?: string | null;
    scope?: string;
  },
): Promise<SecretView> {
  const name = normalizeSecretName(input.name);
  if (!name) throw new Error('A secret needs a name.');
  if (!input.value) throw new Error('A secret needs a value.');

  const values = {
    userId,
    name,
    label: input.label ?? null,
    description: input.description ?? null,
    encryptedValue: encrypt(input.value),
    maskedPreview: maskPreview(input.value),
    scope: input.scope ?? 'tool',
  };

  const [row] = await db
    .insert(secretsTable)
    .values(values)
    .onConflictDoUpdate({
      target: [secretsTable.userId, secretsTable.name],
      set: {
        label: values.label,
        description: values.description,
        encryptedValue: values.encryptedValue,
        maskedPreview: values.maskedPreview,
        scope: values.scope,
      },
    })
    .returning();
  return toSecretView(row);
}

export async function deleteSecret(
  userId: string,
  name: string,
): Promise<boolean> {
  const deleted = await db
    .delete(secretsTable)
    .where(
      and(
        eq(secretsTable.userId, userId),
        eq(secretsTable.name, normalizeSecretName(name)),
      ),
    )
    .returning({ id: secretsTable.id });
  return deleted.length > 0;
}

/**
 * Resolve a secret to its plaintext for a server-side call. Marks the secret
 * as used so the UI can show staleness. Returns null when not configured —
 * callers decide whether that's fatal.
 */
export async function resolveSecret(
  userId: string,
  name: string,
): Promise<string | null> {
  const normalized = normalizeSecretName(name);
  const [row] = await db
    .select()
    .from(secretsTable)
    .where(
      and(eq(secretsTable.userId, userId), eq(secretsTable.name, normalized)),
    );
  if (!row) return null;
  let value: string;
  try {
    value = decrypt(row.encryptedValue);
  } catch {
    return null;
  }
  void db
    .update(secretsTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(secretsTable.id, row.id))
    .catch(() => undefined);
  return value;
}

/** Batch-resolve a name→secretName map into a name→plaintext map. */
export async function resolveSecretMap(
  userId: string,
  mapping: Record<string, string>,
): Promise<Record<string, string>> {
  const wanted = [...new Set(Object.values(mapping).map(normalizeSecretName))];
  if (wanted.length === 0) return {};

  const rows = await db
    .select()
    .from(secretsTable)
    .where(
      and(eq(secretsTable.userId, userId), inArray(secretsTable.name, wanted)),
    );
  const plaintext = new Map<string, string>();
  for (const row of rows) {
    try {
      plaintext.set(row.name, decrypt(row.encryptedValue));
    } catch {
      // Skip undecryptable rows rather than failing the whole resolution.
    }
  }

  const resolved: Record<string, string> = {};
  for (const [key, secretName] of Object.entries(mapping)) {
    const value = plaintext.get(normalizeSecretName(secretName));
    if (value !== undefined) resolved[key] = value;
  }

  if (rows.length > 0) {
    void db
      .update(secretsTable)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(secretsTable.userId, userId),
          inArray(
            secretsTable.name,
            rows.map((r) => r.name),
          ),
        ),
      )
      .catch(() => undefined);
  }
  return resolved;
}

/**
 * Redact anything that looks like credential material before it's persisted
 * to the tool-invocation audit log or streamed to the browser.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') {
    return value.length > 512 ? `${value.slice(0, 512)}…[truncated]` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactSecrets(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = /key|token|secret|password|authorization|credential|cookie/i.test(
        key,
      )
        ? '[redacted]'
        : redactSecrets(inner, depth + 1);
    }
    return out;
  }
  return value;
}
