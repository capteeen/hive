/**
 * Postgres (snake_case) rows <-> the app's RemoteHive / RemoteAction / RemoteHarvest.
 *
 * Used by SupabaseDb on the server and by the browser's Supabase Realtime listener, so it must not
 * import anything server-only. The readers are deliberately forgiving: PostgREST returns `numeric`
 * as JSON numbers but Realtime may deliver them as strings, timestamps arrive as ISO strings in a few
 * shapes (`...Z`, `...+00:00`, `... +00`), and nullable columns come back as `null`.
 */
import type { QueenLook, QueenRules } from '@/lib/queen';
import type { ActionVerb } from '@/lib/types';
import type { HiveStatus, RemoteAction, RemoteHarvest, RemoteHive, RemoteState } from './api';

/* ---------- row shapes (match supabase/migrations/0001_hive.sql) ---------- */

/** A number column as it may arrive: number (PostgREST) or string (numeric via Realtime). */
type Num = number | string;
/** A timestamptz column: ISO string from Postgres, or epoch ms if something upstream already converted it. */
type Ts = string | number;

export interface HiveRow {
  ca: string;
  name: string;
  ticker: string;
  image: string;
  description: string | null;
  motto: string | null;
  telegram: string | null;
  twitter: string | null;
  cell_q: number;
  cell_r: number;
  queen_wallet: string;
  owner_wallet: string;
  look: QueenLook | null;
  rules: QueenRules | null;
  temperament: { dip: string; swarm: string } | null;
  dev_buy: Num;
  status: HiveStatus;
  create_tx: string | null;
  honey: Num;
  bees: Num;
  fees_total: Num;
  royal_jelly: Num;
  price: Num | null;
  state: RemoteState;
  last_fee_at: Ts | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface ActionRow {
  id: string;
  ca: string;
  verb: ActionVerb;
  amount: Num;
  target_ca: string | null;
  reason: string;
  tx_sig: string | null;
  at: Ts;
  dry_run: boolean;
}

export interface HarvestRow {
  id: string;
  at: Ts;
  fees_in: Num;
  hive_bought: Num;
  burned: Num;
  jelly_to: string;
  jelly_amount: Num;
  jelly_sol: Num;
  tx_sig: string;
  dry_run: boolean;
}

export interface PriceRow {
  ca: string;
  at: Ts;
  price: Num;
}

/** GET /api/hives/[ca]. (Candidate for lib/shared/api.ts.) */
export interface HiveDetailResponse {
  hive: RemoteHive;
  /** Newest first, up to 100. */
  actions: RemoteAction[];
  /** Oldest first, the last 24h. */
  prices: { at: number; price: number }[];
  serverTime: number;
}

/* ---------- scalar helpers ---------- */

/** Finite number from a number / numeric string; `dflt` otherwise. */
export function toNum(v: unknown, dflt = 0): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : dflt;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  }
  return dflt;
}

/**
 * Epoch ms from a timestamptz value. Accepts ISO 8601 (`2026-10-07T06:00:00.123456+00:00`, `...Z`),
 * Postgres text output (`2026-10-07 06:00:00.123+00`) and numbers. Returns NaN when unparseable.
 */
export function toMs(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string' || !v) return NaN;
  let s = v.trim().replace(' ', 'T');
  if (!s.includes('T')) return Date.parse(s);
  // more than millisecond precision: keep 3 fractional digits (Date.parse is only specified for ms)
  s = s.replace(/(\.\d{3})\d+/, '$1');
  // "+00" -> "+00:00", "+0530" -> "+05:30"
  s = s.replace(/([+-]\d{2})$/, '$1:00').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  // no zone at all: Postgres `timestamp` / Realtime without offset is UTC here
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += 'Z';
  return Date.parse(s);
}

/** Epoch ms -> ISO string for a timestamptz column. */
export const toIso = (ms: number) => new Date(ms).toISOString();

const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const optMs = (v: unknown): number | undefined => {
  const n = toMs(v);
  return Number.isFinite(n) ? n : undefined;
};
const msOr = (v: unknown, dflt: number) => {
  const n = toMs(v);
  return Number.isFinite(n) ? n : dflt;
};
const obj = <T>(v: unknown): T | undefined => (v && typeof v === 'object' ? (v as T) : undefined);

/* ---------- hives ---------- */

export function hiveToRow(h: RemoteHive): HiveRow {
  return {
    ca: h.ca,
    name: h.name,
    ticker: h.ticker,
    image: h.image,
    description: h.description ?? null,
    motto: h.motto ?? null,
    telegram: h.telegram ?? null,
    twitter: h.twitter ?? null,
    cell_q: h.cell.q,
    cell_r: h.cell.r,
    queen_wallet: h.queenWallet,
    owner_wallet: h.ownerWallet,
    look: h.look ?? null,
    rules: h.rules ?? null,
    temperament: h.temperament ?? null,
    dev_buy: h.devBuy,
    status: h.status,
    create_tx: h.createTx ?? null,
    honey: h.honey,
    bees: Math.max(0, Math.round(h.bees)),
    fees_total: h.feesTotal,
    royal_jelly: h.royalJelly,
    price: h.price ?? null,
    state: h.state,
    last_fee_at: h.lastFeeAt != null ? toIso(h.lastFeeAt) : null,
    created_at: toIso(h.createdAt),
    updated_at: toIso(h.updatedAt),
  };
}

