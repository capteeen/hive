/**
 * #1: a live abandon payout must reach every holder (up to MAX_PAYOUT_RECIPIENTS, the biggest, pro-rata
 * among themselves), and a payout that cannot be planned for lack of holder data stays open and is
 * retried instead of being marked done with the vault stranded in the queen wallet.
 */
import { describe, expect, it, vi } from 'vitest';
import { Keypair, type Connection } from '@solana/web3.js';
import { DEFAULT_RULES } from '@/lib/queen';
import type { RemoteHive } from '@/lib/shared/api';
import { config } from '@/lib/server/config';
import { LiveChain } from '@/lib/server/chain-live';
import { newKeypair } from '@/lib/server/keys';
import { MAX_PAYOUT_RECIPIENTS, planPayout, readHiveState, runHourly, type HubSetup } from '@/lib/server/engine';
import { EngineMemDb, ScriptChain, walletAddress } from './engine-fakes';

const HOUR = 3_600_000;
const T0 = 500_000 * HOUR;

/** LiveChain.holders over a fake Helius DAS that serves `pages` (1-based). */
async function dasHolders(pages: (page: number) => { owner: string; amount: number }[]) {
  const prev = config.heliusApiKey;
  config.heliusApiKey = 'k';
  try {
    const fetchMock = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body));
      return Response.json({ result: { token_accounts: pages(b.params.page) } });
    });
    const chain = new LiveChain({ connection: {} as unknown as Connection, fetch: fetchMock as unknown as typeof fetch });
    return { holders: await chain.holders('MINT'), calls: fetchMock.mock.calls.length };
  } finally {
    config.heliusApiKey = prev;
  }
}

async function liveWorld(holderCount: number) {
  const db = new EngineMemDb();
  const sc = new ScriptChain('live');
  const hubKey = Keypair.generate();
  const hub: HubSetup = { keypair: hubKey, wallet: hubKey.publicKey.toBase58(), mint: walletAddress() };
  const { keypair, enc } = newKeypair();
  const qw = keypair.publicKey.toBase58();
  await db.putSecret(qw, enc);
  const hive: RemoteHive = {
    ca: walletAddress(), name: 'Gone', ticker: 'GONE', image: '', cell: { q: 0, r: 0 }, queenWallet: qw, ownerWallet: walletAddress(),
    rules: DEFAULT_RULES, devBuy: 0, status: 'live', honey: 0, bees: holderCount, feesTotal: 0, royalJelly: 0, state: 'starving',
    lastFeeAt: T0 - 25 * HOUR, createdAt: T0 - 48 * HOUR, updatedAt: T0 - 48 * HOUR,
  };
  await db.upsertHive(hive);
  sc.setSol(qw, 1.05);
  const ctx = (now: number) => ({ db, chain: sc, mode: 'live' as const, hub, now, hourMs: HOUR, settleMs: 0, reserveSol: 0.05 });
  const paid = () => sc.sends('transferSol').filter((s) => s.from === qw);
  return { db, sc, hive, qw, ctx, paid };
}

