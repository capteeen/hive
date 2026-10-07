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

/** The rate-limit key for a client we cannot identify. Every such client shares it. */
export const UNKNOWN_IP = 'unknown';

/**
 * The client address to rate-limit by, taken only from a source the client cannot forge:
 *  - on Vercel (`VERCEL` set): `x-vercel-forwarded-for` / `x-real-ip` / `x-forwarded-for`, which the
 *    platform sets itself (it overwrites whatever the client sent);
 *  - behind your own reverse proxy, with `TRUST_PROXY=1` (or N for a chain of N proxies): the N-th
 *    X-Forwarded-For entry from the right, i.e. the address your outermost proxy saw. Entries further
 *    left were written by the client;
 *  - otherwise UNKNOWN_IP. `next start` passes a client-sent X-Forwarded-For through untouched and route
 *    handlers never see the socket address, so an unproxied server cannot tell clients apart: they all
 *    share one bucket (launches are also limited per owner).
 * IPv6 addresses are keyed by their /64, which one subscriber usually holds in full.
 */
export function clientIp(headers: Headers, env: Record<string, string | undefined> = process.env): string {
  let raw: string | undefined;
  if (env.VERCEL) {
    raw = firstEntry(headers.get('x-vercel-forwarded-for')) ?? firstEntry(headers.get('x-real-ip')) ?? firstEntry(headers.get('x-forwarded-for'));
  } else {
    const hops = trustedHops(env.TRUST_PROXY);
    if (hops > 0) {
      const list = (headers.get('x-forwarded-for') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      raw = list.length >= hops ? list[list.length - hops] : undefined;
    }
  }
  return (raw && normalizeIp(raw)) || UNKNOWN_IP;
}

const firstEntry = (v: string | null) => v?.split(',')[0]?.trim() || undefined;

/** TRUST_PROXY: unset / 0 / false = no trusted proxy; 1 / true / yes = one; an integer N = N proxies. */
function trustedHops(v: string | undefined): number {
  const t = (v ?? '').trim().toLowerCase();
  if (!t || /^(0|false|no|off)$/.test(t)) return 0;
  if (/^(true|yes|on)$/.test(t)) return 1;
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 10) : 1;
}

/** A stable key for an address: IPv4 as is (port dropped), IPv6 as its /64, anything else trimmed. */
export function normalizeIp(raw: string): string {
  let s = raw.trim().replace(/^"|"$/g, '');
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracket) s = bracket[1];
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(s);
  if (v4port) return v4port[1];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) return mapped[1];
  if (s.includes(':')) {
    const prefix = ipv6Prefix64(s);
    if (prefix) return prefix;
  }
  return s.slice(0, 64);
}

/** `2001:db8:1:2:aaaa::1` -> `2001:db8:1:2::/64`; null when it is not an IPv6 address. */
function ipv6Prefix64(ip: string): string | null {
  const s = ip.toLowerCase().split('%')[0];
  if (!/^[0-9a-f:.]+$/.test(s)) return null;
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const split = (x: string) => (x ? x.split(':') : []);
  const head = split(parts[0]);
  const tail = parts.length === 2 ? split(parts[1]) : [];
  const all = [...head, ...tail];
  const groups = (g: string) => (g.includes('.') ? 2 : 1); // an embedded IPv4 tail fills two groups
  for (let i = 0; i < all.length; i++) {
    const g = all[i];
    if (g.includes('.') ? i !== all.length - 1 || !/^\d{1,3}(\.\d{1,3}){3}$/.test(g) : !/^[0-9a-f]{1,4}$/.test(g)) return null;
  }
  const used = all.reduce((n, g) => n + groups(g), 0);
  if (parts.length === 1 ? used !== 8 : used > 7) return null;
  const full = parts.length === 2 ? [...head, ...Array<string>(8 - used).fill('0'), ...tail] : head;
  return `${full
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

/** Test hook. */
export function resetRateLimits() {
  windows.clear();
  lastSweep = 0;
}
