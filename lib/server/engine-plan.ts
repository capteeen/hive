import 'server-only';
/**
 * The queen's hourly decision as a pure function: no I/O, no clock, no randomness.
 *
 * It mirrors `earnFees` in lib/sim.ts, so a remote hive behaves like a simulated one:
 *  - HUB:   theme.feeToHub (20%) of the hour's creator fees goes to the hub (the harvest).
 *  - SEAL:  when the price is below the 24h average by more than her `sealTrigger`, `burnShare` of the
 *           remaining 80% buys her own coin and burns it; the rest is stored.
 *  - STORE: otherwise the whole 80% stays in the queen wallet as honey.
 *  - SWARM: when honey > `interactThreshold` × her average hourly fees (and > 0.4 SOL, and her
 *           cooldown has passed), `interactShare` of honey buys the coin of an adjacent working hive
 *           with the fastest fee growth (falling back to hives within 3 cells).
 *
 * Differences from the simulator, all on the side of safety and determinism:
 *  - Nothing is ever planned below `reserveSol` (plus the network cost of each planned transaction
 *    and a buy's worst-case slippage), so the queen can always pay for her next hour.
 *  - The simulator swarms with a 55% chance and a randomised cooldown; here a swarm happens whenever
 *    the rule holds, and the cooldown is exactly `cooldownH` hours.
 *  - Trades below `minTradeSol` and hub transfers below `minHubSol` are not sent (the network fee
 *    would eat them); a small hub share is carried to the next hour instead.
 */
import { theme } from '@/themes';
import { clampRules, type QueenRules } from '@/lib/queen';

/** One real hour. The mock world uses lib/sim.ts HOUR_MS (60 s) instead. */
export const LIVE_HOUR_MS = 3_600_000;
/** The simulator only swarms with more than this much honey (lib/sim.ts earnFees). */
export const MIN_SWARM_HONEY_SOL = 0.4;
/** Smallest buy worth a transaction. */
export const MIN_TRADE_SOL = 0.001;
/** Smallest hub transfer worth a transaction; smaller shares are carried to the next hour. */
export const MIN_HUB_TRANSFER_SOL = 0.001;
/** Fee growth is measured against at least this much (SOL), like lib/sim.ts feeGrowth. */
export const FEE_GROWTH_FLOOR_SOL = 0.05;

/** Relative growth of the last hour's fees over the hour before (lib/sim.ts feeGrowth). */
export function feeGrowth(feesHour: number, feesPrevHour: number): number {
  const base = Math.max(feesPrevHour, FEE_GROWTH_FLOOR_SOL);
  return (feesHour - feesPrevHour) / base;
}

/** The hourly fee average after an hour that earned `feesSol` (the simulator's EMA at each harvest). */
export function nextFeeAvg(avgSol: number, feesSol: number): number {
  return avgSol * 0.7 + feesSol * 0.3;
}

/** SOL for humans: 2 significant digits under 0.01, otherwise 2–3 decimals. */
export function fmtSol(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const a = Math.abs(n);
  if (a >= 100) return n.toFixed(1);
  if (a >= 1) return n.toFixed(2);
  if (a >= 0.01) return n.toFixed(3);
  return n.toFixed(Math.min(9, -Math.floor(Math.log10(a)) + 1));
}

export interface PlanNeighbour {
  ca: string;
  ticker?: string;
  /** Hex distance on the comb (1 = adjacent). */
  distance: number;
  /** feeGrowth() of that hive's last two hours. */
  feeGrowth: number;
}

export interface PlanInput {
  /** SOL claimed in creator fees this hour. */
  feesSol: number;
  /** The queen wallet's SOL after the claim (so it includes `feesSol`). */
  queenBalanceSol: number;
  /** SOL that always stays in the queen wallet. Nothing is planned below it. */
  reserveSol: number;
  /** Current price, SOL per token (0 = unknown). */
  price: number;
  /** 24h average price (0 = unknown). */
  avg24h: number;
  /** Average hourly creator fees before this hour (EMA), SOL. */
  avgHourlyFeesSol: number;
  rules: QueenRules;
  /** ms epoch of her last swarm. */
  lastSwarmAt?: number | null;
  now: number;
  /** Working hives of the same kind (live or mock), not including this one. */
  neighbours: PlanNeighbour[];
  /** Length of one hour for the cooldown. Default: a real hour. */
  hourMs?: number;
  /** False when no hub wallet is configured: the hub share stays with the queen. Default true. */
  hubEnabled?: boolean;
  /** Hub share owed from earlier hours (too small to send then). It is never spent on trades. */
  hubCarrySol?: number;
  /** False when she may not seal this hour (an earlier seal is still settling). Default true. */
  sealAllowed?: boolean;
  /** Why she may not seal, for the store text (after "but "). Default: an earlier seal is still settling. */
  sealBlockedWhy?: string;
  /** Network cost set aside for each planned transaction, SOL. */
  txCostSol?: number;
  /** What a buy may cost on top of its amount (slippage, protocol fee), as a fraction. */
  buyOverhead?: number;
  minTradeSol?: number;
  minHubSol?: number;
  minSwarmHoneySol?: number;
}

