import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actionToRow, harvestToRow, hiveToRow, mapRows, rowToAction, rowToHarvest, rowToHive, rowToPrice, toMs, toNum } from '@/lib/shared/rows';
import { SupabaseDb, launchPatchToRow, launchToRow, rowToLaunch } from '@/lib/server/db-supabase';
import type { LaunchRecord } from '@/lib/server/db';
import type { RemoteAction, RemoteHarvest, RemoteHive } from '@/lib/shared/api';
import { DEFAULT_LOOK, DEFAULT_RULES } from '@/lib/queen';

const T = Date.UTC(2026, 9, 7, 6, 0, 0, 123);

const fullHive: RemoteHive = {
  ca: 'CaAbc123pump',
  name: 'Golden',
  ticker: 'GOLD',
  image: 'https://ipfs.io/ipfs/xyz',
  description: 'desc',
  motto: 'motto',
  telegram: 'https://t.me/x',
  twitter: 'https://x.com/x',
  cell: { q: -2, r: 3 },
  queenWallet: 'Queen111',
  ownerWallet: 'Owner111',
  look: DEFAULT_LOOK,
  rules: DEFAULT_RULES,
  temperament: { dip: 'steady', swarm: 'social' },
  devBuy: 0.5,
  status: 'live',
  createTx: 'sigCreate',
  honey: 1.25,
  bees: 42,
  feesTotal: 3.5,
  royalJelly: 0.75,
  price: 0.000000281,
  state: 'starving',
  lastFeeAt: T - 1000,
  createdAt: T - 5000,
  updatedAt: T,
};

describe('scalar readers', () => {
  it('reads numbers from numbers and numeric strings', () => {
    expect(toNum(1.5)).toBe(1.5);
    expect(toNum('0.000000281')).toBe(0.000000281);
    expect(toNum('')).toBe(0);
    expect(toNum(null, 7)).toBe(7);
    expect(toNum('abc', 7)).toBe(7);
    expect(toNum(Infinity, 7)).toBe(7);
  });

  it('reads timestamptz in the shapes PostgREST and Realtime produce', () => {
    expect(toMs('2026-10-07T06:00:00.123Z')).toBe(T);
    expect(toMs('2026-10-07T06:00:00.123+00:00')).toBe(T);
    expect(toMs('2026-10-07T06:00:00.123456+00:00')).toBe(T);
    expect(toMs('2026-10-07 06:00:00.123+00')).toBe(T);
    expect(toMs('2026-10-07T08:00:00.123+02')).toBe(T);
    expect(toMs('2026-10-07T11:30:00.123+0530')).toBe(T);
    expect(toMs('2026-10-07T06:00:00.123')).toBe(T); // no zone: UTC
    expect(toMs(T)).toBe(T);
    expect(toMs('garbage')).toBeNaN();
    expect(toMs(null)).toBeNaN();
  });
});

describe('hive rows', () => {
  it('round-trips every field', () => {
    const row = hiveToRow(fullHive);
    expect(row.cell_q).toBe(-2);
    expect(row.queen_wallet).toBe('Queen111');
    expect(row.created_at).toBe(new Date(T - 5000).toISOString());
    expect(rowToHive(row)).toEqual(fullHive);
  });

  it('maps absent optionals to null and back to undefined', () => {
    const minimal: RemoteHive = { ...fullHive, description: undefined, motto: undefined, telegram: undefined, twitter: undefined, look: undefined, rules: undefined, temperament: undefined, createTx: undefined, price: undefined, lastFeeAt: undefined };
    const row = hiveToRow(minimal);
    expect(row.description).toBeNull();
    expect(row.price).toBeNull();
    expect(row.last_fee_at).toBeNull();
    const back = rowToHive(row)!;
    expect(back.description).toBeUndefined();
    expect(back.price).toBeUndefined();
    expect(back.lastFeeAt).toBeUndefined();
    expect(back).toEqual(minimal);
  });

  it('accepts a Realtime-shaped row (numeric strings, Postgres timestamps)', () => {
    const rt = { ...hiveToRow(fullHive), honey: '1.25', bees: '42', fees_total: '3.5', royal_jelly: '0.75', dev_buy: '0.5', price: '2.81e-7', created_at: '2026-10-07 05:59:55.123+00', updated_at: '2026-10-07 06:00:00.123+00', last_fee_at: '2026-10-07 05:59:59.123+00' };
    expect(rowToHive(rt)).toEqual(fullHive);
  });

  it('never produces an invalid hive', () => {
    expect(rowToHive(null)).toBeNull();
    expect(rowToHive({})).toBeNull();
    expect(rowToHive({ ca: 'x', cell_q: 'a', cell_r: 0 })).toBeNull();
    const odd = rowToHive({ ca: 'x', cell_q: 1, cell_r: 2, state: 'bogus', status: 'bogus' })!;
    expect(odd.state).toBe('working');
    expect(odd.status).toBe('mock');
    expect(odd.image).toBe('');
    expect(Number.isFinite(odd.createdAt)).toBe(true);
  });

  it('rounds bees to a non-negative integer for the integer column', () => {
    expect(hiveToRow({ ...fullHive, bees: 3.6 }).bees).toBe(4);
    expect(hiveToRow({ ...fullHive, bees: -1 }).bees).toBe(0);
  });
});

