/**
 * PHASE 1 MOCK SIMULATOR
 * ----------------------
 * A deterministic world of units ("hives") on a hex grid. Every 2–5 s a few of them
 * earn creator fees; their agents ("queens") immediately allocate the hour's budget by
 * the public rules (SEAL / STORE / SWARM); the hub ritual ("harvest") runs every mock
 * hour. In production, the same rule functions run server-side against real fee claims.
 *
 * Mock time: one "hour" is 60 s. Switch HOUR_MS to 3_600_000 for prod cadence.
 */
import { theme } from '@/themes';
import { mulberry32, mockAddress, mockSig, pick, range, type Rng } from './rng';
import { spiral, neighbors, cellKey, hexDistance } from './hex';
import type { Action, Harvest, Hive, HiveState, SceneEvent, SceneEventType, World, Cell } from './types';
import { DEFAULT_RULES, clampRules, type QueenLook, type QueenRules } from './queen';

export const HOUR_MS = 60_000;
export const SEED = 0x5eed;
export const SEED_HIVES = 60;
export const LAUNCH_COST = 0.02;
export const QUEEN_RESERVE = 0.05;
const MAX_ACTIONS = 240;
const MAX_HARVESTS = 120;

const ADJ = ['Amber', 'Velvet', 'Golden', 'Wild', 'Clover', 'Drone', 'Solar', 'Black', 'Royal', 'Neon', 'Glass', 'Iron', 'Wax', 'Dusk', 'Moon', 'Feral', 'Copper', 'Silent', 'Nectar', 'Cinder', 'Lunar', 'Ghost', 'Hollow', 'Vapor', 'Prism'];
const NOUN = ['Comb', 'Swarm', 'Nectar', 'Drone', 'Pollen', 'Wax', 'Sting', 'Meadow', 'Apiary', 'Larva', 'Buzz', 'Mead', 'Hum', 'Honeycomb', 'Thorax', 'Propolis', 'Brood', 'Forager', 'Cell', 'Jelly'];
const PACK_ADJ = ['Grey', 'Winter', 'Timber', 'Lone', 'Night', 'Snow', 'Ash', 'Fang', 'Ridge', 'Moon'];
const PACK_NOUN = ['Wolf', 'Den', 'Howl', 'Fang', 'Pack', 'Hunt', 'Pelt', 'Tundra', 'Alpha', 'Trail'];

function makeName(rng: Rng, used: Set<string>) {
  const isPack = theme.id === 'pack';
  for (let i = 0; i < 50; i++) {
    const a = pick(rng, isPack ? PACK_ADJ : ADJ);
    const n = pick(rng, isPack ? PACK_NOUN : NOUN);
    const name = `${a} ${n}`;
    if (!used.has(name)) {
      used.add(name);
      const ticker = (a.slice(0, 2) + n.slice(0, 3)).toUpperCase();
      return { name, ticker };
    }
  }
  const name = `Unit ${used.size}`;
  used.add(name);
  return { name, ticker: `U${used.size}` };
}

let actionSeq = 0;
const aid = () => `a${Date.now().toString(36)}${(actionSeq++).toString(36)}`;

function pushAction(world: World, a: Omit<Action, 'id'>) {
  world.actions.unshift({ id: aid(), ...a });
  if (world.actions.length > MAX_ACTIONS) world.actions.length = MAX_ACTIONS;
}

function emit(world: World, type: SceneEventType, ca: string, extra: Partial<SceneEvent> = {}) {
  world.events.push({ id: ++world.eventSeq, type, ca, at: Date.now(), ...extra });
  if (world.events.length > 200) world.events.splice(0, world.events.length - 200);
}

/* ---------- per-hive fee log (sliding window) ---------- */
const feeLogs = new Map<string, { at: number; amount: number }[]>();
function logFee(ca: string, at: number, amount: number) {
  let l = feeLogs.get(ca);
  if (!l) feeLogs.set(ca, (l = []));
  l.push({ at, amount });
}
function feeWindows(ca: string, now: number) {
  const l = feeLogs.get(ca) ?? [];
  const cutoff = now - 2 * HOUR_MS;
  while (l.length && l[0].at < cutoff) l.shift();
  let hour = 0;
  let prev = 0;
  for (const f of l) {
    if (f.at >= now - HOUR_MS) hour += f.amount;
    else prev += f.amount;
  }
  return { hour, prev };
}

