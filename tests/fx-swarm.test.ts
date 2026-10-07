import { describe, expect, it } from 'vitest';
import { hive } from '@/themes/hive';
import { pack } from '@/themes/pack';
import {
  BEE_H,
  PERCH_SCALE,
  type Bee,
  type Candidate,
  type Rect,
  type View,
  ambienceOf,
  beeBox,
  chooseLanding,
  depthScale,
  makeBee,
  perchIsClear,
  perchOn,
  pickSpecial,
  specialGap,
  startCurious,
  startFlee,
  startFlyby,
  startLanding,
  stepBee,
  swarmCount,
} from '@/components/fx/swarmModel';

/**
 * The ambient swarm's pure logic (components/fx/swarmModel): counts per screen, theme gating,
 * perches that keep controls clickable, the rare-behaviour scheduler and smooth, bounded flight.
 */

/** Small seeded PRNG (mulberry32) so every run flies the same bees. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DESK: View = { w: 1440, h: 900, top: 64 };
const PHONE: View = { w: 390, h: 844, top: 100 };
const on = { reduced: false, enabled: true, critter: true };

describe('how many bees', () => {
  it('2 on phones, 4 on tablets / small laptops, 5 on desktops (plus one fly-by slot)', () => {
    expect(swarmCount(390, on)).toBe(2);
    expect(swarmCount(767, on)).toBe(2);
    expect(swarmCount(1024, on)).toBe(4);
    expect(swarmCount(1440, on)).toBe(5);
    expect(swarmCount(2560, on)).toBe(5);
  });

  it('none under reduced motion, with the Bees switch off, or without a critter', () => {
    expect(swarmCount(1440, { ...on, reduced: true })).toBe(0);
    expect(swarmCount(390, { ...on, reduced: true })).toBe(0);
    expect(swarmCount(1440, { ...on, enabled: false })).toBe(0);
    expect(swarmCount(1440, { ...on, critter: false })).toBe(0);
  });

  it('the hive theme flies bees and pours honey; pack (wolves) gets neither; a theme without the field gets nothing', () => {
    expect(ambienceOf(hive)).toEqual({ critter: 'bee', honey: true });
    expect(ambienceOf(pack)).toEqual({ critter: null, honey: false });
    expect(ambienceOf({})).toEqual({ critter: null, honey: false });
    expect(swarmCount(1440, { ...on, critter: !!ambienceOf(pack).critter })).toBe(0);
  });
});

describe('perches keep controls clickable', () => {
  const button = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height });

  it('a perch is on the top edge near a corner, never over the centre, and hides at most a fifth', () => {
    const rnd = seeded(7);
    for (let i = 0; i < 4000; i++) {
      const r = button(100 + rnd() * 900, 120 + rnd() * 600, 28 + rnd() * 300, 14 + rnd() * 80);
      const p = perchOn(r, PERCH_SCALE, rnd);
      expect(p).not.toBeNull();
      if (!p) continue;
      // standing on the top edge: centre above it, feet (PERCH_LIFT below the centre) on it
      expect(p.y).toBeLessThan(r.top);
      expect(Math.abs(p.y + BEE_H * PERCH_SCALE * 0.3 - r.top)).toBeLessThan(0.01);
      // within the outer quarter of the edge, clear of the corner itself
      const fromEdge = Math.min(p.x - r.left, r.left + r.width - p.x);
      expect(fromEdge).toBeGreaterThanOrEqual(14 - 1e-9);
      expect(fromEdge).toBeLessThanOrEqual(Math.max(14, r.width / 4) + 1e-9);
      // faces into the element
      expect(p.face).toBe(p.x < r.left + r.width / 2 ? 1 : -1);
      // a bigger control loses at most a fifth to the bee (tiny ones are refused by chooseLanding)
      if (r.width >= 80 && r.height >= 30) expect(perchIsClear(p, PERCH_SCALE, r)).toBe(true);
      const box = beeBox(p.x, p.y, PERCH_SCALE);
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      expect(cx >= box.left && cx <= box.left + box.width && cy >= box.top && cy <= box.top + box.height).toBe(false);
    }
  });

  it('no perch on elements too small to stand on', () => {
    expect(perchOn(button(10, 200, 20, 30), 1, seeded(1))).toBeNull();
    expect(perchOn(button(10, 200, 120, 10), 1, seeded(1))).toBeNull();
  });

  it('a perch over the middle of a control is refused', () => {
    const r = button(100, 300, 120, 40);
    expect(perchIsClear({ x: 160, y: 320 }, 1, r)).toBe(false); // on the click point
    expect(perchIsClear({ x: 120, y: 300 - BEE_H * 0.3 }, 1, r)).toBe(true); // on the top-left edge
  });

  it('only lands on elements fully on screen, below the nav (the logo excepted), and not on huge blocks', () => {
    const rnd = seeded(3);
    const cands: Candidate[] = [
      { rect: button(100, 30, 140, 36), kind: 'control' }, // under the nav
      { rect: button(100, 880, 140, 36), kind: 'control' }, // cut off at the bottom
      { rect: button(-20, 300, 140, 36), kind: 'control' }, // cut off at the left
      { rect: button(1400, 300, 140, 36), kind: 'control' }, // cut off at the right
      { rect: button(0, 70, 1440, 800), kind: 'heading' }, // a huge block
    ];
    for (let i = 0; i < 200; i++) expect(chooseLanding(cands, DESK, PERCH_SCALE, rnd)).toBeNull();
    // the real nav logo: 28 px, 18 px from the top of the screen
    const ok: Candidate[] = [...cands, { rect: button(600, 420, 160, 44), kind: 'control' }, { rect: button(20, 18, 28, 28), kind: 'logo' }];
    const picked = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const got = chooseLanding(ok, DESK, PERCH_SCALE, rnd);
      expect(got).not.toBeNull();
      const { index, perch } = got!;
      picked.add(index);
      const r = ok[index].rect;
      expect(perchIsClear(perch, perch.scale, r, ok[index].kind === 'logo' ? 0.45 : 0.2)).toBe(true);
      // the whole bee (bar its wing tips' air) stays on screen
      expect(beeBox(perch.x, perch.y, perch.scale).top).toBeGreaterThanOrEqual(-4);
    }
    expect([...picked].sort()).toEqual([5, 6]);
  });

  it('nothing to land on: null', () => {
    expect(chooseLanding([], DESK, PERCH_SCALE, seeded(1))).toBeNull();
  });
});

describe('the rare behaviours', () => {
  it('the first one is a landing, soon after load; then 6–12 s apart', () => {
    const rnd = seeded(11);
    expect(pickSpecial(rnd, { land: true, curious: true, flyby: true }, true)).toBe('land');
    for (let i = 0; i < 500; i++) {
      const first = specialGap(rnd, true);
      expect(first).toBeGreaterThanOrEqual(1800);
      expect(first).toBeLessThanOrEqual(3000);
      const g = specialGap(rnd, false);
      expect(g).toBeGreaterThanOrEqual(6000);
      expect(g).toBeLessThanOrEqual(12000);
    }
  });

  it('picks only what is possible, all three over time, and nothing when nothing is', () => {
    const rnd = seeded(5);
    const seen = new Map<string, number>();
    for (let i = 0; i < 3000; i++) {
      const k = pickSpecial(rnd, { land: true, curious: true, flyby: true })!;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    expect(seen.get('land')! / 3000).toBeGreaterThan(0.4);
    expect(seen.get('curious')! / 3000).toBeGreaterThan(0.15);
    expect(seen.get('flyby')! / 3000).toBeGreaterThan(0.2);
    for (let i = 0; i < 200; i++) expect(pickSpecial(rnd, { land: false, curious: false, flyby: true }, true)).toBe('flyby');
    expect(pickSpecial(rnd, { land: false, curious: false, flyby: false })).toBeNull();
  });
});

describe('flight', () => {
  const swarm = (view: View, n: number, seed: number) => {
    const rnd = seeded(seed);
    const bees: Bee[] = [];
    for (let i = 0; i < n; i++) bees.push(makeBee(i, (i + 0.25) / n, view, rnd, 0));
    return { rnd, bees };
  };

  it('a minute of wandering at 60 fps: smooth (no jumps), finite, on screen unless leaving, every bee visible most of the time', () => {
    for (const view of [DESK, PHONE]) {
      const { rnd, bees } = swarm(view, swarmCount(view.w, on), 21);
      const prev = bees.map((b) => ({ x: b.x, y: b.y }));
      const visible = bees.map(() => 0);
      const steps = 60 * 60;
      for (let f = 1; f <= steps; f++) {
        const now = (f * 1000) / 60;
        bees.forEach((b, i) => {
          const wasAway = b.mode === 'away';
          stepBee(b, 1 / 60, now, { view, rnd, pointer: null });
          expect(Number.isFinite(b.x + b.y + b.vx + b.vy + b.tilt + b.face)).toBe(true);
          if (b.mode !== 'away' && !wasAway) {
            // never faster than ~6 px a frame (360 px/s) while wandering: no teleports
            expect(Math.hypot(b.x - prev[i].x, b.y - prev[i].y)).toBeLessThan(6);
          }
          if (b.mode === 'fly') {
            // re-entering bees start 60 px off screen
            expect(b.x).toBeGreaterThan(-150);
            expect(b.x).toBeLessThan(view.w + 150);
            // never wanders up over the nav
            expect(b.y).toBeGreaterThanOrEqual(view.top - 6);
            expect(b.y).toBeLessThan(view.h + 150);
            visible[i]++;
          }
          expect(Math.abs(b.tilt)).toBeLessThan(0.75);
          expect(Math.abs(b.face)).toBeLessThanOrEqual(1.0001);
          prev[i] = { x: b.x, y: b.y };
        });
      }
      // bees leave now and then, but the swarm is mostly here
      for (const v of visible) expect(v / steps).toBeGreaterThan(0.5);
      expect(visible.reduce((x, y) => x + y, 0) / visible.length / steps).toBeGreaterThan(0.75);
    }
  });

  it('a landing arrives on the perch, rests 2–4 s on it (following it if it scrolls), then takes off', () => {
    const { rnd, bees } = swarm(DESK, 1, 9);
    const b = bees[0];
    const r: Rect = { left: 700, top: 500, width: 160, height: 44 };
    const perch = perchOn(r, PERCH_SCALE, rnd)!;
    startLanding(b, perch, 0);
    let now = 0;
    let landedAt = -1;
    for (let f = 1; f < 60 * 9 && landedAt < 0; f++) {
      now = (f * 1000) / 60;
      if (stepBee(b, 1 / 60, now, { view: DESK, rnd, pointer: null }) === 'landed') landedAt = now;
    }
    expect(landedAt).toBeGreaterThan(0);
    expect(b.mode).toBe('rest');
    expect(b.x).toBeCloseTo(perch.x, 5);
    expect(b.y).toBeCloseTo(perch.y, 5);
    // it turned on the final approach: it touches down already facing into the element
    expect(b.face * perch.face).toBeGreaterThan(0.8);
    // the page scrolls 40 px: the perch moves and the bee stays on it
    perch.y -= 40;
    stepBee(b, 1 / 60, now + 16, { view: DESK, rnd, pointer: null });
    expect(b.y).toBeCloseTo(perch.y, 5);
    let tookOff = -1;
    for (let f = 2; f < 60 * 5 && tookOff < 0; f++) {
      const t = now + (f * 1000) / 60;
      if (stepBee(b, 1 / 60, t, { view: DESK, rnd, pointer: null }) === 'tookoff') tookOff = t;
    }
    expect(tookOff - landedAt).toBeGreaterThanOrEqual(2000);
    expect(tookOff - landedAt).toBeLessThanOrEqual(4100);
    expect(b.mode).toBe('fly');
    expect(b.perch).toBeNull();
    expect(b.scaleTo).toBeCloseTo(depthScale(b.depth));
  });

  it('a landing that cannot arrive gives up (no teleport onto the perch)', () => {
    const { rnd, bees } = swarm(DESK, 1, 4);
    const b = bees[0];
    const perch = { x: 5000, y: 5000, face: 1 as const, dx: 0, dy: 0, scale: PERCH_SCALE };
    startLanding(b, perch, 0);
    let maxStep = 0;
    for (let f = 1; f <= 60 * 10; f++) {
      const x = b.x;
      const y = b.y;
      stepBee(b, 1 / 60, (f * 1000) / 60, { view: DESK, rnd, pointer: null });
      maxStep = Math.max(maxStep, Math.hypot(b.x - x, b.y - y));
    }
    expect(b.mode).not.toBe('rest');
    expect(b.perch).toBeNull();
    expect(maxStep).toBeLessThan(10);
  });

  it('a curious bee keeps a polite distance from the cursor, then loses interest', () => {
    const { rnd, bees } = swarm(DESK, 1, 13);
    const b = bees[0];
    const pointer = { x: 720, y: 450 };
    startCurious(b, pointer, 0, rnd);
    const until = b.until;
    let minD = Infinity;
    let f = 1;
    for (; (f * 1000) / 60 <= until + 100; f++) {
      stepBee(b, 1 / 60, (f * 1000) / 60, { view: DESK, rnd, pointer });
      if (f > 90) minD = Math.min(minD, Math.hypot(b.x - pointer.x, b.y - pointer.y));
    }
    expect(minD).toBeGreaterThan(40);
    expect(b.mode).toBe('fly');
  });

  it('a fly-by crosses from one side to the other quickly, then the slot goes idle', () => {
    const { rnd, bees } = swarm(DESK, 1, 17);
    const b = bees[0];
    b.flyby = true;
    startFlyby(b, DESK, 0, rnd);
    const x0 = b.x;
    let gone = -1;
    for (let f = 1; f < 60 * 4 && gone < 0; f++) if (stepBee(b, 1 / 60, (f * 1000) / 60, { view: DESK, rnd, pointer: null }) === 'gone') gone = f;
    expect(gone).toBeGreaterThan(0);
    expect(gone / 60).toBeLessThan(3);
    expect(Math.sign(b.x - DESK.w / 2)).toBe(-Math.sign(x0 - DESK.w / 2));
    expect(b.mode).toBe('idle');
  });

  it('a caught bee darts off screen and comes back later; a caught fly-by bee goes back to idle', () => {
    const { rnd, bees } = swarm(DESK, 2, 19);
    const [a, fb] = bees;
    startFlee(a, { x: a.x + 5, y: a.y + 5 }, 0);
    fb.flyby = true;
    startFlyby(fb, DESK, 0, rnd);
    for (let f = 1; f < 30; f++) stepBee(fb, 1 / 60, (f * 1000) / 60, { view: DESK, rnd, pointer: null });
    startFlee(fb, { x: fb.x, y: fb.y + 10 }, 500);
    let back = -1;
    for (let f = 31; f < 60 * 20 && back < 0; f++) {
      const now = (f * 1000) / 60;
      stepBee(fb, 1 / 60, now, { view: DESK, rnd, pointer: null });
      if (stepBee(a, 1 / 60, now, { view: DESK, rnd, pointer: null }) === 'entered') back = now;
    }
    expect(back).toBeGreaterThan(6000);
    expect(a.mode).toBe('fly');
    expect(fb.mode).toBe('idle');
  });
});
