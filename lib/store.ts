'use client';
import { create } from 'zustand';
import { createWorld, createClock, stepWorld, foundHive, computeStats, SEED, type SimClock } from './sim';
import type { World, Hive, Action, Harvest, SceneEvent, Stats } from './types';

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
  /** CAs founded by the connected wallet in this session (mock). */
  mine: string[];
  /** Mock holdings for /me. */
  positions: Position[];
  claimed: string[];
  started: boolean;
  start: () => void;
  found: (input: { name: string; ticker: string; image: string; description?: string; devBuy: number }) => Hive;
  claim: (ca: string) => void;
  toggleMode: () => void;
  toggleSound: () => void;
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
  mine: [],
  positions: [],
  claimed: [],
  started: false,
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
