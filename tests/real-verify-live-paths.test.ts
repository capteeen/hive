/**
 * Verifier regressions for the "only real hives" track.
 *  - GET /api/hives/[ca] in live mode applies the same rule as the list (lib/shared/visibility.ts): a live
 *    hive's action aimed at a preview hive (a swarm into it) is not public, so the hive page never names a
 *    preview hive. Mock mode is unchanged.
 *  - SupabaseDb without migration 0002: live claims fall back to claim_cell, which preview hives still block,
 *    so the cells offered must count preview hives too. Before, a live database whose only hive was a
 *    preview one at the origin offered nothing else and every live launch failed with "No free cell".
 *  - scripts/check-live.mjs: a 403 / 407 / 5xx from the RPC or Helius without a JSON-RPC answer (a proxy or
 *    firewall on the owner's machine, or an outage) is a warning, not a "key rejected" failure; a 401 or a
 *    real JSON-RPC answer still fails. Nothing secret is printed either way.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LaunchMode, RemoteAction, RemoteHive } from '@/lib/shared/api';
import { config } from '@/lib/server/config';
import { setDbForTests } from '@/lib/server/db';
import { FileDb } from '@/lib/server/db-file';
import { SupabaseDb } from '@/lib/server/db-supabase';
import { claimLaunchCell } from '@/lib/server/cells';
import { GET as detailRoute } from '@/app/api/hives/[ca]/route';
import * as checkLive from '../scripts/check-live.mjs';

type Item = { name: string; status: 'ok' | 'fail' | 'warn'; detail: string; fix: string };
const cl = checkLive as unknown as { probe(env: Record<string, string>, f: typeof fetch): Promise<Item[]>; render(items: Item[]): string };

const T = Date.UTC(2026, 9, 7, 6, 0, 0);
const hive = (ca: string, status: 'mock' | 'live', q: number): RemoteHive => ({
  ca,
  name: `Hive ${ca}`,
  ticker: 'HV',
  image: 'https://ipfs.io/ipfs/bafy',
  cell: { q, r: 0 },
  queenWallet: `queen-${ca}`,
  ownerWallet: `owner-${ca}`,
  devBuy: 0,
  status,
  honey: 1,
  bees: 2,
  feesTotal: 0,
  royalJelly: 0,
  state: 'working',
  createdAt: T,
  updatedAt: T,
});
const action = (id: string, ca: string, over: Partial<RemoteAction> = {}): RemoteAction => ({ id, ca, verb: 'store', amount: 0.1, reason: id, txSig: `sig-${id}`, at: T + 1, ...over });

describe('GET /api/hives/[ca]: live mode never names a preview hive', () => {
  let mode: LaunchMode;
  let dir: string;

  beforeEach(async () => {
    mode = config.launchMode;
    dir = await mkdtemp(path.join(os.tmpdir(), 'real-verify-detail-'));
    const db = new FileDb(dir, { isolated: true });
    setDbForTests(db);
    await db.upsertHive(hive('LIVEA', 'live', 1));
    await db.upsertHive(hive('LIVEB', 'live', 2));
    await db.upsertHive(hive('MOCKA', 'mock', 3));
    await db.addAction(action('own', 'LIVEA'));
    await db.addAction(action('swarm-live', 'LIVEA', { verb: 'swarm', targetCa: 'LIVEB' }));
    await db.addAction(action('swarm-mock', 'LIVEA', { verb: 'swarm', targetCa: 'MOCKA' }));
    await db.addAction(action('swarm-gone', 'LIVEA', { verb: 'swarm', targetCa: 'NOSUCHHIVE' }));
    await db.addAction(action('dry', 'LIVEA', { verb: 'seal', dryRun: true, txSig: undefined }));
  });

  afterEach(async () => {
    config.launchMode = mode;
    setDbForTests(null);
    await rm(dir, { recursive: true, force: true });
  });

  const detail = async (ca: string) => {
    const res = await detailRoute(new Request(`http://localhost/api/hives/${ca}`), { params: { ca } });
    return { status: res.status, body: (await res.json()) as { actions?: RemoteAction[] } };
  };
  const ids = (xs: RemoteAction[] = []) => xs.map((a) => a.id).sort();

  it('live mode: only real actions whose target is live', async () => {
    config.launchMode = 'live';
    const r = await detail('LIVEA');
    expect(r.status).toBe(200);
    expect(ids(r.body.actions)).toEqual(['own', 'swarm-live']);
    expect(JSON.stringify(r.body)).not.toContain('MOCKA');
  });

  it('mock mode: every stored action is shown, as before', async () => {
    config.launchMode = 'mock';
    expect(ids((await detail('LIVEA')).body.actions)).toEqual(['dry', 'own', 'swarm-gone', 'swarm-live', 'swarm-mock']);
  });
});

describe('scripts/check-live.mjs on a blocked network', () => {
  const env = {
    SOLANA_RPC_URL: 'https://rpc.example.test/?api-key=RPCKEYSECRET-0001',
    HELIUS_API_KEY: '0c1f3b7e-5a55-4c8e-9d44-6b1e2f3a4b5c',
  };
  const answering = (status: number, body = '') => (async () => new Response(body, { status })) as unknown as typeof fetch;
  const of = (items: Item[], name: string) => items.find((i) => i.name === name);

  it('a proxy / firewall answer (403, 407, 5xx) is a warning, not a rejected key', async () => {
    for (const s of [403, 407, 502]) {
      const items = await cl.probe(env, answering(s, '<html>blocked</html>'));
      expect(of(items, 'Solana RPC')?.status, `RPC ${s}`).toBe('warn');
      expect(of(items, 'Helius key')?.status, `Helius ${s}`).toBe('warn');
      expect(items.some((i) => i.status === 'fail')).toBe(false);
      const text = cl.render(items);
      expect(text).not.toContain('RPCKEYSECRET');
      expect(text).not.toContain(env.HELIUS_API_KEY);
    }
  });

  it('a 401, or a JSON-RPC answer that is not healthy, still fails', async () => {
    const items = await cl.probe(env, answering(401));
    expect(of(items, 'Solana RPC')?.status).toBe('fail');
    expect(of(items, 'Helius key')).toMatchObject({ status: 'fail', detail: 'rejected' });
    const sick = await cl.probe(env, answering(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'behind' })));
    expect(of(sick, 'Solana RPC')?.status).toBe('fail');
    expect(of(sick, 'Helius key')?.status).toBe('fail');
  });
});

describe('SupabaseDb without 0002: live launches still find a cell', () => {
  it('a preview hive on the origin (claim_cell refuses it) does not leave a live launch without a cell', async () => {
    const demo = config.demoHives;
    config.demoHives = false;
    const claimed: string[] = [];
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const query = decodeURIComponent(url.search);
      if (url.pathname === '/rest/v1/rpc/claim_live_cell') return json({ code: 'PGRST202', message: 'Could not find the function' }, 404);
      if (url.pathname === '/rest/v1/rpc/claim_cell') {
        const { q, r } = JSON.parse(String(init?.body)) as { q: number; r: number };
        claimed.push(`${q},${r}`);
        return json(!(q === 0 && r === 0)); // 0001's claim_cell: the preview hive holds the origin
      }
      // the only hive is a preview one on the origin
      if (url.pathname === '/rest/v1/hives') return json(query.includes('status=neq.mock') ? [] : [{ cell_q: 0, cell_r: 0 }]);
      return json([]);
    }) as typeof fetch;
    try {
      const db = new SupabaseDb('https://proj.supabase.co', 'service-key', { fetch: f });
      const got = await claimLaunchCell(db, null, 'live-launch', Date.now() + 60_000, Date.now(), { liveOnly: true });
      expect(got.cell).not.toEqual({ q: 0, r: 0 });
      expect(Math.max(Math.abs(got.cell.q), Math.abs(got.cell.r), Math.abs(got.cell.q + got.cell.r))).toBe(1); // next to the origin
      expect(claimed[0]).toBe('0,0');
    } finally {
      config.demoHives = demo;
    }
  });
});