export function feeGrowth(h: Hive) {
  const base = Math.max(h.feesPrevHour, 0.05);
  return (h.feesHour - h.feesPrevHour) / base;
}

/* ---------- world creation ---------- */
export function createWorld(seed = SEED, now = Date.now(), demo = true): World {
  const rng = mulberry32(seed);
  const cells = spiral(SEED_HIVES);
  const used = new Set<string>();
  const world: World = {
    hives: {},
    order: [],
    actions: [],
    harvests: [],
    hubPool: 0,
    hubBurnedTotal: 0,
    hubPrice: 0.000012,
    nextHarvestAt: Math.ceil(now / HOUR_MS) * HOUR_MS,
    events: [],
    eventSeq: 0,
    seq: 0,
    biggestCa: '',
  };

  if (!demo) return world; // only server-side (remote) hives

  // Index 0 is the biggest (centered). A handful are starving/abandoned on load.
  for (let i = 0; i < SEED_HIVES; i++) {
    const { name, ticker } = makeName(rng, used);
    const ca = mockAddress(rng);
    const tier = i === 0 ? 1 : Math.pow(rng(), 1.8); // power-law size
    const honey = i === 0 ? 48 + rng() * 10 : 0.2 + tier * 22;
    const bees = Math.round(i === 0 ? 2400 + rng() * 600 : 12 + tier * 1800 + rng() * 40);
    const price = 0.00000025 + rng() * 0.0000012;
    const vigor = i === 0 ? 0.95 : 0.15 + rng() * 0.8;
    let state: HiveState = 'working';
    let lastFeeAt = now - rng() * 0.6 * HOUR_MS;
    let v = vigor;
    if (i >= 50 && i < 56) {
      // starving
      state = 'starving';
      lastFeeAt = now - (theme.rules.starveHours + 2 + rng() * 10) * HOUR_MS;
      v = i < 53 ? 0 : 0.03; // a couple may recover
    } else if (i >= 56) {
      state = 'abandoned';
      lastFeeAt = now - (theme.rules.abandonHours + 5 + rng() * 40) * HOUR_MS;
      v = 0;
    } else if (i > 8 && rng() < 0.08) {
      v = 0; // will starve during the session
      lastFeeAt = now - rng() * 3 * HOUR_MS;
    }
    const h: Hive = {
      ca,
      name,
      ticker,
      image: '',
      queenWallet: mockAddress(rng),
      honey: state === 'abandoned' ? 0 : honey,
      bees: state === 'abandoned' ? Math.round(bees * 0.2) : state === 'starving' ? Math.round(bees * 0.7) : bees,
      beesPeak: bees,
      feesTotal: honey * (2 + rng() * 3),
      feesHour: 0,
      feesPrevHour: 0,
      feeAvgHour: state === 'working' ? honey * (0.02 + rng() * 0.08) : 0,
      price,
      avg24h: price * (0.9 + rng() * 0.2),
      state,
      swarmsIn: Math.floor(rng() * 6 * tier),
      swarmsOut: Math.floor(rng() * 6 * tier),
      swarmsWon: Math.floor(rng() * 4 * tier),
      royalJelly: i === 0 ? 3.2 + rng() * 2 : rng() < 0.2 ? rng() * 1.5 : 0,
      sealed: rng() * 0.12 * tier,
      bornAt: now - (1 + rng() * 40) * 86400000,
      lastFeeAt,
      cell: cells[i],
      vigor: v,
      priceHistory: [],
    };
    // backfill price history (120 points, 30 s apart)
    let p = price * (0.75 + rng() * 0.5);
    const t0 = Math.floor(now / 1000) - 120 * 30;
    for (let k = 0; k < 120; k++) {
      p = p * (1 + (rng() - 0.49) * 0.06);
      h.priceHistory.push({ time: t0 + k * 30, value: p });
    }
    p = price;
    h.priceHistory[h.priceHistory.length - 1].value = price;
    // backfill recent fees so the hourly stats aren't empty
    if (state === 'working') {
      const n = 2 + Math.floor(rng() * 8 * v);
      for (let k = 0; k < n; k++) {
        const at = now - rng() * 2 * HOUR_MS;
        const amount = range(rng, 0.02, 0.5) * (0.4 + tier);
        logFee(ca, at, amount);
      }
      const w = feeWindows(ca, now);
      h.feesHour = w.hour;
      h.feesPrevHour = w.prev;
    }
    world.hives[ca] = h;
    world.order.push(ca);
  }

  // backfill a log and a few past harvests
  const workingCas = world.order.filter((c) => world.hives[c].state === 'working');
  // every working hive gets at least two entries, plus a random spread
  const backfill: string[] = [...workingCas, ...workingCas];
  for (let k = 0; k < 60; k++) backfill.push(pick(rng, workingCas));
  for (const ca of backfill) {
    const h = world.hives[ca];
    const at = now - rng() * 1.8 * HOUR_MS;
    const roll = rng();
    if (roll < 0.15) {
      const target = pick(rng, workingCas.filter((c) => c !== ca));
      pushAction(world, { ca, verb: 'swarm', amount: range(rng, 0.1, 2), targetCa: target, reason: `${theme.copy.resource} above ${theme.rules.interactThreshold}× hourly fees. Bought ${world.hives[target].ticker}, the neighbor with the fastest fee growth.`, txSig: mockSig(rng), at });
    } else if (roll < 0.4) {
      pushAction(world, { ca, verb: 'seal', amount: range(rng, 0.02, 0.3), reason: `Price below 24h average. ${Math.round(theme.rules.burnShare * 100)}% of the hour’s fees bought and burned.`, txSig: mockSig(rng), at });
    } else {
      pushAction(world, { ca, verb: 'store', amount: range(rng, 0.02, 0.5), reason: `Price above 24h average. Fees stored as ${theme.copy.resource}.`, txSig: mockSig(rng), at });
    }
    void h;
  }
  for (const ca of world.order) {
    const h = world.hives[ca];
    if (h.state === 'starving') pushAction(world, { ca, verb: 'starve', amount: 0, reason: `No fees for ${theme.rules.starveHours} hours. ${theme.holderPlural} are leaving.`, at: h.lastFeeAt + theme.rules.starveHours * HOUR_MS });
    if (h.state === 'abandoned') pushAction(world, { ca, verb: 'abandon', amount: range(rng, 0.3, 4), reason: `No fees for ${theme.rules.abandonHours} hours. Vault paid out pro-rata to ${theme.holderPlural}.`, txSig: mockSig(rng), at: h.lastFeeAt + theme.rules.abandonHours * HOUR_MS });
  }
  world.actions.sort((a, b) => b.at - a.at);

  let hubPrice = 0.0000095;
  for (let k = 8; k >= 1; k--) {
    const at = world.nextHarvestAt - k * HOUR_MS;
    const feesIn = range(rng, 0.6, 3.2);
    const bought = feesIn / hubPrice;
    hubPrice *= 1 + range(rng, 0.002, 0.03);
    const jellyTo = world.order[0];
    const jellySol = feesIn * theme.hubSplit.toBiggest;
    const txSig = mockSig(rng);
    world.harvests.unshift({ id: `h${at}`, at, feesIn, hiveBought: bought, burned: bought * theme.hubSplit.burn, jellyTo, jellyAmount: bought * theme.hubSplit.toBiggest, jellySol, txSig });
    if (k <= 2) pushAction(world, { ca: jellyTo, verb: 'jelly', amount: jellySol, reason: `${theme.hubRitual} ${theme.copy.reward}: biggest ${theme.unit} by ${theme.copy.resource} received ${Math.round(theme.hubSplit.toBiggest * 100)}% of the ${theme.hubToken.symbol} bought this hour.`, txSig, at });
    world.hubBurnedTotal += bought * theme.hubSplit.burn;
  }
  world.actions.sort((a, b) => b.at - a.at);
  world.hubBurnedTotal += 42_000_000; // "lifetime" burn before the backfilled window
  world.hubPrice = hubPrice;
  world.hubPool = range(rng, 0.2, 0.8);
  world.biggestCa = world.order[0];
  return world;
}

