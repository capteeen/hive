import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileDb, FILE_DB_CAPS } from '@/lib/server/db-file';
import type { LaunchRecord } from '@/lib/server/db';
import type { RemoteAction, RemoteHarvest, RemoteHive, StreamEvent } from '@/lib/shared/api';
import type { HiveDetailResponse } from '@/lib/shared/rows';
import { DEFAULT_LOOK, DEFAULT_RULES } from '@/lib/queen';

let dir: string;
let db: FileDb;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'hive-filedb-'));
  db = new FileDb(dir, { isolated: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const hive = (ca: string, q: number, r: number, extra: Partial<RemoteHive> = {}): RemoteHive => ({
  ca,
  name: `Hive ${ca}`,
  ticker: 'HV',
  image: 'data:image/png;base64,AAAA',
  cell: { q, r },
  queenWallet: `queen-${ca}`,
  ownerWallet: `guest:owner-${ca}`,
  look: DEFAULT_LOOK,
  rules: DEFAULT_RULES,
  temperament: { dip: 'steady', swarm: 'social' },
  devBuy: 0.1,
  status: 'mock',
  honey: 0.05,
  bees: 2,
  feesTotal: 0,
  royalJelly: 0,
  price: 0.00000028,
  state: 'working',
  createdAt: 1_000,
  updatedAt: 1_000,
  ...extra,
});

const action = (id: string, ca: string, at: number, extra: Partial<RemoteAction> = {}): RemoteAction => ({ id, ca, verb: 'store', amount: 0.01, reason: 'kept honey', at, ...extra });
const harvest = (id: string, at: number): RemoteHarvest => ({ id, at, feesIn: 1, hiveBought: 100, burned: 50, jellyTo: 'A', jellyAmount: 50, jellySol: 0.5, txSig: 'sig' });

const launch = (id: string, extra: Partial<LaunchRecord> = {}): LaunchRecord => ({
  id,
  mode: 'mock',
  state: 'reserved',
  owner: 'guest:owner01',
  payload: {
    owner: 'guest:owner01',
    name: 'Test',
    ticker: 'TEST',
    image: 'data:image/png;base64,AAAA',
    devBuy: 0,
    look: DEFAULT_LOOK,
    rules: DEFAULT_RULES,
    temperament: { dip: 'steady', swarm: 'social' },
    issuedAt: 1,
  },
  queenWallet: `queen-${id}`,
  mintPubkey: `mint-${id}`,
  mintSecretEnc: 'v1.a.b.c',
  cell: { q: 1, r: 0 },
  lamports: 70_000_000,
  createdAt: 1,
  expiresAt: Date.now() + 60_000,
  updatedAt: 1,
  txs: {},
  attempts: 0,
  ...extra,
});

describe('FileDb hives', () => {
  it('creates, reads, updates and lists hives', async () => {
    expect(await db.listHives()).toEqual([]);
    expect(await db.getHive('A')).toBeNull();
    await db.upsertHive(hive('A', 0, 0));
    await db.upsertHive(hive('B', 1, 0, { createdAt: 500 }));
    expect((await db.listHives()).map((h) => h.ca)).toEqual(['B', 'A']); // oldest first
    await db.upsertHive(hive('A', 0, 0, { honey: 1.5, state: 'starving', updatedAt: 2_000 }));
    const a = await db.getHive('A');
    expect(a?.honey).toBe(1.5);
    expect(a?.state).toBe('starving');
    expect(await db.listHives()).toHaveLength(2);
  });

  it('returns copies: mutating results or inputs never changes the store', async () => {
    const h = hive('A', 0, 0);
    await db.upsertHive(h);
    h.honey = 99;
    const got = (await db.getHive('A'))!;
    expect(got.honey).toBe(0.05);
    got.honey = 42;
    expect((await db.getHive('A'))!.honey).toBe(0.05);
  });

  it('enforces one hive per cell and one hive per queen wallet', async () => {
    await db.upsertHive(hive('A', 0, 0));
    await expect(db.upsertHive(hive('B', 0, 0))).rejects.toThrow(/cell/);
    await expect(db.upsertHive(hive('C', 2, 0, { queenWallet: 'queen-A' }))).rejects.toThrow(/queen wallet/);
    expect((await db.listHives()).map((h) => h.ca)).toEqual(['A']);
  });

  it('rejects malformed hives', async () => {
    await expect(db.upsertHive({ ...hive('A', 0, 0), cell: { q: 0.5, r: 0 } })).rejects.toThrow();
    await expect(db.upsertHive({ ...hive('', 0, 0) })).rejects.toThrow();
  });
});

describe('FileDb actions, harvests, prices', () => {
  it('keeps actions newest first, filters by ca, ignores duplicate ids', async () => {
    await db.addAction(action('1', 'A', 100));
    await db.addAction(action('2', 'B', 300));
    await db.addAction(action('3', 'A', 200));
    await db.addAction(action('3', 'A', 999)); // retry of an existing id: ignored
    expect((await db.listActions(10)).map((a) => a.id)).toEqual(['2', '3', '1']);
    expect((await db.listActions(10, 'A')).map((a) => a.id)).toEqual(['3', '1']);
    expect((await db.listActions(1)).map((a) => a.id)).toEqual(['2']);
    expect(await db.listActions(0)).toEqual([]);
  });

  it(`caps actions at ${FILE_DB_CAPS.actions}`, async () => {
    await Promise.all(Array.from({ length: FILE_DB_CAPS.actions + 25 }, (_, i) => db.addAction(action(`a${i}`, 'A', i))));
    const all = await db.listActions(10_000);
    expect(all).toHaveLength(FILE_DB_CAPS.actions);
    expect(all[0].id).toBe(`a${FILE_DB_CAPS.actions + 24}`);
    expect(all.at(-1)!.id).toBe('a25');
  });

  it('keeps harvests newest first', async () => {
    await db.addHarvest(harvest('h1', 10));
    await db.addHarvest(harvest('h2', 20));
    expect((await db.listHarvests(5)).map((h) => h.id)).toEqual(['h2', 'h1']);
  });

  it('stores prices per ca in time order, replaces same-time points, caps per ca', async () => {
    await db.addPrice('A', 300, 3);
    await db.addPrice('A', 100, 1);
    await db.addPrice('A', 200, 2);
    await db.addPrice('A', 200, 2.5);
    await db.addPrice('B', 150, 9);
    expect(await db.listPrices('A', 0)).toEqual([
      { at: 100, price: 1 },
      { at: 200, price: 2.5 },
      { at: 300, price: 3 },
    ]);
    expect(await db.listPrices('A', 200)).toHaveLength(2);
    expect(await db.listPrices('C', 0)).toEqual([]);
    await Promise.all(Array.from({ length: FILE_DB_CAPS.pricesPerCa + 10 }, (_, i) => db.addPrice('C', 1_000 + i, i)));
    const c = await db.listPrices('C', 0);
    expect(c).toHaveLength(FILE_DB_CAPS.pricesPerCa);
    expect(c[0].at).toBe(1_010);
    await expect(db.addPrice('A', 1, NaN)).rejects.toThrow();
  });

  it('never caches prices for CAs that are not hives (reads of unknown CAs cannot grow memory)', async () => {
    const cache = (d: FileDb) => (d as unknown as { s: { prices: Map<string, unknown>; pricesLoading: Map<string, unknown> } }).s;
    for (let i = 0; i < 500; i++) expect(await db.listPrices(`unknown${i}`, 0)).toEqual([]);
    expect(cache(db).prices.size).toBe(0);
    expect(cache(db).pricesLoading.size).toBe(0);

    // a price file whose CA has no hive record is still served, straight from disk
    await db.addPrice('Orphan', 100, 1);
    const fresh = new FileDb(dir, { isolated: true });
    expect(await fresh.listPrices('Orphan', 0)).toEqual([{ at: 100, price: 1 }]);
    expect(cache(fresh).prices.size).toBe(0);

    // real hives are cached once and stay consistent with later writes
    await fresh.upsertHive(hive('A', 0, 0));
    await Promise.all([fresh.listPrices('A', 0), fresh.listPrices('A', 0), fresh.addPrice('A', 5, 2)]);
    expect([...cache(fresh).prices.keys()]).toEqual(['A']);
    expect(cache(fresh).pricesLoading.size).toBe(0);
    expect(await fresh.listPrices('A', 0)).toEqual([{ at: 5, price: 2 }]);
  });
});

describe('FileDb cell claims', () => {
  it('gives each cell to exactly one of many concurrent launches', async () => {
    const cells = [
      { q: 1, r: 0 },
      { q: 0, r: 1 },
      { q: -1, r: 1 },
    ];
    const exp = Date.now() + 60_000;
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => db.claimCell(cells, `L${i}`, exp)));
    const won = results.filter(Boolean).map((c) => `${c!.q},${c!.r}`);
    expect(won).toHaveLength(3);
    expect(new Set(won).size).toBe(3);
    expect(results.filter((c) => c === null)).toHaveLength(7);
    expect(await db.takenCells(Date.now())).toHaveLength(3);
  });

  it('skips cells a hive stands on and invalid candidates', async () => {
    await db.upsertHive(hive('A', 0, 0));
    const got = await db.claimCell([{ q: 0, r: 0 }, { q: 0.5, r: 1 } as never, { q: 2, r: 2 }], 'L1', Date.now() + 60_000);
    expect(got).toEqual({ q: 2, r: 2 });
  });

  it('frees expired claims, keeps finalized ones forever', async () => {
    const now = Date.now();
    expect(await db.claimCell([{ q: 1, r: 1 }], 'L1', now - 1)).toEqual({ q: 1, r: 1 }); // lapses immediately
    expect(await db.takenCells(Date.now())).toEqual([]);
    expect(await db.claimCell([{ q: 1, r: 1 }], 'L2', now + 60_000)).toEqual({ q: 1, r: 1 });
    expect(await db.claimCell([{ q: 1, r: 1 }], 'L3', now + 60_000)).toBeNull();
    // the claim is taken until it expires...
    expect(await db.takenCells(now)).toEqual([{ q: 1, r: 1 }]);
    expect(await db.takenCells(now + 120_000)).toEqual([]);
    // ...unless finalized
    await db.finalizeCell('L2');
    expect(await db.takenCells(now + 10 * 365 * 86_400_000)).toEqual([{ q: 1, r: 1 }]);
  });

  it('is idempotent per launch and holds one pending cell per launch', async () => {
    const exp = Date.now() + 60_000;
    expect(await db.claimCell([{ q: 1, r: 1 }], 'L1', exp)).toEqual({ q: 1, r: 1 });
    expect(await db.claimCell([{ q: 1, r: 1 }], 'L1', exp + 1)).toEqual({ q: 1, r: 1 });
    expect(await db.claimCell([{ q: 2, r: 2 }], 'L1', exp)).toEqual({ q: 2, r: 2 });
    expect(await db.takenCells(Date.now())).toEqual([{ q: 2, r: 2 }]);
  });

  it('releases a launch\'s claims', async () => {
    const exp = Date.now() + 60_000;
    await db.claimCell([{ q: 1, r: 1 }], 'L1', exp);
    await db.releaseCell('L1');
    expect(await db.claimCell([{ q: 1, r: 1 }], 'L2', exp)).toEqual({ q: 1, r: 1 });
  });
});

