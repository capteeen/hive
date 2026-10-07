import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileDb } from '@/lib/server/db-file';
import { candidateCells, claimLaunchCell } from '@/lib/server/cells';
import { config } from '@/lib/server/config';
import { demoCells } from '@/lib/sim';
import { cellKey, hexDistance, neighbors } from '@/lib/hex';
import type { RemoteHive } from '@/lib/shared/api';
import type { Cell } from '@/lib/types';

let dir: string;
let db: FileDb;
const demoDefault = config.demoHives;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'hive-cells-'));
  db = new FileDb(dir, { isolated: true });
});
afterEach(async () => {
  config.demoHives = demoDefault;
  await rm(dir, { recursive: true, force: true });
});

const hive = (ca: string, cell: Cell): RemoteHive => ({
  ca,
  name: ca,
  ticker: 'HV',
  image: '',
  cell,
  queenWallet: `queen-${ca}`,
  ownerWallet: 'guest:owner01',
  devBuy: 0,
  status: 'mock',
  honey: 0,
  bees: 1,
  feesTotal: 0,
  royalJelly: 0,
  state: 'working',
  createdAt: 1,
  updatedAt: 1,
});

const keys = (cells: Cell[]) => cells.map(cellKey);
const soon = () => Date.now() + 60_000;

describe('candidateCells', () => {
  it('starts the comb at the origin when nothing exists (demo hives off)', async () => {
    config.demoHives = false;
    expect(await candidateCells(db, null, Date.now())).toEqual([{ q: 0, r: 0 }]);
  });

  it('offers only free cells on the edge of the comb', async () => {
    config.demoHives = false;
    await db.upsertHive(hive('A', { q: 0, r: 0 }));
    const c = await candidateCells(db, null, Date.now());
    expect(new Set(keys(c))).toEqual(new Set(keys(neighbors({ q: 0, r: 0 }))));
  });

  it('treats demo hives as taken when they are on', async () => {
    config.demoHives = true;
    const demo = new Set(keys(demoCells()));
    const c = await candidateCells(db, null, Date.now(), 500);
    expect(c.length).toBeGreaterThan(0);
    for (const cell of c) {
      expect(demo.has(cellKey(cell))).toBe(false);
      expect(neighbors(cell).some((n) => demo.has(cellKey(n)))).toBe(true);
    }
    // with demo hives off the same empty store starts at the origin, which demo mode covers
    config.demoHives = false;
    expect(await candidateCells(db, null, Date.now())).toEqual([{ q: 0, r: 0 }]);
  });

  it('puts the preferred cell first when it is free and on the edge', async () => {
    config.demoHives = false;
    await db.upsertHive(hive('A', { q: 0, r: 0 }));
    const preferred = { q: -1, r: 1 };
    const c = await candidateCells(db, preferred, Date.now());
    expect(c[0]).toEqual(preferred);
  });

  it('falls back to the nearest free edge cells when the preferred one is taken', async () => {
    config.demoHives = false;
    await db.upsertHive(hive('A', { q: 0, r: 0 }));
    await db.upsertHive(hive('B', { q: 1, r: 0 }));
    const preferred = { q: 1, r: 0 }; // occupied by B
    const c = await candidateCells(db, preferred, Date.now());
    expect(keys(c)).not.toContain(cellKey(preferred));
    const d = c.map((x) => hexDistance(x, preferred));
    expect(d[0]).toBe(1);
    expect([...d].sort((a, b) => a - b)).toEqual(d); // nearest first
  });

  it('treats unexpired claims as taken and expired ones as free', async () => {
    config.demoHives = false;
    await db.upsertHive(hive('A', { q: 0, r: 0 }));
    const now = Date.now();
    await db.claimCell([{ q: 1, r: 0 }], 'L1', now + 60_000);
    expect(keys(await candidateCells(db, null, now))).not.toContain('1,0');
    expect(keys(await candidateCells(db, null, now + 120_000))).toContain('1,0');
  });

  it('respects the limit', async () => {
    config.demoHives = true;
    expect(await candidateCells(db, null, Date.now(), 5)).toHaveLength(5);
  });
});

describe('claimLaunchCell', () => {
  it('reserves the preferred cell, changed = false', async () => {
    config.demoHives = false;
    await db.upsertHive(hive('A', { q: 0, r: 0 }));
    const r = await claimLaunchCell(db, { q: 0, r: 1 }, 'L1', soon());
    expect(r).toEqual({ cell: { q: 0, r: 1 }, changed: false });
    expect(keys(await db.takenCells(Date.now()))).toContain('0,1');
  });

  it('reserves the nearest free cell when the preferred one is taken, changed = true', async () => {
    config.demoHives = false;
    await db.upsertHive(hive('A', { q: 0, r: 0 }));
    await claimLaunchCell(db, { q: 0, r: 1 }, 'L1', soon());
    const r = await claimLaunchCell(db, { q: 0, r: 1 }, 'L2', soon());
    expect(r.changed).toBe(true);
    expect(cellKey(r.cell)).not.toBe('0,1');
    expect(hexDistance(r.cell, { q: 0, r: 1 })).toBe(1);
  });

  it('changed = false without a preference', async () => {
    config.demoHives = false;
    const r = await claimLaunchCell(db, null, 'L1', soon());
    expect(r).toEqual({ cell: { q: 0, r: 0 }, changed: false });
  });

  it('never hands one cell to two concurrent launches', async () => {
    config.demoHives = true;
    const preferred = (await candidateCells(db, null, Date.now()))[0];
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => claimLaunchCell(db, preferred, `L${i}`, soon())));
    const cells = results.map((r) => cellKey(r.cell));
    expect(new Set(cells).size).toBe(12);
    expect(results.filter((r) => !r.changed)).toHaveLength(1);
    const demo = new Set(keys(demoCells()));
    for (const c of cells) expect(demo.has(c)).toBe(false);
  });
});
