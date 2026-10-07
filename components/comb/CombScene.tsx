'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CombRenderer } from '@/lib/comb3d';
import { useHive } from '@/lib/store';
import { theme } from '@/themes';
import { fmtSol, fmtNum } from '@/lib/format';
import type { Hive } from '@/lib/types';

interface Props {
  mode?: 'comb' | 'single';
  ca?: string;
  className?: string;
  interactive?: boolean;
  /** Optional filter for the comb page. */
  filter?: (h: Hive) => boolean;
}

export default function CombScene({ mode = 'comb', ca, className = '', interactive = true, filter }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CombRenderer | null>(null);
  const lastEvent = useRef(0);
  const router = useRouter();
  const [hover, setHover] = useState<{ ca: string; x: number; y: number } | null>(null);
  const version = useHive((s) => s.version);
  const modeTheme = useHive((s) => s.mode);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = new CombRenderer(canvas, {
      mode,
      interactive,
      onHover: (hca, x, y) => setHover(hca ? { ca: hca, x, y } : null),
      onSelect: (sca) => router.push(`/hive/${sca}`),
    });
    rendererRef.current = r;
    lastEvent.current = 0;
    const io = new IntersectionObserver(([en]) => r.setVisible(en.isIntersecting), { threshold: 0.01 });
    io.observe(canvas);
    const onVis = () => r.setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      r.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, ca]);

  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    const s = useHive.getState();
    const world = s.world;
    let hives = world.order.map((c) => world.hives[c]);
    if (mode === 'single') hives = hives.filter((h) => h.ca === ca);
    else if (filterRef.current) hives = hives.filter(filterRef.current);
    r.sync(hives, world.biggestCa);
    const evs = world.events.filter((e) => e.id > lastEvent.current);
    if (lastEvent.current === 0) {
      // skip backlog on mount
      lastEvent.current = world.eventSeq;
    } else {
      for (const e of evs) {
        if (mode === 'single' && e.ca !== ca && e.targetCa !== ca) continue;
        r.handleEvent(mode === 'single' && e.type === 'swarm' && e.targetCa === ca ? { ...e, type: 'swarm', ca: ca!, targetCa: ca } : e);
        lastEvent.current = e.id;
      }
      if (evs.length) lastEvent.current = evs[evs.length - 1].id;
    }
  }, [version, mode, ca]);

  useEffect(() => {
    rendererRef.current?.setBackground(modeTheme === 'day' ? theme.palette.dayBase : theme.palette.base, modeTheme === 'day');
  }, [modeTheme, version]);

  const hovered = hover ? useHive.getState().world.hives[hover.ca] : null;
  const lastVerb = hovered ? useHive.getState().world.actions.find((a) => a.ca === hovered.ca) : null;

  return (
    <div className={`relative ${className}`}>
      <canvas ref={canvasRef} className="block h-full w-full" aria-label={`${theme.name} ${theme.scene}`} />
      {hovered && hover && (
        <div
          className="pointer-events-none fixed z-50 shape-card glass px-4 py-3 text-sm"
          style={{ left: hover.x + 16, top: hover.y + 16, minWidth: 200 }}
        >
          <div className="font-heading text-base font-semibold tracking-tight">
            {hovered.name} <span className="text-accent">${hovered.ticker}</span>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 tabular-nums text-text/80">
            <span className="text-text/50">{theme.copy.resource}</span>
            <span>{fmtSol(hovered.honey)}</span>
            <span className="text-text/50">{theme.holderPlural}</span>
            <span>{fmtNum(hovered.bees)}</span>
            <span className="text-text/50">state</span>
            <span className={hovered.state === 'working' ? 'text-accent' : 'text-starving'}>{hovered.state}</span>
            <span className="text-text/50">last</span>
            <span>{lastVerb ? theme.copy.verbLabels[verbKey(lastVerb.verb)] ?? lastVerb.verb.toUpperCase() : '—'}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function verbKey(v: string): 'burn' | 'store' | 'interact' | 'starve' | 'abandon' {
  switch (v) {
    case 'seal':
      return 'burn';
    case 'store':
    case 'jelly':
    case 'born':
      return 'store';
    case 'swarm':
      return 'interact';
    case 'starve':
      return 'starve';
    default:
      return 'abandon';
  }
}
