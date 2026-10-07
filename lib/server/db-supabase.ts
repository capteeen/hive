import 'server-only';
/**
 * SupabaseDb: Postgres through PostgREST with the service-role key (bypasses RLS; never sent to the
 * browser). Schema: supabase/migrations/0001_hive.sql. Atomic operations live in the database:
 * claim_cell() and try_lock() are SECURITY DEFINER functions only the service role may execute,
 * and updateLaunch is a single conditional UPDATE (compare-and-set on `state`).
 *
 * Realtime: hives / actions / harvests are in the supabase_realtime publication and readable by
 * anon, so browsers subscribe to Postgres changes directly; subscribe() here is a no-op.
 *
 * Images: a data-URL hive image (mock launches) is stored in `meta` under `image:<ca>` and the hive
 * row gets the short `/api/hives/<ca>/image?v=…` path instead, so list reads and Realtime payloads
 * never carry image bytes. FileDb does the same.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Cell } from '@/lib/types';
import type { LaunchMode, LaunchState, RemoteAction, RemoteHarvest, RemoteHive, StreamEvent } from '@/lib/shared/api';
import { actionToRow, harvestToRow, hiveImageMetaKey, hiveImagePath, hiveToRow, isDataUrl, mapRows, rowToAction, rowToHarvest, rowToHive, rowToPrice, toIso, toMs, toNum } from '@/lib/shared/rows';
import type { CellScope, Db, LaunchRecord, ListOpts } from './db';

/** PostgREST's default max rows per request; listHives / takenCells page through it. */
const PAGE = 1000;
/** Most price points listPrices returns (the newest ones); matches FileDb's per-hive cap. */
const PRICE_LIST_MAX = 2000;
/** Price points older than this are pruned (the UI reads 24h; the chart a few days at most). */
const PRICE_RETENTION_MS = 14 * 24 * 3600_000;

/* ---------- launches <-> rows (server only: these carry encrypted secrets) ---------- */

export interface LaunchRow {
  id: string;
  mode: LaunchMode;
  state: LaunchState;
  owner: string;
  payload: LaunchRecord['payload'];
  queen_wallet: string;
  mint_pubkey: string;
  mint_secret_enc: string;
  cell_q: number;
  cell_r: number;
  lamports: number | string;
  created_at: string;
  expires_at: string;
  updated_at: string;
  ca: string | null;
  metadata_uri: string | null;
  image_uri: string | null;
  txs: LaunchRecord['txs'] | null;
  error: string | null;
  attempts: number;
}

/** Column for each LaunchRecord field, and how to write it. */
const LAUNCH_COLS: { [K in keyof LaunchRecord]-?: (v: LaunchRecord[K]) => Partial<LaunchRow> } = {
  id: (v) => ({ id: v }),
  mode: (v) => ({ mode: v }),
  state: (v) => ({ state: v }),
  owner: (v) => ({ owner: v }),
  payload: (v) => ({ payload: v }),
  queenWallet: (v) => ({ queen_wallet: v }),
  mintPubkey: (v) => ({ mint_pubkey: v }),
  mintSecretEnc: (v) => ({ mint_secret_enc: v }),
  cell: (v) => ({ cell_q: v.q, cell_r: v.r }),
  lamports: (v) => ({ lamports: v }),
  createdAt: (v) => ({ created_at: toIso(v) }),
  expiresAt: (v) => ({ expires_at: toIso(v) }),
  updatedAt: (v) => ({ updated_at: toIso(v) }),
  ca: (v) => ({ ca: v ?? null }),
  metadataUri: (v) => ({ metadata_uri: v ?? null }),
  imageUri: (v) => ({ image_uri: v ?? null }),
  txs: (v) => ({ txs: v ?? {} }),
  error: (v) => ({ error: v ?? null }),
  attempts: (v) => ({ attempts: v }),
};

export function launchToRow(l: LaunchRecord): LaunchRow {
  return launchPatchToRow(l) as LaunchRow;
}

/**
 * Only the keys present in `patch` become columns; a key present with value `undefined` clears the
 * column (null), matching FileDb's shallow merge.
 */
export function launchPatchToRow(patch: Partial<LaunchRecord>): Partial<LaunchRow> {
  const out: Partial<LaunchRow> = {};
  for (const k of Object.keys(patch) as (keyof LaunchRecord)[]) {
    const map = LAUNCH_COLS[k] as ((v: unknown) => Partial<LaunchRow>) | undefined;
    if (!map) continue;
    const v = patch[k];
    if (v === undefined && (k === 'id' || k === 'cell' || k === 'createdAt' || k === 'expiresAt' || k === 'updatedAt')) continue;
    Object.assign(out, map(v));
  }
  return out;
}