describe('action, harvest, price rows', () => {
  it('round-trips actions, including dry runs and swarm targets', () => {
    const a: RemoteAction = { id: 'a1', ca: 'C1', verb: 'swarm', amount: 0.2, targetCa: 'C2', reason: 'Swarmed', txSig: 'sig', at: T, dryRun: true };
    expect(actionToRow(a)).toMatchObject({ target_ca: 'C2', tx_sig: 'sig', dry_run: true, at: new Date(T).toISOString() });
    expect(rowToAction(actionToRow(a))).toEqual(a);
    const plain: RemoteAction = { id: 'a2', ca: 'C1', verb: 'store', amount: 0, reason: 'kept', at: T };
    expect(rowToAction(actionToRow(plain))).toEqual(plain);
  });

  it('drops unreadable actions', () => {
    expect(rowToAction({ id: 'a', ca: 'c', verb: 'explode', at: T })).toBeNull();
    expect(rowToAction({ id: 'a', ca: 'c', verb: 'seal', at: 'never' })).toBeNull();
    expect(mapRows([{ id: 'a', ca: 'c', verb: 'seal', at: T, amount: '1' }, { nope: true }], rowToAction)).toHaveLength(1);
    expect(mapRows(null, rowToAction)).toEqual([]);
  });

  it('round-trips harvests', () => {
    const h: RemoteHarvest = { id: 'h1', at: T, feesIn: 1.2, hiveBought: 1_000_000, burned: 500_000, jellyTo: 'C1', jellyAmount: 500_000, jellySol: 0.6, txSig: 'sig' };
    expect(rowToHarvest(harvestToRow(h))).toEqual(h);
    expect(rowToHarvest(harvestToRow({ ...h, dryRun: true }))?.dryRun).toBe(true);
  });

  it('reads prices', () => {
    expect(rowToPrice({ ca: 'C', at: '2026-10-07T06:00:00.123+00:00', price: '0.5' })).toEqual({ at: T, price: 0.5 });
    expect(rowToPrice({ at: 'x', price: 1 })).toBeNull();
  });
});

const launch: LaunchRecord = {
  id: 'L1',
  mode: 'live',
  state: 'paid',
  owner: 'Owner111',
  payload: { owner: 'Owner111', name: 'Golden', ticker: 'GOLD', image: 'data:image/png;base64,AAAA', devBuy: 0.5, look: DEFAULT_LOOK, rules: DEFAULT_RULES, temperament: { dip: 'steady', swarm: 'social' }, issuedAt: T, cell: { q: 1, r: 1 } },
  queenWallet: 'Queen111',
  mintPubkey: 'Mint111',
  mintSecretEnc: 'v1.iv.tag.ct',
  cell: { q: 1, r: 1 },
  lamports: 570_000_000,
  createdAt: T - 10_000,
  expiresAt: T + 900_000,
  updatedAt: T,
  ca: 'Mint111',
  metadataUri: 'https://ipfs.io/ipfs/meta',
  imageUri: 'https://ipfs.io/ipfs/img',
  txs: { payment: 'sigPay' },
  error: 'last error',
  attempts: 2,
};