/* ---------- helpers ---------- */
function biggest(world: World) {
  let best: Hive | undefined;
  for (const ca of world.order) {
    const h = world.hives[ca];
    if (h.state === 'abandoned' || h.source === 'remote') continue;
    if (!best || h.honey > best.honey) best = h;
  }
  return best;
}

function centerBiggest(world: World) {
  const b = biggest(world);
  if (!b || b.ca === world.biggestCa) return;
  world.biggestCa = b.ca;
  if (b.cell.q === 0 && b.cell.r === 0) return;
  const center = Object.values(world.hives).find((h) => h.cell.q === 0 && h.cell.r === 0);
  const old = { ...b.cell };
  b.cell = { q: 0, r: 0 };
  if (center) center.cell = old;
}

function pushPrice(h: Hive, now: number) {
  const t = Math.floor(now / 1000);
  const last = h.priceHistory[h.priceHistory.length - 1];
  if (last && t <= last.time) last.value = h.price;
  else h.priceHistory.push({ time: t, value: h.price });
  if (h.priceHistory.length > 600) h.priceHistory.splice(0, h.priceHistory.length - 600);
  h.avg24h = h.avg24h * 0.97 + h.price * 0.03;
}

function swarmTarget(world: World, h: Hive): Hive | undefined {
  const candidates: Hive[] = [];
  const adj = new Set(neighbors(h.cell).map(cellKey));
  for (const ca of world.order) {
    const o = world.hives[ca];
    if (o.ca === h.ca || o.state !== 'working' || o.source === 'remote') continue;
    if (adj.has(cellKey(o.cell))) candidates.push(o);
  }
  if (!candidates.length) {
    // fall back to the nearest working hives within distance 3
    for (const ca of world.order) {
      const o = world.hives[ca];
      if (o.ca === h.ca || o.state !== 'working' || o.source === 'remote') continue;
      if (hexDistance(o.cell, h.cell) <= 3) candidates.push(o);
    }
  }
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => feeGrowth(b) - feeGrowth(a));
  return candidates[0];
}

