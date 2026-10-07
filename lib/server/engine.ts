import 'server-only';
/**
 * THE QUEEN ENGINE: what every remote hive's queen does each hour, the hub's harvest, and the stat
 * refresh. Remote hives only: status 'live' with LiveChain in live mode, status 'mock' with MockChain in
 * mock mode. Both run the same code; the chain decides whether anything real moves.
 *
 *   runHourly   per hive: claim creator fees → 20% to the hub → plan (engine-plan.ts) → SEAL (buy, then
 *               burn exactly what was bought) / STORE / SWARM (buy the neighbour's coin) → actions →
 *               hive stats → STARVE after 6 silent hours, ABANDON (vault paid out) after 24.
 *   runHarvest  the hub buys $HIVE with its pooled SOL, burns half and sends half to the queen of the
 *               biggest working hive (royal jelly).
 *   runRefresh  honey from the queen balance, bees from holders, price into the price history, state
 *               from the last fee. Writes a hive only when something changed.
 *
 * Money safety:
 *  - One run per hour and per kind of run (real / dry): a db lock plus an hour mark per mode
 *    (`engine:<mode>:<real|dry>:lastHour`); on top of that every hive records the hour it ran in its own
 *    state (`engine:hive:<ca>`) BEFORE it sends anything, so a crash or a retry can never send twice in
 *    an hour. Hours are compared by start time, so a mark written in the other mode (or with another
 *    hour length) never blocks a run, and dry runs keep their own marks and statistics: a forced dry run
 *    never uses up the real hour.
 *  - Fees are booked against the queen's balance saved BEFORE the claim. If anything fails between the
 *    claim and the booking (a claim that timed out, an RPC error), the next run counts those fees.
 *  - The hour being carried out is journalled in the hive's state before the first send and after each
 *    one, and feed entries go through an outbox: a run that dies part-way, or a db write that fails, is
 *    recorded by the next run. A send whose outcome is unknown (timed out) is never repeated blindly.
 *  - The engine's own state is the authority for lastFeeAt and feesTotal, and starving / abandoning is
 *    decided from it; the hive row is a display copy that a concurrent writer (the refresh) may
 *    overwrite. The row is re-read before an abandon payout.
 *  - No send starts unless it can finish inside the run's time budget (the cron route's maxDuration).
 *  - Burns and harvest splits are driven by token balances measured against a baseline saved before
 *    the buy, so a retried step only does what is still missing, and nobody else's tokens are touched
 *    (the queen may hold her owner's dev-buy tokens; the hub may hold its own $HIVE).
 *  - Nothing is planned below the queen's reserve (engine-plan.ts).
 *  - dryRun sends nothing at all (not even the fee claim): it records what would have happened.
 *  - Secrets never leave this module; errors are logged as messages with URL queries stripped.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';
import { theme } from '@/themes';
import { HOUR_MS } from '@/lib/sim';
import { hexDistance } from '@/lib/hex';
import { DEFAULT_RULES, clampRules } from '@/lib/queen';
import { isBase58Address, type LaunchMode, type RemoteAction, type RemoteHarvest, type RemoteHive, type RemoteState } from '@/lib/shared/api';
import { config } from './config';
import { getDb, type Db } from './db';
import { BASE_FEE_LAMPORTS, TxError, getChain, type Chain, type TokenBalance } from './chain';
import { keypairFromEnc } from './keys';
import { LIVE_HOUR_MS, feeGrowth, fmtSol, nextFeeAvg, planHour, type PlanInput, type PlanNeighbour, type QueenPlan } from './engine-plan';

/* ================================================================== */
/* knobs                                                               */
/* ================================================================== */

const LAMPORTS = 1e9;
/** Locks outlive the cron route's maxDuration (300 s), so a killed run cannot overlap the next one. */
const HOURLY_LOCK_MS = 330_000;
const HARVEST_LOCK_MS = 330_000;
const REFRESH_LOCK_MS = 120_000;
/** SOL the hub keeps for its own network fees. */
export const HUB_RESERVE_SOL = 0.01;
/** Smallest harvest buy worth sending. */
export const MIN_HARVEST_SOL = 0.001;
/** Smallest abandon payout per holder: above the rent-exempt minimum of an empty account (0.00089 SOL). */
export const MIN_PAYOUT_LAMPORTS = 1_000_000;
/**
 * Most holders one abandon payout pays (one transfer each, within the run's time budget). With more
 * holder wallets than this, the vault goes pro-rata to the MAX_PAYOUT_RECIPIENTS biggest of them and
 * smaller holders get nothing.
 */
export const MAX_PAYOUT_RECIPIENTS = 100;
/**
 * How long after a harvest burn or royal-jelly transfer with an unknown outcome (it timed out, or its
 * run died) before it may be sent again: it was sent within its run (≤ 300 s) and can land until its
 * blockhash expires (~90 s later); until then the balance is not final.
 */
export const UNSURE_SEND_SETTLE_MS = 10 * 60 * 1000;
/** A buy that has not shown up in the balance after this many hours never will (its blockhash expired). */
const PENDING_GIVE_UP_HOURS = 2;
/** Time budget of one engine run: the cron route's maxDuration (300 s) minus room to record and answer. */
export const RUN_BUDGET_MS = 270_000;
/** A live send can take this long (PumpPortal 20 s + confirmation 50 s, plus margin): none starts with less left. */
export const LIVE_SEND_WINDOW_MS = 75_000;
/** Time kept after a hive's last send to record its hour (live). */
const LIVE_RECORD_MS = 15_000;
/** The mock chain answers at once. */
const MOCK_SEND_WINDOW_MS = 1_000;
const MOCK_RECORD_MS = 1_000;
/** Most feed entries a hive keeps for a later write; the oldest are dropped beyond it. */
const OUTBOX_CAP = 100;

type RunKind = 'real' | 'dry';
const kindOf = (dry: boolean): RunKind => (dry ? 'dry' : 'real');

/**
 * Meta keys. Run marks are per mode (a mock deployment and a live one may share a database) and per kind
 * of run (a dry run never uses up the real hour). Per-hive state needs no mode: a hive has one status.
 */
export const ENGINE_META = {
  lastHour: (mode: LaunchMode, dry: boolean) => `engine:${mode}:${kindOf(dry)}:lastHour`,
  lastHarvestHour: (mode: LaunchMode, dry: boolean) => `engine:${mode}:${kindOf(dry)}:lastHarvestHour`,
  hubPlanned: (mode: LaunchMode, dry: boolean) => `engine:${mode}:${kindOf(dry)}:hubPlanned`,
  openHarvest: (mode: LaunchMode) => `engine:${mode}:harvest:open`,
  /** Set (to an expiry time) while the hourly run or the harvest writes hive rows; the refresh stays off them. */
  busy: (mode: LaunchMode, job: 'hourly' | 'harvest') => `engine:${mode}:busy:${job}`,
  hive: (ca: string) => `engine:hive:${ca}`,
  /** Dev-buy tokens a launch still owes its owner (DevTokensOwed): it went live without sending them. */
  devOwed: (ca: string) => `engine:devOwed:${ca}`,
} as const;

/** Length of an engine hour: a real hour live, the simulator's mock hour (60 s) in mock mode. */
export const engineHourMs = (mode: LaunchMode) => (mode === 'live' ? LIVE_HOUR_MS : HOUR_MS);

/* ================================================================== */
/* context                                                             */
/* ================================================================== */

/** The hub: who signs the harvest, where queens send their 20%, and the $HIVE mint. */
export interface HubSetup {
  /** Signs the harvest. Null: harvests are recorded as dry runs only. */
  keypair: Keypair | null;
  /** Where queens send the hub share. Null: the share stays with each queen. */
  wallet: string | null;
  /** The $HIVE mint the harvest buys. */
  mint: string | null;
  /** Why the hub is (partly) disabled, for the summary. Never contains secrets. */
  problem?: string;
}

/** Everything defaults to the real thing; tests inject fakes. */
export interface EngineCtx {
  /** Logical time of the run (ms). Default: now. */
  now?: number;
  /** Record what would happen without sending anything. */
  dryRun?: boolean;
  db?: Db;
  chain?: Chain;
  mode?: LaunchMode;
  /** Length of an engine hour. Default engineHourMs(mode). */
  hourMs?: number;
  /** Hub override (tests). Default: from config, or an in-memory hub in mock mode. */
  hub?: HubSetup;
  /** SOL every queen keeps. Default config.costs.queenReserve. */
  reserveSol?: number;
  /** Wait between token-balance re-reads after a buy (RPC lag). Default 1.5 s live, 0 mock. */
  settleMs?: number;
  /** Hives processed at the same time. Default 4. */
  concurrency?: number;
  /** Wall clock for the time budget (ms). Default Date.now; tests inject a fake. */
  clock?: () => number;
  /**
   * When (clock ms) the run must be done: no hive starts and no send begins that could run past it.
   * The cron route passes one deadline to both the hourly run and the harvest. Default: start + budgetMs.
   */
  deadline?: number;
  /** Time budget when no deadline is given (ms). Default RUN_BUDGET_MS. */
  budgetMs?: number;
  /** No send starts with less time than this left (ms). Default 75 s on a live chain, 1 s on the mock chain. */
  sendWindowMs?: number;
}

interface Deps {
  db: Db;
  chain: Chain;
  mode: LaunchMode;
  now: number;
  dryRun: boolean;
  hourMs: number;
  hour: number;
  reserveSol: number;
  settleMs: number;
  concurrency: number;
  clock: () => number;
  deadline: number;
  sendWindowMs: number;
  recordMs: number;
  /** Network cost set aside per transaction (base fee + priority fee). */
  txCostSol: number;
  /** What a buy may cost over its amount (slippage + fee headroom), as a fraction. */
  buyOverhead: number;
  ctx: EngineCtx;
}

async function deps(ctx: EngineCtx): Promise<Deps> {
  const mode = ctx.mode ?? config.launchMode;
  const db = ctx.db ?? (await getDb());
  const chain = ctx.chain ?? (await getChain());
  // Mock hives have made-up coins: never let them near a real chain.
  if (mode === 'mock' && chain.kind === 'live') throw new Error('The engine refuses to run mock hives against the live chain.');
  const now = ctx.now ?? Date.now();
  const hourMs = ctx.hourMs && ctx.hourMs > 0 ? ctx.hourMs : engineHourMs(mode);
  const clock = ctx.clock ?? Date.now;
  const live = chain.kind === 'live';
  return {
    db,
    chain,
    mode,
    now,
    dryRun: !!ctx.dryRun,
    hourMs,
    hour: Math.floor(now / hourMs),
    reserveSol: ctx.reserveSol ?? config.costs.queenReserve,
    settleMs: ctx.settleMs ?? (live ? 1500 : 0),
    concurrency: Math.max(1, Math.floor(ctx.concurrency ?? 4)),
    clock,
    deadline: ctx.deadline ?? clock() + (ctx.budgetMs ?? RUN_BUDGET_MS),
    sendWindowMs: Math.max(0, ctx.sendWindowMs ?? (live ? LIVE_SEND_WINDOW_MS : MOCK_SEND_WINDOW_MS)),
    recordMs: live ? LIVE_RECORD_MS : MOCK_RECORD_MS,
    txCostSol: Math.max(0, config.priorityFeeSol) + BASE_FEE_LAMPORTS / LAMPORTS,
    buyOverhead: mode === 'live' ? Math.max(0, config.slippagePct) / 100 + 0.02 : 0,
    ctx,
  };
}

