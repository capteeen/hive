/**
 * Theme contract for the engine.
 * Everything visible — copy, palette, verb names, shape language and the 3D scene —
 * reads from a Theme. A new skin is a new file implementing this interface.
 */
export type Verb = 'burn' | 'store' | 'interact' | 'starve' | 'abandon';

export interface Palette {
  base: string; // page background (night)
  surface: string; // card background
  accent: string; // primary accent (amber)
  accentSoft: string; // secondary accent (honey gold)
  text: string; // body text (wax cream)
  royal: string; // reserved for the biggest unit only
  starving: string; // grey
  raid: string; // swarm / hunt red
  dayBase: string; // daylight mode background
  dayText: string; // daylight mode text
}

export interface Fonts {
  heading: string; // CSS font-family stack
  body: string;
  headingWeight: number;
  tracking: string; // letter-spacing for headings
}

export interface ThemeCopy {
  eyebrow: string;
  tagline: string;
  /** 4 numbered steps, each with a title + one sentence. */
  steps: { title: string; body: string }[];
  /** 3 feature cards. */
  feature: { title: string; body: string }[];
  /** Launch modal strings. */
  launch: { title: string; cta: string; sentence: string; reserveLabel: string; namePlaceholder: string; mottoPlaceholder: string; tickerPlaceholder: string };
  /** Per-verb short labels used in the log and markers. */
  verbLabels: Record<'burn' | 'store' | 'interact' | 'starve' | 'abandon', string>;
  /** Stats strip labels. */
  stats: { units: string; holders: string; stored: string; burned: string; next: string };
  /** Name of the stored resource (honey / cache). */
  resource: string;
  /** Name of the reward the hub sends to the biggest unit (royal jelly / alpha's share). */
  reward: string;
  footer: string;
}

/** Ambient decoration on every page (components/fx). Optional: a theme without it gets none. */
export interface Ambience {
  /** What flies around the page (a small swarm, landing on buttons now and then), or nothing. */
  critter: 'bee' | null;
  /** Honey everywhere: drips under the nav, a honeycomb texture and glow in the background, honey on click. */
  honey: boolean;
}

export interface Theme {
  id: string;
  name: string;
  /** What a coin is called (hive / den). */
  unit: string;
  unitPlural: string;
  /** What a holder is called (bee / wolf). */
  holder: string;
  holderPlural: string;
  /** What the AI agent is called (queen / alpha). */
  agent: string;
  /** Verb names, keyed by mechanical verb. */
  verbs: { burn: string; store: string; interact: string };
  hubToken: { symbol: string; name: string; ca: string };
  /** Name of the hourly hub ritual (harvest / hunt). */
  hubRitual: string;
  hubSplit: { burn: number; toBiggest: number };
  feeToHub: number;
  /** Queen rule parameters, public on /how. */
  rules: {
    burnShare: number; // share of hour's fees burned when below 24h avg
    storeShare: number; // share of hour's fees stored by default
    interactThreshold: number; // honey > N × hourly fee avg triggers interact
    interactShare: number; // share of honey spent on interact
    starveHours: number; // consecutive zero-fee hours before starving
    abandonHours: number; // hours before abandoned
  };
  palette: Palette;
  fonts: Fonts;
  shape: 'hex' | 'circle';
  scene: 'comb' | 'den';
  copy: ThemeCopy;
  ambience?: Ambience;
}
