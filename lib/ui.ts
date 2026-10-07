'use client';
import { create } from 'zustand';

interface UI {
  launchOpen: boolean;
  openLaunch: () => void;
  closeLaunch: () => void;
}
export const useUI = create<UI>((set) => ({
  launchOpen: false,
  openLaunch: () => set({ launchOpen: true }),
  closeLaunch: () => set({ launchOpen: false }),
}));
