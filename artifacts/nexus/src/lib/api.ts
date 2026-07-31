/**
 * Typed client for the Nexus API.
 *
 * The auth and provider endpoints keep using the Orval-generated client
 * (`@workspace/api-client-react`); everything added after Milestone 1 goes
 * through here. Same transport rules: relative `/api` paths by default,
 * `VITE_API_URL` for split-origin deployments, and `credentials: 'include'` so
 * the session cookie travels.
 */

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');

export function apiUrl(path: string): string {
  return `${BASE}/api${path.startsWith('/') ? path : `/${path}`}`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: string = 'request',
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Set when sending FormData — don't stringify or set a content type. */
  raw?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, raw } = options;
  const init: RequestInit = { method, credentials: 'include', signal };

  if (body !== undefined) {
    if (raw) {
      init.body = body as BodyInit;
    } else {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
  }

  const response = await fetch(apiUrl(path), init);
  if (!response.ok) {
    let message = `Request failed with ${response.status}.`;
    let kind = 'request';
    let hint: string | null = null;
    try {
      const parsed = (await response.json()) as {
        error?: string;
        kind?: string;
        hint?: string | null;
      };
      if (parsed.error) message = parsed.error;
      if (parsed.kind) kind = parsed.kind;
      hint = parsed.hint ?? null;
    } catch {
      // Non-JSON error body — keep the status message.
    }
    throw new ApiError(message, response.status, kind, hint);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'POST', body, signal }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, form: FormData) =>
    request<T>(path, { method: 'POST', body: form, raw: true }),
};

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

export interface SseHandlers {
  onEvent: (type: string, data: unknown) => void;
  onError?: (error: Error) => void;
  onDone?: () => void;
}

/**
 * Consume an SSE response from a POST. `EventSource` can't send a body or use
 * a method other than GET, so this reads the stream directly and parses the
 * `event:`/`data:` framing itself.
 */
export async function streamSse(
  path: string,
  body: unknown,
  handlers: SseHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body ?? {}),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      handlers.onDone?.();
      return;
    }
    handlers.onError?.(new Error('Could not reach the server.'));
    return;
  }

  if (!response.ok) {
    let message = `Request failed with ${response.status}.`;
    try {
      const parsed = (await response.json()) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // Keep the status message.
    }
    handlers.onError?.(new ApiError(message, response.status));
    return;
  }
  if (!response.body) {
    handlers.onError?.(new Error('The server returned an empty stream.'));
    return;
  }

  await consumeSse(response.body, handlers);
}

/** Subscribe to a GET SSE endpoint (agent runs, ingestion progress). */
export function subscribeSse(
  path: string,
  handlers: SseHandlers,
): { close: () => void } {
  const controller = new AbortController();

  void (async () => {
    try {
      const response = await fetch(apiUrl(path), {
        credentials: 'include',
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        handlers.onError?.(
          new ApiError('Could not open the event stream.', response.status),
        );
        return;
      }
      await consumeSse(response.body, handlers);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        handlers.onError?.(err as Error);
      }
    }
  })();

  return { close: () => controller.abort() };
}

async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  handlers: SseHandlers,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2));

        let type = 'message';
        const dataLines: string[] = [];
        for (const line of rawEvent.split(/\r?\n/)) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length > 0) {
          const payload = dataLines.join('\n');
          try {
            handlers.onEvent(type, JSON.parse(payload));
          } catch {
            handlers.onEvent(type, payload);
          }
        }
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      handlers.onError?.(err as Error);
    }
  } finally {
    reader.releaseLock();
    handlers.onDone?.();
  }
}

/** Absolute URL for binary endpoints used directly in `src`/`href`. */
export function fileUrl(fileId: number, download = false): string {
  return apiUrl(`/files/${fileId}/raw${download ? '?download=true' : ''}`);
}

export function screenshotUrl(storageKey: string): string {
  const name = storageKey.replace(/^screenshots\//, '');
  return apiUrl(`/browser/screenshot/${name}`);
}