export function rowToLaunch(r: LaunchRow): LaunchRecord {
  const l: LaunchRecord = {
    id: r.id,
    mode: r.mode,
    state: r.state,
    owner: r.owner,
    payload: r.payload,
    queenWallet: r.queen_wallet,
    mintPubkey: r.mint_pubkey,
    mintSecretEnc: r.mint_secret_enc,
    cell: { q: r.cell_q, r: r.cell_r },
    lamports: toNum(r.lamports),
    createdAt: toMs(r.created_at),
    expiresAt: toMs(r.expires_at),
    updatedAt: toMs(r.updated_at),
    txs: r.txs ?? {},
    attempts: r.attempts ?? 0,
  };
  if (r.ca) l.ca = r.ca;
  if (r.metadata_uri) l.metadataUri = r.metadata_uri;
  if (r.image_uri) l.imageUri = r.image_uri;
  if (r.error) l.error = r.error;
  return l;
}

/* ---------- the store ---------- */

interface PgError {
  message: string;
  code?: string;
}

/** PostgREST could not find the function (PGRST202), or Postgres says it does not exist (42883). */
const isMissingFunction = (err: PgError) => err.code === 'PGRST202' || err.code === '42883';

/** Throw a short error. Only `message`/`code` are used: PostgREST `details` can echo row values. */
function fail(what: string, err: PgError): never {
  throw new Error(`[db] ${what} failed: ${err.message}${err.code ? ` (${err.code})` : ''}`);
}

export class SupabaseDb implements Db {
  readonly kind = 'supabase' as const;
  private readonly sb: SupabaseClient;
  /** ca -> last prune time (ms), so pruning old prices runs at most hourly per hive per process. */
  private readonly pruned = new Map<string, number>();
  /** False once claim_live_cell() turned out to be missing (migration 0002 not applied). */
  private liveClaim = true;

