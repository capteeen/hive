/**
 * #18: dev-buy tokens that could not be sent before the launch went live stay owed. The queen engine
 * delivers them in her next hour (or a later confirm does): exactly the dev-buy amount (never tokens the
 * engine bought for a seal), never while the engine is working on her, and never a second time.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';
import { launchMessage, type LaunchPayload } from '@/lib/shared/api';
import { DEFAULT_LOOK, DEFAULT_RULES } from '@/lib/queen';
import { config } from '@/lib/server/config';
import { TxError } from '@/lib/server/chain';
import { MAX_ATTEMPTS, confirmLaunch, prepareLaunch, type LaunchCtx } from '@/lib/server/launch';
import { ENGINE_META, UNSURE_SEND_SETTLE_MS, runHourly, type HubSetup } from '@/lib/server/engine';
import { resetRateLimits } from '@/lib/server/ratelimit';
import { MemDb } from './fakes/memdb';
import { FakeChain, fakeSig } from './fakes/fakechain';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

beforeEach(() => {
  resetRateLimits();
  config.demoHives = false;
});

/** A live launch with a 2 SOL dev buy that went live after MAX_ATTEMPTS failed token transfers. */
async function liveWithStrandedTokens(failure: () => Error = () => new Error('fetch failed')) {
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
  chain.script.transferTokens = async () => {
    throw failure();
  };
  let st = await confirmLaunch(prep.launchId, { signature: fakeSig('P') }, ctx());
  for (let i = 0; i < MAX_ATTEMPTS && st.state !== 'live'; i++) st = await confirmLaunch(prep.launchId, {}, ctx());
  expect(st.state).toBe('live');
  expect(st.error).toMatch(/still in the queen wallet/);
  const queenKey = `${prep.queenWallet}|${rec.mintPubkey}`;
  const ownerKey = `${owner}|${rec.mintPubkey}`;
  const stuck = chain.tokens.get(queenKey)!;
  expect(stuck).toBeGreaterThan(0n);
  const hubKey = Keypair.generate();
  const hub: HubSetup = { keypair: hubKey, wallet: hubKey.publicKey.toBase58(), mint: Keypair.generate().publicKey.toBase58() };
  const hourly = (now: number) => runHourly({ db, chain, mode: 'live', hub, now, hourMs: HOUR, settleMs: 0, reserveSol: 0.05 });
  return { clock, db, chain, ctx, prep, rec, owner, queenKey, ownerKey, stuck, hourly };
}

describe('#18 dev-buy tokens left in the queen wallet when the launch went live', () => {
  it('the queen engine delivers them in her next hour, once, and notes it on the launch', async () => {
    const t = await liveWithStrandedTokens();
    delete t.chain.script.transferTokens; // the RPC is back
    const s = await t.hourly(T0 + HOUR);
    const res = s.hives.find((h) => h.ca === t.rec.mintPubkey)!;
    expect(res.txs.devTokens).toBeTruthy();
    expect(t.chain.tokens.get(t.ownerKey)).toBe(t.stuck); // was: 0n forever
    expect(t.chain.tokens.get(t.queenKey)).toBe(0n);
    const l = (await t.db.getLaunch(t.prep.launchId))!;
    expect(l.txs.devTransfer).toBe(res.txs.devTokens);
    expect(l.error).toBeFalsy();

    const before = t.chain.count('transferTokens');
    await t.hourly(T0 + 2 * HOUR);
    for (let i = 0; i < 3; i++) await confirmLaunch(t.prep.launchId, {}, t.ctx());
    expect(t.chain.count('transferTokens')).toBe(before);
    expect(t.chain.tokens.get(t.ownerKey)).toBe(t.stuck);
  });

  it('a later confirm delivers them too, exactly once', async () => {
    const t = await liveWithStrandedTokens();
    delete t.chain.script.transferTokens;
    const st = await confirmLaunch(t.prep.launchId, {}, t.ctx());
    expect(st.state).toBe('live');
    expect(st.error).toBeUndefined();
    expect(st.txs.devTransfer).toBeTruthy();
    expect(t.chain.tokens.get(t.ownerKey)).toBe(t.stuck);
    const before = t.chain.count('transferTokens');
    for (let i = 0; i < 3; i++) await confirmLaunch(t.prep.launchId, {}, t.ctx());
    await t.hourly(T0 + HOUR);
    expect(t.chain.count('transferTokens')).toBe(before);
    expect(t.chain.tokens.get(t.ownerKey)).toBe(t.stuck);
  });

  it('nothing is sent while the engine is working on her, and only the dev-buy amount afterwards', async () => {
    const t = await liveWithStrandedTokens();
    delete t.chain.script.transferTokens;
    const before = t.chain.count('transferTokens');

    // the engine bought tokens for a seal and has not burned them yet
    const sealBought = 5_000_000n;
    t.chain.tokens.set(t.queenKey, t.stuck + sealBought);
    await t.db.setMeta(ENGINE_META.hive(t.rec.mintPubkey), JSON.stringify({ v: 2, sealPending: { before: t.stuck.toString(), at: T0, sol: 0.1 }, open: null }));
    let st = await confirmLaunch(t.prep.launchId, {}, t.ctx());
    expect(st.error).toMatch(/busy/);
    expect(t.chain.count('transferTokens')).toBe(before);

    // the hourly run is in progress
    await t.db.setMeta(ENGINE_META.hive(t.rec.mintPubkey), JSON.stringify({ v: 2, sealPending: null, open: null }));
    await t.db.setMeta(ENGINE_META.busy('live', 'hourly'), String(Date.now() + 60_000));
    st = await confirmLaunch(t.prep.launchId, {}, t.ctx());
    expect(st.error).toMatch(/busy/);
    expect(t.chain.count('transferTokens')).toBe(before);

    // the engine is idle again (and something else of this coin sits in her wallet): only the dev buy goes
    await t.db.setMeta(ENGINE_META.busy('live', 'hourly'), '');
    st = await confirmLaunch(t.prep.launchId, {}, t.ctx());
    expect(st.error).toBeUndefined();
    expect(t.chain.tokens.get(t.ownerKey)).toBe(t.stuck);
    expect(t.chain.tokens.get(t.queenKey)).toBe(sealBought);
  });

  it('a last transfer that timed out is not repeated until it can no longer land; if it landed, nothing more is sent', async () => {
    const t = await liveWithStrandedTokens(() => new TxError('Transaction not confirmed in time.', 'SIGDEV', undefined));
    delete t.chain.script.transferTokens;
    const before = t.chain.count('transferTokens');
    let st = await confirmLaunch(t.prep.launchId, {}, t.ctx());
    expect(st.error).toMatch(/could still land/);
    await t.hourly(T0 + 60_000);
    expect(t.chain.count('transferTokens')).toBe(before);

    // it landed after all
    t.chain.tokens.set(t.queenKey, 0n);
    t.chain.tokens.set(t.ownerKey, t.stuck);
    t.clock.now = T0 + UNSURE_SEND_SETTLE_MS;
    st = await confirmLaunch(t.prep.launchId, {}, t.ctx());
    expect(st.error).toBeUndefined();
    await t.hourly(T0 + HOUR);
    expect(t.chain.count('transferTokens')).toBe(before);
    expect(t.chain.tokens.get(t.ownerKey)).toBe(t.stuck);
  });
});