const swarmCooldown = new Map<string, number>();

/** A hive earned `amount` SOL of creator fees. Route 20% to the hub, let the queen allocate the rest. */
export function earnFees(world: World, h: Hive, amount: number, now: number, rng: Rng, viaSwarmFrom?: Hive) {
  const hub = amount * theme.feeToHub;
  const budget = amount - hub;
  world.hubPool += hub;
  h.feesTotal += amount;
  logFee(h.ca, now, amount);
  const w = feeWindows(h.ca, now);
  h.feesHour = w.hour;
  h.feesPrevHour = w.prev;
  h.lastFeeAt = now;

  // revival
  if (h.state === 'starving') {
    h.state = 'working';
    h.bees = h.beesPeak;
    pushAction(world, { ca: h.ca, verb: 'store', amount: 0, reason: `Fees are back. ${theme.holderPlural} return to the ${theme.unit}.`, at: now });
  }

  // buy pressure
  h.price *= 1 + range(rng, -0.025, 0.035) + Math.min(0.05, amount * 0.02);
  pushPrice(h, now);
  if (!viaSwarmFrom && rng() < 0.6) h.bees += Math.round(range(rng, 1, 6) * (1 + amount));
  if (h.bees > h.beesPeak) h.beesPeak = h.bees;

  const rules: QueenRules = h.rules ?? DEFAULT_RULES;
  if (h.price < h.avg24h * (1 - rules.sealTrigger)) {
    // SEAL
    const below = ((1 - h.price / h.avg24h) * 100).toFixed(1);
    const burn = budget * rules.burnShare;
    const store = budget - burn;
    h.sealed = Math.min(0.6, h.sealed + burn * 0.004);
    h.honey += store;
    h.price *= 1 + burn * 0.01;
    pushAction(world, {
      ca: h.ca,
      verb: 'seal',
      amount: burn,
      reason: `Price ${below}% below 24h average${rules.sealTrigger > 0 ? ` (her trigger: ${Math.round(rules.sealTrigger * 100)}%)` : ''}. ${Math.round(rules.burnShare * 100)}% of the hour’s fees bought and burned, ${Math.round((1 - rules.burnShare) * 100)}% stored.`,
      txSig: mockSig(rng),
      at: now,
    });
    emit(world, 'seal', h.ca, { amount: burn });
  } else {
    h.honey += budget;
    pushAction(world, {
      ca: h.ca,
      verb: 'store',
      amount: budget,
      reason: viaSwarmFrom
        ? `Swarmed by ${viaSwarmFrom.ticker}. Creator fee from the raid stored as ${theme.copy.resource}.`
        : h.price < h.avg24h
          ? `Price below 24h average but not past her ${Math.round(rules.sealTrigger * 100)}% trigger. Fees stored as ${theme.copy.resource}.`
          : `Price above 24h average. Nothing to ${theme.verbs.burn}. Fees stored as ${theme.copy.resource}.`,
      txSig: mockSig(rng),
      at: now,
    });
    emit(world, 'store', h.ca, { amount: budget });
  }

  // SWARM
  const cd = swarmCooldown.get(h.ca) ?? 0;
  if (now > cd && h.feeAvgHour > 0 && h.honey > rules.interactThreshold * h.feeAvgHour && h.honey > 0.4) {
    const target = swarmTarget(world, h);
    if (target && rng() < 0.55) {
      const spend = h.honey * rules.interactShare;
      h.honey -= spend;
      h.swarmsOut++;
      target.swarmsIn++;
      if (h.honey > target.honey) h.swarmsWon++;
      else target.swarmsWon++;
      swarmCooldown.set(h.ca, now + HOUR_MS * rules.cooldownH * (0.4 + rng() * 0.6));
      target.price *= 1 + Math.min(0.12, spend * 0.02);
      pushPrice(target, now);
      pushAction(world, {
        ca: h.ca,
        verb: 'swarm',
        amount: spend,
        targetCa: target.ca,
        reason: `${theme.copy.resource} ${(h.honey + spend).toFixed(2)} SOL is above ${rules.interactThreshold}× hourly fees (${h.feeAvgHour.toFixed(2)} SOL). Spent ${Math.round(rules.interactShare * 100)}% buying ${target.ticker}, the neighbor with the fastest fee growth (${(feeGrowth(target) * 100).toFixed(0)}%).`,
        txSig: mockSig(rng),
        at: now,
      });
      emit(world, 'swarm', h.ca, { targetCa: target.ca, amount: spend });
      // the raid pays the target's creator fee (1% of the buy)
      earnFees(world, target, spend * 0.01, now + 1, rng, h);
    }
  }
}

