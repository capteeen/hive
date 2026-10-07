/**
 * Go-live setup checks:
 *   - GET /api/health: public booleans / counts / timestamps only (never a key, a URL or a wallet secret),
 *     schema / realtime / preview-data report from hive_schema_info (0002) with a fallback for 0001-only
 *     databases, rate limited per client, route file exports only handlers and config;
 *   - the engine records when each job last ran, and in live mode ignores preview hives;
 *   - the hourly cron's JSON shows the admin what a dry run planned (it is hidden from the public);
 *   - liveModeProblems() rejects a QUEEN_KEY_SECRET that is not 32 bytes;
 *   - hive metadata / OG data: no simulated hive unless demo hives are on;
 *   - scripts/check-live.mjs: env parsing, shape checks (hub key matches HUB_WALLET, ...), probes, and
 *     output that never contains a secret.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { DEFAULT_RULES } from '@/lib/queen';
import type { RemoteHive } from '@/lib/shared/api';
import { config, liveModeProblems } from '@/lib/server/config';
import { setChainForTests } from '@/lib/server/chain';
import { setDbForTests } from '@/lib/server/db';
import { ENGINE_META, runHourly, runRefresh } from '@/lib/server/engine';
import { healthReport, resetHealthCache, type HealthReport } from '@/lib/server/health';
import { hiveSummary } from '@/lib/server/hive-summary';
import { newKeypair } from '@/lib/server/keys';
import { resetRateLimits } from '@/lib/server/ratelimit';
import * as healthRoute from '@/app/api/health/route';
import { GET as hourlyRoute } from '@/app/api/cron/hourly/route';
import { EngineMemDb, ScriptChain, walletAddress } from './engine-fakes';
import * as checkLive from '../scripts/check-live.mjs';

type Item = { name: string; status: 'ok' | 'fail' | 'warn'; detail: string; fix: string };
const cl = checkLive as unknown as {
  parseEnv(t: string): Record<string, string>;
  checkEnv(env: Record<string, string>): Item[];
  probe(env: Record<string, string>, f: typeof fetch): Promise<Item[]>;
  pubkeyOfSecret(s: string): string | null;
  queenKeyBytes(s: string): number;
  render(items: Item[]): string;
};

const saved = structuredClone({ ...config, supabase: { ...config.supabase } });
const SECRETS = {
  service: 'eyJhbGciOiJIUzI1NiJ9.c2VydmljZS1yb2xlLXNlY3JldA.SERVICEsignatureSECRET',
  anon: 'eyJhbGciOiJIUzI1NiJ9.YW5vbi1wdWJsaWM.ANONsignature',
  queen: randomBytes(32).toString('base64'),
  cron: 'cron-' + randomBytes(24).toString('hex'),
  helius: '11111111-2222-4333-8444-555555555555',
  rpc: 'https://rpc.example.test/?api-key=RPCKEYSECRET',
  url: 'https://projref.supabase.co',
};

beforeEach(() => {
  resetHealthCache();
  resetRateLimits();
});
afterEach(() => {
  Object.assign(config, structuredClone(saved));
  setDbForTests(null);
  setChainForTests(null);
  vi.unstubAllEnvs();
});

function goLive(hub?: Keypair) {
  config.launchMode = 'live';
  config.supabase = { url: SECRETS.url, anonKey: SECRETS.anon, serviceKey: SECRETS.service };
  config.queenKeySecret = SECRETS.queen;
  config.cronSecret = SECRETS.cron;
  config.heliusApiKey = SECRETS.helius;
  config.rpcUrl = SECRETS.rpc;
  vi.stubEnv('SOLANA_RPC_URL', SECRETS.rpc);
  if (hub) {
    config.hubSecret = bs58.encode(hub.secretKey);
    config.hubWallet = hub.publicKey.toBase58();
    config.hubTokenMint = walletAddress();
  }
}

/** A fake network: Supabase PostgREST (service and anon keys) and a Solana RPC. */
function fakeNet(opts: { schemaInfo?: 'ok' | 'missing'; down?: boolean; missingTables?: string[] } = {}) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (opts.down) throw new TypeError('fetch failed');
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.origin === new URL(SECRETS.rpc).origin) return json({ jsonrpc: '2.0', id: 1, result: 'ok' });
    if (url.pathname === '/rest/v1/rpc/hive_schema_info') {
      if (opts.schemaInfo === 'missing') return json({ code: 'PGRST202', message: 'Could not find the function' }, 404);
      return json({
        version: 2,
        tables: ['actions', 'cell_claims', 'harvests', 'hives', 'launches', 'locks', 'meta', 'prices', 'secrets'],
        functions: ['claim_cell', 'claim_live_cell', 'hive_schema_info', 'try_lock'],
        rls: true,
        realtime: { publication: true, allTables: false, tables: ['actions', 'harvests', 'hives'] },
        preview: { hives: 3, launches: 2, dryRunActions: 5, dryRunHarvests: 1 },
        live: { hives: 0, launches: 0 },
      });
    }
    const t = url.pathname.replace('/rest/v1/', '');
    if (opts.missingTables?.includes(t)) return json({ code: '42P01', message: `relation "public.${t}" does not exist` }, 404);
    return new Response(init?.method === 'HEAD' ? null : '[]', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' } });
  }) as typeof fetch;
  return { f, calls };
}

