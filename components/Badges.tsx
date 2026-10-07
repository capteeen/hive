import { theme } from '@/themes';
import type { ActionVerb, HiveState } from '@/lib/types';

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
