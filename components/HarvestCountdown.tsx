'use client';
import { useNow } from '@/lib/useNow';
import { useHive } from '@/lib/store';
import { countdown } from '@/lib/format';
import { theme } from '@/themes';
import PourCounter from './PourCounter';

export default function HarvestCountdown({ compact = false, className = '' }: { compact?: boolean; className?: string }) {
  const next = useHive((s) => s.stats.nextHarvestAt);
  const now = useNow(250);
  const left = now === null ? 0 : next - now;
  const hot = now !== null && left < 5000;
  const text = now === null ? '--:--' : countdown(left);
  if (compact) {
    return (
      <div className={`flex shrink-0 items-center gap-2 ${className}`} title={`Next ${theme.hubRitual} (UTC, hourly)`}>
        <span className={`relative inline-block h-2 w-2 shape-hex ${hot ? 'bg-royal' : 'bg-accent'} pulse-ring`} />
        <span className="hidden whitespace-nowrap text-[11px] uppercase tracking-wider text-text/60 sm:inline">{theme.copy.stats.next}</span>
        <PourCounter value={text} className={`text-sm font-semibold ${hot ? 'text-royal' : 'text-accent'}`} />
      </div>
    );
  }
  return (
    <div className={className}>
      <div className="text-[11px] uppercase tracking-[0.18em] text-text/60">{theme.copy.stats.next}</div>
      <PourCounter value={text} className={`mt-1 text-3xl font-semibold ${hot ? 'text-royal' : 'text-accent'}`} />
    </div>
  );
}
