/**
 * The queen you design in the launch wizard: her look (drawn in 3D on the comb and as the
 * coin's logo) and her rule numbers (public, mechanical, run every hour by the simulator).
 */
import { theme } from '@/themes';

export type Marking = 'stripes' | 'bands' | 'chevron' | 'spots' | 'solid';
export type Crown = 'none' | 'crown' | 'tiara' | 'halo';

export interface QueenLook {
  body: string; // abdomen ("shell")
  marking: Marking;
  fuzz: string; // thorax
  glow: string; // aura
  wings: string;
  crown: Crown;
}

export const SHELLS = ['#F5A524', '#FFC866', '#C8742A', '#E0502A', '#2A2118', '#F3E6CF', '#7A4BC2', '#3F9E78'];
export const FUZZ = ['#FFC866', '#FFF1D6', '#B07A3C', '#2C2620', '#F2A7B5', '#9FD3FF'];
export const GLOWS = ['#F5A524', '#FFF8EC', '#FF5C3A', '#FF8FCF', '#7CC8FF', '#8DF0B4', '#B48CFF', '#FFE066'];
export const WINGS = ['#FFF1D6', '#FFFFFF', '#BFE6FF', '#FFC9D9', '#D9C9FF', '#C9F5D9', '#BDB6AC', '#FFD9A8'];
export const MARKINGS: { id: Marking; label: string }[] = [
  { id: 'stripes', label: 'Stripes' },
  { id: 'bands', label: 'Bands' },
  { id: 'chevron', label: 'Chevron' },
  { id: 'spots', label: 'Spots' },
  { id: 'solid', label: 'Solid' },
];
export const CROWNS: { id: Crown; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'crown', label: 'Crown' },
  { id: 'tiara', label: 'Tiara' },
  { id: 'halo', label: 'Halo' },
];

export const DEFAULT_LOOK: QueenLook = { body: SHELLS[0], marking: 'stripes', fuzz: FUZZ[0], glow: GLOWS[0], wings: WINGS[0], crown: 'crown' };

export function randomLook(rand: () => number = Math.random): QueenLook {
  const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
  return { body: pick(SHELLS), marking: pick(MARKINGS).id, fuzz: pick(FUZZ), glow: pick(GLOWS), wings: pick(WINGS), crown: pick(CROWNS).id };
}

export function isLook(x: unknown): x is QueenLook {
  if (!x || typeof x !== 'object') return false;
  const l = x as Record<string, unknown>;
  const hex = (v: unknown) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
  return hex(l.body) && hex(l.fuzz) && hex(l.glow) && hex(l.wings) && MARKINGS.some((m) => m.id === l.marking) && CROWNS.some((c) => c.id === l.crown);
}

