/**
 * #17: a live harvest burn (or royal-jelly transfer) that timed out may still land; a resumed harvest
 * must not send it again until it no longer can, so the hub's own $HIVE is never spent.
 */
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { DEFAULT_RULES } from '@/lib/queen';
import type { RemoteHive } from '@/lib/shared/api';
import { TxError } from '@/lib/server/chain';
import { newKeypair } from '@/lib/server/keys';
import { ENGINE_META, UNSURE_SEND_SETTLE_MS, runHarvest, type HubSetup } from '@/lib/server/engine';
import { EngineMemDb, ScriptChain, walletAddress } from './engine-fakes';

const HOUR = 3_600_000;
const T0 = 500_000 * HOUR;
const OWN = 777_000_000n; // the hub's own $HIVE, never to be touched

async function setup() {
  const db = new EngineMemDb();
  const chain = new ScriptChain('live');
  const hubKey = Keypair.generate();
  const hubMint = walletAddress();
  const hub: HubSetup = { keypair: hubKey, wallet: hubKey.publicKey.toBase58(), mint: hubMint };
  const { keypair, enc } = newKeypair();
  await db.putSecret(keypair.publicKey.toBase58(), enc);
  const big: RemoteHive = {
    ca: walletAddress(), name: 'Big', ticker: 'BIG', image: '', cell: { q: 0, r: 0 }, queenWallet: keypair.publicKey.toBase58(), ownerWallet: walletAddress(),
    rules: DEFAULT_RULES, devBuy: 0, status: 'live', honey: 5, bees: 1, feesTotal: 0, royalJelly: 0, state: 'working', lastFeeAt: T0, createdAt: T0 - HOUR, updatedAt: T0 - HOUR,
  };
  await db.upsertHive(big);
  chain.setSol(hub.wallet!, 1);
  chain.prices.set(hubMint, 1e-5);
  chain.setTokens(hub.wallet!, hubMint, OWN);
  const ctx = (now: number) => ({ db, chain, mode: 'live' as const, hub, now, hourMs: HOUR, settleMs: 0, reserveSol: 0.05 });
  const hubTokens = () => chain.tokenOf(hub.wallet!, hubMint);
  return { db, chain, hub, hubMint, big, ctx, hubTokens };
}

/** Make the next `op` broadcast but time out without landing; returns what it would have moved. */
function timeOutOnce(chain: ScriptChain, op: 'burn' | 'transferTokens', sig: string) {
  const inFlight: { amount: bigint | null } = { amount: null };
  chain.fail = (o, info) => {
    if (o === op && inFlight.amount === null) {
      inFlight.amount = info.amount!;
      return new TxError('Transaction not confirmed in time. It may still land; retrying will check first.', sig, undefined);
    }
    return undefined;
  };
  return inFlight;
}

describe('#17 live harvest resume after a send with an unknown outcome', () => {
  it('a second call seconds later does not burn again; the late-landing burn is not repeated', async () => {
    const w = await setup();
    const inFlight = timeOutOnce(w.chain, 'burn', 'SIGBURN1');
    const s1 = await runHarvest(w.ctx(T0));
    expect(s1.pending).toMatch(/burn did not confirm/);
    const open = JSON.parse((await w.db.getMeta(ENGINE_META.openHarvest('live')))!);
    expect(open.burnTx).toBe('SIGBURN1');

    // a duplicate cron call 20 s later: the first burn may still land, so nothing is sent
    const s2 = await runHarvest(w.ctx(T0 + 20_000));
    expect(s2.pending).toMatch(/may still land/);
    expect(s2.harvest).toBeUndefined();
    expect(w.chain.sends('burn')).toHaveLength(0); // was: burned the same amount again

    // the first burn lands within its blockhash lifetime
    w.chain.setTokens(w.hub.wallet!, w.hubMint, w.hubTokens() - inFlight.amount!);

    // after the settle time the balance is final: no burn is owed, the jelly goes out, the hub keeps its own
    const s3 = await runHarvest(w.ctx(T0 + UNSURE_SEND_SETTLE_MS));
    expect(s3.harvest).toBeDefined();
    expect(w.chain.sends('burn')).toHaveLength(0);
    expect(w.chain.sends('transferTokens')).toHaveLength(1);
    expect(w.hubTokens()).toBe(OWN);
  });

  it('a burn that never landed is sent again once it no longer can', async () => {
    const w = await setup();
    const inFlight = timeOutOnce(w.chain, 'burn', 'SIGBURN1');
    await runHarvest(w.ctx(T0));
    expect((await runHarvest(w.ctx(T0 + UNSURE_SEND_SETTLE_MS - 1))).pending).toMatch(/may still land/);
    const s = await runHarvest(w.ctx(T0 + UNSURE_SEND_SETTLE_MS));
    expect(s.harvest).toBeDefined();
    expect(w.chain.sends('burn').map((b) => b.amount)).toEqual([inFlight.amount]);
    expect(w.hubTokens()).toBe(OWN);
  });

  it('the intent is saved before the send, so a run that dies mid-send waits like a timed-out one', async () => {
    const w = await setup();
    const seen: unknown[] = [];
    w.chain.fail = (op) => {
      if (op === 'burn') seen.push(JSON.parse(w.db.meta.get(ENGINE_META.openHarvest('live'))!).burnUnsureAt);
      return undefined;
    };
    const s = await runHarvest(w.ctx(T0));
    expect(s.harvest).toBeDefined();
    expect(seen).toEqual([T0]); // journalled while the burn was in flight
    expect(w.db.meta.get(ENGINE_META.openHarvest('live'))).toBe(''); // and closed after
  });

  it('the same holds for a royal-jelly transfer that timed out', async () => {
    const w = await setup();
    const inFlight = timeOutOnce(w.chain, 'transferTokens', 'SIGJELLY1');
    const s1 = await runHarvest(w.ctx(T0));
    expect(s1.pending).toMatch(/transfer did not confirm/);
    expect((await runHarvest(w.ctx(T0 + 30_000))).pending).toMatch(/may still land/);
    expect(w.chain.sends('transferTokens')).toHaveLength(0);
    // it lands
    w.chain.setTokens(w.hub.wallet!, w.hubMint, w.hubTokens() - inFlight.amount!);
    w.chain.setTokens(w.big.queenWallet, w.hubMint, w.chain.tokenOf(w.big.queenWallet, w.hubMint) + inFlight.amount!);
    const s3 = await runHarvest(w.ctx(T0 + UNSURE_SEND_SETTLE_MS));
    expect(s3.harvest).toBeDefined();
    expect(w.chain.sends('transferTokens')).toHaveLength(0);
    expect(w.hubTokens()).toBe(OWN);
    expect(w.chain.tokenOf(w.big.queenWallet, w.hubMint)).toBe(inFlight.amount);
  });
});
