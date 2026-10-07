import { NextResponse } from 'next/server';
import { healthReport } from '@/lib/server/health';
import { UNKNOWN_IP, clientIp, rateLimit } from '@/lib/server/ratelimit';

/**
 * GET /api/health: whether this deployment is set up for real launches (lib/server/health.ts). Booleans,
 * counts and timestamps only: no keys, no URLs, no wallet secrets. The report is cached for a few seconds
 * per process, and identifiable clients are rate limited (like /api/hives, an unidentifiable client is
 * not: one shared bucket would let a single client lock the owner out of the check).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const RATE = { limit: 30, windowMs: 60_000 };

export async function GET(req: Request) {
  const ip = clientIp(req.headers);
  if (ip !== UNKNOWN_IP) {
    const r = rateLimit(`health:ip:${ip}`, RATE.limit, RATE.windowMs);
    if (!r.ok) return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': String(Math.ceil(r.retryAfterMs / 1000)) } });
  }
  try {
    return NextResponse.json(await healthReport(), { headers: NO_STORE });
  } catch (e) {
    console.error('[hive] GET /api/health failed:', e instanceof Error ? e.name : 'error');
    return NextResponse.json({ ok: false, error: 'The health check failed.' }, { status: 500, headers: NO_STORE });
  }
}
