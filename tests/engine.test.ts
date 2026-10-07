import { afterEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { theme } from '@/themes';
import { DEFAULT_RULES, type QueenRules } from '@/lib/queen';
import type { RemoteHive, RemoteState } from '@/lib/shared/api';
import { HOUR_MS } from '@/lib/sim';
import { config } from '@/lib/server/config';
import { TxError, setChainForTests } from '@/lib/server/chain';
import { MockChain } from '@/lib/server/chain-mock';
import { setDbForTests } from '@/lib/server/db';
import { newKeypair } from '@/lib/server/keys';
import {
  ENGINE_META,
  MIN_PAYOUT_LAMPORTS,
  UNSURE_SEND_SETTLE_MS,
  cronAuth,
  cronDryRun,
  planPayout,
  readHiveState,
  runHarvest,
  runHourly,
  runRefresh,
  safeErr,
  type EngineCtx,
  type HubSetup,
} from '@/lib/server/engine';
import { autorunBlockedReason } from '@/lib/server/engine-autorun';
import { EngineMemDb, ScriptChain, pdaAddress, walletAddress } from './engine-fakes';

const HOUR = 3_600_000;
const T0 = 500_000 * HOUR; // on an hour boundary
const HOUR_INDEX = T0 / HOUR;
const RESERVE = 0.05;
/** What the engine sets aside per transaction: config.priorityFeeSol + the base fee. */
const TX = config.priorityFeeSol + 5000 / 1e9;
/** A creator-fee claim pays its own base fee; the engine counts what arrived. */
const arrived = (sol: number) => sol - 5000 / 1e9;

interface HiveOpts {
  cell: { q: number; r: number };
  /** Queen SOL. */
  sol?: number;
  /** Current price (SOL per token); missing = no market. */
  price?: number;
  /** Claimable creator fees, SOL. */
  fees?: number;
  /** Older price points, newest first, one per hour before T0. */
  history?: number[];
  state?: RemoteState;
  lastFeeAt?: number;
  honey?: number;
  status?: 'live' | 'mock';
  rules?: QueenRules;
  /** Store the queen key (default true). */
  withKey?: boolean;
}

function world(mode: 'live' | 'mock' = 'live') {
  const db = new EngineMemDb();
  const chain = new ScriptChain(mode);
  const hubKey = Keypair.generate();
  const hubMint = walletAddress();
  const hub: HubSetup = { keypair: hubKey, wallet: hubKey.publicKey.toBase58(), mint: hubMint };
  const ctx = (extra: Partial<EngineCtx> = {}): EngineCtx => ({ db, chain, mode, hub, now: T0, hourMs: HOUR, settleMs: 0, reserveSol: RESERVE, ...extra });
  let n = 0;
  async function addHive(o: HiveOpts): Promise<RemoteHive> {
    const { keypair, enc } = newKeypair();
    const queenWallet = keypair.publicKey.toBase58();
    if (o.withKey !== false) await db.putSecret(queenWallet, enc);
    const t = T0 - 48 * HOUR + ++n;
    const hive: RemoteHive = {
      ca: walletAddress(),
      name: `Hive ${n}`,
      ticker: `HV${n}`,
      image: '',
      cell: o.cell,
      queenWallet,
      ownerWallet: walletAddress(),
      rules: o.rules ?? DEFAULT_RULES,
      devBuy: 0,
      status: o.status ?? mode,
      honey: o.honey ?? 0,
      bees: 1,
      feesTotal: 0,
      royalJelly: 0,
      state: o.state ?? 'working',
      lastFeeAt: o.lastFeeAt ?? T0 - HOUR,
      createdAt: t,
      updatedAt: t,
    };
    await db.upsertHive(hive);
    chain.setSol(queenWallet, o.sol ?? 1);
    if (o.price) chain.prices.set(hive.ca, o.price);
    if (o.fees) chain.fees.set(queenWallet, Math.round(o.fees * 1e9));
    for (const [i, p] of (o.history ?? []).entries()) await db.addPrice(hive.ca, T0 - (i + 1) * HOUR, p);
    return hive;
  }
  return { db, chain, hub, hubMint, ctx, addHive };
}

afterEach(() => {
  setDbForTests(null);
  setChainForTests(null);
});

/* ================================================================== */
/* hourly                                                              */
/* ================================================================== */

describe('runHourly', () => {
  it('runs every queen’s hour (hub share, SEAL, STORE) and one failing hive does not stop the others', async () => {
    const w = world();
    // A: 11.8% under its 24h average -> seal. Her owner's dev-buy tokens sit in her wallet too.
    const a = await w.addHive({ cell: { q: 0, r: 0 }, price: 1e-6, fees: 0.1, history: [1.2e-6, 1.2e-6] });
    w.chain.setTokens(a.queenWallet, a.ca, 1_000_000_000n);
    // B: flat price -> store. C: the RPC fails on the claim.
    const b = await w.addHive({ cell: { q: 1, r: 0 }, price: 2e-6, fees: 0.05, history: [2e-6] });
    const c = await w.addHive({ cell: { q: 0, r: 1 }, price: 2e-6, fees: 0.05 });
    w.chain.fail = (op, info) => (op === 'collect' && info.from === c.queenWallet ? new Error('RPC down at https://rpc.example/?api-key=SECRET123') : undefined);

    const s = await runHourly(w.ctx());
    expect(s.skipped).toBeUndefined();
    expect(s.hour).toBe(HOUR_INDEX);
    expect(s.hives).toHaveLength(3);
    const res = (ca: string) => s.hives.find((h) => h.ca === ca)!;

    // C failed before sending anything; the error is logged without the API key
    expect(res(c.ca).ok).toBe(false);
    expect(res(c.ca).errors[0]).toContain('RPC down');
    expect(res(c.ca).errors[0]).not.toContain('SECRET123');
    expect(w.chain.sent.filter((x) => x.from === c.queenWallet)).toHaveLength(0);
    expect(w.db.actionsFor(c.ca)).toHaveLength(0);
    expect((await w.db.getHive(c.ca))!.lastFeeAt).toBe(T0 - HOUR);

    // A: 20% to the hub, then buy and burn exactly what the buy brought in
    const feesA = arrived(0.1);
    expect(res(a.ca)).toMatchObject({ ok: true, state: 'working', feesSol: expect.closeTo(feesA, 9) });
    const hubA = w.chain.sends('transferSol').find((x) => x.from === a.queenWallet)!;
    expect(hubA.to).toBe(w.hub.wallet);
    expect(Math.abs(hubA.lamports! - feesA * 0.2 * 1e9)).toBeLessThanOrEqual(1);
    const buyA = w.chain.sends('buy').find((x) => x.from === a.queenWallet)!;
    expect(buyA.mint).toBe(a.ca);
    expect(buyA.sol).toBeCloseTo(feesA * 0.8 * DEFAULT_RULES.burnShare, 9);
    const burnA = w.chain.sends('burn').find((x) => x.from === a.queenWallet)!;
    expect(burnA.amount).toBe(buyA.amount);
    expect(w.chain.tokenOf(a.queenWallet, a.ca)).toBe(1_000_000_000n); // the owner's tokens are untouched
    const sealA = w.db.actions.find((x) => x.id === `seal-${a.ca}-${HOUR_INDEX}`)!;
    expect(sealA).toMatchObject({ verb: 'seal', amount: expect.closeTo(buyA.sol!, 9), txSig: burnA.signature });
    expect(sealA.dryRun).toBeUndefined();
    expect(sealA.reason).toMatch(/^Price 11\.8% below 24h average\. 40% of the hour’s fees \(0\.032 SOL\) bought and burned, 60% stored\. .* tokens burned\. 20% \(0\.020 SOL\) went to the harvest\.$/);

    // B: everything stored, no trade
    expect(w.chain.sends('buy').some((x) => x.from === b.queenWallet)).toBe(false);
    const storeB = w.db.actions.find((x) => x.id === `store-${b.ca}-${HOUR_INDEX}`)!;
    expect(storeB.amount).toBeCloseTo(arrived(0.05) * 0.8, 9);
    expect(storeB.reason).toMatch(/^Price above 24h average\. Nothing to seal\. Fees stored as honey\./);
    expect(storeB.txSig).toBe(w.chain.sends('collect').find((x) => x.from === b.queenWallet)!.signature);

    // hive rows
    const ha = (await w.db.getHive(a.ca))!;
    expect(ha.feesTotal).toBeCloseTo(feesA, 9);
    expect(ha.lastFeeAt).toBe(T0);
    expect(ha.price).toBe(1e-6);
    expect(ha.honey).toBeCloseTo(w.chain.lamports(a.queenWallet) / 1e9 - RESERVE, 9);
    expect(ha.updatedAt).toBe(T0);

    // the hub got both shares; the hour is marked done
    expect(s.hubSentSol).toBeCloseTo((feesA + arrived(0.05)) * 0.2, 8);
    expect(w.chain.lamports(w.hub.wallet!) / 1e9).toBeCloseTo(s.hubSentSol, 8);
    expect(JSON.parse((await w.db.getMeta(ENGINE_META.lastHour('live', false)))!)).toEqual({ hour: HOUR_INDEX, hourMs: HOUR });
    const st = await readHiveState(w.db, a.ca);
    expect(st.real).toMatchObject({ hour: HOUR_INDEX, hourMs: HOUR, feesHour: feesA });
    expect(st).toMatchObject({ sealPending: null, open: null, outbox: [], claim: null, lastFeeAt: T0, feesTotal: expect.closeTo(feesA, 9) });
    expect(st.real.feeAvgHour).toBeCloseTo(feesA * 0.3, 12);
  });

  it('dry run sends nothing (not even the claim) and records the would-be amounts', async () => {
    const w = world();
    const a = await w.addHive({ cell: { q: 0, r: 0 }, price: 1e-6, fees: 0.1, history: [1.2e-6] });
    const b = await w.addHive({ cell: { q: 1, r: 0 }, price: 2e-6, fees: 0.05 });
    w.chain.prices.set(w.hubMint, 1e-5);

    const s = await runHourly(w.ctx({ dryRun: true }));
    const h = await runHarvest(w.ctx({ dryRun: true }));
    expect(w.chain.sent).toHaveLength(0);
    expect(w.chain.fees.get(a.queenWallet)).toBe(1e8); // still unclaimed

    const acts = w.db.actions;
    expect(acts.map((x) => x.verb).sort()).toEqual(['jelly', 'seal', 'store']);
    expect(acts.every((x) => x.dryRun === true && !x.txSig && x.id.startsWith('dry-'))).toBe(true);
    const seal = acts.find((x) => x.verb === 'seal')!;
    expect(seal).toMatchObject({ ca: a.ca, amount: expect.closeTo(0.1 * 0.8 * 0.4, 9) });
    expect(seal.reason).toMatch(/20% \(0\.020 SOL\) would go to the harvest\.$/);
    expect(acts.find((x) => x.verb === 'store')).toMatchObject({ ca: b.ca, amount: expect.closeTo(0.04, 9) });

    // a dry run does not count unclaimed fees as earned, but sees the activity
    const ha = (await w.db.getHive(a.ca))!;
    expect(ha.feesTotal).toBe(0);
    expect(ha.lastFeeAt).toBe(T0);
    expect(s.hubPlannedSol).toBeCloseTo(0.03, 9);
    expect(s.hubSentSol).toBe(0);

    // the harvest is computed from the share the queens would have sent
    expect(h.harvest).toMatchObject({ id: `dry-harvest-${HOUR_INDEX}`, dryRun: true, txSig: '', jellyTo: a.ca });
    expect(h.harvest!.feesIn).toBeCloseTo(0.03, 9);
    expect(h.harvest!.hiveBought).toBeCloseTo(3000, 6);
    expect(h.harvest!.burned).toBeCloseTo(1500, 6);
    expect(h.harvest!.jellySol).toBeCloseTo(0.015, 9);

    // next dry hour counts only the fees that appeared since
    w.chain.fees.set(a.queenWallet, 1e8 + 2e7);
    const s2 = await runHourly(w.ctx({ dryRun: true, now: T0 + HOUR }));
    expect(s2.hives.find((x) => x.ca === a.ca)!.feesSol).toBeCloseTo(0.02, 9);
    expect(s2.hives.find((x) => x.ca === b.ca)!.feesSol).toBe(0);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('runs once per hour: a repeat is skipped, and a run that died half-way never re-sends', async () => {
    const w = world();
    const a = await w.addHive({ cell: { q: 0, r: 0 }, price: 1e-6, fees: 0.1, history: [1.2e-6] });
    await w.addHive({ cell: { q: 1, r: 0 }, price: 2e-6, fees: 0.05 });
    await runHourly(w.ctx());
    const sent = w.chain.sent.length;
    expect(sent).toBe(6); // 2 claims, 2 hub transfers, A's buy and burn

    expect((await runHourly(w.ctx({ now: T0 + 59 * 60_000 }))).skipped).toBe('This hour already ran.');

    // as if the process died after the hives ran but before the hour was marked done
    w.db.meta.delete(ENGINE_META.lastHour('live', false));
    w.chain.fees.set(a.queenWallet, 5e7);
    const rerun = await runHourly(w.ctx({ now: T0 + 30 * 60_000 }));
    expect(rerun.hives.every((h) => h.skipped === 'Already ran this hour.')).toBe(true);
    expect(w.chain.sent).toHaveLength(sent);

    // a concurrent run is turned away
    await w.db.lock('engine:hourly', Date.now() + 60_000);
    expect((await runHourly(w.ctx({ now: T0 + HOUR }))).skipped).toBe('Another hourly run is in progress.');
    await w.db.unlock('engine:hourly');

    // the next hour runs
    const next = await runHourly(w.ctx({ now: T0 + HOUR }));
    expect(next.skipped).toBeUndefined();
    expect(w.chain.sends('collect')).toHaveLength(3);
  });

  it('swarms into the adjacent hive with the fastest fee growth and starts her cooldown', async () => {
    const w = world();
    const x = await w.addHive({ cell: { q: 0, r: 0 }, sol: 3, price: 2e-6, fees: 0.1, history: [1.5e-6] });
    const n1 = await w.addHive({ cell: { q: 1, r: 0 }, price: 1e-6 }); // adjacent, growth 100%
    const n2 = await w.addHive({ cell: { q: 0, r: 1 }, price: 1e-6 }); // adjacent, growth 0%
    const n3 = await w.addHive({ cell: { q: 2, r: 0 }, price: 1e-6 }); // 2 cells away, growth 1100%
    const state = (feesHour: number, feesPrevHour: number) =>
      JSON.stringify({ v: 1, hour: HOUR_INDEX - 1, feeAvgHour: 0.1, feesHour, feesPrevHour, lastSwarmAt: null, hubCarrySol: 0, sealPending: null, dryClaimable: 0, payout: null });
    await w.db.setMeta(ENGINE_META.hive(x.ca), state(0.1, 0.1));
    await w.db.setMeta(ENGINE_META.hive(n1.ca), state(0.2, 0.1));
    await w.db.setMeta(ENGINE_META.hive(n2.ca), state(0.1, 0.1));
    await w.db.setMeta(ENGINE_META.hive(n3.ca), state(0.6, 0.05));

    await runHourly(w.ctx());
    const buys = w.chain.sends('buy').filter((b) => b.from === x.queenWallet);
    expect(buys).toHaveLength(1);
    expect(buys[0].mint).toBe(n1.ca);
    const fees = arrived(0.1);
    const honey = 3 + fees - RESERVE - fees * 0.2 - TX;
    expect(buys[0].sol).toBeCloseTo(honey * DEFAULT_RULES.interactShare, 9);
    const act = w.db.actions.find((a) => a.verb === 'swarm')!;
    expect(act).toMatchObject({ ca: x.ca, targetCa: n1.ca, txSig: buys[0].signature, amount: expect.closeTo(buys[0].sol!, 9) });
    expect(act.reason).toContain(`buying ${n1.ticker}, the neighbor with the fastest fee growth (100%)`);
    expect((await readHiveState(w.db, x.ca)).real.lastSwarmAt).toBe(T0);
    void n2;
    void n3;
  });

  it('owes a hub share that certainly failed to send again next hour, but never re-sends one with an unknown outcome', async () => {
    const w = world();
    const a = await w.addHive({ cell: { q: 0, r: 0 }, price: 2e-6, fees: 0.1 });
    const b = await w.addHive({ cell: { q: 1, r: 0 }, price: 2e-6, fees: 0.1 });
    w.chain.fail = (op, info) => (op === 'transferSol' && info.from === a.queenWallet ? new TxError('blockhash expired', 'SIGA', false) : undefined);
    w.chain.after = (op, info) => (op === 'transferSol' && info.from === b.queenWallet ? new TxError('confirmation timed out', 'SIGB', undefined) : undefined);
    const s = await runHourly(w.ctx());
    expect(s.hives.every((h) => !h.ok)).toBe(true);
    expect((await readHiveState(w.db, a.ca)).real.hubCarrySol).toBeCloseTo(arrived(0.1) * 0.2, 9);
    expect((await readHiveState(w.db, b.ca)).real.hubCarrySol).toBe(0);
    expect(w.db.actions.find((x) => x.ca === a.ca)!.reason).toMatch(/could not be sent this hour/);

    w.chain.fail = null;
    w.chain.after = null;
    w.chain.fees.set(a.queenWallet, 1e8);
    w.chain.fees.set(b.queenWallet, 1e8);
    await runHourly(w.ctx({ now: T0 + HOUR }));
    const toHubA = w.chain.sends('transferSol').filter((x) => x.from === a.queenWallet);
    expect(toHubA).toHaveLength(1);
    expect(toHubA[0].lamports! / 1e9).toBeCloseTo(2 * arrived(0.1) * 0.2, 8);
    const toHubB = w.chain.sends('transferSol').filter((x) => x.from === b.queenWallet);
    expect(toHubB).toHaveLength(2);
    expect(toHubB[1].lamports! / 1e9).toBeCloseTo(arrived(0.1) * 0.2, 8);
    expect((await readHiveState(w.db, a.ca)).real.hubCarrySol).toBeCloseTo(0, 12);
  });

  it('keeps the hub share with the queen when no hub wallet is configured', async () => {
    const w = world();
    const none: HubSetup = { keypair: null, wallet: null, mint: null, problem: 'No hub wallet: queens keep the harvest share.' };
    const a = await w.addHive({ cell: { q: 0, r: 0 }, price: 2e-6, fees: 0.1 });
    const s = await runHourly(w.ctx({ hub: none }));
    expect(s.notes).toContain(none.problem);
    expect(w.chain.sends('transferSol')).toHaveLength(0);
    expect(w.db.actions[0].reason).toMatch(/No hub wallet is configured, so the 20% harvest share \(0\.020 SOL\) stays with the queen\./);
    expect((await w.db.getHive(a.ca))!.honey).toBeCloseTo(1 + arrived(0.1) - RESERVE, 9);

    // the harvest cannot run for real: it is recorded as a dry run with the share the queens kept
    const h = await runHarvest(w.ctx({ hub: none }));
    expect(w.chain.sends('buy')).toHaveLength(0);
    expect(h.harvest).toMatchObject({ dryRun: true, txSig: '', jellyTo: a.ca, hiveBought: 0 });
    expect(h.harvest!.feesIn).toBeCloseTo(arrived(0.1) * 0.2, 9);
  });

  it('burns what a timed-out seal buy bought, and never buys twice', async () => {
    const w = world();
    const a = await w.addHive({ cell: { q: 0, r: 0 }, price: 1e-6, fees: 0.1, history: [1.2e-6] });
    let tripped = false;
    w.chain.after = (op) => (op === 'buy' && !tripped ? ((tripped = true), new TxError('confirmation timed out', 'SIGT', undefined)) : undefined);
    await runHourly(w.ctx());
    expect(w.chain.sends('buy')).toHaveLength(1);
    expect(w.chain.sends('burn')).toHaveLength(1);
    expect(w.chain.sends('burn')[0].amount).toBe(w.chain.sends('buy')[0].amount);
    const seal = w.db.actions.find((x) => x.verb === 'seal')!;
    expect(seal.txSig).toBe(w.chain.sends('burn')[0].signature);
    expect((await readHiveState(w.db, a.ca)).sealPending).toBeNull();
  });

  it('a seal buy that shows up late is burned in a later hour; until then she does not seal again', async () => {
    const w = world();
    const a = await w.addHive({ cell: { q: 0, r: 0 }, price: 1e-6, fees: 0.1, history: [1.2e-6, 1.2e-6, 1.2e-6] });
    // hour 1: the buy times out before anything is visible
    w.chain.fail = (op) => (op === 'buy' ? new TxError('confirmation timed out', 'SIGT', undefined) : undefined);
    await runHourly(w.ctx());
    expect((await readHiveState(w.db, a.ca)).sealPending).not.toBeNull();
    expect(w.db.actions.find((x) => x.verb === 'store')!.reason).toMatch(/has not confirmed\. Fees stored as honey; anything it bought is burned once it shows up\./);

    // hour 2: still nothing; she stores instead of sealing again
    w.chain.fail = null;
    w.chain.fees.set(a.queenWallet, 1e8);
    await runHourly(w.ctx({ now: T0 + HOUR }));
    expect(w.chain.sends('buy')).toHaveLength(0);
    expect(w.db.actions.find((x) => x.id === `store-${a.ca}-${HOUR_INDEX + 1}`)!.reason).toMatch(/still settling/);

    // hour 3: the tokens arrived; exactly those are burned first, then she seals as usual
    w.chain.setTokens(a.queenWallet, a.ca, 12_345n);
    w.chain.fees.set(a.queenWallet, 1e8);
    await runHourly(w.ctx({ now: T0 + 2 * HOUR }));
    const burns = w.chain.sends('burn');
    expect(burns[0].amount).toBe(12_345n);
    expect(w.db.actions.find((x) => x.id === `seal-late-${a.ca}-${HOUR_INDEX + 2}`)!.reason).toMatch(/confirmed late/);
    expect(w.chain.sends('buy')).toHaveLength(1);
    expect(burns[1].amount).toBe(w.chain.sends('buy')[0].amount);
    expect(w.chain.tokenOf(a.queenWallet, a.ca)).toBe(0n);
  });

  it('refuses to act for a live queen without her key, but uses a stand-in on the mock chain', async () => {
    const live = world();
    const h = await live.addHive({ cell: { q: 0, r: 0 }, price: 2e-6, fees: 0.1, withKey: false });
    const s = await runHourly(live.ctx());
    expect(s.hives[0].errors[0]).toMatch(/key is missing/);
    expect(live.chain.sent).toHaveLength(0);
    void h;

    const mock = world('mock');
    await mock.addHive({ cell: { q: 0, r: 0 }, price: 2e-6, fees: 0.1, withKey: false });
    const m = await runHourly(mock.ctx());
    expect(m.hives[0].ok).toBe(true);
    expect(mock.chain.sends('collect')).toHaveLength(1);
  });

  it('never runs mock hives against a live chain, and leaves hives of the other mode alone', async () => {
    const w = world('mock');
    await expect(runHourly({ ...w.ctx(), chain: new ScriptChain('live') })).rejects.toThrow(/refuses/);
    const lw = world('live');
    const m = await lw.addHive({ cell: { q: 0, r: 0 }, price: 2e-6, fees: 0.1, status: 'mock' });
    const s = await runHourly(lw.ctx());
    expect(s.hives).toHaveLength(0);
    expect(lw.chain.sent).toHaveLength(0);
    void m;
  });
});

/* ================================================================== */
/* starving / abandon                                                  */
/* ================================================================== */

describe('starving and abandonment', () => {
  it('starves after 6 silent hours, revives on fees, and abandons after 24 with a pro-rata payout', async () => {
    const w = world();
    const silent = await w.addHive({ cell: { q: 0, r: 0 }, price: 1e-6, lastFeeAt: T0 - 7 * HOUR });
    const back = await w.addHive({ cell: { q: 1, r: 0 }, price: 2e-6, fees: 0.05, state: 'starving', lastFeeAt: T0 - 8 * HOUR });
    const gone = await w.addHive({ cell: { q: 0, r: 1 }, sol: 1.05, price: 1e-6, state: 'starving', lastFeeAt: T0 - 25 * HOUR });
    const whale = walletAddress();
    const minnow = walletAddress();
    w.chain.holderLists.set(gone.ca, {
      count: 4,
      top: [
        { owner: whale, amount: 300n },
        { owner: minnow, amount: 100n },
        { owner: pdaAddress('bonding-curve'), amount: 10_000n }, // the curve is not a holder
        { owner: gone.queenWallet, amount: 50n },
      ],
    });
    const unknown = await w.addHive({ cell: { q: -1, r: 0 }, sol: 0.55, price: 1e-6, state: 'starving', lastFeeAt: T0 - 30 * HOUR });

    await runHourly(w.ctx());

    expect((await w.db.getHive(silent.ca))!.state).toBe('starving');
    const starve = w.db.actionsFor(silent.ca);
    expect(starve.map((a) => a.verb)).toEqual(['starve']);
    expect(starve[0].reason).toBe('No fees for 6 consecutive hours. Bees are leaving and the hive is going grey.');

    expect((await w.db.getHive(back.ca))!.state).toBe('working');
    expect(w.db.actionsFor(back.ca).find((a) => a.id.startsWith('revive-'))!.reason).toBe('Fees are back. Bees return to the hive.');

    // 1.05 SOL - 0.05 reserve = 1 SOL, split 3:1 between the two wallets
    const pays = w.chain.sends('transferSol').filter((x) => x.from === gone.queenWallet);
    expect(pays.map((p) => [p.to, p.lamports])).toEqual([
      [whale, 750_000_000],
      [minnow, 250_000_000],
    ]);
    expect((await w.db.getHive(gone.ca))!.state).toBe('abandoned');
    const abandon = w.db.actions.find((a) => a.id === `abandon-${gone.ca}`)!;
    expect(abandon).toMatchObject({ verb: 'abandon', amount: 1, txSig: pays[0].signature });
    expect(abandon.reason).toBe('No fees for 24 hours. Hive abandoned. Vault of 1.00 SOL paid out pro-rata to 2 bees. The cell stays on the map as grey comb.');

    // no holder list: nothing sent and nothing settled. The vault stays owed, the hive stays in the
    // hourly run (starving) and the payout is tried again every hour; the log says why, once.
    expect(w.chain.sends('transferSol').some((x) => x.from === unknown.queenWallet)).toBe(false);
    expect((await w.db.getHive(unknown.ca))!.state).toBe('starving');
    expect(w.db.actions.find((a) => a.id === `abandon-${unknown.ca}`)).toBeUndefined();
    const waiting = w.db.actions.find((a) => a.id === `abandon-wait-${unknown.ca}`)!;
    expect(waiting).toMatchObject({ verb: 'starve', amount: 0 });
    expect(waiting.reason).toMatch(/vault of 0\.500 SOL is due to its bees pro-rata, but the holder list is not available here, so it stays in the queen wallet and the payout is tried again every hour/);
    expect((await readHiveState(w.db, unknown.ca)).payout).toBeNull();

    // abandoned hives are left alone from now on; the unpaid one is tried again
    const before = w.chain.sent.length;
    const next = await runHourly(w.ctx({ now: T0 + HOUR }));
    expect(next.hives.map((h) => h.ca).sort()).toEqual([silent.ca, back.ca, unknown.ca].sort());
    expect(w.chain.sent.length).toBe(before);
    expect(w.db.actions.filter((a) => a.id === `abandon-wait-${unknown.ca}`)).toHaveLength(1);

    // once the holder list is available, the vault is paid and the hive is abandoned
    const holder = walletAddress();
    w.chain.holderLists.set(unknown.ca, { count: 1, top: [{ owner: holder, amount: 5n }] });
    await runHourly(w.ctx({ now: T0 + 2 * HOUR }));
    expect(w.chain.sends('transferSol').filter((x) => x.from === unknown.queenWallet).map((x) => [x.to, x.lamports])).toEqual([[holder, 500_000_000]]);
    expect((await w.db.getHive(unknown.ca))!.state).toBe('abandoned');
  });

  it('an abandon payout that fails part-way pays only who is still owed, next hour', async () => {
    const w = world();
    const gone = await w.addHive({ cell: { q: 0, r: 0 }, sol: 1.05, price: 1e-6, state: 'starving', lastFeeAt: T0 - 25 * HOUR });
    const x = walletAddress();
    const y = walletAddress();
    w.chain.holderLists.set(gone.ca, { count: 2, top: [{ owner: x, amount: 1n }, { owner: y, amount: 1n }] });
    w.chain.fail = (op, info) => (op === 'transferSol' && info.to === y ? new TxError('failed on chain', 'SIGF', true) : undefined);
    await runHourly(w.ctx());
    expect((await w.db.getHive(gone.ca))!.state).toBe('starving');
    expect(w.db.actions.find((a) => a.verb === 'abandon')).toBeUndefined();

    w.chain.fail = null;
    // the holder list changed meanwhile: the frozen plan still applies
    w.chain.holderLists.set(gone.ca, { count: 1, top: [{ owner: walletAddress(), amount: 1n }] });
    await runHourly(w.ctx({ now: T0 + HOUR }));
    const pays = w.chain.sends('transferSol').filter((p) => p.from === gone.queenWallet);
    expect(pays.map((p) => [p.to, p.lamports])).toEqual([
      [x, 500_000_000],
      [y, 500_000_000],
    ]);
    expect((await w.db.getHive(gone.ca))!.state).toBe('abandoned');
    expect(w.db.actions.find((a) => a.verb === 'abandon')).toMatchObject({ amount: 1, reason: expect.stringContaining('pro-rata to 2 bees') });
  });

  it('a dry run records the abandonment it would do and changes nothing', async () => {
    const w = world();
    const gone = await w.addHive({ cell: { q: 0, r: 0 }, sol: 1.05, price: 1e-6, state: 'starving', lastFeeAt: T0 - 25 * HOUR });
    w.chain.holderLists.set(gone.ca, { count: 1, top: [{ owner: walletAddress(), amount: 1n }] });
    await runHourly(w.ctx({ dryRun: true }));
    expect(w.chain.sent).toHaveLength(0);
    expect((await w.db.getHive(gone.ca))!.state).toBe('starving');
    expect(w.db.actions.find((a) => a.verb === 'abandon')).toMatchObject({ id: `dry-abandon-${gone.ca}`, dryRun: true, amount: expect.closeTo(1, 9) });
  });

  it('planPayout: complete lists only, personal wallets only, dust skipped', () => {
    const a = walletAddress();
    const b = walletAddress();
    expect(planPayout(1e9, null, new Set()).why).toMatch(/not available/);
    expect(planPayout(1e9, { count: 5, top: [{ owner: a, amount: 1n }] }, new Set()).why).toMatch(/only 1 of its 5 bees/);
    expect(planPayout(MIN_PAYOUT_LAMPORTS - 1, { count: 1, top: [{ owner: a, amount: 1n }] }, new Set()).why).toMatch(/too small/);
    expect(planPayout(1e9, { count: 2, top: [{ owner: a, amount: 1n }, { owner: pdaAddress('x'), amount: 1n }] }, new Set()).recipients).toEqual([{ owner: a, lamports: 1e9 }]);
    expect(planPayout(1e9, { count: 1, top: [{ owner: a, amount: 1n }] }, new Set([a])).recipients).toEqual([]);
    // b's share (1/10001 of 0.01 SOL) is below the minimum and stays in the vault
    expect(planPayout(1e7, { count: 2, top: [{ owner: a, amount: 10_000n }, { owner: b, amount: 1n }] }, new Set()).recipients).toEqual([{ owner: a, lamports: Math.floor((1e7 * 10_000) / 10_001) }]);
  });
});

/* ================================================================== */
/* harvest                                                             */
/* ================================================================== */

describe('runHarvest', () => {
  async function setup() {
    const w = world();
    const big = await w.addHive({ cell: { q: 0, r: 0 }, honey: 5 });
    await w.addHive({ cell: { q: 1, r: 0 }, honey: 1 });
    await w.addHive({ cell: { q: 0, r: 1 }, honey: 50, state: 'abandoned' });
    await w.addHive({ cell: { q: -1, r: 0 }, honey: 9, state: 'starving' });
    await w.addHive({ cell: { q: 0, r: -1 }, honey: 100, status: 'mock' });
    w.chain.setSol(w.hub.wallet!, 1);
    w.chain.prices.set(w.hubMint, 1e-5);
    w.chain.setTokens(w.hub.wallet!, w.hubMint, 777_000_000n); // the hub's own $HIVE, never touched
    return { w, big };
  }

  it('buys $HIVE with the pool, burns half and sends half to the biggest working hive’s queen', async () => {
    const { w, big } = await setup();
    const s = await runHarvest(w.ctx());
    expect(s.errors).toEqual([]);
    const [buy] = w.chain.sends('buy');
    expect(buy).toMatchObject({ from: w.hub.wallet, mint: w.hubMint });
    expect(buy.sol).toBeCloseTo((1 - 0.01 - 3 * TX) / (1 + config.slippagePct / 100 + 0.02), 8);
    const bought = buy.amount!;
    const [burn] = w.chain.sends('burn');
    const [jelly] = w.chain.sends('transferTokens');
    expect(burn.amount).toBe(bought / 2n);
    expect(burn.amount! + jelly.amount!).toBe(bought);
    expect(jelly.to).toBe(big.queenWallet);
    expect(w.chain.tokenOf(w.hub.wallet!, w.hubMint)).toBe(777_000_000n);
    expect(w.chain.tokenOf(big.queenWallet, w.hubMint)).toBe(jelly.amount);

    const hv = w.db.harvests[0];
    expect(hv).toMatchObject({ id: `harvest-${HOUR_INDEX}`, at: T0, jellyTo: big.ca, txSig: buy.signature });
    expect(hv.dryRun).toBeUndefined();
    expect(hv.feesIn).toBeCloseTo(buy.sol!, 9);
    expect(hv.hiveBought).toBeCloseTo(Number(bought) / 1e6, 6);
    expect(hv.burned).toBeCloseTo(Number(burn.amount) / 1e6, 6);
    expect(hv.jellyAmount).toBeCloseTo(Number(jelly.amount) / 1e6, 6);
    expect(hv.jellySol).toBeCloseTo(buy.sol! * 0.5, 9);
    expect(s.harvest).toEqual(hv);

    const act = w.db.actions.find((a) => a.verb === 'jelly')!;
    expect(act).toMatchObject({ id: `jelly-harvest-${HOUR_INDEX}`, ca: big.ca, txSig: jelly.signature, amount: hv.jellySol });
    expect(act.reason).toBe('Harvest royal jelly: biggest hive by honey received 50% of the $HIVE bought this hour.');
    expect((await w.db.getHive(big.ca))!.royalJelly).toBeCloseTo(hv.jellySol, 9);

    const again = await runHarvest(w.ctx({ now: T0 + 10 * 60_000 }));
    expect(again.skipped).toMatch(/already ran/);
    expect(w.chain.sends('buy')).toHaveLength(1);
  });

  it('resumes after a burn that timed out without burning twice', async () => {
    const { w, big } = await setup();
    let tripped = false;
    w.chain.after = (op) => (op === 'burn' && !tripped ? ((tripped = true), new TxError('confirmation timed out', 'SIGB', undefined)) : undefined);
    const s1 = await runHarvest(w.ctx());
    expect(s1.pending).toMatch(/burn did not confirm/);
    expect(w.db.harvests).toHaveLength(0);

    // a minute later the burn may still land: nothing is sent or decided yet
    const wait = await runHarvest(w.ctx({ now: T0 + 60_000 }));
    expect(wait.pending).toMatch(/may still land/);
    expect(wait.harvest).toBeUndefined();
    expect(w.chain.sends('burn')).toHaveLength(1);
    expect(w.chain.sends('transferTokens')).toHaveLength(0);

    const s2 = await runHarvest(w.ctx({ now: T0 + UNSURE_SEND_SETTLE_MS }));
    expect(s2.harvest).toBeDefined();
    expect(w.chain.sends('buy')).toHaveLength(1);
    expect(w.chain.sends('burn')).toHaveLength(1);
    expect(w.chain.sends('transferTokens')).toHaveLength(1);
    expect(w.chain.tokenOf(w.hub.wallet!, w.hubMint)).toBe(777_000_000n);
    expect((await w.db.getHive(big.ca))!.royalJelly).toBeCloseTo(s2.harvest!.jellySol, 9);
  });

  it('retries a burn that certainly failed, and gives up on a buy that never arrives', async () => {
    const { w } = await setup();
    let failOnce = true;
    w.chain.fail = (op) => (op === 'burn' && failOnce ? ((failOnce = false), new TxError('failed on chain', 'SIGX', true)) : undefined);
    expect((await runHarvest(w.ctx())).pending).toBeDefined();
    const s2 = await runHarvest(w.ctx({ now: T0 + 60_000 }));
    expect(s2.harvest).toBeDefined();
    expect(w.chain.sends('burn')).toHaveLength(1);

    // a buy that timed out and never shows up
    const { w: w2 } = await setup();
    w2.chain.fail = (op) => (op === 'buy' ? new TxError('confirmation timed out', 'SIGT', undefined) : undefined);
    expect((await runHarvest(w2.ctx())).pending).toMatch(/Waiting/);
    w2.chain.fail = null;
    const late = await runHarvest(w2.ctx({ now: T0 + 3 * HOUR }));
    expect(late.errors[0]).toMatch(/never arrived/);
    expect(w2.chain.sends('buy')).toHaveLength(0);
    expect(await w2.db.getMeta(ENGINE_META.openHarvest('live'))).toBe('');
  });

  it('waits when the pool is too small or no hive can receive the jelly', async () => {
    const { w } = await setup();
    w.chain.setSol(w.hub.wallet!, 0.0105);
    expect((await runHarvest(w.ctx())).skipped).toBe('Nothing to harvest this hour.');
    const empty = world();
    empty.chain.setSol(empty.hub.wallet!, 1);
    expect((await runHarvest(empty.ctx())).skipped).toMatch(/No working hive/);
    expect(empty.chain.sent).toHaveLength(0);
  });
});

/* ================================================================== */
/* refresh                                                             */
/* ================================================================== */

describe('runRefresh', () => {
  it('honey from balance, bees from holders, a price point, starving from the last fee; writes only on change', async () => {
    const w = world();
    const a = await w.addHive({ cell: { q: 0, r: 0 }, sol: 0.55, price: 3e-6, lastFeeAt: T0 - 7 * HOUR });
    w.chain.holderLists.set(a.ca, { count: 42, top: [] });
    const b = await w.addHive({ cell: { q: 1, r: 0 }, sol: 0.3, lastFeeAt: T0 - HOUR }); // holders and price unknown
    const gone = await w.addHive({ cell: { q: 0, r: 1 }, sol: 2, state: 'abandoned' });

    const r = await runRefresh(w.ctx());
    expect(r).toMatchObject({ checked: 2, updated: 2, errors: [] });
    expect(await w.db.getHive(a.ca)).toMatchObject({ honey: 0.5, bees: 42, price: 3e-6, state: 'starving', updatedAt: T0 });
    expect(await w.db.listPrices(a.ca, 0)).toEqual([{ at: T0, price: 3e-6 }]);
    expect(w.db.actionsFor(a.ca).map((x) => x.verb)).toEqual(['starve']);
    const hb = (await w.db.getHive(b.ca))!;
    expect(hb).toMatchObject({ bees: 1, state: 'working' });
    expect(hb.honey).toBeCloseTo(0.25, 9);
    expect(hb.price).toBeUndefined();
    expect((await w.db.getHive(gone.ca))!.honey).toBe(0);

    const writes = w.db.upserts;
    const r2 = await runRefresh(w.ctx({ now: T0 + 5 * 60_000 }));
    expect(r2.updated).toBe(0);
    expect(w.db.upserts).toBe(writes);
    expect(w.db.actionsFor(a.ca)).toHaveLength(1);

    // the hourly run recording the same starvation does not log it twice
    await runHourly(w.ctx({ now: T0 + HOUR }));
    expect(w.db.actionsFor(a.ca).filter((x) => x.verb === 'starve')).toHaveLength(1);
  });

  it('reports a hive the chain cannot answer for and carries on', async () => {
    const w = world();
    const a = await w.addHive({ cell: { q: 0, r: 0 }, sol: 0.55 });
    const b = await w.addHive({ cell: { q: 1, r: 0 }, sol: 0.55 });
    w.chain.fail = (op, info) => ((info.from === a.queenWallet || info.mint === a.ca) && op !== 'tokenBalance' ? new Error('timeout') : undefined);
    const r = await runRefresh(w.ctx());
    expect(r.errors.map((e) => e.ca)).toEqual([a.ca]);
    expect((await w.db.getHive(b.ca))!.honey).toBeCloseTo(0.5, 9);
  });
});

/* ================================================================== */
/* mock mode end to end                                                */
/* ================================================================== */

describe('mock mode', () => {
  it('runs the same engine against MockChain, with an in-memory hub', async () => {
    let clock = T0;
    const chain = new MockChain({ seed: 42, now: () => clock });
    const db = new EngineMemDb();
    const cells = [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 0, r: 1 },
    ];
    const devTokens = new Map<string, bigint>();
    for (const [i, cell] of cells.entries()) {
      // launched like lib/server/launch.ts does in mock mode: paid, then created as creator
      const { keypair, enc } = newKeypair();
      const mint = Keypair.generate();
      const queenWallet = keypair.publicKey.toBase58();
      await db.putSecret(queenWallet, enc);
      await chain.verifyPayment(`mock-payment-${i}`, 'guest:abcdef', queenWallet, Math.round((0.02 + 0.05 + 2) * 1e9), T0);
      await chain.createCoin({ creator: keypair, mint, name: `Mock ${i}`, symbol: `MK${i}`, uri: 'ipfs://x', devBuySol: 0.5 });
      await chain.collectCreatorFees(keypair); // starts the mock fee clock
      const ca = mint.publicKey.toBase58();
      devTokens.set(ca, (await chain.tokenBalance(queenWallet, ca)).amount);
      await db.upsertHive({ ca, name: `Mock ${i}`, ticker: `MK${i}`, image: '', cell, queenWallet, ownerWallet: 'guest:abcdef', devBuy: 0.5, status: 'mock', honey: 0, bees: 1, feesTotal: 0, royalJelly: 0, state: 'working', lastFeeAt: T0, createdAt: T0 + i, updatedAt: T0 });
    }
    for (let h = 1; h <= 12; h++) {
      clock = T0 + h * HOUR_MS;
      const ctx: EngineCtx = { db, chain, mode: 'mock', now: clock };
      const s = await runHourly(ctx);
      expect(s.skipped).toBeUndefined();
      expect(s.hives.flatMap((x) => x.errors)).toEqual([]);
      const hv = await runHarvest(ctx);
      expect(hv.errors).toEqual([]);
      const r = await runRefresh({ ...ctx, now: clock + 20_000 });
      expect(r.errors).toEqual([]);
    }
    expect(db.actions.some((a) => a.verb === 'store' || a.verb === 'seal')).toBe(true);
    expect(db.actions.every((a) => !a.dryRun)).toBe(true);
    expect(db.harvests.length).toBeGreaterThan(0);
    expect(db.harvests.every((h) => !h.dryRun && h.txSig && h.jellyTo)).toBe(true);
    // dev-buy tokens are the owner's: every seal burned exactly what it bought, so they are all still there
    for (const hive of await db.listHives()) {
      expect(devTokens.get(hive.ca)).toBeGreaterThan(0n);
      expect((await chain.tokenBalance(hive.queenWallet, hive.ca)).amount).toBe(devTokens.get(hive.ca));
    }
    // the mock hub's 20% arrived and was harvested
    expect(db.actions.some((a) => a.verb === 'jelly' && !a.dryRun)).toBe(true);
  });
});

/* ================================================================== */
/* cron + autorun helpers                                              */
/* ================================================================== */

describe('cron helpers and the mock ticker gate', () => {
  it('cronAuth: bearer secret when set; without one, mock mode only', () => {
    expect(cronAuth(null, { secret: undefined, mode: 'mock' })).toEqual({ ok: true });
    expect(cronAuth(null, { secret: undefined, mode: 'live' })).toMatchObject({ ok: false, status: 401 });
    expect(cronAuth('Bearer s3cret', { secret: 's3cret', mode: 'live' })).toEqual({ ok: true });
    expect(cronAuth('Bearer nope', { secret: 's3cret', mode: 'mock' })).toMatchObject({ ok: false, status: 401 });
    expect(cronAuth(null, { secret: 's3cret', mode: 'mock' })).toMatchObject({ ok: false, status: 401 });
  });

  it('cronDryRun: live follows ENGINE_DRY_RUN, mock sends, ?dryRun=1 always forces a dry run', () => {
    expect(cronDryRun(new URL('http://x/api/cron/hourly'), 'mock')).toBe(false);
    expect(cronDryRun(new URL('http://x/api/cron/hourly?dryRun=1'), 'mock')).toBe(true);
    expect(cronDryRun(new URL('http://x/api/cron/hourly'), 'live')).toBe(config.engineDryRun);
  });

  it('the ticker only runs in mock mode on a long-lived Node server', () => {
    expect(autorunBlockedReason({ NEXT_RUNTIME: 'nodejs' }, 'mock')).toBeNull();
    expect(autorunBlockedReason({ NEXT_RUNTIME: 'nodejs' }, 'live')).toMatch(/live/);
    expect(autorunBlockedReason({ NEXT_RUNTIME: 'nodejs', ENGINE_AUTORUN: '0' }, 'mock')).toMatch(/ENGINE_AUTORUN/);
    expect(autorunBlockedReason({ NEXT_RUNTIME: 'edge' }, 'mock')).toMatch(/Node/);
    expect(autorunBlockedReason({ NEXT_RUNTIME: 'nodejs', VERCEL: '1' }, 'mock')).toMatch(/serverless/);
    expect(autorunBlockedReason({ NEXT_RUNTIME: 'nodejs', NEXT_PHASE: 'phase-production-build' }, 'mock')).toMatch(/build/);
  });

  it('safeErr strips URL queries and keys', () => {
    expect(safeErr(new Error('fetch failed https://mainnet.helius-rpc.com/?api-key=abc123 (x)'))).toBe('fetch failed https://mainnet.helius-rpc.com/?… (x)');
    expect(safeErr('bad token=xyz')).toBe('bad token=…');
  });

  it('the cron routes authorise, run hourly + harvest, and answer with a JSON summary', async () => {
    const w = world('mock');
    await w.addHive({ cell: { q: 0, r: 0 }, price: 2e-6, fees: 0.1 });
    w.chain.prices.set(theme.hubToken.ca, 1e-5); // the mock hub buys the theme's mock $HIVE
    setDbForTests(w.db);
    setChainForTests(w.chain);
    const hourly = await import('@/app/api/cron/hourly/route');
    const refresh = await import('@/app/api/cron/refresh/route');
    expect(hourly.maxDuration).toBe(300);

    const prev = config.cronSecret;
    try {
      config.cronSecret = 's3cret';
      expect((await hourly.GET(new Request('http://x/api/cron/hourly'))).status).toBe(401);
      const res = await hourly.POST(new Request('http://x/api/cron/hourly', { method: 'POST', headers: { authorization: 'Bearer s3cret' } }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; dryRun: boolean; hourly: { hives: unknown[] }; harvest: { mode: string; errors: string[] } };
      expect(body.harvest.errors).toEqual([]);
      expect(body).toMatchObject({ ok: true, dryRun: false });
      expect(body.hourly.hives).toHaveLength(1);
      expect(body.harvest.mode).toBe('mock');
      const rf = await refresh.GET(new Request('http://x/api/cron/refresh', { headers: { authorization: 'Bearer s3cret' } }));
      expect(rf.status).toBe(200);
      expect(((await rf.json()) as { refresh: { checked: number } }).refresh.checked).toBe(1);
    } finally {
      config.cronSecret = prev;
    }
  });
});

/* ================================================================== */
/* review fixes: hour marks, the engine's own record, claims,          */
/* recording, time budget, dry runs                                    */
/* ================================================================== */

describe('hour marks', () => {
  it('a mock run on the same database never blocks the live hour or harvest (marks are per mode)', async () => {
    const w = world('live');
    // a mock deployment ran its cron on this database first (60 s hours: a far bigger hour index)
    const mockChain = new ScriptChain('mock');
    await runHourly({ db: w.db, chain: mockChain, mode: 'mock', hub: w.hub, now: T0, settleMs: 0 });
    await runHarvest({ db: w.db, chain: mockChain, mode: 'mock', hub: w.hub, now: T0, settleMs: 0 });
    expect(await w.db.getMeta(ENGINE_META.lastHour('mock', false))).not.toBeNull();
    expect(await w.db.getMeta(ENGINE_META.lastHarvestHour('mock', false))).not.toBeNull();

    // then LAUNCH_MODE=live
    await w.addHive({ cell: { q: 0, r: 0 }, price: 2e-6, fees: 0.1, honey: 1 });
    w.chain.setSol(w.hub.wallet!, 1);
    w.chain.prices.set(w.hubMint, 1e-5);
    const later = T0 + 30 * 24 * HOUR;
    const s = await runHourly(w.ctx({ now: later }));
    expect(s.skipped).toBeUndefined();
    expect(w.chain.sends('collect')).toHaveLength(1);
    const h = await runHarvest(w.ctx({ now: later }));
    expect(h.skipped).toBeUndefined();
    expect(h.harvest).toBeDefined();
    expect(w.chain.sends('buy').filter((b) => b.mint === w.hubMint)).toHaveLength(1);
  });

  it('a mark written with another hour length blocks at most the hour it covers', async () => {
    const w = world('live');
    const a = await w.addHive({ cell: { q: 0, r: 0 }, price: 2e-6, fees: 0.1 });
    const later = T0 + 5 * HOUR + 30 * 60_000;
    // e.g. written by a build with 60 s hours: index ~60× bigger, but its start time is what counts
    await w.db.setMeta(ENGINE_META.lastHour('live', false), JSON.stringify({ hour: Math.floor(later / 60_000), hourMs: 60_000 }));
    expect((await runHourly(w.ctx({ now: later }))).skipped).toBe('This hour already ran.');
    const next = await runHourly(w.ctx({ now: later + HOUR }));
    expect(next.skipped).toBeUndefined();
    expect(w.chain.sends('collect').filter((x) => x.from === a.queenWallet)).toHaveLength(1);
  });
});

/** Gates the refresh's read of a hive row until the hourly run has written it (a lost-update race). */
class RaceDb extends EngineMemDb {
  armed = false;
  private opened = false;
  private open!: () => void;
  private gate = new Promise<void>((r) => (this.open = r));
  async getHive(ca: string) {
    const fromRefresh = /refreshHive/.test(new Error().stack ?? '');
    const v = await super.getHive(ca);
    if (this.armed && fromRefresh && !this.opened) await this.gate;
    return v;
  }
  async upsertHive(h: RemoteHive) {
    await super.upsertHive(h);
    if (this.armed && (h.lastFeeAt ?? 0) >= T0) {
      this.opened = true;
      this.open();
    }
  }
}

describe('the engine’s own record decides starving and abandonment', () => {
  async function revivedHive(db?: EngineMemDb) {
    const w = world();
    const wdb = db ?? w.db;
    const ctx = (extra: Partial<EngineCtx> = {}) => w.ctx({ db: wdb, ...extra });
    const { keypair, enc } = newKeypair();
    const queenWallet = keypair.publicKey.toBase58();
    await wdb.putSecret(queenWallet, enc);
    const hive: RemoteHive = { ca: walletAddress(), name: 'Hive', ticker: 'HV', image: '', cell: { q: 0, r: 0 }, queenWallet, ownerWallet: walletAddress(), rules: DEFAULT_RULES, devBuy: 0, status: 'live', honey: 0, bees: 2, feesTotal: 0, royalJelly: 0, state: 'starving', lastFeeAt: T0 - 23 * HOUR, createdAt: T0 - 48 * HOUR, updatedAt: T0 - 48 * HOUR };
    await wdb.upsertHive(hive);
    w.chain.setSol(queenWallet, 1);
    w.chain.prices.set(hive.ca, 1e-6);
    w.chain.fees.set(queenWallet, 1e9); // fees are back this hour
    const holderA = walletAddress();
    const holderB = walletAddress();
    w.chain.holderLists.set(hive.ca, { count: 2, top: [{ owner: holderA, amount: 100n }, { owner: holderB, amount: 50n }] });
    const payouts = () => w.chain.sends('transferSol').filter((s) => s.to === holderA || s.to === holderB);
    return { w, db: wdb, ctx, hive, payouts };
  }

  it('a stale row written back by a refresh neither abandons the hive nor loses its fees', async () => {
    const { w, ctx, hive, payouts } = await revivedHive();
    await runHourly(ctx());
    const row = (await w.db.getHive(hive.ca))!;
    expect(row).toMatchObject({ state: 'working', lastFeeAt: T0, feesTotal: expect.closeTo(arrived(1), 9) });
    expect(w.db.actions.some((a) => a.id === `revive-${hive.ca}-${HOUR_INDEX}`)).toBe(true);

    // a refresh that read the row before the hourly run wrote it puts the old one back
    await w.db.upsertHive({ ...row, lastFeeAt: T0 - 23 * HOUR, feesTotal: 0, state: 'starving' });
    // next hour, no fees: 24 h since the row's last fee, but the engine saw fees an hour ago
    const s = await runHourly(ctx({ now: T0 + HOUR }));
    expect(s.hives[0].state).toBe('working');
    expect(payouts()).toHaveLength(0);
    expect(await w.db.getHive(hive.ca)).toMatchObject({ state: 'working', lastFeeAt: T0, feesTotal: expect.closeTo(arrived(1), 9) });

    // the refresh restores them from the engine's record too
    const cur = (await w.db.getHive(hive.ca))!;
    await w.db.upsertHive({ ...cur, lastFeeAt: T0 - 23 * HOUR, feesTotal: 0, state: 'starving' });
    const r = await runRefresh(ctx({ now: T0 + HOUR + 60_000 }));
    expect(r.updated).toBe(1);
    expect(await w.db.getHive(hive.ca)).toMatchObject({ state: 'working', lastFeeAt: T0, feesTotal: expect.closeTo(arrived(1), 9) });
  });

  it('a refresh racing the hourly run cannot revert it into a wrongful abandon payout', async () => {
    const db = new RaceDb();
    const { ctx, hive, payouts } = await revivedHive(db);
    db.armed = true;
    await Promise.all([runRefresh(ctx({ now: T0 + 5 })), runHourly(ctx({ now: T0 + 10 }))]);
    db.armed = false;
    expect(await db.getHive(hive.ca)).toMatchObject({ state: 'working', lastFeeAt: T0 + 10, feesTotal: expect.closeTo(arrived(1), 9) });
    await runHourly(ctx({ now: T0 + HOUR + 10 }));
    expect((await db.getHive(hive.ca))!.state).toBe('working');
    expect(payouts()).toHaveLength(0);
  });

  it('the refresh leaves rows alone while the hourly run is writing them; the run clears its flag', async () => {
    const w = world();
    const a = await w.addHive({ cell: { q: 0, r: 0 }, sol: 0.55, lastFeeAt: T0 - 7 * HOUR });
    await w.db.setMeta(ENGINE_META.busy('live', 'hourly'), String(Date.now() + 60_000));
    expect(await runRefresh(w.ctx())).toMatchObject({ checked: 1, updated: 0, deferred: 1 });
    expect((await w.db.getHive(a.ca))!.state).toBe('working');
    await w.db.setMeta(ENGINE_META.busy('live', 'hourly'), '');
    expect(await runRefresh(w.ctx())).toMatchObject({ updated: 1, deferred: 0 });

    await runHourly(w.ctx({ now: T0 + HOUR }));
    expect(await w.db.getMeta(ENGINE_META.busy('live', 'hourly'))).toBe('');
  });
});

describe('fees claimed are never lost', () => {
  it('a token balance that cannot be read blocks only the seal: the hour is booked and the hub gets its share', async () => {
    const w = world();
    const a = await w.addHive({ cell: { q: 0, r: 0 }, price: 1e-6, fees: 1, history: [1.2e-6, 1.2e-6] });
    w.chain.fail = (op, info) => (op === 'tokenBalance' && info.from === a.queenWallet ? new Error('fetch failed: 503 from https://rpc.example/?api-key=x') : undefined);
    const s = await runHourly(w.ctx());
    const r = s.hives[0];
    expect(r.errors[0]).toMatch(/^seal baseline: fetch failed: 503/);
    expect(r.errors[0]).not.toContain('api-key=x');
    expect(w.chain.sends('buy')).toHaveLength(0);
    const hub = w.chain.sends('transferSol');
    expect(hub).toHaveLength(1);
    expect(hub[0].lamports! / 1e9).toBeCloseTo(arrived(1) * 0.2, 8);
    const store = w.db.actions.find((x) => x.id === `store-${a.ca}-${HOUR_INDEX}`)!;
    expect(store.reason).toMatch(/^Price 11\.8% below 24h average, but her token balance could not be read\. Fees stored as honey\. 20% \(0\.200 SOL\) went to the harvest\.$/);
    expect(store.amount).toBeCloseTo(arrived(1) * 0.8, 9);
    const st = await readHiveState(w.db, a.ca);
    expect(st).toMatchObject({ claim: null, sealPending: null, feesTotal: expect.closeTo(arrived(1), 9) });
  });

  it('a claim that lands but times out is counted on the next run, with the hub’s 20%', async () => {
    const w = world();
    const a = await w.addHive({ cell: { q: 0, r: 0 }, price: 2e-6, fees: 1 });
    let tripped = false;
    w.chain.after = (op) => (op === 'collect' && !tripped ? ((tripped = true), new TxError('Transaction not confirmed in time.', 'SIGC', undefined)) : undefined);
    const s1 = await runHourly(w.ctx());
    expect(s1.hives[0]).toMatchObject({ ok: false, errors: ['fee claim: Transaction not confirmed in time.'] });
    expect(s1.hives[0].notes).toContain('The fee claim has not confirmed; its fees are counted on the next run.');
    expect(w.chain.sends('transferSol')).toHaveLength(0);
    const st1 = await readHiveState(w.db, a.ca);
    expect(st1.claim).toMatchObject({ before: 1e9, tx: 'SIGC' });
    expect(st1.real.hour).toBe(-1); // the hour was not booked

    w.chain.fees.set(a.queenWallet, 5e8); // and half a SOL more this hour
    const s2 = await runHourly(w.ctx({ now: T0 + HOUR }));
    const fees = arrived(1) + arrived(0.5);
    expect(s2.hives[0].feesSol).toBeCloseTo(fees, 9);
    const hub = w.chain.sends('transferSol');
    expect(hub).toHaveLength(1);
    expect(hub[0].lamports! / 1e9).toBeCloseTo(fees * 0.2, 8);
    expect((await w.db.getHive(a.ca))!).toMatchObject({ feesTotal: expect.closeTo(fees, 9), lastFeeAt: T0 + HOUR });
    expect((await readHiveState(w.db, a.ca)).claim).toBeNull();
  });

  it('an RPC error after the claim: the hive reports it and the next run counts those fees', async () => {
    const w = world();
    const a = await w.addHive({ cell: { q: 0, r: 0 }, price: 2e-6, fees: 1 });
    let claimed = false;
    let broken = true;
    w.chain.after = (op) => ((claimed ||= op === 'collect'), undefined);
    w.chain.fail = (op, info) => (op === 'balance' && info.from === a.queenWallet && claimed && broken ? new Error('503') : undefined);
    const s1 = await runHourly(w.ctx());
    expect(s1.hives[0]).toMatchObject({ ok: false, errors: ['503'] });
    expect(w.chain.sends('collect')).toHaveLength(1);
    broken = false;
    const s2 = await runHourly(w.ctx({ now: T0 + HOUR }));
    expect(s2.hives[0].feesSol).toBeCloseTo(arrived(1), 9);
    expect(w.chain.sends('transferSol')[0].lamports! / 1e9).toBeCloseTo(arrived(1) * 0.2, 8);
  });
});

describe('recording an hour', () => {
  it('a failed row write still records the hour’s actions; the next refresh fixes the row', async () => {
    const w = world();
    const a = await w.addHive({ cell: { q: 0, r: 0 }, price: 1e-6, fees: 1, history: [1.2e-6, 1.2e-6] });
    let failed = false;
    w.db.fail = (op) => (op === 'upsertHive' && !failed ? ((failed = true), new Error('upsertHive: 503 from supabase')) : undefined);
    const s = await runHourly(w.ctx());
    expect(s.hives[0].errors).toEqual(['saving the hive: upsertHive: 503 from supabase']);
    expect(w.chain.sent.map((x) => x.op)).toEqual(['collect', 'transferSol', 'buy', 'burn']);
    const seal = w.db.actions.find((x) => x.id === `seal-${a.ca}-${HOUR_INDEX}`)!;
    expect(seal.txSig).toBe(w.chain.sends('burn')[0].signature);
    expect((await w.db.getHive(a.ca))!.feesTotal).toBe(0); // the write that failed

    w.db.fail = null;
    await runRefresh(w.ctx({ now: T0 + 60_000 }));
    expect(await w.db.getHive(a.ca)).toMatchObject({ feesTotal: expect.closeTo(arrived(1), 9), lastFeeAt: T0 });
  });

  it('feed entries that cannot be written wait in the outbox for the next run', async () => {
    const w = world();
    const a = await w.addHive({ cell: { q: 0, r: 0 }, price: 2e-6, fees: 0.1 });
    w.db.fail = (op) => (op === 'addAction' ? new Error('actions table down') : undefined);
    await runHourly(w.ctx());
    expect(w.db.actions).toHaveLength(0);
    expect((await readHiveState(w.db, a.ca)).outbox.map((x) => x.id)).toEqual([`store-${a.ca}-${HOUR_INDEX}`]);
    w.db.fail = null;
    await runHourly(w.ctx({ now: T0 + HOUR }));
    expect(w.db.actions.map((x) => x.id)).toContain(`store-${a.ca}-${HOUR_INDEX}`);
    expect((await readHiveState(w.db, a.ca)).outbox).toEqual([]);
  });

  it('a run that dies after the seal buy is recorded by the next run, which burns what it bought; nothing is sent twice', async () => {
    const w = world();
    const a = await w.addHive({ cell: { q: 0, r: 0 }, price: 1e-6, fees: 1, history: [1.2e-6, 1.2e-6, 1.2e-6] });
    let bought = false;
    let dead = true;
    w.chain.after = (op, info) => ((bought ||= op === 'buy' && info.mint === a.ca), undefined);
    // the process dies at the first save after the buy
    w.db.fail = (op, key) => (op === 'setMeta' && key === ENGINE_META.hive(a.ca) && bought && dead ? new Error('process killed') : undefined);
    const s1 = await runHourly(w.ctx());
    expect(s1.hives[0].errors).toEqual(['process killed']);
    expect(w.chain.sent.map((x) => x.op)).toEqual(['collect', 'transferSol', 'buy']);
    expect(w.db.actions).toHaveLength(0);
    expect((await readHiveState(w.db, a.ca)).open).not.toBeNull();

    dead = false;
    await runHourly(w.ctx({ now: T0 + HOUR }));
    expect(w.chain.sends('buy')).toHaveLength(1);
    expect(w.chain.sends('transferSol')).toHaveLength(1);
    expect(w.chain.sends('burn')).toHaveLength(1);
    expect(w.chain.sends('burn')[0].amount).toBe(w.chain.sends('buy')[0].amount);
    const stale = w.db.actions.find((x) => x.id === `store-${a.ca}-${HOUR_INDEX}`)!;
    expect(stale.reason).toMatch(/but the seal buy has not confirmed\. Fees stored as honey; anything it bought is burned once it shows up\. 20% \(0\.200 SOL\) went to the harvest\.$/);
    expect(w.db.actions.find((x) => x.id === `seal-late-${a.ca}-${HOUR_INDEX + 1}`)).toBeDefined();
    const st = await readHiveState(w.db, a.ca);
    expect(st).toMatchObject({ open: null, outbox: [], sealPending: null });
  });

  it('a run that dies during a swarm buy keeps her cooldown: no second swarm', async () => {
    const w = world();
    const rules = { ...DEFAULT_RULES, cooldownH: 6 };
    const x = await w.addHive({ cell: { q: 0, r: 0 }, sol: 3, price: 2e-6, fees: 0.1, history: [1.5e-6], rules });
    const n = await w.addHive({ cell: { q: 1, r: 0 }, price: 1e-6 });
    const state = JSON.stringify({ v: 2, real: { hour: HOUR_INDEX - 1, hourMs: HOUR, feeAvgHour: 0.1, feesHour: 0.1, feesPrevHour: 0.1, lastSwarmAt: null, hubCarrySol: 0 } });
    await w.db.setMeta(ENGINE_META.hive(x.ca), state);
    let swarmed = false;
    w.chain.after = (op, info) => ((swarmed ||= op === 'buy' && info.mint === n.ca), undefined);
    w.db.fail = (op, key) => (op === 'setMeta' && key === ENGINE_META.hive(x.ca) && swarmed ? new Error('process killed') : undefined);
    await runHourly(w.ctx());
    expect(w.chain.sends('buy')).toHaveLength(1);
    w.db.fail = null;

    w.chain.fees.set(x.queenWallet, 1e8);
    await runHourly(w.ctx({ now: T0 + HOUR }));
    expect(w.chain.sends('buy')).toHaveLength(1);
    const act = w.db.actions.find((a) => a.id === `swarm-${x.ca}-${HOUR_INDEX}`)!;
    expect(act).toMatchObject({ verb: 'swarm', targetCa: n.ca });
    expect(act.reason).toMatch(/The buy has not confirmed yet\.$/);
    expect((await readHiveState(w.db, x.ca)).real.lastSwarmAt).toBe(T0);
  });
});

describe('time budget', () => {
  it('no send starts that could run past the deadline: the hub share is owed, the seal waits', async () => {
    const w = world();
    const a = await w.addHive({ cell: { q: 0, r: 0 }, price: 1e-6, fees: 1, history: [1.2e-6, 1.2e-6] });
    let clock = 1_000_000;
    const timing = { clock: () => clock, deadline: 1_000_000 + 100_000, sendWindowMs: 50_000 };
    w.chain.after = (op) => (op === 'collect' && (clock += 60_000), undefined); // a slow claim
    const s = await runHourly(w.ctx(timing));
    expect(s.incomplete).toBeUndefined();
    expect(w.chain.sent.map((x) => x.op)).toEqual(['collect']);
    const st = await readHiveState(w.db, a.ca);
    expect(st.real.hubCarrySol).toBeCloseTo(arrived(1) * 0.2, 9);
    expect(st.sealPending).toBeNull();
    const store = w.db.actions.find((x) => x.id === `store-${a.ca}-${HOUR_INDEX}`)!;
    expect(store.reason).toMatch(/but this run ran out of time before the seal buy\. Fees stored as honey\. The 20% harvest share \(0\.200 SOL\) could not be sent this hour; it follows next hour\.$/);

    // next hour, with time: the owed share goes out with that hour's
    w.chain.after = null;
    w.chain.fees.set(a.queenWallet, 1e8);
    await runHourly(w.ctx({ now: T0 + HOUR }));
    expect(w.chain.sends('transferSol')[0].lamports! / 1e9).toBeCloseTo((arrived(1) + arrived(0.1)) * 0.2, 8);
  });

  it('hives that cannot finish in time are left for the next call, and the hour stays open', async () => {
    const w = world();
    await w.addHive({ cell: { q: 0, r: 0 }, price: 2e-6, fees: 0.1 });
    const s = await runHourly(w.ctx({ clock: () => 0, deadline: 10_000, sendWindowMs: 50_000 }));
    expect(s.incomplete).toBe(true);
    expect(s.hives[0].skipped).toMatch(/Out of time/);
    expect(w.chain.sent).toHaveLength(0);
    expect(await w.db.getMeta(ENGINE_META.lastHour('live', false))).toBeNull();
    expect((await runHourly(w.ctx({ now: T0 + 60_000 }))).hives[0].ok).toBe(true);
  });

  it('a harvest step that would not fit waits for the next run', async () => {
    const w = world();
    await w.addHive({ cell: { q: 0, r: 0 }, honey: 5 });
    w.chain.setSol(w.hub.wallet!, 1);
    w.chain.prices.set(w.hubMint, 1e-5);
    let clock = 0;
    w.chain.after = (op) => (op === 'buy' && (clock += 60_000), undefined);
    const s1 = await runHarvest(w.ctx({ clock: () => clock, deadline: 100_000, sendWindowMs: 50_000 }));
    expect(s1.pending).toMatch(/Out of time in this run: the burn follows next run/);
    w.chain.after = null;
    const s2 = await runHarvest(w.ctx({ now: T0 + 60_000 }));
    expect(s2.harvest).toBeDefined();
    expect(w.chain.sends('buy')).toHaveLength(1);
    expect(w.chain.sends('burn')).toHaveLength(1);
    expect(w.chain.sends('transferTokens')).toHaveLength(1);
  });
});

describe('dry runs keep their own books', () => {
  it('a forced dry run never uses up the real hour or its harvest, and does not touch the real averages', async () => {
    const w = world();
    const a = await w.addHive({ cell: { q: 0, r: 0 }, price: 2e-6, fees: 0.1, honey: 1 });
    w.chain.setSol(w.hub.wallet!, 1);
    w.chain.prices.set(w.hubMint, 1e-5);
    const dry = await runHourly(w.ctx({ now: T0 + 1_000, dryRun: true }));
    expect(dry.hives[0].feesSol).toBeCloseTo(0.1, 9);
    expect((await runHarvest(w.ctx({ now: T0 + 2_000, dryRun: true }))).harvest?.dryRun).toBe(true);
    expect(w.chain.sent).toHaveLength(0);

    const real = await runHourly(w.ctx({ now: T0 + 60_000 }));
    expect(real.skipped).toBeUndefined();
    expect(w.chain.sends('collect')).toHaveLength(1);
    const st = await readHiveState(w.db, a.ca);
    expect(st.real).toMatchObject({ hour: HOUR_INDEX, feesHour: arrived(0.1) });
    expect(st.real.feeAvgHour).toBeCloseTo(arrived(0.1) * 0.3, 12); // the dry preview was not counted twice
    expect(st.dry).toMatchObject({ hour: HOUR_INDEX, feesHour: 0.1, claimable: 0 });
    const harvest = await runHarvest(w.ctx({ now: T0 + 70_000 }));
    expect(harvest.skipped).toBeUndefined();
    expect(harvest.harvest?.dryRun).toBeUndefined();
    expect(w.chain.sends('buy').filter((b) => b.mint === w.hubMint)).toHaveLength(1);
  });

  it('a dry swarm starts the dry cooldown: the feed shows one swarm per cooldown', async () => {
    const w = world();
    const rules = { burnShare: 0.5, sealTrigger: 0, interactThreshold: 2, interactShare: 0.2, cooldownH: 6 };
    const a = await w.addHive({ cell: { q: 0, r: 0 }, sol: 5, price: 1e-6, rules });
    await w.addHive({ cell: { q: 1, r: 0 }, sol: 5, price: 1e-6, rules });
    for (let i = 0; i < 4; i++) {
      w.chain.fees.set(a.queenWallet, (w.chain.fees.get(a.queenWallet) ?? 0) + 3e8); // unclaimed fees keep growing
      await runHourly(w.ctx({ now: T0 + i * HOUR, dryRun: true }));
    }
    const swarms = w.db.actions.filter((x) => x.ca === a.ca && x.verb === 'swarm');
    expect(swarms.map((x) => x.id)).toEqual([`dry-swarm-${a.ca}-${HOUR_INDEX + 1}`]);
    expect(swarms[0].dryRun).toBe(true);
    expect(w.chain.sent).toHaveLength(0);
    expect((await readHiveState(w.db, a.ca)).real.lastSwarmAt).toBeNull();
  });
});
