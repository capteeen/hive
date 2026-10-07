'use client';
import { create } from 'zustand';
import { createWorld, createClock, stepWorld, foundHive, computeStats, SEED, HOUR_MS, type SimClock, type FoundInput } from './sim';
import type { World, Hive, Action, Harvest, SceneEvent, SceneEventType, Stats } from './types';
import type { HivesResponse, PublicConfig, RemoteAction, RemoteHarvest, RemoteHive } from './shared/api';
import { isServerHarvest, remoteToAction, remoteToHarvest, remoteToHive } from './remoteMap';
import { cellKey } from './hex';
import { setSfxEnabled } from './sfx';

interface Position {
  ca: string;
  tokens: number;
  share: number; // share of supply (0..1)
}

interface HiveStore {
  world: World;
  version: number;
  stats: Stats;
  mode: 'night' | 'day';
  sound: boolean;
  /** UI click sounds (on by default, persisted). */
  sfx: boolean;
  /**
   * "Your" hives. Remote hives: exactly those whose owner is one of `ownerIds` (recomputed when they
   * change). Hives founded only in this browser (found / markMine) keep their mark.
   */
  mine: string[];
  /** Mock holdings for /me. */
  positions: Position[];
  claimed: string[];
  started: boolean;
  /** Server config (launch mode, realtime transport), once loaded. */
  config: PublicConfig | null;
  /** Wallet / guest ids that count as "me" for ownership. */
  ownerIds: string[];
  /** Server connection state for the live feed. */
  feed: 'connecting' | 'live' | 'offline';
  setConfig: (c: PublicConfig) => void;
  setOwnerIds: (ids: string[]) => void;
  setFeed: (f: 'connecting' | 'live' | 'offline') => void;
  /** Merge hives / actions / harvests stored server-side (every user sees these). */
  applyRemote: (data: Partial<Pick<HivesResponse, 'hives' | 'actions' | 'harvests'>>, opts?: { initial?: boolean }) => void;
  markMine: (ca: string) => void;
  start: () => void;
  found: (input: FoundInput) => Hive;
  claim: (ca: string) => void;
  toggleMode: () => void;
  toggleSound: () => void;
  toggleSfx: () => void;
  consumeEvents: (afterId: number) => SceneEvent[];
}

/**
 * Whether this build shows the 60 simulated demo hives before /api/config says otherwise. Next inlines
 * NEXT_PUBLIC_DEMO_HIVES into the browser bundle at build time and the server reads the same variable, so
 * SSR and hydration agree. Off unless set (`=1` for local play), like the server's config.demoHives: a
 * real deployment never flashes made-up hives while the config loads.
 */
export const BUILD_DEMO_HIVES = ((v) => !!v && !/^(0|false|no|off)$/i.test(v))((process.env.NEXT_PUBLIC_DEMO_HIVES ?? '').trim());

/** Fixed epoch so server and client hydrate identical markup; start() re-seeds with the real clock. */
const FIXED_EPOCH = 1_760_000_000_000;
const initialWorld = createWorld(SEED, FIXED_EPOCH, BUILD_DEMO_HIVES);
let clock: SimClock | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** One real hour: the live engine harvests on the hour (cron "0 * * * *", engine-plan.ts LIVE_HOUR_MS). */
const LIVE_HOUR_MS = 3_600_000;
/** The server's harvest hour: real hours in live launch mode, the mock hour (sim.ts HOUR_MS) otherwise. */
export const harvestHourMs = (cfg: PublicConfig | null) => (cfg?.launchMode === 'live' ? LIVE_HOUR_MS : HOUR_MS);
/** Whether the simulated demo hives are shown: the server's say once /api/config has loaded, the build's until then. */
export const demoOn = (cfg: PublicConfig | null) => (cfg ? cfg.demoHives : BUILD_DEMO_HIVES);