/** Colour of the marking drawn over the shell: dark on light shells, gold on dark ones. */
export function markColor(body: string) {
  const n = parseInt(body.slice(1), 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum < 0.3 ? '#FFC866' : '#1C1207';
}

/* ---------- rules ---------- */
export interface QueenRules {
  /** Share of the hour's budget bought and burned when the price is in a dip. */
  burnShare: number;
  /** How far below the 24h average the price must be to count as a dip (0 = any dip). */
  sealTrigger: number;
  /** Swarm when honey exceeds this many times the hourly fee average. */
  interactThreshold: number;
  /** Share of honey spent on one swarm. */
  interactShare: number;
  /** Hours between swarms. */
  cooldownH: number;
}

export const DEFAULT_RULES: QueenRules = {
  burnShare: theme.rules.burnShare,
  sealTrigger: 0,
  interactThreshold: theme.rules.interactThreshold,
  interactShare: theme.rules.interactShare,
  cooldownH: 1,
};

export const RULE_LIMITS = {
  burnShare: { min: 0.1, max: 0.8, step: 0.05 },
  sealTrigger: { min: 0, max: 0.2, step: 0.01 },
  interactThreshold: { min: 1.2, max: 6, step: 0.1 },
  interactShare: { min: 0.05, max: 0.5, step: 0.05 },
  cooldownH: { min: 0.5, max: 6, step: 0.5 },
} as const;

export function clampRules(r: Partial<QueenRules>): QueenRules {
  const out = { ...DEFAULT_RULES };
  for (const k of Object.keys(RULE_LIMITS) as (keyof QueenRules)[]) {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(RULE_LIMITS[k].max, Math.max(RULE_LIMITS[k].min, v));
  }
  return out;
}

export type Risk = 'low' | 'medium' | 'high' | 'extreme';

/** What she does in a dip. */
export const DIPS = [
  { id: 'gentle', name: 'Gentle', icon: '◇', body: `Seals lightly. In a real dip (3% under the 24h average) she burns 25% of the hour's fees and stores the rest.`, rules: { burnShare: 0.25, sealTrigger: 0.03 } },
  { id: 'steady', name: 'Steady', icon: '◆', body: `The default. Any dip under the 24h average: 40% of the hour's fees buy and burn, 60% stored as ${theme.copy.resource}.`, rules: { burnShare: 0.4, sealTrigger: 0 } },
  { id: 'fierce', name: 'Fierce', icon: '✦', body: `Defends the price. Any dip: 65% of the hour's fees buy and burn. Less ${theme.copy.resource}, more ${theme.verbs.burn}s.`, rules: { burnShare: 0.65, sealTrigger: 0 } },
] as const;

/** How she swarms. */
export const SWARMS = [
  { id: 'homebody', name: 'Homebody', risk: 'low' as Risk, body: `Rarely leaves. Swarms only when ${theme.copy.resource} is 4× her hourly fees, with 10% of it.`, rules: { interactThreshold: 4, interactShare: 0.1, cooldownH: 3 } },
  { id: 'forager', name: 'Forager', risk: 'medium' as Risk, body: 'Balanced all-rounder: swarms at 2× her hourly fees with 25%. The default.', rules: { interactThreshold: 2, interactShare: 0.25, cooldownH: 1 } },
  { id: 'raider', name: 'Raider', risk: 'high' as Risk, body: 'Momentum: swarms at 1.5× with 35%, every 45 minutes if she can. Hits the fastest-growing neighbour hard.', rules: { interactThreshold: 1.5, interactShare: 0.35, cooldownH: 0.75 } },
  { id: 'berserker', name: 'Berserker', risk: 'extreme' as Risk, body: `Swarms at 1.2× with half her ${theme.copy.resource}. EXTREME RISK: her vault can drain fast.`, rules: { interactThreshold: 1.2, interactShare: 0.5, cooldownH: 0.5 } },
] as const;

export type DipId = (typeof DIPS)[number]['id'];
export type SwarmId = (typeof SWARMS)[number]['id'] | 'custom';

export function presetRules(dip: DipId, swarm: SwarmId, custom?: QueenRules): QueenRules {
  if (swarm === 'custom' && custom) return clampRules(custom);
  const d = DIPS.find((x) => x.id === dip) ?? DIPS[1];
  const s = SWARMS.find((x) => x.id === swarm) ?? SWARMS[1];
  return clampRules({ ...d.rules, ...s.rules, cooldownH: s.rules.cooldownH });
}

export function rulesSummary(r: QueenRules) {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return {
    seal: `${pct(r.burnShare)} on ${r.sealTrigger > 0 ? `a ${pct(r.sealTrigger)} dip` : 'any dip'}`,
    swarm: `at ${r.interactThreshold.toFixed(1)}× fees`,
    size: `${pct(r.interactShare)} of ${theme.copy.resource}`,
    cooldown: r.cooldownH >= 1 ? `${r.cooldownH % 1 ? r.cooldownH.toFixed(1) : r.cooldownH} h` : `${Math.round(r.cooldownH * 60)} min`,
  };
}

/* ---------- 2D portrait: the coin logo ---------- */
/** Draw the queen top-down on a hex of honey. Returns a PNG data URL (browser only). */
export function drawQueenImage(look: QueenLook, size = 512): string {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const s = size / 512;
  const cx = size / 2;
  const cy = size / 2;
  // honey hex
  const hex = (r: number) => {
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
  };
  const bg = g.createRadialGradient(cx, cy * 0.85, 10 * s, cx, cy, 260 * s);
  bg.addColorStop(0, '#FFD98A');
  bg.addColorStop(0.55, '#F5A524');
  bg.addColorStop(1, '#8A5410');
  hex(250 * s);
  g.fillStyle = bg;
  g.fill();
  // glow
  const glow = g.createRadialGradient(cx, cy, 0, cx, cy, 210 * s);
  glow.addColorStop(0, look.glow + 'cc');
  glow.addColorStop(1, look.glow + '00');
  g.fillStyle = glow;
  hex(250 * s);
  g.fill();
  g.save();
  g.translate(cx, cy + 18 * s);
  // wings
  g.fillStyle = look.wings + 'b0';
  g.strokeStyle = '#1C120760';
  g.lineWidth = 3 * s;
  for (const side of [-1, 1]) {
    for (const [len, wid, ang, oy] of [
      [150, 62, 0.55, -40],
      [105, 44, 1.0, -5],
    ]) {
      g.save();
      g.translate(side * 26 * s, oy * s);
      g.rotate(side * (Math.PI / 2 - ang));
      g.beginPath();
      g.ellipse(0, -len * 0.5 * s, wid * 0.5 * s, len * 0.5 * s, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.restore();
    }
  }
  // abdomen with marking
  const mark = markColor(look.body);
  g.save();
  g.beginPath();
  g.ellipse(0, 55 * s, 62 * s, 95 * s, 0, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = look.body;
  g.fillRect(-80 * s, -60 * s, 160 * s, 220 * s);
  g.fillStyle = mark;
  if (look.marking === 'stripes') for (let i = 0; i < 4; i++) g.fillRect(-80 * s, (5 + i * 40) * s, 160 * s, 18 * s);
  else if (look.marking === 'bands') for (let i = 0; i < 2; i++) g.fillRect(-80 * s, (25 + i * 62) * s, 160 * s, 32 * s);
  else if (look.marking === 'chevron')
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      const y = (20 + i * 45) * s;
      g.moveTo(-80 * s, y);
      g.lineTo(0, y + 26 * s);
      g.lineTo(80 * s, y);
      g.lineTo(80 * s, y + 16 * s);
      g.lineTo(0, y + 42 * s);
      g.lineTo(-80 * s, y + 16 * s);
      g.closePath();
      g.fill();
    }
  else if (look.marking === 'spots')
    for (const [x, y, r] of [
      [-22, 20, 12],
      [24, 34, 10],
      [-10, 70, 14],
      [28, 92, 11],
      [-30, 110, 9],
    ]) {
      g.beginPath();
      g.arc(x * s, y * s, r * s, 0, Math.PI * 2);
      g.fill();
    }
  g.fillStyle = mark;
  g.fillRect(-80 * s, 132 * s, 160 * s, 40 * s); // tail tip
  // gloss
  const gl = g.createLinearGradient(-60 * s, 0, 60 * s, 0);
  gl.addColorStop(0, '#ffffff00');
  gl.addColorStop(0.35, '#ffffff40');
  gl.addColorStop(0.55, '#ffffff00');
  g.fillStyle = gl;
  g.fillRect(-80 * s, -60 * s, 160 * s, 220 * s);
  g.restore();
  // thorax
  g.fillStyle = look.fuzz;
  g.beginPath();
  g.ellipse(0, -48 * s, 52 * s, 48 * s, 0, 0, Math.PI * 2);
  g.fill();
  // head + eyes
  g.fillStyle = '#1C1207';
  g.beginPath();
  g.ellipse(0, -112 * s, 36 * s, 32 * s, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff55';
  for (const side of [-1, 1]) {
    g.beginPath();
    g.ellipse(side * 18 * s, -118 * s, 8 * s, 11 * s, side * 0.3, 0, Math.PI * 2);
    g.fill();
  }
  // antennae
  g.strokeStyle = '#1C1207';
  g.lineWidth = 6 * s;
  g.lineCap = 'round';
  for (const side of [-1, 1]) {
    g.beginPath();
    g.moveTo(side * 12 * s, -138 * s);
    g.quadraticCurveTo(side * 30 * s, -185 * s, side * 52 * s, -192 * s);
    g.stroke();
  }
  // crown
  g.fillStyle = '#FFD45A';
  g.strokeStyle = '#8A5410';
  g.lineWidth = 3 * s;
  if (look.crown === 'crown') {
    g.beginPath();
    g.moveTo(-34 * s, -128 * s);
    g.lineTo(-38 * s, -172 * s);
    g.lineTo(-18 * s, -150 * s);
    g.lineTo(0, -180 * s);
    g.lineTo(18 * s, -150 * s);
    g.lineTo(38 * s, -172 * s);
    g.lineTo(34 * s, -128 * s);
    g.closePath();
    g.fill();
    g.stroke();
  } else if (look.crown === 'tiara') {
    g.beginPath();
    g.arc(0, -120 * s, 36 * s, Math.PI * 1.1, Math.PI * 1.9);
    g.lineWidth = 8 * s;
    g.strokeStyle = '#FFD45A';
    g.stroke();
    g.fillStyle = look.glow;
    g.beginPath();
    g.arc(0, -158 * s, 9 * s, 0, Math.PI * 2);
    g.fill();
  } else if (look.crown === 'halo') {
    g.strokeStyle = '#FFF4C2';
    g.lineWidth = 7 * s;
    g.beginPath();
    g.ellipse(0, -168 * s, 40 * s, 12 * s, 0, 0, Math.PI * 2);
    g.stroke();
  }
  g.restore();
  // rim
  hex(250 * s);
  g.lineWidth = 10 * s;
  g.strokeStyle = '#00000030';
  g.stroke();
  return c.toDataURL('image/png');
}