/* ================================================================== */
/* small helpers                                                       */
/* ================================================================== */

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pct = (n: number) => Math.round(n * 100);
const round9 = (n: number) => Math.round(n * 1e9) / 1e9;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const join = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(' ');
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** An error message safe to log or return: no URL query strings (RPC URLs carry API keys), one line, bounded. */
export function safeErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg
    .replace(/(https?:\/\/[^\s?#'"]+)[?#][^\s'"]*/g, '$1?…')
    .replace(/(api[-_]?key|token|secret)=([^\s&'"]+)/gi, '$1=…')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

function isPubkey(s: unknown): s is string {
  if (typeof s !== 'string' || !isBase58Address(s)) return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

/** A wallet a person controls (on the ed25519 curve), not a program-derived account like a bonding curve. */
function isPersonalWallet(s: string): boolean {
  try {
    return PublicKey.isOnCurve(new PublicKey(s).toBytes());
  } catch {
    return false;
  }
}

/** Token amount for humans. */
function fmtTokens(raw: bigint, decimals: number): string {
  const n = Number(raw) / 10 ** decimals;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}
const uiAmount = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

/** Run `fn` over `items` with at most `size` at a time. `fn` must not throw. */
async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
  return out;
}

/**
 * A send that certainly moved nothing. Per the Chain contract (chain.ts) every failure after a
 * transaction was signed and broadcast is a TxError; anything else failed before broadcasting
 * (PumpPortal refused, the guard refused to sign, no blockhash). A TxError is final only when it
 * landed and failed, or can no longer land; `landed: undefined` (timed out) may still land.
 */
const definitelyNotSent = (e: unknown) => !(e instanceof TxError) || e.landed !== undefined;

/* ---------- time budget ---------- */

const timeLeft = (d: Deps) => d.deadline - d.clock();
/** A send may start only if it can finish inside the run's budget. */
const canSend = (d: Deps) => timeLeft(d) >= d.sendWindowMs;
/** A hive's hour may start only if a claim and recording it fit. */
const canStartHive = (d: Deps) => timeLeft(d) >= d.sendWindowMs + d.recordMs;

/* ---------- hour marks ---------- */

interface HourMark {
  hour: number;
  hourMs: number;
}

/**
 * Whether an hour that already ran (index `hour` of hours `hourMs` long) covers the current hour.
 * Compared by start time, so a mark written with another hour length (the other mode, or an older
 * build) cannot block a run for ages; an unknown length (legacy state) is taken as the current one.
 */
function covers(d: Deps, hour: number, hourMs: number): boolean {
  if (!Number.isFinite(hour) || hour < 0) return false;
  const len = Number.isFinite(hourMs) && hourMs > 0 ? hourMs : d.hourMs;
  return hour * len >= d.hour * d.hourMs;
}

function parseMark(raw: string | null): HourMark | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Partial<HourMark>;
    return typeof m.hour === 'number' && typeof m.hourMs === 'number' && Number.isFinite(m.hour) && m.hourMs > 0 ? { hour: m.hour, hourMs: m.hourMs } : null;
  } catch {
    return null;
  }
}
const markOf = (d: Deps) => JSON.stringify({ hour: d.hour, hourMs: d.hourMs } satisfies HourMark);

/** Whether the hourly run or the harvest is writing hive rows right now (their busy flags). */
async function engineBusy(d: Deps): Promise<boolean> {
  for (const job of ['hourly', 'harvest'] as const) {
    const v = Number(await d.db.getMeta(ENGINE_META.busy(d.mode, job)).catch(() => null));
    if (Number.isFinite(v) && v > Date.now()) return true;
  }
  return false;
}

/* ================================================================== */
/* keys                                                                */
/* ================================================================== */

let warnedMockSigner = false;

/**
 * The queen's keypair. In mock mode only, a queen whose key cannot be read (the throwaway dev key of
 * another process or bundle encrypted it; see keys.ts) acts through a public-key-only stand-in:
 * MockChain identifies accounts by public key and never signs. A live chain never gets one.
 */
async function queenSigner(d: Deps, hive: RemoteHive): Promise<Keypair> {
  const mockOk = d.mode === 'mock' && d.chain.kind === 'mock';
  const enc = await d.db.getSecret(hive.queenWallet);
  let kp: Keypair | null = null;
  if (enc) {
    try {
      kp = keypairFromEnc(enc);
    } catch (e) {
      if (!mockOk) throw new Error(`The ${theme.agent} key could not be decrypted (${safeErr(e)}).`);
    }
  } else if (!mockOk) {
    throw new Error(`The ${theme.agent} key is missing.`);
  }
  if (kp) {
    if (kp.publicKey.toBase58() !== hive.queenWallet) throw new Error(`The stored ${theme.agent} key does not match its wallet.`);
    return kp;
  }
  if (!warnedMockSigner) {
    warnedMockSigner = true;
    console.warn(`[hive] engine: some mock ${theme.agent} keys are unreadable (set QUEEN_KEY_SECRET to keep them across restarts); using public-key stand-ins on the mock chain.`);
  }
  return { publicKey: new PublicKey(hive.queenWallet), secretKey: new Uint8Array(64) } as unknown as Keypair;
}

/** Parse a secret key given as base58 (64 bytes) or a JSON byte array (Solana CLI format). Null if invalid. */
function parseSecretKey(raw: string): Keypair | null {
  try {
    const t = raw.trim();
    const bytes = t.startsWith('[') ? Uint8Array.from(JSON.parse(t) as number[]) : bs58.decode(t);
    if (bytes.length !== 64) return null;
    return Keypair.fromSecretKey(bytes); // validates that the public half matches
  } catch {
    return null;
  }
}

const mockHubRegistry = globalThis as unknown as { __hiveMockHubKeyV1?: Keypair };

/** The hub as configured. Mock mode always has one (an in-memory key unless HUB_WALLET_SECRET is set). */
export function resolveHub(ctx: EngineCtx, mode: LaunchMode): HubSetup {
  if (ctx.hub) return ctx.hub;
  if (mode === 'mock') {
    const kp = (config.hubSecret && parseSecretKey(config.hubSecret)) || (mockHubRegistry.__hiveMockHubKeyV1 ??= Keypair.generate());
    const mint = config.hubTokenMint ?? theme.hubToken.ca;
    return { keypair: kp, wallet: kp.publicKey.toBase58(), mint };
  }
  const problems: string[] = [];
  let keypair: Keypair | null = null;
  if (config.hubSecret) {
    keypair = parseSecretKey(config.hubSecret);
    if (!keypair) problems.push('HUB_WALLET_SECRET is not a valid secret key (base58 or JSON byte array).');
  }
  let wallet: string | null = config.hubWallet ?? keypair?.publicKey.toBase58() ?? null;
  if (wallet && !isPubkey(wallet)) {
    problems.push('HUB_WALLET is not a valid address.');
    wallet = null;
  }
  if (keypair && wallet && keypair.publicKey.toBase58() !== wallet) {
    // Ambiguous configuration: send nowhere rather than to the wrong wallet.
    problems.push('HUB_WALLET does not match HUB_WALLET_SECRET; the hub is disabled until they agree.');
    keypair = null;
    wallet = null;
  }
  let mint = config.hubTokenMint ?? null;
  if (mint && !isPubkey(mint)) {
    problems.push('HUB_TOKEN_MINT is not a valid address.');
    mint = null;
  }
  if (!wallet) problems.push('No hub wallet: queens keep the harvest share.');
  else if (!keypair) problems.push('No hub key: harvests are recorded as dry runs.');
  else if (!mint) problems.push('HUB_TOKEN_MINT is not set: harvests are recorded as dry runs.');
  return { keypair, wallet, mint, problem: problems.length ? problems.join(' ') : undefined };
}

/* ================================================================== */
/* per-hive engine state (db meta, never sent to browsers)             */
/* ================================================================== */

export interface PayoutPlan {
  at: number;
  vaultLamports: number;
  holders: number;
  recipients: { owner: string; lamports: number; tx?: string; uncertain?: boolean }[];
  doneAt?: number;
}

/** What one kind of run (real or dry) remembers between hours. */
export interface RunStats {
  /** The last engine hour this kind of run took (-1: never). Taken before anything is sent. */
  hour: number;
  /** That hour's length (ms); 0 = unknown (older state). */
  hourMs: number;
  /** Hourly fee average (EMA), SOL. */
  feeAvgHour: number;
  /** Fees of the last hour it ran and of the one before (for fee growth), SOL. */
  feesHour: number;
  feesPrevHour: number;
  lastSwarmAt: number | null;
  /** Hub share owed from earlier hours (too small to send, or a transfer that certainly failed), SOL. */
  hubCarrySol: number;
}

/** How a send of the hour went. `sending`: started, outcome not recorded (the run stopped). */
export type SendState = 'sending' | 'sent' | 'failed' | 'unconfirmed' | 'skipped';

/** The hour being carried out: saved before the first send and after each one, cleared once recorded. */
export interface OpenHour {
  hour: number;
  at: number;
  /** Fees counted this hour, SOL. */
  fees: number;
  claimTx?: string;
  /** The hive was starving when the hour began (fees revive it). */
  wasStarving: boolean;
  plan: Pick<QueenPlan, 'hubShareSol' | 'hubSol' | 'seal' | 'storeSol' | 'swarm' | 'dipBelow' | 'reasons'>;
  hub?: SendState;
  /** `sent`: the buy went through (or its tokens arrived); `burned` is a raw token amount. */
  seal?: { state: SendState; buyTx?: string; burnTx?: string; burned?: string; decimals?: number };
  swarm?: { state: SendState; tx?: string };
  /** Starve / abandon entries decided at the end of the hour. */
  lifecycle: RemoteAction[];
}

export interface HiveEngineState {
  v: 2;
  real: RunStats;
  /** Dry runs: their own hour, averages and cooldown, plus the claimable fees seen last time (lamports). */
  dry: RunStats & { claimable: number };
  /**
   * The engine's record of the last fee seen (a claim, or a dry run's preview) and of all fees claimed
   * (SOL; null until first set from the hive row). The hive row only shows copies of them.
   */
  lastFeeAt: number | null;
  feesTotal: number | null;
  /** A fee claim not booked yet: her balance before it (lamports). The next run measures from it. */
  claim: { before: number; at: number; tx?: string } | null;
  /** A seal buy whose tokens are not burned yet. `before` = her token balance before the buy (raw units). */
  sealPending: { before: string; at: number; sol: number; buyTx?: string } | null;
  open: OpenHour | null;
  /** Feed entries composed but not written yet. */
  outbox: RemoteAction[];
  /** An abandon payout in progress (frozen recipient list) or done. */
  payout: PayoutPlan | null;
}

const freshStats = (): RunStats => ({ hour: -1, hourMs: 0, feeAvgHour: 0, feesHour: 0, feesPrevHour: 0, lastSwarmAt: null, hubCarrySol: 0 });

const freshState = (): HiveEngineState => ({
  v: 2,
  real: freshStats(),
  dry: { ...freshStats(), claimable: 0 },
  lastFeeAt: null,
  feesTotal: null,
  claim: null,
  sealPending: null,
  open: null,
  outbox: [],
  payout: null,
});

const finite = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const finiteOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function readStats(j: Record<string, unknown>): RunStats {
  return {
    hour: finite(j.hour, -1),
    hourMs: Math.max(0, finite(j.hourMs, 0)),
    feeAvgHour: Math.max(0, finite(j.feeAvgHour, 0)),
    feesHour: Math.max(0, finite(j.feesHour, 0)),
    feesPrevHour: Math.max(0, finite(j.feesPrevHour, 0)),
    lastSwarmAt: finiteOrNull(j.lastSwarmAt),
    hubCarrySol: Math.max(0, finite(j.hubCarrySol, 0)),
  };
}

const isAction = (a: unknown): a is RemoteAction => isObj(a) && typeof a.id === 'string' && !!a.id && typeof a.ca === 'string' && typeof a.verb === 'string' && Number.isFinite(a.at);

function readOpen(v: unknown): OpenHour | null {
  if (!isObj(v)) return null;
  const p = v.plan;
  if (!Number.isFinite(v.hour) || !Number.isFinite(v.at) || !Number.isFinite(v.fees) || !isObj(p) || !isObj(p.reasons)) return null;
  const o = v as unknown as OpenHour;
  return { ...o, lifecycle: Array.isArray(o.lifecycle) ? o.lifecycle.filter(isAction) : [] };
}

/** Read a hive's engine state. A corrupt record throws: guessing could repeat an hour's sends. */
export async function readHiveState(db: Db, ca: string): Promise<HiveEngineState> {
  const raw = await db.getMeta(ENGINE_META.hive(ca));
  if (!raw) return freshState();
  let j: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObj(parsed)) throw new Error('not an object');
    j = parsed;
  } catch {
    throw new Error(`Engine state for ${ca} is not valid JSON; fix or delete meta "${ENGINE_META.hive(ca)}".`);
  }
  // Version 1 kept the real run's statistics at the top level and the dry preview in `dryClaimable`.
  const v2 = j.v === 2;
  const dryRaw: Record<string, unknown> = v2 && isObj(j.dry) ? j.dry : {};
  const sp = j.sealPending;
  const claim = j.claim;
  const payout = j.payout;
  const open = j.open == null ? null : readOpen(j.open);
  if (j.open != null && !open) console.warn(`[hive] engine: dropped an unreadable open hour for ${ca}.`);
  return {
    v: 2,
    real: readStats(v2 && isObj(j.real) ? j.real : j),
    dry: { ...readStats(dryRaw), claimable: Math.max(0, finite(v2 ? dryRaw.claimable : j.dryClaimable, 0)) },
    lastFeeAt: finiteOrNull(j.lastFeeAt),
    feesTotal: finiteOrNull(j.feesTotal),
    claim: isObj(claim) && Number.isFinite(claim.before) ? { before: claim.before as number, at: finite(claim.at, 0), tx: typeof claim.tx === 'string' ? claim.tx : undefined } : null,
    sealPending: isObj(sp) && typeof sp.before === 'string' && /^\d+$/.test(sp.before) ? { before: sp.before, at: finite(sp.at, 0), sol: finite(sp.sol, 0), buyTx: typeof sp.buyTx === 'string' ? sp.buyTx : undefined } : null,
    open,
    outbox: Array.isArray(j.outbox) ? j.outbox.filter(isAction) : [],
    payout: isObj(payout) && Array.isArray(payout.recipients) ? (payout as unknown as PayoutPlan) : null,
  };
}

const writeHiveState = (db: Db, ca: string, st: HiveEngineState) => db.setMeta(ENGINE_META.hive(ca), JSON.stringify(st));

/** Add feed entries to the outbox (once per id; the oldest are dropped beyond OUTBOX_CAP). */
function queueActions(st: HiveEngineState, actions: RemoteAction[]) {
  for (const a of actions) if (!st.outbox.some((x) => x.id === a.id)) st.outbox.push(a);
  if (st.outbox.length > OUTBOX_CAP) {
    const dropped = st.outbox.splice(0, st.outbox.length - OUTBOX_CAP);
    console.warn(`[hive] engine: dropped ${dropped.length} feed entries that could not be written.`);
  }
}

/* ================================================================== */
/* shared pieces                                                       */
/* ================================================================== */

/** Honey: the queen's SOL above her reserve. */
const honeyOf = (d: Deps, lamports: number) => Math.max(0, round9(lamports / LAMPORTS - d.reserveSol));

/** The later of two fee times (undefined when neither is known). */
function newestFee(a: number | null | undefined, b: number | null | undefined): number | undefined {
  const x = Math.max(a ?? -Infinity, b ?? -Infinity);
  return Number.isFinite(x) ? x : undefined;
}

/** Working ↔ starving from the time since the last fee. Abandonment needs a payout, so only runHourly does it. */
export function stateFromSilence(current: RemoteState, lastFeeAt: number, now: number, hourMs: number): RemoteState {
  if (current === 'abandoned') return 'abandoned';
  return (now - lastFeeAt) / hourMs >= theme.rules.starveHours ? 'starving' : 'working';
}

const starveAction = (ca: string, lastFeeAt: number, at: number): RemoteAction => ({
  id: `starve-${ca}-${lastFeeAt}`, // the same id from runHourly and runRefresh: recorded once
  ca,
  verb: 'starve',
  amount: 0,
  reason: `No fees for ${theme.rules.starveHours} consecutive hours. ${cap(theme.holderPlural)} are leaving and the ${theme.unit} is going grey.`,
  at,
});

const jellyReason = `${cap(theme.hubRitual)} ${theme.copy.reward}: biggest ${theme.unit} by ${theme.copy.resource} received ${pct(theme.hubSplit.toBiggest)}% of the ${theme.hubToken.symbol} bought this hour.`;

/**
 * Mock mode: MockChain's ledger lives in process memory and starts empty after a restart or on another
 * server instance, while the hives are persisted. Without this its first answers (balance 0, a made-up
 * coin) would overwrite every hive's honey, price and bees. Hives it has never seen are handed to it
 * from their stored rows (honey + reserve as her balance); hives it knows are left alone.
 */
function adoptMockHives(d: Deps, hives: RemoteHive[]) {
  if (d.mode !== 'mock' || d.chain.kind !== 'mock') return;
  type Adopt = (input: { queenWallet: string; mint: string; lamports: number; price?: number; holders: number; createdAt: number }) => boolean;
  const adopt = (d.chain as Chain & { adopt?: Adopt }).adopt;
  if (typeof adopt !== 'function') return;
  for (const h of hives) {
    try {
      const honey = Number.isFinite(h.honey) ? Math.max(0, h.honey) : 0;
      adopt.call(d.chain, { queenWallet: h.queenWallet, mint: h.ca, lamports: Math.round((honey + d.reserveSol) * LAMPORTS), price: h.price, holders: Number.isFinite(h.bees) ? h.bees : 0, createdAt: h.createdAt });
    } catch (e) {
      console.warn(`[hive] engine: mock ledger could not take over ${h.ca}: ${safeErr(e)}`);
    }
  }
}

/** Current price (0 when the chain does not know it) and the average of the last 24 engine hours. */
async function market(d: Deps, hive: RemoteHive): Promise<{ price: number; avg24h: number }> {
  const info = await d.chain.coinInfo(hive.ca).catch(() => null);
  const price = info && Number.isFinite(info.priceSol) && info.priceSol > 0 ? info.priceSol : 0;
  if (price > 0) await d.db.addPrice(hive.ca, d.now, price).catch((e) => console.warn(`[hive] engine: price for ${hive.ca} not saved: ${safeErr(e)}`));
  const pts = await d.db.listPrices(hive.ca, d.now - 24 * d.hourMs).catch(() => []);
  const valid = pts.filter((p) => Number.isFinite(p.price) && p.price > 0 && p.at <= d.now);
  const avg24h = valid.length ? valid.reduce((s, p) => s + p.price, 0) / valid.length : price;
  return { price, avg24h };
}

/** How much of `mint` arrived in `owner` since `before`. Re-reads a few times to ride out RPC lag. */
async function tokenDelta(d: Deps, owner: string, mint: string, before: bigint): Promise<{ delta: bigint; decimals: number }> {
  let last = { delta: 0n, decimals: 6 };
  for (let i = 0; i < 3; i++) {
    const b = await d.chain.tokenBalance(owner, mint);
    last = { delta: b.amount > before ? b.amount - before : 0n, decimals: b.decimals };
    if (last.delta > 0n) return last;
    if (d.settleMs > 0 && i < 2) await sleep(d.settleMs);
  }
  return last;
}

/**
 * Burn whatever a pending seal bought: her balance above the baseline saved before the buy. Clears the
 * pending seal once burned, or once the buy can no longer arrive.
 */
async function settleSeal(d: Deps, queen: Keypair, hive: RemoteHive, st: HiveEngineState): Promise<{ burned: bigint; decimals: number; burnTx?: string; sol: number; gaveUp?: boolean }> {
  const p = st.sealPending;
  if (!p) return { burned: 0n, decimals: 6, sol: 0 };
  const { delta, decimals } = await tokenDelta(d, hive.queenWallet, hive.ca, BigInt(p.before));
  if (delta <= 0n) {
    if (d.now - p.at > PENDING_GIVE_UP_HOURS * d.hourMs) {
      st.sealPending = null;
      await writeHiveState(d.db, hive.ca, st);
      return { burned: 0n, decimals, sol: p.sol, gaveUp: true };
    }
    return { burned: 0n, decimals, sol: p.sol };
  }
  const r = await d.chain.burn({ owner: queen, mint: hive.ca, amount: delta });
  st.sealPending = null;
  await writeHiveState(d.db, hive.ca, st);
  return { burned: delta, decimals, burnTx: r.signature, sol: p.sol };
}

/** Record on the launch that its dev-buy tokens were delivered (best effort: the transfer is what counts). */
async function noteDevDelivered(d: Deps, ca: string, launchId: string | undefined, signature: string) {
  if (!launchId) return;
  try {
    const l = await d.db.getLaunch(launchId);
    if (l && l.mintPubkey === ca && l.state === 'live' && !l.txs.devTransfer) {
      await d.db.updateLaunch(l.id, { txs: { ...l.txs, devTransfer: signature }, error: '', updatedAt: d.now }, ['live']);
    }
  } catch (e) {
    console.warn(`[hive] engine: dev-buy delivery for ${ca} not noted on its launch: ${safeErr(e)}`);
  }
}

/** Claimable creator fees without claiming (LiveChain and test chains expose it). Null when unknown. */
async function peekClaimable(chain: Chain, queen: Keypair): Promise<number | null> {
  const fn = (chain as Chain & { claimableCreatorFees?: (creator: PublicKey) => Promise<number> }).claimableCreatorFees;
  if (typeof fn !== 'function') return null;
  try {
    const v = await fn.call(chain, queen.publicKey);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  } catch {
    return null;
  }
}

/* ================================================================== */
/* dev-buy tokens a launch still owes                                  */
/* ================================================================== */

/**
 * The owner's dev-buy tokens, left in the queen wallet when her launch went live because every transfer
 * failed (launch.ts). `amount`: raw units the dev buy brought in (unknown when no balance read
 * succeeded); `unsureAt`: a transfer was started then and its outcome is unknown.
 */
export interface DevTokensOwed {
  owner: string;
  amount?: string;
  launchId?: string;
  unsureAt?: number;
}

export async function readDevOwed(db: Db, ca: string): Promise<DevTokensOwed | null> {
  const raw = await db.getMeta(ENGINE_META.devOwed(ca));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DevTokensOwed>;
    if (!isObj(v) || typeof v.owner !== 'string' || !isBase58Address(v.owner)) return null;
    return {
      owner: v.owner,
      amount: typeof v.amount === 'string' && /^\d+$/.test(v.amount) ? v.amount : undefined,
      launchId: typeof v.launchId === 'string' ? v.launchId : undefined,
      unsureAt: finiteOrNull(v.unsureAt) ?? undefined,
    };
  } catch {
    return null;
  }
}

export const writeDevOwed = (db: Db, ca: string, v: DevTokensOwed | null) => db.setMeta(ENGINE_META.devOwed(ca), v ? JSON.stringify(v) : '');

/**
 * Send owed dev-buy tokens from the queen to the owner, once. The caller makes sure the engine is not
 * working on this queen (no hour in progress, no seal whose bought tokens are unburned), so her balance
 * of her own coin is the dev buy alone, or less if an earlier transfer landed after all (a transfer
 * moves the whole amount at once): then nothing is owed any more. A transfer with an unknown outcome is
 * journalled first and not repeated before UNSURE_SEND_SETTLE_MS, when the balance is final.
 * Throws when the transfer fails (still owed).
 */
export async function deliverDevTokens(
  input: { db: Db; chain: Chain; queen: Keypair; queenWallet: string; ca: string; now: number },
): Promise<{ owed: boolean; signature?: string; launchId?: string; waitMs?: number }> {
  const { db, chain, ca, now } = input;
  const owed = await readDevOwed(db, ca);
  if (!owed) return { owed: false };
  if (owed.unsureAt !== undefined && now - owed.unsureAt < UNSURE_SEND_SETTLE_MS) return { owed: true, waitMs: owed.unsureAt + UNSURE_SEND_SETTLE_MS - now };
  const bal = await chain.tokenBalance(input.queenWallet, ca);
  const amount = owed.amount !== undefined ? BigInt(owed.amount) : bal.amount;
  if (amount <= 0n || bal.amount < amount) {
    await writeDevOwed(db, ca, null); // delivered earlier after all (or nothing to deliver)
    return { owed: false };
  }
  const next: DevTokensOwed = { ...owed, amount: amount.toString(), unsureAt: now };
  await writeDevOwed(db, ca, next); // intent first
  try {
    const { signature } = await chain.transferTokens({ from: input.queen, mint: ca, to: owed.owner, amount });
    await writeDevOwed(db, ca, null);
    return { owed: false, signature, launchId: owed.launchId };
  } catch (e) {
    await writeDevOwed(db, ca, { ...next, unsureAt: definitelyNotSent(e) ? undefined : now }).catch(() => {});
    throw e;
  }
}

/* ================================================================== */
/* recording an hour                                                   */
/* ================================================================== */

/**
 * The feed entries of an hour, in the simulator's voice, from what was planned and what the sends did.
 * `stale`: the run that opened the hour stopped part-way, so a send without a recorded outcome may or
 * may not have happened.
 */
function hourActions(ca: string, o: OpenHour, dry: boolean, stale = false): RemoteAction[] {
  const R = theme.copy.resource;
  const p = o.plan;
  const tag = dry ? 'dry-' : '';
  const flag = dry ? { dryRun: true as const } : {};
  const share = `${pct(theme.feeToHub)}% ${theme.hubRitual} share (${fmtSol(p.hubSol)} SOL)`;
  const hub = o.hub ?? (stale && p.hubSol > 0 ? 'sending' : undefined);
  let hubText = '';
  if (p.reasons.hub) {
    if (dry && p.hubSol > 0) hubText = `${pct(theme.feeToHub)}% (${fmtSol(p.hubSol)} SOL) would go to the ${theme.hubRitual}.`;
    else if (hub === 'failed' || hub === 'skipped') hubText = `The ${share} could not be sent this hour; it follows next hour.`;
    else if (hub === 'unconfirmed') hubText = `The ${share} was sent but has not confirmed; it is not sent again.`;
    else if (hub === 'sending') hubText = `The run stopped while sending the ${share}; it is not sent again.`;
    else hubText = p.reasons.hub;
  }

  const out: RemoteAction[] = [];
  if (o.fees > 0) {
    // a seal whose buy has no recorded outcome after a stopped run: its pending burn settles it later
    const seal = o.seal?.state ?? (stale && p.seal ? 'unconfirmed' : undefined);
    if (p.seal && (dry || seal === 'sent')) {
      const burned = o.seal?.burned && /^\d+$/.test(o.seal.burned) ? BigInt(o.seal.burned) : 0n;
      const burnText = dry ? '' : burned > 0n ? `${fmtTokens(burned, o.seal?.decimals ?? 6)} tokens burned.` : 'The burn follows once the bought tokens show up.';
      out.push({ id: `${tag}seal-${ca}-${o.hour}`, ca, verb: 'seal', amount: round9(p.seal.sol), reason: join(p.reasons.seal, burnText, hubText), txSig: dry ? undefined : o.seal?.burnTx ?? o.seal?.buyTx, at: o.at, ...flag });
    } else {
      const lead = `Price ${p.dipBelow !== null ? `${(p.dipBelow * 100).toFixed(1)}% ` : ''}below 24h average`;
      const reason = !p.seal
        ? p.reasons.store
        : seal === 'unconfirmed'
          ? `${lead}, but the ${theme.verbs.burn} buy has not confirmed. Fees stored as ${R}; anything it bought is burned once it shows up.`
          : seal === 'skipped'
            ? `${lead}, but this run ran out of time before the ${theme.verbs.burn} buy. Fees stored as ${R}.`
            : `${lead}, but the ${theme.verbs.burn} buy did not go through. Fees stored as ${R}.`;
      const amount = p.storeSol + (p.seal ? p.seal.sol : 0);
      out.push({ id: `${tag}store-${ca}-${o.hour}`, ca, verb: 'store', amount: round9(amount), reason: join(reason, hubText), txSig: dry ? undefined : o.claimTx, at: o.at, ...flag });
    }
  }
  const swarm = o.swarm?.state;
  if (p.swarm && (dry || swarm === 'sent' || swarm === 'unconfirmed' || swarm === 'sending')) {
    const unsure = !dry && swarm !== 'sent';
    out.push({ id: `${tag}swarm-${ca}-${o.hour}`, ca, verb: 'swarm', amount: round9(p.swarm.sol), targetCa: p.swarm.targetCa, reason: join(p.reasons.swarm ?? '', unsure && 'The buy has not confirmed yet.'), txSig: dry ? undefined : o.swarm?.tx, at: o.at, ...flag });
  }
  if (o.fees > 0 && o.wasStarving) {
    out.push({ id: `revive-${ca}-${o.hour}`, ca, verb: 'store', amount: 0, reason: `Fees are back. ${cap(theme.holderPlural)} return to the ${theme.unit}.`, at: o.at });
  }
  out.push(...o.lifecycle);
  return out;
}

/** Write the outbox's feed entries (each is idempotent by id); what fails stays for the next run. Never throws. */
async function flushOutbox(d: Deps, ca: string, st: HiveEngineState, res: HiveRunResult): Promise<void> {
  if (!st.outbox.length) return;
  const left: RemoteAction[] = [];
  for (const a of st.outbox) {
    try {
      await d.db.addAction(a);
    } catch (e) {
      left.push(a);
      res.errors.push(`recording ${a.verb}: ${safeErr(e)}`);
    }
  }
  st.outbox = left;
  try {
    await writeHiveState(d.db, ca, st);
  } catch (e) {
    // the entries stay in the stored outbox and are written again (as no-ops) next run
    res.errors.push(`saving the outbox: ${safeErr(e)}`);
  }
}

/**
 * Write the hive row from the engine's state (lastFeeAt, feesTotal) and this run's findings. Re-reads the
 * row first so what a refresh wrote meanwhile (bees, price) is kept. Never throws: the engine's state is
 * the record, the row is rewritten by every later run and refresh.
 */
async function writeRow(d: Deps, hive: RemoteHive, st: HiveEngineState, res: HiveRunResult, patch: { state?: RemoteState; honeyLamports?: number | null; price?: number }): Promise<void> {
  try {
    const cur = (await d.db.getHive(hive.ca)) ?? hive;
    await d.db.upsertHive({
      ...cur,
      honey: patch.honeyLamports == null ? cur.honey : honeyOf(d, patch.honeyLamports),
      feesTotal: st.feesTotal === null ? cur.feesTotal : round9(st.feesTotal),
      lastFeeAt: newestFee(cur.lastFeeAt, st.lastFeeAt),
      price: patch.price && patch.price > 0 ? patch.price : cur.price,
      state: cur.state === 'abandoned' ? 'abandoned' : patch.state ?? cur.state,
      updatedAt: d.now,
    });
  } catch (e) {
    res.errors.push(`saving the ${theme.unit}: ${safeErr(e)}`);
  }
}

/** Record an hour that a stopped run left open, and write feed entries still owed. Never throws on db writes. */
async function settleBooks(d: Deps, hive: RemoteHive, st: HiveEngineState, res: HiveRunResult): Promise<void> {
  if (!st.open) return flushOutbox(d, hive.ca, st, res);
  queueActions(st, hourActions(hive.ca, st.open, false, true));
  st.open = null;
  res.notes.push('Recorded an earlier hour that stopped part-way.');
  if (st.outbox.length) return flushOutbox(d, hive.ca, st, res);
  try {
    await writeHiveState(d.db, hive.ca, st);
  } catch (e) {
    res.errors.push(`saving the hour: ${safeErr(e)}`);
  }
}

/* ================================================================== */
/* abandon payout                                                      */
/* ================================================================== */

/**
 * Split `vaultLamports` pro-rata over the holders. Only with a complete holder list (every holder
 * known), only to personal wallets (no bonding curve / pool accounts), never to `exclude`d addresses.
 * At most MAX_PAYOUT_RECIPIENTS wallets are paid: the biggest by amount, pro-rata among themselves.
 * Shares below MIN_PAYOUT_LAMPORTS are skipped (their dust stays in the vault). `retry`: nothing can be
 * planned because the holder data is missing or incomplete, which may change; anything else is final.
 */
export function planPayout(
  vaultLamports: number,
  holders: { count: number; top: { owner: string; amount: bigint }[]; complete?: boolean } | null,
  exclude: Set<string>,
): { recipients: { owner: string; lamports: number }[]; why?: string; retry?: boolean } {
  if (!(vaultLamports >= MIN_PAYOUT_LAMPORTS)) return { recipients: [], why: 'it is too small to split' };
  if (!holders) return { recipients: [], why: 'the holder list is not available here', retry: true };
  if (!holders.top.length || holders.top.length < holders.count || holders.complete === false) {
    return { recipients: [], why: `only ${holders.top.length} of its ${holders.count}${holders.complete === false ? '+' : ''} ${theme.holderPlural} are known here`, retry: true };
  }
  const eligible = holders.top.filter((h) => typeof h.owner === 'string' && typeof h.amount === 'bigint' && h.amount > 0n && !exclude.has(h.owner) && isPersonalWallet(h.owner));
  if (!eligible.length) return { recipients: [], why: `no ${theme.holder} wallet can receive it` };
  // biggest first (a stable sort: ties keep the chain's order)
  const list = eligible
    .slice()
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
    .slice(0, MAX_PAYOUT_RECIPIENTS);
  const total = list.reduce((s, h) => s + h.amount, 0n);
  const vault = BigInt(Math.floor(vaultLamports));
  const recipients = list.map((h) => ({ owner: h.owner, lamports: Number((vault * h.amount) / total) })).filter((r) => r.lamports >= MIN_PAYOUT_LAMPORTS);
  if (!recipients.length) return { recipients: [], why: 'every share is too small to send' };
  return { recipients };
}

/**
 * Pay an abandoned hive's vault (balance above the reserve) to its holders. The plan is frozen on first
 * use and each transfer is recorded as it lands, so a retry pays only who is still unpaid; a transfer
 * with an unknown outcome is never repeated. Returns done=false while transfers are still owed.
 */
async function payOut(d: Deps, hive: RemoteHive, queen: Keypair, st: HiveEngineState, hubWallet: string | null, res: HiveRunResult): Promise<{ done: boolean; action?: RemoteAction }> {
  const ca = hive.ca;
  const abandoned = `No fees for ${theme.rules.abandonHours} hours. ${cap(theme.unit)} abandoned.`;
  if (!st.payout) {
    const balance = await d.chain.balance(hive.queenWallet);
    const vault = Math.max(0, balance - Math.round(d.reserveSol * LAMPORTS));
    const holders = await d.chain.holders(ca).catch(() => null);
    const exclude = new Set([hive.queenWallet, ca, ...(hubWallet ? [hubWallet] : [])]);
    const plan = planPayout(vault, holders, exclude);
    if (!plan.recipients.length && plan.retry && d.chain.kind === 'live') {
      // The holders are owed this vault, but who they are is not fully known (yet): nothing is frozen
      // or marked done, the hive stays in the hourly run (starving) and the payout is tried again
      // every hour until a complete holder list is available. Mock coins never have one: below.
      res.notes.push(`Abandon payout waits: ${plan.why}. It is tried again next hour.`);
      return {
        done: false,
        action: {
          id: `abandon-wait-${ca}`,
          ca,
          verb: 'starve',
          amount: 0,
          reason: `No fees for ${theme.rules.abandonHours} hours. Its vault of ${fmtSol(vault / LAMPORTS)} SOL is due to its ${theme.holderPlural} pro-rata, but ${plan.why}, so it stays in the ${theme.agent} wallet and the payout is tried again every hour.`,
          at: d.now,
        },
      };
    }
    if (!plan.recipients.length) {
      st.payout = { at: d.now, vaultLamports: vault, holders: holders?.count ?? 0, recipients: [], doneAt: d.now };
      await writeHiveState(d.db, ca, st);
      return {
        done: true,
        action: {
          id: `abandon-${ca}`,
          ca,
          verb: 'abandon',
          amount: 0,
          reason: `${abandoned} Its vault of ${fmtSol(vault / LAMPORTS)} SOL is due to its ${theme.holderPlural} pro-rata, but ${plan.why}, so it stays in the ${theme.agent} wallet until it can be paid. The cell stays on the map as grey comb.`,
          at: d.now,
        },
      };
    }
    st.payout = { at: d.now, vaultLamports: vault, holders: holders?.count ?? plan.recipients.length, recipients: plan.recipients };
    await writeHiveState(d.db, ca, st);
  }
  const payout = st.payout;
  let failures = 0;
  for (const r of payout.recipients) {
    if (r.tx || r.uncertain) continue;
    if (!canSend(d)) {
      res.notes.push('Out of time in this run: the rest of the abandon payout follows next hour.');
      break;
    }
    try {
      r.tx = (await d.chain.transferSol({ from: queen, to: r.owner, lamports: r.lamports })).signature;
      failures = 0;
    } catch (e) {
      res.errors.push(`payout to ${r.owner.slice(0, 6)}…: ${safeErr(e)}`);
      if (!definitelyNotSent(e)) {
        // it may still land: never pay twice
        r.uncertain = true;
        if (e instanceof TxError && e.signature) r.tx = e.signature;
      }
      if (++failures >= 3) break;
    } finally {
      await writeHiveState(d.db, ca, st);
    }
  }
  if (payout.recipients.some((r) => !r.tx && !r.uncertain)) {
    res.notes.push(`Abandon payout incomplete; the rest is paid next hour.`);
    return { done: false };
  }
  payout.doneAt = d.now;
  await writeHiveState(d.db, ca, st);
  const sent = payout.recipients.filter((r) => r.tx && !r.uncertain);
  const unsure = payout.recipients.filter((r) => r.uncertain);
  const paidSol = sent.reduce((s, r) => s + r.lamports, 0) / LAMPORTS;
  return {
    done: true,
    action: {
      id: `abandon-${ca}`,
      ca,
      verb: 'abandon',
      amount: round9(paidSol),
      reason: `${abandoned} Vault of ${fmtSol(payout.vaultLamports / LAMPORTS)} SOL paid out pro-rata to ${sent.length} ${theme.holderPlural}${unsure.length ? ` (${unsure.length} more transfer${unsure.length > 1 ? 's' : ''} unconfirmed)` : ''}. The cell stays on the map as grey comb.`,
      txSig: sent[0]?.tx,
      at: d.now,
    },
  };
}

/* ================================================================== */
/* hourly                                                              */
/* ================================================================== */

export interface HiveRunResult {
  ca: string;
  ticker: string;
  ok: boolean;
  skipped?: string;
  feesSol?: number;
  hubShareSol?: number;
  hubSentSol?: number;
  sealSol?: number;
  storeSol?: number;
  swarm?: { targetCa: string; sol: number };
  state?: RemoteState;
  /** Out of time before its hour began: it runs on the next call (the hour is not marked done). */
  deferred?: boolean;
  txs: Record<string, string>;
  notes: string[];
  errors: string[];
}

export interface HourlySummary {
  mode: LaunchMode;
  dryRun: boolean;
  hour: number;
  at: number;
  ms: number;
  skipped?: string;
  /** Out of time: hives not reached run next time (the hour is not marked done). */
  incomplete?: boolean;
  hubPlannedSol: number;
  hubSentSol: number;
  hives: HiveRunResult[];
  notes: string[];
}

interface HourCtx {
  hubWallet: string | null;
  neighbours: PlanNeighbour[];
}

const OUT_OF_TIME = 'Out of time in this run; it runs next time.';

export async function runHourly(ctx: EngineCtx = {}): Promise<HourlySummary> {
  const d = await deps(ctx);
  const t0 = Date.now();
  const summary: HourlySummary = { mode: d.mode, dryRun: d.dryRun, hour: d.hour, at: d.now, ms: 0, hubPlannedSol: 0, hubSentSol: 0, hives: [], notes: [] };
  const done = () => ({ ...summary, ms: Date.now() - t0 });
  if (!(await d.db.lock('engine:hourly', Date.now() + HOURLY_LOCK_MS))) return { ...done(), skipped: 'Another hourly run is in progress.' };
  const busyKey = ENGINE_META.busy(d.mode, 'hourly');
  try {
    const markKey = ENGINE_META.lastHour(d.mode, d.dryRun);
    const mark = parseMark(await d.db.getMeta(markKey));
    if (mark && covers(d, mark.hour, mark.hourMs)) return { ...done(), skipped: 'This hour already ran.' };
    await d.db.setMeta(busyKey, String(Date.now() + HOURLY_LOCK_MS));

    const active = (await d.db.listHives()).filter((h) => h.status === d.mode && h.state !== 'abandoned');
    adoptMockHives(d, active);
    // Neighbour fee growth comes from a snapshot taken before any hive runs, so order does not matter.
    const states = new Map<string, HiveEngineState>();
    for (const h of active) states.set(h.ca, await readHiveState(d.db, h.ca).catch(() => freshState()));
    const growth = (ca: string) => {
      const s = states.get(ca);
      const k = s && (d.dryRun ? s.dry : s.real);
      // a hive that has not run for a while has no recent fees to grow
      return k && k.hour >= d.hour - 1 ? feeGrowth(k.feesHour, k.feesPrevHour) : 0;
    };

    const hub = resolveHub(ctx, d.mode);
    if (hub.problem) summary.notes.push(hub.problem);

    summary.hives = await pool(active, d.concurrency, async (h): Promise<HiveRunResult> => {
      if (!canStartHive(d)) return { ca: h.ca, ticker: h.ticker, ok: false, skipped: OUT_OF_TIME, deferred: true, txs: {}, notes: [], errors: [] };
      const neighbours = active
        .filter((o) => o.ca !== h.ca && o.state === 'working')
        .map((o) => ({ ca: o.ca, ticker: o.ticker, distance: hexDistance(o.cell, h.cell), feeGrowth: growth(o.ca) }))
        .filter((n) => n.distance <= 3);
      try {
        return await runHive(d, h, { hubWallet: hub.wallet && hub.wallet !== h.queenWallet ? hub.wallet : null, neighbours });
      } catch (e) {
        // This hive's hour was not booked; the others carry on. Anything it claimed is counted on its
        // next run (the balance before the claim is saved), and any send it began is in its journal.
        return { ca: h.ca, ticker: h.ticker, ok: false, txs: {}, notes: [], errors: [safeErr(e)] };
      }
    });
    for (const r of summary.hives) {
      summary.hubPlannedSol += r.hubShareSol ?? 0;
      summary.hubSentSol += r.hubSentSol ?? 0;
      if (r.errors.length) console.error(`[hive] engine: ${r.ticker} (${r.ca}) this hour: ${r.errors.join('; ')}`);
    }
    summary.hubPlannedSol = round9(summary.hubPlannedSol);
    summary.hubSentSol = round9(summary.hubSentSol);
    await d.db.setMeta(ENGINE_META.hubPlanned(d.mode, d.dryRun), JSON.stringify({ hour: d.hour, hourMs: d.hourMs, shareSol: summary.hubPlannedSol, sentSol: summary.hubSentSol }));
    if (summary.hives.some((h) => h.deferred)) summary.incomplete = true;
    else await d.db.setMeta(markKey, markOf(d));
    return done();
  } finally {
    await d.db.setMeta(busyKey, '').catch(() => {});
    await d.db.unlock('engine:hourly').catch(() => {});
  }
}

/**
 * One queen's hour. Throws only before the hour is booked (nothing sent but possibly the fee claim,
 * which the next run counts); later failures are collected in `errors`.
 */
async function runHive(d: Deps, hive: RemoteHive, hc: HourCtx): Promise<HiveRunResult> {
  const { db, chain } = d;
  const ca = hive.ca;
  const qw = hive.queenWallet;
  const dry = d.dryRun;
  const res: HiveRunResult = { ca, ticker: hive.ticker, ok: true, txs: {}, notes: [], errors: [] };
  const st = await readHiveState(db, ca);
  const save = () => writeHiveState(db, ca, st);
  const finish = (extra: Partial<HiveRunResult> = {}): HiveRunResult => ({ ...res, ok: res.errors.length === 0, ...extra });

  /* ---- an earlier hour that stopped part-way, and feed entries still owed ---- */
  await settleBooks(d, hive, st, res);

  /* ---- paid out already, but the row does not say so yet ---- */
  if (st.payout?.doneAt) {
    await writeRow(d, hive, st, res, { state: 'abandoned' });
    return finish({ state: 'abandoned', skipped: `Abandoned; its row is brought up to date.` });
  }

  const stats = dry ? st.dry : st.real;
  if (covers(d, stats.hour, stats.hourMs)) return finish({ skipped: 'Already ran this hour.' });
  const queen = await queenSigner(d, hive);

  /* ---- an abandon payout that started in an earlier hour finishes first ---- */
  if (st.payout && !st.payout.doneAt) {
    if (dry) return finish({ skipped: 'An abandon payout is in progress; dry runs leave it alone.' });
    st.real.hour = d.hour;
    st.real.hourMs = d.hourMs;
    await save();
    let p: { done: boolean; action?: RemoteAction } = { done: false };
    try {
      p = await payOut(d, hive, queen, st, hc.hubWallet, res);
    } catch (e) {
      res.errors.push(`abandon: ${safeErr(e)}`);
    }
    if (p.action) queueActions(st, [p.action]);
    await flushOutbox(d, ca, st, res);
    const end = await chain.balance(qw).catch(() => null);
    const state: RemoteState = p.done ? 'abandoned' : hive.state;
    await writeRow(d, hive, st, res, { state, honeyLamports: end });
    return finish({ state });
  }

  /* ---- 0a. dev-buy tokens her launch could not deliver before it went live (live chains only) ----
   * Not gated on dry-run: the tokens are the owner's, bought by the launch (which already sends for
   * real), and the launch told them the tokens arrive within the hour. */
  if (!st.sealPending && canSend(d)) {
    try {
      const r = await deliverDevTokens({ db, chain, queen, queenWallet: qw, ca, now: d.now });
      if (r.signature) {
        res.txs.devTokens = r.signature;
        res.notes.push(`Sent the owner the dev-buy tokens that were still in the ${theme.agent} wallet.`);
        await noteDevDelivered(d, ca, r.launchId, r.signature);
      }
    } catch (e) {
      res.errors.push(`dev-buy tokens: ${safeErr(e)}`);
    }
  }

  /* ---- 0. an earlier seal whose burn has not happened: burn what it bought ---- */
  if (!dry && st.sealPending && canSend(d)) {
    try {
      const r = await settleSeal(d, queen, hive, st);
      if (r.burnTx) {
        res.txs.lateBurn = r.burnTx;
        queueActions(st, [
          {
            id: `seal-late-${ca}-${d.hour}`,
            ca,
            verb: 'seal',
            amount: round9(r.sol),
            reason: `The ${theme.verbs.burn} buy from an earlier hour confirmed late: the ${fmtTokens(r.burned, r.decimals)} tokens it bought are burned.`,
            txSig: r.burnTx,
            at: d.now,
          },
        ]);
        await save();
      } else if (r.gaveUp) {
        res.notes.push(`An earlier ${theme.verbs.burn} buy never arrived; stopped waiting for it.`);
      }
    } catch (e) {
      res.errors.push(`earlier ${theme.verbs.burn}: ${safeErr(e)}`);
    }
  }

  /* ---- 1. creator fees ---- */
  let feesLamports = 0;
  let feesKnown = true;
  let claimTx: string | undefined;
  let wallet: number; // the queen's real balance (lamports)
  let planBalance: number; // the balance the plan works with (a dry run adds the unclaimed fees)
  if (dry) {
    wallet = await chain.balance(qw);
    planBalance = wallet;
    const claimable = await peekClaimable(chain, queen);
    if (claimable === null) {
      feesKnown = false;
      res.notes.push('Dry run: claimable fees cannot be previewed on this chain, so this hour is not counted.');
    } else {
      // fees that appeared since the last dry hour; a drop means someone claimed in between
      feesLamports = claimable >= st.dry.claimable ? claimable - st.dry.claimable : claimable;
      st.dry.claimable = claimable;
      planBalance = wallet + claimable;
    }
  } else {
    // An earlier late burn may have used up the time: the claim waits for the next call then.
    if (!canSend(d)) return finish({ skipped: OUT_OF_TIME, deferred: true });
    // The balance before the claim is saved first: whatever happens after the claim, the fees it
    // brought are counted (now, or by the next run if this one stops before booking the hour).
    const carried = st.claim;
    if (!carried) {
      st.claim = { before: await chain.balance(qw), at: d.now };
      await save();
    }
    const baseline = (carried ?? st.claim)!.before;
    let claim: { signature: string } | null = null;
    try {
      claim = await chain.collectCreatorFees(queen);
    } catch (e) {
      if (definitelyNotSent(e)) throw e; // nothing claimed; the saved baseline stays for the next run
      // It may still land: book nothing now. The next run measures from the saved baseline.
      if (e instanceof TxError && e.signature && st.claim) {
        st.claim.tx = e.signature;
        await save();
      }
      res.errors.push(`fee claim: ${safeErr(e)}`);
      res.notes.push('The fee claim has not confirmed; its fees are counted on the next run.');
      return finish();
    }
    wallet = await chain.balance(qw);
    planBalance = wallet;
    if (claim) {
      claimTx = claim.signature;
      res.txs.claim = claimTx;
    } else if (carried?.tx) {
      claimTx = carried.tx;
    }
    // The claim's own network fee comes out of this delta: what is counted is what arrived.
    if (claim || carried) feesLamports = Math.max(0, wallet - baseline);
    st.dry.claimable = 0;
  }
  const fees = feesLamports / LAMPORTS;
  res.feesSol = round9(fees);

  /* ---- 2. market ---- */
  const { price, avg24h } = await market(d, hive);

  /* ---- 3. plan ---- */
  const planInput: PlanInput = {
    feesSol: fees,
    queenBalanceSol: planBalance / LAMPORTS,
    reserveSol: d.reserveSol,
    price,
    avg24h,
    avgHourlyFeesSol: stats.feeAvgHour,
    rules: clampRules(hive.rules ?? DEFAULT_RULES),
    lastSwarmAt: stats.lastSwarmAt,
    now: d.now,
    hourMs: d.hourMs,
    neighbours: hc.neighbours,
    hubEnabled: !!hc.hubWallet,
    hubCarrySol: stats.hubCarrySol,
    sealAllowed: !st.sealPending,
    txCostSol: d.txCostSol,
    buyOverhead: d.buyOverhead,
  };
  let plan: QueenPlan = planHour(planInput);
  // A seal burns exactly what its buy adds to her balance: without the balance before, no seal.
  let sealBaseline: TokenBalance | null = null;
  if (!dry && plan.seal) {
    try {
      sealBaseline = await chain.tokenBalance(qw, ca);
    } catch (e) {
      res.errors.push(`${theme.verbs.burn} baseline: ${safeErr(e)}`);
      plan = planHour({ ...planInput, sealAllowed: false, sealBlockedWhy: 'her token balance could not be read' });
    }
  }
  res.hubShareSol = round9(plan.hubShareSol);
  res.sealSol = plan.seal ? round9(plan.seal.sol) : 0;
  res.storeSol = round9(plan.storeSol);
  if (plan.swarm) res.swarm = { targetCa: plan.swarm.targetCa, sol: round9(plan.swarm.sol) };
  res.notes.push(...plan.notes);

  /* ---- 4. book the hour and open its journal, before anything is sent ---- */
  stats.hour = d.hour;
  stats.hourMs = d.hourMs;
  if (feesKnown) {
    stats.feesPrevHour = stats.feesHour;
    stats.feesHour = fees;
    stats.feeAvgHour = nextFeeAvg(stats.feeAvgHour, fees);
  }
  stats.hubCarrySol = plan.hubCarrySol;
  // A dry run's fees are seen (not claimed): they still show the coin is earning.
  if (fees > 0) st.lastFeeAt = Math.max(st.lastFeeAt ?? 0, d.now);
  const open: OpenHour = {
    hour: d.hour,
    at: d.now,
    fees,
    claimTx,
    wasStarving: hive.state === 'starving',
    plan: { hubShareSol: plan.hubShareSol, hubSol: plan.hubSol, seal: plan.seal, storeSol: plan.storeSol, swarm: plan.swarm, dipBelow: plan.dipBelow, reasons: plan.reasons },
    lifecycle: [],
  };
  if (dry) {
    // the dry cooldown starts with the swarm it records, as a real one would
    if (plan.swarm) st.dry.lastSwarmAt = d.now;
  } else {
    st.feesTotal = round9((st.feesTotal ?? hive.feesTotal ?? 0) + fees);
    st.claim = null;
    if (plan.seal && sealBaseline) st.sealPending = { before: sealBaseline.amount.toString(), at: d.now, sol: plan.seal.sol };
    st.open = open;
  }
  await save();

  /* ---- 5. send (each outcome is journalled) ---- */
  let hubSent = 0;
  if (!dry) {
    if (plan.hubSol > 0 && hc.hubWallet) {
      const lamports = Math.floor(plan.hubSol * LAMPORTS);
      if (!canSend(d)) {
        open.hub = 'skipped';
        st.real.hubCarrySol += plan.hubSol; // certainly not sent: owed next hour
        res.notes.push('Out of time in this run: the hub share follows next hour.');
      } else {
        try {
          res.txs.hub = (await chain.transferSol({ from: queen, to: hc.hubWallet, lamports })).signature;
          hubSent = lamports / LAMPORTS;
          open.hub = 'sent';
        } catch (e) {
          res.errors.push(`hub transfer: ${safeErr(e)}`);
          // certainly not sent: owe it again next hour. Unknown: never risk paying the hub twice.
          if (definitelyNotSent(e)) {
            open.hub = 'failed';
            st.real.hubCarrySol += plan.hubSol;
          } else {
            open.hub = 'unconfirmed';
          }
        }
      }
      await save();
    }
    if (plan.seal && st.sealPending) {
      if (!canSend(d)) {
        st.sealPending = null; // nothing was bought
        open.seal = { state: 'skipped' };
        res.notes.push(`Out of time in this run: no ${theme.verbs.burn} this hour.`);
        await save();
      } else {
        let buyErr: unknown;
        try {
          const buyTx = (await chain.buy({ payer: queen, mint: ca, sol: plan.seal.sol })).signature;
          res.txs.sealBuy = buyTx;
          st.sealPending.buyTx = buyTx;
          open.seal = { state: 'sent', buyTx };
        } catch (e) {
          buyErr = e;
          res.errors.push(`${theme.verbs.burn} buy: ${safeErr(e)}`);
          if (definitelyNotSent(e)) {
            st.sealPending = null; // nothing was bought
            open.seal = { state: 'failed' };
          } else {
            open.seal = { state: 'unconfirmed', buyTx: e instanceof TxError ? e.signature : undefined };
          }
        }
        await save();
        // A buy that timed out may still have landed: the balance decides, now or in a later hour.
        if (st.sealPending && canSend(d)) {
          try {
            const r = await settleSeal(d, queen, hive, st);
            if (r.burnTx) res.txs.sealBurn = r.burnTx;
            if (r.burned > 0n) open.seal = { state: 'sent', buyTx: open.seal?.buyTx ?? (buyErr instanceof TxError ? buyErr.signature : undefined), burnTx: r.burnTx, burned: r.burned.toString(), decimals: r.decimals };
          } catch (e) {
            res.errors.push(`${theme.verbs.burn} burn: ${safeErr(e)}`);
          }
          await save();
        }
      }
    }
    if (plan.swarm) {
      if (!canSend(d)) {
        open.swarm = { state: 'skipped' };
        res.notes.push('Out of time in this run: no swarm this hour.');
      } else {
        // The cooldown starts before the buy: a run that stops mid-buy never swarms twice.
        const prevSwarmAt = st.real.lastSwarmAt;
        st.real.lastSwarmAt = d.now;
        open.swarm = { state: 'sending' };
        await save();
        try {
          const tx = (await chain.buy({ payer: queen, mint: plan.swarm.targetCa, sol: plan.swarm.sol })).signature;
          res.txs.swarm = tx;
          open.swarm = { state: 'sent', tx };
        } catch (e) {
          res.errors.push(`swarm buy: ${safeErr(e)}`);
          if (definitelyNotSent(e)) {
            st.real.lastSwarmAt = prevSwarmAt;
            open.swarm = { state: 'failed' };
          } else {
            // it may still land: keep the cooldown rather than risk a second swarm next hour
            open.swarm = { state: 'unconfirmed', tx: e instanceof TxError ? e.signature : undefined };
          }
        }
      }
      await save();
    }
    res.hubSentSol = round9(hubSent);
  }

  /* ---- 6. life cycle: revival, starving, abandonment (from the engine's own last fee) ---- */
  let lastFeeAt = newestFee(hive.lastFeeAt ?? hive.createdAt, st.lastFeeAt) ?? hive.createdAt;
  let state: RemoteState = hive.state;
  if (feesKnown) {
    state = stateFromSilence(hive.state, lastFeeAt, d.now, d.hourMs);
    if (state === 'starving' && hive.state !== 'starving') open.lifecycle.push(starveAction(ca, lastFeeAt, d.now));
    if (state === 'starving' && (d.now - lastFeeAt) / d.hourMs >= theme.rules.abandonHours) {
      if (dry) {
        const vault = Math.max(0, wallet - Math.round(d.reserveSol * LAMPORTS));
        open.lifecycle.push({ id: `dry-abandon-${ca}`, ca, verb: 'abandon', amount: round9(vault / LAMPORTS), reason: `No fees for ${theme.rules.abandonHours} hours. The ${theme.unit} would be abandoned and its vault of ${fmtSol(vault / LAMPORTS)} SOL paid out pro-rata to its ${theme.holderPlural}.`, at: d.now, dryRun: true });
      } else {
        try {
          // Irreversible: re-read the row first; a newer fee there keeps the hive alive.
          const fresh = await db.getHive(ca);
          lastFeeAt = newestFee(lastFeeAt, fresh?.lastFeeAt) ?? lastFeeAt;
          if ((d.now - lastFeeAt) / d.hourMs >= theme.rules.abandonHours) {
            const p = await payOut(d, hive, queen, st, hc.hubWallet, res);
            if (p.action) open.lifecycle.push(p.action);
            if (p.done) state = 'abandoned';
          } else {
            state = stateFromSilence('working', lastFeeAt, d.now, d.hourMs);
          }
        } catch (e) {
          res.errors.push(`abandon: ${safeErr(e)}`);
        }
      }
    }
  }

  /* ---- 7. record: feed entries (through the outbox), then the hive row ---- */
  queueActions(st, hourActions(ca, open, dry));
  if (!dry) st.open = null;
  try {
    await save();
  } catch (e) {
    // the stored journal still holds the hour: the next run records it (entries are idempotent by id)
    res.errors.push(`saving the hour: ${safeErr(e)}`);
  }
  await flushOutbox(d, ca, st, res);
  const end = dry ? wallet : await chain.balance(qw).catch(() => null);
  await writeRow(d, hive, st, res, { state, honeyLamports: end, price });
  return finish({ state });
}

/* ================================================================== */
/* harvest                                                             */
/* ================================================================== */

export interface HarvestSummary {
  mode: LaunchMode;
  dryRun: boolean;
  hour: number;
  at: number;
  ms: number;
  skipped?: string;
  /** A live harvest waiting for its bought tokens or a step that did not confirm; it resumes next run. */
  pending?: string;
  harvest?: RemoteHarvest;
  notes: string[];
  errors: string[];
}

/** A live harvest in progress, saved before each send (raw token amounts as decimal strings). */
interface OpenHarvest {
  id: string;
  hour: number;
  at: number;
  feesIn: number;
  /** The hub's $HIVE balance before the buy. */
  before: string;
  decimals: number;
  jellyTo: string;
  jellyQueen: string;
  jellySol: number;
  buyTx?: string;
  bought?: string;
  burnAmt?: string;
  jellyAmt?: string;
  burnTx?: string;
  jellyTx?: string;
  /**
   * Set (to the run's time) before a burn / jelly transfer is sent and cleared once its outcome is
   * known: one that timed out, or whose run died, may still land, so it is not re-sent before
   * UNSURE_SEND_SETTLE_MS.
   */
  burnUnsureAt?: number;
  jellyUnsureAt?: number;
  credited?: boolean;
}

async function readOpenHarvest(d: Deps): Promise<OpenHarvest | null> {
  const key = ENGINE_META.openHarvest(d.mode);
  const raw = await d.db.getMeta(key);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as OpenHarvest;
    return o && typeof o.id === 'string' && /^\d+$/.test(o.before) ? o : null;
  } catch {
    throw new Error(`Open harvest record is not valid JSON; fix or clear meta "${key}".`);
  }
}
const saveOpenHarvest = (d: Deps, o: OpenHarvest | null) => d.db.setMeta(ENGINE_META.openHarvest(d.mode), o ? JSON.stringify(o) : '');