function runHarvest(world: World, now: number, rng: Rng) {
  const feesIn = world.hubPool;
  world.hubPool = 0;
  const bought = feesIn / world.hubPrice;
  const burned = bought * theme.hubSplit.burn;
  const jelly = bought * theme.hubSplit.toBiggest;
  world.hubPrice *= 1 + Math.min(0.05, feesIn * 0.01);
  world.hubBurnedTotal += burned;
  const b = biggest(world);
  const jellySol = feesIn * theme.hubSplit.toBiggest;
  if (b) {
    b.honey += jellySol;
    b.royalJelly += jellySol;
    pushAction(world, { ca: b.ca, verb: 'jelly', amount: jellySol, reason: `${theme.hubRitual} ${theme.copy.reward}: biggest ${theme.unit} by ${theme.copy.resource} received ${Math.round(theme.hubSplit.toBiggest * 100)}% of the ${theme.hubToken.symbol} bought this hour.`, txSig: mockSig(rng), at: now });
  }
  const txSig = mockSig(rng);
  world.harvests.unshift({ id: `h${now}`, at: now, feesIn, hiveBought: bought, burned, jellyTo: b?.ca ?? '', jellyAmount: jelly, jellySol, txSig });
  if (world.harvests.length > MAX_HARVESTS) world.harvests.length = MAX_HARVESTS;
  emit(world, 'harvest', b?.ca ?? '', { amount: feesIn });
  // roll hourly averages
  for (const ca of world.order) {
    const h = world.hives[ca];
    if (h.source === 'remote') continue;
    const w = feeWindows(ca, now);
    h.feesHour = w.hour;
    h.feesPrevHour = w.prev;
    h.feeAvgHour = h.feeAvgHour * 0.7 + w.hour * 0.3;
  }
  world.nextHarvestAt = Math.ceil((now + 1) / HOUR_MS) * HOUR_MS;
}

