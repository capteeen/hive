import { NextResponse } from 'next/server';
import { getDb } from '@/lib/server/db';
import { config } from '@/lib/server/config';
import { actionIsPublic, hiveIsPublic } from '@/lib/shared/visibility';
import type { HiveDetailResponse } from '@/lib/shared/rows';
import { publicHive } from '@/app/api/_lib/public';

/**
 * GET /api/hives/[ca]: one hive (image as a URL, never inlined), its newest 100 actions and its last 24h
 * of price snapshots. Live launch mode: a preview hive is "not found", and only what the public may see
 * of its actions (lib/shared/visibility.ts): no dry runs, and no action aimed at a preview hive.
 */
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
    const mode = config.launchMode;
    const hive = await db.getHive(ca);
    if (!hive || !hiveIsPublic(mode, hive)) return NextResponse.json({ error: 'Hive not found.' }, { status: 404, headers: NO_STORE });
    const real = mode === 'live';
    const [listed, prices] = await Promise.all([db.listActions(100, ca, { real }), db.listPrices(ca, now - DAY_MS)]);
    // the same rule as the list: a swarm into a hive that is not live is not shown (the engine never
    // mixes statuses, but a shared database can hold anything)
    const targets = real ? [...new Set(listed.map((a) => a.targetCa).filter((t): t is string => !!t && t !== ca))] : [];
    const live = new Set([ca]);
    for (const t of await Promise.all(targets.map((t) => db.getHive(t)))) if (t && hiveIsPublic(mode, t)) live.add(t.ca);
    const actions = listed.filter((a) => actionIsPublic(mode, a, (c) => live.has(c)));
    const body: HiveDetailResponse = { hive: publicHive(hive), actions, prices, serverTime: now };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (e) {
    console.error('[hive] GET /api/hives/[ca] failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not load this hive.' }, { status: 500, headers: NO_STORE });
  }
}