describe('launch rows (server)', () => {
  it('round-trips a full launch record', () => {
    const row = launchToRow(launch);
    expect(row).toMatchObject({ queen_wallet: 'Queen111', mint_secret_enc: 'v1.iv.tag.ct', cell_q: 1, cell_r: 1, lamports: 570_000_000 });
    expect(rowToLaunch(row)).toEqual(launch);
  });

  it('patches only the given keys; an explicit undefined clears the column', () => {
    expect(launchPatchToRow({ state: 'created', txs: { create: 's' } })).toEqual({ state: 'created', txs: { create: 's' } });
    expect(launchPatchToRow({ error: undefined, ca: undefined })).toEqual({ error: null, ca: null });
    // required columns are never nulled by an undefined
    expect(launchPatchToRow({ cell: undefined, expiresAt: undefined } as Partial<LaunchRecord>)).toEqual({});
  });
});

/* ---------- SupabaseDb request shapes, against a fake PostgREST ---------- */

interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: unknown;
  prefer: string | null;
}

function fakeSupabase(respond: (c: Call) => unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      params: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      prefer: headers.get('Prefer'),
    };
    calls.push(call);
    const data = respond(call);
    return new Response(data === undefined ? '' : JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const db = new SupabaseDb('https://example.supabase.co', 'service-key', { fetch: fetchImpl });
  return { db, calls };
}