/** The biggest working hive by honey (ties: the older one). */
async function biggestWorking(d: Deps): Promise<RemoteHive | null> {
  const hives = (await d.db.listHives()).filter((h) => h.status === d.mode && h.state === 'working');
  hives.sort((a, b) => b.honey - a.honey || a.createdAt - b.createdAt || (a.ca < b.ca ? -1 : 1));
  return hives[0] ?? null;
}

const SPLIT_BPS = { burn: BigInt(Math.round(theme.hubSplit.burn * 10_000)), jelly: BigInt(Math.round(theme.hubSplit.toBiggest * 10_000)) };

export async function runHarvest(ctx: EngineCtx = {}): Promise<HarvestSummary> {
  const d = await deps(ctx);
  const t0 = Date.now();
  const out: HarvestSummary = { mode: d.mode, dryRun: d.dryRun, hour: d.hour, at: d.now, ms: 0, notes: [], errors: [] };
  const done = (extra: Partial<HarvestSummary> = {}) => ({ ...out, ...extra, ms: Date.now() - t0 });
  if (!(await d.db.lock('engine:harvest', Date.now() + HARVEST_LOCK_MS))) return done({ skipped: 'Another harvest is in progress.' });
  const busyKey = ENGINE_META.busy(d.mode, 'harvest');
  try {
    const hub = resolveHub(ctx, d.mode);
    if (hub.problem) out.notes.push(hub.problem);
    const canSendHub = !d.dryRun && !!hub.keypair && !!hub.wallet && !!hub.mint;
    const open = canSendHub ? await readOpenHarvest(d) : null;
    const mark = parseMark(await d.db.getMeta(ENGINE_META.lastHarvestHour(d.mode, d.dryRun)));
    if (!open && mark && covers(d, mark.hour, mark.hourMs)) return done({ skipped: 'This hour’s harvest already ran.' });
    await d.db.setMeta(busyKey, String(Date.now() + HARVEST_LOCK_MS));
    if (!canSendHub) {
      await dryHarvest(d, hub, out);
    } else {
      await liveHarvest(d, { keypair: hub.keypair!, wallet: hub.wallet!, mint: hub.mint! }, open, out);
    }
    return done();
  } catch (e) {
    const msg = safeErr(e);
    console.error(`[hive] engine: harvest failed: ${msg}`);
    out.errors.push(msg);
    return done();
  } finally {
    await d.db.setMeta(busyKey, '').catch(() => {});
    await d.db.unlock('engine:harvest').catch(() => {});
  }
}

