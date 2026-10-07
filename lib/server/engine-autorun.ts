import 'server-only';
/**
 * Mock mode only: an in-process ticker that drives the queen engine on a local server, so remote mock
 * hives come alive without a cron service.
 *
 *  - runRefresh every 20 s (honey, bees, price points, starving).
 *  - runHourly then runHarvest every mock hour (lib/sim.ts HOUR_MS, 60 s), aligned to the hour
 *    boundary like the simulator's harvest countdown.
 *
 * Started once per process from instrumentation.ts. Never in live mode (Vercel Cron drives
 * /api/cron/* there), never on serverless (VERCEL is set), never during `next build`, and not when
 * ENGINE_AUTORUN=0. Runs are serialised: a tick that finds the same job still queued or running is
 * skipped, so slow runs never pile up. Timers are unref'd so they never keep a process alive.
 */
import { HOUR_MS } from '@/lib/sim';
import { config } from './config';
import { runHarvest, runHourly, runRefresh, safeErr } from './engine';

export const AUTORUN_REFRESH_MS = 20_000;
/** Run the hour a little after the boundary so it lands inside the new hour. */
const HOUR_OFFSET_MS = 1_500;
const FIRST_REFRESH_MS = 3_000;

interface Ticker {
  started: boolean;
  timers: ReturnType<typeof setTimeout>[];
  /** Jobs queued or running. */
  pending: Set<string>;
  /** Serialises every engine job in this process. */
  queue: Promise<void>;
}

// On globalThis: route handlers, instrumentation and dev hot reloads may each load their own copy.
const registry = globalThis as unknown as { __hiveEngineAutorunV1?: Ticker };

/** Why the ticker must not run here, or null when it may. */
export function autorunBlockedReason(env: Record<string, string | undefined> = process.env, mode = config.launchMode): string | null {
  if (mode !== 'mock') return 'live mode (the engine runs from /api/cron)';
  if (env.ENGINE_AUTORUN === '0') return 'ENGINE_AUTORUN=0';
  if (env.NEXT_RUNTIME && env.NEXT_RUNTIME !== 'nodejs') return 'not the Node.js runtime';
  if (env.NEXT_PHASE === 'phase-production-build') return 'next build';
  if (env.VERCEL) return 'serverless (Vercel Cron drives the engine)';
  return null;
}

const unref = (t: ReturnType<typeof setTimeout>) => {
  (t as { unref?: () => void }).unref?.();
  return t;
};

/** Start the ticker. Returns false when blocked or already running in this process. */
export function startEngineAutorun(): boolean {
  const blocked = autorunBlockedReason();
  if (blocked) return false;
  const t = (registry.__hiveEngineAutorunV1 ??= { started: false, timers: [], pending: new Set(), queue: Promise.resolve() });
  if (t.started) return false;
  t.started = true;

  const enqueue = (name: string, job: () => Promise<void>) => {
    if (t.pending.has(name)) return; // the previous one has not finished: skip this tick
    t.pending.add(name);
    t.queue = t.queue
      .then(job)
      .catch((e) => console.error(`[hive] engine ${name} failed: ${safeErr(e)}`))
      .finally(() => t.pending.delete(name));
  };
  const refresh = () =>
    enqueue('refresh', async () => {
      await runRefresh();
    });
  const hour = () =>
    enqueue('hourly', async () => {
      // config.launchMode is fixed for the process, but check anyway: this must never send live
      if (config.launchMode !== 'mock') return;
      await runHourly({ dryRun: false });
      await runHarvest({ dryRun: false });
    });

  t.timers.push(unref(setTimeout(refresh, FIRST_REFRESH_MS)));
  t.timers.push(unref(setInterval(refresh, AUTORUN_REFRESH_MS)));
  const now = Date.now();
  const firstHour = Math.ceil(now / HOUR_MS) * HOUR_MS + HOUR_OFFSET_MS - now;
  t.timers.push(
    unref(
      setTimeout(() => {
        hour();
        t.timers.push(unref(setInterval(hour, HOUR_MS)));
      }, firstHour),
    ),
  );
  console.info(`[hive] mock engine ticker started: refresh every ${AUTORUN_REFRESH_MS / 1000} s, queens and harvest every mock hour (${HOUR_MS / 1000} s). ENGINE_AUTORUN=0 turns it off.`);
  return true;
}

/** Stop the ticker (tests, hot reload). Jobs already running finish on their own. */
export function stopEngineAutorun() {
  const t = registry.__hiveEngineAutorunV1;
  if (!t) return;
  for (const timer of t.timers) clearTimeout(timer);
  t.timers = [];
  t.started = false;
}
