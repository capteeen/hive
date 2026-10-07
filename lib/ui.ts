'use client';
import { create } from 'zustand';
import type { Cell } from './types';

interface UI {
  launchOpen: boolean;
  /** The empty cell the user picked on the comb, if the launch started there. */
  launchCell: Cell | null;
  /** Open the launch modal, optionally reserving an empty cell. Safe to pass straight to onClick. */
  openLaunch: (cell?: Cell | null | unknown) => void;
  setLaunchCell: (cell: Cell | null) => void;
  closeLaunch: () => void;
}

const asCell = (c: unknown): Cell | null => {
  if (!c || typeof c !== 'object') return null;
  const { q, r } = c as Partial<Cell>;
  return typeof q === 'number' && typeof r === 'number' && Number.isFinite(q) && Number.isFinite(r) ? { q, r } : null;
};

export const useUI = create<UI>((set) => ({
  launchOpen: false,
  launchCell: null,
  openLaunch: (cell) => set({ launchOpen: true, launchCell: asCell(cell) }),
  setLaunchCell: (cell) => set({ launchCell: asCell(cell) }),
  closeLaunch: () => set({ launchOpen: false, launchCell: null }),
}));

if (typeof window !== 'undefined') (window as unknown as { __ui?: typeof useUI }).__ui = useUI;
