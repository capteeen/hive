import { describe, expect, it } from 'vitest';
import { theme } from '@/themes';
import { DEFAULT_RULES, type QueenRules } from '@/lib/queen';
import { MIN_SWARM_HONEY_SOL, feeGrowth, fmtSol, nextFeeAvg, pickSwarmTarget, planHour, type PlanInput, type PlanNeighbour } from '@/lib/server/engine-plan';

const H = 3_600_000;
const NOW = 1_800_000_000_000;

/** A hive in a 10% dip with no fee average yet (so no swarm): the plainest SEAL hour. */
function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    feesSol: 0.1,
    queenBalanceSol: 1,
    reserveSol: 0.05,
    price: 0.9e-6,
    avg24h: 1e-6,
    avgHourlyFeesSol: 0,
    rules: DEFAULT_RULES,
    lastSwarmAt: null,
    now: NOW,
    neighbours: [],
    hourMs: H,
    ...over,
  };
}

const rules = (over: Partial<QueenRules>): QueenRules => ({ ...DEFAULT_RULES, ...over });
const n = (ca: string, distance: number, growth: number): PlanNeighbour => ({ ca, ticker: ca.toUpperCase(), distance, feeGrowth: growth });

describe('planHour: hub, SEAL and STORE', () => {
  it('seals burnShare of the 80% budget in a dip and stores the rest, sending 20% to the hub', () => {
    const p = planHour(input());
    expect(p.hubShareSol).toBeCloseTo(0.1 * theme.feeToHub, 12);
    expect(p.hubSol).toBeCloseTo(0.02, 12);
    expect(p.hubCarrySol).toBe(0);
    expect(p.seal?.sol).toBeCloseTo(0.08 * DEFAULT_RULES.burnShare, 12);
    expect(p.storeSol).toBeCloseTo(0.08 * (1 - DEFAULT_RULES.burnShare), 12);
    expect(p.swarm).toBeNull();
    expect(p.dipBelow).toBeCloseTo(0.1, 12);
    expect(p.reasons.seal).toMatch(/^Price 10\.0% below 24h average\. 40% of the hour’s fees \(0\.032 SOL\) bought and burned, 60% stored\.$/);
    expect(p.reasons.hub).toMatch(/20% \(0\.020 SOL\) went to the harvest/);
    expect(p.honeySol).toBeCloseTo(1 - 0.05 - 0.02 - 0.032, 12);
  });

  it('respects her seal trigger: a 3% dip under a 5% trigger is stored, an 8% dip is sealed', () => {
    const shallow = planHour(input({ price: 0.97e-6, rules: rules({ sealTrigger: 0.05 }) }));
    expect(shallow.seal).toBeNull();
    expect(shallow.storeSol).toBeCloseTo(0.08, 12);
    expect(shallow.reasons.store).toBe('Price below 24h average but not past her 5% trigger. Fees stored as honey.');

    const deep = planHour(input({ price: 0.92e-6, rules: rules({ sealTrigger: 0.05, burnShare: 0.65 }) }));
    expect(deep.seal?.sol).toBeCloseTo(0.08 * 0.65, 12);
    expect(deep.reasons.seal).toContain('(her trigger: 5%)');
    expect(deep.reasons.seal).toContain('65% of the hour’s fees');
  });

  it('stores everything when the price is above average or unknown', () => {
    const above = planHour(input({ price: 1.1e-6 }));
    expect(above.seal).toBeNull();
    expect(above.storeSol).toBeCloseTo(0.08, 12);
    expect(above.reasons.store).toBe('Price above 24h average. Nothing to seal. Fees stored as honey.');

    const unknown = planHour(input({ price: 0, avg24h: 0 }));
    expect(unknown.seal).toBeNull();
    expect(unknown.reasons.store).toBe('No price history yet. Fees stored as honey.');
  });

  it('does nothing in an hour without fees', () => {
    const p = planHour(input({ feesSol: 0, hubCarrySol: 0.0005 }));
    expect(p.hubSol).toBe(0);
    expect(p.seal).toBeNull();
    expect(p.swarm).toBeNull();
    expect(p.storeSol).toBe(0);
    expect(p.hubCarrySol).toBe(0.0005);
  });

  it('keeps the hub share with the queen when no hub wallet is configured', () => {
    const p = planHour(input({ hubEnabled: false, price: 1.2e-6 }));
    expect(p.hubSol).toBe(0);
    expect(p.hubShareSol).toBeCloseTo(0.02, 12);
    expect(p.hubCarrySol).toBe(0);
    expect(p.reasons.hub).toMatch(/No hub wallet is configured/);
    expect(p.honeySol).toBeCloseTo(1 - 0.05, 12);
  });

  it('carries a hub share too small to send and pays it with a later hour', () => {
    const small = planHour(input({ feesSol: 0.002, queenBalanceSol: 1, price: 2e-6 }));
    expect(small.hubSol).toBe(0);
    expect(small.hubCarrySol).toBeCloseTo(0.0004, 12);
    const later = planHour(input({ feesSol: 0.004, hubCarrySol: small.hubCarrySol, price: 2e-6 }));
    expect(later.hubSol).toBeCloseTo(0.0004 + 0.0008, 12);
    expect(later.hubCarrySol).toBe(0);
  });

  it('does not seal while an earlier seal is settling', () => {
    const p = planHour(input({ sealAllowed: false }));
    expect(p.seal).toBeNull();
    expect(p.storeSol).toBeCloseTo(0.08, 12);
    expect(p.reasons.store).toMatch(/still settling/);
  });

  it('says why a seal is blocked when the engine gives a reason', () => {
    const p = planHour(input({ sealAllowed: false, sealBlockedWhy: 'her token balance could not be read' }));
    expect(p.seal).toBeNull();
    expect(p.storeSol).toBeCloseTo(0.08, 12);
    expect(p.reasons.store).toBe('Price 10.0% below 24h average, but her token balance could not be read. Fees stored as honey.');
    expect(p.notes).toContain('seal skipped: her token balance could not be read');
  });

  it('skips a seal that is too small to trade', () => {
    const p = planHour(input({ feesSol: 0.002 }));
    expect(p.seal).toBeNull();
    expect(p.reasons.store).toMatch(/too small to trade/);
  });
});

