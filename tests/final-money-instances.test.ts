/**
 * #14: mock mode with Supabase (several server instances sharing one database, no QUEEN_KEY_SECRET):
 * every instance derives the same development key, so a launch prepared on one instance confirms on
 * another; and a launch whose keys cannot be read fails (cell released) instead of sticking in 'metadata'.
 * #15: the mock ledger lives in memory; after a restart (or on another instance) the engine takes the
 * persisted hives over instead of overwriting their honey with 0 and their price and bees with made-up values.
 *
 * Each "instance" is a fresh module graph (vi.resetModules) with fresh globalThis registries.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_LOOK, DEFAULT_RULES } from '@/lib/queen';
import { MemDb } from './fakes/memdb';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const ENV_KEYS = ['QUEEN_KEY_SECRET', 'LAUNCH_MODE', 'VERCEL', 'DATA_DIR', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_DEMO_HIVES'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];
const g = globalThis as Record<string, unknown>;
const savedGlobals = { dev: g.__hiveDevKey, chain: g.__hiveMockChainV1, fileDb: g.__hiveFileDbV1 };

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  g.__hiveDevKey = savedGlobals.dev;
  g.__hiveMockChainV1 = savedGlobals.chain;
  g.__hiveFileDbV1 = savedGlobals.fileDb;
  vi.resetModules();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const payload = () => ({
  owner: 'guest:abcdef12', name: 'Amber Comb', ticker: 'AMBER', description: 'd', motto: 'm', telegram: '', twitter: '',
  image: PNG, devBuy: 0, cell: null, look: DEFAULT_LOOK, rules: DEFAULT_RULES, temperament: { dip: 'Steady', swarm: 'Forager' }, issuedAt: Date.now(),
});

/** A new server process: fresh modules and registries, its own /tmp (DATA_DIR) unless one is given. */
async function boot(name: string, opts: { supabase?: boolean; dataDir?: string } = {}) {
  vi.resetModules();
  delete g.__hiveDevKey;
  delete g.__hiveMockChainV1;
  delete g.__hiveFileDbV1;
  delete process.env.QUEEN_KEY_SECRET;
  delete process.env.LAUNCH_MODE;
  process.env.NEXT_PUBLIC_DEMO_HIVES = '0';
  if (opts.supabase) {
    process.env.VERCEL = '1';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-shared-by-every-instance';
  } else {
    delete process.env.VERCEL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
  let dir = opts.dataDir;
  if (!dir) {
    dir = mkdtempSync(path.join(tmpdir(), `hive-final-money-${name}-`));
    dirs.push(dir);
  }
  process.env.DATA_DIR = dir;
  const launch = await import('@/lib/server/launch');
  const { MockChain } = await import('@/lib/server/chain-mock');
  const engine = await import('@/lib/server/engine');
  const keys = await import('@/lib/server/keys');
  const { getDb } = await import('@/lib/server/db');
  const { resetRateLimits } = await import('@/lib/server/ratelimit');
  resetRateLimits();
  return { launch, engine, keys, chain: new MockChain(), getDb, dir };
}

describe('#14 mock mode with Supabase and no QUEEN_KEY_SECRET', () => {
  it('a launch prepared on one instance confirms on another, where its keys decrypt', async () => {
    const db = new MemDb();
    const a = await boot('a', { supabase: true });
    const prep = await a.launch.prepareLaunch({ payload: payload() }, { db, chain: a.chain, mode: 'mock', ip: '1.1.1.1' });
    const b = await boot('b', { supabase: true });
    const st = await b.launch.confirmLaunch(prep.launchId, {}, { db, chain: b.chain, mode: 'mock', ip: '1.1.1.1' });
    expect(st.state).toBe('live'); // was: HTTP 500, stuck in 'metadata' with its cell claimed for good
    // the queen key written on A decrypts on B too (not a public-key stand-in)
    const enc = (await db.getSecret(prep.queenWallet))!;
    expect(b.keys.keypairFromEnc(enc).publicKey.toBase58()).toBe(prep.queenWallet);
  });

  it('the local file store keeps its own persisted random key', async () => {
    const a = await boot('c');
    const enc = a.keys.newKeypair().enc;
    const again = await boot('c2', { dataDir: a.dir }); // same data dir after a restart
    expect(() => again.keys.keypairFromEnc(enc)).not.toThrow();
    const other = await boot('d'); // another data dir: another key
    expect(() => other.keys.keypairFromEnc(enc)).toThrow();
  });

  it('a launch whose keys cannot be read fails after MAX_ATTEMPTS and frees its cell instead of sticking', async () => {
    const db = new MemDb();
    const a = await boot('e'); // file key of instance e
    const prep = await a.launch.prepareLaunch({ payload: payload() }, { db, chain: a.chain, mode: 'mock', ip: '1.1.1.1' });
    const b = await boot('f'); // another key: nothing from e can be decrypted
    let st = await b.launch.confirmLaunch(prep.launchId, {}, { db, chain: b.chain, mode: 'mock', ip: '1.1.1.1' });
    expect(st.state).toBe('metadata');
    expect(st.error).toMatch(/keys for this launch could not be read/);
    for (let i = 0; i < b.launch.MAX_ATTEMPTS && st.state === 'metadata'; i++) st = await b.launch.confirmLaunch(prep.launchId, {}, { db, chain: b.chain, mode: 'mock', ip: '1.1.1.1' });
    expect(st.state).toBe('failed');
    expect(db.claims.filter((c) => c.launchId === prep.launchId)).toEqual([]);
    // and the (simulated) refund goes through instead of a server error
    const refunded = await b.launch.refundLaunch(prep.launchId, {}, { db, chain: b.chain, mode: 'mock', ip: '1.1.1.1' });
    expect(refunded.state).toBe('refunded');
  });
});

describe('#15 mock ledger vs persisted hives across a restart', () => {
  it('a refresh and an hourly run after a restart keep honey, price and bees', async () => {
    const a = await boot('restart');
    const prep = await a.launch.prepareLaunch({ payload: payload() }, { mode: 'mock', ip: '1.1.1.1' });
    const st = await a.launch.confirmLaunch(prep.launchId, {}, { mode: 'mock', ip: '1.1.1.1' });
    expect(st.state).toBe('live');
    // a refresh in the same process settles honey to the engine's definition (SOL above the reserve)
    // and records a price: this is what every browser sees
    await a.engine.runRefresh();
    const dbA = await a.getDb();
    const hiveA = (await dbA.listHives())[0];
    const beforeRow = { honey: hiveA.honey, price: hiveA.price, bees: hiveA.bees };
    // make the persisted honey distinctive: a hive that has earned and stored fees
    await dbA.upsertHive({ ...hiveA, honey: 0.75, updatedAt: hiveA.updatedAt + 1 });

    const b = await boot('restart2', { dataDir: a.dir }); // process restart: empty mock ledger
    const r = await b.engine.runRefresh();
    expect(r.errors).toEqual([]);
    const dbB = await b.getDb();
    const after = (await dbB.listHives())[0];
    expect(after.honey).toBe(0.75); // was: 0
    expect(after.bees).toBe(beforeRow.bees); // was: a random 1..200
    expect(after.price).toBeCloseTo(beforeRow.price!, 15); // was: a made-up price

    const c = await boot('restart3', { dataDir: a.dir });
    const s = await c.engine.runHourly({ now: Date.now() + 61_000 });
    expect(s.hives.flatMap((h) => h.errors)).toEqual([]);
    const afterHour = (await (await c.getDb()).listHives())[0];
    expect(afterHour.honey).toBe(0.75);
  });
});
