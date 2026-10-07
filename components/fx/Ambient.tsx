'use client';
/**
 * Ambient life on every page: money splashes and a bee flying by now and then.
 *
 * - Client-only: the effects are dynamic imports with ssr: false, and nothing renders before mount.
 * - Renders nothing under prefers-reduced-motion (and globals.css hides `.fx-layer` there too).
 * - Pauses while the tab is hidden and while the launch wizard is open: the effects are unmounted,
 *   which clears their timers and animation frames; they start fresh when shown again.
 * - One fixed overlay (`.fx-layer`, z-index 35: above the page, below the nav and modals) with
 *   pointer-events: none; only the coins and the bee catch clicks.
 */
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { useUI } from '@/lib/ui';

const MoneySplash = dynamic(() => import('./MoneySplash'), { ssr: false });
const FlyingBee = dynamic(() => import('./FlyingBee'), { ssr: false });

export default function Ambient() {
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(true);
  const launching = useUI((s) => s.launchOpen);

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

  if (reduced || !visible || launching) return null;
  return (
    <div className="fx-layer" aria-hidden="true">
      <MoneySplash />
      <FlyingBee />
    </div>
  );
}