/** Dry run (or no hub key / mint): record what the harvest would do with this hour's pool. */
async function dryHarvest(d: Deps, hub: HubSetup, out: HarvestSummary) {
  // The pool: the hub wallet's spendable SOL, plus this hour's share the queens did not actually send.
  let unsent = 0;
  const raw = await d.db.getMeta(ENGINE_META.hubPlanned(d.mode, d.dryRun));
  if (raw) {
    try {
      const p = JSON.parse(raw) as { hour?: number; hourMs?: number; shareSol?: number; sentSol?: number };
      if (p.hour === d.hour && (p.hourMs ?? d.hourMs) === d.hourMs) unsent = Math.max(0, finite(p.shareSol, 0) - finite(p.sentSol, 0));
    } catch {
      /* a broken summary only affects this estimate */
    }
  }
  let pooled = 0;
  if (hub.wallet) {
    const bal = await d.chain.balance(hub.wallet).catch(() => 0);
    pooled = Math.max(0, bal / LAMPORTS - HUB_RESERVE_SOL - 3 * d.txCostSol);
  }
  const feesIn = round9(pooled + unsent);
  await d.db.setMeta(ENGINE_META.lastHarvestHour(d.mode, d.dryRun), markOf(d));
  if (feesIn <= 0) {
    out.skipped = 'Nothing to harvest this hour.';
    return;
  }
  const info = hub.mint ? await d.chain.coinInfo(hub.mint).catch(() => null) : null;
  const price = info && info.priceSol > 0 ? info.priceSol : 0;
  if (!price) out.notes.push(`${theme.hubToken.symbol} price unknown: token amounts not estimated.`);
  const bought = price ? feesIn / price : 0;
  const big = await biggestWorking(d);
  const harvest: RemoteHarvest = {
    id: `dry-harvest-${d.hour}`,
    at: d.now,
    feesIn,
    hiveBought: bought,
    burned: bought * theme.hubSplit.burn,
    jellyTo: big?.ca ?? '',
    jellyAmount: bought * theme.hubSplit.toBiggest,
    jellySol: round9(feesIn * theme.hubSplit.toBiggest),
    txSig: '',
    dryRun: true,
  };
  await d.db.addHarvest(harvest);
  if (big) await d.db.addAction({ id: `dry-jelly-${d.hour}`, ca: big.ca, verb: 'jelly', amount: harvest.jellySol, reason: jellyReason, at: d.now, dryRun: true });
  out.harvest = harvest;
}

