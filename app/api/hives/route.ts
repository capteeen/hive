import { NextResponse } from 'next/server';
import { getDb } from '@/lib/server/db';
import type { HivesResponse } from '@/lib/shared/api';

/** GET /api/hives: every stored hive, the newest 200 actions and the newest 60 harvests. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
  try {
    const db = await getDb();
    const [hives, actions, harvests] = await Promise.all([db.listHives(), db.listActions(200), db.listHarvests(60)]);
    const body: HivesResponse = { hives, actions, harvests, serverTime: Date.now() };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (e) {
    console.error('[hive] GET /api/hives failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not load hives.' }, { status: 500, headers: NO_STORE });
  }
}
