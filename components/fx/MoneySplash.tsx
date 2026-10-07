'use client';
/**
 * Money splashes: every 7–16 s a burst of SOL coins and honey drops pops somewhere on screen,
 * flies outward under gravity, spins and fades over ~1.6 s, with a label rising from the middle.
 * Half the time the label is the latest real action in the store ("+0.12 SOL · $AMBER"),
 * otherwise a random "+0.xx SOL". Coins can be caught: a click pops one with a sparkle and a clink.
 *
 * Rendering: React mounts one burst (≤ 16 nodes) and unmounts it when done; a single
 * requestAnimationFrame loop writes transforms / opacity straight to the nodes (no re-renders,
 * no layout reads per frame). Mounted inside the fixed `.fx-layer` by ./Ambient, which also
 * unmounts it while the tab is hidden or motion is reduced.
 */
import { useEffect, useRef, useState } from 'react';
import { useHive } from '@/lib/store';
import { sfx } from '@/lib/sfx';
import { isDryRun, verbLabel } from '@/components/Badges';

const EDGE = 80; // keep bursts this far from the viewport edges
const LIFE_S = 1.6; // particle lifetime
const LABEL_S = 1.95; // label animation (matches mcLabel in globals.css) + a little slack
const GRAVITY = 900; // px/s²
const DRAG = 1.4; // 1/s, horizontal air drag: keeps the burst about ±280 px wide
const EVERY_MS: [number, number] = [7000, 16000];
const FIRST_MS: [number, number] = [3500, 8000];

interface Particle {
  kind: 'coin' | 'drop';
  size: number;
  vx: number; // px/s
  vy: number; // px/s (negative = up)
  spin: number; // deg/s around z
  flipRate: number; // rad/s of the rotateY wobble
  phase: number;
  delay: number; // s before it leaves the origin
  popped: boolean;
  done: boolean;
}