describe('FileDb launches', () => {
  it('creates once and reads back', async () => {
    await db.createLaunch(launch('L1'));
    await expect(db.createLaunch(launch('L1'))).rejects.toThrow(/exists/);
    expect((await db.getLaunch('L1'))?.queenWallet).toBe('queen-L1');
    expect(await db.getLaunch('nope')).toBeNull();
  });

  it('updateLaunch is compare-and-set on state', async () => {
    await db.createLaunch(launch('L1'));
    const paid = await db.updateLaunch('L1', { state: 'paid', txs: { payment: 'sig1' } }, ['reserved']);
    expect(paid?.state).toBe('paid');
    expect(paid?.txs.payment).toBe('sig1');
    expect(paid!.updatedAt).toBeGreaterThan(1);
    // a second worker that still thinks it is 'reserved' loses
    expect(await db.updateLaunch('L1', { state: 'expired' }, ['reserved'])).toBeNull();
    expect((await db.getLaunch('L1'))?.state).toBe('paid');
    // the id can never be patched
    const r = await db.updateLaunch('L1', { id: 'other', attempts: 2 } as Partial<LaunchRecord>, ['paid']);
    expect(r?.id).toBe('L1');
    expect(await db.updateLaunch('missing', { state: 'paid' }, ['reserved'])).toBeNull();
  });

  it('lets exactly one of many concurrent CAS updates win', async () => {
    await db.createLaunch(launch('L1'));
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => db.updateLaunch('L1', { state: 'metadata', attempts: i + 1 }, ['reserved', 'paid'])));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('lists launches by state, oldest first', async () => {
    await db.createLaunch(launch('L2', { createdAt: 20 }));
    await db.createLaunch(launch('L1', { createdAt: 10 }));
    await db.createLaunch(launch('L3', { createdAt: 30, state: 'live' }));
    expect((await db.listLaunches(['reserved'])).map((l) => l.id)).toEqual(['L1', 'L2']);
    expect((await db.listLaunches(['reserved', 'live'])).map((l) => l.id)).toEqual(['L1', 'L2', 'L3']);
  });
});

