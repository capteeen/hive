import 'server-only';
/**
 * FileDb: the default store when Supabase is not configured. JSON files under DATA_DIR, an in-memory
 * cache loaded once, and an in-process event bus that feeds the SSE endpoint.
 *
 * Layout (all files written atomically: tmp file + fsync + rename, mode 0600):
 *   hives/<ca>.json        one RemoteHive per file
 *   images/<ca>.json       { ca, image }: a hive's data-URL image, read from disk on demand (never cached).
 *                          The hive itself carries `/api/hives/<ca>/image?v=…` instead, so lists, the
 *                          change feed and memory never hold image bytes. Exposed as meta `image:<ca>`
 *                          (the same key SupabaseDb uses).
 *   launches/<id>.json     one LaunchRecord per file (payload carries the image until the launch is
 *                          live or refunded; then the image is dropped, the hive has its own copy)
 *   prices/<ca>.json       { ca, points } per hive, newest 2000 points, loaded lazily (cached for
 *                          real hives only, so unknown CAs never grow memory)
 *   actions.json           newest 5000, newest first
 *   harvests.json          newest 2000, newest first
 *   claims.json            cell claims
 *   secrets.json           encrypted keys (first write wins, never overwritten)
 *   meta.json, locks.json
 *
 * Concurrency: every mutation runs through one promise queue, so read-check-write sequences
 * (claimCell, updateLaunch CAS, lock) are atomic within the process. Disk writes are coalesced per
 * file and a mutation resolves only once its change is on disk. State is shared per data directory
 * through globalThis, so separately bundled copies of this module (route handlers, instrumentation,
 * dev hot reloads) see the same cache and the same event bus.
 *
 * Single process only: two server processes on one DATA_DIR would overwrite each other. Use Supabase
 * for anything beyond one Node process (and always for live mode).
 */
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Cell } from '@/lib/types';
import type { LaunchState, RemoteAction, RemoteHarvest, RemoteHive, StreamEvent } from '@/lib/shared/api';
import { hiveImageMetaKey, hiveImagePath, isDataUrl } from '@/lib/shared/rows';
import type { CellScope, Db, LaunchRecord, ListOpts } from './db';

/** Retention caps (the UI only ever shows the newest slice). */
export const FILE_DB_CAPS = { actions: 5000, harvests: 2000, pricesPerCa: 2000 } as const;

interface Claim {
  q: number;
  r: number;
  launchId: string;
  /** ms epoch; null = permanent (finalized). */
  expiresAt: number | null;
  createdAt: number;
}

type PricePoint = { at: number; price: number };

/** Coalescing writer for one file: concurrent saves collapse into at most one queued write. */
interface Writer {
  running: Promise<void> | null;
  queued: Promise<void> | null;
  snapshot: () => unknown;
}

interface State {
  dir: string;
  hives: Map<string, RemoteHive>;
  launches: Map<string, LaunchRecord>;
  actions: RemoteAction[];
  harvests: RemoteHarvest[];
  prices: Map<string, PricePoint[]>;
  pricesLoading: Map<string, Promise<void>>;
  claims: Claim[];
  secrets: Record<string, string>;
  meta: Record<string, string>;
  locks: Record<string, number>;
  emitter: EventEmitter;
  queue: Promise<unknown>;
  loaded: Promise<void> | null;
  writers: Map<string, Writer>;
}

interface Tx {
  /** Persist the file at `rel` (relative to the data dir) with whatever `snapshot()` returns at write time. */
  save(rel: string, snapshot: () => unknown): void;
  emit(ev: StreamEvent): void;
}

const noop = () => {};
const clone = <T>(v: T): T => structuredClone(v);
const IMAGE_META_PREFIX = hiveImageMetaKey('');
/**
 * Launch states after which the payload image is never read again: a live hive keeps its own copy,
 * and an expired launch can only be refunded (a late payment is recorded for the refund, never revived).
 */
const IMAGE_DONE: readonly LaunchState[] = ['live', 'expired', 'refunded'];
/** A launch as the cache keeps it: no payload image once it can no longer be needed. */
const slimLaunch = (l: LaunchRecord): LaunchRecord => (IMAGE_DONE.includes(l.state) && l.payload?.image ? { ...l, payload: { ...l.payload, image: '' } } : l);
const isCellInt = (c: unknown): c is Cell => !!c && typeof c === 'object' && Number.isInteger((c as Cell).q) && Number.isInteger((c as Cell).r);
const sameCell = (a: Cell, b: Cell) => a.q === b.q && a.r === b.r;