export interface QueenPlan {
  /** theme.feeToHub of this hour's fees: the hub's nominal share. */
  hubShareSol: number;
  /** SOL to transfer to the hub now (this hour's share plus any carry), or 0. */
  hubSol: number;
  /** Hub share still owed after this hour (carried to the next one). */
  hubCarrySol: number;
  seal: { sol: number } | null;
  /** The part of this hour's 80% that stays in the queen wallet. */
  storeSol: number;
  swarm: { targetCa: string; sol: number } | null;
  /** Honey above the reserve once the plan has run (before network fees). */
  honeySol: number;
  /** How far below the 24h average the price is (0.05 = 5%), when known and below. */
  dipBelow: number | null;
  /** Action texts, in the simulator's voice. `seal` / `swarm` only when planned. */
  reasons: { hub: string; seal?: string; store: string; swarm?: string };
  /** Why something did not happen (for the engine log / cron summary). */
  notes: string[];
}

const pct = (n: number) => Math.round(n * 100);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const nonNeg = (n: number | undefined | null) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/** Adjacent working hive with the fastest fee growth; if none is adjacent, the fastest within 3 cells. */
export function pickSwarmTarget(neighbours: PlanNeighbour[]): PlanNeighbour | null {
  const valid = neighbours.filter((n) => n && typeof n.ca === 'string' && n.ca && Number.isFinite(n.distance) && n.distance >= 1);
  let candidates = valid.filter((n) => n.distance === 1);
  if (!candidates.length) candidates = valid.filter((n) => n.distance <= 3);
  if (!candidates.length) return null;
  const g = (n: PlanNeighbour) => (Number.isFinite(n.feeGrowth) ? n.feeGrowth : -Infinity);
  // fastest growth first; ties go to the nearer hive, then a stable order by address
  candidates.sort((a, b) => g(b) - g(a) || a.distance - b.distance || (a.ca < b.ca ? -1 : a.ca > b.ca ? 1 : 0));
  return candidates[0];
}