describe('FileDb secrets, meta, locks', () => {
  it('stores secrets first-write-wins', async () => {
    await db.putSecret('PK', 'enc-1');
    await db.putSecret('PK', 'enc-2');
    expect(await db.getSecret('PK')).toBe('enc-1');
    expect(await db.getSecret('other')).toBeNull();
    expect(await db.getSecret('__proto__')).toBeNull();
  });

  it('stores meta', async () => {
    expect(await db.getMeta('k')).toBeNull();
    await db.setMeta('k', 'v1');
    await db.setMeta('k', 'v2');
    expect(await db.getMeta('k')).toBe('v2');
  });

  it('locks until expiry, one holder at a time', async () => {
    const now = Date.now();
    const results = await Promise.all(Array.from({ length: 6 }, () => db.lock('engine', now + 60_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.lock('harvest', now + 60_000)).toBe(true);
    await db.unlock('engine');
    expect(await db.lock('engine', now - 1)).toBe(true); // taken with an already-past expiry...
    expect(await db.lock('engine', now + 60_000)).toBe(true); // ...so it is free again
  });
});

describe('FileDb change feed', () => {
  it('emits hive, action and harvest events after they are stored', async () => {
    const seen: StreamEvent[] = [];
    const off = db.subscribe((ev) => seen.push(ev));
    await db.upsertHive(hive('A', 0, 0));
    await db.upsertHive(hive('A', 0, 0)); // unchanged: no event
    await db.addAction(action('1', 'A', 5));
    await db.addAction(action('1', 'A', 5)); // duplicate: no event
    await db.addHarvest(harvest('h1', 7));
    expect(seen.map((e) => e.type)).toEqual(['hive', 'action', 'harvest']);
    expect(seen[0].type === 'hive' && seen[0].hive.ca).toBe('A');
    off();
    off(); // idempotent
    await db.addAction(action('2', 'A', 6));
    expect(seen).toHaveLength(3);
  });

  it('a throwing subscriber does not break writes or other subscribers', async () => {
    const seen: string[] = [];
    db.subscribe(() => {
      throw new Error('boom');
    });
    db.subscribe((ev) => seen.push(ev.type));
    await expect(db.addAction(action('1', 'A', 1))).resolves.toBeUndefined();
    expect(seen).toEqual(['action']);
  });

  it('shares state and the feed between instances on the same directory', async () => {
    const a = new FileDb(dir);
    const b = new FileDb(dir);
    const seen: string[] = [];
    b.subscribe((ev) => seen.push(ev.type));
    await a.upsertHive(hive('A', 0, 0));
    expect(await b.getHive('A')).not.toBeNull();
    expect(seen).toEqual(['hive']);
  });
});

describe('FileDb persistence', () => {
  it('reloads everything from disk in a new instance', async () => {
    await db.upsertHive(hive('A', 0, 0));
    await db.addAction(action('1', 'A', 5));
    await db.addHarvest(harvest('h1', 7));
    await db.addPrice('A', 100, 1);
    await db.createLaunch(launch('L1'));
    await db.updateLaunch('L1', { state: 'paid' }, ['reserved']);
    await db.claimCell([{ q: 3, r: 3 }], 'L1', Date.now() + 60_000);
    await db.finalizeCell('L1');
    await db.putSecret('PK', 'enc');
    await db.setMeta('k', 'v');
    await db.lock('engine', Date.now() + 60_000);

    const again = new FileDb(dir, { isolated: true });
    expect(await again.getHive('A')).toEqual(await db.getHive('A'));
    expect(await again.listActions(10)).toEqual(await db.listActions(10));
    expect(await again.listHarvests(10)).toEqual(await db.listHarvests(10));
    expect(await again.listPrices('A', 0)).toEqual([{ at: 100, price: 1 }]);
    expect((await again.getLaunch('L1'))?.state).toBe('paid');
    expect(await again.takenCells(Date.now() + 1e12)).toEqual(expect.arrayContaining([{ q: 0, r: 0 }, { q: 3, r: 3 }]));
    expect(await again.getSecret('PK')).toBe('enc');
    expect(await again.getMeta('k')).toBe('v');
    expect(await again.lock('engine', Date.now() + 60_000)).toBe(false);
  });

  it('writes atomically (no tmp files left) with private file modes', async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => db.addAction(action(`a${i}`, 'A', i))));
    await db.putSecret('PK', 'enc');
    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(await readFile(path.join(dir, 'actions.json'), 'utf8'))).toHaveLength(30);
    const { stat } = await import('node:fs/promises');
    expect((await stat(path.join(dir, 'secrets.json'))).mode & 0o077).toBe(0);
  });

  it('refuses to start over a corrupt data file instead of overwriting it', async () => {
    await writeFile(path.join(dir, 'secrets.json'), '{ not json');
    const broken = new FileDb(dir, { isolated: true });
    await expect(broken.getSecret('x')).rejects.toThrow(/not valid JSON/);
    expect(await readFile(path.join(dir, 'secrets.json'), 'utf8')).toBe('{ not json');
  });

  it('uses safe file names for unusual ids', async () => {
    await db.upsertHive(hive('../../etc/passwd', 5, 5));
    const files = await readdir(path.join(dir, 'hives'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^x-[0-9a-f]{64}\.json$/);
    const again = new FileDb(dir, { isolated: true });
    expect((await again.getHive('../../etc/passwd'))?.cell).toEqual({ q: 5, r: 5 });
  });
});