/** A safe file name for an id: kept as is when plain, hashed otherwise (ids never reach the path raw). */
function fileKey(id: string): string {
  return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : `x-${createHash('sha256').update(id).digest('hex')}`;
}

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fh = await fs.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(noop);
    throw e;
  }
}

/** Read and parse a JSON file. Missing -> `dflt`. Unparseable -> throw: silently starting empty would overwrite real data on the next write. */
async function readJson<T>(file: string, dflt: T): Promise<T> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return dflt;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`[hive] data file ${file} is not valid JSON; refusing to start over it. Fix or move it away.`);
  }
}

/** Read every `*.json` record in a sub directory (skipping leftover tmp files). */
async function readDir<T>(dir: string): Promise<T[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: T[] = [];
  for (const n of names) {
    const full = path.join(dir, n);
    if (n.endsWith('.tmp')) {
      // a crash between write and rename; old leftovers are safe to drop
      const st = await fs.stat(full).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 60_000) await fs.rm(full, { force: true }).catch(noop);
      continue;
    }
    if (!n.endsWith('.json')) continue;
    out.push(await readJson<T>(full, null as T));
  }
  return out;
}

const registry = globalThis as unknown as { __hiveFileDbV1?: Map<string, State> };

function newState(dir: string): State {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0); // the SSE route subscribes once per process; tests and tools may add more
  return {
    dir,
    hives: new Map(),
    launches: new Map(),
    actions: [],
    harvests: [],
    prices: new Map(),
    pricesLoading: new Map(),
    claims: [],
    secrets: {},
    meta: {},
    locks: {},
    emitter,
    queue: Promise.resolve(),
    loaded: null,
    writers: new Map(),
  };
}

export class FileDb implements Db {
  readonly kind = 'file' as const;
  private readonly s: State;

  /**
   * @param dataDir directory for the JSON files (created if missing).
   * @param opts.isolated do not share state with other instances on the same directory (tests).
   */
  constructor(dataDir: string, opts: { isolated?: boolean } = {}) {
    const dir = path.resolve(dataDir);
    if (opts.isolated) {
      this.s = newState(dir);
    } else {
      const reg = (registry.__hiveFileDbV1 ??= new Map());
      let st = reg.get(dir);
      if (!st) reg.set(dir, (st = newState(dir)));
      this.s = st;
    }
  }

  /* ---------- plumbing ---------- */

  private ready(): Promise<void> {
    const s = this.s;
    if (!s.loaded) {
      s.loaded = this.load().catch((e) => {
        s.loaded = null; // let the next call retry
        throw e;
      });
    }
    return s.loaded;
  }

  private async load() {
    const s = this.s;
    for (const sub of ['', 'hives', 'images', 'launches', 'prices']) await fs.mkdir(path.join(s.dir, sub), { recursive: true, mode: 0o700 });
    const hives = await readDir<RemoteHive>(path.join(s.dir, 'hives'));
    for (const h of hives) if (h && typeof h.ca === 'string') s.hives.set(h.ca, h);
    const launches = await readDir<LaunchRecord>(path.join(s.dir, 'launches'));
    // finished launches lose their payload image in memory (the file keeps it until it is next written)
    for (const l of launches) if (l && typeof l.id === 'string') s.launches.set(l.id, slimLaunch(l));
    s.actions = await readJson<RemoteAction[]>(this.file('actions.json'), []);
    s.harvests = await readJson<RemoteHarvest[]>(this.file('harvests.json'), []);
    s.claims = await readJson<Claim[]>(this.file('claims.json'), []);
    s.secrets = await readJson<Record<string, string>>(this.file('secrets.json'), {});
    s.meta = await readJson<Record<string, string>>(this.file('meta.json'), {});
    s.locks = await readJson<Record<string, number>>(this.file('locks.json'), {});
  }

  private file(rel: string) {
    return path.join(this.s.dir, rel);
  }

  private imageFile(ca: string) {
    return this.file(`images/${fileKey(ca)}.json`);
  }

