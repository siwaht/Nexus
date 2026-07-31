import type { ProviderName } from '@workspace/api-zod';
import { db, providersTable } from '@workspace/db';
import { and, eq } from 'drizzle-orm';

import { decrypt } from '../crypto';
import { getProviderDefinition, type Credentials } from '../providers';
import { ProviderError, type ModelRef, type ParsedModelRef } from './types';

/**
 * Credential resolution for model calls.
 *
 * Keys never leave the server and are never logged. Each call decrypts on
 * demand and caches for a short window so a chat turn with several tool
 * round-trips doesn't hammer the database.
 */

interface CacheEntry {
  credentials: Credentials;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

/** Drop cached credentials for a user — call after any provider mutation. */
export function invalidateCredentialCache(userId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${userId}:`)) cache.delete(key);
  }
}

export async function loadCredentials(
  userId: string,
  provider: ProviderName,
): Promise<Credentials> {
  const cacheKey = `${userId}:${provider}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.credentials;

  const [row] = await db
    .select()
    .from(providersTable)
    .where(
      and(eq(providersTable.userId, userId), eq(providersTable.name, provider)),
    );

  const definition = getProviderDefinition(provider);
  const displayName = definition?.displayName ?? provider;

  if (!row) {
    throw new ProviderError({
      kind: 'auth',
      provider,
      message: `${displayName} isn't connected yet.`,
      hint: 'Add credentials in Settings → Providers.',
    });
  }

  let credentials: Credentials;
  try {
    credentials = JSON.parse(decrypt(row.encryptedCredentials)) as Credentials;
  } catch {
    throw new ProviderError({
      kind: 'auth',
      provider,
      message: `Stored ${displayName} credentials could not be decrypted.`,
      hint: 'Re-enter the credentials in Settings → Providers. This usually means ENCRYPTION_KEY changed.',
    });
  }

  const missing = (definition?.fields ?? [])
    .filter((f) => f.required && !credentials[f.key])
    .map((f) => f.label);
  if (missing.length > 0) {
    throw new ProviderError({
      kind: 'auth',
      provider,
      message: `${displayName} is missing: ${missing.join(', ')}.`,
      hint: 'Complete the provider card in Settings → Providers.',
    });
  }

  cache.set(cacheKey, {
    credentials,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return credentials;
}

/** Which providers this user has usable credentials for. */
export async function connectedProviders(
  userId: string,
): Promise<ProviderName[]> {
  const rows = await db
    .select()
    .from(providersTable)
    .where(eq(providersTable.userId, userId));
  const usable: ProviderName[] = [];
  for (const row of rows) {
    const definition = getProviderDefinition(row.name);
    if (!definition) continue;
    try {
      const credentials = JSON.parse(
        decrypt(row.encryptedCredentials),
      ) as Credentials;
      const complete = definition.fields
        .filter((f) => f.required)
        .every((f) => Boolean(credentials[f.key]));
      if (complete) usable.push(definition.name);
    } catch {
      // Undecryptable row — treat as not connected.
    }
  }
  return usable;
}

/** Split `<provider>:<model>` — the model half may itself contain colons. */
export function parseModelRef(modelRef: ModelRef): ParsedModelRef {
  const separator = modelRef.indexOf(':');
  if (separator <= 0) {
    throw new ProviderError({
      kind: 'invalid_request',
      modelRef,
      message: `"${modelRef}" is not a valid model reference. Expected "provider:model".`,
    });
  }
  const provider = modelRef.slice(0, separator);
  const model = modelRef.slice(separator + 1);
  if (!getProviderDefinition(provider)) {
    throw new ProviderError({
      kind: 'invalid_request',
      modelRef,
      message: `Unknown provider "${provider}".`,
    });
  }
  if (!model) {
    throw new ProviderError({
      kind: 'invalid_request',
      modelRef,
      message: `Model reference "${modelRef}" is missing a model id.`,
    });
  }
  return { provider: provider as ProviderName, model };
}

export function buildModelRef(provider: ProviderName, model: string): ModelRef {
  return `${provider}:${model}`;
}