const noSecrets = (text: string) => {
  for (const v of [SECRETS.service, SECRETS.anon, SECRETS.queen, SECRETS.cron, SECRETS.helius, 'RPCKEYSECRET', 'rpc.example.test', 'projref', config.hubSecret ?? 'none-set']) expect(text).not.toContain(v);
};

describe('GET /api/health', () => {
  it('mock mode without anything configured: ok, file store, nothing secret', async () => {
    const db = new EngineMemDb();
    setDbForTests(db);
    config.launchMode = 'mock';
    vi.stubEnv('SOLANA_RPC_URL', '');
    const net = fakeNet();
    const r = await healthReport({ fetch: net.f });
    expect(r).toMatchObject({ ok: true, launchMode: 'mock', store: 'file', supabase: { configured: false, reachable: null }, queenKey: { set: false }, rpc: { set: false, reachable: null }, problems: [] });
    expect(net.calls).toEqual([]); // nothing configured, nothing probed
  });

  it('live mode, fully set up: reports the schema, realtime, preview data and engine runs, and no secrets', async () => {
    const db = new EngineMemDb();
    setDbForTests(db);
    await db.setMeta(ENGINE_META.lastRun('live', 'hourly'), JSON.stringify({ at: 1234, dryRun: true }));
    await db.setMeta(ENGINE_META.lastRun('live', 'refresh'), JSON.stringify({ at: 5678 }));
    goLive(Keypair.generate());
    const net = fakeNet();
    const r = await healthReport({ fetch: net.f });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.supabase).toMatchObject({ configured: true, anonKey: true, reachable: true, anonRead: true, schema: { present: true, missingTables: [], version: 2, realtime: true } });
    expect(r.supabase.previewData).toEqual({ hives: 3, launches: 2, dryRunActions: 5, dryRunHarvests: 1 });
    expect(r).toMatchObject({ queenKey: { set: true, valid: true }, rpc: { set: true, reachable: true }, heliusKey: true, cronSecret: true, hub: { wallet: true, secret: true, mint: true, ready: true } });
    expect(r.engine).toEqual({ lastHourly: 1234, lastHarvest: null, lastRefresh: 5678 });
    expect(r.warnings.join(' ')).toContain('cleanup-fake-data.sql');
    noSecrets(JSON.stringify(r));
  });

  it('a database with only 0001: tables probed one by one, 0002 asked for', async () => {
    setDbForTests(new EngineMemDb());
    goLive();
    const r = await healthReport({ fetch: fakeNet({ schemaInfo: 'missing', missingTables: ['locks'] }).f });
    expect(r.supabase).toMatchObject({ reachable: true, schema: { present: false, missingTables: ['locks'], version: null, realtime: null }, previewData: null });
    expect(r.warnings.join(' ')).toContain('0001_hive.sql');
  });

  it('nothing answers: unreachable, still no secrets; a bad QUEEN_KEY_SECRET blocks live mode', async () => {
    setDbForTests(new EngineMemDb());
    goLive();
    config.queenKeySecret = Buffer.from('too short').toString('base64');
    const r = await healthReport({ fetch: fakeNet({ down: true }).f });
    expect(r.supabase.reachable).toBe(false);
    expect(r.rpc.reachable).toBe(false);
    expect(r.queenKey).toEqual({ set: true, valid: false });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/QUEEN_KEY_SECRET must decode to exactly 32 bytes/);
    noSecrets(JSON.stringify(r));
  });

  it('the route: rate limited per client address, and exports only route handlers and config', async () => {
    setDbForTests(new EngineMemDb());
    config.launchMode = 'mock';
    vi.stubEnv('VERCEL', '1');
    const req = () => new Request('http://localhost/api/health', { headers: { 'x-vercel-forwarded-for': '203.0.113.9' } });
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await healthRoute.GET(req())).status;
    expect(last).toBe(429);
    expect(Object.keys(healthRoute).sort()).toEqual(['GET', 'dynamic', 'runtime']);
  });
});

