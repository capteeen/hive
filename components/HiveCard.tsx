'use client';
import Link from 'next/link';
import type { Hive } from '@/lib/types';
import { theme } from '@/themes';
import { fmtNum, fmtSol } from '@/lib/format';
import { feeGrowth } from '@/lib/sim';
import Avatar from './Avatar';
import HexBar from './HexBar';
import { StateBadge } from './Badges';

export default function HiveCard({ hive, maxHoney, biggest }: { hive: Hive; maxHoney: number; biggest: boolean }) {
  const g = feeGrowth(hive);
  return (
    <Link
      href={`/hive/${hive.ca}`}
      className={`shape-card glass group block p-5 transition-all duration-600 hover:-translate-y-1 hover:shadow-lift ${biggest ? 'ring-1 ring-royal/60' : ''} ${hive.state !== 'working' ? 'opacity-70' : ''}`}
    >
      <div className="flex items-center gap-3">
        <Avatar hive={hive} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-heading text-base font-semibold tracking-tight">{hive.name}</span>
            {biggest && <span className="shape-btn inline-flex h-5 items-center bg-royal/20 text-[10px] font-semibold uppercase tracking-wider text-royal">biggest</span>}
          </div>
          <div className="text-xs text-text/55">${hive.ticker}</div>
        </div>
        <StateBadge state={hive.state} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3 text-sm tabular-nums">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-text/50">{theme.copy.resource}</div>
          <div className="mt-0.5 font-heading font-semibold">{fmtSol(hive.honey, 1)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-text/50">{theme.holderPlural}</div>
          <div className="mt-0.5 font-heading font-semibold">{fmtNum(hive.bees)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-text/50">fees/h</div>
          <div className={`mt-0.5 font-heading font-semibold ${g > 0 ? 'text-accent' : g < 0 ? 'text-raid' : ''}`}>
            {g > 0 ? '+' : ''}
            {(g * 100).toFixed(0)}%
          </div>
        </div>
      </div>
      <HexBar value={hive.honey / maxHoney} className="mt-4" />
    </Link>
  );
}
