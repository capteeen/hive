'use client';
import { create } from 'zustand';
import { createWorld, createClock, stepWorld, foundHive, computeStats, SEED, type SimClock, type FoundInput } from './sim';
import type { World, Hive, Action, Harvest, SceneEvent, SceneEventType, Stats } from './types';
import type { HivesResponse, PublicConfig, RemoteAction, RemoteHarvest, RemoteHive } from './shared/api';
import { remoteToAction, remoteToHarvest, remoteToHive } from './remoteMap';
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
  /** CAs founded by the connected wallet in this session (mock). */
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

/** Fixed epoch so server and client hydrate identical markup; start() re-seeds with the real clock. */
const FIXED_EPOCH = 1_760_000_000_000;
const initialWorld = createWorld(SEED, FIXED_EPOCH);
let clock: SimClock | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export const useHive = create<HiveStore>((set, get) => ({
  world: initialWorld,
  version: 0,
  stats: computeStats(initialWorld),
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
    set({ config: c });
    // the server can turn the simulated demo hives off: keep only remote hives
    if (!c.demoHives && (prev === null || prev.demoHives)) {
      const w = get().world;
      for (const ca of [...w.order]) if (w.hives[ca].source !== 'remote') delete w.hives[ca];
      w.order = w.order.filter((ca) => !!w.hives[ca]);
      w.actions = w.actions.filter((a) => !!w.hives[a.ca]);
      w.harvests = [];
      w.biggestCa = w.order[0] ?? '';
      set({ world: w, version: get().version + 1, stats: computeStats(w), positions: [] });
    }
  },
  setOwnerIds: (ids) => {
    const w = get().world;
    const own = new Set(ids);
    const mine = new Set(get().mine);
    for (const ca of w.order) if (w.hives[ca].ownerWallet && own.has(w.hives[ca].ownerWallet!)) mine.add(ca);
    set({ ownerIds: ids, mine: [...mine] });
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
      changed = true;
    }
    if (data.actions?.length) {
      const seen = new Set(w.actions.map((a) => a.id));
      const fresh: Action[] = [];
      for (const a of data.actions) {
        if (seen.has(a.id) || !w.hives[a.ca]) continue;
        fresh.push(remoteToAction(a));
        const h = w.hives[a.ca];
        if (a.verb === 'swarm') {
          h.swarmsOut++;
          if (a.targetCa && w.hives[a.targetCa]) w.hives[a.targetCa].swarmsIn++;
        }
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
        if (!opts.initial) for (const h of fresh) emit('harvest', h.jellyTo, { amount: h.feesIn });
        changed = true;
      }
    }
    if (changed) set({ world: w, version: get().version + 1, stats: computeStats(w), mine: [...mine] });
  },
  markMine: (ca) => {
    if (!get().mine.includes(ca)) set({ mine: [...get().mine, ca] });
  },
  start: () => {
    if (get().started || typeof window === 'undefined') return;
    // Re-seed with the real "now" so starvation timers line up on the client.
    const world = createWorld(SEED, Date.now());
    clock = createClock();
    // mock positions for /me: the 2nd, 7th biggest and one abandoned hive
    const order = world.order;
    const positions: Position[] = [
      { ca: order[1], tokens: 12_400_000, share: 0.0124 },
      { ca: order[6], tokens: 31_000_000, share: 0.031 },
      { ca: order[58], tokens: 54_000_000, share: 0.054 },
      { ca: order[59], tokens: 8_000_000, share: 0.008 },
    ];
    set({ world, stats: computeStats(world), started: true, positions, version: 1 });
    timer = setInterval(() => {
      const w = get().world;
      if (stepWorld(w, clock!, Date.now())) {
        set({ world: w, version: get().version + 1, stats: computeStats(w) });
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
    set({ world: w, version: get().version + 1, stats: computeStats(w), mine: [...get().mine, h.ca] });
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