/**
 * The real harvest, resumable: buy → measure what arrived → burn the burn share → send the jelly share.
 * Each step is driven by the hub's token balance against the baseline saved before the buy, so a
 * retried step only does what is still missing. A step that would not fit in the run's time budget
 * waits for the next run.
 */
async function liveHarvest(d: Deps, hub: { keypair: Keypair; wallet: string; mint: string }, open: OpenHarvest | null, out: HarvestSummary) {
  const markHour = () => d.db.setMeta(ENGINE_META.lastHarvestHour(d.mode, false), markOf(d));
  if (open) out.notes.push(`Resuming harvest ${open.id}.`);
  if (!open) {
    const big = await biggestWorking(d);
    if (!big) {
      await markHour();
      out.skipped = `No working ${theme.unit} to receive the ${theme.copy.reward}; the pool waits.`;
      return;
    }
    const bal = await d.chain.balance(hub.wallet);
    const spend = Math.floor(((bal / LAMPORTS - HUB_RESERVE_SOL - 3 * d.txCostSol) / (1 + d.buyOverhead)) * 1e9) / 1e9;
    if (!(spend >= MIN_HARVEST_SOL)) {
      await markHour();
      out.skipped = 'Nothing to harvest this hour.';
      return;
    }
    if (!canSend(d)) {
      // not marked: the next run harvests the whole pool
      out.skipped = 'Out of time in this run; the pool is harvested next run.';
      return;
    }
    const before = await d.chain.tokenBalance(hub.wallet, hub.mint);
    open = { id: `harvest-${d.hour}`, hour: d.hour, at: d.now, feesIn: spend, before: before.amount.toString(), decimals: before.decimals, jellyTo: big.ca, jellyQueen: big.queenWallet, jellySol: round9(spend * theme.hubSplit.toBiggest) };
    await saveOpenHarvest(d, open); // intent first: a crash after the buy is resumed, never repeated
    try {
      open.buyTx = (await d.chain.buy({ payer: hub.keypair, mint: hub.mint, sol: spend })).signature;
      await saveOpenHarvest(d, open);
    } catch (e) {
      out.errors.push(`buy: ${safeErr(e)}`);
      if (definitelyNotSent(e)) {
        await saveOpenHarvest(d, null);
        await markHour();
        out.skipped = 'The buy did not go through; the pool waits for the next hour.';
        return;
      }
      // unknown outcome: the balance check below (or the next run) settles it
    }
  }

  const before = BigInt(open.before);
  if (!open.bought) {
    const { delta, decimals } = await tokenDelta(d, hub.wallet, hub.mint, before);
    if (delta <= 0n) {
      if (d.now - open.at > PENDING_GIVE_UP_HOURS * d.hourMs) {
        await saveOpenHarvest(d, null);
        await markHour();
        out.errors.push(`Harvest ${open.id}: the bought ${theme.hubToken.symbol} never arrived; given up.`);
      } else {
        out.pending = `Waiting for the bought ${theme.hubToken.symbol} to show up.`;
      }
      return;
    }
    const burnAmt = (delta * SPLIT_BPS.burn) / 10_000n;
    const jellyAmt = SPLIT_BPS.burn + SPLIT_BPS.jelly === 10_000n ? delta - burnAmt : (delta * SPLIT_BPS.jelly) / 10_000n;
    Object.assign(open, { bought: delta.toString(), decimals, burnAmt: burnAmt.toString(), jellyAmt: jellyAmt.toString() });
    await saveOpenHarvest(d, open);
  }
  const bought = BigInt(open.bought!);
  const burnAmt = BigInt(open.burnAmt ?? '0');
  const jellyAmt = BigInt(open.jellyAmt ?? '0');
  const clamp = (v: bigint, max: bigint) => (v < 0n ? 0n : v > max ? max : v);

  // A burn or jelly transfer that timed out may still land while its blockhash is valid: the balance
  // says nothing final until then, so nothing is sent (again) before UNSURE_SEND_SETTLE_MS has passed.
  const unsettled = (at: number | undefined) => at !== undefined && d.now - at < UNSURE_SEND_SETTLE_MS;
  if (unsettled(open.burnUnsureAt) || unsettled(open.jellyUnsureAt)) {
    const what = unsettled(open.burnUnsureAt) ? 'burn' : `${theme.copy.reward} transfer`;
    out.pending = `The earlier ${what} may still land; it is checked again once it no longer can.`;
    return;
  }

  // Burn: anything above (baseline + jelly share) is burn share not yet burned.
  const bal1 = (await d.chain.tokenBalance(hub.wallet, hub.mint)).amount;
  const burnLeft = clamp(bal1 - (before + jellyAmt), burnAmt);
  if (burnLeft > 0n) {
    if (!canSend(d)) {
      out.pending = 'Out of time in this run: the burn follows next run.';
      return;
    }
    // intent first: a run that dies during the send waits like one whose send timed out
    open.burnUnsureAt = d.now;
    await saveOpenHarvest(d, open);
    try {
      open.burnTx = (await d.chain.burn({ owner: hub.keypair, mint: hub.mint, amount: burnLeft })).signature;
      open.burnUnsureAt = undefined;
    } catch (e) {
      out.errors.push(`burn: ${safeErr(e)}`);
      if (e instanceof TxError && e.signature) open.burnTx ??= e.signature;
      if (definitelyNotSent(e)) open.burnUnsureAt = undefined;
      await saveOpenHarvest(d, open);
      out.pending = 'The burn did not confirm; it is checked again next run.';
      return;
    }
    await saveOpenHarvest(d, open);
  }

  // Royal jelly: anything still above the baseline (up to the jelly share) goes to the biggest queen.
  const bal2 = burnLeft > 0n ? (await d.chain.tokenBalance(hub.wallet, hub.mint)).amount : bal1;
  const jellyLeft = clamp(bal2 - before, jellyAmt);
  if (jellyLeft > 0n) {
    if (!canSend(d)) {
      out.pending = `Out of time in this run: the ${theme.copy.reward} follows next run.`;
      return;
    }
    open.jellyUnsureAt = d.now; // intent first, as for the burn
    await saveOpenHarvest(d, open);
    try {
      open.jellyTx = (await d.chain.transferTokens({ from: hub.keypair, mint: hub.mint, to: open.jellyQueen, amount: jellyLeft })).signature;
      open.jellyUnsureAt = undefined;
    } catch (e) {
      out.errors.push(`${theme.copy.reward}: ${safeErr(e)}`);
      if (e instanceof TxError && e.signature) open.jellyTx ??= e.signature;
      if (definitelyNotSent(e)) open.jellyUnsureAt = undefined;
      await saveOpenHarvest(d, open);
      out.pending = `The ${theme.copy.reward} transfer did not confirm; it is checked again next run.`;
      return;
    }
    await saveOpenHarvest(d, open);
  }

  const harvest: RemoteHarvest = {
    id: open.id,
    at: open.at,
    feesIn: open.feesIn,
    hiveBought: uiAmount(bought, open.decimals),
    burned: uiAmount(burnAmt, open.decimals),
    jellyTo: open.jellyTo,
    jellyAmount: uiAmount(jellyAmt, open.decimals),
    jellySol: open.jellySol,
    txSig: open.buyTx ?? open.burnTx ?? '',
  };
  await d.db.addHarvest(harvest);
  await d.db.addAction({ id: `jelly-${open.id}`, ca: open.jellyTo, verb: 'jelly', amount: open.jellySol, reason: jellyReason, txSig: open.jellyTx, at: open.at });
  if (!open.credited) {
    // flag first: a crash here under-counts a display stat rather than double-counting it
    open.credited = true;
    await saveOpenHarvest(d, open);
    const h = await d.db.getHive(open.jellyTo);
    if (h) await d.db.upsertHive({ ...h, royalJelly: round9(h.royalJelly + open.jellySol), updatedAt: d.now });
  }
  await saveOpenHarvest(d, null);
  await markHour();
  out.harvest = harvest;
}

