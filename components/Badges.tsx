import { theme } from '@/themes';
import { pumpUrl } from '@/lib/format';
import HexButton from './HexButton';
import type { ActionVerb, Hive, HiveState } from '@/lib/types';

export function StateBadge({ state }: { state: HiveState }) {
  const cls = state === 'working' ? 'bg-accent/15 text-accent' : state === 'starving' ? 'bg-starving/20 text-starving' : 'bg-starving/10 text-starving/70';
  return <span className={`shape-btn inline-flex h-6 items-center text-[11px] font-semibold uppercase tracking-wider ${cls}`}>{state}</span>;
}

export function verbLabel(v: ActionVerb) {
  const L = theme.copy.verbLabels;
  switch (v) {
    case 'seal':
      return L.burn;
    case 'store':
      return L.store;
    case 'swarm':
      return L.interact;
    case 'starve':
      return L.starve;
    case 'abandon':
      return L.abandon;
    case 'jelly':
      return theme.copy.reward.toUpperCase();
    case 'born':
      return 'BORN';
  }
}

export function VerbBadge({ verb }: { verb: ActionVerb }) {
  const cls =
    verb === 'swarm'
      ? 'bg-raid/15 text-raid'
      : verb === 'seal'
        ? 'bg-soft/15 text-soft'
        : verb === 'store' || verb === 'born'
          ? 'bg-accent/15 text-accent'
          : verb === 'jelly'
            ? 'bg-royal/20 text-royal'
            : 'bg-starving/20 text-starving';
  return <span className={`shape-btn inline-flex h-6 min-w-[68px] items-center justify-center text-[11px] font-semibold uppercase tracking-wider ${cls}`}>{verbLabel(verb)}</span>;
}

/* ---------- where a hive comes from ---------- */

/**
 * - 'demo':    simulated in this browser (lib/sim.ts). Its CA is made up.
 * - 'preview': stored server-side but founded in mock launch mode. Nothing on-chain; its CA is not a coin.
 * - 'live':    a real pump.fun coin launched by its queen.
 */
export type HiveSource = 'demo' | 'preview' | 'live';

export function hiveSource(h: Pick<Hive, 'source' | 'status'>): HiveSource {
  if (h.source !== 'remote') return 'demo';
  return h.status === 'live' ? 'live' : 'preview';
}

/** Only live hives have a real coin behind their CA (and real transactions behind their log). */
export const isOnChain = (h: Pick<Hive, 'source' | 'status'>) => hiveSource(h) === 'live';

const SOURCE: Record<HiveSource, { label: string; title: string; cls: string }> = {
  demo: {
    label: 'Demo',
    title: `Demo ${theme.unit}: simulated in your browser. Not a real coin.`,
    cls: 'bg-text/10 text-text/60',
  },
  preview: {
    label: 'Preview',
    title: `Preview ${theme.unit}: launched in preview mode. Nothing was sent on-chain; its address is not a real coin.`,
    cls: 'bg-soft/15 text-soft',
  },
  live: {
    label: 'Live',
    title: `Live ${theme.unit}: a real coin on pump.fun. Its ${theme.agent} acts on-chain.`,
    cls: 'bg-accent/20 text-accent',
  },
};

/** Why the trade / tx links of a non-live hive are switched off (tooltip + screen-reader text). */
export function offChainReason(h: Pick<Hive, 'source' | 'status'>) {
  return SOURCE[hiveSource(h)].title;
}

/**
 * Demo / Preview / Live chip.
 * size 'md' matches StateBadge, 'sm' fits cards, 'xs' is a flat tag for dense rows (the log).
 */
export function SourceBadge({ hive, size = 'md', className = '' }: { hive: Pick<Hive, 'source' | 'status'>; size?: 'xs' | 'sm' | 'md'; className?: string }) {
  const src = hiveSource(hive);
  const s = SOURCE[src];
  if (size === 'xs') {
    return (
      <span title={s.title} className={`inline-flex h-4 shrink-0 items-center rounded-[4px] px-1.5 text-[9px] font-semibold uppercase tracking-wider ${s.cls} ${className}`}>
        {s.label}
      </span>
    );
  }
  // 'sm' trims the hex pill's chamfer and side padding so it fits next to a ticker
  const sm = size === 'sm';
  return (
    <span
      title={s.title}
      style={sm ? ({ '--chamfer': '7px' } as React.CSSProperties) : undefined}
      className={`shape-btn inline-flex shrink-0 items-center gap-1.5 font-semibold uppercase tracking-wider ${sm ? 'h-5 !px-[15px] text-[10px]' : 'h-6 text-[11px]'} ${s.cls} ${className}`}
    >
      {src === 'live' && <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
      {s.label}
    </span>
  );
}

/** A subtle tag for engine actions that were only planned (dry run): nothing was sent. */
export function DryRunTag() {
  return (
    <span title="Dry run: the engine planned this action but sent nothing on-chain." className="inline-flex h-4 shrink-0 items-center rounded-[4px] bg-text/5 px-1.5 text-[9px] font-semibold uppercase tracking-wider text-text/45 ring-1 ring-inset ring-text/10">
      dry run
    </span>
  );
}

/** Reasons for dry-run actions arrive prefixed with "[dry run]" (lib/remoteMap.ts). */
export const DRY_RUN_PREFIX = '[dry run]';
export const isDryRun = (reason: string) => reason.startsWith(DRY_RUN_PREFIX);
export const stripDryRun = (reason: string) => (isDryRun(reason) ? reason.slice(DRY_RUN_PREFIX.length).trimStart() : reason);

const tradeSizes = { sm: 'h-9 text-sm', md: 'h-11 text-sm', lg: 'h-13 text-base' };

/**
 * "Trade on pump.fun" for a hive. Live hives get the real link; demo and preview hives get a muted,
 * non-interactive stand-in with a tooltip, because their CAs are not real coins.
 */
export function TradeLink({
  hive,
  size = 'md',
  variant = 'honey',
  className = '',
  children,
}: {
  hive: Pick<Hive, 'ca' | 'source' | 'status'>;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'honey' | 'ghost';
  className?: string;
  children: React.ReactNode;
}) {
  if (isOnChain(hive)) {
    return (
      <HexButton size={size} variant={variant} href={pumpUrl(hive.ca)} target="_blank" rel="noreferrer" className={className}>
        {children}
      </HexButton>
    );
  }
  const why = offChainReason(hive);
  return (
    <span
      title={why}
      aria-disabled="true"
      className={`shape-btn inline-flex cursor-not-allowed select-none items-center justify-center gap-2 whitespace-nowrap bg-text/5 font-heading font-semibold tracking-tight text-text/35 shadow-[inset_0_0_0_1px_rgb(var(--c-text)/0.1)] ${tradeSizes[size]} ${className}`}
    >
      <span aria-hidden>{children}</span>
      <span className="sr-only">Trading unavailable. {why}</span>
    </span>
  );
}
