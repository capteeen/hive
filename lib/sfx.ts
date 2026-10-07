'use client';
/**
 * UI sound effects, synthesised with WebAudio (no asset files).
 * Every click in the app gets a sound: buttons and links default to `click`; any element
 * (or ancestor) can pick another with `data-sfx="name"`, or opt out with `data-sfx="none"`.
 * Comb picks, wizard steps and launches call `sfx()` directly.
 */
export type SfxName =
  | 'click'
  | 'tick'
  | 'select'
  | 'empty'
  | 'deselect'
  | 'open'
  | 'close'
  | 'next'
  | 'back'
  | 'toggle'
  | 'shuffle'
  | 'swatch'
  | 'launch'
  | 'error'
  // ambient life (components/fx): a caught SOL coin, a caught bee, the bee's buzz, a near bee passing
  | 'coin'
  | 'catch'
  | 'buzz'
  | 'flyby';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;
let lastAt = 0;
let lastName = '';

export function setSfxEnabled(on: boolean) {
  enabled = on;
}
export function sfxEnabled() {
  return enabled;
}

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.55;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

interface Tone {
  type?: OscillatorType;
  f0: number;
  f1?: number;
  at?: number; // start offset (s)
  dur: number;
  gain: number;
  attack?: number;
  filter?: { type: BiquadFilterType; freq: number; q?: number };
}

function tone(ac: AudioContext, t: Tone) {
  const start = ac.currentTime + (t.at ?? 0);
  const o = ac.createOscillator();
  o.type = t.type ?? 'sine';
  o.frequency.setValueAtTime(t.f0, start);
  if (t.f1) o.frequency.exponentialRampToValueAtTime(t.f1, start + t.dur);
  const g = ac.createGain();
  const a = t.attack ?? 0.004;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(t.gain, start + a);
  g.gain.exponentialRampToValueAtTime(0.0001, start + t.dur);
  let node: AudioNode = o;
  if (t.filter) {
    const f = ac.createBiquadFilter();
    f.type = t.filter.type;
    f.frequency.value = t.filter.freq;
    f.Q.value = t.filter.q ?? 0.8;
    node.connect(f);
    node = f;
  }
  node.connect(g).connect(master!);
  o.start(start);
  o.stop(start + t.dur + 0.02);
}

function noise(ac: AudioContext, at: number, dur: number, gain: number, freq: number, type: BiquadFilterType = 'highpass') {
  const start = ac.currentTime + at;
  const len = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const f = ac.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  const g = ac.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(master!);
  src.start(start);
}

/** A bee buzz: sawtooth through a band-pass with a fast amplitude wobble. */
function buzz(ac: AudioContext, at: number, dur: number, gain: number, freq = 190) {
  const start = ac.currentTime + at;
  const o = ac.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(freq, start);
  o.frequency.linearRampToValueAtTime(freq * 1.25, start + dur * 0.5);
  o.frequency.linearRampToValueAtTime(freq * 0.95, start + dur);
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 650;
  bp.Q.value = 1.2;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.08);
  g.gain.setValueAtTime(gain, start + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  const lfo = ac.createOscillator();
  lfo.frequency.value = 26;
  const lfoGain = ac.createGain();
  lfoGain.gain.value = gain * 0.5;
  lfo.connect(lfoGain).connect(g.gain);
  o.connect(bp).connect(g).connect(master!);
  o.start(start);
  lfo.start(start);
  o.stop(start + dur + 0.05);
  lfo.stop(start + dur + 0.05);
}