/** Mock holdings for /me (demo only): the 2nd, 7th biggest and two abandoned demo hives. */
const demoPositions = (order: string[]): Position[] => [
  { ca: order[1], tokens: 12_400_000, share: 0.0124 },
  { ca: order[6], tokens: 31_000_000, share: 0.031 },
  { ca: order[58], tokens: 54_000_000, share: 0.054 },
  { ca: order[59], tokens: 8_000_000, share: 0.008 },
];

/**
 * The server turned demo hives on although this build started without them: seed them around the remote
 * hives already loaded (a demo hive whose cell a remote hive holds is left out). Returns the demo positions.
 */
function addDemo(w: World, now: number): Position[] {
  const demo = createWorld(SEED, now, true);
  const taken = new Set(w.order.map((ca) => cellKey(w.hives[ca].cell)));
  const kept = demo.order.filter((ca) => !taken.has(cellKey(demo.hives[ca].cell)) && !w.hives[ca]);
  for (const ca of kept) w.hives[ca] = demo.hives[ca];
  w.order = [...kept, ...w.order];
  w.actions = [...demo.actions.filter((a) => !!w.hives[a.ca]), ...w.actions].sort((x, y) => y.at - x.at).slice(0, 240);
  w.harvests = [...demo.harvests, ...w.harvests].sort((x, y) => y.at - x.at).slice(0, 120);
  w.hubPool = demo.hubPool;
  w.hubPrice = demo.hubPrice;
  w.hubBurnedTotal = demo.hubBurnedTotal;
  w.nextHarvestAt = demo.nextHarvestAt;
  w.biggestCa = demo.biggestCa;
  return demoPositions(demo.order);
}

/**
 * Line the simulator's next harvest up with the server. Demo off: nothing is simulated, so stepWorld must
 * never harvest (Infinity; the countdown then comes from the server's cadence, see statsOf). Live: the
 * simulated demo harvest waits for the real hour too. Mock with demo hives: the mock hours already match.
 */
function alignHarvest(w: World, cfg: PublicConfig | null) {
  if (!demoOn(cfg)) w.nextHarvestAt = Infinity;
  else if (cfg?.launchMode === 'live') w.nextHarvestAt = Math.ceil(w.nextHarvestAt / LIVE_HOUR_MS) * LIVE_HOUR_MS;
}

/** computeStats, with the countdown on the server's next harvest when nothing is simulated. */
function statsOf(w: World, cfg: PublicConfig | null, now = Date.now()): Stats {
  const s = computeStats(w);
  if (!Number.isFinite(s.nextHarvestAt)) {
    const hour = harvestHourMs(cfg);
    s.nextHarvestAt = Math.ceil(now / hour) * hour;
  }
  return s;
}

/** Demo off: the burn total is what the server's listed harvests burned (a dry run burns nothing). */
const serverBurned = (w: World) => w.harvests.reduce((sum, h) => sum + (isServerHarvest(h) && !h.dryRun ? h.burned : 0), 0);

/**
 * Remote swarm actions already counted into swarmsOut / swarmsIn, by action id. world.actions cannot
 * tell: it is capped and the demo simulator pushes old entries out, while every re-fetch of
 * /api/hives brings them back.
 */
const countedSwarms = { out: new Set<string>(), in: new Set<string>() };

/** Remote hives are mine exactly when their owner is one of `ids`; local ones (and CAs not loaded yet) keep their mark. */
function recomputeMine(w: World, prev: string[], ids: string[]): string[] {
  const own = new Set(ids);
  const owned = (ca: string) => {
    const h = w.hives[ca];
    return !!h?.ownerWallet && own.has(h.ownerWallet);
  };
  const out = new Set<string>();
  for (const ca of prev) if (w.hives[ca]?.source !== 'remote' || owned(ca)) out.add(ca);
  for (const ca of w.order) if (w.hives[ca].source === 'remote' && owned(ca)) out.add(ca);
  return [...out];
}

