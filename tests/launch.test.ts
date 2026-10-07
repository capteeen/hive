import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { LIMITS, launchMessage, type LaunchPayload, type LaunchStatusResponse } from '@/lib/shared/api';
import { DEFAULT_LOOK, DEFAULT_RULES } from '@/lib/queen';
import { config } from '@/lib/server/config';
import { TxError, setChainForTests } from '@/lib/server/chain';
import { MockChain } from '@/lib/server/chain-mock';
import { setDbForTests } from '@/lib/server/db';
import { CREATE_SETTLE_MS, LaunchError, MAX_ATTEMPTS, confirmLaunch, lamportsFor, launchStatus, prepareLaunch, refundLaunch, type LaunchCtx } from '@/lib/server/launch';
import { resetRateLimits } from '@/lib/server/ratelimit';
import * as client from '@/lib/launchClient';
import { refundMessage, type PendingLaunch } from '@/lib/launchClient';
import { MemDb } from './fakes/memdb';
import { FakeChain, fakeSig } from './fakes/fakechain';

// 1×1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const T0 = 1_800_000_000_000;

function wallet() {
  const kp = nacl.sign.keyPair();
  const owner = bs58.encode(kp.publicKey);
  return { owner, sign: (msg: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)) };
}

function payload(owner: string, over: Partial<LaunchPayload> = {}): LaunchPayload {
  return {
    owner,
    name: 'Amber Comb',
    ticker: 'amber',
    description: 'A patient queen.',
    motto: 'Slow honey.',
    telegram: 't.me/amber',
    twitter: '@amber',
    image: PNG,
    devBuy: 0,
    cell: null,
    look: DEFAULT_LOOK,
    rules: DEFAULT_RULES,
    temperament: { dip: 'Steady', swarm: 'Forager' },
    issuedAt: T0,
    ...over,
  };
}

/** A clock shared by the db (claim / lock expiry) and the launch module. */
function setup(mode: 'mock' | 'live', chain: FakeChain | MockChain = new FakeChain(mode)) {
  const clock = { now: T0 };
  const db = new MemDb(() => clock.now);
  const ctx = (extra: Partial<LaunchCtx> = {}): LaunchCtx => ({ db, chain, mode, now: clock.now, ip: '10.0.0.1', problems: [], ...extra });
  return { db, chain, clock, ctx };
}

async function expectError(p: Promise<unknown>, status: number, match?: RegExp) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(LaunchError);
  expect((e as LaunchError).status).toBe(status);
  if (match) expect((e as LaunchError).message).toMatch(match);
  return e as LaunchError;
}

beforeEach(() => {
  resetRateLimits();
  config.demoHives = false; // an empty comb: the first hive goes to the origin
});