/* ================================================================== */
/* refresh                                                             */
/* ================================================================== */

export interface RefreshSummary {
  mode: LaunchMode;
  at: number;
  ms: number;
  skipped?: string;
  checked: number;
  updated: number;
  /** Hives whose row was left alone because the hourly run or the harvest was writing hives. */
  deferred: number;
  errors: { ca: string; error: string }[];
}

export async function runRefresh(ctx: EngineCtx = {}): Promise<RefreshSummary> {
  const d = await deps(ctx);
  const t0 = Date.now();
  const out: RefreshSummary = { mode: d.mode, at: d.now, ms: 0, checked: 0, updated: 0, deferred: 0, errors: [] };
  if (!(await d.db.lock('engine:refresh', Date.now() + REFRESH_LOCK_MS))) return { ...out, skipped: 'Another refresh is in progress.', ms: Date.now() - t0 };
  try {
    const hives = (await d.db.listHives()).filter((h) => h.status === d.mode && h.state !== 'abandoned');
    adoptMockHives(d, hives);
    const results = await pool(hives, d.concurrency, async (h) => {
      try {
        return { ca: h.ca, outcome: await refreshHive(d, h) };
      } catch (e) {
        const msg = safeErr(e);
        console.error(`[hive] engine: refreshing ${h.ticker} (${h.ca}) failed: ${msg}`);
        return { ca: h.ca, error: msg };
      }
    });
    for (const r of results) {
      out.checked++;
      if ('error' in r && r.error) out.errors.push({ ca: r.ca, error: r.error });
      else if ('outcome' in r && r.outcome === 'changed') out.updated++;
      else if ('outcome' in r && r.outcome === 'deferred') out.deferred++;
    }
    return { ...out, ms: Date.now() - t0 };
  } finally {
    await d.db.unlock('engine:refresh').catch(() => {});
  }
}

