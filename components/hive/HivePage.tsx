'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useNow } from '@/lib/useNow';
import { useHive } from '@/lib/store';
import { fetchHiveDetail } from '@/lib/remote';
import type { HiveDetailResponse } from '@/lib/shared/rows';
import { theme } from '@/themes';
import { fmtNum, fmtSol, short, addrUrl, aliveFor, timeAgo } from '@/lib/format';
import { feeGrowth } from '@/lib/sim';
import { DEFAULT_RULES, rulesSummary } from '@/lib/queen';
import HexButton from '@/components/HexButton';
import HexBar from '@/components/HexBar';
import Avatar from '@/components/Avatar';
import Log from '@/components/Log';
import PriceChart from '@/components/PriceChart';
import { SourceBadge, StateBadge, TradeLink } from '@/components/Badges';
import HarvestCountdown from '@/components/HarvestCountdown';
import PourCounter from '@/components/PourCounter';

const CombScene = dynamic(() => import('@/components/comb/CombScene'), { ssr: false });
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/* ---------- looking up an address the store does not hold ---------- */

/**
 * What the page knows about a CA that is not in the store:
 *   checking    - asking the server (or the store has not started yet)
 *   missing     - the server answered 404: no hive was launched with this address
 *   unreachable - the server did not answer (network, 5xx, timeout, garbled body); retrying
 */
export type HiveLookup = 'checking' | 'missing' | 'unreachable';

export interface HiveLookupDeps {
  /** GET /api/hives/[ca]: null on 404, throws on any other failure (lib/remote.ts fetchHiveDetail). */
  fetchDetail: (ca: string, signal: AbortSignal) => Promise<HiveDetailResponse | null>;
  /** Put the server's copy into the store. Returns whether the store now holds the hive. */
  adopt: (detail: HiveDetailResponse) => boolean;
  onState: (state: HiveLookup) => void;
  /** Per-attempt timeout, so a hung request cannot leave the page "looking" forever. */
  timeoutMs?: number;
  /** Delay before retry number `attempt` (0-based). */
  retryMs?: (attempt: number) => number;
  /**
   * Whether a refusal by the store is final. Until GET /api/config has loaded, the browser's demo hives
   * still sit on cells that a demo-off server hands out to real hives (from the origin outward), so the
   * store refusing a hive then proves nothing. Default: the store has its config.
   */
  configReady?: () => boolean;
  /** Calls `fn` once, when the config has loaded. Returns an unsubscribe. Default: a store subscription. */
  whenConfigReady?: (fn: () => void) => () => void;
}

const storeConfigReady = () => useHive.getState().config !== null;
function whenStoreConfigReady(fn: () => void): () => void {
  if (storeConfigReady()) {
    fn();
    return () => {};
  }
  // setConfig applies the config and drops the demo hives in one update, so `fn` sees both
  const unsubscribe = useHive.subscribe((s) => {
    if (!s.config) return;
    unsubscribe();
    fn();
  });
  return unsubscribe;
}

const LOOKUP_TIMEOUT_MS = 10_000;
const lookupBackoff = (attempt: number) => Math.round(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) * (0.8 + Math.random() * 0.4));

/** The detail body is only trusted when it describes this exact CA in a shape applyRemote can place. */
function isDetailFor(ca: string, d: HiveDetailResponse): boolean {
  const h = d?.hive;
  return !!h && h.ca === ca && Number.isInteger(h.cell?.q) && Number.isInteger(h.cell?.r) && Number.isFinite(h.updatedAt) && Array.isArray(d.actions);
}

/**
 * Decide whether `ca` exists by asking the server directly, instead of waiting for the comb's list
 * sync. The realtime feed turning 'live' says nothing about whether GET /api/hives has arrived (it
 * can be slow on a cold start, or 500 and back off for up to 30s), so neither feed status nor a timer
 * can prove a hive does not exist: only a 404 from /api/hives/[ca] does. When the server knows the
 * hive it is adopted into the store right away, so a shared link opens without waiting for the list.
 * Returns a stop function (aborts the request in flight and any pending retry).
 */