describe('prepare: validation and ownership', () => {
  it('rejects an invalid payload with every reason', async () => {
    const { ctx } = setup('mock');
    const e = await expectError(prepareLaunch({ payload: { ...payload('guest:abcdef12'), name: 'x', ticker: '!!', image: 'nope' } }, ctx()), 400);
    expect(e.reasons?.length).toBeGreaterThanOrEqual(3);
    await expectError(prepareLaunch({}, ctx()), 400, /Missing launch details/);
  });

  it('accepts a guest in mock mode without a signature', async () => {
    const { ctx } = setup('mock');
    const res = await prepareLaunch({ payload: payload('guest:abcdef12') }, ctx());
    expect(res.mode).toBe('mock');
    expect(res.cell).toEqual({ q: 0, r: 0 });
    expect(res.lamports).toBe(lamportsFor(config.costs.launchCost + config.costs.queenReserve));
    expect(res.breakdown).toEqual({ launchCost: config.costs.launchCost, queenReserve: config.costs.queenReserve, devBuy: 0 });
  });

  it('live: 503 when not configured, guests refused, signature required / checked / fresh', async () => {
    const { ctx } = setup('live');
    const w = wallet();
    const p = payload(w.owner);
    const e = await expectError(prepareLaunch({ payload: p, signature: w.sign(launchMessage(p)) }, ctx({ problems: ['QUEEN_KEY_SECRET is not set.'] })), 503);
    expect(e.reasons).toEqual(['QUEEN_KEY_SECRET is not set.']);
    await expectError(prepareLaunch({ payload: payload('guest:abcdef12') }, ctx()), 400, /wallet/i);
    await expectError(prepareLaunch({ payload: p }, ctx()), 400, /Sign/);
    const other = wallet();
    await expectError(prepareLaunch({ payload: p, signature: other.sign(launchMessage(p)) }, ctx()), 400, /does not match/);
    // signed a different message (other name)
    await expectError(prepareLaunch({ payload: p, signature: w.sign(launchMessage({ ...p, name: 'Other' })) }, ctx()), 400, /does not match/);
    const stale = payload(w.owner, { issuedAt: T0 - LIMITS.signatureMaxAgeMs - 1 });
    await expectError(prepareLaunch({ payload: stale, signature: w.sign(launchMessage(stale)) }, ctx()), 400, /too old/);
    const ok = await prepareLaunch({ payload: p, signature: w.sign(launchMessage(p)) }, ctx());
    expect(ok.mode).toBe('live');
    expect(ok.queenWallet).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it('rate-limits per owner and per IP', async () => {
    const { ctx } = setup('mock');
    for (let i = 0; i < 6; i++) await prepareLaunch({ payload: payload('guest:sameowner') }, ctx());
    await expectError(prepareLaunch({ payload: payload('guest:sameowner') }, ctx()), 429, /wallet/);
    // same IP, fresh owners: the IP budget (12) runs out too
    for (let i = 0; i < 5; i++) await prepareLaunch({ payload: payload(`guest:owner${i}xx`) }, ctx());
    const e = await expectError(prepareLaunch({ payload: payload('guest:another1') }, ctx()), 429, /network/);
    expect(e.retryAfterMs).toBeGreaterThan(0);
    // another IP is unaffected
    await prepareLaunch({ payload: payload('guest:another1') }, ctx({ ip: '10.0.0.2' }));
  });

  it('stores secrets encrypted and never returns them', async () => {
    const { ctx, db } = setup('mock');
    const res = await prepareLaunch({ payload: payload('guest:abcdef12') }, ctx());
    const rec = (await db.getLaunch(res.launchId))!;
    expect(db.secrets.get(rec.queenWallet)).toMatch(/^v1\./);
    expect(db.secrets.get(rec.mintPubkey)).toMatch(/^v1\./);
    expect(rec.payload.ticker).toBe('AMBER');
    const st = await launchStatus(res.launchId, ctx());
    const json = JSON.stringify(st) + JSON.stringify(res);
    expect(json).not.toMatch(/v1\./);
    expect(json).not.toContain(rec.mintSecretEnc);
    expect(json).not.toContain('data:image');
  });
});

describe('cells', () => {
  it('reserves the preferred cell, or the nearest free one with changed = true', async () => {
    const { ctx } = setup('mock');
    const a = await prepareLaunch({ payload: payload('guest:ownera1', { cell: { q: 0, r: 0 } }) }, ctx());
    expect(a.cell).toEqual({ q: 0, r: 0 });
    expect(a.cellChanged).toBe(false);
    const b = await prepareLaunch({ payload: payload('guest:ownerb1', { cell: { q: 0, r: 0 } }) }, ctx());
    expect(b.cell).not.toEqual({ q: 0, r: 0 });
    expect(b.cellChanged).toBe(true);
    const c = await prepareLaunch({ payload: payload('guest:ownerc1', { cell: b.cell }) }, ctx());
    expect(c.cell).not.toEqual(b.cell);
  });

  it('expires an unpaid reservation and frees its cell', async () => {
    const { ctx, db, clock } = setup('live');
    const w = wallet();
    const p = payload(w.owner);
    const res = await prepareLaunch({ payload: p, signature: w.sign(launchMessage(p)) }, ctx());
    expect(db.claims.some((c) => c.launchId === res.launchId)).toBe(true);
    clock.now = res.expiresAt + 1;
    const st = await launchStatus(res.launchId, ctx({ now: clock.now }));
    expect(st.state).toBe('expired');
    expect(db.claims.some((c) => c.launchId === res.launchId)).toBe(false);
    // the cell can be taken again
    const again = await prepareLaunch({ payload: payload('guest:abcdef12', { cell: res.cell }) }, ctx({ mode: 'mock', now: clock.now }));
    expect(again.cell).toEqual(res.cell);
  });
});

describe('mock launch', () => {
  it('goes all the way to live with MockChain: hive, born action, cell finalized', async () => {
    const { ctx, db } = setup('mock', new MockChain({ seed: 7, now: () => T0 }));
    const prep = await prepareLaunch({ payload: payload('guest:abcdef12', { devBuy: 0.5 }) }, ctx());
    const st = await confirmLaunch(prep.launchId, {}, ctx());
    expect(st.state).toBe('live');
    expect(st.ca).toBeTruthy();
    expect(st.hive?.status).toBe('mock');
    expect(st.hive?.image).toBe(PNG);
    expect(st.hive?.cell).toEqual(prep.cell);
    expect(st.hive?.ownerWallet).toBe('guest:abcdef12');
    expect(st.hive?.telegram).toBe('https://t.me/amber');
    expect(st.hive?.twitter).toBe('https://x.com/amber');
    expect(st.hive?.honey).toBeGreaterThan(0);
    expect(st.txs.create).toHaveLength(88);
    const hive = await db.getHive(st.ca!);
    expect(hive?.queenWallet).toBe(prep.queenWallet);
    const born = db.actions.find((a) => a.verb === 'born');
    expect(born?.ca).toBe(st.ca);
    expect(born?.reason).toContain(prep.queenWallet);
    expect(born?.reason).toContain(st.txs.create);
    expect(db.claims.find((c) => c.launchId === prep.launchId)?.expiresAt).toBeNull();
    // confirming again is a no-op
    const again = await confirmLaunch(prep.launchId, {}, ctx());
    expect(again.state).toBe('live');
    expect(db.actions.filter((a) => a.verb === 'born')).toHaveLength(1);
  });
});

describe('live launch', () => {
  async function livePrep(devBuy = 0.25) {
    const s = setup('live');
    const chain = s.chain as FakeChain;
    const w = wallet();
    const p = payload(w.owner, { devBuy });
    const prep = await prepareLaunch({ payload: p, signature: w.sign(launchMessage(p)) }, s.ctx());
    const rec = (await s.db.getLaunch(prep.launchId))!;
    return { ...s, chain, w, prep, rec };
  }

  it('pays, uploads, creates once with the queen as creator, sends dev tokens, goes live', async () => {
    const { ctx, db, chain, w, prep, rec } = await livePrep(0.25);
    const pay = fakeSig('P');
    const st = await confirmLaunch(prep.launchId, { signature: pay }, ctx());
    expect(st.state).toBe('live');
    expect(chain.calls.find((c) => c.method === 'verifyPayment')?.args).toEqual([pay, w.owner, prep.queenWallet, prep.lamports, rec.createdAt]);
    const up = chain.calls.find((c) => c.method === 'uploadMetadata')!.args[0] as { name: string; symbol: string; image: { mime: string; bytes: Uint8Array } };
    expect(up.symbol).toBe('AMBER');
    expect(up.image.mime).toBe('image/png');
    expect(up.image.bytes.length).toBeGreaterThan(10);
    expect(chain.count('createCoin')).toBe(1);
    const create = chain.calls.find((c) => c.method === 'createCoin')!.args[0] as { creator: { publicKey: { toBase58(): string } }; mint: { publicKey: { toBase58(): string } }; uri: string; devBuySol: number };
    expect(create.creator.publicKey.toBase58()).toBe(prep.queenWallet);
    expect(create.mint.publicKey.toBase58()).toBe(rec.mintPubkey);
    expect(create.uri).toBe('https://ipfs.io/ipfs/QmMeta');
    expect(create.devBuySol).toBe(0.25);
    expect(st.ca).toBe(rec.mintPubkey);
    // dev-buy tokens moved to the owner
    expect(chain.count('transferTokens')).toBe(1);
    expect(chain.tokens.get(`${w.owner}|${rec.mintPubkey}`)).toBeGreaterThan(0n);
    expect(st.txs.devTransfer).toBeTruthy();
    expect(st.txs.payment).toBe(pay);
    expect(st.hive?.status).toBe('live');
    expect(st.hive?.image).toBe('https://ipfs.io/ipfs/QmImage');
    expect(st.hive?.honey).toBeCloseTo(prep.lamports / 1e9);
    expect(await db.getMeta(`payment:${pay}`)).toBe(prep.launchId);
    expect(db.actions[0].verb).toBe('born');
  });

  it('keeps the launch reserved while the payment is unconfirmed, then resumes without the signature', async () => {
    const { ctx, chain, prep } = await livePrep(0);
    chain.script.verifyPayment = async () => ({ ok: false, retry: true, reason: 'Payment not confirmed yet.' });
    const pay = fakeSig('P');
    const st = await confirmLaunch(prep.launchId, { signature: pay }, ctx());
    expect(st.state).toBe('reserved');
    expect(st.error).toMatch(/not confirmed/);
    expect(st.txs.payment).toBe(pay);
    expect(chain.count('createCoin')).toBe(0);
    delete chain.script.verifyPayment;
    const done = await confirmLaunch(prep.launchId, {}, ctx());
    expect(done.state).toBe('live');
    expect(done.error).toBeUndefined();
  });

  it('forgets a definitely-wrong payment so a correct one can be sent', async () => {
    const { ctx, chain, prep } = await livePrep(0);
    chain.script.verifyPayment = async () => ({ ok: false, reason: 'Payment too small.' });
    const st = await confirmLaunch(prep.launchId, { signature: fakeSig('P') }, ctx());
    expect(st.state).toBe('reserved');
    expect(st.txs.payment).toBeUndefined();
    expect(st.error).toMatch(/too small/);
  });

  it('refuses a payment signature already used by another launch', async () => {
    const a = await livePrep(0);
    const pay = fakeSig('P');
    expect((await confirmLaunch(a.prep.launchId, { signature: pay }, a.ctx())).state).toBe('live');
    // a second launch on the same db tries to reuse it
    const w = wallet();
    const p = payload(w.owner);
    const prep2 = await prepareLaunch({ payload: p, signature: w.sign(launchMessage(p)) }, a.ctx());
    const st = await confirmLaunch(prep2.launchId, { signature: pay }, a.ctx());
    expect(st.state).toBe('reserved');
    expect(st.error).toMatch(/already used/);
  });

  it('two concurrent confirms send create only once', async () => {
    const { ctx, chain, prep } = await livePrep(0);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    chain.script.createCoin = async (input) => {
      await gate;
      chain.accounts.add(input.mint.publicKey.toBase58());
      return { signature: fakeSig('C') };
    };
    const pay = fakeSig('P');
    const first = confirmLaunch(prep.launchId, { signature: pay }, ctx());
    // let the first one take the lock and reach createCoin
    await new Promise((r) => setTimeout(r, 10));
    const second = await confirmLaunch(prep.launchId, { signature: pay }, ctx());
    expect(second.state).not.toBe('live');
    release();
    expect((await first).state).toBe('live');
    const third = await confirmLaunch(prep.launchId, { signature: pay }, ctx());
    expect(third.state).toBe('live');
    expect(chain.count('createCoin')).toBe(1);
  });

  it('a create whose answer was lost is not sent again when the mint exists', async () => {
    const { ctx, chain, prep, rec } = await livePrep(0);
    // the transaction lands, but we only see a timeout
    chain.script.createCoin = async () => {
      throw new TxError('Transaction not confirmed in time.', fakeSig('C'));
    };
    const st = await confirmLaunch(prep.launchId, { signature: fakeSig('P') }, ctx());
    expect(st.state).toBe('metadata');
    expect(st.error).toMatch(/Creating the coin failed/);
    expect(st.txs.create).toBeTruthy();
    chain.accounts.add(rec.mintPubkey); // ...it landed after all
    const done = await confirmLaunch(prep.launchId, {}, ctx());
    expect(done.state).toBe('live');
    expect(chain.count('createCoin')).toBe(1);
  });

  it('a network error after the create landed is treated as success right away', async () => {
    const { ctx, chain, prep, rec } = await livePrep(0);
    chain.script.createCoin = async () => {
      chain.accounts.add(rec.mintPubkey);
      throw new Error('socket hang up');
    };
    const st = await confirmLaunch(prep.launchId, { signature: fakeSig('P') }, ctx());
    expect(st.state).toBe('live');
    expect(chain.count('createCoin')).toBe(1);
  });

  it(`fails after ${MAX_ATTEMPTS} create attempts, then refunds to the owner (signed)`, async () => {
    const { ctx, chain, prep, w, db, clock } = await livePrep(0.1);
    chain.script.createCoin = async () => {
      throw new TxError('Transaction rejected: insufficient funds', fakeSig('C'), false);
    };
    let st = await confirmLaunch(prep.launchId, { signature: fakeSig('P') }, ctx());
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(st.state).toBe('metadata');
      st = await confirmLaunch(prep.launchId, {}, ctx());
    }
    expect(st.state).toBe('failed');
    expect(chain.count('createCoin')).toBe(MAX_ATTEMPTS);
    expect(db.claims.some((c) => c.launchId === prep.launchId)).toBe(false);

    await expectError(refundLaunch(prep.launchId, {}, ctx()), 400, /Sign/);
    await expectError(refundLaunch(prep.launchId, { signature: wallet().sign(refundMessage(prep.launchId)) }, ctx()), 400);
    // a create was signed: no refund until it can no longer land
    const early = await expectError(refundLaunch(prep.launchId, { signature: w.sign(refundMessage(prep.launchId)) }, ctx()), 409, /could still land/);
    expect(early.retryAfterMs).toBe(CREATE_SETTLE_MS);
    expect(chain.count('transferSol')).toBe(0);
    clock.now += CREATE_SETTLE_MS + 1;
    const queenBefore = chain.sol.get(prep.queenWallet)!;
    const r = await refundLaunch(prep.launchId, { signature: w.sign(refundMessage(prep.launchId)) }, ctx());
    expect(r.state).toBe('refunded');
    expect(r.txs.refund).toBeTruthy();
    const sent = chain.calls.find((c) => c.method === 'transferSol')!.args[0] as { to: string; lamports: number };
    expect(sent.to).toBe(w.owner);
    expect(sent.lamports).toBe(queenBefore - 5000);
    expect(chain.sol.get(prep.queenWallet)).toBe(0);
    // idempotent
    expect((await refundLaunch(prep.launchId, { signature: w.sign(refundMessage(prep.launchId)) }, ctx())).state).toBe('refunded');
    expect(chain.count('transferSol')).toBe(1);
  });

  it('refuses refunds for launches that did not fail', async () => {
    const { ctx, prep, w } = await livePrep(0);
    await expectError(refundLaunch(prep.launchId, { signature: w.sign(refundMessage(prep.launchId)) }, ctx()), 409);
  });

  it('a payment that arrives after expiry is recorded and refundable', async () => {
    const { ctx, chain, prep, w, clock } = await livePrep(0);
    clock.now = prep.expiresAt + 1;
    expect((await launchStatus(prep.launchId, ctx({ now: clock.now }))).state).toBe('expired');
    const pay = fakeSig('P');
    const st = await confirmLaunch(prep.launchId, { signature: pay }, ctx({ now: clock.now }));
    expect(st.state).toBe('expired');
    expect(st.txs.payment).toBe(pay);
    expect(st.error).toMatch(/refund/i);
    expect(chain.count('createCoin')).toBe(0);
    const r = await refundLaunch(prep.launchId, { signature: w.sign(refundMessage(prep.launchId)) }, ctx({ now: clock.now }));
    expect(r.state).toBe('refunded');
  });

  it('an expired launch without a payment has nothing to refund', async () => {
    const { ctx, prep, w, clock } = await livePrep(0);
    clock.now = prep.expiresAt + 1;
    await expectError(refundLaunch(prep.launchId, { signature: w.sign(refundMessage(prep.launchId)) }, ctx({ now: clock.now })), 409, /No payment/);
  });

  it('refund of a failed launch fails closed: waits out a create that timed out, refuses when the mint check errors', async () => {
    const { ctx, chain, prep, w, clock, rec } = await livePrep(0.1);
    // every create times out: the transaction may still land
    chain.script.createCoin = async () => {
      throw new TxError('Transaction not confirmed in time. It may still land; retrying will check first.', fakeSig('C'));
    };
    let st = await confirmLaunch(prep.launchId, { signature: fakeSig('P') }, ctx());
    for (let i = 1; i < MAX_ATTEMPTS; i++) st = await confirmLaunch(prep.launchId, {}, ctx());
    expect(st.state).toBe('failed');
    const refund = () => refundLaunch(prep.launchId, { signature: w.sign(refundMessage(prep.launchId)) }, ctx());

    // straight after the failure the last create could still land
    await expectError(refund(), 409, /could still land/);
    clock.now += CREATE_SETTLE_MS - 1000;
    await expectError(refund(), 409, /opens in 1 s/);

    // ...and it did land, but the RPC cannot say so right now: nothing is sent
    chain.accounts.add(rec.mintPubkey);
    chain.script.accountExists = async () => {
      throw new Error('429 Too Many Requests');
    };
    clock.now += 2000;
    await expectError(refund(), 503, /Could not check/);
    expect(chain.count('transferSol')).toBe(0);
    expect((await launchStatus(prep.launchId, ctx())).state).toBe('failed');

    // once the chain answers, the launch resumes instead of draining the queen
    delete chain.script.accountExists;
    await expectError(refund(), 409, /created after all/);
    expect((await launchStatus(prep.launchId, ctx())).state).toBe('metadata');
    const done = await confirmLaunch(prep.launchId, {}, ctx());
    expect(done.state).toBe('live');
    expect(chain.count('createCoin')).toBe(MAX_ATTEMPTS); // never created again
    expect(chain.count('transferSol')).toBe(0);
  });

  it('a failed upload (nothing signed) refunds right away', async () => {
    const { ctx, chain, prep, w } = await livePrep(0);
    chain.script.uploadMetadata = async () => {
      throw new Error('IPFS upload failed (502)');
    };
    let st = await confirmLaunch(prep.launchId, { signature: fakeSig('P') }, ctx());
    for (let i = 1; i < MAX_ATTEMPTS; i++) st = await confirmLaunch(prep.launchId, {}, ctx());
    expect(st.state).toBe('failed');
    expect(st.txs.create).toBeUndefined();
    const r = await refundLaunch(prep.launchId, { signature: w.sign(refundMessage(prep.launchId)) }, ctx());
    expect(r.state).toBe('refunded');
    expect(chain.count('createCoin')).toBe(0);
  });

  it('an expired launch whose payment signature never reached the server refunds what the queen wallet holds', async () => {
    const { ctx, chain, prep, w, clock } = await livePrep(0);
    clock.now = prep.expiresAt + 1;
    expect((await launchStatus(prep.launchId, ctx())).state).toBe('expired');
    const refund = () => refundLaunch(prep.launchId, { signature: w.sign(refundMessage(prep.launchId)) }, ctx());
    // nothing there yet: stays expired, so a payment landing later is still refundable
    await expectError(refund(), 409, /No payment/);
    expect((await launchStatus(prep.launchId, ctx())).state).toBe('expired');
    // the payment landed, but its signature was lost with the page
    chain.sol.set(prep.queenWallet, prep.lamports);
    const r = await refund();
    expect(r.state).toBe('refunded');
    const sent = chain.calls.find((c) => c.method === 'transferSol')!.args[0] as { to: string; lamports: number };
    expect(sent).toMatchObject({ to: w.owner, lamports: prep.lamports - 5000 });
    expect(chain.count('verifyPayment')).toBe(0);
  });

  it('an unrecorded-payment refund whose answer was lost settles as refunded on retry, never sends twice', async () => {
    const { ctx, chain, prep, w, clock } = await livePrep(0);
    clock.now = prep.expiresAt + 1;
    chain.sol.set(prep.queenWallet, prep.lamports);
    const lost = fakeSig('R');
    chain.script.transferSol = async () => {
      chain.sol.set(prep.queenWallet, 0); // it lands...
      throw new TxError('Transaction not confirmed in time.', lost); // ...but we only see a timeout
    };
    const refund = () => refundLaunch(prep.launchId, { signature: w.sign(refundMessage(prep.launchId)) }, ctx());
    await expectError(refund(), 502, /Refund failed/);
    delete chain.script.transferSol;
    const r = await refund();
    expect(r.state).toBe('refunded');
    expect(r.txs.refund).toBe(lost);
    expect(chain.count('transferSol')).toBe(1);
  });

  it('a mode switch between prepare and confirm is refused', async () => {
    const { ctx, prep } = await livePrep(0);
    await expectError(confirmLaunch(prep.launchId, {}, ctx({ mode: 'mock' })), 409);
  });

  it('unknown ids are 404', async () => {
    const { ctx } = setup('mock');
    await expectError(launchStatus('nope-nope-nope', ctx()), 404);
    await expectError(launchStatus('../etc', ctx()), 404);
    await expectError(confirmLaunch('nope-nope-nope', {}, ctx()), 404);
  });
});

describe('MockChain', () => {
  it('needs no network: deposits, create, fees over mock hours, buy and burn', async () => {
    const { Keypair } = await import('@solana/web3.js');
    const { HOUR_MS } = await import('@/lib/sim');
    const clock = { now: T0 };
    const chain = new MockChain({ seed: 42, now: () => clock.now });
    const queen = Keypair.generate();
    const mint = Keypair.generate();
    const q = queen.publicKey.toBase58();
    expect((await chain.verifyPayment('sig-a', 'owner', q, 0.1e9, T0)).ok).toBe(true);
    await chain.verifyPayment('sig-a', 'owner', q, 0.1e9, T0); // same signature: credited once
    expect(await chain.balance(q)).toBe(0.1e9);
    await chain.createCoin({ creator: queen, mint, name: 'A', symbol: 'A', uri: 'ipfs://x', devBuySol: 0.01 });
    expect(await chain.accountExists(mint.publicKey.toBase58())).toBe(true);
    await expect(chain.createCoin({ creator: queen, mint, name: 'A', symbol: 'A', uri: 'ipfs://x', devBuySol: 0 })).rejects.toThrow(/in use/);
    const tokens = await chain.tokenBalance(q, mint.publicKey.toBase58());
    expect(tokens.amount).toBeGreaterThan(0n);
    // fees accrue over a few mock hours
    let fees = 0;
    for (let h = 1; h <= 6; h++) {
      clock.now = T0 + h * HOUR_MS;
      if (await chain.collectCreatorFees(queen)) fees++;
    }
    expect(fees).toBeGreaterThan(0);
    const before = await chain.balance(q);
    await chain.buy({ payer: queen, mint: mint.publicKey.toBase58(), sol: 0.01 });
    expect(await chain.balance(q)).toBeLessThan(before);
    const all = (await chain.tokenBalance(q, mint.publicKey.toBase58())).amount;
    await chain.burn({ owner: queen, mint: mint.publicKey.toBase58(), amount: all });
    expect((await chain.tokenBalance(q, mint.publicKey.toBase58())).amount).toBe(0n);
    const info = await chain.coinInfo(mint.publicKey.toBase58());
    expect(info?.priceSol).toBeGreaterThan(0);
    expect((await chain.holders(mint.publicKey.toBase58()))?.count).toBeGreaterThanOrEqual(1);
    await expect(chain.transferSol({ from: queen, to: 'x', lamports: 1e12 })).rejects.toThrow(/insufficient/);
  });
});

/* ------------------------------------------------------------------ */
/* the browser client against the real route handlers                  */
/* ------------------------------------------------------------------ */

describe('launch client: resuming a launch whose payment the server never heard of', () => {
  const realFetch = globalThis.fetch;
  const realMode = config.launchMode;
  const realSecret = config.queenKeySecret;

  /** fetch → the app's /api/launch route handlers, in process. */
  async function routes() {
    const status = await import('@/app/api/launch/[id]/route');
    const confirm = await import('@/app/api/launch/[id]/confirm/route');
    const refund = await import('@/app/api/launch/[id]/refund/route');
    return async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://hive.test');
      const m = /^\/api\/launch\/([^/]+)(?:\/(confirm|refund))?$/.exec(url.pathname);
      if (!m) return new Response('not found', { status: 404 });
      const req = new Request(url, { method: init.method, headers: init.headers, body: init.body });
      const ctx = { params: { id: decodeURIComponent(m[1]) } };
      return m[2] === 'confirm' ? confirm.POST(req, ctx) : m[2] === 'refund' ? refund.POST(req, ctx) : status.GET(req, ctx);
    };
  }

  /** A live launch prepared `agoMs` ago; the owner paid and the browser saved the signature, but the confirm never arrived. */
  async function staleLaunch(agoMs: number) {
    const chain = new FakeChain('live');
    const db = new MemDb(() => Date.now());
    setDbForTests(db);
    setChainForTests(chain);
    config.launchMode = 'live';
    config.queenKeySecret = 'ab'.repeat(32); // live mode refuses the throwaway dev key
    globalThis.fetch = (await routes()) as typeof fetch;
    const w = wallet();
    const then = Date.now() - agoMs;
    const pl = payload(w.owner, { issuedAt: then });
    const prep = await prepareLaunch({ payload: pl, signature: w.sign(launchMessage(pl)) }, { db, chain, mode: 'live', now: then, ip: '10.0.0.9', problems: [] });
    const pending: PendingLaunch = {
      id: prep.launchId,
      mode: 'live',
      owner: w.owner,
      queenWallet: prep.queenWallet,
      lamports: prep.lamports,
      cell: prep.cell,
      cellChanged: prep.cellChanged,
      expiresAt: prep.expiresAt,
      startedAt: then,
      paySig: fakeSig('P'),
    };
    return { chain, db, w, prep, pending };
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
    config.launchMode = realMode;
    config.queenKeySecret = realSecret;
    setDbForTests(null);
    setChainForTests(null);
  });

  it('resumeLaunch hands the saved signature over, so a lapsed reservation still goes live', async () => {
    const { chain, pending } = await staleLaunch(LIMITS.reservationMs + 60_000);
    const s = await client.resumeLaunch(pending);
    expect(s.state).toBe('live');
    expect(s.txs.payment).toBe(pending.paySig);
    expect(chain.count('createCoin')).toBe(1);
  });

  it('a payment still confirming past the grace period ends expired with the payment on record, and refunds', async () => {
    const { chain, w, pending } = await staleLaunch(LIMITS.reservationMs + 11 * 60_000);
    chain.script.verifyPayment = async () => ({ ok: false, retry: true, reason: 'Payment not confirmed yet.' });
    const s = await client.resumeLaunch(pending);
    expect(s.state).toBe('expired');
    expect(s.txs.payment).toBe(pending.paySig);
    expect(client.paymentUnheard(pending, s)).toBe(false);
    delete chain.script.verifyPayment; // it confirms
    const r = await client.refundLaunch(pending.id, w.sign(refundMessage(pending.id)));
    expect(r.state).toBe('refunded');
  });

  it('the old order (status first) expired it with nothing to refund; Start over hands the signature over instead of erasing it', async () => {
    const { chain, w, pending } = await staleLaunch(LIMITS.reservationMs + 60_000);
    const st = await client.launchStatus(pending.id);
    expect(st.state).toBe('expired');
    expect(st.txs.payment).toBeUndefined();
    await expect(client.refundLaunch(pending.id, w.sign(refundMessage(pending.id)))).rejects.toMatchObject({ status: 409 });
    expect(client.paymentUnheard(pending, st)).toBe(true);

    const res = await client.checkBeforeForget(pending, st);
    expect(res.forget).toBe(false);
    const kept = (res as { status: LaunchStatusResponse }).status;
    expect(kept.state).toBe('expired');
    expect(kept.txs.payment).toBe(pending.paySig);
    expect(chain.count('createCoin')).toBe(0);
    expect((await client.refundLaunch(pending.id, w.sign(refundMessage(pending.id)))).state).toBe('refunded');
  });

  it('checkBeforeForget forgets once the server rejected the payment, keeps the launch while the server cannot be asked', async () => {
    const { chain, pending } = await staleLaunch(60_000);
    // nothing to hand over
    expect(await client.checkBeforeForget({ ...pending, paySig: undefined }, null)).toEqual({ forget: true });
    expect(await client.checkBeforeForget({ ...pending, mode: 'mock' }, null)).toEqual({ forget: true });
    // server unreachable: throws, the caller keeps the launch
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(client.checkBeforeForget(pending, null)).rejects.toMatchObject({ network: true });
    globalThis.fetch = (await routes()) as typeof fetch;
    // the server checked it: a failed transaction moved no SOL
    chain.script.verifyPayment = async () => ({ ok: false, reason: 'The payment transaction failed on chain.' });
    expect(await client.checkBeforeForget(pending, null)).toEqual({ forget: true });
    // an unknown launch
    expect(await client.checkBeforeForget({ ...pending, id: 'unknown-launch-id' }, null)).toEqual({ forget: true });
  });
});

