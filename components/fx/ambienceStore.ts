'use client';
/**
 * The "Bees" switch in the nav: ambient motion on or off (the swarm, money splashes, honey on
 * click and the drips' slow stretch). On by default, remembered in localStorage (`hive:bees`);
 * storage that throws (private mode, blocked cookies) just means it is not remembered.
 * Mirrors itself onto <html data-ambience="on|off"> so CSS can pause the drips.
 */
import { create } from 'zustand';

export const AMBIENCE_KEY = 'hive:bees';

interface AmbienceState {
  on: boolean;
  /** Read the saved choice (client only; call after mount so SSR markup matches). */
  load: () => void;
  toggle: () => void;
}

function mirror(on: boolean) {
  if (typeof document !== 'undefined') document.documentElement.dataset.ambience = on ? 'on' : 'off';
}

/** The saved choice: anything but '0' (including nothing saved, or unreadable storage) is on. */
export function readAmbience(storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
  try {
    return storage?.getItem(AMBIENCE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function saveAmbience(storage: Pick<Storage, 'setItem'> | null | undefined, on: boolean) {
  try {
    storage?.setItem(AMBIENCE_KEY, on ? '1' : '0');
  } catch {
    /* not remembered; still applies for this visit */
  }
}

const local = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

export const useAmbience = create<AmbienceState>((set, get) => ({
  on: true,
  load: () => {
    const on = readAmbience(local());
    mirror(on);
    set({ on });
  },
  toggle: () => {
    const on = !get().on;
    saveAmbience(local(), on);
    mirror(on);
    set({ on });
  },
}));
