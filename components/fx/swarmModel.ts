/**
 * The ambient swarm's pure logic (no DOM): how many bees a screen gets, how they fly, where a bee
 * may land, and which rare behaviour comes next. ./Swarm.tsx owns the DOM: it reads rects and the
 * pointer, calls `stepBee` once per bee per frame and writes `poseOf` to the bee's transform.
 *
 * Coordinates are viewport px (the overlay is position: fixed). Time is ms (`now`) and s (`dt`).
 * Every random choice goes through an injectable `rnd` so tests can pin it.
 */
import type { Theme } from '@/themes/types';

export type Rnd = () => number;
export const rand = (rnd: Rnd, a: number, b: number) => a + rnd() * (b - a);
const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Bee box at scale 1 (px). The drawing is a side view facing +x. */
export const BEE_W = 44;
export const BEE_H = 36;
/** How far a perched bee's centre sits above the edge it stands on, as a share of its height. */
export const PERCH_LIFT = 0.3;

/** What the theme flies and pours. Older themes without the field get nothing. */
export function ambienceOf(t: Pick<Theme, 'ambience'>): { critter: 'bee' | null; honey: boolean } {
  return { critter: t.ambience?.critter ?? null, honey: t.ambience?.honey ?? false };
}

/**
 * Ambient bees for a viewport width: 2 on phones, 4 on tablets / small laptops, 5 on desktops.
 * One more slot is kept for the occasional fly-by, so at most 3 / 5 / 6 are ever on screen.
 * Zero under reduced motion, with the toggle off, or for a theme without a critter.
 */
export function swarmCount(vw: number, o: { reduced: boolean; enabled: boolean; critter: boolean }): number {
  if (o.reduced || !o.enabled || !o.critter) return 0;
  if (vw < 768) return 2;
  if (vw < 1200) return 4;
  return 5;
}

export interface View {
  w: number;
  h: number;
  /** Bottom of the fixed nav: wandering bees stay below it. */
  top: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type PerchKind = 'control' | 'heading' | 'card' | 'logo';

export interface Perch {
  /** Where the bee's centre rests. */
  x: number;
  y: number;
  /** Facing while perched: toward the middle of the element. */
  face: 1 | -1;
  /** Offsets from the element's top-left corner, so the perch follows the element when it scrolls. */
  dx: number;
  dy: number;
  /** The bee's size while perched. */
  scale: number;
}

/** The bee's box (centre ± half size) at a scale. */
export function beeBox(x: number, y: number, scale: number): Rect {
  const w = BEE_W * scale;
  const h = BEE_H * scale;
  return { left: x - w / 2, top: y - h / 2, width: w, height: h };
}

const inside = (r: Rect, x: number, y: number) => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));

/**
 * A perch on the element's top edge, near one of its corners (never the middle): the bee stands
 * on the edge with its body above it. Null when the element is too small to stand on.
 */
export function perchOn(r: Rect, scale: number, rnd: Rnd): Perch | null {
  if (r.width < 28 || r.height < 14) return null;
  const right = rnd() < 0.5;
  // clear of chamfered / rounded corners, but within the outer quarter of the edge
  const inset = clamp(r.width * rand(rnd, 0.1, 0.22), 14, Math.max(14, r.width / 4));
  const x = right ? r.left + r.width - inset : r.left + inset;
  const y = r.top - BEE_H * scale * PERCH_LIFT;
  return { x, y, face: right ? -1 : 1, dx: x - r.left, dy: y - r.top, scale };
}

/**
 * Whether a perched bee leaves the element usable: its box must not cover the element's centre
 * (where people click) and may hide at most `share` of the element (a fifth; the small logo allows more).
 */
export function perchIsClear(p: { x: number; y: number }, scale: number, r: Rect, share = 0.2): boolean {
  const box = beeBox(p.x, p.y, scale);
  if (inside(box, r.left + r.width / 2, r.top + r.height / 2)) return false;
  return overlap(box, r) <= r.width * r.height * share;
}

