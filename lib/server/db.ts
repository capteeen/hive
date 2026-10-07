import 'server-only';
/**
 * Persistence contract. Two implementations:
 *  - FileDb (lib/server/db-file.ts): JSON files under DATA_DIR + an in-process event bus. Default; single server.
 *  - SupabaseDb (lib/server/db-supabase.ts): Postgres via the service-role key; realtime via supabase_realtime.
 * Every write that other users should see must go through upsertHive / addAction / addHarvest so the
 * realtime layer (SSE or Supabase) broadcasts it.
 */
import type { Cell } from '@/lib/types';
import type { LaunchPayload, LaunchState, LaunchMode, RemoteAction, RemoteHarvest, RemoteHive, StreamEvent } from '@/lib/shared/api';
import { config, hasSupabase } from './config';

export interface LaunchRecord {
  id: string;
  mode: LaunchMode;
  state: LaunchState;
  owner: string;
  /** Full payload including the (downscaled) image data URL. */
  payload: LaunchPayload;
  queenWallet: string;
  /** Mint keypair, generated at prepare so `create` is idempotent across retries. Encrypted. */
  mintPubkey: string;
  mintSecretEnc: string;
  cell: Cell;
  lamports: number;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  ca?: string;
  metadataUri?: string;
  imageUri?: string;
  txs: { payment?: string; create?: string; devTransfer?: string; refund?: string };
  error?: string;
  attempts: number;
}

export interface Db {
  readonly kind: 'file' | 'supabase';

  listHives(): Promise<RemoteHive[]>;
  getHive(ca: string): Promise<RemoteHive | null>;
  upsertHive(h: RemoteHive): Promise<void>;

  listActions(limit: number, ca?: string): Promise<RemoteAction[]>;
  addAction(a: RemoteAction): Promise<void>;
  listHarvests(limit: number): Promise<RemoteHarvest[]>;
  addHarvest(h: RemoteHarvest): Promise<void>;

  /**
   * Atomically claim a cell for a launch. Tries `candidates` in order (already filtered to free
   * frontier cells by the caller) and returns the first one it could claim, or null if none.
   * A claim made with `expiresAt` lapses unless `finalizeCell` is called; expired claims are free again.
   */
  claimCell(candidates: Cell[], launchId: string, expiresAt: number): Promise<Cell | null>;
  /** Make a launch's claim permanent (the hive is live). */
  finalizeCell(launchId: string): Promise<void>;
  releaseCell(launchId: string): Promise<void>;
  /** Cells taken by hives or by unexpired claims. */
  takenCells(now: number): Promise<Cell[]>;

  createLaunch(l: LaunchRecord): Promise<void>;
  getLaunch(id: string): Promise<LaunchRecord | null>;
  /**
   * Compare-and-set update: applies `patch` only if the launch's current state is in `expect`.
   * Returns the updated record, or null if the state did not match (someone else advanced it).
   */
  updateLaunch(id: string, patch: Partial<LaunchRecord>, expect: LaunchState[]): Promise<LaunchRecord | null>;
  listLaunches(states: LaunchState[]): Promise<LaunchRecord[]>;

  /** Encrypted secret keys (queens, mints). Never exposed to clients. */
  putSecret(pubkey: string, enc: string): Promise<void>;
  getSecret(pubkey: string): Promise<string | null>;

  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  /** Try to take a named lock until `until` (ms). Returns false if someone else holds it. */
  lock(name: string, until: number): Promise<boolean>;
  unlock(name: string): Promise<void>;

  /** Price snapshots (SOL per token) for 24h averages and charts. */
  addPrice(ca: string, at: number, price: number): Promise<void>;
  listPrices(ca: string, since: number): Promise<{ at: number; price: number }[]>;

  /** In-process change feed used by the SSE endpoint (file mode). Supabase mode may no-op. */
  subscribe(fn: (ev: StreamEvent) => void): () => void;
}

let instance: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  if (!instance) {
    instance = (async () => {
      if (hasSupabase()) {
        const { SupabaseDb } = await import('./db-supabase');
        return new SupabaseDb(config.supabase.url!, config.supabase.serviceKey!);
      }
      const { FileDb } = await import('./db-file');
      return new FileDb(config.dataDir);
    })();
  }
  return instance;
}

/** Test hook. */
export function setDbForTests(db: Db | null) {
  instance = db ? Promise.resolve(db) : null;
}
