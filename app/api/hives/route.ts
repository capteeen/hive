import { NextResponse } from 'next/server';
import { getDb } from '@/lib/server/db';
import { config } from '@/lib/server/config';
import { publicView } from '@/lib/shared/visibility';
import { UNKNOWN_IP, clientIp, rateLimit } from '@/lib/server/ratelimit';
import type { HivesResponse } from '@/lib/shared/api';
import { publicHive } from '@/app/api/_lib/public';

/**
 * GET /api/hives: every stored hive, the newest 200 actions and the newest 60 harvests.
 * Live launch mode: only real chain data (lib/shared/visibility.ts): live hives, and actions and
 * harvests that were really sent, for live hives. Preview rows and dry runs stay out.
 * Images are not inlined (each hive's `image` is a URL; data-URL images are served by
 * /api/hives/[ca]/image), so the body stays small however many hives there are.
 * Shared caches may keep it for 5 s (every tab re-fetches it once a minute); clients that can be told
 * apart (see clientIp) are rate limited per address.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const CACHE = { 'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=30' };
/**
 * At most this many hives per response (worst case ~3 KB each, well under Vercel's 4.5 MB body limit).
 * Past it, abandoned hives go first, then the oldest; their cells stay claimed server-side.
 */
const MAX_LIST_HIVES = 1000;
/** Per client address; a page fetches this on load, on every feed reconnect and once a minute. */
const RATE = { limit: 120, windowMs: 60_000 };

export async function GET(req: Request) {
  // Unidentifiable clients (see clientIp) are not limited here: one shared bucket would let a single
  // client lock everyone out of the comb. The body is small and cacheable instead.
  const ip = clientIp(req.headers);
  if (ip !== UNKNOWN_IP) {
    const r = rateLimit(`hives:ip:${ip}`, RATE.limit, RATE.windowMs);
    if (!r.ok) return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': String(Math.ceil(r.retryAfterMs / 1000)) } });
  }
  try {
    const db = await getDb();
    const mode = config.launchMode;
    const real = mode === 'live';
    const lists = await Promise.all([db.listHives(), db.listActions(200, undefined, { real }), db.listHarvests(60, { real })]);
    const { hives, actions, harvests } = publicView(mode, { hives: lists[0], actions: lists[1], harvests: lists[2] });
    const kept = capHives(hives);
    const body: HivesResponse = { hives: kept.map(publicHive), actions, harvests, serverTime: Date.now() };
    if (kept.length < hives.length) body.omitted = hives.length - kept.length;
    return NextResponse.json(body, { headers: CACHE });
  } catch (e) {
    console.error('[hive] GET /api/hives failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not load hives.' }, { status: 500, headers: NO_STORE });
  }
}

/** The hives a response carries: all of them up to MAX_LIST_HIVES, else the living and newest. */
function capHives<T extends { state: string; createdAt: number }>(hives: T[]): T[] {
  if (hives.length <= MAX_LIST_HIVES) return hives;
  const rank = (h: T) => (h.state === 'abandoned' ? 1 : 0);
  return [...hives].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt).slice(0, MAX_LIST_HIVES);
}