interface Burst {
  id: number;
  x: number;
  y: number;
  label: string;
  parts: Particle[];
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const amt = (n: number) => (n < 0.01 ? n.toFixed(3) : n.toFixed(2));

/** A label for the newest action in the store, or null when it is not a money moment. */
function actionLabel(): string | null {
  const w = useHive.getState().world;
  const a = w.actions[0];
  if (!a || !(a.amount > 0)) return null;
  const tk = w.hives[a.ca]?.ticker;
  const who = tk ? ` · $${tk}` : '';
  const dry = isDryRun(a.reason) ? ' · dry run' : '';
  switch (a.verb) {
    case 'store':
      return `+${amt(a.amount)} SOL${who}${dry}`;
    case 'seal':
      return `${verbLabel('seal')} ${amt(a.amount)} SOL${who}${dry}`;
    case 'swarm': {
      const to = a.targetCa ? w.hives[a.targetCa]?.ticker : undefined;
      return `${verbLabel('swarm')} ${amt(a.amount)} SOL${who}${to ? ` → $${to}` : ''}${dry}`;
    }
    case 'jelly':
      return `${verbLabel('jelly')} +${amt(a.amount)} SOL${who}${dry}`;
    default:
      return null; // starve / abandon / born are not splashes
  }
}

let burstSeq = 0;

function makeBurst(): Burst {
  const root = document.documentElement;
  const vw = root.clientWidth || window.innerWidth;
  const vh = root.clientHeight || window.innerHeight;
  const navBottom = document.querySelector('header')?.getBoundingClientRect().bottom ?? 64;

  const label = (Math.random() < 0.5 && actionLabel()) || `+${rand(0.01, 0.49).toFixed(2)} SOL`;
  // keep the label on screen too (≈ 8.5 px per character at 15 px)
  const half = Math.max(EDGE, (label.length * 8.5) / 2 + 12);
  const minX = Math.min(half, vw / 2);
  // coins arc up ~220 px: start a little lower so they mostly stay clear of the nav
  const minY = Math.min(navBottom + EDGE + 40, vh / 2);
  const x = Math.round(rand(minX, Math.max(minX, vw - minX)));
  const y = Math.round(rand(minY, Math.max(minY, vh - EDGE)));

  const parts: Particle[] = [];
  const coins = 6 + Math.floor(Math.random() * 5); // 6–10
  const drops = 3 + Math.floor(Math.random() * 2); // 3–4
  for (let i = 0; i < coins + drops; i++) {
    const coin = i < coins;
    // a fan pointing up, spread about ±65° from vertical
    const ang = -Math.PI / 2 + rand(-1.15, 1.15);
    const speed = coin ? rand(260, 480) : rand(200, 380);
    parts.push({
      kind: coin ? 'coin' : 'drop',
      size: coin ? Math.round(rand(22, 30)) : Math.round(rand(7, 11)),
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed - (coin ? 160 : 90),
      spin: rand(-420, 420),
      flipRate: rand(5, 11),
      phase: rand(0, Math.PI * 2),
      delay: coin ? rand(0, 0.05) : rand(0.02, 0.12),
      popped: false,
      done: false,
    });
  }
  return { id: ++burstSeq, x, y, label, parts };
}

export default function MoneySplash() {
  const [burst, setBurst] = useState<Burst | null>(null);
  const els = useRef<(HTMLElement | null)[]>([]);
  const burstRef = useRef<Burst | null>(null);
  burstRef.current = burst;

  // schedule: one burst at a time, the next one 7–16 s after the previous started
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const next = (range: [number, number]) => {
      timer = setTimeout(() => {
        setBurst(makeBurst());
        next(EVERY_MS);
      }, rand(range[0], range[1]));
    };
    next(FIRST_MS);
    return () => clearTimeout(timer);
  }, []);

  // animate the current burst, then unmount it
  useEffect(() => {
    if (!burst) return;
    let raf = 0;
    let t0 = -1;
    const parts = burst.parts;
    const frame = (now: number) => {
      if (t0 < 0) t0 = now;
      const t = (now - t0) / 1000;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const el = els.current[i];
        if (!el || p.popped || p.done) continue;
        const lt = t - p.delay;
        if (lt < 0) continue;
        const life = LIFE_S - p.delay;
        if (lt >= life) {
          p.done = true;
          el.style.opacity = '0';
          el.style.pointerEvents = 'none';
          continue;
        }
        const k = lt / life;
        const drag = Math.exp(-DRAG * lt);
        const x = (p.vx / DRAG) * (1 - drag);
        const y = p.vy * lt + 0.5 * GRAVITY * lt * lt;
        const grow = lt < 0.14 ? 0.35 + (0.65 * lt) / 0.14 : 1;
        const fade = k < 0.62 ? 1 : 1 - (k - 0.62) / 0.38;
        if (p.kind === 'coin') {
          const flip = Math.sin(p.phase + p.flipRate * lt) * 58;
          el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) perspective(420px) rotateZ(${(p.spin * lt).toFixed(1)}deg) rotateY(${flip.toFixed(1)}deg) rotateX(18deg) scale(${grow.toFixed(3)})`;
          // faded coins stop catching clicks
          if (fade < 0.2) el.style.pointerEvents = 'none';
        } else {
          // the drop's tail trails its velocity
          const heading = (Math.atan2(p.vy + GRAVITY * lt, p.vx * drag) * 180) / Math.PI;
          el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) rotate(${(heading + 225).toFixed(1)}deg) scale(${grow.toFixed(3)})`;
        }
        el.style.opacity = fade.toFixed(3);
      }
      if (t < LABEL_S) raf = requestAnimationFrame(frame);
      else setBurst((b) => (b === burst ? null : b));
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [burst]);

  if (!burst) return null;

  const pop = (i: number) => (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const p = burstRef.current?.parts[i];
    const el = els.current[i];
    if (!p || !el || p.popped || p.done) return;
    p.popped = true; // the frame loop leaves it where it is; CSS plays the pop + sparkle
    el.classList.add('pop');
    sfx('coin');
  };

  return (
    <div key={burst.id} className="mc-burst" style={{ left: burst.x, top: burst.y }}>
      {burst.parts.map((p, i) =>
        p.kind === 'coin' ? (
          <button
            key={i}
            type="button"
            tabIndex={-1}
            data-sfx="none"
            className="mc-coin"
            ref={(el) => {
              els.current[i] = el;
            }}
            style={{ width: p.size, height: p.size, margin: -p.size / 2, fontSize: Math.round(p.size * 0.58) }}
            onPointerDown={pop(i)}
          >
            ◎
          </button>
        ) : (
          <i
            key={i}
            className="mc-drop"
            ref={(el) => {
              els.current[i] = el;
            }}
            style={{ width: p.size, height: p.size, margin: -p.size / 2 }}
          />
        ),
      )}
      <span className="mc-label">{burst.label}</span>
    </div>
  );
}
