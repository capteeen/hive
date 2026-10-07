'use client';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { theme } from '@/themes';
import HexButton from '@/components/HexButton';
import HarvestCountdown from '@/components/HarvestCountdown';
import { useUI } from '@/lib/ui';
import type { SafeArea } from '@/lib/comb3d';

const CombScene = dynamic(() => import('@/components/comb/CombScene'), { ssr: false });

export default function HomeHero() {
  const openLaunch = useUI((s) => s.openLaunch);
  const sectionRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Partial<SafeArea>>({});

  // the glass card covers part of the comb: keep picked cells (and the comb's centre) clear of it
  useEffect(() => {
    const measure = () => {
      const sec = sectionRef.current?.getBoundingClientRect();
      const card = cardRef.current?.getBoundingClientRect();
      if (!sec || !card) return;
      if (window.innerWidth >= 1024) setArea({ left: Math.round(card.right - sec.left + 16), top: 72 });
      else setArea({ top: 96, bottom: Math.round(sec.bottom - card.top + 12) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (cardRef.current) ro.observe(cardRef.current);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  return (
    <section ref={sectionRef} className="relative h-[100svh] min-h-[640px] w-full overflow-hidden">
      <CombScene className="absolute inset-0 h-full w-full" safeArea={area} wheelZoom="modifier" touchScroll />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-night to-transparent" />
      <div className="pointer-events-none absolute inset-0 flex items-end pb-16 pt-28 sm:items-center sm:pb-0">
        <div className="mx-auto w-full max-w-[1400px] px-4 sm:px-6">
          <div ref={cardRef} className="shape-card glass fade-up pointer-events-auto max-w-xl p-7 sm:p-10">
            <div className="text-[11px] uppercase tracking-[0.2em] text-accent">{theme.copy.eyebrow}</div>
            <h1 className="mt-3 font-heading text-7xl font-semibold leading-[0.9] tracking-tight sm:text-8xl">{theme.name}</h1>
            <p className="mt-5 max-w-md text-base leading-relaxed text-text/75 sm:text-lg">{theme.copy.tagline}</p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <HexButton size="lg" onClick={() => openLaunch()} data-sfx="open">
                Launch a {theme.unit}
              </HexButton>
              <HexButton size="lg" variant="ghost" href="/how">
                How it works
              </HexButton>
            </div>
            <HarvestCountdown className="mt-8" />
          </div>
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-6 right-6 hidden text-[11px] uppercase tracking-[0.18em] text-text/40 sm:block">drag to pan · ctrl/⌘ + scroll to zoom · click any cell</div>
    </section>
  );
}