  /** A hive's stored data-URL image, straight from disk (images are never cached in memory). */
  private async readImage(ca: string): Promise<string | null> {
    const data = await readJson<{ ca: string; image: string } | null>(this.imageFile(ca), null);
    return data && data.ca === ca && typeof data.image === 'string' ? data.image : null;
  }

  /** Read one CA's price file from disk (missing -> []). Does not touch the cache. */
  private async readPrices(ca: string): Promise<PricePoint[]> {
    const data = await readJson<{ ca: string; points: PricePoint[] } | null>(this.file(`prices/${fileKey(ca)}.json`), null);
    return data && data.ca === ca && Array.isArray(data.points) ? data.points : [];
  }

  /**
   * One CA's cached price list, loading it on first use (shared promise, so concurrent callers load it
   * once). Only addPrice and known hives come through here, so the cache is bounded by the hives that
   * exist, never by the CAs anonymous readers ask about.
   */
  private async cachedPrices(ca: string): Promise<PricePoint[]> {
    const s = this.s;
    const hit = s.prices.get(ca);
    if (hit) return hit;
    let p = s.pricesLoading.get(ca);
    if (!p) {
      p = this.readPrices(ca)
        .then((pts) => {
          if (!s.prices.has(ca)) s.prices.set(ca, pts);
        })
        .finally(() => {
          s.pricesLoading.delete(ca); // loaded (now in s.prices) or failed (the next call retries)
        });
      s.pricesLoading.set(ca, p);
    }
    await p;
    return s.prices.get(ca)!;
  }

  /** Queue a coalesced atomic write of one file. Resolves once a write that includes the current state finished. */
  private write(rel: string, snapshot: () => unknown): Promise<void> {
    const s = this.s;
    let w = s.writers.get(rel);
    if (!w) s.writers.set(rel, (w = { running: null, queued: null, snapshot }));
    w.snapshot = snapshot;
    if (w.queued) return w.queued; // a write that has not started yet will pick up this change
    const writer = w;
    const p: Promise<void> = (writer.running ?? Promise.resolve())
      .catch(noop)
      .then(async () => {
        writer.queued = null;
        writer.running = p;
        await atomicWrite(this.file(rel), JSON.stringify(writer.snapshot()));
      })
      .finally(() => {
        if (writer.running === p) writer.running = null;
      });
    writer.queued = p;
    return p;
  }

  /**
   * Run a mutation exclusively. `fn` must validate before it mutates the cache. Its saves are awaited
   * after the queue moves on (so writes coalesce), and its events are emitted once they are on disk.
   */
  private async tx<T>(fn: (t: Tx) => T | Promise<T>): Promise<T> {
    const s = this.s;
    const writes: Promise<void>[] = [];
    const events: StreamEvent[] = [];
    const t: Tx = {
      save: (rel, snap) => {
        const p = this.write(rel, snap);
        p.catch(noop); // awaited below; avoid an unhandled rejection if `fn` throws later
        writes.push(p);
      },
      emit: (ev) => events.push(ev),
    };
    const run = s.queue.then(async () => {
      await this.ready();
      return fn(t);
    });
    s.queue = run.then(noop, noop);
    const result = await run;
    await Promise.all(writes);
    for (const ev of events) s.emitter.emit('event', ev);
    return result;
  }

  /* ---------- hives ---------- */

  async listHives(): Promise<RemoteHive[]> {
    await this.ready();
    return [...this.s.hives.values()].sort((a, b) => a.createdAt - b.createdAt).map(clone);
  }

  async getHive(ca: string): Promise<RemoteHive | null> {
    await this.ready();
    const h = this.s.hives.get(ca);
    return h ? clone(h) : null;
  }

  async upsertHive(h: RemoteHive): Promise<void> {
    if (!h || typeof h.ca !== 'string' || !h.ca) throw new Error('upsertHive: missing ca.');
    if (!isCellInt(h.cell)) throw new Error('upsertHive: invalid cell.');
    const next = clone(h);
    // A data-URL image is stored on its own and the hive points at the image route (hashed once, here).
    const image = isDataUrl(next.image) ? next.image : null;
    if (image) next.image = hiveImagePath(next.ca, image);
    await this.tx(async (t) => {
      const s = this.s;
      for (const other of s.hives.values()) {
        if (other.ca === next.ca) continue;
        if (sameCell(other.cell, next.cell)) throw new Error(`upsertHive: cell ${next.cell.q},${next.cell.r} is already taken.`);
        if (next.queenWallet && other.queenWallet === next.queenWallet) throw new Error('upsertHive: queen wallet already belongs to another hive.');
      }
      const prev = s.hives.get(next.ca);
      // The image file goes first (inside the queue): a hive on disk never points at an image that is not.
      // Same path = same content hash = already stored.
      if (image && prev?.image !== next.image) await atomicWrite(this.imageFile(next.ca), JSON.stringify({ ca: next.ca, image }));
      if (prev && JSON.stringify(prev) === JSON.stringify(next)) return; // nothing changed: no write, no event
      s.hives.set(next.ca, next);
      t.save(`hives/${fileKey(next.ca)}.json`, () => s.hives.get(next.ca));
      t.emit({ type: 'hive', hive: clone(next) });
    });
  }

