'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useNow } from '@/lib/useNow';
import { useHive, selectHives } from '@/lib/store';
import { theme } from '@/themes';
import { fmtNum, fmtSol, aliveFor } from '@/lib/format';
import Avatar from './Avatar';
import { StateBadge } from './Badges';
import type { Hive } from '@/lib/types';

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export const TABS = [
  { id: 'honey', label: `Most ${theme.copy.resource}`, key: (h: Hive) => h.honey, fmt: (h: Hive, _now: number | null) => fmtSol(h.honey, 2) },
  { id: 'bees', label: `Most ${theme.holderPlural}`, key: (h: Hive) => h.bees, fmt: (h: Hive, _now: number | null) => fmtNum(h.bees) },
  { id: 'swarms', label: `Most ${theme.verbs.interact}s won`, key: (h: Hive) => h.swarmsWon, fmt: (h: Hive, _now: number | null) => fmtNum(h.swarmsWon) },
  { id: 'jelly', label: `Most ${theme.copy.reward} received`, key: (h: Hive) => h.royalJelly, fmt: (h: Hive, _now: number | null) => fmtSol(h.royalJelly, 2) },
  { id: 'alive', label: 'Longest alive', key: (h: Hive) => -h.bornAt, fmt: (h: Hive, now: number | null) => (now === null ? '…' : aliveFor(h.bornAt, now)) },
] as const;

export type TabId = (typeof TABS)[number]['id'];

export default function LeaderboardTable({ tab: fixed, limit = 50, showTabs = true }: { tab?: TabId; limit?: number; showTabs?: boolean }) {
  const [tab, setTab] = useState<TabId>(fixed ?? 'honey');
  const now = useNow(10000);
  const hives = useHive(selectHives);
  const biggest = useHive((s) => s.world.biggestCa);
  const t = TABS.find((x) => x.id === (fixed ?? tab))!;
  const rows = [...hives].sort((a, b) => t.key(b) - t.key(a)).slice(0, limit);
  return (
    <div>
      {showTabs && (
        <div className="mb-4 flex flex-wrap gap-2">
          {TABS.map((x) => (
            <button key={x.id} onClick={() => setTab(x.id)} className={`shape-btn h-9 text-xs font-semibold ${tab === x.id ? 'btn-honey' : 'btn-ghost'}`}>
              {cap(x.label)}
            </button>
          ))}
        </div>
      )}
      <div className="shape-card glass overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase tracking-wider text-text/50">
            <tr className="border-b border-accent/10">
              <th className="px-4 py-3 text-left font-medium">#</th>
              <th className="px-4 py-3 text-left font-medium">{cap(theme.unit)}</th>
              <th className="hidden px-4 py-3 text-left font-medium sm:table-cell">State</th>
              <th className="px-4 py-3 text-right font-medium">{cap(t.label.replace(/^most /i, ''))}</th>
              {t.id !== 'honey' && <th className="hidden px-4 py-3 text-right font-medium md:table-cell">{theme.copy.resource}</th>}
              <th className="hidden px-4 py-3 text-right font-medium md:table-cell">{theme.holderPlural}</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((h, i) => (
              <tr key={h.ca} className="border-b border-accent/5 transition-colors duration-600 hover:bg-accent/5">
                <td className="px-4 py-3 text-text/50">{i + 1}</td>
                <td className="px-4 py-3">
                  <Link href={`/hive/${h.ca}`} className="flex items-center gap-3">
                    <Avatar hive={h} size={32} />
                    <span className="font-heading font-semibold tracking-tight">{h.name}</span>
                    <span className="text-xs text-text/50">${h.ticker}</span>
                    {h.ca === biggest && <span className="shape-hex inline-block h-2.5 w-2.5 bg-royal" title="biggest" />}
                  </Link>
                </td>
                <td className="hidden px-4 py-3 sm:table-cell">
                  <StateBadge state={h.state} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right font-heading font-semibold">{t.fmt(h, now)}</td>
                {t.id !== 'honey' && <td className="hidden whitespace-nowrap px-4 py-3 text-right text-text/70 md:table-cell">{fmtSol(h.honey, 1)}</td>}
                <td className="hidden px-4 py-3 text-right text-text/70 md:table-cell">{fmtNum(h.bees)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