/* ---------- GET /api/hives/[ca] against a real FileDb ---------- */

describe('GET /api/hives/[ca]', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/server/db');
    vi.resetModules();
  });

  async function route() {
    const calls: string[] = [];
    const spy = new Proxy(db, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    vi.resetModules();
    vi.doMock('@/lib/server/db', () => ({ getDb: async () => spy }));
    const { GET } = await import('@/app/api/hives/[ca]/route');
    const get = (ca: string) => GET(new Request(`http://localhost/api/hives/${ca}`), { params: { ca } });
    return { get, calls };
  }

  it('answers 404 for an unknown hive without touching actions or prices', async () => {
    const { get, calls } = await route();
    const res = await get('NoSuchHive');
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(calls).toEqual(['getHive']);
    expect((await get('bad%2Fca')).status).toBe(404); // not a CA at all: the store is never asked
    expect(calls).toEqual(['getHive']);
  });

  it('returns the hive, its actions and its last day of prices', async () => {
    const now = Date.now();
    await db.upsertHive(hive('A', 0, 0));
    await db.addAction(action('1', 'A', now - 1_000));
    await db.addAction(action('2', 'B', now - 500));
    await db.addPrice('A', now - 2 * 24 * 3600_000, 1);
    await db.addPrice('A', now - 60_000, 2);
    const { get } = await route();
    const res = await get('A');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HiveDetailResponse;
    expect(body.hive.ca).toBe('A');
    expect(body.actions.map((a) => a.id)).toEqual(['1']);
    expect(body.prices).toEqual([{ at: now - 60_000, price: 2 }]);
  });
});