export function planHour(input: PlanInput): QueenPlan {
  const rules = clampRules(input.rules ?? {});
  const hourMs = input.hourMs && input.hourMs > 0 ? input.hourMs : LIVE_HOUR_MS;
  const txCost = nonNeg(input.txCostSol);
  const overhead = nonNeg(input.buyOverhead);
  const minTrade = input.minTradeSol ?? MIN_TRADE_SOL;
  const minHub = input.minHubSol ?? MIN_HUB_TRANSFER_SOL;
  const minSwarmHoney = input.minSwarmHoneySol ?? MIN_SWARM_HONEY_SOL;
  const fees = nonNeg(input.feesSol);
  const carry = nonNeg(input.hubCarrySol);
  const R = theme.copy.resource;
  const notes: string[] = [];

  // Everything above the reserve may be spent; `free` shrinks as the plan commits to transactions.
  let free = nonNeg(input.queenBalanceSol) - nonNeg(input.reserveSol);

  if (fees <= 0) {
    return {
      hubShareSol: 0,
      hubSol: 0,
      hubCarrySol: carry,
      seal: null,
      storeSol: 0,
      swarm: null,
      honeySol: Math.max(0, free),
      dipBelow: null,
      reasons: { hub: '', store: 'No creator fees this hour. Nothing to allocate.' },
      notes: ['no fees this hour'],
    };
  }

  /* ---------- HUB ---------- */
  const hubShare = fees * theme.feeToHub;
  const budget = fees - hubShare;
  let hubSol = 0;
  let hubCarry = carry;
  let hubReason: string;
  if (input.hubEnabled === false) {
    hubReason = `No hub wallet is configured, so the ${pct(theme.feeToHub)}% ${theme.hubRitual} share (${fmtSol(hubShare)} SOL) stays with the ${theme.agent}.`;
    notes.push('hub not configured: share kept');
  } else {
    const due = hubShare + carry;
    const room = Math.max(0, free - txCost);
    const send = Math.min(due, room);
    if (send >= minHub) {
      hubSol = send;
      hubCarry = due - send;
      free -= send + txCost;
      hubReason = `${pct(theme.feeToHub)}% (${fmtSol(hubSol)} SOL) went to the ${theme.hubRitual}.`;
      if (hubCarry > 1e-12) hubReason += ` ${fmtSol(hubCarry)} SOL more is owed and follows next hour.`;
    } else {
      hubCarry = due;
      hubReason = `The ${pct(theme.feeToHub)}% ${theme.hubRitual} share (${fmtSol(due)} SOL so far) is too small to send yet; it follows with a later hour.`;
      notes.push(room < due ? 'hub share held: queen at her reserve' : 'hub share carried: below the minimum transfer');
    }
  }
  // SOL owed to the hub is never spent on trades.
  const spendable = () => free - hubCarry;

  /* ---------- SEAL / STORE ---------- */
  const price = nonNeg(input.price);
  const avg = nonNeg(input.avg24h);
  const known = price > 0 && avg > 0;
  const dipBelow = known && price < avg ? 1 - price / avg : null;
  const inDip = known && price < avg * (1 - rules.sealTrigger);
  const below = dipBelow !== null ? (dipBelow * 100).toFixed(1) : '0';
  const triggerText = rules.sealTrigger > 0 ? ` (her trigger: ${pct(rules.sealTrigger)}%)` : '';

  let seal: QueenPlan['seal'] = null;
  let storeReason: string;
  let sealReason: string | undefined;
  if (inDip) {
    const want = budget * rules.burnShare;
    // a seal is a buy and a burn: two transactions
    const room = Math.max(0, (spendable() - 2 * txCost) / (1 + overhead));
    const amount = Math.min(want, room);
    if (input.sealAllowed === false) {
      const why = input.sealBlockedWhy?.trim() || `an earlier ${theme.verbs.burn} is still settling`;
      storeReason = `Price ${below}% below 24h average${triggerText}, but ${why}. Fees stored as ${R}.`;
      notes.push(input.sealBlockedWhy ? `seal skipped: ${why}` : 'seal skipped: an earlier seal is still settling');
    } else if (amount >= minTrade) {
      seal = { sol: amount };
      free -= amount * (1 + overhead) + 2 * txCost;
      const capped = amount < want - 1e-12;
      sealReason = capped
        ? `Price ${below}% below 24h average${triggerText}. ${fmtSol(amount)} SOL of the hour’s fees bought and burned (capped to keep her reserve), the rest stored.`
        : `Price ${below}% below 24h average${triggerText}. ${pct(rules.burnShare)}% of the hour’s fees (${fmtSol(amount)} SOL) bought and burned, ${pct(1 - rules.burnShare)}% stored.`;
      storeReason = '';
    } else if (want >= minTrade) {
      storeReason = `Price ${below}% below 24h average${triggerText}, but the ${theme.agent} is at her reserve. Fees stored as ${R}.`;
      notes.push('seal skipped: reserve floor');
    } else {
      storeReason = `Price ${below}% below 24h average${triggerText}, but ${fmtSol(want)} SOL is too small to trade. Fees stored as ${R}.`;
      notes.push('seal skipped: below the minimum trade');
    }
  } else if (!known) {
    storeReason = `No price history yet. Fees stored as ${R}.`;
  } else if (price < avg) {
    storeReason = `Price below 24h average but not past her ${pct(rules.sealTrigger)}% trigger. Fees stored as ${R}.`;
  } else {
    storeReason = `Price above 24h average. Nothing to ${theme.verbs.burn}. Fees stored as ${R}.`;
  }
  const storeSol = budget - (seal?.sol ?? 0);

  /* ---------- SWARM ---------- */
  let swarm: QueenPlan['swarm'] = null;
  let swarmReason: string | undefined;
  const honey = Math.max(0, spendable());
  const avgFees = nonNeg(input.avgHourlyFeesSol);
  const last = input.lastSwarmAt;
  const cooldownOk = last == null || !Number.isFinite(last) || input.now - last >= rules.cooldownH * hourMs;
  if (!cooldownOk) notes.push('swarm: cooling down');
  else if (!(avgFees > 0)) notes.push('swarm: no fee average yet');
  else if (!(honey > rules.interactThreshold * avgFees)) notes.push(`swarm: ${R} below ${rules.interactThreshold}× hourly fees`);
  else if (!(honey > minSwarmHoney)) notes.push(`swarm: ${R} below ${minSwarmHoney} SOL`);
  else {
    const target = pickSwarmTarget(input.neighbours ?? []);
    if (!target) notes.push('swarm: no working neighbour within 3 cells');
    else {
      const want = honey * rules.interactShare;
      const amount = Math.min(want, Math.max(0, (honey - txCost) / (1 + overhead)));
      if (amount < minTrade) notes.push('swarm: amount below the minimum trade');
      else {
        swarm = { targetCa: target.ca, sol: amount };
        free -= amount * (1 + overhead) + txCost;
        const name = target.ticker ? target.ticker : `${target.ca.slice(0, 6)}…`;
        const fit = target.distance === 1 ? 'the neighbor' : `the nearby ${theme.unit} (${target.distance} cells away)`;
        swarmReason = `${cap(R)} ${fmtSol(honey)} SOL is above ${rules.interactThreshold}× hourly fees (${fmtSol(avgFees)} SOL). Spent ${pct(rules.interactShare)}% buying ${name}, ${fit} with the fastest fee growth (${(target.feeGrowth * 100).toFixed(0)}%).`;
      }
    }
  }

  return {
    hubShareSol: hubShare,
    hubSol,
    hubCarrySol: hubCarry,
    seal,
    storeSol,
    swarm,
    honeySol: Math.max(0, free),
    dipBelow,
    reasons: { hub: hubReason, seal: sealReason, store: storeReason, swarm: swarmReason },
    notes,
  };
}
