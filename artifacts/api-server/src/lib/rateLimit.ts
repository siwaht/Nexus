import type { NextFunction, Request, Response } from 'express';

/**
 * Simple per-session sliding-window rate limiter (in-memory).
 *
 * Keyed by authenticated user id when available, otherwise by session id or
 * IP. Suitable for a single-process self-hosted deployment — swap for a
 * shared store if the app ever runs multi-instance.
 *
 * Apply to every model-calling and upload endpoint: provider connection
 * tests and local auth are covered here; the chat and upload routes added
 * in later milestones must mount limiters from this module too.
 */

interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
}

const buckets = new Map<string, number[]>();

// Periodically drop stale keys so the map doesn't grow unboundedly.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - SWEEP_INTERVAL_MS;
  for (const [key, hits] of buckets) {
    if (hits.length === 0 || hits[hits.length - 1] < cutoff) {
      buckets.delete(key);
    }
  }
}, SWEEP_INTERVAL_MS).unref();

function keyFor(req: Request): string {
  if (req.user?.id) return `user:${req.user.id}`;
  const sid = req.cookies?.sid ?? req.headers.authorization;
  if (typeof sid === 'string' && sid.length > 0) return `sid:${sid}`;
  return `ip:${req.ip ?? 'unknown'}`;
}

export function rateLimit({ windowMs, max, message }: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = keyFor(req);
    const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      res.status(429).json({
        error: message ?? 'Too many requests — slow down and try again shortly.',
      });
      return;
    }
    hits.push(now);
    buckets.set(key, hits);
    next();
  };
}
