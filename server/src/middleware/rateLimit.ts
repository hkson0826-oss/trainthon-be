import type { RequestHandler } from 'express';
import { ApiError } from '../lib/errors.js';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window per-actor limiter (in-memory, single instance). Keyed by
 * authenticated user id when present, otherwise by remote IP.
 */
export function rateLimit(perMinute: number, now: () => number = Date.now): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const windowMs = 60_000;
  return (req, _res, next) => {
    if (perMinute <= 0) return next();
    const actor = (req.user?.id as string | undefined) ?? req.ip ?? 'anonymous';
    const t = now();
    let b = buckets.get(actor);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + windowMs };
      buckets.set(actor, b);
    }
    b.count += 1;
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (v.resetAt <= t) buckets.delete(k);
    }
    if (b.count > perMinute) return next(new ApiError('RATE_LIMITED', 'Too many requests', { retryable: true }));
    next();
  };
}