describe('SupabaseDb', () => {
  it('claimCell walks the candidates through rpc(claim_cell) until one is granted', async () => {
    const { db, calls } = fakeSupabase((c) => (c.body as { q: number }).q === 2);
    const cell = await db.claimCell([{ q: 1, r: 0 }, { q: 2, r: 0 }, { q: 3, r: 0 }], 'L1', T);
    expect(cell).toEqual({ q: 2, r: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[0].path).toBe('/rest/v1/rpc/claim_cell');
    expect(calls[0].body).toEqual({ q: 1, r: 0, launch: 'L1', expires: new Date(T).toISOString() });
  });

  it('claimCell returns null when nothing could be claimed', async () => {
    const { db } = fakeSupabase(() => false);
    expect(await db.claimCell([{ q: 1, r: 0 }], 'L1', T)).toBeNull();
  });

  it('updateLaunch is a conditional PATCH on id and state', async () => {
    const { db, calls } = fakeSupabase(() => [launchToRow({ ...launch, state: 'created' })]);
    const out = await db.updateLaunch('L1', { state: 'created', id: 'evil' } as Partial<LaunchRecord>, ['paid', 'metadata']);
    expect(out?.state).toBe('created');
    const c = calls[0];
    expect(c.method).toBe('PATCH');
    expect(c.path).toBe('/rest/v1/launches');
    expect(c.params.get('id')).toBe('eq.L1');
    expect(c.params.get('state')).toBe('in.(paid,metadata)');
    expect(c.prefer).toContain('return=representation');
    expect(c.body).toMatchObject({ state: 'created' });
    expect((c.body as Record<string, unknown>).id).toBeUndefined();
    expect(typeof (c.body as Record<string, unknown>).updated_at).toBe('string');
  });

  it('updateLaunch returns null when the state did not match', async () => {
    const { db } = fakeSupabase(() => []);
    expect(await db.updateLaunch('L1', { state: 'created' }, ['paid'])).toBeNull();
  });

  it('lock uses rpc(try_lock)', async () => {
    const { db, calls } = fakeSupabase(() => true);
    expect(await db.lock('engine', T)).toBe(true);
    expect(calls[0].path).toBe('/rest/v1/rpc/try_lock');
    expect(calls[0].body).toEqual({ name: 'engine', until: new Date(T).toISOString() });
  });

  it('putSecret never overwrites (insert, ignore duplicates)', async () => {
    const { db, calls } = fakeSupabase(() => undefined);
    await db.putSecret('PK', 'enc');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].prefer).toContain('resolution=ignore-duplicates');
  });

  it('maps hive rows on read and pages through listHives', async () => {
    const { db, calls } = fakeSupabase(() => [hiveToRow(fullHive)]);
    expect(await db.listHives()).toEqual([fullHive]);
    expect(calls).toHaveLength(1); // a short page ends the scan
    expect(await db.getHive(fullHive.ca)).toEqual(fullHive);
  });

  it('takenCells merges hive cells and live claims', async () => {
    const { db, calls } = fakeSupabase((c) => (c.path.endsWith('/hives') ? [{ cell_q: 0, cell_r: 0 }] : [{ q: 1, r: 0 }, { q: 0, r: 0 }]));
    const cells = await db.takenCells(T);
    expect(cells).toEqual([{ q: 0, r: 0 }, { q: 1, r: 0 }]);
    expect(calls[1].params.get('or')).toBe(`(expires_at.is.null,expires_at.gt."${new Date(T).toISOString()}")`);
  });

  it('listPrices returns the newest points of the window, oldest first, paging under max-rows', async () => {
    // a fake prices table that honours order / offset / limit and caps each response at `maxRows`
    const table = (n: number) => Array.from({ length: n }, (_, i) => ({ at: new Date(T + i * 1000).toISOString(), price: String(i) }));
    const fake = (rows: { at: string; price: string }[], maxRows: number, onCall: () => void = () => {}) =>
      fakeSupabase((c) => {
        const sorted = c.params.get('order') === 'at.desc' ? [...rows].reverse() : rows;
        const off = Number(c.params.get('offset') ?? 0);
        const lim = Math.min(Number(c.params.get('limit') ?? sorted.length), maxRows);
        const page = sorted.slice(off, off + lim);
        onCall();
        return page;
      });
    const ascending = (pts: { at: number }[]) => pts.every((p, i) => i === 0 || p.at > pts[i - 1].at);

    const { db, calls } = fake(table(2500), 1000);
    const out = await db.listPrices('C', T - 1);
    expect(out).toHaveLength(2000);
    expect(out[0]).toEqual({ at: T + 500_000, price: 500 });
    expect(out[1999]).toEqual({ at: T + 2_499_000, price: 2499 }); // the current price survives the cap
    expect(ascending(out)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].params.get('ca')).toBe('eq.C');
    expect(calls[0].params.get('at')).toBe(`gte.${new Date(T - 1).toISOString()}`);
    expect(calls[0].params.get('order')).toBe('at.desc');
    expect([calls[0].params.get('offset'), calls[1].params.get('offset')]).toEqual(['0', '1000']);

    // a server configured with a smaller max-rows still yields the newest points
    const small = fake(table(2500), 300);
    const few = await small.db.listPrices('C', 0);
    expect(few).toHaveLength(300);
    expect(few[299].price).toBe(2499);
    expect(small.calls).toHaveLength(1);

    // a short window is one request
    const short = fake(table(5), 1000);
    expect((await short.db.listPrices('C', 0)).map((p) => p.price)).toEqual([0, 1, 2, 3, 4]);
    expect(short.calls).toHaveLength(1);

    // a point inserted between pages shifts the next page by one row: no duplicates come back
    const rows = table(2500);
    let n = 0;
    const shifting = fake(rows, 1000, () => {
      if (++n === 1) rows.push({ at: new Date(T + 2500 * 1000).toISOString(), price: '2500' });
    });
    const shifted = await shifting.db.listPrices('C', 0);
    expect(ascending(shifted)).toBe(true);
    expect(new Set(shifted.map((p) => p.at)).size).toBe(shifted.length);
  });

  it('surfaces database errors without row details', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: 'duplicate key', code: '23505', details: 'Key (pubkey)=(secret) exists' }), { status: 409 })) as typeof fetch;
    const db = new SupabaseDb('https://example.supabase.co', 'k', { fetch: fetchImpl });
    const err = await db.createLaunch(launch).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('23505');
    expect((err as Error).message).not.toContain('secret');
  });

  it('has no in-process feed', () => {
    const { db } = fakeSupabase(() => undefined);
    const off = db.subscribe(() => {});
    expect(typeof off).toBe('function');
    off();
  });
});

/* ---------- browser sync (lib/remote.ts): feed status over SSE and Supabase Realtime ---------- */

/** Minimal EventSource double: the test opens it, emits named events and errors. */
class FakeEventSource {
  static all: FakeEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
}

