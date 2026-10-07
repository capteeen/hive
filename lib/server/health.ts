import 'server-only';
/**
 * GET /api/health: is this deployment set up to run for real? Public, so it carries booleans, counts and
 * timestamps only: never a key, a URL (RPC URLs often embed an API key), a wallet secret or an error text
 * that could echo one. `npm run check:live` (scripts/check-live.mjs) checks the same things from a
 * terminal, with the fix for each problem.
 *
 * Probes run in parallel, each with a short timeout, and the report is cached briefly per process so the
 * endpoint cannot be used to hammer Supabase or the RPC.
 */
import { createClient } from '@supabase/supabase-js';
import type { LaunchMode } from '@/lib/shared/api';
import { config, hasSupabase, liveModeProblems, queenKeyValid } from './config';
import { getDb } from './db';
import { ENGINE_META, resolveHub } from './engine';

export const HEALTH_TABLES = ['hives', 'actions', 'harvests', 'prices', 'launches', 'cell_claims', 'secrets', 'meta', 'locks'] as const;
const PROBE_MS = 2_500;
const CACHE_MS = 10_000;

export interface HealthReport {
  /** Live mode: nothing blocks real launches. Mock mode: always true (nothing real is at stake). */
  ok: boolean;
  checkedAt: number;
  launchMode: LaunchMode;
  /** Live mode: the engine only records what it would do (ENGINE_DRY_RUN). */
  dryRun: boolean;
  demoHives: boolean;
  store: 'supabase' | 'file';
  supabase: {
    configured: boolean;
    anonKey: boolean;
    reachable: boolean | null;
    /** The anon key can read hives (what browsers do). Null when not checked. */
    anonRead: boolean | null;
    schema: {
      /** Every table of 0001_hive.sql exists. */
      present: boolean;
      missingTables: string[];
      /** 2 once supabase/migrations/0002_live.sql ran; 1 when only 0001 did; null when unknown. */
      version: number | null;
      /** hives, actions and harvests are in the supabase_realtime publication. Null when unknown (0001 only). */
      realtime: boolean | null;
    } | null;
    /** Preview rows and dry runs still stored (supabase/cleanup-fake-data.sql removes them). Needs 0002. */
    previewData: { hives: number; launches: number; dryRunActions: number; dryRunHarvests: number } | null;
  };
  queenKey: { set: boolean; valid: boolean };
  rpc: { set: boolean; reachable: boolean | null };
  heliusKey: boolean;
  hub: { wallet: boolean; secret: boolean; mint: boolean; ready: boolean };
  cronSecret: boolean;
  siteUrl: boolean;
  /** When each engine job last ran to the end (ms epoch), in this launch mode. */
  engine: { lastHourly: number | null; lastHarvest: number | null; lastRefresh: number | null };
  /** liveModeProblems(): live launches are refused while this is not empty. */
  problems: string[];
  /** Not blocking, but worth fixing. */
  warnings: string[];
}

export interface HealthDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

let cached: { at: number; report: Promise<HealthReport> } | null = null;

/** The current report, at most CACHE_MS old. */
export function healthReport(deps: HealthDeps = {}): Promise<HealthReport> {
  const now = (deps.now ?? Date.now)();
  if (cached && now - cached.at < CACHE_MS) return cached.report;
  const report = buildReport(deps);
  cached = { at: now, report };
  report.catch(() => {
    if (cached?.report === report) cached = null;
  });
  return report;
}

/** Test hook. */
export function resetHealthCache() {
  cached = null;
}

const timed =
  (f: typeof fetch, ms: number): typeof fetch =>
  (input, init) =>
    f(input, { ...init, signal: AbortSignal.timeout(ms) });

async function buildReport(deps: HealthDeps): Promise<HealthReport> {
  const f = timed(deps.fetch ?? fetch, PROBE_MS);
  const live = config.launchMode === 'live';
  const hub = resolveHub({}, 'live');
  // without SOLANA_RPC_URL there is no RPC of ours to check (the public fallback is not worth probing)
  const rpcSet = !!process.env.SOLANA_RPC_URL?.trim();
  const [supabase, rpcReachable, engine] = await Promise.all([probeSupabase(f), rpcSet ? probeRpc(f) : Promise.resolve(null), engineRuns()]);
  const problems = live ? liveModeProblems() : [];
  const warnings: string[] = [];
  if (live) {
    if (!config.cronSecret) warnings.push('CRON_SECRET is not set: the engine (fees, seal / store / swarm, harvest) cannot be scheduled.');
    else if (config.cronSecret.length < 32) warnings.push('CRON_SECRET is short: use at least 32 random characters (`openssl rand -hex 32`).');
    if (!config.heliusApiKey) warnings.push('HELIUS_API_KEY is not set: bee counts stay at 0 and abandon payouts wait.');
    if (hub.problem) warnings.push(`Harvest: ${hub.problem}`);
    if (config.demoHives) warnings.push('NEXT_PUBLIC_DEMO_HIVES is on: browsers also show 60 simulated demo hives.');
    if (supabase.reachable === false) warnings.push('Supabase did not answer.');
    if (supabase.schema && !supabase.schema.present) warnings.push(`Supabase tables missing: ${supabase.schema.missingTables.join(', ')}. Run supabase/migrations/0001_hive.sql.`);
    if (supabase.schema?.present && supabase.schema.version !== 2) warnings.push('Run supabase/migrations/0002_live.sql: until then preview hives block their cells and this check cannot see the realtime setup.');
    if (supabase.schema?.realtime === false) warnings.push('Realtime is off for hives / actions / harvests: browsers only update once a minute.');
    if (supabase.anonRead === false) warnings.push('The anon key cannot read hives: check NEXT_PUBLIC_SUPABASE_ANON_KEY.');
    if (rpcReachable === false) warnings.push('The Solana RPC did not answer getHealth.');
    const p = supabase.previewData;
    if (p && p.hives + p.launches + p.dryRunActions + p.dryRunHarvests > 0) warnings.push('Preview / dry-run rows are stored (hidden from the public in live mode). supabase/cleanup-fake-data.sql removes them.');
  }
  return {
    ok: !live || problems.length === 0,
    checkedAt: Date.now(),
    launchMode: config.launchMode,
    dryRun: live ? config.engineDryRun : false,
    demoHives: config.demoHives,
    store: hasSupabase() ? 'supabase' : 'file',
    supabase,
    queenKey: { set: !!config.queenKeySecret, valid: !!config.queenKeySecret && queenKeyValid(config.queenKeySecret) },
    rpc: { set: rpcSet, reachable: rpcReachable },
    heliusKey: !!config.heliusApiKey,
    hub: { wallet: !!config.hubWallet, secret: !!config.hubSecret, mint: !!config.hubTokenMint, ready: !!hub.keypair && !!hub.wallet && !!hub.mint },
    cronSecret: !!config.cronSecret,
    siteUrl: !!config.siteUrl,
    engine,
    problems,
    warnings,
  };
}