export function watchHiveLookup(ca: string, deps: HiveLookupDeps): () => void {
  const timeoutMs = deps.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const retryMs = deps.retryMs ?? lookupBackoff;
  const configReady = deps.configReady ?? storeConfigReady;
  const whenConfigReady = deps.whenConfigReady ?? whenStoreConfigReady;
  let stopped = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let inflight: AbortController | null = null;
  let waiting: (() => void) | null = null;

  /** The store would not place the hive: final once the config is in, otherwise ask again when it is. */
  const refused = (detail: HiveDetailResponse) => {
    if (configReady()) return deps.onState('missing');
    waiting = whenConfigReady(() => {
      waiting = null;
      if (stopped) return;
      if (!deps.adopt(detail)) deps.onState('missing');
    });
  };

  const once = async () => {
    retry = null;
    if (stopped) return;
    const ac = new AbortController();
    inflight = ac;
    const killer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const detail = await deps.fetchDetail(ca, ac.signal);
      if (stopped) return;
      if (detail === null) {
        deps.onState('missing');
        return;
      }
      if (!isDetailFor(ca, detail)) throw new Error('unexpected hive detail');
      // Adopted: the page re-renders with the hive and stops this watcher. Not adopted means the
      // store refused it (its cell is taken by a demo hive), so it cannot be shown on the comb either,
      // unless the config that may remove the demo hives has not arrived yet.
      if (!deps.adopt(detail)) refused(detail);
    } catch {
      if (stopped) return;
      deps.onState('unreachable');
      retry = setTimeout(() => void once(), retryMs(attempt++));
    } finally {
      clearTimeout(killer);
      if (inflight === ac) inflight = null;
    }
  };

  deps.onState('checking');
  void once();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    retry = null;
    inflight?.abort();
    inflight = null;
    waiting?.();
    waiting = null;
  };
}

/** Store-side adoption of a hive the server knows: the hive plus its own recent actions, as catch-up (no animations). */
export function adoptIntoStore(ca: string, detail: HiveDetailResponse): boolean {
  const s = useHive.getState();
  if (!s.world.hives[ca]) {
    const actions = detail.actions.filter((a) => !!a && a.ca === ca && typeof a.id === 'string' && Number.isFinite(a.at));
    s.applyRemote({ hives: [detail.hive], actions }, { initial: true });
  }
  return !!useHive.getState().world.hives[ca];
}

function Copy({ value }: { value: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }}
      className="shape-btn btn-ghost inline-flex h-7 items-center text-[11px] font-mono"
      title="Copy"
    >
      {short(value, 5)} {ok ? '✓' : '⧉'}
    </button>
  );
}

