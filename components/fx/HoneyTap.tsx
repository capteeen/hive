'use client';
/**
 * Honey on click: every click or tap leaves a tiny honey droplet splash at the pointer (a blob,
 * a thin ring and three droplets, ~0.5 s, CSS only). Clicks on the ambient bees and coins are
 * skipped (they have their own effects). At most a few splashes live at once; each removes itself.
 * Mounted in `.fx-layer` by ./Ambient for themes with honey.
 */
import { useEffect, useRef } from 'react';

export const MAX_TAPS = 4;

type Host = Pick<HTMLElement, 'childElementCount' | 'firstElementChild' | 'appendChild' | 'ownerDocument'>;

/** Add one splash at (x, y) to `host`, dropping the oldest beyond MAX_TAPS. */
export function spawnTap(host: Host, x: number, y: number): HTMLElement {
  while (host.childElementCount >= MAX_TAPS && host.firstElementChild) host.firstElementChild.remove();
  const d = host.ownerDocument.createElement('i');
  d.className = 'fx-tap';
  // left/top, not transform: the splash animates `scale`, which would scale a translate as well
  d.style.left = `${Math.round(x)}px`;
  d.style.top = `${Math.round(y)}px`;
  d.addEventListener('animationend', (ev) => ev.animationName === 'fxTap' && d.remove());
  host.appendChild(d);
  return d;
}

export default function HoneyTap() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = host.current;
      const t = e.target as Element | null;
      // keyboard "clicks" have no pointer position
      if (!el || (e.clientX === 0 && e.clientY === 0 && e.detail === 0)) return;
      if (t && typeof t.closest === 'function' && t.closest('.fx-layer')) return;
      spawnTap(el, e.clientX, e.clientY);
    };
    document.addEventListener('click', onClick, { capture: true, passive: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, []);
  return <div ref={host} className="fx-taps" />;
}