/** A smaller bee sits on the nav's logo, its wing tips (which have air above them) may touch the screen's top. */
export const LOGO_SCALE = 0.7;

export interface Candidate {
  rect: Rect;
  kind: PerchKind;
}

const KIND_WEIGHT: Record<PerchKind, number> = { control: 3, logo: 2, heading: 2, card: 1 };

/**
 * Pick an element to land on and the perch on it. Only elements fully on screen (and, except the
 * logo in the nav, below the nav) with room above them for the bee qualify.
 */
export function chooseLanding(cands: Candidate[], view: View, scale: number, rnd: Rnd): { index: number; perch: Perch } | null {
  const ok: { index: number; perch: Perch; w: number }[] = [];
  for (let i = 0; i < cands.length; i++) {
    const { rect: r, kind } = cands[i];
    const logo = kind === 'logo';
    const s = logo ? Math.min(scale, LOGO_SCALE) : scale;
    const beeH = BEE_H * s;
    // the bee's top (0.8 of its height above the edge) stays on screen, or below the nav
    const minTop = logo ? beeH * (PERCH_LIFT + 0.5) - 4 : view.top + beeH;
    if (r.top < minTop || r.top + r.height > view.h - 8 || r.left < 8 || r.left + r.width > view.w - 8) continue;
    // huge blocks (the hero comb, full-width tables) are not perches
    if (kind !== 'card' && r.width * r.height > view.w * view.h * 0.25) continue;
    const perch = perchOn(r, s, rnd);
    if (!perch || !perchIsClear(perch, s, r, logo ? 0.45 : 0.2)) continue;
    ok.push({ index: i, perch, w: KIND_WEIGHT[kind] });
  }
  if (!ok.length) return null;
  let sum = 0;
  for (const c of ok) sum += c.w;
  let pick = rnd() * sum;
  for (const c of ok) {
    pick -= c.w;
    if (pick <= 0) return { index: c.index, perch: c.perch };
  }
  const last = ok[ok.length - 1];
  return { index: last.index, perch: last.perch };
}

/* ---------------- the rare behaviours ---------------- */

export type Special = 'land' | 'curious' | 'flyby';

/** The pause before the next rare behaviour: the first comes quickly (a landing), then 6–12 s apart. */
export function specialGap(rnd: Rnd, first: boolean): number {
  return first ? rand(rnd, 1800, 3000) : rand(rnd, 6000, 12000);
}

/** The next rare behaviour among those possible right now; the first one is always a landing. */
export function pickSpecial(rnd: Rnd, can: Record<Special, boolean>, first = false): Special | null {
  if (first && can.land) return 'land';
  const opts: [Special, number][] = [
    ['land', can.land ? 0.5 : 0],
    ['curious', can.curious ? 0.22 : 0],
    ['flyby', can.flyby ? 0.28 : 0],
  ];
  const sum = opts.reduce((s, [, w]) => s + w, 0);
  if (sum <= 0) return null;
  let r = rnd() * sum;
  for (const [k, w] of opts) {
    if (!w) continue;
    r -= w;
    if (r <= 0) return k;
  }
  return null;
}

/* ---------------- flight ---------------- */

export type Mode = 'fly' | 'leave' | 'away' | 'land' | 'rest' | 'curious' | 'flee' | 'flyby' | 'idle';

export interface Bee {
  id: number;
  /** 0 = far (small, faint, soft) … 1 = near. Fixed per bee; the fly-by bee is nearer than 1. */
  depth: number;
  scale: number;
  /** The scale the bee eases toward: a landing bee comes to the page's plane. */
  scaleTo: number;
  mode: Mode;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Goal of the current leg. */
  gx: number;
  gy: number;
  /** When the current mode or leg ends (ms). */
  until: number;
  /** Smoothed facing, -1 (left) … 1 (right): passing through 0 reads as the bee turning round. */
  face: number;
  /** Smoothed body tilt (rad). */
  tilt: number;
  heading: number;
  /** Per-bee phase for wander noise and bobbing. */
  phase: number;
  /** Cruise speed (px/s). */
  cruise: number;
  /** Fly-by path (quadratic Bézier) and timing. */
  fb: { x0: number; y0: number; x1: number; y1: number; x2: number; y2: number; t0: number; dur: number } | null;
  /** Perch while landing / resting, facing set on arrival. */
  perch: Perch | null;
  /** The fly-by slot: idle between fly-bys instead of wandering. */
  flyby?: boolean;
}