export default function HivePage({ ca }: { ca: string }) {
  const hive = useHive((s) => s.world.hives[ca]);
  const biggest = useHive((s) => s.world.biggestCa);
  const actions = useHive((s) => s.world.actions);
  const hives = useHive((s) => s.world.hives);
  const now = useNow(5000);
  const maxHoney = useHive((s) => Math.max(1, ...s.world.order.map((c) => s.world.hives[c].honey)));
  const started = useHive((s) => s.started);
  const present = !!hive;
  // Hives launched by other users are not in the store until the comb's list sync lands, which can
  // take a while (or fail and back off). Ask the server about this one address instead: only its 404
  // proves the hive does not exist. Waits for start(), which re-seeds the world and would drop an
  // adopted hive. Keyed by CA so a stale answer for the previous address never shows.
  const [lookup, setLookup] = useState<{ ca: string; state: HiveLookup }>({ ca, state: 'checking' });
  useEffect(() => {
    if (present || !started) return;
    return watchHiveLookup(ca, {
      fetchDetail: fetchHiveDetail,
      adopt: (detail) => adoptIntoStore(ca, detail),
      onState: (state) => setLookup({ ca, state }),
    });
  }, [ca, started, present]);

  if (!hive) {
    const state: HiveLookup = started && lookup.ca === ca ? lookup.state : 'checking';
    const done = state !== 'checking';
    return (
      <div className="mx-auto max-w-[1400px] px-4 pt-32 sm:px-6">
        <h1 className="font-heading text-3xl font-semibold">
          {state === 'missing' ? `No ${theme.unit} at this address.` : state === 'unreachable' ? `Still looking for this ${theme.unit}…` : `Looking for this ${theme.unit}…`}
        </h1>
        <p className="mt-2 text-text/60" aria-live="polite">
          {state === 'missing'
            ? `Nothing on the ${theme.scene} has this address. It may be a coin that was not launched through ${theme.name}.`
            : state === 'unreachable'
              ? `The server did not answer, so ${theme.unitPlural} launched by other people cannot be checked yet. Trying again…`
              : `Checking the ${theme.scene} for ${short(ca, 5)}.`}
        </p>
        {done && (
          <HexButton href="/comb" className="mt-6">
            Back to the {theme.scene}
          </HexButton>
        )}
      </div>
    );
  }
  const isBig = hive.ca === biggest;
  const swarmsOut = actions.filter((a) => a.verb === 'swarm' && a.ca === ca);
  const swarmsIn = actions.filter((a) => a.verb === 'swarm' && a.targetCa === ca);
  const growth = feeGrowth(hive);

  return (
    <div className="mx-auto max-w-[1400px] px-4 pt-24 sm:px-6 sm:pt-28">
      <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr]">
        <div className="shape-card glass relative aspect-square max-h-[560px] w-full overflow-hidden">
          <CombScene mode="single" ca={ca} className="absolute inset-0 h-full w-full" interactive={false} />
          <div className="pointer-events-none absolute left-5 top-5 flex items-center gap-2">
            <StateBadge state={hive.state} />
            {isBig && <span className="shape-btn inline-flex h-6 items-center bg-royal/20 text-[11px] font-semibold uppercase tracking-wider text-royal">biggest {theme.unit}</span>}
          </div>
          <div className="pointer-events-none absolute bottom-5 left-5 right-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-text/55">{theme.copy.resource}</div>
            <HexBar value={hive.honey / maxHoney} cells={16} className="mt-2" />
          </div>
        </div>
        <div>
          <div className="flex items-center gap-4">
            <Avatar hive={hive} size={64} />
            <div className="min-w-0">
              <h1 className="truncate font-heading text-4xl font-semibold tracking-tight sm:text-5xl">{hive.name}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-text/60">
                <span className="text-accent">${hive.ticker}</span>
                <SourceBadge hive={hive} size="sm" />
                <span>alive {now === null ? '…' : aliveFor(hive.bornAt, now)}</span>
                <span>last fee {now === null ? '…' : timeAgo(hive.lastFeeAt, now)}</span>
              </div>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-text/50">CA</span>
            <Copy value={hive.ca} />
            <span className="ml-2 text-text/50">{theme.agent} wallet</span>
            <a href={addrUrl(hive.queenWallet)} target="_blank" rel="noreferrer" className="shape-btn btn-ghost inline-flex h-7 items-center font-mono text-[11px]">
              {short(hive.queenWallet, 5)} ↗
            </a>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label={theme.copy.resource} value={fmtSol(hive.honey, 2)} />
            <Stat label={theme.holderPlural} value={fmtNum(hive.bees)} />
            <Stat label="fees / hour" value={`${hive.feesHour.toFixed(3)} SOL`} sub={`${growth >= 0 ? '+' : ''}${(growth * 100).toFixed(0)}% vs last hour`} />
            <Stat label={`${theme.verbs.interact}s in / out`} value={`${hive.swarmsIn} / ${hive.swarmsOut}`} sub={`${hive.swarmsWon} won`} />
            <Stat label={`${theme.copy.reward} received`} value={fmtSol(hive.royalJelly, 2)} />
            <Stat label="sealed supply" value={`${(hive.sealed * 100).toFixed(1)}%`} sub={`total fees ${fmtSol(hive.feesTotal, 1)}`} />
          </div>
          <QueenRulesCard hive={hive} />
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {/* demo and preview CAs are not real coins: TradeLink renders a muted stand-in for them */}
            <TradeLink hive={hive}>Trade on pump.fun ↗</TradeLink>
            <HexButton variant="ghost" href="/comb">
              Find on the {theme.scene}
            </HexButton>
            <HarvestCountdown compact className="ml-auto" />
          </div>
        </div>
      </div>

      <div className="mt-12 grid gap-8 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <div className="mb-3 flex items-end justify-between">
            <h2 className="font-heading text-2xl font-semibold tracking-tight">Price</h2>
            <div className="text-xs text-text/50">
              markers: {theme.copy.verbLabels.burn} · {theme.copy.verbLabels.interact} · {theme.copy.reward}
            </div>
          </div>
          <div className="shape-card glass p-3">
            <PriceChart ca={ca} className="h-[320px]" />
          </div>
          <div className="mt-8 grid gap-6 sm:grid-cols-2">
            <SwarmList title={`${cap(theme.verbs.interact)}s in`} list={swarmsIn.map((a) => ({ id: a.id, ca: a.ca, amount: a.amount, at: a.at }))} hives={hives} tone="in" now={now} />
            <SwarmList title={`${cap(theme.verbs.interact)}s out`} list={swarmsOut.map((a) => ({ id: a.id, ca: a.targetCa!, amount: a.amount, at: a.at }))} hives={hives} tone="out" now={now} />
          </div>
        </div>
        <div>
          <h2 className="mb-3 font-heading text-2xl font-semibold tracking-tight">{cap(theme.agent)} log</h2>
          <div className="shape-card glass max-h-[720px] overflow-y-auto scroll-thin">
            <Log ca={ca} limit={40} compact />
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="shape-card glass px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.16em] text-text/50">{label}</div>
      <PourCounter value={value} className="mt-1 text-lg font-semibold" />
      {sub && <div className="mt-0.5 text-[11px] text-text/50">{sub}</div>}
    </div>
  );
}

