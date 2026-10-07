import type { QueenLook, QueenRules } from './queen';

export type HiveState = 'working' | 'starving' | 'abandoned';
export type ActionVerb = 'seal' | 'store' | 'swarm' | 'starve' | 'abandon' | 'jelly' | 'born';

export interface Cell {
  q: number;
  r: number;
}

/** What the user is pointing at or has selected on the comb: a hive, an empty cell, or nothing. */
export type CombPick = { kind: 'hive'; ca: string } | { kind: 'empty'; q: number; r: number } | null;

export const pickKey = (p: CombPick) => (!p ? '' : p.kind === 'hive' ? `h:${p.ca}` : `e:${p.q},${p.r}`);

export interface Hive {
  ca: string;
  name: string;
  ticker: string;
  image: string; // url or data url
  queenWallet: string;
  honey: number; // SOL in vault
  bees: number; // holders
  feesTotal: number; // SOL
  feesHour: number; // SOL earned in the trailing hour
  feesPrevHour: number; // SOL earned the hour before (for growth)
  feeAvgHour: number; // EMA of hourly fees
  price: number; // SOL per token (mock)
  avg24h: number; // 24h average price
  state: HiveState;
  swarmsIn: number;
  swarmsOut: number;
  swarmsWon: number;
  royalJelly: number; // SOL received from the hub
  sealed: number; // share of supply sealed (0..1)
  bornAt: number;
  lastFeeAt: number;
  cell: Cell;
  /** mock: how likely this hive earns on a tick (0..1). 0 = dead. */
  vigor: number;
  /** mock: holders the hive had before starving started (for decay display). */
  beesPeak: number;
  priceHistory: PricePoint[];
  /** Set for hives founded through the wizard. */
  look?: QueenLook;
  rules?: QueenRules;
  description?: string;
  motto?: string;
  temperament?: { dip: string; swarm: string };
}

export interface PricePoint {
  time: number; // unix seconds
  value: number;
}

export interface Action {
  id: string;
  ca: string;
  verb: ActionVerb;
  amount: number; // SOL
  targetCa?: string;
  reason: string;
  txSig?: string;
  at: number;
}

export interface Harvest {
  id: string;
  at: number;
  feesIn: number; // SOL
  hiveBought: number; // hub tokens bought
  burned: number; // hub tokens burned
  jellyTo: string; // ca
  jellyAmount: number; // hub tokens sent (as SOL value for display we keep both)
  jellySol: number;
  txSig: string;
}

export interface Stats {
  hives: number;
  bees: number;
  honey: number;
  burned: number;
  nextHarvestAt: number;
}

export type SceneEventType = 'seal' | 'store' | 'swarm' | 'harvest' | 'starve' | 'abandon' | 'spawn' | 'jelly';

export interface SceneEvent {
  id: number;
  type: SceneEventType;
  ca: string;
  targetCa?: string;
  amount?: number;
  at: number;
}

export interface World {
  hives: Record<string, Hive>;
  order: string[]; // insertion order of CAs
  actions: Action[]; // newest first, capped
  harvests: Harvest[]; // newest first
  hubPool: number; // SOL waiting for the next harvest
  hubBurnedTotal: number; // hub tokens burned total
  hubPrice: number; // SOL per hub token (mock)
  nextHarvestAt: number;
  events: SceneEvent[]; // pending scene events (consumed by renderer)
  eventSeq: number;
  seq: number;
  biggestCa: string;
}