describe('planHour: reserve floor', () => {
  it('never plans below the reserve: a queen at her reserve stores instead of sealing', () => {
    // She was below her reserve before this hour; the fees barely refill it (0.007 SOL above it).
    const p = planHour(input({ feesSol: 0.03, queenBalanceSol: 0.057, reserveSol: 0.05, txCostSol: 0.0005 }));
    expect(p.hubSol).toBeCloseTo(0.006, 12);
    expect(p.seal).toBeNull();
    expect(p.notes).toContain('seal skipped: reserve floor');
    expect(p.honeySol).toBeGreaterThanOrEqual(0);
  });

  it('caps a seal so the reserve and network fees stay covered', () => {
    const p = planHour(input({ feesSol: 0.5, queenBalanceSol: 0.25, reserveSol: 0.05, txCostSol: 0.001, buyOverhead: 0.12 }));
    // free = 0.2; hub 0.1 + 1 tx; seal room = (0.2 - 0.101 - 0.002) / 1.12
    expect(p.hubSol).toBeCloseTo(0.1, 12);
    expect(p.seal!.sol).toBeCloseTo((0.2 - 0.101 - 0.002) / 1.12, 9);
    expect(p.reasons.seal).toMatch(/capped to keep her reserve/);
    expect(p.honeySol).toBeCloseTo(0, 9);
  });

  it('holds the hub share when even that would cut into the reserve', () => {
    const p = planHour(input({ feesSol: 0.01, queenBalanceSol: 0.0505, reserveSol: 0.05 }));
    expect(p.hubSol).toBe(0);
    expect(p.hubCarrySol).toBeCloseTo(0.002, 12);
    expect(p.notes).toContain('hub share held: queen at her reserve');
  });

  it('holds for any input: hub + seal + swarm + network fees + owed hub share stay within balance − reserve', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2000; i++) {
      const tx = rnd() * 0.002;
      const o = rnd() * 0.2;
      const inp = input({
        feesSol: rnd() * 2,
        queenBalanceSol: rnd() * 5,
        reserveSol: 0.05,
        price: rnd() * 2e-6,
        avg24h: 1e-6,
        avgHourlyFeesSol: rnd() * 0.5,
        hubCarrySol: rnd() * 0.01,
        txCostSol: tx,
        buyOverhead: o,
        neighbours: [n('a', 1, rnd()), n('b', 2, rnd())],
        rules: rules({ burnShare: 0.1 + rnd() * 0.7, interactShare: 0.05 + rnd() * 0.45, interactThreshold: 1.2 + rnd() * 4 }),
      });
      const p = planHour(inp);
      const spent = p.hubSol + (p.hubSol > 0 ? tx : 0) + (p.seal ? p.seal.sol * (1 + o) + 2 * tx : 0) + (p.swarm ? p.swarm.sol * (1 + o) + tx : 0);
      const room = Math.max(0, inp.queenBalanceSol - inp.reserveSol);
      expect(spent).toBeLessThanOrEqual(room + 1e-9);
      // a share owed to the hub is never spent on trades
      if (p.seal || p.swarm) expect(spent + p.hubCarrySol).toBeLessThanOrEqual(room + 1e-9);
      expect(p.storeSol + (p.seal?.sol ?? 0)).toBeCloseTo(inp.feesSol * (1 - theme.feeToHub), 9);
    }
  });
});