describe('#1 live abandon payout with more than 10 holders', () => {
  it('LiveChain.holders returns every owner, so a 12-holder vault is paid out to all 12', async () => {
    const owners = Array.from({ length: 12 }, () => Keypair.generate().publicKey.toBase58());
    const { holders } = await dasHolders((page) => (page === 1 ? owners.map((owner, i) => ({ owner, amount: 1000 + i })) : []));
    expect(holders!.count).toBe(12);
    expect(holders!.top).toHaveLength(12); // was cut to 10
    expect(holders!.complete).toBe(true);
    expect(holders!.top[0]).toEqual({ owner: owners[11], amount: 1011n }); // largest first

    const plan = planPayout(1_000_000_000, holders!, new Set());
    expect(plan.why).toBeUndefined();
    expect(plan.recipients).toHaveLength(12);

    const w = await liveWorld(12);
    w.sc.holderLists.set(w.hive.ca, holders!);
    await runHourly(w.ctx(T0));
    expect(w.paid()).toHaveLength(12);
    expect(new Set(w.paid().map((p) => p.to))).toEqual(new Set(owners));
    const total = w.paid().reduce((s, p) => s + p.lamports!, 0);
    expect(total).toBeLessThanOrEqual(1_000_000_000); // never more than the vault
    expect(total).toBeGreaterThan(999_999_000);
    expect((await w.db.getHive(w.hive.ca))!.state).toBe('abandoned');
  });

  it('an incomplete holder list keeps the payout open (not done, not abandoned) and a later run pays it', async () => {
    const owners = Array.from({ length: 12 }, () => Keypair.generate().publicKey.toBase58());
    const w = await liveWorld(12);
    // only part of the list is known (an older chain, or a cut-off DAS answer)
    w.sc.holderLists.set(w.hive.ca, { count: 12, top: owners.slice(0, 10).map((owner) => ({ owner, amount: 1n })) });
    await runHourly(w.ctx(T0));
    expect(w.paid()).toHaveLength(0);
    let st = await readHiveState(w.db, w.hive.ca);
    expect(st.payout).toBeNull(); // nothing frozen, nothing marked done
    expect((await w.db.getHive(w.hive.ca))!.state).toBe('starving');
    expect(w.db.actions.find((a) => a.id === `abandon-${w.hive.ca}`)).toBeUndefined();
    expect(w.db.actions.find((a) => a.id === `abandon-wait-${w.hive.ca}`)!.reason).toMatch(/only 10 of its 12 bees are known here.*tried again every hour/);

    // the DAS answer fails outright an hour later: still waiting
    w.sc.holderLists.set(w.hive.ca, null);
    await runHourly(w.ctx(T0 + HOUR));
    expect(w.paid()).toHaveLength(0);

    // a complete list two hours later: the vault is paid and the hive abandoned
    w.sc.holderLists.set(w.hive.ca, { count: 12, top: owners.map((owner) => ({ owner, amount: 1n })) });
    await runHourly(w.ctx(T0 + 2 * HOUR));
    expect(w.paid()).toHaveLength(12);
    expect(w.paid().every((p) => p.lamports === Math.floor(1_000_000_000 / 12))).toBe(true);
    st = await readHiveState(w.db, w.hive.ca);
    expect(st.payout?.doneAt).toBe(T0 + 2 * HOUR);
    expect((await w.db.getHive(w.hive.ca))!.state).toBe('abandoned');
    expect(w.db.actions.find((a) => a.id === `abandon-${w.hive.ca}`)!.reason).toMatch(/paid out pro-rata to 12 bees/);
  });

  it('more than MAX_PAYOUT_RECIPIENTS holders: the biggest are paid, pro-rata among themselves', () => {
    const holders = Array.from({ length: MAX_PAYOUT_RECIPIENTS + 50 }, (_, i) => ({ owner: Keypair.generate().publicKey.toBase58(), amount: BigInt(1000 + i) }));
    const plan = planPayout(10_000_000_000, { count: holders.length, top: holders, complete: true }, new Set());
    expect(plan.recipients).toHaveLength(MAX_PAYOUT_RECIPIENTS);
    const biggest = holders.slice(-MAX_PAYOUT_RECIPIENTS);
    expect(new Set(plan.recipients.map((r) => r.owner))).toEqual(new Set(biggest.map((h) => h.owner)));
    const total = biggest.reduce((s, h) => s + h.amount, 0n);
    for (const r of plan.recipients) {
      const h = biggest.find((x) => x.owner === r.owner)!;
      expect(r.lamports).toBe(Number((10_000_000_000n * h.amount) / total));
    }
    expect(plan.recipients.reduce((s, r) => s + r.lamports, 0)).toBeLessThanOrEqual(10_000_000_000);
  });

  it('a DAS list cut off at the page cap is reported incomplete and never paid from', async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const { holders, calls } = await dasHolders(() => Array.from({ length: 1000 }, () => ({ owner, amount: 1 })));
    expect(calls).toBe(50);
    expect(holders!.complete).toBe(false);
    const plan = planPayout(1_000_000_000, holders!, new Set());
    expect(plan.recipients).toHaveLength(0);
    expect(plan.retry).toBe(true);
  });
});
