import 'server-only';
/**
 * In-memory sliding-window rate limiter. Per process: good enough to stop a single client from
 * hammering launch preparation (each prepare reserves a cell and generates keys). Behind several
 * server instances each instance counts on its own, so limits are per instance.
 */

const windows = new Map<string, number[]>();
let lastSweep = 0;

export interface RateResult {
  ok: boolean;
  /** How long until the next request would be allowed (0 when ok). */
  retryAfterMs: number;
  remaining: number;
}

/**
 * Count one hit for `key` and say whether it is within `limit` hits per `windowMs`.
 * A rejected hit is not counted, so a client that waits `retryAfterMs` gets through.
 */
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateResult {
  sweep(now, windowMs);
  const hits = (windows.get(key) ?? []).filter((t) => t > now - windowMs);
  if (hits.length >= limit) {
    windows.set(key, hits);
    return { ok: false, retryAfterMs: Math.max(1, hits[0] + windowMs - now), remaining: 0 };
  }
  hits.push(now);
  windows.set(key, hits);
  return { ok: true, retryAfterMs: 0, remaining: limit - hits.length };
}

/** Drop idle keys now and then so the map cannot grow without bound. */
function sweep(now: number, windowMs: number) {
  if (now - lastSweep < 60_000 && windows.size < 10_000) return;
  lastSweep = now;
  for (const [k, hits] of windows) if (!hits.length || hits[hits.length - 1] <= now - Math.max(windowMs, 3_600_000)) windows.delete(k);
}

/** Best-effort client IP from proxy headers (Vercel / most proxies set x-forwarded-for). */
export function clientIp(headers: Headers): string {
  const fwd = headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim().slice(0, 64) || 'unknown';
  return (headers.get('x-real-ip') ?? 'unknown').trim().slice(0, 64);
}

/** Test hook. */
export function resetRateLimits() {
  windows.clear();
  lastSweep = 0;
}