/* ---------- GET /api/stream against a real FileDb ---------- */

describe('GET /api/stream', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/server/db');
    vi.resetModules();
    vi.useRealTimers();
  });

  it('streams events with image URLs (never data URLs), pings every 20s and unsubscribes on abort', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.resetModules();
    vi.doMock('@/lib/server/db', () => ({ getDb: async () => db }));
    const { GET } = await import('@/app/api/stream/route');
    const ac = new AbortController();
    const res = await GET(new Request('http://localhost/api/stream', { signal: ac.signal }));
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const next = async () => dec.decode((await reader.read()).value);

    expect(await next()).toContain('retry: 5000');
    await db.upsertHive(hive('A', 0, 0));
    const first = await next();
    expect(first).toMatch(/^event: hive\ndata: /);
    const url = JSON.parse(first.split('data: ')[1]).image as string;
    expect(url).toMatch(/^\/api\/hives\/A\/image\?v=[0-9a-z]+$/); // the bytes are served by the image route
    expect(await db.getMeta('image:A')).toBe('data:image/png;base64,AAAA');
    await db.upsertHive(hive('A', 0, 0, { honey: 1, updatedAt: 2_000 }));
    expect(JSON.parse((await next()).split('data: ')[1]).image).toBe(url); // a few bytes: always sent

    vi.advanceTimersByTime(20_000);
    expect(await next()).toMatch(/^event: ping\ndata: \d+\n\n$/); // a named event the page can see

    const emitter = (db as unknown as { s: { emitter: { listenerCount(e: string): number } } }).s.emitter;
    expect(emitter.listenerCount('event')).toBe(1);
    ac.abort();
    expect(emitter.listenerCount('event')).toBe(0);
  });
});
