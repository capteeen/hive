import { NextResponse } from 'next/server';
import { config, liveModeProblems } from '@/lib/server/config';
import { cronAuth, runRefresh, safeErr } from '@/lib/server/engine';

/**
 * GET|POST /api/cron/refresh — read-only stat refresh for every remote hive: honey from the queen
 * balance, bees from holders, a price point for the 24h average, working / starving from the last fee.
 * Sends no transactions. Vercel Cron calls it every 5 minutes, offset from the hourly run (vercel.json:
 * minutes 2, 7, …, 57), with `Authorization: Bearer ${CRON_SECRET}`; without CRON_SECRET it only runs in
 * mock mode. Rows the hourly run or the harvest is writing are left for the next refresh.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const NO_STORE = { 'Cache-Control': 'no-store' };

async function handle(req: Request): Promise<Response> {
  const auth = cronAuth(req.headers.get('authorization'));
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: NO_STORE });
  if (config.launchMode === 'live') {
    const problems = liveModeProblems();
    if (problems.length) return NextResponse.json({ error: 'Live mode is not fully configured; the refresh did not run.', problems }, { status: 503, headers: NO_STORE });
  }
  try {
    const refresh = await runRefresh();
    return NextResponse.json({ ok: refresh.errors.length === 0, mode: config.launchMode, refresh }, { headers: NO_STORE });
  } catch (e) {
    console.error('[hive] cron refresh failed:', safeErr(e));
    return NextResponse.json({ ok: false, error: safeErr(e) }, { status: 500, headers: NO_STORE });
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