/** Size by depth: far bees ~30 px long, near ones ~52 px. */
export const depthScale = (depth: number) => 0.68 + 0.5 * depth;
/** Size of a bee standing on the page (landing brings it to the page's plane). */
export const PERCH_SCALE = 0.95;

export function makeBee(id: number, depth: number, view: View, rnd: Rnd, now: number): Bee {
  const scale = depthScale(depth);
  const x = rand(rnd, 40, Math.max(41, view.w - 40));
  const y = rand(rnd, view.top + 40, Math.max(view.top + 41, view.h - 50));
  const a = rand(rnd, 0, TAU);
  return {
    id,
    depth,
    scale,
    scaleTo: scale,
    mode: 'fly',
    x,
    y,
    vx: Math.cos(a) * 60,
    vy: Math.sin(a) * 40,
    gx: x,
    gy: y,
    until: now,
    face: Math.cos(a) < 0 ? -1 : 1,
    tilt: 0,
    heading: a,
    phase: rand(rnd, 0, TAU),
    cruise: 95 + 85 * depth,
    fb: null,
    perch: null,
  };
}

/** A new wander goal 140–420 px away, inside the air below the nav; now and then one off screen (the bee leaves for a while). */
export function wanderGoal(b: Bee, view: View, rnd: Rnd): { x: number; y: number; leave: boolean } {
  if (rnd() < 0.05) {
    // out through the nearest of left, right or bottom (never through the nav)
    const dl = b.x;
    const dr = view.w - b.x;
    const db = view.h - b.y;
    const side = dl <= dr && dl <= db ? 0 : dr <= db ? 1 : 2;
    const off = 90;
    if (side === 0) return { x: -off, y: rand(rnd, view.top, view.h), leave: true };
    if (side === 1) return { x: view.w + off, y: rand(rnd, view.top, view.h), leave: true };
    return { x: rand(rnd, 0, view.w), y: view.h + off, leave: true };
  }
  const a = rand(rnd, 0, TAU);
  const d = rand(rnd, 140, 420);
  const pad = 36;
  return {
    x: clamp(b.x + Math.cos(a) * d, pad, Math.max(pad, view.w - pad)),
    y: clamp(b.y + Math.sin(a) * d * 0.7, view.top + pad, Math.max(view.top + pad, view.h - pad)),
    leave: false,
  };
}

/** A point just off a random edge (not the top) to re-enter from. */
export function entryPoint(view: View, rnd: Rnd): { x: number; y: number } {
  const side = Math.floor(rnd() * 3);
  if (side === 0) return { x: -60, y: rand(rnd, view.top + 40, view.h - 40) };
  if (side === 1) return { x: view.w + 60, y: rand(rnd, view.top + 40, view.h - 40) };
  return { x: rand(rnd, 40, view.w - 40), y: view.h + 60 };
}

export const isOffscreen = (x: number, y: number, view: View, m = 40) => x < -m || x > view.w + m || y < -m || y > view.h + m;

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Steer toward (gx, gy): cruise speed easing down within `arrive` px, the heading wobbling with
 * two slow sines (organic curves) that fade out close to the goal so landings are exact.
 */