describe('planHour: SWARM', () => {
  // Rich, above-average price (no seal), fee average 0.1 SOL/h: honey ≈ 2.88 > 2 × 0.1.
  const rich = (over: Partial<PlanInput> = {}) =>
    input({ queenBalanceSol: 3, price: 1.2e-6, avgHourlyFeesSol: 0.1, neighbours: [n('slow', 1, 0.1), n('fast', 1, 1.5), n('far', 2, 9)], ...over });

  it('spends interactShare of honey on the adjacent hive with the fastest fee growth', () => {
    const p = planHour(rich());
    const honey = 3 - 0.05 - 0.02;
    expect(p.swarm).toEqual({ targetCa: 'fast', sol: expect.closeTo(honey * DEFAULT_RULES.interactShare, 12) });
    expect(p.reasons.swarm).toBe(`Honey ${honey.toFixed(2)} SOL is above 2× hourly fees (0.100 SOL). Spent 25% buying FAST, the neighbor with the fastest fee growth (150%).`);
  });

  it('falls back to the fastest hive within 3 cells when none is adjacent, and to nobody beyond', () => {
    const p = planHour(rich({ neighbours: [n('two', 2, 0.2), n('three', 3, 0.9), n('four', 4, 50)] }));
    expect(p.swarm?.targetCa).toBe('three');
    expect(p.reasons.swarm).toContain('3 cells away');
    const none = planHour(rich({ neighbours: [n('four', 4, 50)] }));
    expect(none.swarm).toBeNull();
    expect(none.notes).toContain('swarm: no working neighbour within 3 cells');
  });

  it('waits out her cooldown', () => {
    const cooling = planHour(rich({ lastSwarmAt: NOW - 0.5 * H }));
    expect(cooling.swarm).toBeNull();
    expect(cooling.notes).toContain('swarm: cooling down');
    expect(planHour(rich({ lastSwarmAt: NOW - H })).swarm).not.toBeNull();
    const homebody = rules({ cooldownH: 3 });
    expect(planHour(rich({ rules: homebody, lastSwarmAt: NOW - 2 * H })).swarm).toBeNull();
    expect(planHour(rich({ rules: homebody, lastSwarmAt: NOW - 3 * H })).swarm).not.toBeNull();
  });

  it('needs a fee average, honey above threshold × average, and more than the simulator’s minimum honey', () => {
    expect(planHour(rich({ avgHourlyFeesSol: 0 })).swarm).toBeNull();
    // honey 2.88 is not above 4 × 1 SOL/h
    expect(planHour(rich({ avgHourlyFeesSol: 1, rules: rules({ interactThreshold: 4 }) })).swarm).toBeNull();
    // above the threshold but under 0.4 SOL of honey
    const poor = planHour(rich({ queenBalanceSol: 0.05 + 0.02 + MIN_SWARM_HONEY_SOL - 0.01, avgHourlyFeesSol: 0.01 }));
    expect(poor.swarm).toBeNull();
    expect(poor.notes.some((x) => x.includes('below 0.4 SOL'))).toBe(true);
  });

  it('swarms with what is left after a seal in the same hour', () => {
    const p = planHour(rich({ price: 0.8e-6 }));
    expect(p.seal).not.toBeNull();
    const honey = 3 - 0.05 - 0.02 - p.seal!.sol;
    expect(p.swarm!.sol).toBeCloseTo(honey * DEFAULT_RULES.interactShare, 12);
  });
});

describe('helpers', () => {
  it('pickSwarmTarget breaks growth ties by distance, then address', () => {
    expect(pickSwarmTarget([n('b', 1, 1), n('a', 1, 1)])?.ca).toBe('a');
    expect(pickSwarmTarget([n('x', 2, 1), n('y', 3, 1)])?.ca).toBe('x');
    expect(pickSwarmTarget([n('nan', 1, Number.NaN), n('neg', 1, -0.5)])?.ca).toBe('neg');
    expect(pickSwarmTarget([])).toBeNull();
  });

  it('feeGrowth and the fee average match the simulator', () => {
    expect(feeGrowth(0.2, 0.1)).toBeCloseTo(1, 12);
    expect(feeGrowth(0.03, 0)).toBeCloseTo(0.6, 12); // floored at 0.05 SOL
    expect(nextFeeAvg(0.1, 0.2)).toBeCloseTo(0.13, 12);
  });

  it('fmtSol keeps small amounts readable', () => {
    expect(fmtSol(0)).toBe('0');
    expect(fmtSol(0.004)).toBe('0.0040');
    expect(fmtSol(0.032)).toBe('0.032');
    expect(fmtSol(2.5)).toBe('2.50');
  });
});
