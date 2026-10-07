/**
 * "Only real hives": in LAUNCH_MODE=live the public reads (GET /api/hives, /api/hives/[ca], the image
 * route, /api/stream) carry only hives with status 'live' and only real (not dry-run) actions and
 * harvests of live hives. Preview rows in a live database never reach the public, never block a real
 * launch's cell, and a preview launch cannot be "refunded" by a live server. Mock mode is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_LOOK, DEFAULT_RULES } from '@/lib/queen';
import type { LaunchMode, RemoteAction, RemoteHarvest, RemoteHive, StreamEvent } from '@/lib/shared/api';
import { actionIsPublic, harvestIsPublic, hiveIsPublic, publicView } from '@/lib/shared/visibility';
import { config } from '@/lib/server/config';
import { setDbForTests, type LaunchRecord } from '@/lib/server/db';
import { FileDb } from '@/lib/server/db-file';
import { SupabaseDb } from '@/lib/server/db-supabase';
import { candidateCells, claimLaunchCell } from '@/lib/server/cells';
import { resetRateLimits } from '@/lib/server/ratelimit';
import { LaunchError, refundLaunch } from '@/lib/server/launch';
import { GET as listRoute } from '@/app/api/hives/route';
import { GET as detailRoute } from '@/app/api/hives/[ca]/route';
import { GET as imageRoute } from '@/app/api/hives/[ca]/image/route';
import { GET as streamRoute } from '@/app/api/stream/route';
import { hubFor, type StreamClient } from '@/app/api/_lib/stream-hub';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const T = Date.UTC(2026, 9, 7, 6, 0, 0);

const hive = (ca: string, status: 'mock' | 'live', q: number, over: Partial<RemoteHive> = {}): RemoteHive => ({
  ca,
  name: `Hive ${ca}`,
  ticker: 'HV',
  image: status === 'mock' ? PNG : 'https://ipfs.io/ipfs/bafy',
  cell: { q, r: 0 },
  queenWallet: `queen-${ca}`,
  ownerWallet: `owner-${ca}`,
  look: DEFAULT_LOOK,
  rules: DEFAULT_RULES,
  temperament: { dip: 'steady', swarm: 'social' },
  devBuy: 0,
  status,
  honey: 1,
  bees: 2,
  feesTotal: 0,
  royalJelly: 0,
  state: 'working',
  createdAt: T,
  updatedAt: T,
  ...over,
});
const action = (id: string, ca: string, over: Partial<RemoteAction> = {}): RemoteAction => ({ id, ca, verb: 'store', amount: 0.1, reason: id, at: T + 1, ...over });
const harvest = (id: string, jellyTo: string, over: Partial<RemoteHarvest> = {}): RemoteHarvest => ({ id, at: T + 2, feesIn: 1, hiveBought: 10, burned: 5, jellyTo, jellyAmount: 5, jellySol: 0.5, txSig: `sig-${id}`, ...over });

const dirs: string[] = [];
let mode: LaunchMode;
let db: FileDb;

async function seed(d: FileDb) {
  await d.upsertHive(hive('LIVE1', 'live', 1));
  await d.upsertHive(hive('LIVE2', 'live', 2));
  await d.upsertHive(hive('MOCK1', 'mock', 3));
  await d.addAction(action('live-real', 'LIVE1', { txSig: 'sig-real' }));
  await d.addAction(action('live-dry', 'LIVE1', { dryRun: true }));
  await d.addAction(action('mock-real', 'MOCK1'));
  await d.addAction(action('swarm-to-mock', 'LIVE2', { verb: 'swarm', targetCa: 'MOCK1' }));
  await d.addHarvest(harvest('h-real', 'LIVE1'));
  await d.addHarvest(harvest('h-dry', 'LIVE1', { dryRun: true }));
  await d.addHarvest(harvest('h-mock', 'MOCK1'));
}

beforeEach(async () => {
  mode = config.launchMode;
  resetRateLimits();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'real-visibility-'));
  dirs.push(dir);
  db = new FileDb(dir, { isolated: true });
  setDbForTests(db);
  await seed(db);
});

afterEach(async () => {
  config.launchMode = mode;
  setDbForTests(null);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const list = async () => (await (await listRoute(new Request('http://localhost/api/hives'))).json()) as { hives: RemoteHive[]; actions: RemoteAction[]; harvests: RemoteHarvest[] };
const ids = <T extends { id?: string; ca?: string }>(xs: T[], k: 'id' | 'ca') => xs.map((x) => x[k]).sort();

describe('lib/shared/visibility', () => {
  it('mock mode shows everything; live mode only live hives and real rows of live hives', () => {
    const live = (ca: string) => ca.startsWith('LIVE');
    expect(hiveIsPublic('mock', { status: 'mock' })).toBe(true);
    expect(hiveIsPublic('live', { status: 'mock' })).toBe(false);
    expect(hiveIsPublic('live', { status: 'live' })).toBe(true);
    expect(actionIsPublic('live', { ca: 'LIVE1' }, live)).toBe(true);
    expect(actionIsPublic('live', { ca: 'LIVE1', dryRun: true }, live)).toBe(false);
    expect(actionIsPublic('live', { ca: 'MOCK1' }, live)).toBe(false);
    expect(actionIsPublic('live', { ca: 'LIVE1', targetCa: 'MOCK1' }, live)).toBe(false);
    expect(actionIsPublic('mock', { ca: 'MOCK1', dryRun: true }, live)).toBe(true);
    expect(harvestIsPublic('live', { jellyTo: 'LIVE1' }, live)).toBe(true);
    expect(harvestIsPublic('live', { jellyTo: 'LIVE1', dryRun: true }, live)).toBe(false);
    expect(harvestIsPublic('live', { jellyTo: '' }, live)).toBe(false);
    expect(harvestIsPublic('live', { jellyTo: 'MOCK1' }, live)).toBe(false);
    const data = { hives: [hive('LIVE1', 'live', 1), hive('MOCK1', 'mock', 3)], actions: [action('a', 'LIVE1'), action('b', 'MOCK1')], harvests: [] };
    expect(publicView('mock', data)).toBe(data);
    expect(ids(publicView('live', data).hives, 'ca')).toEqual(['LIVE1']);
    expect(ids(publicView('live', data).actions, 'id')).toEqual(['a']);
  });
});

describe('GET /api/hives', () => {
  it('live mode: only live hives, real actions and harvests of live hives', async () => {
    config.launchMode = 'live';
    const body = await list();
    expect(ids(body.hives, 'ca')).toEqual(['LIVE1', 'LIVE2']);
    expect(ids(body.actions, 'id')).toEqual(['live-real']);
    expect(ids(body.harvests, 'id')).toEqual(['h-real']);
  });

  it('mock mode: unchanged, preview hives and dry runs included', async () => {
    config.launchMode = 'mock';
    const body = await list();
    expect(ids(body.hives, 'ca')).toEqual(['LIVE1', 'LIVE2', 'MOCK1']);
    expect(ids(body.actions, 'id')).toEqual(['live-dry', 'live-real', 'mock-real', 'swarm-to-mock']);
    expect(ids(body.harvests, 'id')).toEqual(['h-dry', 'h-mock', 'h-real']);
  });

  it('live mode: dry runs never crowd real rows out of the capped list (filtered in the store)', async () => {
    config.launchMode = 'live';
    for (let i = 0; i < 250; i++) await db.addAction(action(`dry-${i}`, 'LIVE1', { dryRun: true, at: T + 100 + i }));
    for (let i = 0; i < 70; i++) await db.addHarvest(harvest(`hdry-${i}`, 'LIVE1', { dryRun: true, at: T + 100 + i }));
    const body = await list();
    expect(ids(body.actions, 'id')).toEqual(['live-real']);
    expect(ids(body.harvests, 'id')).toEqual(['h-real']);
  });
});

describe('GET /api/hives/[ca] and its image', () => {
  const detail = (ca: string) => detailRoute(new Request(`http://localhost/api/hives/${ca}`), { params: { ca } });
  const image = (ca: string) => imageRoute(new Request(`http://localhost/api/hives/${ca}/image`), { params: { ca } });

  it('live mode: a preview hive is not found, and a live hive comes without its dry runs', async () => {
    config.launchMode = 'live';
    expect((await detail('MOCK1')).status).toBe(404);
    expect((await image('MOCK1')).status).toBe(404);
    const res = await detail('LIVE1');
    expect(res.status).toBe(200);
    expect(ids(((await res.json()) as { actions: RemoteAction[] }).actions, 'id')).toEqual(['live-real']);
    expect((await image('LIVE1')).status).toBe(302); // IPFS image: redirect
  });

  it('mock mode: preview hives and their images are served', async () => {
    config.launchMode = 'mock';
    expect((await detail('MOCK1')).status).toBe(200);
    const img = await image('MOCK1');
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
  });
});

describe('/api/stream in live mode', () => {
  const decode = (chunks: Uint8Array[]) => chunks.map((c) => new TextDecoder().decode(c)).join('');
  const events = (text: string) => [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].filter((m) => m[1] !== 'ping').map((m) => ({ type: m[1], data: JSON.parse(m[2]) as { ca?: string; id?: string } }));

  it('the in-process feed drops preview hives, their rows and dry runs', async () => {
    const hub = hubFor(db, 'events', 'live');
    const got: Uint8Array[] = [];
    const client: StreamClient = { push: (b) => got.push(b) };
    hub.add(client);
    await new Promise((r) => setTimeout(r, 20)); // the live hives are learnt from the store
    await db.upsertHive(hive('MOCK2', 'mock', 4));
    await db.addAction(action('mock2-a', 'MOCK2'));
    await db.addAction(action('live1-dry2', 'LIVE1', { dryRun: true }));
    await db.addAction(action('live1-real2', 'LIVE1'));
    await db.addHarvest(harvest('h-dry2', 'LIVE1', { dryRun: true }));
    await db.addHarvest(harvest('h-real2', 'LIVE2'));
    await db.upsertHive(hive('LIVE3', 'live', 5));
    await db.addAction(action('live3-born', 'LIVE3', { verb: 'born' }));
    hub.remove(client);
    expect(events(decode(got)).map((e) => `${e.type}:${e.data.id ?? e.data.ca}`)).toEqual(['action:live1-real2', 'harvest:h-real2', 'hive:LIVE3', 'action:live3-born']);
  });

  it('the polling feed (Supabase without an anon key) only lists what the public may see', async () => {
    config.launchMode = 'live';
    const poll = hubFor(db, 'poll', 'live');
    const got: Uint8Array[] = [];
    const client: StreamClient = { push: (b) => got.push(b) };
    poll.add(client);
    await new Promise((r) => setTimeout(r, 50)); // first round: learns the current state
    await db.upsertHive(hive('MOCK3', 'mock', 6));
    await db.upsertHive(hive('LIVE4', 'live', 7));
    await db.addAction(action('live4-a', 'LIVE4'));
    await db.addAction(action('mock3-a', 'MOCK3'));
    await db.addAction(action('live4-dry', 'LIVE4', { dryRun: true }));
    await new Promise((r) => setTimeout(r, 5_300)); // one POLL_MS round
    poll.remove(client);
    const seen = events(decode(got)).map((e) => `${e.type}:${e.data.id ?? e.data.ca}`);
    expect(seen).toEqual(['hive:LIVE4', 'action:live4-a']);
  }, 15_000);

  it('the route serves the filtered feed', async () => {
    config.launchMode = 'live';
    const ac = new AbortController();
    const res = await streamRoute(new Request('http://localhost/api/stream', { signal: ac.signal }));
    const reader = res.body!.getReader();
    await reader.read(); // retry + connected comment
    await new Promise((r) => setTimeout(r, 20));
    await db.upsertHive(hive('MOCK9', 'mock', 9));
    await db.upsertHive(hive('LIVE9', 'live', 10));
    const r = await reader.read();
    ac.abort();
    const ev = events(new TextDecoder().decode(r.value));
    expect(ev.map((e) => e.data.ca)).toEqual(['LIVE9']);
  });
});

describe('cells: preview data never blocks a live launch', () => {
  const launch = (id: string, launchMode: LaunchMode, q: number): LaunchRecord => ({
    id,
    mode: launchMode,
    state: 'reserved',
    owner: 'guest:abcdefgh',
    payload: {} as LaunchRecord['payload'],
    queenWallet: `queen-${id}`,
    mintPubkey: `mint-${id}`,
    mintSecretEnc: 'v1.x.x.x',
    cell: { q, r: 0 },
    lamports: 0,
    createdAt: T,
    expiresAt: Date.now() + 600_000,
    updatedAt: T,
    txs: {},
    attempts: 0,
  });

  it('live launches ignore preview hives and take over a preview launch\'s claim; mock launches do not', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'real-cells-'));
    dirs.push(dir);
    const d = new FileDb(dir, { isolated: true });
    await d.upsertHive(hive('MOCKO', 'mock', 0, { cell: { q: 0, r: 0 } })); // a preview hive on the origin
    await d.createLaunch(launch('mock-l', 'mock', 1));
    expect(await d.claimCell([{ q: 1, r: 0 }], 'mock-l', Date.now() + 600_000)).toEqual({ q: 1, r: 0 });
    const demo = config.demoHives;
    config.demoHives = false;
    try {
      // mock mode: the preview hive and claim are taken, the comb grows around them
      expect(await candidateCells(d, { q: 0, r: 0 }, Date.now())).not.toContainEqual({ q: 0, r: 0 });
      // live mode: an empty comb, so the first real hive gets the origin
      expect(await candidateCells(d, null, Date.now(), 40, { liveOnly: true })).toEqual([{ q: 0, r: 0 }]);
      expect(await d.takenCells(Date.now(), { liveOnly: true })).toEqual([]);
      // the first real launch gets the origin, under the preview hive
      await d.createLaunch(launch('live-l', 'live', 0));
      expect(await claimLaunchCell(d, { q: 0, r: 0 }, 'live-l', Date.now() + 600_000, Date.now(), { liveOnly: true })).toEqual({ cell: { q: 0, r: 0 }, changed: false });
      // the next one may take the cell a preview launch holds next to it
      await d.createLaunch(launch('live-2', 'live', 1));
      expect(await claimLaunchCell(d, { q: 1, r: 0 }, 'live-2', Date.now() + 600_000, Date.now(), { liveOnly: true })).toEqual({ cell: { q: 1, r: 0 }, changed: false });
      expect(await d.claimCell([{ q: 1, r: 0 }], 'mock-l', Date.now() + 600_000)).toBeNull(); // the real claim holds
      // a mock launch still treats both as taken
      expect(await d.claimCell([{ q: 0, r: 0 }], 'mock-l', Date.now() + 600_000)).toBeNull();
    } finally {
      config.demoHives = demo;
    }
  });

  it('a live server refuses to refund a preview launch (and a mock server a live one)', async () => {
    const l = { ...launch('mockrefund1', 'mock', 5), state: 'failed' as const };
    await db.createLaunch(l);
    await expect(refundLaunch(l.id, {}, { mode: 'live', db })).rejects.toMatchObject({ status: 409 });
    const live = { ...launch('liverefund1', 'live', 6), state: 'failed' as const };
    await db.createLaunch(live);
    const err = await refundLaunch(live.id, {}, { mode: 'mock', db }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaunchError);
    expect((err as LaunchError).status).toBe(409);
  });
});

describe('SupabaseDb: live scope and real-only lists', () => {
  function fakeSupabase(opts: { liveClaimMissing?: boolean } = {}) {
    const calls: { method: string; path: string; query: string; body?: unknown }[] = [];
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname, query: decodeURIComponent(url.search), body });
      if (url.pathname === '/rest/v1/rpc/claim_live_cell' && opts.liveClaimMissing) return json({ code: 'PGRST202', message: 'Could not find the function public.claim_live_cell' }, 404);
      if (url.pathname.startsWith('/rest/v1/rpc/')) return json(true);
      if (url.pathname === '/rest/v1/hives') return json([{ cell_q: 5, cell_r: 0 }]);
      if (url.pathname === '/rest/v1/launches') return json([{ id: 'mock-launch' }]);
      if (url.pathname === '/rest/v1/cell_claims') return json([{ q: 1, r: 0, launch_id: 'mock-launch' }, { q: 2, r: 0, launch_id: 'live-launch' }]);
      return json([]);
    }) as typeof fetch;
    return { db: new SupabaseDb('https://proj.supabase.co', 'service-key', { fetch: f }), calls };
  }

  it('live launches claim through claim_live_cell (falling back to claim_cell without 0002) and see no preview cells', async () => {
    const a = fakeSupabase();
    expect(await a.db.claimCell([{ q: 1, r: 0 }], 'live-launch', Date.now() + 60_000, { liveOnly: true })).toEqual({ q: 1, r: 0 });
    expect(a.calls.map((c) => c.path)).toEqual(['/rest/v1/rpc/claim_live_cell']);
    await a.db.claimCell([{ q: 1, r: 0 }], 'mock-launch', Date.now() + 60_000);
    expect(a.calls[1].path).toBe('/rest/v1/rpc/claim_cell');

    const b = fakeSupabase({ liveClaimMissing: true });
    expect(await b.db.claimCell([{ q: 1, r: 0 }], 'live-launch', Date.now() + 60_000, { liveOnly: true })).toEqual({ q: 1, r: 0 });
    expect(b.calls.map((c) => c.path)).toEqual(['/rest/v1/rpc/claim_live_cell', '/rest/v1/rpc/claim_cell']);
    await b.db.claimCell([{ q: 2, r: 0 }], 'live-launch', Date.now() + 60_000, { liveOnly: true });
    expect(b.calls.slice(2).map((c) => c.path)).toEqual(['/rest/v1/rpc/claim_cell']); // asked once per process

    const c = fakeSupabase();
    const taken = await c.db.takenCells(Date.now(), { liveOnly: true });
    expect(c.calls.find((x) => x.path === '/rest/v1/hives')!.query).toContain('status=neq.mock');
    expect(taken).toEqual([{ q: 5, r: 0 }, { q: 2, r: 0 }]); // the mock launch's claim on (1,0) does not count
    const d = fakeSupabase();
    expect(await d.db.takenCells(Date.now())).toHaveLength(3);
    expect(d.calls.some((x) => x.path === '/rest/v1/launches')).toBe(false);
  });

  it('real-only lists leave dry runs out in the query', async () => {
    const a = fakeSupabase();
    await a.db.listActions(200, undefined, { real: true });
    await a.db.listHarvests(60, { real: true });
    await a.db.listActions(200);
    expect(a.calls.map((c) => c.query.includes('dry_run=eq.false'))).toEqual([true, true, false]);
  });
});

export type { StreamEvent };