/* ------------------------------------------------------------------ */
/* MockChain ledger shared across module copies                        */
/* ------------------------------------------------------------------ */

describe('MockChain process-wide ledger', () => {
  it('route handlers and the instrumentation engine (separate module copies) see the same balances, coins and tokens', async () => {
    const { Keypair } = await import('@solana/web3.js');
    // two independently loaded copies of chain.ts, like Next's route and instrument bundles
    vi.resetModules();
    const routeCopy = await import('@/lib/server/chain');
    vi.resetModules();
    const engineCopy = await import('@/lib/server/chain');
    expect(routeCopy.getChain).not.toBe(engineCopy.getChain);
    const a = await routeCopy.getChain();
    const b = await engineCopy.getChain();
    expect(a).not.toBe(b);
    expect(a.kind).toBe('mock');

    const queen = Keypair.generate();
    const mint = Keypair.generate();
    const q = queen.publicKey.toBase58();
    const m = mint.publicKey.toBase58();
    await a.verifyPayment(`mock-payment-${q}`, 'guest:abcdef12', q, 0.1e9, 0);
    await a.createCoin({ creator: queen, mint, name: 'Shared', symbol: 'SHR', uri: 'ipfs://x', devBuySol: 0.01 });
    expect(await b.balance(q)).toBe(await a.balance(q));
    expect(await b.balance(q)).toBeGreaterThan(0);
    expect(await b.accountExists!(m)).toBe(true);
    expect((await b.tokenBalance(q, m)).amount).toBeGreaterThan(0n);
    // the engine copy can spend what the launch deposited
    await b.buy({ payer: queen, mint: m, sol: 0.001 });
    expect(await a.balance(q)).toBe(await b.balance(q));

    // a seeded / clocked instance (tests, simulations) keeps a private ledger
    expect(await new MockChain({ seed: 1 }).balance(q)).toBe(0);
    expect(await new MockChain({ now: () => T0 }).balance(q)).toBe(0);
    expect(await new MockChain({ seed: 1, shared: true }).balance(q)).toBe(await a.balance(q));
  });
});