/**
 * Refresh one hive's row. The row is written whole, so lastFeeAt and feesTotal are taken from the
 * engine's own state (never moved backwards), and rows are left alone while the hourly run or the
 * harvest is writing them.
 */
async function refreshHive(d: Deps, hive: RemoteHive): Promise<'changed' | 'same' | 'deferred'> {
  const [bal, holders, info] = await Promise.all([
    d.chain.balance(hive.queenWallet).catch(() => null),
    d.chain.holders(hive.ca).catch(() => null),
    d.chain.coinInfo(hive.ca).catch(() => null),
  ]);
  if (bal === null && !holders && !info) throw new Error('The chain answered none of balance, holders or price.');
  const price = info && Number.isFinite(info.priceSol) && info.priceSol > 0 ? info.priceSol : undefined;
  if (price !== undefined) await d.db.addPrice(hive.ca, d.now, price);

  // Checked right before the read-then-write, so the window for a lost update is a few milliseconds.
  if (await engineBusy(d)) return 'deferred';
  const cur = (await d.db.getHive(hive.ca)) ?? hive; // fresh copy: the hourly run may have just written it
  if (cur.state === 'abandoned') return 'same';
  const st = await readHiveState(d.db, hive.ca).catch(() => null); // read after the row: at least as new
  const honey = bal === null ? cur.honey : honeyOf(d, bal);
  const bees = holders && Number.isFinite(holders.count) ? Math.max(0, Math.round(holders.count)) : cur.bees;
  const lastFeeAt = newestFee(cur.lastFeeAt, st?.lastFeeAt);
  const feesTotal = st?.feesTotal != null ? round9(st.feesTotal) : cur.feesTotal;
  const state: RemoteState = st?.payout?.doneAt ? 'abandoned' : stateFromSilence(cur.state, lastFeeAt ?? cur.createdAt, d.now, d.hourMs);
  const changed =
    Math.abs(honey - cur.honey) > 1e-9 ||
    bees !== cur.bees ||
    (price !== undefined && price !== cur.price) ||
    state !== cur.state ||
    lastFeeAt !== cur.lastFeeAt ||
    Math.abs(feesTotal - cur.feesTotal) > 1e-12;
  if (!changed) return 'same';
  await d.db.upsertHive({ ...cur, honey, bees, price: price ?? cur.price, state, lastFeeAt, feesTotal, updatedAt: d.now });
  if (cur.state === 'working' && state === 'starving') await d.db.addAction(starveAction(cur.ca, lastFeeAt ?? cur.createdAt, d.now));
  return 'changed';
}