  /** `opts.fetch` lets tests stub the network. */
  constructor(url: string, serviceKey: string, opts: { fetch?: typeof fetch } = {}) {
    this.sb = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: opts.fetch ? { fetch: opts.fetch } : undefined,
    });
  }

  /* ---------- hives ---------- */

  async listHives(): Promise<RemoteHive[]> {
    const out: RemoteHive[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.sb.from('hives').select('*').order('created_at', { ascending: true }).order('ca', { ascending: true }).range(from, from + PAGE - 1);
      if (error) fail('listHives', error);
      out.push(...mapRows(data, rowToHive));
      if (!data || data.length < PAGE) break;
    }
    return out;
  }

  async getHive(ca: string): Promise<RemoteHive | null> {
    const { data, error } = await this.sb.from('hives').select('*').eq('ca', ca).maybeSingle();
    if (error) fail('getHive', error);
    return data ? rowToHive(data) : null;
  }

  async upsertHive(h: RemoteHive): Promise<void> {
    const row = hiveToRow(h);
    if (isDataUrl(h.image)) {
      // The image first: once the row (and its Realtime event) points at the image route, it must resolve.
      await this.setMeta(hiveImageMetaKey(h.ca), h.image);
      row.image = hiveImagePath(h.ca, h.image);
    }
    const { error } = await this.sb.from('hives').upsert(row, { onConflict: 'ca' });
    if (error) fail('upsertHive', error);
  }

  /* ---------- actions / harvests ---------- */

  async listActions(limit: number, ca?: string, opts: ListOpts = {}): Promise<RemoteAction[]> {
    const n = Math.max(0, Math.floor(limit));
    if (!n) return [];
    let q = this.sb.from('actions').select('*');
    if (ca) q = q.eq('ca', ca);
    if (opts.real) q = q.eq('dry_run', false);
    const { data, error } = await q.order('at', { ascending: false }).limit(n);
    if (error) fail('listActions', error);
    return mapRows(data, rowToAction);
  }

  async addAction(a: RemoteAction): Promise<void> {
    // ignoreDuplicates: a retried insert of the same action id is a no-op (and emits no realtime event)
    const { error } = await this.sb.from('actions').upsert(actionToRow(a), { onConflict: 'id', ignoreDuplicates: true });
    if (error) fail('addAction', error);
  }

  async listHarvests(limit: number, opts: ListOpts = {}): Promise<RemoteHarvest[]> {
    const n = Math.max(0, Math.floor(limit));
    if (!n) return [];
    let q = this.sb.from('harvests').select('*');
    if (opts.real) q = q.eq('dry_run', false);
    const { data, error } = await q.order('at', { ascending: false }).limit(n);
    if (error) fail('listHarvests', error);
    return mapRows(data, rowToHarvest);
  }

  async addHarvest(h: RemoteHarvest): Promise<void> {
    const { error } = await this.sb.from('harvests').upsert(harvestToRow(h), { onConflict: 'id', ignoreDuplicates: true });
    if (error) fail('addHarvest', error);
  }

  /* ---------- cells ---------- */

  /**
   * `scope.liveOnly` uses claim_live_cell() (supabase/migrations/0002_live.sql), which ignores preview
   * hives and replaces a mock launch's claim. Without 0002 it falls back to claim_cell(), where preview
   * data still blocks its cells (the launch then gets the nearest free one).
   */
  async claimCell(candidates: Cell[], launchId: string, expiresAt: number, scope: CellScope = {}): Promise<Cell | null> {
    if (!launchId) throw new Error('claimCell: missing launch id.');
    if (!Number.isFinite(expiresAt)) throw new Error('claimCell: invalid expiry.');
    for (const c of candidates) {
      if (!Number.isInteger(c?.q) || !Number.isInteger(c?.r)) continue;
      const args = { q: c.q, r: c.r, launch: launchId, expires: toIso(expiresAt) };
      let fn = scope.liveOnly && this.liveClaim ? 'claim_live_cell' : 'claim_cell';
      let { data, error } = await this.sb.rpc(fn, args);
      if (error && fn === 'claim_live_cell' && isMissingFunction(error)) {
        this.liveClaim = false;
        console.warn('[hive] claim_live_cell() is missing: run supabase/migrations/0002_live.sql. Preview hives block their cells until then.');
        fn = 'claim_cell';
        ({ data, error } = await this.sb.rpc(fn, args));
      }
      if (error) fail(fn, error);
      if (data === true) return { q: c.q, r: c.r };
    }
    return null;
  }

  async finalizeCell(launchId: string): Promise<void> {
    const { data, error } = await this.sb.from('cell_claims').update({ expires_at: null }).eq('launch_id', launchId).select('q');
    if (error) fail('finalizeCell', error);
    if (!data?.length) console.warn(`[hive] finalizeCell: launch ${launchId} holds no cell claim.`);
  }

  async releaseCell(launchId: string): Promise<void> {
    const { error } = await this.sb.from('cell_claims').delete().eq('launch_id', launchId);
    if (error) fail('releaseCell', error);
  }

  async takenCells(now: number, scope: CellScope = {}): Promise<Cell[]> {
    // Without claim_live_cell (0002 missing) claims go through claim_cell, which preview data still
    // blocks: offer only cells it can grant, or a comb whose only hive is a preview one has none to give.
    const liveOnly = !!scope.liveOnly && this.liveClaim;
    const out = new Map<string, Cell>();
    for (let from = 0; ; from += PAGE) {
      let q = this.sb.from('hives').select('cell_q,cell_r');
      if (liveOnly) q = q.neq('status', 'mock');
      const { data, error } = await q.order('ca', { ascending: true }).range(from, from + PAGE - 1);
      if (error) fail('takenCells(hives)', error);
      for (const r of (data ?? []) as { cell_q: number; cell_r: number }[]) out.set(`${r.cell_q},${r.cell_r}`, { q: r.cell_q, r: r.cell_r });
      if (!data || data.length < PAGE) break;
    }
    const mock = liveOnly ? await this.mockLaunchIds() : null;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.sb
        .from('cell_claims')
        .select('q,r,launch_id')
        .or(`expires_at.is.null,expires_at.gt."${toIso(now)}"`)
        .order('q', { ascending: true })
        .order('r', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) fail('takenCells(claims)', error);
      for (const r of (data ?? []) as { q: number; r: number; launch_id: string }[]) if (!mock?.has(r.launch_id)) out.set(`${r.q},${r.r}`, { q: r.q, r: r.r });
      if (!data || data.length < PAGE) break;
    }
    return [...out.values()];
  }

  /** Ids of mock-mode launches (a live database normally has none). */
  private async mockLaunchIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.sb.from('launches').select('id').eq('mode', 'mock').order('id', { ascending: true }).range(from, from + PAGE - 1);
      if (error) fail('takenCells(launches)', error);
      for (const r of (data ?? []) as { id: string }[]) ids.add(r.id);
      if (!data || data.length < PAGE) break;
    }
    return ids;
  }

  /* ---------- launches ---------- */

  async createLaunch(l: LaunchRecord): Promise<void> {
    // plain insert: a second create with the same id fails on the primary key (never overwrites)
    const { error } = await this.sb.from('launches').insert(launchToRow(l));
    if (error) fail('createLaunch', error);
  }

  async getLaunch(id: string): Promise<LaunchRecord | null> {
    const { data, error } = await this.sb.from('launches').select('*').eq('id', id).maybeSingle();
    if (error) fail('getLaunch', error);
    return data ? rowToLaunch(data as LaunchRow) : null;
  }

  async updateLaunch(id: string, patch: Partial<LaunchRecord>, expect: LaunchState[]): Promise<LaunchRecord | null> {
    if (!expect.length) return null;
    const { id: _ignored, ...rest } = patch;
    void _ignored;
    const row = launchPatchToRow({ ...rest, updatedAt: rest.updatedAt ?? Date.now() });
    // Compare-and-set: the WHERE on state makes the update a no-op if someone else advanced it.
    const { data, error } = await this.sb.from('launches').update(row).eq('id', id).in('state', expect).select('*').maybeSingle();
    if (error) fail('updateLaunch', error);
    return data ? rowToLaunch(data as LaunchRow) : null;
  }

  async listLaunches(states: LaunchState[]): Promise<LaunchRecord[]> {
    if (!states.length) return [];
    const { data, error } = await this.sb.from('launches').select('*').in('state', states).order('created_at', { ascending: true }).limit(PAGE);
    if (error) fail('listLaunches', error);
    return ((data ?? []) as LaunchRow[]).map(rowToLaunch);
  }

  /* ---------- secrets / meta / locks ---------- */

  async putSecret(pubkey: string, enc: string): Promise<void> {
    if (!pubkey || !enc) throw new Error('putSecret: invalid input.');
    // first write wins: an existing key is never replaced
    const { error } = await this.sb.from('secrets').upsert({ pubkey, enc }, { onConflict: 'pubkey', ignoreDuplicates: true });
    if (error) fail('putSecret', error);
  }

  async getSecret(pubkey: string): Promise<string | null> {
    const { data, error } = await this.sb.from('secrets').select('enc').eq('pubkey', pubkey).maybeSingle();
    if (error) fail('getSecret', error);
    return (data as { enc: string } | null)?.enc ?? null;
  }

  async getMeta(key: string): Promise<string | null> {
    const { data, error } = await this.sb.from('meta').select('value').eq('key', key).maybeSingle();
    if (error) fail('getMeta', error);
    return (data as { value: string } | null)?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    const { error } = await this.sb.from('meta').upsert({ key, value, updated_at: toIso(Date.now()) }, { onConflict: 'key' });
    if (error) fail('setMeta', error);
  }

  async lock(name: string, until: number): Promise<boolean> {
    if (!name || !Number.isFinite(until)) throw new Error('lock: invalid input.');
    const { data, error } = await this.sb.rpc('try_lock', { name, until: toIso(until) });
    if (error) fail('try_lock', error);
    return data === true;
  }

  async unlock(name: string): Promise<void> {
    const { error } = await this.sb.from('locks').delete().eq('name', name);
    if (error) fail('unlock', error);
  }

  /* ---------- prices ---------- */

  async addPrice(ca: string, at: number, price: number): Promise<void> {
    if (!ca || !Number.isFinite(at) || !Number.isFinite(price) || price < 0) throw new Error('addPrice: invalid input.');
    // (ca, at) is unique: a retry with the same timestamp replaces the point
    const { error } = await this.sb.from('prices').upsert({ ca, at: toIso(at), price }, { onConflict: 'ca,at' });
    if (error) fail('addPrice', error);
    const last = this.pruned.get(ca) ?? 0;
    if (Date.now() - last > 3600_000) {
      this.pruned.set(ca, Date.now());
      const { error: pe } = await this.sb.from('prices').delete().eq('ca', ca).lt('at', toIso(Date.now() - PRICE_RETENTION_MS));
      if (pe) console.warn('[hive] pruning old prices failed:', pe.message);
    }
  }

  /**
   * The newest PRICE_LIST_MAX points at or after `since`, oldest first (FileDb keeps the same newest
   * slice per hive). Read newest first and paged: PostgREST caps every response (max-rows), and a cap
   * applied to an ascending read would cut the newest points, i.e. the current price.
   */
  async listPrices(ca: string, since: number): Promise<{ at: number; price: number }[]> {
    const byAt = new Map<number, { at: number; price: number }>();
    for (let from = 0; from < PRICE_LIST_MAX; from += PAGE) {
      const to = Math.min(from + PAGE, PRICE_LIST_MAX) - 1;
      const { data, error } = await this.sb
        .from('prices')
        .select('at,price')
        .eq('ca', ca)
        .gte('at', toIso(since))
        .order('at', { ascending: false })
        .range(from, to);
      if (error) fail('listPrices', error);
      // a point inserted between two pages shifts the next page by one row: (ca, at) is unique, so dedupe on at
      for (const p of mapRows(data, rowToPrice)) byAt.set(p.at, p);
      if (!data || data.length < to - from + 1) break; // short page: the window is exhausted (or max-rows < PAGE)
    }
    return [...byAt.values()].sort((a, b) => a.at - b.at);
  }

  /* ---------- change feed ---------- */

  /** Browsers listen to Supabase Realtime directly; there is no in-process feed. */
  subscribe(_fn: (ev: StreamEvent) => void): () => void {
    return () => {};
  }
}
