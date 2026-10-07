'use client';
/**
 * A bee that now and then flies across the screen: every 9–22 s (after the previous one has
 * gone) a single bee enters from off-screen on one side and leaves on the other along a smooth
 * random cubic Bézier with a sinusoidal wobble (and sometimes a loop-the-loop), turned along its
 * direction of travel, in 6–10 s. Click it: a chirp and a buzz, a small honey splash, and the bee
 * darts off fast.
 *
 * Rendering: React mounts the bee when a flight starts and unmounts it when it ends; a single
 * requestAnimationFrame loop writes the transforms (the button only translates so its shadow stays
 * below; the svg rotates). Wings flap with a CSS animation. Mounted inside `.fx-layer` by ./Ambient.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { sfx } from '@/lib/sfx';
import { theme } from '@/themes';

const GAP_MS: [number, number] = [9000, 22000];
const FIRST_MS: [number, number] = [5000, 11000];
const DUR_MS: [number, number] = [6000, 10000];
const OFF = 70; // px beyond the viewport edge where flights start and end

interface Path {
  // cubic Bézier control points
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
  wobA: number; // px
  wobF: number; // wobble cycles over the whole flight
  wobPh: number;
  loopAt: number; // flight fraction of the loop's centre, or -1 for no loop
  loopW: number; // flight fraction the loop takes
  loopR: number; // px
}

interface Flight {
  id: number;
  dur: number; // ms
  path: Path;
  /** -1 when flying right to left: the bee is mirrored so it stays upright. */
  flip: 1 | -1;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;

/** Position along the flight at fraction u (0..1), written into `out` (no allocation). */
function pointAt(p: Path, u: number, out: { x: number; y: number }) {
  const m = 1 - u;
  const a = m * m * m;
  const b = 3 * m * m * u;
  const c = 3 * m * u * u;
  const d = u * u * u;
  let x = a * p.x0 + b * p.x1 + c * p.x2 + d * p.x3;
  let y = a * p.y0 + b * p.y1 + c * p.y2 + d * p.y3;
  // unit tangent and normal of the Bézier
  let tx = 3 * m * m * (p.x1 - p.x0) + 6 * m * u * (p.x2 - p.x1) + 3 * u * u * (p.x3 - p.x2);
  let ty = 3 * m * m * (p.y1 - p.y0) + 6 * m * u * (p.y2 - p.y1) + 3 * u * u * (p.y3 - p.y2);
  const len = Math.hypot(tx, ty) || 1;
  tx /= len;
  ty /= len;
  // the normal that points up on screen
  let nx = -ty;
  let ny = tx;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const wob = p.wobA * Math.sin(TAU * p.wobF * u + p.wobPh);
  x += nx * wob;
  y += ny * wob;
  if (p.loopAt >= 0) {
    const s = (u - (p.loopAt - p.loopW / 2)) / p.loopW;
    if (s > 0 && s < 1) {
      // forward, up, back over the top, down: a loop riding on the path
      const th = TAU * (s * s * (3 - 2 * s)); // eased in and out so it joins the path smoothly
      x += p.loopR * (Math.sin(th) * tx + (1 - Math.cos(th)) * nx);
      y += p.loopR * (Math.sin(th) * ty + (1 - Math.cos(th)) * ny);
    }
  }
  out.x = x;
  out.y = y;
}

let flightSeq = 0;

function makeFlight(): Flight {
  const root = document.documentElement;
  const vw = root.clientWidth || window.innerWidth;
  const vh = root.clientHeight || window.innerHeight;
  const top = Math.min((document.querySelector('header')?.getBoundingClientRect().bottom ?? 64) + 40, vh / 2);
  const bottom = Math.max(top, vh - 60);
  const ltr = Math.random() < 0.5;
  const sx = ltr ? -OFF : vw + OFF;
  const ex = ltr ? vw + OFF : -OFF;
  const loop = Math.random() < 0.3;
  return {
    id: ++flightSeq,
    dur: rand(DUR_MS[0], DUR_MS[1]),
    flip: ltr ? 1 : -1,
    path: {
      x0: sx,
      y0: rand(top, bottom),
      x1: sx + (ex - sx) * rand(0.2, 0.45),
      y1: rand(top, bottom),
      x2: sx + (ex - sx) * rand(0.55, 0.8),
      y2: rand(top, bottom),
      x3: ex,
      y3: rand(top, bottom),
      wobA: rand(8, 22),
      wobF: rand(2, 5),
      wobPh: rand(0, TAU),
      loopAt: loop ? rand(0.3, 0.7) : -1,
      loopW: rand(0.09, 0.13),
      // wide screens make the path faster: grow the loop so it still closes over the top
      loopR: rand(32, 46) * Math.max(1, vw / 1500),
    },
  };
}