async function probeRpc(f: typeof fetch): Promise<boolean | null> {
  try {
    const res = await f(config.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { result?: unknown } | null;
    return body?.result === 'ok';
  } catch {
    return false;
  }
}

type SupabaseHealth = HealthReport['supabase'];

/** PostgREST could not find the function (PGRST202), or Postgres says it does not exist (42883). */
const missingFunction = (code?: string) => code === 'PGRST202' || code === '42883';
/** The table does not exist (Postgres 42P01, PostgREST's schema cache PGRST205). */
const missingTable = (code?: string) => code === '42P01' || code === 'PGRST205';

async function probeSupabase(f: typeof fetch): Promise<SupabaseHealth> {
  const out: SupabaseHealth = { configured: hasSupabase(), anonKey: !!config.supabase.anonKey, reachable: null, anonRead: null, schema: null, previewData: null };
  if (!out.configured) return out;
  const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: f } };
  const sb = createClient(config.supabase.url!, config.supabase.serviceKey!, opts);
  try {
    const { data, error, status } = await sb.rpc('hive_schema_info');
    if (!status) {
      out.reachable = false; // no HTTP answer: network failure or timeout (postgrest-js reports status 0)
    } else if (!error && data && typeof data === 'object') {
      const info = data as { version?: number; tables?: string[]; realtime?: { allTables?: boolean; tables?: string[] }; preview?: SupabaseHealth['previewData'] };
      const tables = Array.isArray(info.tables) ? info.tables : [];
      const rt = info.realtime;
      out.reachable = true;
      out.schema = {
        present: HEALTH_TABLES.every((t) => tables.includes(t)),
        missingTables: HEALTH_TABLES.filter((t) => !tables.includes(t)),
        version: typeof info.version === 'number' ? info.version : null,
        realtime: rt ? !!rt.allTables || ['hives', 'actions', 'harvests'].every((t) => rt.tables?.includes(t)) : null,
      };
      out.previewData = info.preview ?? null;
    } else {
      // 0002 not applied (missingFunction), or the call failed in the database: probe the tables one by one
      if (error && !missingFunction(error.code)) console.warn('[hive] health: hive_schema_info failed:', error.code ?? 'no code');
      const missing: string[] = [];
      let answered = false;
      const probes = await Promise.all(HEALTH_TABLES.map((t) => sb.from(t).select('*', { head: true, count: 'exact' }).limit(1)));
      probes.forEach((r, i) => {
        if (!r.status) return; // no answer
        answered = true;
        if (r.error && missingTable(r.error.code)) missing.push(HEALTH_TABLES[i]);
      });
      out.reachable = answered;
      if (answered) out.schema = { present: missing.length === 0, missingTables: missing, version: missing.length ? null : 1, realtime: null };
    }
  } catch {
    out.reachable = false;
  }
  if (out.anonKey && out.reachable) {
    try {
      const anon = createClient(config.supabase.url!, config.supabase.anonKey!, opts);
      const { error } = await anon.from('hives').select('ca').limit(1);
      out.anonRead = !error;
    } catch {
      out.anonRead = false;
    }
  }
  return out;
}

/** `p`, or `dflt` once PROBE_MS have passed (the store's own client has no timeout). */
const within = <T>(p: Promise<T>, dflt: T) => Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(dflt), PROBE_MS).unref?.())]);

async function engineRuns(): Promise<HealthReport['engine']> {
  const at = async (job: 'hourly' | 'harvest' | 'refresh') => {
    try {
      const raw = await within((await getDb()).getMeta(ENGINE_META.lastRun(config.launchMode, job)), null);
      const v = raw ? (JSON.parse(raw) as { at?: unknown }).at : null;
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  };
  const [lastHourly, lastHarvest, lastRefresh] = await Promise.all([at('hourly'), at('harvest'), at('refresh')]);
  return { lastHourly, lastHarvest, lastRefresh };
}
