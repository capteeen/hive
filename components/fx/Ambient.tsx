'use client';
/**
 * Ambient life on every page: money splashes, and for the hive theme a small swarm of bees
 * (./Swarm) plus a honey droplet on every click (./HoneyTap).
 *
 * - Client-only: the effects are dynamic imports with ssr: false, and nothing renders before mount.
 * - Renders nothing under prefers-reduced-motion (and globals.css hides `.fx-layer` there too),
 *   or when the nav's Bees switch is off (./ambienceStore).
 * - Pauses while the tab is hidden and while the launch wizard is open: the effects are unmounted,
 *   which clears their timers and animation frames; they start fresh when shown again.
 * - One fixed overlay (`.fx-layer`, z-index 45: above the page and the nav, so a bee can land on
 *   the logo; below modals at 50) with pointer-events: none; only the coins and the bees catch clicks.
 * - The flying creature (its drawing and its buzz) and the honey belong to the theme
 *   (`theme.ambience`): only `hive` has them, so a swapped theme (pack: wolves and dens) keeps the
 *   money splashes and flies nothing.
 */
import dynamic from 'next/dynamic';
import { useEffect, useState, type ComponentType } from 'react';
import { useUI } from '@/lib/ui';
import { theme } from '@/themes';
import { useAmbience } from './ambienceStore';
import { ambienceOf } from './swarmModel';

const MoneySplash = dynamic(() => import('./MoneySplash'), { ssr: false });
const Swarm = dynamic(() => import('./Swarm'), { ssr: false });
const HoneyTap = dynamic(() => import('./HoneyTap'), { ssr: false });

/** The ambient creature of each theme, by theme id. */
const CRITTERS: Record<string, ComponentType> = { hive: Swarm };
export const critterFor = (themeId: string): ComponentType | null => CRITTERS[themeId] ?? null;
const Critter = critterFor(theme.id);
const honey = ambienceOf(theme).honey;

export default function Ambient() {
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(true);
  const launching = useUI((s) => s.launchOpen);
  const on = useAmbience((s) => s.on);

  useEffect(() => {
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const onMotion = () => setReduced(!!mq?.matches);
    const onVisibility = () => setVisible(document.visibilityState !== 'hidden');
    onMotion();
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    if (mq?.addEventListener) mq.addEventListener('change', onMotion);
    else mq?.addListener?.(onMotion); // Safari < 14
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (mq?.removeEventListener) mq.removeEventListener('change', onMotion);
      else mq?.removeListener?.(onMotion);
    };
  }, []);

  if (reduced || !visible || launching || !on) return null;
  return (
    <div className="fx-layer" aria-hidden="true">
      <MoneySplash />
      {Critter && <Critter />}
      {honey && <HoneyTap />}
    </div>
  );
}
