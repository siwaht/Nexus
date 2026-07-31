import type { Request, Response } from 'express';

import { ProviderError } from '../lib/ai';

/**
 * Shared route plumbing: SSE setup and one error shape for every endpoint.
 */

export function userId(req: Request): string {
  // Every router that uses this is mounted behind `requireAuth`.
  return req.user!.id;
}

export interface ApiErrorBody {
  error: string;
  kind: string;
  hint: string | null;
}

/** Translate any thrown value into a status code plus a readable body. */
export function errorResponse(err: unknown): {
  status: number;
  body: ApiErrorBody;
} {
  if (err instanceof ProviderError) {
    const status =
      err.kind === 'auth' || err.kind === 'permission'
        ? 400
        : err.kind === 'not_found'
          ? 404
          : err.kind === 'rate_limit'
            ? 429
            : err.kind === 'invalid_request' || err.kind === 'unsupported'
              ? 400
              : 502;
    return {
      status,
      body: { error: err.message, kind: err.kind, hint: err.hint },
    };
  }
  const message =
    err instanceof Error ? err.message : 'Something went wrong on the server.';
  return { status: 400, body: { error: message, kind: 'request', hint: null } };
}

export function sendError(res: Response, err: unknown): void {
  const { status, body } = errorResponse(err);
  if (!res.headersSent) res.status(status).json(body);
}

/** Wrap a handler so thrown errors become a normalized JSON response. */
export function handler(
  fn: (req: Request, res: Response) => Promise<void> | void,
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      sendError(res, err);
    }
  };
}

export interface SseChannel {
  send: (event: string, data: unknown) => void;
  comment: (text: string) => void;
  close: () => void;
  readonly closed: boolean;
  signal: AbortSignal;
}

/**
 * Open a Server-Sent Events response.
 *
 * Buffering is disabled explicitly (`X-Accel-Buffering`) because a proxy that
 * buffers turns token streaming into a single delayed blob. The returned
 * `signal` aborts when the client disconnects, so generation stops instead of
 * running on for a browser that has gone away.
 */
export function openSse(req: Request, res: Response): SseChannel {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const controller = new AbortController();
  let closed = false;

  const keepAlive = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, 15_000);

  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    controller.abort();
  };

  req.on('close', finish);
  res.on('close', finish);

  return {
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      if (!closed) res.write(`: ${text}\n\n`);
    },
    close() {
      if (closed) return;
      clearInterval(keepAlive);
      closed = true;
      res.end();
    },
    get closed() {
      return closed;
    },
    signal: controller.signal,
  };
}

export function intParam(value: unknown, fallback = 0): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function requireIntParam(value: unknown, name: string): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`"${name}" must be a number.`);
  }
  return parsed;
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function optionalStr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function boolOr(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

export function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item;
  }
  return out;
}
