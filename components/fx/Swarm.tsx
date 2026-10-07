'use client';
/**
 * The ambient swarm: a few bees always about (2 on phones, 4–5 on larger screens, at different
 * depths: far ones small, faint and soft), wandering on smooth curves, banking into turns,
 * bobbing, leaving now and then and coming back. Every 6–12 s one rare thing happens:
 *   - land: a bee flies to a visible button, heading, card or the logo, stands on a corner of its
 *     top edge for 2–4 s flicking its wings, then buzzes off (the first one comes ~2 s after load);
 *   - curious: a bee follows the mouse at a polite distance for a few seconds;
 *   - fly-by: a big, near bee crosses the screen fast.
 * Click / tap a bee: a chirp and a buzz, a honey splash, and it darts away.
 *
 * Rendering: React mounts the bees once; one requestAnimationFrame loop steps them
 * (./swarmModel) and writes transforms only. DOM reads (the landing target's rect) happen at the
 * start of the frame, before any writes. Bees never sit on a control's centre (see perchIsClear),
 * and only the bee itself catches the pointer. Mounted in `.fx-layer` by ./Ambient, which unmounts
 * it while the tab is hidden, the wizard is open, motion is reduced or the nav's Bees switch is off.
 */
import { useEffect, useRef, useState } from 'react';
import { sfx } from '@/lib/sfx';
import { BeeArt, BeeDefs } from './BeeArt';
import { type Bee, type Candidate, type Pose, type Special, type View, BEE_H, BEE_W, PERCH_SCALE, chooseLanding, makeBee, pickSpecial, poseOf, specialGap, startCurious, startFlee, startFlyby, startLanding, stepBee, swarmCount, takeOff } from './swarmModel';

const PERCH_SEL = 'button, a.shape-btn, [data-perch], h1, h2, .shape-card';
const FLYBY_SCALE = 1.7;

interface FxStats {
  frames: number;
  ms: number;
  maxMs: number;
}
/** Test hooks (like window.__hive / __ui / __comb): read the swarm, force a rare behaviour. */
interface FxHooks {
  stats: FxStats;
  bees: () => { id: number; mode: string; x: number; y: number; scale: number }[];
  /** Start one now; for 'land', `only` limits the perches to elements matching a selector. */
  special: (k: Special, only?: string) => boolean;
  /** The current landing: its element and where the bee stands. */
  landing: () => { el: Element; x: number; y: number; mode: string } | null;
}
declare global {
  interface Window {
    __fx?: FxHooks;
  }
}

/** requestIdleCallback where there is one (not Safari), else a short timeout. */
const idle = (fn: () => void) => {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(fn, { timeout: 600 });
  else setTimeout(fn, 60);
};

const viewNow = (): View => {
  const root = document.documentElement;
  return {
    w: root.clientWidth || window.innerWidth,
    h: root.clientHeight || window.innerHeight,
    top: Math.round(document.querySelector('header')?.getBoundingClientRect().bottom ?? 64),
  };
};

/** Elements a bee could land on right now, with the rect to stand on (a heading's text, not its block). */
function perchCandidates(sel = PERCH_SEL): { els: Element[]; cands: Candidate[] } {
  const els: Element[] = [];
  const cands: Candidate[] = [];
  const list = document.querySelectorAll(sel);
  const range = document.createRange();
  for (let i = 0; i < list.length && cands.length < 80; i++) {
    const el = list[i];
    if (el.closest('.fx-layer, [role="dialog"], [aria-modal="true"]') || el.matches(':disabled')) continue;
    const kind = el.matches('[data-perch]') ? 'logo' : el.matches('h1, h2') ? 'heading' : el.matches('.shape-card') ? 'card' : 'control';
    let r: DOMRect;
    if (kind === 'heading') {
      range.selectNodeContents(el);
      r = range.getBoundingClientRect();
    } else r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    els.push(el);
    cands.push({ rect: { left: r.left, top: r.top, width: r.width, height: r.height }, kind });
  }
  return { els, cands };
}

/** Whether an element shows text of its own (not just through its children). */
function hasOwnText(el: Element): boolean {
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && n.textContent?.trim()) return true;
  return false;
}

