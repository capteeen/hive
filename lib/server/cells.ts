import 'server-only';
/**
 * Where a new hive may live: a free cell on the comb's edge. Demo hives (when enabled) occupy the
 * same spiral of cells in every browser, so the server treats them as taken too.
 */
import { demoCells } from '@/lib/sim';
import { cellKey, hexDistance, neighbors, spiralIndexOf } from '@/lib/hex';
import type { Cell } from '@/lib/types';
import type { Db } from './db';
import { config } from './config';

const ORIGIN: Cell = { q: 0, r: 0 };
const order = (c: Cell) => spiralIndexOf(c);

/** Free edge cells, best first: the preferred cell, then nearest to it, then spiral order. */
export async function candidateCells(db: Db, preferred: Cell | null, now: number, limit = 40): Promise<Cell[]> {
  const taken = new Set<string>();
  if (config.demoHives) for (const c of demoCells()) taken.add(cellKey(c));
  for (const c of await db.takenCells(now)) taken.add(cellKey(c));
  if (taken.size === 0) return [ORIGIN];
  const frontier = new Map<string, Cell>();
  for (const k of taken) {
    const [q, r] = k.split(',').map(Number);
    for (const n of neighbors({ q, r })) {
      const nk = cellKey(n);
      if (!taken.has(nk)) frontier.set(nk, n);
    }
  }
  const list = [...frontier.values()];
  const anchor = preferred ?? ORIGIN;
  list.sort((a, b) => hexDistance(a, anchor) - hexDistance(b, anchor) || order(a) - order(b));
  return list.slice(0, limit);
}

/** Reserve a cell for a launch. `changed` = the preferred cell was not available. */
export async function claimLaunchCell(db: Db, preferred: Cell | null, launchId: string, expiresAt: number, now = Date.now()): Promise<{ cell: Cell; changed: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidates = await candidateCells(db, preferred, now);
    const cell = await db.claimCell(candidates, launchId, expiresAt);
    if (cell) return { cell, changed: !!preferred && (cell.q !== preferred.q || cell.r !== preferred.r) };
  }
  throw new Error('No free cell could be reserved. Try again in a moment.');
}
