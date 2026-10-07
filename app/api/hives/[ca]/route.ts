import { NextResponse } from 'next/server';
import { getDb } from '@/lib/server/db';
import type { HiveDetailResponse } from '@/lib/shared/rows';

/** GET /api/hives/[ca]: one hive, its newest 100 actions and its last 24h of price snapshots. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const DAY_MS = 24 * 3600_000;
/** Mint addresses are base58; mock ones are close enough. Anything else cannot be a stored hive. */
const CA_RE = /^[A-Za-z0-9_-]{1,100}$/;

export async function GET(_req: Request, { params }: { params: { ca: string } }) {
  const ca = params.ca;
  if (!CA_RE.test(ca)) return NextResponse.json({ error: 'Hive not found.' }, { status: 404, headers: NO_STORE });
  try {
    const db = await getDb();
    const now = Date.now();
    // Existence first: an unknown CA costs one map lookup (file) or one indexed read (Supabase) and
    // never reaches the action scan or the price store.
    const hive = await db.getHive(ca);
    if (!hive) return NextResponse.json({ error: 'Hive not found.' }, { status: 404, headers: NO_STORE });
    const [actions, prices] = await Promise.all([db.listActions(100, ca), db.listPrices(ca, now - DAY_MS)]);
    const body: HiveDetailResponse = { hive, actions, prices, serverTime: now };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (e) {
    console.error('[hive] GET /api/hives/[ca] failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not load this hive.' }, { status: 500, headers: NO_STORE });
  }
}
