import { NextResponse } from 'next/server';
import { config, liveModeProblems } from '@/lib/server/config';
import { getDb } from '@/lib/server/db';
import { RUN_BUDGET_MS, cronAuth, cronDryRun, runHarvest, runHourly, safeErr } from '@/lib/server/engine';

/**
 * GET|POST /api/cron/hourly — every queen's hour (claim fees, hub share, SEAL / STORE / SWARM, starve /
 * abandon), then the hub's harvest. Vercel Cron calls it on the hour (vercel.json) with
 * `Authorization: Bearer ${CRON_SECRET}`; without CRON_SECRET it only runs in mock mode.
 *
 * Live mode sends nothing unless ENGINE_DRY_RUN is explicitly off. `?dryRun=1` forces a dry run; dry
 * runs keep their own hour marks, so one never uses up the real hour. Dry-run rows never reach the public
 * feed in live mode (lib/shared/visibility.ts): this response is where the admin sees them, as
 * `dryRunFeed` (the planned actions with their reasons, and the planned harvest).
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
    const dryRunFeed = dryRun ? await plannedFeed(hourly.at, harvest.harvest) : undefined;
    return NextResponse.json({ ok: failed === 0 && harvest.errors.length === 0, mode: config.launchMode, dryRun, hourly, harvest, dryRunFeed }, { headers: NO_STORE });
  } catch (e) {
    console.error('[hive] cron hourly failed:', safeErr(e));
    return NextResponse.json({ ok: false, error: safeErr(e) }, { status: 500, headers: NO_STORE });
  }
}

/** What this dry run recorded (the public never sees it in live mode). Best effort: the run itself succeeded. */
async function plannedFeed(since: number, harvest: unknown) {
  try {
    const actions = (await (await getDb()).listActions(500)).filter((a) => a.dryRun && a.at >= since);
    return { note: 'Dry run: nothing was sent. These rows are hidden from the public feed in live mode.', actions, harvest: harvest ?? null };
  } catch (e) {
    return { note: `Could not list the planned actions: ${safeErr(e)}`, actions: [], harvest: harvest ?? null };
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