export default function FlyingBee() {
  const [flight, setFlight] = useState<Flight | null>(null);
  const [splash, setSplash] = useState<{ id: number; x: number; y: number } | null>(null);
  const beeRef = useRef<HTMLButtonElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  /** Shared with the click handler: where the bee is and whether it was caught. */
  const live = useRef({ x: 0, y: 0, heading: 0, caught: false, caughtAt: 0, dx: 0, dy: 0 });
  const clipId = `bee-clip-${useId().replace(/:/g, '')}`;

  // schedule: the next bee 9–22 s after the previous one has left
  useEffect(() => {
    if (flight) return;
    const t = setTimeout(() => setFlight(makeFlight()), flightSeq === 0 ? rand(FIRST_MS[0], FIRST_MS[1]) : rand(GAP_MS[0], GAP_MS[1]));
    return () => clearTimeout(t);
  }, [flight]);

  // fly
  useEffect(() => {
    if (!flight) return;
    const bee = beeRef.current;
    const svg = svgRef.current;
    if (!bee || !svg) return;
    const L = live.current;
    L.caught = false;
    const p = flight.path;
    const pt = { x: 0, y: 0 };
    const ahead = { x: 0, y: 0 };
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    let t0 = -1;
    let raf = 0;
    let flip = flight.flip;
    // where the escape starts (set when caught)
    let escX = 0;
    let escY = 0;

    const place = (x: number, y: number, headingRad: number) => {
      L.x = x;
      L.y = y;
      L.heading = headingRad;
      bee.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
      svg.style.transform = `rotate(${((headingRad * 180) / Math.PI).toFixed(1)}deg) scaleY(${flip})`;
    };

    const frame = (now: number) => {
      if (t0 < 0) t0 = now;
      if (!L.caught) {
        const u = (now - t0) / flight.dur;
        if (u >= 1) return setFlight(null);
        pointAt(p, u, pt);
        pointAt(p, Math.min(1, u + 0.004), ahead);
        place(pt.x, pt.y, Math.atan2(ahead.y - pt.y, ahead.x - pt.x));
      } else {
        // darting away: accelerate along the escape direction with a nervous zig-zag
        const t = (now - L.caughtAt) / 1000;
        const dist = 700 * t + 2200 * t * t;
        const zig = Math.sin(t * 42) * 7 * Math.min(1, t * 6);
        const ex = escX + L.dx * dist - L.dy * zig;
        const ey = escY + L.dy * dist + L.dx * zig;
        place(ex, ey, Math.atan2(L.dy, L.dx));
        if (t > 1.6 || ex < -OFF * 2 || ex > vw + OFF * 2 || ey < -OFF * 2 || ey > vh + OFF * 2) return setFlight(null);
      }
      raf = requestAnimationFrame(frame);
    };

    const onCatch = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (L.caught) return;
      L.caught = true;
      L.caughtAt = performance.now();
      escX = L.x;
      escY = L.y;
      // keep going the way she was heading, but up and away
      let dx = Math.cos(L.heading);
      let dy = Math.sin(L.heading) - 0.9;
      const n = Math.hypot(dx, dy) || 1;
      dx /= n;
      dy /= n;
      L.dx = dx;
      L.dy = dy;
      flip = dx < 0 ? -1 : 1;
      bee.classList.add('fast');
      sfx('catch');
      sfx('buzz');
      setSplash({ id: L.caughtAt, x: Math.round(L.x), y: Math.round(L.y) });
    };
    bee.addEventListener('pointerdown', onCatch);

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      bee.removeEventListener('pointerdown', onCatch);
    };
  }, [flight]);

  const c = theme.palette;
  return (
    <>
      {splash && <i key={splash.id} className="bee-splash" style={{ transform: `translate3d(${splash.x}px,${splash.y}px,0)` }} onAnimationEnd={(e) => e.animationName === 'beeSplash' && setSplash(null)} />}
      {flight && (
        <button key={flight.id} ref={beeRef} type="button" tabIndex={-1} data-sfx="none" className="bee-fly" style={{ transform: `translate3d(${flight.path.x0}px,${flight.path.y0}px,0)` }}>
          <span className="bee-shadow" />
          <svg ref={svgRef} viewBox="-28 -22 56 44" aria-hidden>
            <defs>
              <clipPath id={clipId}>
                <ellipse cx="-3" cy="2" rx="14" ry="10" />
              </clipPath>
            </defs>
            {/* stinger */}
            <path d="M-16 2 L-23 3.5 L-16 5.5 Z" fill={c.base} />
            {/* body + stripes clipped to it */}
            <ellipse cx="-3" cy="2" rx="14" ry="10" fill={c.accent} stroke={c.base} strokeOpacity="0.35" strokeWidth="1" />
            <path d="M-13 -9h4.5v22H-13zM-5 -9h4.5v22H-5zM3 -9h4v22H3z" fill={c.base} clipPath={`url(#${clipId})`} />
            {/* head, eye, antennae */}
            <circle cx="12.5" cy="0" r="6.5" fill={c.base} />
            <circle cx="15" cy="-1.8" r="1.7" fill={c.royal} />
            <path d="M14 -5.5q2 -6 7.5 -7.5M11 -6q-0.5 -6 3 -9" fill="none" stroke={c.base} strokeWidth="1.3" strokeLinecap="round" />
            {/* wings: translucent, flapping fast (CSS), hinged at the bottom */}
            <ellipse className="bee-wing" cx="-4" cy="-13" rx="6.5" ry="10" fill={c.royal} fillOpacity="0.5" stroke={c.royal} strokeOpacity="0.8" strokeWidth="0.8" />
            <ellipse className="bee-wing b" cx="3" cy="-12" rx="5.5" ry="8.5" fill={c.royal} fillOpacity="0.38" stroke={c.royal} strokeOpacity="0.7" strokeWidth="0.8" />
          </svg>
        </button>
      )}
    </>
  );
}
