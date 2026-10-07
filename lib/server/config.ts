import 'server-only';
/**
 * Server configuration from environment variables. Everything has a safe default:
 * with no env at all the app runs in mock launch mode on a local file store.
 */
import { LAUNCH_COST, QUEEN_RESERVE } from '@/lib/sim';
import { LIMITS, type LaunchMode, type PublicConfig } from '@/lib/shared/api';

const env = (k: string) => {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : undefined;
};
const flag = (k: string, dflt: boolean) => {
  const v = env(k);
  if (v === undefined) return dflt;
  return !/^(0|false|no|off)$/i.test(v);
};
const num = (k: string, dflt: number) => {
  const v = Number(env(k));
  return Number.isFinite(v) && env(k) !== undefined ? v : dflt;
};

export const config = {
  /** 'live' sends real transactions. Requires SOLANA_RPC_URL, QUEEN_KEY_SECRET and a database. */
  launchMode: (env('LAUNCH_MODE') === 'live' ? 'live' : 'mock') as LaunchMode,
  supabase: {
    url: env('NEXT_PUBLIC_SUPABASE_URL'),
    anonKey: env('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'),
  },
  /** File store location when Supabase is not configured. */
  // Vercel's filesystem is read-only except /tmp (and /tmp is per instance: use Supabase for real multi-user)
  dataDir: env('DATA_DIR') ?? (process.env.VERCEL ? '/tmp/hive-data' : '.data'),
  rpcUrl: env('SOLANA_RPC_URL') ?? 'https://api.mainnet-beta.solana.com',
  /** 32-byte key (base64 or hex) that encrypts queen secret keys at rest. */
  queenKeySecret: env('QUEEN_KEY_SECRET'),
  priorityFeeSol: num('PRIORITY_FEE_SOL', 0.0005),
  slippagePct: num('SLIPPAGE_PCT', 10),
  pumpPortalUrl: env('PUMPPORTAL_URL') ?? 'https://pumpportal.fun/api/trade-local',
  pumpIpfsUrl: env('PUMP_IPFS_URL') ?? 'https://pump.fun/api/ipfs',
  pumpCoinApi: env('PUMP_COIN_API') ?? 'https://frontend-api-v3.pump.fun/coins',
  heliusApiKey: env('HELIUS_API_KEY'),
  /** Hub (harvest) wallet: base58 secret key, and the $HIVE mint it buys. */
  hubSecret: env('HUB_WALLET_SECRET'),
  hubWallet: env('HUB_WALLET'),
  hubTokenMint: env('HUB_TOKEN_MINT'),
  /** The hourly engine only records what it would do unless this is explicitly off. */
  engineDryRun: flag('ENGINE_DRY_RUN', true),
  cronSecret: env('CRON_SECRET'),
  demoHives: flag('NEXT_PUBLIC_DEMO_HIVES', true),
  costs: { launchCost: num('LAUNCH_COST_SOL', LAUNCH_COST), queenReserve: num('QUEEN_RESERVE_SOL', QUEEN_RESERVE), maxDevBuy: LIMITS.maxDevBuy },
  siteUrl: env('NEXT_PUBLIC_SITE_URL'),
};

export const hasSupabase = () => !!(config.supabase.url && config.supabase.serviceKey);

/** Problems that make live mode unsafe to run; empty means live mode is fully configured. */
export function liveModeProblems(): string[] {
  const p: string[] = [];
  if (!config.queenKeySecret) p.push('QUEEN_KEY_SECRET is not set.');
  if (!process.env.SOLANA_RPC_URL) p.push('SOLANA_RPC_URL is not set (use a paid RPC for mainnet).');
  if (!hasSupabase()) p.push('Supabase is not configured: live mode needs a durable database, not the local file store.');
  else if (!config.supabase.anonKey) p.push('NEXT_PUBLIC_SUPABASE_ANON_KEY is not set: browsers need it to see other users\' hives in realtime.');
  return p;
}

/**
 * What the browser needs. `realtime` is 'supabase' only when browsers can subscribe themselves (URL +
 * anon key); otherwise 'sse', which /api/stream serves for both stores: the file store's in-process
 * feed, or (a Supabase store without an anon key) a loop that polls the database.
 */
export function publicConfig(): PublicConfig {
  const realtime = config.supabase.url && config.supabase.anonKey && hasSupabase() ? 'supabase' : 'sse';
  return {
    launchMode: config.launchMode,
    realtime,
    supabaseUrl: realtime === 'supabase' ? config.supabase.url : undefined,
    supabaseAnonKey: realtime === 'supabase' ? config.supabase.anonKey : undefined,
    demoHives: config.demoHives,
    costs: config.costs,
  };
}