describe('liveModeProblems', () => {
  it('accepts a 32-byte key in base64 or hex, and rejects other lengths', () => {
    goLive();
    expect(liveModeProblems()).toEqual([]);
    config.queenKeySecret = randomBytes(32).toString('hex');
    expect(liveModeProblems()).toEqual([]);
    config.queenKeySecret = randomBytes(16).toString('base64');
    expect(liveModeProblems().join(' ')).toContain('32 bytes');
  });
});

describe('engine', () => {
  const T0 = 500_000 * 3_600_000;
  async function hiveOf(db: EngineMemDb, chain: ScriptChain, status: 'live' | 'mock', q: number) {
    const { keypair, enc } = newKeypair();
    const queenWallet = keypair.publicKey.toBase58();
    await db.putSecret(queenWallet, enc);
    const h: RemoteHive = { ca: walletAddress(), name: `H${q}`, ticker: `H${q}`, image: '', cell: { q, r: 0 }, queenWallet, ownerWallet: walletAddress(), rules: DEFAULT_RULES, devBuy: 0, status, honey: 0, bees: 1, feesTotal: 0, royalJelly: 0, state: 'working', lastFeeAt: T0 - 3_600_000, createdAt: T0 - 7_200_000, updatedAt: T0 - 7_200_000 };
    await db.upsertHive(h);
    chain.setSol(queenWallet, 1);
    chain.fees.set(queenWallet, 1e8);
    chain.prices.set(h.ca, 1e-6);
    return h;
  }

  it('live mode never touches a preview hive found in the database, and records when each job ran', async () => {
    config.queenKeySecret = SECRETS.queen;
    const db = new EngineMemDb();
    const chain = new ScriptChain('live');
    const real = await hiveOf(db, chain, 'live', 0);
    const fake = await hiveOf(db, chain, 'mock', 1);
    const hub = { keypair: null, wallet: null, mint: null };
    const s = await runHourly({ db, chain, mode: 'live', hub, now: T0, hourMs: 3_600_000, settleMs: 0, reserveSol: 0.05 });
    expect(s.hives.map((h) => h.ca)).toEqual([real.ca]);
    const r = await runRefresh({ db, chain, mode: 'live', hub, now: T0 + 60_000, hourMs: 3_600_000, settleMs: 0, reserveSol: 0.05 });
    expect(r.checked).toBe(1);
    expect(chain.fees.get(fake.queenWallet)).toBe(1e8); // never claimed
    expect(db.actions.some((a) => a.ca === fake.ca)).toBe(false);
    expect(JSON.parse((await db.getMeta(ENGINE_META.lastRun('live', 'hourly')))!)).toMatchObject({ dryRun: false });
    expect(JSON.parse((await db.getMeta(ENGINE_META.lastRun('live', 'refresh')))!).at).toEqual(expect.any(Number));
  });

  it('the hourly cron answers a dry run with the planned feed the public does not see', async () => {
    config.launchMode = 'mock';
    config.queenKeySecret = SECRETS.queen;
    config.cronSecret = undefined;
    const db = new EngineMemDb();
    const chain = new ScriptChain('mock');
    setDbForTests(db);
    setChainForTests(chain);
    const now = Date.now();
    const { keypair, enc } = newKeypair();
    await db.putSecret(keypair.publicKey.toBase58(), enc);
    const h: RemoteHive = { ca: walletAddress(), name: 'Dry', ticker: 'DRY', image: '', cell: { q: 0, r: 0 }, queenWallet: keypair.publicKey.toBase58(), ownerWallet: walletAddress(), rules: DEFAULT_RULES, devBuy: 0, status: 'mock', honey: 0, bees: 1, feesTotal: 0, royalJelly: 0, state: 'working', lastFeeAt: now - 30_000, createdAt: now - 600_000, updatedAt: now - 600_000 };
    await db.upsertHive(h);
    chain.setSol(h.queenWallet, 1);
    chain.fees.set(h.queenWallet, 1e8);
    chain.prices.set(h.ca, 1e-6);
    const res = await hourlyRoute(new Request('http://localhost/api/cron/hourly?dryRun=1'));
    const body = (await res.json()) as { dryRun: boolean; dryRunFeed: { note: string; actions: { ca: string; dryRun: boolean; reason: string }[] } };
    expect(body.dryRun).toBe(true);
    expect(body.dryRunFeed.actions.length).toBeGreaterThan(0);
    expect(body.dryRunFeed.actions.every((a) => a.dryRun && a.ca === h.ca && a.reason.length > 0)).toBe(true);
    expect(body.dryRunFeed.note).toMatch(/hidden from the public/);
  });
});

