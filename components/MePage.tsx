'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useWallet } from '@solana/wallet-adapter-react';
import { useHive } from '@/lib/store';
import { useUI } from '@/lib/ui';
import { theme } from '@/themes';
import { fmtNum, fmtSol, short } from '@/lib/format';
import HexButton from './HexButton';
import Avatar from './Avatar';
import HiveCard from './HiveCard';
import { StateBadge } from './Badges';

const WalletButton = dynamic(() => import('./WalletButton'), { ssr: false });
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export default function MePage() {
  const { publicKey } = useWallet();
  const hives = useHive((s) => s.world.hives);
  const mine = useHive((s) => s.mine);
  const positions = useHive((s) => s.positions);
  const claimed = useHive((s) => s.claimed);
  const claim = useHive((s) => s.claim);
  const biggest = useHive((s) => s.world.biggestCa);
  const actions = useHive((s) => s.world.actions);
  const openLaunch = useUI((s) => s.openLaunch);
  const maxHoney = Math.max(1, ...Object.values(hives).map((h) => h.honey));

  const myHives = mine.map((ca) => hives[ca]).filter(Boolean);
  const claimable = positions
    .map((p) => ({ p, h: hives[p.ca] }))
    .filter(({ h }) => h && h.state === 'abandoned')
    .map(({ p, h }) => {
      const payout = actions.find((a) => a.verb === 'abandon' && a.ca === h.ca)?.amount ?? 0;
      return { p, h, amount: payout * p.share, done: claimed.includes(h.ca) };
    });

  return (
    <div className="mx-auto max-w-[1400px] px-4 pt-24 sm:px-6 sm:pt-28">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-accent">{publicKey ? short(publicKey.toBase58(), 6) : 'not connected'}</div>
          <h1 className="mt-2 font-heading text-5xl font-semibold tracking-tight sm:text-6xl">Me</h1>
        </div>
        <div className="flex items-center gap-3">
          <WalletButton full />
          <HexButton onClick={openLaunch}>Launch a {theme.unit}</HexButton>
        </div>
      </div>
      {!publicKey && (
        <div className="shape-card glass mt-6 p-4 text-sm text-text/70">
          Connect a wallet to see your own {theme.unitPlural} and positions. Below is a demo wallet so the page is never empty. In Phase 2 positions come from DAS holder lookups.
        </div>
      )}

      <section className="mt-12">
        <h2 className="font-heading text-2xl font-semibold tracking-tight">Your {theme.unitPlural}</h2>
        {myHives.length ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {myHives.map((h) => (
              <HiveCard key={h.ca} hive={h} maxHoney={maxHoney} biggest={h.ca === biggest} />
            ))}
          </div>
        ) : (
          <div className="shape-card glass mt-4 flex flex-wrap items-center justify-between gap-4 p-6">
            <p className="text-sm text-text/70">You haven’t founded a {theme.unit} yet. Your {theme.agent} is waiting.</p>
            <HexButton onClick={openLaunch} size="sm">
              {theme.copy.launch.title}
            </HexButton>
          </div>
        )}
      </section>

      <section className="mt-12">
        <h2 className="font-heading text-2xl font-semibold tracking-tight">Your {theme.holder} positions</h2>
        <p className="mt-1 text-sm text-text/60">Coins you hold. You are a {theme.holder} in each of these {theme.unitPlural}.</p>
        <div className="shape-card glass mt-4 overflow-hidden">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-[11px] uppercase tracking-wider text-text/50">
              <tr className="border-b border-accent/10">
                <th className="px-4 py-3 text-left font-medium">{cap(theme.unit)}</th>
                <th className="hidden px-4 py-3 text-left font-medium sm:table-cell">State</th>
                <th className="px-4 py-3 text-right font-medium">Tokens</th>
                <th className="px-4 py-3 text-right font-medium">Share</th>
                <th className="hidden px-4 py-3 text-right font-medium sm:table-cell">{theme.copy.resource}</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const h = hives[p.ca];
                if (!h) return null;
                return (
                  <tr key={p.ca} className="border-b border-accent/5">
                    <td className="px-4 py-3">
                      <Link href={`/hive/${h.ca}`} className="flex items-center gap-3">
                        <Avatar hive={h} size={30} />
                        <span className="font-heading font-semibold tracking-tight">{h.name}</span>
                        <span className="text-xs text-text/50">${h.ticker}</span>
                      </Link>
                    </td>
                    <td className="hidden px-4 py-3 sm:table-cell">
                      <StateBadge state={h.state} />
                    </td>
                    <td className="px-4 py-3 text-right">{fmtNum(p.tokens)}</td>
                    <td className="px-4 py-3 text-right">{(p.share * 100).toFixed(2)}%</td>
                    <td className="hidden px-4 py-3 text-right text-text/70 sm:table-cell">{fmtSol(h.honey, 2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-12">
        <h2 className="font-heading text-2xl font-semibold tracking-tight">Claimable payouts</h2>
        <p className="mt-1 text-sm text-text/60">When a {theme.unit} is abandoned its vault pays out pro-rata to {theme.holderPlural}.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {claimable.map(({ h, amount, done }) => (
            <div key={h.ca} className="shape-card glass flex items-center gap-4 p-5">
              <Avatar hive={h} size={44} />
              <div className="min-w-0 flex-1">
                <div className="font-heading font-semibold tracking-tight">{h.name}</div>
                <div className="text-xs text-text/55">abandoned · your share</div>
              </div>
              <div className="text-right">
                <div className="font-heading text-lg font-semibold">{fmtSol(amount, 4)}</div>
                <button onClick={() => claim(h.ca)} disabled={done} className={`shape-btn mt-1 h-8 text-xs font-semibold ${done ? 'btn-ghost opacity-60' : 'btn-honey'}`}>
                  {done ? 'Claimed' : 'Claim'}
                </button>
              </div>
            </div>
          ))}
          {!claimable.length && <div className="shape-card glass p-5 text-sm text-text/60">Nothing to claim. None of your {theme.unitPlural} have been abandoned.</div>}
        </div>
      </section>
    </div>
  );
}