/* ================================================================== */
/* cron route helpers                                                  */
/* ================================================================== */

/**
 * Authorise a cron call: `Authorization: Bearer ${CRON_SECRET}` when CRON_SECRET is set (Vercel Cron
 * sends exactly that); without a secret, only in mock mode. Constant-time comparison.
 */
export function cronAuth(authorization: string | null, opts: { secret?: string | null; mode?: LaunchMode } = {}): { ok: true } | { ok: false; status: number; error: string } {
  const secret = 'secret' in opts ? opts.secret : config.cronSecret;
  const mode = opts.mode ?? config.launchMode;
  if (!secret) {
    return mode === 'mock' ? { ok: true } : { ok: false, status: 401, error: 'CRON_SECRET is not set: in live mode the engine only runs for an authorised cron call.' };
  }
  const want = createHash('sha256').update(`Bearer ${secret}`).digest();
  const got = createHash('sha256').update(authorization ?? '').digest();
  return timingSafeEqual(want, got) ? { ok: true } : { ok: false, status: 401, error: 'Unauthorized.' };
}

/**
 * Live mode follows ENGINE_DRY_RUN (on unless explicitly off); mock mode sends (to MockChain).
 * `?dryRun=1` forces a dry run; it keeps its own hour marks, so it never uses up the real hour.
 */
export function cronDryRun(url: URL, mode: LaunchMode = config.launchMode): boolean {
  const forced = /^(1|true|yes|on)$/i.test(url.searchParams.get('dryRun') ?? '');
  return forced || (mode === 'live' ? config.engineDryRun : false);
}
