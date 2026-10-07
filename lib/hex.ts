import type { Cell } from './types';

/** Pointy-top axial hex math. */
export const SQRT3 = Math.sqrt(3);

export function axialToXY(c: Cell, size = 1): [number, number] {
  return [size * SQRT3 * (c.q + c.r / 2), size * 1.5 * c.r];
}

export function hexDistance(a: Cell, b: Cell) {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

const DIRS: Cell[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function neighbors(c: Cell): Cell[] {
  return DIRS.map((d) => ({ q: c.q + d.q, r: c.r + d.r }));
}

/** Spiral of cells from the center outward: index 0 = (0,0), then ring 1, ring 2, ... */
export function spiral(count: number): Cell[] {
  const out: Cell[] = [{ q: 0, r: 0 }];
  let ring = 1;
  while (out.length < count) {
    let q = -ring;
    let r = ring;
    for (let side = 0; side < 6; side++) {
      for (let step = 0; step < ring; step++) {
        out.push({ q, r });
        q += DIRS[side].q;
        r += DIRS[side].r;
        if (out.length >= count) return out;
      }
    }
    ring++;
  }
  return out;
}

export const cellKey = (c: Cell) => `${c.q},${c.r}`;

/** Circular ring layout for the 'den' scene: index → xy on concentric rings. */
export function ringXY(index: number, spacing = 2.1): [number, number] {
  if (index === 0) return [0, 0];
  let ring = 1;
  let start = 1;
  while (index >= start + ring * 6) {
    start += ring * 6;
    ring++;
  }
  const n = ring * 6;
  const i = index - start;
  const a = (i / n) * Math.PI * 2 + ring * 0.35;
  const rad = ring * spacing;
  return [Math.cos(a) * rad, Math.sin(a) * rad];
}
