import { NextResponse } from 'next/server';
import { config, liveModeProblems } from '@/lib/server/config';
import { RUN_BUDGET_MS, cronAuth, cronDryRun, runHarvest, runHourly, safeErr } from '@/lib/server/engine';

/**
 * GET|POST /api/cron/hourly — every queen's hour (claim fees, hub share, SEAL / STORE / SWARM, starve /
 * abandon), then the hub's harvest. Vercel Cron calls it on the hour (vercel.json) with
 * `Authorization: Bearer ${CRON_SECRET}`; without CRON_SECRET it only runs in mock mode.
 *
 * Live mode sends nothing unless ENGINE_DRY_RUN is explicitly off. `?dryRun=1` forces a dry run; dry
 * runs keep their own hour marks, so one never uses up the real hour.
 * Repeated calls within the same hour are no-ops (a db lock plus a per-hour marker).
 *
 * Both jobs share one deadline inside maxDuration: no send starts that could run past it. Hives that
 * did not get their turn run on the next call (the hour is not marked done), and a harvest step that
 * did not fit resumes on the next run.
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
    if (problems.length) return NextResponse.json({ error: 'Live mode is not fully configured; the engine did not run.', problems }, { status: 503, headers: NO_STORE });
  }
  const dryRun = cronDryRun(new URL(req.url));
  const deadline = Date.now() + RUN_BUDGET_MS;
  try {
    const hourly = await runHourly({ dryRun, deadline });
    const harvest = await runHarvest({ dryRun, deadline });
    const failed = hourly.hives.filter((h) => h.errors.length).length;
    return NextResponse.json({ ok: failed === 0 && harvest.errors.length === 0, mode: config.launchMode, dryRun, hourly, harvest }, { headers: NO_STORE });
  } catch (e) {
    console.error('[hive] cron hourly failed:', safeErr(e));
    return NextResponse.json({ ok: false, error: safeErr(e) }, { status: 500, headers: NO_STORE });
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