function runStarvation(world: World, now: number, rng: Rng) {
  const rules = theme.rules;
  for (const ca of world.order) {
    const h = world.hives[ca];
    if (h.state === 'abandoned' || h.source === 'remote') continue; // remote hives starve server-side
    const silent = (now - h.lastFeeAt) / HOUR_MS;
    if (h.state === 'working' && silent >= rules.starveHours) {
      h.state = 'starving';
      pushAction(world, { ca, verb: 'starve', amount: 0, reason: `No fees for ${rules.starveHours} consecutive hours. ${theme.holderPlural} are leaving and the ${theme.unit} is going grey.`, at: now });
      emit(world, 'starve', ca);
    }
    if (h.state === 'starving') {
      const p = Math.min(1, (silent - rules.starveHours) / (rules.abandonHours - rules.starveHours));
      h.bees = Math.max(1, Math.round(h.beesPeak * (1 - 0.8 * p)));
      if (silent >= rules.abandonHours) {
        h.state = 'abandoned';
        const payout = h.honey;
        h.honey = 0;
        pushAction(world, { ca, verb: 'abandon', amount: payout, reason: `No fees for ${rules.abandonHours} hours. ${theme.unit} abandoned. Vault of ${payout.toFixed(2)} SOL paid out pro-rata to ${h.bees} ${theme.holderPlural}. The cell stays on the map as grey comb.`, txSig: mockSig(rng), at: now });
        emit(world, 'abandon', ca);
      }
    }
  }
}

/* ---------- stepping ---------- */
export interface SimClock {
  rng: Rng;
  nextFeeAt: number;
}

export function createClock(now = Date.now()): SimClock {
  return { rng: mulberry32((now ^ 0x9e3779b9) >>> 0), nextFeeAt: now + 800 };
}

/** Advance the world to `now`. Mutates `world` in place; returns true if anything changed. */
export function stepWorld(world: World, clock: SimClock, now = Date.now()): boolean {
  let changed = false;
  const { rng } = clock;
  if (now >= clock.nextFeeAt) {
    changed = true;
    clock.nextFeeAt = now + 2000 + rng() * 3000;
    const n = 1 + Math.floor(rng() * 3);
    const working = world.order.filter((ca) => world.hives[ca].state !== 'abandoned' && world.hives[ca].source !== 'remote');
    for (let i = 0; i < n; i++) {
      // weighted by vigor
      const total = working.reduce((s, ca) => s + world.hives[ca].vigor, 0);
      let x = rng() * total;
      let chosen: Hive | undefined;
      for (const ca of working) {
        x -= world.hives[ca].vigor;
        if (x <= 0) {
          chosen = world.hives[ca];
          break;
        }
      }
      if (!chosen || chosen.vigor === 0) continue;
      const amount = range(rng, 0.02, 0.6) * (0.5 + chosen.vigor) * (chosen.ca === world.biggestCa ? 1.6 : 1);
      earnFees(world, chosen, amount, now, rng);
    }
  }
  if (now >= world.nextHarvestAt) {
    runHarvest(world, now, rng);
    changed = true;
  }
  if (world.seq % 8 === 0) {
    runStarvation(world, now, rng);
    centerBiggest(world);
    changed = true;
  }
  world.seq++;
  return changed;
}

/* ---------- empty cells ---------- */
/** Cells the simulated demo hives occupy (the same in every browser and on the server). */
export function demoCells(): Cell[] {
  return spiral(SEED_HIVES);
}

