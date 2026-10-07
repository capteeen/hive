/**
 * Honey everywhere (themes with `ambience.honey`), all static markup + CSS, rendered on the server
 * so the first paint already says "honey":
 *   - HoneyDrips: a glossy honey film along the nav's bottom edge with drips of varied length
 *     that slowly stretch and now and then let a droplet fall (CSS transforms only);
 *   - HoneyBackdrop: a faint honeycomb texture and warm glow pools behind every page;
 *   - HoneyPool: honey pooled on the footer's top edge, with a few short drips.
 * All aria-hidden and pointer-events: none. Motion stops under prefers-reduced-motion and when the
 * nav's Bees switch is off (html[data-ambience='off']); see globals.css "honey".
 */
import type { CSSProperties } from 'react';

/** One drip: position (% of the width), stem length and bulb radius (px), stretch cycle (s), phase (s), whether it drops. */
export interface Drip {
  at: number;
  len: number;
  r: number;
  dur: number;
  delay: number;
  drop: boolean;
  /** Shown on wide screens only. */
  wide?: boolean;
}

export const NAV_DRIPS: Drip[] = [
  { at: 3, len: 12, r: 3, dur: 9, delay: -2, drop: false, wide: true },
  { at: 9.5, len: 24, r: 3.6, dur: 11, delay: -6, drop: true },
  { at: 17, len: 9, r: 2.8, dur: 8, delay: -1, drop: false, wide: true },
  { at: 27, len: 31, r: 4, dur: 13, delay: -4, drop: true, wide: true },
  { at: 39, len: 14, r: 3, dur: 10, delay: -7, drop: false },
  { at: 50, len: 20, r: 3.4, dur: 12, delay: -3, drop: false, wide: true },
  { at: 61, len: 36, r: 4.2, dur: 14, delay: -9, drop: true },
  { at: 72.5, len: 11, r: 3, dur: 9, delay: -5, drop: false, wide: true },
  { at: 83, len: 26, r: 3.6, dur: 12, delay: -2, drop: true },
  { at: 94, len: 15, r: 3.2, dur: 10, delay: -8, drop: false },
];

const W = 18; // drip box width (px)
const C = W / 2;

/** The drip's outline: a meniscus where it leaves the film, a thin stem, a round bulb. */
export function dripPath(len: number, r: number, stem = 1.9): string {
  const L = Math.max(len, 6 + r * 1.6);
  const s = stem;
  const f = (n: number) => +n.toFixed(2);
  return [
    `M0 0H${W}`,
    `C${C + 3} 0 ${f(C + s)} 2 ${f(C + s)} 6`,
    `V${f(L - r * 1.5)}`,
    `C${f(C + s)} ${f(L - r * 0.9)} ${f(C + r)} ${f(L - r * 0.8)} ${f(C + r)} ${f(L)}`,
    `A${r} ${r} 0 0 1 ${f(C - r)} ${f(L)}`,
    `C${f(C - r)} ${f(L - r * 0.8)} ${f(C - s)} ${f(L - r * 0.9)} ${f(C - s)} ${f(L - r * 1.5)}`,
    `V6C${f(C - s)} 2 ${C - 3} 0 0 0Z`,
  ].join('');
}

/** Where a droplet lets go: the bulb's bottom at the stretch's peak (scaleY 1.16, from the drip's top 3 px under the film). */
export const dropTop = (d: Drip) => Math.round(3 + (Math.max(d.len, 6 + d.r * 1.6) + d.r) * 1.16 - 4);

function DripSvg({ d }: { d: Drip }) {
  const L = Math.max(d.len, 6 + d.r * 1.6);
  const h = Math.ceil(L + d.r + 1);
  return (
    <svg width={W} height={h} viewBox={`0 0 ${W} ${h}`} focusable="false">
      <path d={dripPath(d.len, d.r)} fill="url(#fxh-drip)" />
      {/* specular streak down the stem and a glint on the bulb */}
      <path d={`M${C - 0.9} 5V${(L - d.r * 1.4).toFixed(1)}`} stroke="#FFF6DA" strokeOpacity="0.6" strokeWidth="0.9" strokeLinecap="round" />
      <circle cx={C - d.r * 0.38} cy={L - d.r * 0.3} r={d.r * 0.32} fill="#FFFBEF" opacity="0.8" />
    </svg>
  );
}

export function HoneyDrips({ drips = NAV_DRIPS }: { drips?: Drip[] }) {
  return (
    <div className="honey-drips" aria-hidden="true">
      <svg width="0" height="0" style={{ position: 'absolute' }} focusable="false">
        <defs>
          <linearGradient id="fxh-drip" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#A85F08" />
            <stop offset="0.3" stopColor="#F5A524" />
            <stop offset="0.5" stopColor="#FFC866" />
            <stop offset="0.75" stopColor="#F5A524" />
            <stop offset="1" stopColor="#9C5606" />
          </linearGradient>
        </defs>
      </svg>
      <i className="honey-film" />
      {drips.map((d, i) => {
        const timing = { animationDuration: `${d.dur}s`, animationDelay: `${d.delay}s` };
        return (
          <span key={i} className={d.wide ? 'wide' : undefined}>
            <span className="honey-drip" style={{ left: `${d.at}%`, ...timing } as CSSProperties}>
              <DripSvg d={d} />
            </span>
            {/* a sibling, not a child: it must keep falling while the drip snaps back */}
            {d.drop && <i className="honey-drop" style={{ left: `${d.at}%`, top: dropTop(d), ...timing }} />}
          </span>
        );
      })}
    </div>
  );
}

export function HoneyBackdrop() {
  return <div className="honey-bg" aria-hidden="true" />;
}

/** Honey pooled along the footer's top border (place it first inside a relative wrapper of the footer). Its drips use HoneyDrips' gradient. */
export function HoneyPool() {
  return (
    <div className="honey-pool" aria-hidden="true">
      <i className="honey-pool-film" />
      {[
        { at: 12, len: 10, r: 2.8, dur: 12, delay: -3, drop: false },
        { at: 47, len: 16, r: 3.2, dur: 15, delay: -8, drop: false },
        { at: 78, len: 8, r: 2.6, dur: 11, delay: -5, drop: false },
      ].map((d, i) => (
        <span key={i} className="honey-drip" style={{ left: `${d.at}%`, animationDuration: `${d.dur}s`, animationDelay: `${d.delay}s` }}>
          <DripSvg d={d} />
        </span>
      ))}
    </div>
  );
}
