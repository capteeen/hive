/**
 * The verifier's three residual gaps from the final review:
 * #18 a dry-run engine never delivered owed dev-buy tokens; #16 expired launches kept their image forever;
 * #3/#8 /api/hives was uncapped and hive text kept control characters.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';
import { LIMITS, launchMessage, type HivesResponse, type LaunchPayload, type RemoteHive } from '@/lib/shared/api';
import { DEFAULT_LOOK, DEFAULT_RULES } from '@/lib/queen';
import { config } from '@/lib/server/config';
import { MockChain } from '@/lib/server/chain-mock';
import { FileDb } from '@/lib/server/db-file';
import { MAX_ATTEMPTS, confirmLaunch, launchStatus, prepareLaunch, type LaunchCtx } from '@/lib/server/launch';
import { runHourly, type HubSetup } from '@/lib/server/engine';
import { resetRateLimits } from '@/lib/server/ratelimit';
import { MemDb } from '@/tests/fakes/memdb';
import { FakeChain, fakeSig } from '@/tests/fakes/fakechain';

const listDb = vi.hoisted(() => ({ hives: [] as unknown[] }));
vi.mock('@/lib/server/db', () => ({
  getDb: async () => ({ listHives: async () => listDb.hives, listActions: async () => [], listHarvests: async () => [] }),
}));

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const BIG = `data:image/webp;base64,${Buffer.alloc(LIMITS.imageBytes - (LIMITS.imageBytes % 3), 7).toString('base64')}`;
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
beforeEach(() => {
  resetRateLimits();
  config.demoHives = false;
});

it('a dry-run engine still delivers owed dev-buy tokens, exactly once', async () => {
  const clock = { now: T0 };
  const db = new MemDb(() => clock.now);
  const chain = new FakeChain('live');
  const ctx = (): LaunchCtx => ({ db, chain, mode: 'live', now: clock.now, ip: '10.0.0.1', problems: [] });
  const kp = nacl.sign.keyPair();
  const owner = bs58.encode(kp.publicKey);
  const p: LaunchPayload = { owner, name: 'Amber Comb', ticker: 'amber', image: PNG, devBuy: 2, cell: null, look: DEFAULT_LOOK, rules: DEFAULT_RULES, temperament: { dip: 'Steady', swarm: 'Forager' }, issuedAt: T0 };
  const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(launchMessage(p)), kp.secretKey));
  const prep = await prepareLaunch({ payload: p, signature: sig }, ctx());
  const rec = (await db.getLaunch(prep.launchId))!;
  chain.script.transferTokens = async () => { throw new Error('fetch failed'); };
  let st = await confirmLaunch(prep.launchId, { signature: fakeSig('P') }, ctx());
  for (let i = 0; i < MAX_ATTEMPTS && st.state !== 'live'; i++) st = await confirmLaunch(prep.launchId, {}, ctx());
  expect(st.state).toBe('live');
  delete chain.script.transferTokens; // RPC is back
  const hubKey = Keypair.generate();
  const hub: HubSetup = { keypair: hubKey, wallet: hubKey.publicKey.toBase58(), mint: Keypair.generate().publicKey.toBase58() };
  for (let h = 1; h <= 3; h++) await runHourly({ db, chain, mode: 'live', dryRun: true, hub, now: T0 + h * HOUR, hourMs: HOUR, settleMs: 0, reserveSol: 0.05 });
  const ownerBal = chain.tokens.get(`${owner}|${rec.mintPubkey}`) ?? 0n;
  expect(ownerBal).toBeGreaterThan(0n);
  expect(chain.tokens.get(`${prep.queenWallet}|${rec.mintPubkey}`) ?? 0n).toBe(0n);
});

it('drops the payload image of launches that expire unpaid', async () => {
  const db = new FileDb(mkdtempSync(path.join(tmpdir(), 'exp-')), { isolated: true });
  const chain = new MockChain({ seed: 1 });
  let now = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const prep = await prepareLaunch({ payload: { owner: `guest:expire${i}xx`, name: `Junk ${i}`, ticker: `JNK${i}`, image: BIG, devBuy: 0, cell: null, look: DEFAULT_LOOK, rules: DEFAULT_RULES, temperament: { dip: 'Steady', swarm: 'Forager' }, issuedAt: now } }, { db, chain, mode: 'mock', ip: 'unknown', now });
    ids.push(prep.launchId);
  }
  now += 24 * HOUR;
  for (const id of ids) {
    const st = await launchStatus(id, { db, chain, mode: 'mock', ip: `x${id}`, now });
    expect(st.state).toBe('expired');
    expect((await db.getLaunch(id))!.payload.image).toBe('');
  }
});

it('strips control, zero-width and bidi characters from hive text, and rejects a name left too short', async () => {
  const db = new MemDb(() => T0);
  const chain = new FakeChain('mock');
  const ctx: LaunchCtx = { db, chain, mode: 'mock', now: T0, ip: '10.0.0.2' };
  const base = { owner: 'guest:cleaner01', ticker: 'CLN', image: PNG, devBuy: 0, cell: null, look: DEFAULT_LOOK, rules: DEFAULT_RULES, temperament: { dip: 'Steady', swarm: 'Forager' }, issuedAt: T0 };
  const prep = await prepareLaunch({ payload: { ...base, name: 'Clean\u0000‮ Comb​', description: 'line one\nline\u0007 two', motto: 'buzz\u0085' } }, ctx);
  const p = (await db.getLaunch(prep.launchId))!.payload;
  expect(p.name).toBe('Clean Comb');
  expect(p.description).toBe('line one\nline two');
  expect(p.motto).toBe('buzz');
  await expect(prepareLaunch({ payload: { ...base, owner: 'guest:cleaner02', name: 'A​​​' } }, ctx)).rejects.toThrow(/Name must be/);
});

it('caps /api/hives, dropping abandoned then oldest hives first', async () => {
  const mk = (i: number, state: RemoteHive['state']): RemoteHive => ({
    ca: `ca${i}`, name: `H${i}`, ticker: 'HV', image: '', cell: { q: i, r: 0 }, queenWallet: `q${i}`, ownerWallet: 'guest:owner01',
    devBuy: 0, status: 'mock', honey: 0, bees: 1, feesTotal: 0, royalJelly: 0, state, createdAt: i, updatedAt: i,
  });
  listDb.hives = Array.from({ length: 1200 }, (_, i) => mk(i, i % 4 === 0 ? 'abandoned' : 'working'));
  const { GET } = await import('@/app/api/hives/route');
  const res = await GET(new Request('http://localhost/api/hives'));
  const body = (await res.json()) as HivesResponse;
  expect(body.hives).toHaveLength(1000);
  expect(body.omitted).toBe(200);
  expect(body.hives.filter((h) => h.state === 'abandoned')).toHaveLength(100); // all 900 working kept, then the newest abandoned
  expect(body.hives.some((h) => h.ca === 'ca1199')).toBe(true);
  expect(body.hives.some((h) => h.ca === 'ca0')).toBe(false);
  listDb.hives = [mk(1, 'working')];
  expect(((await (await GET(new Request('http://localhost/api/hives'))).json()) as HivesResponse).omitted).toBeUndefined();
});
