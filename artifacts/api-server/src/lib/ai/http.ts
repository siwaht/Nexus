import { normalizeProviderError } from '../providers';
import type { Transport } from './endpoints';
import { ProviderError, type ProviderErrorKind } from './types';

/**
 * One HTTP path for every provider call: consistent timeouts, no redirect
 * following on user-supplied endpoints, and a single normalized error type.
 */

const DEFAULT_TIMEOUT_MS = 120_000;

function kindForStatus(status: number, body: string): ProviderErrorKind {
  const lower = body.toLowerCase();
  if (status === 401) return 'auth';
  if (status === 403) {
    return lower.includes('permission') || lower.includes('scope')
      ? 'permission'
      : 'auth';
  }
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status === 402 || lower.includes('quota') || lower.includes('credit')) {
    return 'quota';
  }
  if (status >= 400 && status < 500) return 'invalid_request';
  if (status >= 500) return 'server';
  return 'unknown';
}

function hintForKind(
  kind: ProviderErrorKind,
  provider: string | null,
): string | null {
  switch (kind) {
    case 'auth':
      return 'Check the key in Settings → Providers, then run Test connection.';
    case 'permission':
      return provider?.startsWith('cloudflare')
        ? 'The Cloudflare token needs the Workers AI permission. Recreate it in Settings → Providers.'
        : 'The key is valid but lacks permission for this operation.';
    case 'not_found':
      return 'The model id may be wrong or retired — refresh the catalogue in Settings → Models.';
    case 'rate_limit':
      return 'Wait a few seconds and retry, or switch to another provider.';
    case 'quota':
      return 'The account is out of credit or over its quota.';
    default:
      return null;
  }
}

export interface ProviderFetchOptions extends RequestInit {
  timeoutMs?: number;
  /** Used only for error attribution. */
  modelRef?: string;
}

export async function providerFetch(
  transport: Transport,
  url: string,
  options: ProviderFetchOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, modelRef, ...init } = options;
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (init.signal) signals.push(init.signal as AbortSignal);

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...transport.headers, ...(init.headers ?? {}) },
      // A validated URL must not be able to bounce the request elsewhere.
      redirect: transport.userSupplied ? 'error' : 'follow',
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new ProviderError({
      kind: timedOut ? 'timeout' : aborted ? 'timeout' : 'network',
      provider: transport.provider,
      modelRef: modelRef ?? null,
      message: timedOut
        ? 'The provider did not respond in time.'
        : aborted
          ? 'The request was cancelled.'
          : 'Could not reach the provider — check the endpoint and network.',
    });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const kind = kindForStatus(res.status, body);
    throw new ProviderError({
      kind,
      status: res.status,
      provider: transport.provider,
      modelRef: modelRef ?? null,
      message: normalizeProviderError(res.status, body),
      hint: hintForKind(kind, transport.provider),
    });
  }

  return res;
}

export async function providerFetchJson<T>(
  transport: Transport,
  url: string,
  options: ProviderFetchOptions = {},
): Promise<T> {
  const res = await providerFetch(transport, url, options);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError({
      kind: 'server',
      provider: transport.provider,
      modelRef: options.modelRef ?? null,
      message: 'The provider returned a response that was not valid JSON.',
    });
  }
}

/**
 * Iterate `data:` payloads from a text/event-stream response body.
 * Yields raw payload strings; `[DONE]` sentinels are filtered out.
 */
export async function* sseChunks(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; a single event may carry
      // several `data:` lines that concatenate.
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2));
        const payload = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (payload && payload !== '[DONE]') yield payload;
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
    const tail = buffer
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (tail && tail !== '[DONE]') yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** Rough token estimate used for context budgeting when a provider is silent. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~4 characters per token is close enough for budgeting across model
  // families without shipping a tokenizer per provider.
  return Math.ceil(text.length / 4);
}