describe('startRemoteSync feed status', () => {
  const winListeners = new Map<string, Set<() => void>>();
  const fire = (type: string) => winListeners.get(type)?.forEach((fn) => fn());
  let stop: () => void = () => {};

  const config = (realtime: 'sse' | 'supabase') => ({
    launchMode: 'mock',
    realtime,
    ...(realtime === 'supabase' ? { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon' } : {}),
    demoHives: false,
    costs: { launchCost: 0.02, queenReserve: 0.05, maxDevBuy: 5 },
  });

  async function boot(realtime: 'sse' | 'supabase') {
    vi.stubGlobal('fetch', async (url: string) => {
      const body = url === '/api/config' ? config(realtime) : { hives: [fullHive], actions: [], harvests: [], serverTime: T };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.resetModules(); // a fresh module-level session and store per test
    const { startRemoteSync } = await import('@/lib/remote');
    const { useHive } = await import('@/lib/store');
    stop = startRemoteSync();
    await vi.advanceTimersByTimeAsync(0);
    return { feed: () => useHive.getState().feed, world: () => useHive.getState().world };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.all = [];
    winListeners.clear();
    const on = (t: string, fn: () => void) => winListeners.set(t, (winListeners.get(t) ?? new Set()).add(fn));
    const off = (t: string, fn: () => void) => winListeners.get(t)?.delete(fn);
    vi.stubGlobal('window', { addEventListener: on, removeEventListener: off });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(async () => {
    stop();
    await vi.advanceTimersByTimeAsync(5_000); // past the teardown grace period
    vi.doUnmock('@supabase/supabase-js');
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('SSE: an offline/online blip that the connection survives ends live again', async () => {
    const { feed, world } = await boot('sse');
    const es = FakeEventSource.all[0];
    es.open();
    expect(feed()).toBe('live');
    fire('offline');
    expect(feed()).toBe('offline');
    fire('online');
    expect(feed()).toBe('live');
    expect(FakeEventSource.all).toHaveLength(1); // no needless reconnect

    // anything heard on the feed marks it live too
    fire('offline');
    es.emit('harvest', { id: 'h1', at: T, feesIn: 1, hiveBought: 1, burned: 1, jellyTo: 'A', jellyAmount: 1, jellySol: 0.1, txSig: 's' });
    expect(feed()).toBe('live');
    fire('offline');
    es.emit('ping', T);
    expect(feed()).toBe('live');
    await vi.advanceTimersByTimeAsync(500);
    expect(world().harvests.some((h) => h.id === 'h1')).toBe(true);
  });

  it('SSE: a connection that stops hearing pings is dropped and reopened', async () => {
    const { feed } = await boot('sse');
    FakeEventSource.all[0].open();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      FakeEventSource.all[0].emit('ping', Date.now());
    }
    expect(FakeEventSource.all).toHaveLength(1); // pings keep it alive
    expect(feed()).toBe('live');

    await vi.advanceTimersByTimeAsync(60_000); // silence: the connection died without an error
    expect(FakeEventSource.all[0].readyState).toBe(2);
    expect(feed()).toBe('offline');
    fire('online'); // not a reason to call a dead connection live
    await vi.advanceTimersByTimeAsync(40_000);
    expect(FakeEventSource.all.length).toBeGreaterThanOrEqual(2);
    FakeEventSource.all[FakeEventSource.all.length - 1].open();
    expect(feed()).toBe('live');
  });

  it('Supabase: re-checks a joined channel when the browser comes back online, and data marks it live', async () => {
    const handlers: ((p: { new: unknown }) => void)[] = [];
    let subscribed: () => void = () => {};
    const joinedOnce = new Promise<void>((resolve) => (subscribed = resolve));
    const channel = {
      state: 'joining',
      on(_type: string, _filter: unknown, fn: (p: { new: unknown }) => void) {
        handlers.push(fn);
        return channel;
      },
      subscribe(cb: (status: string) => void) {
        channel.state = 'joined';
        cb('SUBSCRIBED');
        subscribed();
        return channel;
      },
    };
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({ channel: () => channel, removeChannel: async () => 'ok', realtime: { disconnect: () => {} } }),
    }));
    const { feed } = await boot('supabase');
    await joinedOnce; // the client is loaded with a dynamic import, which takes real time
    expect(feed()).toBe('live');
    expect(FakeEventSource.all).toHaveLength(0);

    fire('offline');
    expect(feed()).toBe('offline');
    fire('online');
    expect(feed()).toBe('live');

    fire('offline');
    handlers[0]({ new: hiveToRow(fullHive) });
    expect(feed()).toBe('live');

    channel.state = 'errored';
    fire('offline');
    fire('online');
    expect(feed()).toBe('offline'); // a channel that is not joined is not live
  });
});