function steer(b: Bee, gx: number, gy: number, cruise: number, dt: number, t: number, wander: number, agility: number, arrive = 120) {
  const dx = gx - b.x;
  const dy = gy - b.y;
  const d = Math.hypot(dx, dy);
  const sp = cruise * Math.min(1, d / arrive);
  const near = Math.min(1, d / 160);
  const a = Math.atan2(dy, dx) + wander * near * (Math.sin(t * 0.9 + b.phase) * 0.75 + Math.sin(t * 2.3 + b.phase * 1.7) * 0.35);
  const k = 1 - Math.exp(-dt * agility);
  b.vx += (Math.cos(a) * sp - b.vx) * k;
  b.vy += (Math.sin(a) * sp - b.vy) * k;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  return d;
}

/** A soft floor under the nav: wandering bees that drift up toward it are pushed back down. */
function keepBelowNav(b: Bee, view: View, dt: number) {
  const edge = view.top + 28;
  if (b.y < edge) {
    b.vy += (edge - b.y) * 14 * dt;
    if (b.y < view.top - 6) b.y = view.top - 6;
  }
}

/** Ease facing and tilt from the velocity: face the way it flies, pitch with the climb, bank into turns. */
function orient(b: Bee, dt: number, faceTo: number | null) {
  const sp = Math.hypot(b.vx, b.vy);
  const want = faceTo ?? (b.vx > 10 ? 1 : b.vx < -10 ? -1 : Math.sign(b.face) || 1);
  b.face += (want - b.face) * (1 - Math.exp(-dt * 7));
  const h = Math.atan2(b.vy, b.vx);
  const turn = sp > 20 ? wrapAngle(h - b.heading) / Math.max(dt, 1e-3) : 0;
  b.heading = h;
  // pitch: nose up when climbing (screen y grows downward), mirrored with the facing
  const pitch = clamp(Math.atan2(b.vy, Math.abs(b.vx) + 60) * 0.55, -0.42, 0.42) * Math.sign(b.face || 1);
  const bank = clamp(turn * 0.05, -0.28, 0.28);
  const tilt = sp > 15 ? pitch + bank : 0;
  b.tilt += (tilt - b.tilt) * (1 - Math.exp(-dt * 6));
}

export interface StepEnv {
  view: View;
  rnd: Rnd;
  /** Last pointer position (curious bees), if any. */
  pointer: { x: number; y: number } | null;
}

/** What happened this step that the DOM side cares about. */
export type StepEvent = 'landed' | 'tookoff' | 'gone' | 'entered' | null;