export const useHive = create<HiveStore>((set, get) => ({
  world: initialWorld,
  version: 0,
  stats: statsOf(initialWorld, null, FIXED_EPOCH),
  mode: 'night',
  sound: false,
  sfx: true,
  mine: [],
  positions: [],
  claimed: [],
  started: false,
  config: null,
  ownerIds: [],
  feed: 'connecting',
  setConfig: (c) => {
    const prev = get().config;
    const w = get().world;
    const patch: Partial<HiveStore> = {};
    // the server can turn the simulated demo hives off: keep only remote hives, and no demo hub numbers
    if (!c.demoHives && demoOn(prev)) {
      for (const ca of [...w.order]) if (w.hives[ca].source !== 'remote') delete w.hives[ca];
      w.order = w.order.filter((ca) => !!w.hives[ca]);
      w.actions = w.actions.filter((a) => !!w.hives[a.ca]);
      w.harvests = w.harvests.filter(isServerHarvest);
      w.biggestCa = w.order[0] ?? '';
      w.hubPool = 0; // the server does not publish its pool or the $HIVE price
      w.hubPrice = 0;
      w.hubBurnedTotal = serverBurned(w);
      patch.positions = [];
    } else if (c.demoHives && !demoOn(prev)) {
      patch.positions = addDemo(w, Date.now());
      if (!get().started) patch.positions = []; // start() seeds them with the world it creates
    }
    alignHarvest(w, c);
    // One update: a subscriber waiting for the config (HivePage's lookup) must not see the demo hives.
    set({ ...patch, config: c, world: w, version: get().version + 1, stats: statsOf(w, c) });
  },
  setOwnerIds: (ids) => {
    set({ ownerIds: ids, mine: recomputeMine(get().world, get().mine, ids) });
  },
  setFeed: (f) => set({ feed: f }),
  applyRemote: (data, opts = {}) => {
    const w = get().world;
    const own = new Set(get().ownerIds);
    const mine = new Set(get().mine);
    const now = Date.now();
    const emit = (type: SceneEventType, ca: string, extra: Partial<SceneEvent> = {}) => {
      w.events.push({ id: ++w.eventSeq, type, ca, at: now, ...extra });
      if (w.events.length > 200) w.events.splice(0, w.events.length - 200);
    };
    let changed = false;
    for (const r of data.hives ?? []) {
      const prev = w.hives[r.ca];
      if (prev && prev.source !== 'remote') continue;
      // never stack two hives on one cell (e.g. a demo hive where the server placed a remote one)
      if (!prev) {
        const clash = w.order.find((ca) => w.hives[ca].cell.q === r.cell.q && w.hives[ca].cell.r === r.cell.r);
        if (clash && w.hives[clash].source !== 'remote') continue;
      }
      w.hives[r.ca] = remoteToHive(r, prev);
      if (!prev) {
        w.order.push(r.ca);
        if (!opts.initial && now - r.createdAt < 120_000) emit('spawn', r.ca);
      } else if (prev.state !== r.state && !opts.initial) {
        if (r.state === 'starving') emit('starve', r.ca);
        if (r.state === 'abandoned') emit('abandon', r.ca);
      }
      if (r.ownerWallet && own.has(r.ownerWallet)) mine.add(r.ca);
      else mine.delete(r.ca);
      changed = true;
    }
    if (data.actions?.length) {
      const seen = new Set(w.actions.map((a) => a.id));
      const fresh: Action[] = [];
      for (const a of data.actions) {
        if (!w.hives[a.ca]) continue;
        // counted once per action id and side (the target may arrive later), never per sighting
        if (a.verb === 'swarm') {
          if (!countedSwarms.out.has(a.id)) {
            countedSwarms.out.add(a.id);
            w.hives[a.ca].swarmsOut++;
            changed = true;
          }
          const target = a.targetCa ? w.hives[a.targetCa] : undefined;
          if (target && !countedSwarms.in.has(a.id)) {
            countedSwarms.in.add(a.id);
            target.swarmsIn++;
            changed = true;
          }
        }
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        fresh.push(remoteToAction(a));
        if (!opts.initial && !a.dryRun) {
          if (a.verb === 'seal') emit('seal', a.ca, { amount: a.amount });
          else if (a.verb === 'store') emit('store', a.ca, { amount: a.amount });
          else if (a.verb === 'swarm' && a.targetCa) emit('swarm', a.ca, { targetCa: a.targetCa, amount: a.amount });
          else if (a.verb === 'jelly') emit('jelly', a.ca, { amount: a.amount });
        }
      }
      if (fresh.length) {
        w.actions = [...fresh, ...w.actions].sort((x, y) => y.at - x.at).slice(0, 240);
        changed = true;
      }
    }
    if (data.harvests?.length) {
      const seen = new Set(w.harvests.map((h) => h.id));
      const fresh = data.harvests.filter((h) => !seen.has(h.id)).map(remoteToHarvest);
      if (fresh.length) {
        w.harvests = [...fresh, ...w.harvests].sort((x, y) => y.at - x.at).slice(0, 120);
        if (!demoOn(get().config)) w.hubBurnedTotal = serverBurned(w);
        if (!opts.initial) for (const h of fresh) emit('harvest', h.jellyTo, { amount: h.feesIn });
        changed = true;
      }
    }
    if (changed) set({ world: w, version: get().version + 1, stats: statsOf(w, get().config), mine: [...mine] });
  },
  markMine: (ca) => {
    if (!get().mine.includes(ca)) set({ mine: [...get().mine, ca] });
  },
  start: () => {
    if (get().started || typeof window === 'undefined') return;
    const config = get().config;
    const demo = demoOn(config);
    // Re-seed with the real "now" so starvation timers line up on the client.
    const world = createWorld(SEED, Date.now(), demo);
    alignHarvest(world, config);
    clock = createClock();
    countedSwarms.out.clear(); // the re-seeded world holds no remote hives yet
    countedSwarms.in.clear();
    const positions: Position[] = demo ? demoPositions(world.order) : [];
    set({ world, stats: statsOf(world, config), started: true, positions, version: 1 });
    timer = setInterval(() => {
      const s = get();
      const w = s.world;
      const now = Date.now();
      if (!demoOn(s.config)) {
        // nothing to simulate: only move the countdown on to the server's next harvest
        if (now >= s.stats.nextHarvestAt) set({ stats: statsOf(w, s.config, now) });
        return;
      }
      if (stepWorld(w, clock!, now)) {
        alignHarvest(w, s.config);
        set({ world: w, version: get().version + 1, stats: statsOf(w, s.config, now) });
      }
    }, 250);
    try {
      const m = localStorage.getItem('hive:mode');
      if (m === 'day' || m === 'night') set({ mode: m });
      const fx = localStorage.getItem('hive:sfx');
      if (fx === '0') {
        set({ sfx: false });
        setSfxEnabled(false);
      }
    } catch {}
  },
  found: (input) => {
    const w = get().world;
    const h = foundHive(w, input);
    set({ world: w, version: get().version + 1, stats: statsOf(w, get().config), mine: [...get().mine, h.ca] });
    return h;
  },
  claim: (ca) => set({ claimed: [...get().claimed, ca] }),
  toggleMode: () => {
    const mode = get().mode === 'night' ? 'day' : 'night';
    set({ mode });
    try {
      localStorage.setItem('hive:mode', mode);
    } catch {}
  },
  toggleSound: () => set({ sound: !get().sound }),
  toggleSfx: () => {
    const on = !get().sfx;
    set({ sfx: on });
    setSfxEnabled(on);
    try {
      localStorage.setItem('hive:sfx', on ? '1' : '0');
    } catch {}
  },
  consumeEvents: (afterId) => get().world.events.filter((e) => e.id > afterId),
}));

if (typeof window !== 'undefined') (window as unknown as { __hive?: typeof useHive }).__hive = useHive;

export function stopSim() {
  if (timer) clearInterval(timer);
  timer = null;
}

/* ---------- selectors ---------- */
export const selectHives = (s: HiveStore): Hive[] => s.world.order.map((ca) => s.world.hives[ca]);
export const selectActions = (s: HiveStore): Action[] => s.world.actions;
export const selectHarvests = (s: HiveStore): Harvest[] => s.world.harvests;
export const selectHive = (ca: string) => (s: HiveStore): Hive | undefined => s.world.hives[ca];