const SOUNDS: Record<SfxName, (ac: AudioContext) => void> = {
  // a soft wax tap
  click: (ac) => {
    tone(ac, { f0: 1250, f1: 760, dur: 0.05, gain: 0.11 });
    noise(ac, 0, 0.018, 0.05, 3200);
  },
  tick: (ac) => tone(ac, { f0: 1900, dur: 0.018, gain: 0.04 }),
  swatch: (ac) => {
    tone(ac, { f0: 980, f1: 1320, dur: 0.06, gain: 0.09, type: 'triangle' });
  },
  // a drop of honey
  select: (ac) => {
    tone(ac, { f0: 660, f1: 330, dur: 0.16, gain: 0.18 });
    tone(ac, { f0: 1320, f1: 900, dur: 0.07, gain: 0.04, type: 'triangle' });
  },
  // a hollow pop: an empty cell
  empty: (ac) => {
    tone(ac, { f0: 300, f1: 760, dur: 0.12, gain: 0.15 });
    noise(ac, 0, 0.06, 0.035, 1800, 'bandpass');
  },
  deselect: (ac) => tone(ac, { f0: 440, f1: 300, dur: 0.09, gain: 0.07 }),
  open: (ac) => {
    tone(ac, { f0: 523.25, dur: 0.12, gain: 0.1, type: 'triangle' });
    tone(ac, { f0: 783.99, dur: 0.18, gain: 0.1, type: 'triangle', at: 0.07 });
  },
  close: (ac) => {
    tone(ac, { f0: 783.99, dur: 0.1, gain: 0.08, type: 'triangle' });
    tone(ac, { f0: 523.25, dur: 0.14, gain: 0.08, type: 'triangle', at: 0.06 });
  },
  next: (ac) => {
    tone(ac, { f0: 659.25, dur: 0.08, gain: 0.1, type: 'triangle' });
    tone(ac, { f0: 987.77, dur: 0.12, gain: 0.1, type: 'triangle', at: 0.06 });
  },
  back: (ac) => {
    tone(ac, { f0: 987.77, dur: 0.08, gain: 0.08, type: 'triangle' });
    tone(ac, { f0: 659.25, dur: 0.12, gain: 0.08, type: 'triangle', at: 0.06 });
  },
  toggle: (ac) => {
    tone(ac, { f0: 880, f1: 1180, dur: 0.05, gain: 0.08 });
  },
  shuffle: (ac) => {
    [880, 1175, 740, 1320].forEach((f, i) => tone(ac, { f0: f, dur: 0.05, gain: 0.07, type: 'triangle', at: i * 0.04 }));
  },
  launch: (ac) => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(ac, { f0: f, dur: 0.22, gain: 0.11, type: 'triangle', at: i * 0.09 }));
    buzz(ac, 0.3, 1.3, 0.05);
  },
  error: (ac) => {
    tone(ac, { f0: 150, dur: 0.16, gain: 0.08, type: 'square', filter: { type: 'lowpass', freq: 900 } });
  },
  // a SOL coin: a bright metallic clink, two quick high partials plus an inharmonic shimmer
  coin: (ac) => {
    noise(ac, 0, 0.012, 0.035, 6500);
    tone(ac, { f0: 1975.53, dur: 0.07, gain: 0.08, type: 'triangle' });
    tone(ac, { f0: 2637.02, at: 0.055, dur: 0.3, gain: 0.085, type: 'triangle' });
    tone(ac, { f0: 6330, at: 0.055, dur: 0.12, gain: 0.018 });
  },
  // a caught bee: a playful upward chirp
  catch: (ac) => {
    tone(ac, { f0: 520, f1: 1480, dur: 0.13, gain: 0.12, type: 'triangle' });
    tone(ac, { f0: 1046.5, f1: 2093, at: 0.1, dur: 0.11, gain: 0.07, type: 'triangle' });
  },
  // a short bee buzz flying off
  buzz: (ac) => buzz(ac, 0, 0.38, 0.05, 220),
  // a near bee passing: a quiet buzz that swells and falls in pitch as it goes by (Doppler)
  flyby: (ac) => buzz(ac, 0, 1.1, 0.022, 250),
};

/** Play a UI sound (no-op when muted, on the server, or before audio is available). */
export function sfx(name: SfxName) {
  if (!enabled) return;
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  // de-dupe: a component that plays a sound and the global click listener for the same click
  if (name === lastName && now - lastAt < 45) return;
  if (name === 'tick' && now - lastAt < 35) return;
  lastAt = now;
  lastName = name;
  const ac = audio();
  if (!ac || !master) return;
  try {
    SOUNDS[name](ac);
  } catch {
    /* audio is best-effort */
  }
}

const NAMES = new Set(Object.keys(SOUNDS));

/**
 * Install the global click → sound listener. Returns an uninstaller.
 * Buttons, links, checkboxes, radios, selects and summary elements make a sound;
 * range sliders tick as they move.
 */
export function installClickSounds() {
  if (typeof document === 'undefined') return () => {};
  const onClick = (e: MouseEvent) => {
    const el = e.target as HTMLElement | null;
    if (!el || typeof el.closest !== 'function') return;
    const tagged = el.closest<HTMLElement>('[data-sfx]');
    const name = tagged?.dataset.sfx;
    if (name === 'none') return;
    const target = el.closest<HTMLElement>('button, a[href], [role="button"], [role="tab"], input[type="checkbox"], input[type="radio"], select, summary, label');
    if (!target) return;
    if ((target as HTMLButtonElement).disabled || target.getAttribute('aria-disabled') === 'true') {
      sfx('error');
      return;
    }
    if (name && NAMES.has(name)) sfx(name as SfxName);
    else if (target.matches('input[type="checkbox"], input[type="radio"]')) sfx('toggle');
    else if (target.tagName === 'LABEL') return; // the label forwards a click to its input
    else sfx('click');
  };
  const onInput = (e: Event) => {
    const el = e.target as HTMLInputElement | null;
    if (el?.type === 'range') sfx('tick');
  };
  // browsers dispatch no click on natively disabled buttons; catch the press instead
  const onDown = (e: PointerEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && typeof el.closest === 'function' && el.closest('button:disabled')) sfx('error');
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  return () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('input', onInput, true);
  };
}
