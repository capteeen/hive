'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useHive } from '@/lib/store';
import { useUI } from '@/lib/ui';
import { theme } from '@/themes';
import { axialToXY, cellKey, hexDistance, neighbors } from '@/lib/hex';
import { feeGrowth, isFoundable, LAUNCH_COST, QUEEN_RESERVE } from '@/lib/sim';
import { fmtNum, fmtSol, pumpUrl, short, timeAgo } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import Avatar, { avatarBg } from '@/components/Avatar';
import HexButton from '@/components/HexButton';
import { StateBadge, VerbBadge } from '@/components/Badges';
import type { Cell, CombPick, Hive } from '@/lib/types';

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const DIRS = neighbors({ q: 0, r: 0 });

/**
 * The in-place panel for whatever is selected on the comb: a hive's live stats, last
 * actions and neighbours, or an empty cell with "Found a hive here".
 */
export default function CellPanel({ pick, onClose, onPick, wide }: { pick: Exclude<CombPick, null>; onClose: () => void; onPick: (p: CombPick) => void; wide: boolean }) {
  const world = useHive((s) => s.world);
  const version = useHive((s) => s.version);
  const mine = useHive((s) => s.mine);
  const openLaunch = useUI((s) => s.openLaunch);
  const now = useNow(5000);
  const [copied, setCopied] = useState(false);

  // cell → hive, rebuilt when the world changes
  const occ = useMemo(() => {
    const m = new Map<string, Hive>();
    for (const ca of world.order) m.set(cellKey(world.hives[ca].cell), world.hives[ca]);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, version]);

  const hive = pick.kind === 'hive' ? world.hives[pick.ca] : undefined;
  const cell: Cell | undefined = pick.kind === 'hive' ? hive?.cell : { q: pick.q, r: pick.r };
  if (!cell) return null;
  const ring = hexDistance(cell, { q: 0, r: 0 });
  const around = DIRS.map((d) => ({ q: cell.q + d.q, r: cell.r + d.r }));
  const nHives = around.map((c) => occ.get(cellKey(c))).filter(Boolean) as Hive[];
  const foundable = pick.kind === 'empty' && isFoundable(world, cell);

  const shell = `shape-card glass fade-up z-20 overflow-y-auto scroll-thin p-5 ${wide ? 'absolute bottom-6 right-6 max-h-[calc(100%-8rem)] w-[380px]' : 'absolute inset-x-3 bottom-3 max-h-[62%]'}`;

  const flower = (
    <div className="relative mx-auto shrink-0" style={{ width: 132, height: 124 }} aria-label="Neighbours">
      {[{ q: 0, r: 0 }, ...DIRS].map((d, i) => {
        const [x, y] = axialToXY(d, 23);
        const c = { q: cell.q + d.q, r: cell.r + d.r };
        const h = occ.get(cellKey(c));
        const isCenter = i === 0;
        const style = { left: 66 + x - 19, top: 62 + y - 22, width: 38, height: 44 } as const;
        if (isCenter) {
          return (
            <div key="c" className="shape-hex absolute flex items-center justify-center text-[10px] font-semibold" style={{ ...style, background: hive ? avatarBg(hive) : 'rgb(var(--c-accent) / 0.35)', color: 'rgb(var(--c-base))' }}>
              {hive ? hive.ticker.slice(0, 3) : 'you'}
            </div>
          );
        }
        if (h) {
          return (
            <button key={i} onClick={() => onPick({ kind: 'hive', ca: h.ca })} title={`${h.name} · ${fmtSol(h.honey, 1)}`} data-sfx="select" className="shape-hex absolute flex items-center justify-center text-[9px] font-semibold opacity-90 transition-transform duration-600 hover:scale-110" style={{ ...style, background: avatarBg(h), color: 'rgb(var(--c-base))' }}>
              {h.ticker.slice(0, 3)}
            </button>
          );
        }
        const free = isFoundable(world, c);
        return (
          <button
            key={i}
            disabled={!free}
            onClick={() => onPick({ kind: 'empty', q: c.q, r: c.r })}
            title={free ? 'Free cell' : 'Not on the edge yet'}
            data-sfx="empty"
            className={`shape-hex absolute flex items-center justify-center text-sm transition-transform duration-600 ${free ? 'bg-accent/15 text-accent hover:scale-110 hover:bg-accent/30' : 'bg-text/5 text-text/20'}`}
            style={style}
          >
            +
          </button>
        );
      })}
    </div>
  );

  const header = (icon: React.ReactNode, title: React.ReactNode, sub: React.ReactNode) => (
    <div className="flex items-start gap-3">
      {icon}
      <div className="min-w-0 flex-1">
        {title}
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text/55">{sub}</div>
      </div>
      <button onClick={onClose} data-sfx="close" className="shape-hex flex h-8 w-8 shrink-0 items-center justify-center bg-accent/10 text-text/70 hover:bg-accent/20" aria-label="Close">
        ×
      </button>
    </div>
  );

  if (pick.kind === 'empty') {
    return (
      <section key={`e${cell.q},${cell.r}`} className={shell} aria-label="Empty cell">
        {header(
          <div className="shape-hex flex h-11 w-11 shrink-0 items-center justify-center bg-accent/20 text-xl font-semibold text-accent">+</div>,
          <div className="font-heading text-lg font-semibold tracking-tight">Free cell</div>,
          <>
            <span>ring {ring}</span>
            <span>·</span>
            <span>
              cell {cell.q}, {cell.r}
            </span>
          </>,
        )}
        <div className="mt-4 flex items-center gap-4">
          {flower}
          <p className="text-sm leading-relaxed text-text/70">
            {foundable ? (
              <>
                Found a {theme.unit} here and your coin moves into this cell.{' '}
                {nHives.length ? (
                  <>
                    Your {theme.agent}&rsquo;s neighbours: <span className="text-text">{nHives.slice(0, 3).map((h) => h.name).join(', ')}</span>
                    {nHives.length > 3 ? ` +${nHives.length - 3}` : ''}.
                  </>
                ) : null}
              </>
            ) : (
              <>This cell is not on the edge of the {theme.scene} yet. Pick a cell next to a {theme.unit}.</>
            )}
          </p>
        </div>
        <p className="mt-3 text-xs text-text/50">{cap(theme.verbs.interact)}s target neighbours, so where you settle matters. Launch from {fmtSol(LAUNCH_COST + QUEEN_RESERVE, 3)}.</p>
        <div className="mt-4 flex gap-2">
          <HexButton size="sm" disabled={!foundable} className={foundable ? '' : 'opacity-50'} onClick={() => openLaunch(cell)} data-sfx="open">
            Found a {theme.unit} here
          </HexButton>
          <HexButton size="sm" variant="ghost" onClick={onClose} data-sfx="close">
            Cancel
          </HexButton>
        </div>
      </section>
    );
  }

  if (!hive) return null;
  const g = feeGrowth(hive);
  const isMine = mine.includes(hive.ca);
  const fresh = isMine && now !== null && now - hive.bornAt < 120000;
  const recent = world.actions.filter((a) => a.ca === hive.ca || a.targetCa === hive.ca).slice(0, 3);
  return (
    <section key={hive.ca} className={shell} aria-label={`${hive.name} details`}>
      {header(
        <Avatar hive={hive} size={46} />,
        <div className="truncate font-heading text-lg font-semibold tracking-tight">
          {hive.name} <span className="text-accent">${hive.ticker}</span>
        </div>,
        <>
          <StateBadge state={hive.state} />
          {hive.ca === world.biggestCa && <span className="shape-btn inline-flex h-6 items-center bg-royal/20 text-[10px] font-semibold uppercase tracking-wider text-royal">biggest</span>}
          {isMine && <span className="shape-btn inline-flex h-6 items-center bg-accent/20 text-[10px] font-semibold uppercase tracking-wider text-accent">{fresh ? 'yours · just founded' : 'yours'}</span>}
        </>,
      )}
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm tabular-nums">
        <Stat label={theme.copy.resource} value={fmtSol(hive.honey, 2)} />
        <Stat label={theme.holderPlural} value={fmtNum(hive.bees)} />
        <Stat label="fees / hour" value={`${hive.feesHour.toFixed(3)} SOL`} sub={`${g >= 0 ? '+' : ''}${(g * 100).toFixed(0)}% vs last hour`} subTone={g >= 0 ? 'text-accent' : 'text-raid'} />
        <Stat label={`${theme.verbs.interact}s in / out`} value={`${hive.swarmsIn} / ${hive.swarmsOut}`} sub={`${hive.swarmsWon} won`} />
      </div>
      <div className="mt-4 flex items-center gap-4 border-t border-accent/10 pt-4">
        {flower}
        <div className="text-xs leading-relaxed text-text/60">
          <div className="text-[10px] uppercase tracking-[0.16em] text-text/45">neighbours</div>
          <div className="mt-1">
            {nHives.length} {nHives.length === 1 ? theme.unit : theme.unitPlural}, {6 - nHives.length} free.
          </div>
          <div className="mt-1">Click a neighbour to jump to it, or a + to found next door.</div>
        </div>
      </div>
      {recent.length > 0 && (
        <ul className="mt-3 space-y-2 border-t border-accent/10 pt-3">
          {recent.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-xs">
              <VerbBadge verb={a.verb} />
              <span className="min-w-0 flex-1 truncate text-text/65" title={a.reason}>
                {a.targetCa === hive.ca && a.ca !== hive.ca ? `by ${world.hives[a.ca]?.ticker ?? short(a.ca)}` : a.reason}
              </span>
              <span className="shrink-0 text-text/40">{now === null ? '…' : timeAgo(a.at, now)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <HexButton size="sm" href={`/hive/${hive.ca}`}>
          Open {theme.unit}
        </HexButton>
        <HexButton size="sm" variant="ghost" href={pumpUrl(hive.ca)} target="_blank" rel="noreferrer">
          Trade ↗
        </HexButton>
        <HexButton
          size="sm"
          variant="ghost"
          onClick={() => {
            navigator.clipboard?.writeText(hive.ca);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? 'Copied ✓' : 'Copy CA'}
        </HexButton>
      </div>
    </section>
  );
}

function Stat({ label, value, sub, subTone = 'text-text/45' }: { label: string; value: string; sub?: string; subTone?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.16em] text-text/45">{label}</div>
      <div className="font-heading font-semibold">{value}</div>
      {sub && <div className={`text-[11px] ${subTone}`}>{sub}</div>}
    </div>
  );
}
