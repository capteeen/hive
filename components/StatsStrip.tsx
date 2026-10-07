'use client';
import { useNow } from '@/lib/useNow';
import { useHive } from '@/lib/store';
import { theme } from '@/themes';
import { fmtNum, fmtCompact, countdown } from '@/lib/format';
import PourCounter from './PourCounter';

export default function StatsStrip({ className = '' }: { className?: string }) {
  const stats = useHive((s) => s.stats);
  const now = useNow(500);
  const items = [
    { label: theme.copy.stats.units, value: fmtNum(stats.hives) },
    { label: theme.copy.stats.holders, value: fmtNum(stats.bees) },
    { label: theme.copy.stats.stored, value: `${fmtNum(stats.honey, 1)} SOL` },
    { label: theme.copy.stats.burned, value: fmtCompact(stats.burned) },
    { label: theme.copy.stats.next, value: now === null ? '--:--' : countdown(stats.nextHarvestAt - now) },
  ];
  return (
    <div className={`shape-card glass grid grid-cols-2 gap-px overflow-hidden md:grid-cols-5 ${className}`}>
      {items.map((it, i) => (
        <div key={it.label} className={`px-5 py-4 ${i < items.length - 1 ? 'md:border-r md:border-accent/10' : ''}`}>
          <div className="text-[11px] uppercase tracking-[0.18em] text-text/55">{it.label}</div>
          <PourCounter value={it.value} className="mt-1.5 text-2xl font-semibold" />
        </div>
      ))}
    </div>
  );
}