  /* ---------- actions / harvests ---------- */

  async listActions(limit: number, ca?: string, opts: ListOpts = {}): Promise<RemoteAction[]> {
    await this.ready();
    const n = Math.max(0, Math.floor(limit));
    const out: RemoteAction[] = [];
    for (const a of this.s.actions) {
      if (out.length >= n) break;
      if ((!ca || a.ca === ca) && !(opts.real && a.dryRun)) out.push(clone(a));
    }
    return out;
  }

  async addAction(a: RemoteAction): Promise<void> {
    if (!a || typeof a.id !== 'string' || !a.id || typeof a.ca !== 'string' || !Number.isFinite(a.at)) throw new Error('addAction: invalid action.');
    const rec = clone(a);
    await this.tx((t) => {
      const s = this.s;
      if (s.actions.some((x) => x.id === rec.id)) return; // idempotent retry
      if (insertNewestFirst(s.actions, rec, FILE_DB_CAPS.actions)) {
        t.save('actions.json', () => s.actions);
        t.emit({ type: 'action', action: clone(rec) });
      }
    });
  }

  async listHarvests(limit: number, opts: ListOpts = {}): Promise<RemoteHarvest[]> {
    await this.ready();
    const list = opts.real ? this.s.harvests.filter((h) => !h.dryRun) : this.s.harvests;
    return list.slice(0, Math.max(0, Math.floor(limit))).map(clone);
  }

  async addHarvest(h: RemoteHarvest): Promise<void> {
    if (!h || typeof h.id !== 'string' || !h.id || !Number.isFinite(h.at)) throw new Error('addHarvest: invalid harvest.');
    const rec = clone(h);
    await this.tx((t) => {
      const s = this.s;
      if (s.harvests.some((x) => x.id === rec.id)) return;
      if (insertNewestFirst(s.harvests, rec, FILE_DB_CAPS.harvests)) {
        t.save('harvests.json', () => s.harvests);
        t.emit({ type: 'harvest', harvest: clone(rec) });
      }
    });
  }

  /* ---------- cells ---------- */

  async claimCell(candidates: Cell[], launchId: string, expiresAt: number, scope: CellScope = {}): Promise<Cell | null> {
    if (typeof launchId !== 'string' || !launchId) throw new Error('claimCell: missing launch id.');
    if (!Number.isFinite(expiresAt)) throw new Error('claimCell: invalid expiry.');
    return this.tx((t) => {
      const s = this.s;
      const now = Date.now();
      const before = s.claims.length;
      s.claims = s.claims.filter((c) => c.expiresAt === null || c.expiresAt > now);
      let changed = s.claims.length !== before;
      let won: Cell | null = null;
      const counts = this.counts(scope);
      for (const cand of candidates) {
        if (!isCellInt(cand)) continue;
        if ([...s.hives.values()].some((h) => counts.hive(h) && sameCell(h.cell, cand))) continue;
        if (scope.liveOnly) {
          // a preview launch's claim never blocks a real one: the live launch takes the cell over
          const n = s.claims.length;
          s.claims = s.claims.filter((c) => !(sameCell(c, cand) && c.launchId !== launchId && !counts.claim(c)));
          if (s.claims.length !== n) changed = true;
        }
        const held = s.claims.find((c) => sameCell(c, cand));
        if (held) {
          if (held.launchId !== launchId) continue;
          // idempotent retry by the same launch: refresh the expiry of a pending claim
          if (held.expiresAt !== null) held.expiresAt = expiresAt;
          won = { q: cand.q, r: cand.r };
          changed = true;
          break;
        }
        // one launch holds at most one pending cell: drop its other unfinalized claims
        s.claims = s.claims.filter((c) => !(c.launchId === launchId && c.expiresAt !== null));
        s.claims.push({ q: cand.q, r: cand.r, launchId, expiresAt, createdAt: now });
        won = { q: cand.q, r: cand.r };
        changed = true;
        break;
      }
      if (changed) t.save('claims.json', () => s.claims);
      return won;
    });
  }

