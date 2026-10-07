'use client';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useHive, selectHives } from '@/lib/store';
import { theme } from '@/themes';
import { feeGrowth } from '@/lib/sim';
import { fmtNum, fmtSol } from '@/lib/format';
import Avatar from '@/components/Avatar';
import { StateBadge } from '@/components/Badges';
import { pickKey, type CombPick, type Hive, type HiveState } from '@/lib/types';
import type { SafeArea } from '@/lib/comb3d';

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
  const params = useSearchParams();
  const router = useRouter();
  const focusCa = params.get('focus') ?? undefined;
  const [sel, setSel] = useState<CombPick>(focusCa ? { kind: 'hive', ca: focusCa } : null);
  const colRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Partial<SafeArea>>({});

  // a new ?focus= (e.g. after founding) selects that hive
  useEffect(() => {
    if (focusCa) setSel({ kind: 'hive', ca: focusCa });
  }, [focusCa]);

  // start with the list collapsed on phones so the comb is visible
  useEffect(() => {
    if (window.innerWidth < 768) setOpen(false);
  }, []);

  // tell the comb which part of the screen the list covers
  useEffect(() => {
    const measure = () => {
      const col = colRef.current;
      const head = headRef.current;
      if (!col || !head) return;
      if (window.innerWidth >= 768) setArea({ left: Math.round(col.getBoundingClientRect().right + 12), top: 72 });
      else setArea({ top: Math.round(head.getBoundingClientRect().bottom + 8) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (colRef.current) ro.observe(colRef.current);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [open]);

  const onSel = useCallback(
    (p: CombPick) => {
      setSel(p);
      // once the selection moves away from the linked hive, drop ?focus= so a remount doesn't jump back
      if (focusCa && !(p?.kind === 'hive' && p.ca === focusCa)) router.replace('/comb', { scroll: false });
    },
    [focusCa, router],
  );

  const filter = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (h: Hive) => states[h.state] && (!query || h.ca.toLowerCase().includes(query) || h.name.toLowerCase().includes(query) || h.ticker.toLowerCase().includes(query));
  }, [states, q]);

  const list = useMemo(() => {
    const key = sort === 'honey' ? (h: Hive) => h.honey : sort === 'bees' ? (h: Hive) => h.bees : feeGrowth;
    return hives.filter(filter).sort((a, b) => key(b) - key(a));
  }, [hives, filter, sort]);

  const selKey = pickKey(sel);

  return (
    <div className="relative h-[100svh] w-full overflow-hidden">
      <CombScene className="absolute inset-0 h-full w-full" filter={filter} focusCa={focusCa} selection={sel} onSelectionChange={onSel} safeArea={area} />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-night/80 to-transparent" />
      <div ref={colRef} className="absolute left-4 top-24 z-10 flex max-h-[calc(100svh-7rem)] w-[min(380px,calc(100vw-2rem))] flex-col sm:left-6 sm:top-28">
        <div ref={headRef} className="shape-card glass p-4">
          <div className="flex items-center justify-between">
            <h1 className="font-heading text-xl font-semibold tracking-tight">The {theme.scene}</h1>
            <button onClick={() => setOpen(!open)} className="text-xs text-text/60 hover:text-text" aria-expanded={open}>
              {open ? 'hide list' : 'show list'}
            </button>
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search by CA, name or ticker`} className="mt-3 w-full bg-night/60 px-3 py-2 text-sm outline-none ring-1 ring-accent/25 focus:ring-accent/60" />
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(['working', 'starving', 'abandoned'] as HiveState[]).map((s) => (
              <button key={s} onClick={() => setStates({ ...states, [s]: !states[s] })} data-sfx="toggle" aria-pressed={states[s]} className={`shape-btn h-7 text-[11px] font-semibold uppercase tracking-wider ${states[s] ? 'btn-honey' : 'btn-ghost opacity-60'}`}>
                {s}
              </button>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-text/60">
            <span>sort</span>
            {(['honey', 'bees', 'growth'] as Sort[]).map((s) => (
              <button key={s} onClick={() => setSort(s)} aria-pressed={sort === s} className={`${sort === s ? 'text-accent' : 'hover:text-text'}`}>
                {s === 'honey' ? theme.copy.resource : s === 'bees' ? theme.holderPlural : 'fee growth'}
              </button>
            ))}
            <span className="ml-auto tabular-nums">{list.length}</span>
          </div>
        </div>
        {open && (
          <ol className="shape-card glass mt-3 flex-1 overflow-y-auto scroll-thin">
            {list.map((h, i) => {
              const active = selKey === `h:${h.ca}`;
              return (
                <li key={h.ca}>
                  <button
                    onClick={() => {
                      onSel({ kind: 'hive', ca: h.ca });
                      if (window.innerWidth < 768) setOpen(false);
                    }}
                    data-sfx="select"
                    aria-current={active ? 'true' : undefined}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-600 hover:bg-accent/10 ${active ? 'bg-accent/15' : ''}`}
                  >
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
                  </button>
                </li>
              );
            })}
            {!list.length && (
              <li className="px-4 py-6 text-sm text-text/50" data-empty={hives.length ? undefined : 'hives'}>
                {hives.length ? `No ${theme.unitPlural} match.` : `No ${theme.unitPlural} yet. Click the empty cell in the middle to found the first one.`}
              </li>
            )}
          </ol>
        )}
      </div>
      {!sel && (
        <div className="pointer-events-none absolute bottom-6 right-6 hidden text-right text-[11px] uppercase tracking-[0.18em] text-text/40 sm:block">
          Click a cell for details · click an empty <span className="text-accent/70">+</span> cell to found a {theme.unit}
          <br />
          {cap(theme.holderPlural)} capped at 30 per cell · hover for the real count
        </div>
      )}
    </div>
  );
}