/** Advance one bee by dt seconds. Pure apart from mutating `b`. */
export function stepBee(b: Bee, dt: number, now: number, env: StepEnv): StepEvent {
  const { view, rnd } = env;
  const t = now / 1000;
  b.scale += (b.scaleTo - b.scale) * (1 - Math.exp(-dt * 3));
  let faceTo: number | null = null;
  switch (b.mode) {
    case 'idle':
      return null;
    case 'away':
      if (now < b.until) return null;
      {
        const e = entryPoint(view, rnd);
        b.x = e.x;
        b.y = e.y;
        b.vx = 0;
        b.vy = 0;
        const g = wanderGoal({ ...b, x: clamp(e.x, 60, view.w - 60), y: clamp(e.y, view.top + 60, view.h - 60) }, view, () => 0.5);
        b.gx = g.x;
        b.gy = g.y;
        b.mode = 'fly';
        b.until = now + rand(rnd, 3000, 6000);
      }
      return 'entered';
    case 'fly': {
      const d = steer(b, b.gx, b.gy, b.cruise, dt, t, 0.9, 2.4);
      keepBelowNav(b, view, dt);
      if (d < 36 || now > b.until) {
        const g = wanderGoal(b, view, rnd);
        b.gx = g.x;
        b.gy = g.y;
        b.until = now + rand(rnd, 2500, 5500);
        if (g.leave) {
          b.mode = 'leave';
          b.until = now + 15000;
        }
      }
      break;
    }
    case 'leave':
      steer(b, b.gx, b.gy, b.cruise * 1.2, dt, t, 0.5, 2.4, 40);
      keepBelowNav(b, view, dt);
      if (isOffscreen(b.x, b.y, view, 50) || now > b.until) {
        b.mode = 'away';
        b.until = now + rand(rnd, 3000, 8000);
        return 'gone';
      }
      break;
    case 'land': {
      const p = b.perch;
      if (!p) {
        b.mode = 'fly';
        break;
      }
      const d = steer(b, p.x, p.y, Math.max(170, b.cruise * 1.4), dt, t, 0.6, 3.4, 120);
      if (now > b.until) {
        // something kept it from arriving: give up and wander on
        b.mode = 'fly';
        b.perch = null;
        b.scaleTo = depthScale(b.depth);
        break;
      }
      // turn to face into the element on the final approach, so it lands already facing it
      if (d < 70) faceTo = p.face;
      if (d < 2.5 && Math.hypot(b.vx, b.vy) < 45) {
        b.x = p.x;
        b.y = p.y;
        b.vx = 0;
        b.vy = 0;
        b.mode = 'rest';
        b.until = now + rand(rnd, 2000, 4000);
        return 'landed';
      }
      break;
    }
    case 'rest': {
      const p = b.perch;
      if (p) {
        b.x = p.x;
        b.y = p.y;
      }
      b.face += ((p?.face ?? Math.sign(b.face)) - b.face) * (1 - Math.exp(-dt * 8));
      b.tilt += (0 - b.tilt) * (1 - Math.exp(-dt * 8));
      if (now >= b.until) return takeOff(b, now, view, rnd);
      return null;
    }
    case 'curious': {
      const ptr = env.pointer;
      if (!ptr || now > b.until) {
        b.mode = 'fly';
        // lose interest: wander off the other way
        const g = wanderGoal(b, view, rnd);
        b.gx = g.x;
        b.gy = g.y;
        b.until = now + rand(rnd, 2500, 5000);
        break;
      }
      // hover at a polite distance on the side it came from, drifting a little
      const gx = ptr.x + b.gx + Math.sin(t * 1.3 + b.phase) * 14;
      const gy = ptr.y + b.gy + Math.sin(t * 1.9 + b.phase) * 10;
      steer(b, gx, gy, 220, dt, t, 0.35, 3, 160);
      keepBelowNav(b, view, dt);
      break;
    }
    case 'flee': {
      // accelerate away along the escape line with a nervous zig-zag
      const sp = Math.hypot(b.vx, b.vy) || 1;
      const ux = b.vx / sp;
      const uy = b.vy / sp;
      const nsp = Math.min(1500, sp + 2600 * dt);
      const zig = Math.sin(t * 40) * 160;
      b.vx = ux * nsp - uy * zig * dt * 20;
      b.vy = uy * nsp + ux * zig * dt * 20;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (isOffscreen(b.x, b.y, view, 70) || now > b.until) {
        if (b.flyby) {
          b.mode = 'idle';
          return 'gone';
        }
        b.mode = 'away';
        b.scaleTo = depthScale(b.depth);
        b.until = now + rand(rnd, 6000, 12000);
        return 'gone';
      }
      break;
    }
    case 'flyby': {
      const f = b.fb;
      if (!f) {
        b.mode = 'idle';
        return 'gone';
      }
      const u = (now - f.t0) / f.dur;
      if (u >= 1) {
        b.mode = 'idle';
        b.fb = null;
        return 'gone';
      }
      const m = 1 - u;
      const nx = m * m * f.x0 + 2 * m * u * f.x1 + u * u * f.x2;
      const ny = m * m * f.y0 + 2 * m * u * f.y1 + u * u * f.y2 + Math.sin(u * TAU * 2 + b.phase) * 6;
      if (dt > 0) {
        b.vx = (nx - b.x) / dt;
        b.vy = (ny - b.y) / dt;
      }
      b.x = nx;
      b.y = ny;
      break;
    }
  }
  orient(b, dt, faceTo);
  return null;
}