  async finalizeCell(launchId: string): Promise<void> {
    await this.tx((t) => {
      const s = this.s;
      const mine = s.claims.filter((c) => c.launchId === launchId);
      if (!mine.length) {
        console.warn(`[hive] finalizeCell: launch ${launchId} holds no cell claim.`);
        return;
      }
      for (const c of mine) c.expiresAt = null;
      t.save('claims.json', () => s.claims);
    });
  }

  async releaseCell(launchId: string): Promise<void> {
    await this.tx((t) => {
      const s = this.s;
      const before = s.claims.length;
      s.claims = s.claims.filter((c) => c.launchId !== launchId);
      if (s.claims.length !== before) t.save('claims.json', () => s.claims);
    });
  }

  async takenCells(now: number, scope: CellScope = {}): Promise<Cell[]> {
    await this.ready();
    const counts = this.counts(scope);
    const out = new Map<string, Cell>();
    for (const h of this.s.hives.values()) if (counts.hive(h)) out.set(`${h.cell.q},${h.cell.r}`, { q: h.cell.q, r: h.cell.r });
    for (const c of this.s.claims) if ((c.expiresAt === null || c.expiresAt > now) && counts.claim(c)) out.set(`${c.q},${c.r}`, { q: c.q, r: c.r });
    return [...out.values()];
  }

  /** Which hives and claims occupy a cell for `scope` (liveOnly: not preview hives, not mock launches' claims). */
  private counts(scope: CellScope) {
    const live = !!scope.liveOnly;
    return {
      hive: (h: RemoteHive) => !live || h.status !== 'mock',
      claim: (c: Claim) => !live || this.s.launches.get(c.launchId)?.mode !== 'mock',
    };
  }

  /* ---------- launches ---------- */

  async createLaunch(l: LaunchRecord): Promise<void> {
    if (!l || typeof l.id !== 'string' || !l.id) throw new Error('createLaunch: missing id.');
    const rec = slimLaunch(clone(l));
    await this.tx((t) => {
      const s = this.s;
      if (s.launches.has(rec.id)) throw new Error(`createLaunch: launch ${rec.id} already exists.`);
      s.launches.set(rec.id, rec);
      t.save(`launches/${fileKey(rec.id)}.json`, () => s.launches.get(rec.id));
    });
  }

  async getLaunch(id: string): Promise<LaunchRecord | null> {
    await this.ready();
    const l = this.s.launches.get(id);
    return l ? clone(l) : null;
  }

  async updateLaunch(id: string, patch: Partial<LaunchRecord>, expect: LaunchState[]): Promise<LaunchRecord | null> {
    const p = clone(patch);
    return this.tx((t) => {
      const s = this.s;
      const cur = s.launches.get(id);
      if (!cur || !expect.includes(cur.state)) return null;
      // shallow merge (like a column update); a key set to undefined clears that field
      const next = slimLaunch({ ...cur, ...p, id: cur.id, updatedAt: p.updatedAt ?? Date.now() });
      s.launches.set(id, next);
      t.save(`launches/${fileKey(id)}.json`, () => s.launches.get(id));
      return clone(next);
    });
  }

  async listLaunches(states: LaunchState[]): Promise<LaunchRecord[]> {
    await this.ready();
    return [...this.s.launches.values()].filter((l) => states.includes(l.state)).sort((a, b) => a.createdAt - b.createdAt).map(clone);
  }

  /* ---------- secrets / meta / locks ---------- */

  async putSecret(pubkey: string, enc: string): Promise<void> {
    if (!pubkey || typeof enc !== 'string' || !enc) throw new Error('putSecret: invalid input.');
    await this.tx((t) => {
      const s = this.s;
      // First write wins: a key that controls funds is never replaced (a retry re-encrypting the
      // same keypair produces a different ciphertext for the same secret, which is harmless to skip).
      if (Object.prototype.hasOwnProperty.call(s.secrets, pubkey)) return;
      s.secrets[pubkey] = enc;
      t.save('secrets.json', () => s.secrets);
    });
  }