const CONTROL_SEL = 'a, button, input, select, textarea, label, [role="button"], [tabindex]';

/** Nothing but the perch's own element, or empty space, under the bee's body (centre and both shoulders). */
function clearAround(el: Element, x: number, y: number, scale: number): boolean {
  const dx = BEE_W * scale * 0.34;
  const dy = BEE_H * scale * 0.22;
  for (const [px, py] of [
    [x, y],
    [x - dx, y - dy],
    [x + dx, y - dy],
    [x - dx, y + dy],
    [x + dx, y + dy],
  ]) {
    const front = document.elementFromPoint(px, py);
    // the element itself, or what contains it (the logo's link, a card around a heading): same target
    if (!front || el.contains(front) || front.contains(el) || front.closest('.fx-layer')) continue;
    if (hasOwnText(front) || front.closest(CONTROL_SEL)) return false;
  }
  return true;
}

export default function Swarm() {
  const [n, setN] = useState(0);
  const wraps = useRef<(HTMLButtonElement | null)[]>([]);
  const bodies = useRef<(HTMLSpanElement | null)[]>([]);
  const shadows = useRef<(HTMLElement | null)[]>([]);
  const [splash, setSplash] = useState<{ id: number; x: number; y: number } | null>(null);

  // how many bees this screen gets (re-evaluated on resize)
  useEffect(() => {
    const count = () => setN(swarmCount(window.innerWidth, { reduced: false, enabled: true, critter: true }));
    count();
    window.addEventListener('resize', count);
    return () => window.removeEventListener('resize', count);
  }, []);

  useEffect(() => {
    if (!n) return;
    const rnd = Math.random;
    let view = viewNow();
    // the swarm's own clock (ms): the sum of the frames' capped steps, so its timers (rests, fly-bys,
    // give-ups) keep pace with its motion even when frames are slow
    let clock = 0;
    const start = 0;
    const bees: Bee[] = [];
    for (let i = 0; i < n; i++) bees.push(makeBee(i, n === 1 ? 0.6 : (i + rnd() * 0.5) / (n - 0.5), view, rnd, start));
    // the fly-by slot: waits idle off screen until its turn
    const fly = makeBee(n, 1.3, view, rnd, start);
    fly.mode = 'idle';
    fly.flyby = true;
    fly.scale = fly.scaleTo = FLYBY_SCALE;
    fly.cruise = 0;
    bees.push(fly);

    const pose: Pose = { x: 0, y: 0, sx: 1, sy: 1, rot: 0, bob: 0 };
    const lastT: string[] = [];
    const lastB: string[] = [];
    const lastS: string[] = [];
    const lastC: string[] = [];
    const stats: FxStats = { frames: 0, ms: 0, maxMs: 0 };

    // the landing target, followed every frame (it may scroll)
    let landEl: Element | null = null;
    let landLogo = false;
    let landBee: Bee | null = null;
    let special: { kind: Special; bee: Bee } | null = null;
    let first = true;
    let nextAt = start + specialGap(rnd, true);

    const fine = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
    const pointer = { x: 0, y: 0, at: -1e9 };
    let interacted = false;
    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.at = performance.now();
    };
    const onAny = () => {
      interacted = true;
    };
    const onResize = () => {
      view = viewNow();
    };
    if (fine) window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onAny, { passive: true, capture: true });
    window.addEventListener('resize', onResize);

    const flying = (b: Bee) => b.mode === 'fly' && b !== fly;
    const nearest = (x: number, y: number, max = Infinity) => {
      let best: Bee | null = null;
      let bd = max;
      for (const b of bees) {
        if (!flying(b)) continue;
        const d = Math.hypot(b.x - x, b.y - y);
        if (d < bd) {
          bd = d;
          best = b;
        }
      }
      return best;
    };

    /** Try to start a rare behaviour; false when it is not possible right now. */
    const trySpecial = (k: Special, now: number, only?: string): boolean => {
      if (k === 'land') {
        if (!bees.some(flying)) return false;
        const { els, cands } = perchCandidates(only);
        for (let attempt = 0; attempt < 8 && cands.length; attempt++) {
          const pick = chooseLanding(cands, view, PERCH_SCALE, rnd);
          if (!pick) return false;
          const el = els[pick.index];
          const r = cands[pick.index].rect;
          // the edge must really be visible there (not under another element), and the bee must not
          // stand in front of other text or controls (an eyebrow line just above a heading, an input)
          const hit = document.elementFromPoint(pick.perch.x, r.top + 3);
          if (hit && (el === hit || el.contains(hit)) && clearAround(el, pick.perch.x, pick.perch.y, pick.perch.scale)) {
            const b = nearest(pick.perch.x, pick.perch.y);
            if (!b) return false;
            startLanding(b, pick.perch, now);
            landEl = el;
            landLogo = cands[pick.index].kind === 'logo';
            landBee = b;
            special = { kind: k, bee: b };
            return true;
          }
          els.splice(pick.index, 1);
          cands.splice(pick.index, 1);
        }
        return false;
      }
      if (k === 'curious') {
        if (!fine || performance.now() - pointer.at > 4000) return false;
        const b = nearest(pointer.x, pointer.y, 700);
        if (!b) return false;
        startCurious(b, pointer, now, rnd);
        special = { kind: k, bee: b };
        return true;
      }
      if (fly.mode !== 'idle') return false;
      startFlyby(fly, view, now, rnd);
      special = { kind: k, bee: fly };
      if (interacted) sfx('flyby');
      return true;
    };

    const stillSpecial = (s: { kind: Special; bee: Bee }) => (s.kind === 'land' ? s.bee.mode === 'land' || s.bee.mode === 'rest' : s.bee.mode === s.kind);

    let raf = 0;
    let last = -1;
    let scanning = false;
    let alive = true;
    const frame = (ts: number) => {
      const s0 = performance.now();
      // capped: after a stall (a busy main thread, a background tab) bees don't jump
      const dt = last < 0 ? 0 : Math.min(0.1, Math.max(0, (ts - last) / 1000));
      last = ts;
      clock += dt * 1000;
      const now = clock;
      const recent = ts - pointer.at < 4000; // the pointer moved lately (real time)

      // reads first: follow the landing target, or give up on it when it is gone or off screen
      if (landEl && landBee && landBee.perch && (landBee.mode === 'land' || landBee.mode === 'rest')) {
        const r = landEl.getBoundingClientRect();
        const lost = !landEl.isConnected || !r.width || r.top < (landLogo ? 0 : view.top + 8) || r.top > view.h - 8;
        if (lost) {
          if (landBee.mode === 'rest') takeOff(landBee, now, view, rnd);
          else landBee.mode = 'fly';
          landBee.perch = null;
          landEl = null;
        } else {
          landBee.perch.x = r.left + landBee.perch.dx;
          landBee.perch.y = r.top + landBee.perch.dy;
        }
      } else landEl = null;

      if (special && !stillSpecial(special)) {
        special = null;
        nextAt = now + specialGap(rnd, false);
      }
      if (!special && !scanning && now >= nextAt) {
        const can = { land: true, curious: fine && recent, flyby: fly.mode === 'idle' };
        const k = pickSpecial(rnd, can, first);
        first = false;
        if (k === 'land') {
          // finding a perch reads layout: do it when the page is idle, not inside this frame
          scanning = true;
          idle(() => {
            scanning = false;
            if (alive && !trySpecial('land', clock)) nextAt = clock + 1500;
          });
        } else if (!k || !trySpecial(k, now)) nextAt = now + 1500; // nothing possible: look again shortly
      }

      const env = { view, rnd, pointer: recent ? pointer : null };
      for (let i = 0; i < bees.length; i++) {
        const b = bees[i];
        stepBee(b, dt, now, env);
        const w = wraps.current[i];
        const body = bodies.current[i];
        const sh = shadows.current[i];
        if (!w || !body || !sh) continue;
        const hidden = b.mode === 'away' || b.mode === 'idle';
        const cls = `fxb${hidden ? ' off' : ''}${b.mode === 'rest' ? ' rest' : ''}${b.mode === 'flee' || b.mode === 'flyby' ? ' fast' : ''}${b === fly ? ' near' : b.depth < 0.3 ? ' far' : ''}`;
        if (cls !== lastC[i]) {
          w.className = cls;
          lastC[i] = cls;
        }
        if (hidden) continue;
        poseOf(b, now, pose);
        const tf = `translate3d(${pose.x.toFixed(1)}px,${pose.y.toFixed(1)}px,0)`;
        if (tf !== lastT[i]) {
          w.style.transform = tf;
          lastT[i] = tf;
        }
        const bt = `translateY(${pose.bob.toFixed(1)}px) rotate(${pose.rot.toFixed(1)}deg) scale(${pose.sx.toFixed(3)},${pose.sy.toFixed(3)})`;
        if (bt !== lastB[i]) {
          body.style.transform = bt;
          lastB[i] = bt;
        }
        // the shadow falls on the page: close and crisp under a perched bee, lower and wider the nearer the bee flies
        const rest = b.mode === 'rest';
        const st = `translate3d(0,${(rest ? 11 * b.scale : 16 + 24 * Math.min(1, b.depth)).toFixed(0)}px,0) scale(${(b.scale * (rest ? 0.8 : 1.15)).toFixed(2)})`;
        if (st !== lastS[i]) {
          sh.style.transform = st;
          lastS[i] = st;
        }
      }

      const cost = performance.now() - s0;
      stats.frames++;
      stats.ms += cost;
      if (cost > stats.maxMs) stats.maxMs = cost;
      raf = requestAnimationFrame(frame);
    };

    // catching: on the bee itself only (the overlay is pointer-events: none elsewhere)
    const offs: (() => void)[] = [];
    bees.forEach((b, i) => {
      const w = wraps.current[i];
      if (!w) return;
      const onCatch = (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (b.mode === 'flee' || b.mode === 'away' || b.mode === 'idle') return;
        if (landBee === b) landEl = null;
        startFlee(b, { x: e.clientX, y: e.clientY }, clock);
        sfx('catch');
        sfx('buzz');
        setSplash({ id: performance.now(), x: Math.round(b.x), y: Math.round(b.y) });
      };
      w.addEventListener('pointerdown', onCatch);
      offs.push(() => w.removeEventListener('pointerdown', onCatch));
    });

    window.__fx = {
      stats,
      bees: () => bees.map((b) => ({ id: b.id, mode: b.mode, x: Math.round(b.x), y: Math.round(b.y), scale: +b.scale.toFixed(2) })),
      special: (k, only) => {
        if (special) {
          special.bee.mode = 'fly';
          special.bee.perch = null;
          special = null;
        }
        return trySpecial(k, clock, only);
      },
      landing: () => (landEl && landBee?.perch ? { el: landEl, x: landBee.perch.x, y: landBee.perch.y, mode: landBee.mode } : null),
    };

    raf = requestAnimationFrame(frame);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      offs.forEach((f) => f());
      if (fine) window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onAny, { capture: true });
      window.removeEventListener('resize', onResize);
      delete window.__fx;
    };
  }, [n]);

  if (!n) return null;
  return (
    <>
      <BeeDefs />
      {splash && <i key={splash.id} className="bee-splash" style={{ left: splash.x, top: splash.y }} onAnimationEnd={(e) => e.animationName === 'beeSplash' && setSplash(null)} />}
      {Array.from({ length: n + 1 }, (_, i) => (
        <button
          key={i}
          ref={(el) => {
            wraps.current[i] = el;
          }}
          type="button"
          tabIndex={-1}
          data-sfx="none"
          className="fxb off"
          style={{ transform: 'translate3d(-200px,-200px,0)', zIndex: i + 1 }}
        >
          <i
            className="fxb-shadow"
            ref={(el) => {
              shadows.current[i] = el;
            }}
          />
          <span
            className="fxb-body"
            ref={(el) => {
              bodies.current[i] = el;
            }}
          >
            <BeeArt />
          </span>
        </button>
      ))}
    </>
  );
}
