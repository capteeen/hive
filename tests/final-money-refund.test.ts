/**
 * #4: an expired live launch whose recorded payment signature never lands (the payment was dropped and
 * sent again, and the new signature never reached the server) must still be refundable: once the
 * recorded signature can no longer land, what sits in the queen wallet goes back to the owner.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { LIMITS, launchMessage, type LaunchPayload } from '@/lib/shared/api';
import { DEFAULT_LOOK, DEFAULT_RULES } from '@/lib/queen';
import { config } from '@/lib/server/config';
import { LaunchError, PAYMENT_SETTLE_MS, confirmLaunch, launchStatus, prepareLaunch, refundLaunch, type LaunchCtx } from '@/lib/server/launch';
import { resetRateLimits } from '@/lib/server/ratelimit';
import { refundMessage } from '@/lib/launchClient';
import { MemDb } from './fakes/memdb';
import { FakeChain, fakeSig } from './fakes/fakechain';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const T0 = 1_800_000_000_000;
const GRACE = 10 * 60 * 1000;

function wallet() {
  const kp = nacl.sign.keyPair();
  const owner = bs58.encode(kp.publicKey);
  return { owner, sign: (msg: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)) };
}
function payload(owner: string): LaunchPayload {
  return { owner, name: 'Amber Comb', ticker: 'amber', image: PNG, devBuy: 0, cell: null, look: DEFAULT_LOOK, rules: DEFAULT_RULES, temperament: { dip: 'Steady', swarm: 'Forager' }, issuedAt: T0 };
}

beforeEach(() => {
  resetRateLimits();
  config.demoHives = false;
});

async function expiredWithDroppedSig(verdict: { ok: false; retry?: boolean; reason: string }) {
  const clock = { now: T0 };
  const db = new MemDb(() => clock.now);
  const chain = new FakeChain('live');
  const ctx = (): LaunchCtx => ({ db, chain, mode: 'live', now: clock.now, ip: '10.0.0.1', problems: [] });
  const w = wallet();
  const p = payload(w.owner);
  const prep = await prepareLaunch({ payload: p, signature: w.sign(launchMessage(p)) }, ctx());
  const S1 = fakeSig('P');
  chain.script.verifyPayment = async (sig) => (sig === S1 ? { ok: false, retry: true, reason: 'Payment not confirmed yet.' } : { ok: true, lamports: prep.lamports });
  const st1 = await confirmLaunch(prep.launchId, { signature: S1 }, ctx());
  expect(st1.txs.payment).toBe(S1);
  // S2 (sent again) landed, but its confirm never reached the server
  chain.sol.set(prep.queenWallet, prep.lamports);
  // the reservation and its payment grace run out; a status poll expires it, keeping S1
  clock.now = T0 + LIMITS.reservationMs + GRACE + 1;
  const exp = await launchStatus(prep.launchId, ctx());
  expect(exp.state).toBe('expired');
  expect(exp.txs.payment).toBe(S1);
  chain.script.verifyPayment = async () => verdict;
  const refund = () => refundLaunch(prep.launchId, { signature: w.sign(refundMessage(prep.launchId)) }, ctx());
  return { clock, db, chain, prep, w, refund };
}

describe('#4 refund of an expired launch whose recorded payment never lands', () => {
  it('waits while the recorded signature could still land, then refunds the queen balance to the owner', async () => {
    const { clock, chain, prep, w, refund } = await expiredWithDroppedSig({ ok: false, retry: true, reason: 'Payment not confirmed yet.' });

    // right after expiry the dropped payment might still land: nothing is sent yet
    const early = await refund().then(() => null, (e: unknown) => e);
    expect(early).toBeInstanceOf(LaunchError);
    expect((early as LaunchError).status).toBe(409);
    expect((early as LaunchError).message).toMatch(/not confirmed yet/);
    expect(chain.count('transferSol')).toBe(0);

    // once it can no longer land, the balance decides (was: 409 forever, the SOL stuck)
    clock.now += PAYMENT_SETTLE_MS + 1;
    const st = await refund();
    expect(st.state).toBe('refunded');
    expect(chain.count('transferSol')).toBe(1);
    expect(await chain.balance(w.owner)).toBe(prep.lamports - 5000);
    expect(await chain.balance(prep.queenWallet)).toBe(0);

    // idempotent: a second request sends nothing more
    await refund();
    expect(chain.count('transferSol')).toBe(1);
  });

  it('a recorded signature that is final and not a payment for this launch does not block the refund either', async () => {
    const { chain, prep, w, refund } = await expiredWithDroppedSig({ ok: false, reason: 'The payment transaction failed on chain.' });
    const st = await refund();
    expect(st.state).toBe('refunded');
    expect(await chain.balance(w.owner)).toBe(prep.lamports - 5000);
  });

  it('with nothing in the queen wallet, it stays expired (a late payment can still be refunded)', async () => {
    const { clock, db, chain, prep, refund } = await expiredWithDroppedSig({ ok: false, retry: true, reason: 'Payment not confirmed yet.' });
    chain.sol.set(prep.queenWallet, 0);
    clock.now += PAYMENT_SETTLE_MS + 1;
    const err = await refund().then(() => null, (e: unknown) => e);
    expect((err as LaunchError).status).toBe(409);
    expect((err as LaunchError).message).toMatch(/No payment was received/);
    expect(chain.count('transferSol')).toBe(0);
    expect(db.launches.get(prep.launchId)!.state).toBe('expired');
  });
});
