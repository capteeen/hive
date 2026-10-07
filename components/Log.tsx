'use client';
import Link from 'next/link';
import { useNow } from '@/lib/useNow';
import { useHive } from '@/lib/store';
import { theme } from '@/themes';
import { fmtSol, timeAgo, txUrl, short } from '@/lib/format';
import { DryRunTag, SourceBadge, VerbBadge, isDryRun, isOnChain, offChainReason, stripDryRun } from './Badges';
import Avatar from './Avatar';
import type { Action } from '@/lib/types';

export default function Log({ ca, limit = 12, className = '', compact = false }: { ca?: string; limit?: number; className?: string; compact?: boolean }) {
  const actions = useHive((s) => s.world.actions);
  const hives = useHive((s) => s.world.hives);
  const now = useNow(5000);
  const list = (ca ? actions.filter((a) => a.ca === ca || a.targetCa === ca) : actions).slice(0, limit);
  return (
    <ol className={`divide-y divide-accent/10 ${className}`}>
      {list.map((a) => {
        const h = hives[a.ca];
        const t = a.targetCa ? hives[a.targetCa] : undefined;
        if (!h) return null;
        const dry = isDryRun(a.reason);
        // Only live hives have real transactions; demo / preview signatures are made up.
        const realTx = !!a.txSig && !dry && isOnChain(h);
        return (
          <li key={a.id} className="log-in flex items-start gap-3 px-4 py-3">
            {!compact && (
              <Link href={`/hive/${h.ca}`} className="mt-0.5">
                <Avatar hive={h} size={32} />
              </Link>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <VerbBadge verb={a.verb} />
                <Link href={`/hive/${h.ca}`} className="font-heading font-semibold tracking-tight hover:text-accent">
                  {h.name}
                </Link>
                {/* in a hive's own log its badge sits in the page header: only tag other hives */}
                {h.ca !== ca && <SourceBadge hive={h} size="xs" />}
                {t && (
                  <>
                    <span className="text-text/40">→</span>
                    <Link href={`/hive/${t.ca}`} className="font-heading font-semibold tracking-tight text-raid hover:text-soft">
                      {t.name}
                    </Link>
                  </>
                )}
                {dry && <DryRunTag />}
                {a.amount > 0 && <span className="ml-auto tabular-nums text-text/80">{fmtSol(a.amount, 3)}</span>}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-text/60" title={dry ? a.reason : undefined}>
                {stripDryRun(a.reason)}
              </p>
              <div className="mt-1 flex items-center gap-3 text-[11px] text-text/45">
                <span>{now === null ? '…' : timeAgo(a.at, now)}</span>
                {realTx ? (
                  <a href={txUrl(a.txSig!)} target="_blank" rel="noreferrer" className="text-accent/80 hover:text-accent">
                    tx {short(a.txSig!, 4)} ↗
                  </a>
                ) : (
                  a.txSig &&
                  !dry && (
                    <span className="cursor-help text-text/35" title={`Simulated transaction. ${offChainReason(h)}`}>
                      tx {short(a.txSig, 4)}
                    </span>
                  )
                )}
              </div>
            </div>
          </li>
        );
      })}
      {list.length === 0 && <li className="px-4 py-6 text-sm text-text/50">Nothing yet. The {theme.agent} is waiting for her first fees.</li>}
    </ol>
  );
}

export type { Action };