/**
 * Row -> RemoteHive. Returns null for rows missing the identity fields (e.g. a Realtime UPDATE whose
 * payload was cut down). `image` may legitimately be empty when Realtime drops oversized values; the
 * browser fills it from the hive it already has.
 */
export function rowToHive(row: unknown): RemoteHive | null {
  const r = obj<Partial<Record<keyof HiveRow, unknown>>>(row);
  if (!r || typeof r.ca !== 'string' || !r.ca) return null;
  const q = toNum(r.cell_q, NaN);
  const rr = toNum(r.cell_r, NaN);
  if (!Number.isInteger(q) || !Number.isInteger(rr)) return null;
  const createdAt = msOr(r.created_at, Date.now());
  const price = r.price == null ? undefined : toNum(r.price, NaN);
  const state = r.state === 'starving' || r.state === 'abandoned' ? r.state : 'working';
  return {
    ca: r.ca,
    name: typeof r.name === 'string' ? r.name : '',
    ticker: typeof r.ticker === 'string' ? r.ticker : '',
    image: typeof r.image === 'string' ? r.image : '',
    description: optStr(r.description),
    motto: optStr(r.motto),
    telegram: optStr(r.telegram),
    twitter: optStr(r.twitter),
    cell: { q, r: rr },
    queenWallet: typeof r.queen_wallet === 'string' ? r.queen_wallet : '',
    ownerWallet: typeof r.owner_wallet === 'string' ? r.owner_wallet : '',
    look: obj<QueenLook>(r.look),
    rules: obj<QueenRules>(r.rules),
    temperament: obj<{ dip: string; swarm: string }>(r.temperament),
    devBuy: toNum(r.dev_buy),
    status: r.status === 'live' ? 'live' : 'mock',
    createTx: optStr(r.create_tx),
    honey: toNum(r.honey),
    bees: toNum(r.bees),
    feesTotal: toNum(r.fees_total),
    royalJelly: toNum(r.royal_jelly),
    price: price !== undefined && Number.isFinite(price) ? price : undefined,
    state,
    lastFeeAt: optMs(r.last_fee_at),
    createdAt,
    updatedAt: msOr(r.updated_at, createdAt),
  };
}

/* ---------- actions ---------- */

const VERBS: readonly ActionVerb[] = ['seal', 'store', 'swarm', 'starve', 'abandon', 'jelly', 'born'];

export function actionToRow(a: RemoteAction): ActionRow {
  return {
    id: a.id,
    ca: a.ca,
    verb: a.verb,
    amount: a.amount,
    target_ca: a.targetCa ?? null,
    reason: a.reason,
    tx_sig: a.txSig ?? null,
    at: toIso(a.at),
    dry_run: !!a.dryRun,
  };
}

export function rowToAction(row: unknown): RemoteAction | null {
  const r = obj<Partial<Record<keyof ActionRow, unknown>>>(row);
  if (!r || typeof r.id !== 'string' || typeof r.ca !== 'string') return null;
  if (!VERBS.includes(r.verb as ActionVerb)) return null;
  const at = toMs(r.at);
  if (!Number.isFinite(at)) return null;
  const out: RemoteAction = {
    id: r.id,
    ca: r.ca,
    verb: r.verb as ActionVerb,
    amount: toNum(r.amount),
    reason: typeof r.reason === 'string' ? r.reason : '',
    at,
  };
  const target = optStr(r.target_ca);
  if (target) out.targetCa = target;
  const sig = optStr(r.tx_sig);
  if (sig) out.txSig = sig;
  if (r.dry_run === true) out.dryRun = true;
  return out;
}

/* ---------- harvests ---------- */

export function harvestToRow(h: RemoteHarvest): HarvestRow {
  return {
    id: h.id,
    at: toIso(h.at),
    fees_in: h.feesIn,
    hive_bought: h.hiveBought,
    burned: h.burned,
    jelly_to: h.jellyTo,
    jelly_amount: h.jellyAmount,
    jelly_sol: h.jellySol,
    tx_sig: h.txSig,
    dry_run: !!h.dryRun,
  };
}

export function rowToHarvest(row: unknown): RemoteHarvest | null {
  const r = obj<Partial<Record<keyof HarvestRow, unknown>>>(row);
  if (!r || typeof r.id !== 'string') return null;
  const at = toMs(r.at);
  if (!Number.isFinite(at)) return null;
  const out: RemoteHarvest = {
    id: r.id,
    at,
    feesIn: toNum(r.fees_in),
    hiveBought: toNum(r.hive_bought),
    burned: toNum(r.burned),
    jellyTo: typeof r.jelly_to === 'string' ? r.jelly_to : '',
    jellyAmount: toNum(r.jelly_amount),
    jellySol: toNum(r.jelly_sol),
    txSig: typeof r.tx_sig === 'string' ? r.tx_sig : '',
  };
  if (r.dry_run === true) out.dryRun = true;
  return out;
}

/* ---------- prices ---------- */

export function rowToPrice(row: unknown): { at: number; price: number } | null {
  const r = obj<Partial<Record<keyof PriceRow, unknown>>>(row);
  if (!r) return null;
  const at = toMs(r.at);
  const price = toNum(r.price, NaN);
  return Number.isFinite(at) && Number.isFinite(price) ? { at, price } : null;
}

/** Map a list, dropping rows that could not be read. */
export function mapRows<T>(rows: unknown, fn: (r: unknown) => T | null): T[] {
  if (!Array.isArray(rows)) return [];
  const out: T[] = [];
  for (const r of rows) {
    const v = fn(r);
    if (v) out.push(v);
  }
  return out;
}