export function occupiedKeys(world: World) {
  return new Set(world.order.map((ca) => cellKey(world.hives[ca].cell)));
}

/**
 * The empty cells a new unit can be founded in: every free cell that touches an occupied one.
 * The comb only grows outward from its edge, so this is the clickable "empty box" ring.
 */
export function frontierCells(world: World): Cell[] {
  const taken = occupiedKeys(world);
  const out = new Map<string, Cell>();
  for (const ca of world.order) {
    for (const n of neighbors(world.hives[ca].cell)) {
      const k = cellKey(n);
      if (!taken.has(k) && !out.has(k)) out.set(k, n);
    }
  }
  return [...out.values()];
}

/** True when `cell` is free and on the edge of the comb, i.e. a unit can be founded there. */
export function isFoundable(world: World, cell: Cell) {
  const taken = occupiedKeys(world);
  if (taken.has(cellKey(cell))) return false;
  return world.order.length === 0 || neighbors(cell).some((n) => taken.has(cellKey(n)));
}

/* ---------- founding a new unit (mock launch) ---------- */
export interface FoundInput {
  name: string;
  ticker: string;
  image: string;
  description?: string;
  devBuy: number;
  owner?: string;
  /** Preferred empty cell. Used when it is still free and on the edge; otherwise the next free cell is taken. */
  cell?: Cell | null;
  look?: QueenLook;
  rules?: Partial<QueenRules>;
  motto?: string;
  temperament?: { dip: string; swarm: string };
}

export function foundHive(world: World, input: FoundInput, now = Date.now()): Hive {
  const rng = mulberry32((now ^ 0xabcdef) >>> 0);
  const taken = occupiedKeys(world);
  const cells = spiral(world.order.length + 40);
  const wanted = input.cell && isFoundable(world, input.cell) ? { q: input.cell.q, r: input.cell.r } : null;
  const cell: Cell = wanted ?? cells.find((c) => !taken.has(cellKey(c))) ?? { q: 0, r: 0 };
  const ca = mockAddress(rng);
  const price = 0.00000028;
  const h: Hive = {
    ca,
    name: input.name,
    ticker: input.ticker.toUpperCase(),
    image: input.image,
    queenWallet: mockAddress(rng),
    honey: QUEEN_RESERVE + input.devBuy * 0.8 * 0.01,
    bees: 1 + (input.devBuy > 0 ? 1 : 0),
    beesPeak: 2,
    feesTotal: input.devBuy * 0.01,
    feesHour: input.devBuy * 0.01,
    feesPrevHour: 0,
    feeAvgHour: 0.05,
    price,
    avg24h: price,
    state: 'working',
    swarmsIn: 0,
    swarmsOut: 0,
    swarmsWon: 0,
    royalJelly: 0,
    sealed: 0,
    bornAt: now,
    lastFeeAt: now,
    cell,
    vigor: 0.5,
    priceHistory: [{ time: Math.floor(now / 1000) - 1, value: price }],
    look: input.look,
    rules: input.rules ? clampRules(input.rules) : undefined,
    description: input.description?.trim() || undefined,
    motto: input.motto?.trim() || undefined,
    temperament: input.temperament,
  };
  world.hives[ca] = h;
  world.order.push(ca);
  pushAction(world, { ca, verb: 'born', amount: input.devBuy, reason: `${theme.unit} founded. ${theme.agent} wallet ${h.queenWallet.slice(0, 6)}… launched ${h.ticker} on pump.fun as creator${input.devBuy ? ` with a ${input.devBuy} SOL dev buy` : ''}.`, txSig: mockSig(rng), at: now });
  emit(world, 'spawn', ca);
  return h;
}

export function computeStats(world: World) {
  let bees = 0;
  let honey = 0;
  for (const ca of world.order) {
    const h = world.hives[ca];
    bees += h.bees;
    honey += h.honey;
  }
  return { hives: world.order.length, bees, honey, burned: world.hubBurnedTotal, nextHarvestAt: world.nextHarvestAt };
}