  async getSecret(pubkey: string): Promise<string | null> {
    await this.ready();
    return Object.prototype.hasOwnProperty.call(this.s.secrets, pubkey) ? this.s.secrets[pubkey] : null;
  }

  async getMeta(key: string): Promise<string | null> {
    await this.ready();
    if (key.startsWith(IMAGE_META_PREFIX)) return this.readImage(key.slice(IMAGE_META_PREFIX.length));
    return Object.prototype.hasOwnProperty.call(this.s.meta, key) ? this.s.meta[key] : null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    if (key.startsWith(IMAGE_META_PREFIX)) {
      const ca = key.slice(IMAGE_META_PREFIX.length);
      await this.tx(() => atomicWrite(this.imageFile(ca), JSON.stringify({ ca, image: value })));
      return;
    }
    await this.tx((t) => {
      const s = this.s;
      if (s.meta[key] === value) return;
      s.meta[key] = value;
      t.save('meta.json', () => s.meta);
    });
  }

  async lock(name: string, until: number): Promise<boolean> {
    if (!name || !Number.isFinite(until)) throw new Error('lock: invalid input.');
    return this.tx((t) => {
      const s = this.s;
      const now = Date.now();
      for (const [k, v] of Object.entries(s.locks)) if (v <= now) delete s.locks[k];
      if (s.locks[name] !== undefined) return false;
      s.locks[name] = until;
      t.save('locks.json', () => s.locks);
      return true;
    });
  }

  async unlock(name: string): Promise<void> {
    await this.tx((t) => {
      const s = this.s;
      if (s.locks[name] === undefined) return;
      delete s.locks[name];
      t.save('locks.json', () => s.locks);
    });
  }

  /* ---------- prices ---------- */

  async addPrice(ca: string, at: number, price: number): Promise<void> {
    if (!ca || !Number.isFinite(at) || !Number.isFinite(price) || price < 0) throw new Error('addPrice: invalid input.');
    await this.tx(async (t) => {
      const s = this.s;
      const pts = await this.cachedPrices(ca);
      // keep ascending by time; the same timestamp twice (a retry) replaces the point
      let i = pts.length;
      while (i > 0 && pts[i - 1].at > at) i--;
      if (i > 0 && pts[i - 1].at === at) pts[i - 1].price = price;
      else pts.splice(i, 0, { at, price });
      if (pts.length > FILE_DB_CAPS.pricesPerCa) pts.splice(0, pts.length - FILE_DB_CAPS.pricesPerCa);
      t.save(`prices/${fileKey(ca)}.json`, () => ({ ca, points: s.prices.get(ca) }));
    });
  }

  async listPrices(ca: string, since: number): Promise<{ at: number; price: number }[]> {
    await this.ready();
    const s = this.s;
    // Known hives (and CAs addPrice already cached) are served from the cache. Any other CA, e.g. one a
    // client typed into /api/hives/[ca], is read from disk without caching: it must not grow memory.
    const known = s.prices.has(ca) || s.pricesLoading.has(ca) || s.hives.has(ca);
    const pts = known ? await this.cachedPrices(ca) : await this.readPrices(ca);
    return pts.filter((p) => p.at >= since).map((p) => ({ at: p.at, price: p.price }));
  }

  /* ---------- change feed ---------- */

  subscribe(fn: (ev: StreamEvent) => void): () => void {
    const handler = (ev: StreamEvent) => {
      try {
        fn(ev);
      } catch (e) {
        // a broken subscriber (e.g. a closed SSE stream) must never fail the write that emitted
        console.error('[hive] stream subscriber failed:', e instanceof Error ? e.message : e);
      }
    };
    this.s.emitter.on('event', handler);
    let off = false;
    return () => {
      if (off) return;
      off = true;
      this.s.emitter.off('event', handler);
    };
  }
}

/** Insert into a newest-first list capped at `cap`. Returns false if the record fell off the end. */
function insertNewestFirst<T extends { at: number }>(list: T[], rec: T, cap: number): boolean {
  let i = 0;
  while (i < list.length && list[i].at > rec.at) i++;
  if (i >= cap) return false;
  list.splice(i, 0, rec);
  if (list.length > cap) list.length = cap;
  return true;
}