/** Leave a perch: hop up and away, back to wandering. */
export function takeOff(b: Bee, now: number, view: View, rnd: Rnd): StepEvent {
  b.mode = 'fly';
  b.perch = null;
  b.scaleTo = depthScale(b.depth);
  const dir = b.face >= 0 ? 1 : -1;
  b.vx = dir * 70;
  b.vy = -110;
  b.gx = clamp(b.x + dir * rand(rnd, 120, 260), 36, view.w - 36);
  b.gy = clamp(b.y - rand(rnd, 60, 160), view.top + 36, view.h - 36);
  b.until = now + rand(rnd, 2000, 4000);
  return 'tookoff';
}

/** Start a landing on `perch`; the bee comes forward to the page's plane on the way. */
export function startLanding(b: Bee, perch: Perch, now: number) {
  b.mode = 'land';
  b.perch = perch;
  b.scaleTo = perch.scale;
  b.until = now + 9000; // give up and settle wherever it is if something keeps it from arriving
}

/** Follow the cursor for a few seconds at a polite distance (90–120 px) on the side it is on. */
export function startCurious(b: Bee, pointer: { x: number; y: number }, now: number, rnd: Rnd) {
  const a = Math.atan2(b.y - pointer.y, b.x - pointer.x);
  const d = rand(rnd, 90, 120);
  b.mode = 'curious';
  b.gx = Math.cos(a) * d; // in curious mode the goal is an offset from the pointer
  b.gy = Math.sin(a) * d * 0.8;
  b.until = now + rand(rnd, 2500, 4500);
}

/** A near, large bee crossing the screen fast on a gentle curve. */
export function startFlyby(b: Bee, view: View, now: number, rnd: Rnd) {
  const ltr = rnd() < 0.5;
  const x0 = ltr ? -90 : view.w + 90;
  const x2 = ltr ? view.w + 90 : -90;
  const lo = view.top + 50;
  const hi = Math.max(lo + 1, view.h * 0.8);
  const y0 = rand(rnd, lo, hi);
  const y2 = rand(rnd, lo, hi);
  b.fb = { x0, y0, x1: (x0 + x2) / 2, y1: clamp((y0 + y2) / 2 + rand(rnd, -160, 160), lo, hi), x2, y2, t0: now, dur: rand(rnd, 1300, 2000) * Math.max(0.8, Math.min(1.4, view.w / 1300)) };
  b.mode = 'flyby';
  b.x = x0;
  b.y = y0;
  b.vx = ltr ? 600 : -600;
  b.vy = 0;
  b.face = ltr ? 1 : -1;
  b.tilt = 0;
}

/** Catch a bee: it darts off away from the pointer (and upward), then stays away for a while. */
export function startFlee(b: Bee, from: { x: number; y: number }, now: number) {
  let dx = b.x - from.x || (b.face >= 0 ? 1 : -1);
  let dy = b.y - from.y - 30;
  const n = Math.hypot(dx, dy) || 1;
  dx /= n;
  dy /= n;
  b.mode = 'flee';
  b.perch = null;
  b.fb = null;
  b.vx = dx * 650;
  b.vy = dy * 650;
  b.until = now + 1600;
}

export interface Pose {
  x: number;
  y: number;
  /** Horizontal scale (signed: facing) and vertical scale. */
  sx: number;
  sy: number;
  /** Body rotation (deg). */
  rot: number;
  /** Vertical bob (px), zero while perched. */
  bob: number;
}

/** Where and how to draw the bee this frame. */
export function poseOf(b: Bee, now: number, out: Pose): Pose {
  const t = now / 1000;
  const f = Math.abs(b.face) < 0.12 ? 0.12 * (b.face < 0 ? -1 : 1) : b.face;
  out.x = b.x;
  out.y = b.y;
  out.sx = b.scale * f;
  out.sy = b.scale;
  out.rot = (b.tilt * 180) / Math.PI;
  out.bob = b.mode === 'rest' ? 0 : Math.sin(t * TAU * 1.7 + b.phase) * 3 * b.scale;
  return out;
}