describe('hive metadata (title, description, OG image)', () => {
  it('never describes a simulated hive unless demo hives are on, and labels preview hives', async () => {
    const db = new EngineMemDb();
    setDbForTests(db);
    const { createWorld, SEED } = await import('@/lib/sim');
    const demoCa = createWorld(SEED).order[0];
    config.demoHives = false;
    expect(await hiveSummary(demoCa)).toBeNull();
    config.demoHives = true;
    expect(await hiveSummary(demoCa)).toMatchObject({ source: 'demo', biggest: true });
    const h: RemoteHive = { ca: 'PreviewCa1', name: 'P', ticker: 'P', image: '', cell: { q: 9, r: 9 }, queenWallet: 'q', ownerWallet: 'o', devBuy: 0, status: 'mock', honey: 1, bees: 1, feesTotal: 0, royalJelly: 0, state: 'working', createdAt: 1, updatedAt: 1 };
    await db.upsertHive(h);
    config.launchMode = 'mock';
    expect(await hiveSummary('PreviewCa1')).toMatchObject({ source: 'preview' });
    config.launchMode = 'live';
    config.demoHives = false;
    expect(await hiveSummary('PreviewCa1')).toBeNull();
  });
});

describe('scripts/check-live.mjs', () => {
  const hub = Keypair.generate();
  const fullEnv = () => ({
    LAUNCH_MODE: 'live',
    NEXT_PUBLIC_SUPABASE_URL: SECRETS.url,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: SECRETS.anon,
    SUPABASE_SERVICE_ROLE_KEY: SECRETS.service,
    QUEEN_KEY_SECRET: SECRETS.queen,
    CRON_SECRET: SECRETS.cron,
    SOLANA_RPC_URL: SECRETS.rpc,
    NEXT_PUBLIC_RPC: 'https://public-rpc.example.test',
    HELIUS_API_KEY: SECRETS.helius,
    NEXT_PUBLIC_SITE_URL: 'https://hive.example',
    ENGINE_DRY_RUN: '0',
    HUB_WALLET: hub.publicKey.toBase58(),
    HUB_WALLET_SECRET: bs58.encode(hub.secretKey),
    HUB_TOKEN_MINT: walletAddress(),
  });
  const status = (items: Item[], name: string) => items.find((i) => i.name === name)?.status;

  it('parses .env files (export, quotes, comments)', () => {
    expect(cl.parseEnv('# c\nexport A=1\nB = "two # not a comment"\nC=three # comment\nD=\'4\'\nbad line\n')).toEqual({ A: '1', B: 'two # not a comment', C: 'three', D: '4' });
  });

  it('a complete live env is all green; shape errors are caught with a fix', () => {
    expect(cl.checkEnv(fullEnv()).filter((i) => i.status !== 'ok')).toEqual([]);
    const bad = { ...fullEnv(), QUEEN_KEY_SECRET: randomBytes(31).toString('base64'), HUB_WALLET: Keypair.generate().publicKey.toBase58(), HUB_TOKEN_MINT: 'not-a-mint', NEXT_PUBLIC_DEMO_HIVES: '1', CRON_SECRET: 'short', LAUNCH_MODE: 'mock' };
    const items = cl.checkEnv(bad);
    expect(status(items, 'QUEEN_KEY_SECRET')).toBe('fail');
    expect(status(items, 'HUB_WALLET_SECRET')).toBe('fail'); // its public key is not HUB_WALLET
    expect(status(items, 'HUB_TOKEN_MINT')).toBe('fail');
    expect(status(items, 'NEXT_PUBLIC_DEMO_HIVES')).toBe('fail');
    expect(status(items, 'CRON_SECRET')).toBe('warn');
    expect(status(items, 'LAUNCH_MODE')).toBe('fail');
    expect(items.filter((i) => i.status !== 'ok').every((i) => i.fix.length > 0)).toBe(true);
    const out = cl.render(items) + cl.render(cl.checkEnv(fullEnv()));
    for (const v of Object.values(bad)) if (v.length > 12 && !/^https:\/\/hive\.example|^live|^mock/.test(v)) expect(out).not.toContain(v);
    expect(out).not.toContain(SECRETS.queen);
    expect(out).not.toContain('RPCKEYSECRET');
  });

  it('derives the hub public key from its secret (base58 or JSON bytes) and rejects a tampered one', () => {
    expect(cl.pubkeyOfSecret(bs58.encode(hub.secretKey))).toBe(hub.publicKey.toBase58());
    expect(cl.pubkeyOfSecret(JSON.stringify([...hub.secretKey]))).toBe(hub.publicKey.toBase58());
    const tampered = Uint8Array.from(hub.secretKey);
    tampered[40] ^= 1;
    expect(cl.pubkeyOfSecret(bs58.encode(tampered))).toBeNull();
    expect(cl.queenKeyBytes(randomBytes(32).toString('hex'))).toBe(32);
  });

  it('probes Supabase (tables, functions, 0002, realtime, anon read), the RPC and Helius without printing secrets', async () => {
    const paths = Object.fromEntries(['hives', 'actions', 'harvests', 'prices', 'launches', 'cell_claims', 'secrets', 'meta', 'locks', 'rpc/claim_cell', 'rpc/try_lock', 'rpc/claim_live_cell', 'rpc/hive_schema_info'].map((p) => [`/${p}`, {}]));
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname === '/rest/v1/') return json({ paths });
      if (url.pathname === '/rest/v1/rpc/hive_schema_info') return json({ realtime: { tables: ['hives', 'actions'] }, preview: { hives: 0, launches: 0, dryRunActions: 0, dryRunHarvests: 0 } });
      if (url.pathname === '/rest/v1/hives') return json([]);
      if (init?.method === 'POST' && init.body && String(init.body).includes('getSlot')) return json({ result: 123 });
      if (init?.method === 'POST') return json({ result: 'ok' });
      return new Response('', { status: 405 });
    }) as typeof fetch;
    const items = await cl.probe(fullEnv(), f);
    expect(status(items, 'Supabase tables (0001)')).toBe('ok');
    expect(status(items, 'Supabase functions (0001)')).toBe('ok');
    expect(status(items, 'Supabase migration 0002')).toBe('ok');
    expect(status(items, 'Supabase Realtime')).toBe('fail'); // harvests is not published
    expect(status(items, 'Supabase (anon key reads hives)')).toBe('ok');
    expect(items.find((i) => i.name === 'Solana RPC')).toMatchObject({ status: 'ok', detail: 'healthy, slot 123' });
    expect(status(items, 'Helius key')).toBe('ok');
    expect(status(items, 'PumpPortal')).toBe('ok');
    const down = await cl.probe(fullEnv(), (async () => {
      throw new TypeError('fetch failed https://rpc.example.test/?api-key=RPCKEYSECRET');
    }) as typeof fetch);
    expect(down.every((i) => i.status === 'warn')).toBe(true);
    const text = cl.render([...items, ...down]);
    for (const v of [SECRETS.service, SECRETS.anon, SECRETS.helius, 'RPCKEYSECRET', SECRETS.cron]) expect(text).not.toContain(v);
  });
});

export type { HealthReport };
