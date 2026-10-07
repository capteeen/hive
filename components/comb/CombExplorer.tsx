'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useHive, selectHives } from '@/lib/store';
import { theme } from '@/themes';
import { feeGrowth } from '@/lib/sim';
import { fmtNum, fmtSol } from '@/lib/format';
import Avatar from '@/components/Avatar';
import { StateBadge } from '@/components/Badges';
import type { Hive, HiveState } from '@/lib/types';

const CombScene = dynamic(() => import('@/components/comb/CombScene'), { ssr: false });

type Sort = 'honey' | 'bees' | 'growth';
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export default function CombExplorer() {
  const hives = useHive(selectHives);
  const biggest = useHive((s) => s.world.biggestCa);
  const [states, setStates] = useState<Record<HiveState, boolean>>({ working: true, starving: true, abandoned: true });
  const [sort, setSort] = useState<Sort>('honey');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(true);

  const filter = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (h: Hive) => states[h.state] && (!query || h.ca.toLowerCase().includes(query) || h.name.toLowerCase().includes(query) || h.ticker.toLowerCase().includes(query));
  }, [states, q]);

  const list = useMemo(() => {
    const key = sort === 'honey' ? (h: Hive) => h.honey : sort === 'bees' ? (h: Hive) => h.bees : feeGrowth;
    return hives.filter(filter).sort((a, b) => key(b) - key(a));
  }, [hives, filter, sort]);

  return (
    <div className="relative h-[100svh] w-full overflow-hidden">
      <CombScene className="absolute inset-0 h-full w-full" filter={filter} />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-night/80 to-transparent" />
      <div className="absolute left-4 top-24 z-10 flex max-h-[calc(100svh-7rem)] w-[min(380px,calc(100vw-2rem))] flex-col sm:left-6 sm:top-28">
        <div className="shape-card glass p-4">
          <div className="flex items-center justify-between">
            <h1 className="font-heading text-xl font-semibold tracking-tight">The {theme.scene}</h1>
            <button onClick={() => setOpen(!open)} className="text-xs text-text/60 hover:text-text">
              {open ? 'hide list' : 'show list'}
            </button>
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search by CA, name or ticker`} className="mt-3 w-full bg-night/60 px-3 py-2 text-sm outline-none ring-1 ring-accent/25 focus:ring-accent/60" />
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(['working', 'starving', 'abandoned'] as HiveState[]).map((s) => (
              <button key={s} onClick={() => setStates({ ...states, [s]: !states[s] })} className={`shape-btn h-7 text-[11px] font-semibold uppercase tracking-wider ${states[s] ? 'btn-honey' : 'btn-ghost opacity-60'}`}>
                {s}
              </button>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-text/60">
            <span>sort</span>
            {(['honey', 'bees', 'growth'] as Sort[]).map((s) => (
              <button key={s} onClick={() => setSort(s)} className={`${sort === s ? 'text-accent' : 'hover:text-text'}`}>
                {s === 'honey' ? theme.copy.resource : s === 'bees' ? theme.holderPlural : 'fee growth'}
              </button>
            ))}
            <span className="ml-auto tabular-nums">{list.length}</span>
          </div>
        </div>
        {open && (
          <ol className="shape-card glass mt-3 flex-1 overflow-y-auto scroll-thin">
            {list.map((h, i) => (
              <li key={h.ca}>
                <Link href={`/hive/${h.ca}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors duration-600 hover:bg-accent/10">
                  <span className="w-5 text-xs tabular-nums text-text/40">{i + 1}</span>
                  <Avatar hive={h} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-heading text-sm font-semibold tracking-tight">{h.name}</span>
                      {h.ca === biggest && <span className="shape-hex inline-block h-2 w-2 bg-royal" />}
                    </div>
                    <div className="text-[11px] tabular-nums text-text/50">
                      {fmtSol(h.honey, 1)} · {fmtNum(h.bees)} {theme.holderPlural}
                    </div>
                  </div>
                  <StateBadge state={h.state} />
                </Link>
              </li>
            ))}
            {!list.length && <li className="px-4 py-6 text-sm text-text/50">No {theme.unitPlural} match.</li>}
          </ol>
        )}
      </div>
      <div className="pointer-events-none absolute bottom-6 right-6 hidden text-[11px] uppercase tracking-[0.18em] text-text/40 sm:block">{cap(theme.holderPlural)} capped at 30 per cell · hover for real count</div>
    </div>
  );
}