function SwarmList({ title, list, hives, tone, now }: { title: string; list: { id: string; ca: string; amount: number; at: number }[]; hives: Record<string, { name: string; ticker: string; image: string; state: 'working' | 'starving' | 'abandoned'; ca: string }>; tone: 'in' | 'out'; now: number | null }) {
  return (
    <div className="shape-card glass p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-heading font-semibold tracking-tight">{title}</h3>
        <span className={`text-sm tabular-nums ${tone === 'in' ? 'text-raid' : 'text-accent'}`}>{list.length}</span>
      </div>
      <ul className="mt-3 divide-y divide-accent/10">
        {list.slice(0, 6).map((s) => {
          const h = hives[s.ca];
          if (!h) return null;
          return (
            <li key={s.id} className="flex items-center gap-3 py-2 text-sm">
              <Avatar hive={h} size={24} />
              <Link href={`/hive/${h.ca}`} className="flex-1 truncate font-heading font-semibold tracking-tight hover:text-accent">
                {h.name}
              </Link>
              <span className="tabular-nums text-text/70">{fmtSol(s.amount, 2)}</span>
              <span className="text-xs text-text/40">{now === null ? '…' : timeAgo(s.at, now)}</span>
            </li>
          );
        })}
        {!list.length && <li className="py-3 text-xs text-text/50">None yet.</li>}
      </ul>
    </div>
  );
}

function QueenRulesCard({ hive }: { hive: { rules?: import('@/lib/queen').QueenRules; temperament?: { dip: string; swarm: string }; motto?: string; description?: string } }) {
  const r = hive.rules ?? DEFAULT_RULES;
  const s = rulesSummary(r);
  return (
    <div className="shape-card glass mt-3 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-[0.16em] text-text/50">
          her rules {hive.temperament ? `· ${hive.temperament.dip} · ${hive.temperament.swarm}` : '· protocol defaults'}
        </div>
        {hive.motto && <div className="text-xs italic text-text/60">&ldquo;{hive.motto}&rdquo;</div>}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
        <RuleStat k={`${cap(theme.verbs.burn)}s`} v={s.seal} />
        <RuleStat k={`${cap(theme.verbs.interact)}s`} v={s.swarm} />
        <RuleStat k={`${cap(theme.verbs.interact)} size`} v={s.size} />
        <RuleStat k="Cooldown" v={s.cooldown} />
      </div>
      {hive.description && <p className="mt-2 text-xs leading-relaxed text-text/60">{hive.description}</p>}
    </div>
  );
}

function RuleStat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[11px] text-text/50">{k}</div>
      <div className="font-heading text-sm font-semibold text-accent">{v}</div>
    </div>
  );
}
