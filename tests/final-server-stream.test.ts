/**
 * Finding #6: /api/stream had no connection cap and no backpressure, and hashed every hive image once
 * per connection inside the emitting write. Finding #23: a Supabase store without an anon key told
 * browsers to use SSE while /api/stream answered 204.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileDb } from '@/lib/server/db-file';
import { setDbForTests, type Db } from '@/lib/server/db';
import type { RemoteAction, RemoteHive } from '@/lib/shared/api';
import { DEFAULT_LOOK, DEFAULT_RULES } from '@/lib/queen';
import { MemDb } from './fakes/memdb';
import { GET } from '@/app/api/stream/route';
import { MAX_CONNECTIONS, MAX_PER_IP, MAX_QUEUED_BYTES, openConnections } from '@/app/api/_lib/stream-hub';

const BIG = 'data:image/png;base64,' + 'A'.repeat(Math.floor((400 * 1024) / 0.75));

const hive = (ca: string, q: number, honey: number, image = BIG): RemoteHive => ({
  ca,
  name: `Hive ${ca}`,
  ticker: 'HV',
  image,
  cell: { q, r: 0 },
  queenWallet: `queen-${ca}`,
  ownerWallet: `guest:owner-${ca}`,
  look: DEFAULT_LOOK,
  rules: DEFAULT_RULES,
  temperament: { dip: 'steady', swarm: 'social' },
  devBuy: 0,
  status: 'mock',
  honey,
  bees: 2,
  feesTotal: 0,
  royalJelly: 0,
  state: 'working',
  createdAt: 1_000,
  updatedAt: 1_000 + honey,
});

const dirs: string[] = [];
const aborts: AbortController[] = [];
async function fileDb() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'final-server-sse-'));
  dirs.push(dir);
  return new FileDb(dir, { isolated: true });
}
function open(headers: Record<string, string> = {}) {
  const ac = new AbortController();
  aborts.push(ac);
  return { ac, res: GET(new Request('http://localhost/api/stream', { signal: ac.signal, headers })) };
}
const listeners = (db: FileDb) => (db as unknown as { s: { emitter: { listenerCount(e: string): number } } }).s.emitter.listenerCount('event');

afterEach(async () => {
  for (const ac of aborts.splice(0)) ac.abort();
  expect(openConnections()).toBe(0);
  setDbForTests(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function drainAvailable(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let bytes = 0;
  for (;;) {
    const r = await Promise.race([reader.read().catch(() => ({ done: true, value: undefined })), new Promise<null>((res) => setTimeout(() => res(null), 50))]);
    if (!r || r.done) return bytes;
    bytes += r.value!.byteLength;
  }
}

describe('#6 GET /api/stream with clients that do not read', () => {
  it('keeps writes fast and per-connection memory bounded with 200 idle clients; the 201st is refused', async () => {
    const db = await fileDb();
    setDbForTests(db);
    const H = 20;
    for (let i = 0; i < H; i++) await db.upsertHive(hive(`H${i}`, i, 0));
    const round = async (honey: number) => {
      const t = performance.now();
      for (let i = 0; i < H; i++) await db.upsertHive(hive(`H${i}`, i, honey));
      return performance.now() - t;
    };
    const base = await round(1); // no subscribers

    const conns = await Promise.all(Array.from({ length: MAX_CONNECTIONS }, () => open().res));
    expect(conns.every((r) => r.status === 200)).toBe(true);

    const withSubs = await round(2);
    expect(withSubs).toBeLessThan(base * 5 + 1_000); // was 13.7 s vs 0.18 s
    for (let k = 3; k < 13; k++) await round(k);

    const buffered = await drainAvailable(conns[0].body!.getReader());
    expect(buffered).toBeGreaterThan(0);
    expect(buffered).toBeLessThanOrEqual(MAX_QUEUED_BYTES + 64 * 1024); // was 11 MB per stalled connection

    const over = await open().res;
    expect(over.status).toBe(503);
    expect(over.headers.get('Retry-After')).toBeTruthy();
    expect(openConnections()).toBe(MAX_CONNECTIONS);
    expect(listeners(db)).toBe(1); // one subscription for all of them
  });

  it('drops a connection whose unread queue passes the bound, and unsubscribes', async () => {
    const db = await fileDb();
    setDbForTests(db);
    const { res } = open();
    const body = (await res).body!;
    const reason = 'x'.repeat(40_000);
    for (let i = 0; i < Math.ceil((MAX_QUEUED_BYTES * 1.5) / reason.length); i++) {
      const a: RemoteAction = { id: `a${i}`, ca: 'H0', verb: 'store', amount: 0, reason, at: 1_000 + i };
      await db.addAction(a);
    }
    expect(listeners(db)).toBe(0);
    await expect(body.getReader().read()).rejects.toThrow(/not reading/);
    expect(openConnections()).toBe(0);
  });

  it('caps connections per identifiable client', async () => {
    vi.stubEnv('TRUST_PROXY', '1');
    setDbForTests(await fileDb());
    const mine = await Promise.all(Array.from({ length: MAX_PER_IP }, () => open({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' })));
    for (const c of mine) expect((await c.res).status).toBe(200);
    expect((await open({ 'x-forwarded-for': '7.7.7.7, 203.0.113.9' }).res).status).toBe(429);
    expect((await open({ 'x-forwarded-for': '203.0.113.10' }).res).status).toBe(200);
    mine[0].ac.abort();
    expect((await open({ 'x-forwarded-for': '203.0.113.9' }).res).status).toBe(200);
  });

  it('sends image URLs, mapped once per event, for a store that emits data URLs', async () => {
    const db = new MemDb();
    setDbForTests(db);
    const a = open();
    const b = open();
    const ra = (await a.res).body!.getReader();
    const rb = (await b.res).body!.getReader();
    const dec = new TextDecoder();
    await ra.read();
    await rb.read(); // retry / connected
    await db.upsertHive(hive('M1', 0, 1));
    const ea = dec.decode((await ra.read()).value);
    const eb = dec.decode((await rb.read()).value);
    expect(ea).toBe(eb);
    expect(ea).not.toContain('data:image');
    expect(JSON.parse(ea.split('data: ')[1]).image).toMatch(/^\/api\/hives\/M1\/image\?v=/);
  });
});

describe('#23 Supabase store without an anon key', () => {
  it('config says sse and /api/stream serves SSE from polling the database', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://proj.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    const { publicConfig } = await import('@/lib/server/config');
    const dbMod = await import('@/lib/server/db');
    const route = await import('@/app/api/stream/route');
    const hub = await import('@/app/api/_lib/stream-hub');

    let hives = [hive('S1', 0, 1, '/api/hives/S1/image?v=abc')];
    let actions: RemoteAction[] = [{ id: 'old', ca: 'S1', verb: 'store', amount: 0, reason: 'r', at: 1 }];
    let reads = 0;
    const fake = {
      kind: 'supabase',
      listHives: async () => (reads++, hives),
      listActions: async () => actions,
      listHarvests: async () => [],
      subscribe: () => () => {},
    } as unknown as Db;
    dbMod.setDbForTests(fake);

    const cfg = publicConfig();
    const ac = new AbortController();
    const res = await route.GET(new Request('http://x/api/stream', { signal: ac.signal }));
    expect(cfg.realtime === 'sse' && res.status === 204).toBe(false);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = dec.decode((await reader.read()).value);
    expect(text).toContain('retry: 5000');
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1); // first round: learns the current state, sends nothing

    hives = [{ ...hives[0], honey: 2, updatedAt: 5_000 }, hive('S2', 1, 0, BIG)];
    actions = [{ id: 'new', ca: 'S2', verb: 'born', amount: 0, reason: 'founded', at: 2 }, ...actions];
    await vi.advanceTimersByTimeAsync(hub.POLL_MS);
    text = '';
    while (!text.includes('event: action')) text += dec.decode((await reader.read()).value);
    expect(text.match(/event: hive/g)).toHaveLength(2);
    expect(text).not.toContain('data:image'); // S2's data URL went out as the image route path
    expect(text).toContain('/api/hives/S2/image?v=');
    expect(text).toContain('"id":"new"');
    expect(text).not.toContain('"id":"old"');

    await vi.advanceTimersByTimeAsync(20_000);
    expect(dec.decode((await reader.read()).value)).toMatch(/^event: ping/);
    ac.abort();
    expect(hub.openConnections()).toBe(0);
    const before = reads;
    await vi.advanceTimersByTimeAsync(hub.POLL_MS * 3);
    expect(reads).toBe(before); // polling stops with the last connection
    vi.resetModules();
  });

  it('with an anon key browsers use Supabase Realtime: 204', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://proj.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
    const { publicConfig } = await import('@/lib/server/config');
    const dbMod = await import('@/lib/server/db');
    const route = await import('@/app/api/stream/route');
    dbMod.setDbForTests({ kind: 'supabase' } as unknown as Db);
    expect(publicConfig().realtime).toBe('supabase');
    expect((await route.GET(new Request('http://x/api/stream'))).status).toBe(204);
    vi.resetModules();
  });
});
