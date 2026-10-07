'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useNow } from '@/lib/useNow';
import { createChart, ColorType, type IChartApi, type Time } from 'lightweight-charts';
import { useHive } from '@/lib/store';
import { theme } from '@/themes';
import { fmtCompact, fmtSol, short, txUrl, timeAgo, addrUrl } from '@/lib/format';
import HarvestCountdown from './HarvestCountdown';
import PourCounter from './PourCounter';
import Avatar from './Avatar';

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export default function HarvestPage() {
  const harvests = useHive((s) => s.world.harvests);
  const hives = useHive((s) => s.world.hives);
  const burned = useHive((s) => s.world.hubBurnedTotal);
  const pool = useHive((s) => s.world.hubPool);
  const price = useHive((s) => s.world.hubPrice);
  const mode = useHive((s) => s.mode);
  const chartRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const now = useNow(5000);

  useEffect(() => {
    if (!chartRef.current) return;
    const p = theme.palette;
    const chart: IChartApi = createChart(chartRef.current, {
      layout: { attributionLogo: false, background: { type: ColorType.Solid, color: 'transparent' }, textColor: mode === 'day' ? p.dayText : p.text, fontSize: 11, fontFamily: 'Inter, system-ui, sans-serif' },
      grid: { vertLines: { color: 'rgba(245,165,36,0.06)' }, horzLines: { color: 'rgba(245,165,36,0.06)' } },
      rightPriceScale: { borderColor: 'rgba(245,165,36,0.2)' },
      timeScale: { borderColor: 'rgba(245,165,36,0.2)', timeVisible: true },
      autoSize: true,
    });
    const s = chart.addHistogramSeries({ color: p.accent, priceFormat: { type: 'volume' } });
    const data = [...harvests]
      .reverse()
      .map((h) => ({ time: Math.floor(h.at / 1000) as Time, value: Math.round(h.burned), color: p.accent }));
    const uniq = data.filter((d, i) => i === 0 || d.time !== data[i - 1].time);
    s.setData(uniq);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [harvests, mode]);

  const totals = harvests.reduce((a, h) => ({ fees: a.fees + h.feesIn, bought: a.bought + h.hiveBought }), { fees: 0, bought: 0 });

  return (
    <div className="mx-auto max-w-[1400px] px-4 pt-24 sm:px-6 sm:pt-28">
      <div className="grid gap-8 lg:grid-cols-[1fr_1fr]">
        <div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-accent">hub · every hour on the hour, UTC</div>
          <h1 className="mt-2 font-heading text-5xl font-semibold tracking-tight sm:text-6xl">{cap(theme.hubRitual)}</h1>
          <p className="mt-4 max-w-lg text-text/70">
            {Math.round(theme.feeToHub * 100)}% of every {theme.unit}’s fees are pooled. On the hour the pool buys {theme.hubToken.symbol}. {Math.round(theme.hubSplit.burn * 100)}% is burned. {Math.round(theme.hubSplit.toBiggest * 100)}% is sent to the biggest {theme.unit} by {theme.copy.resource} as {theme.copy.reward}. The X account posts every {theme.hubRitual} with the tx.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-text/50">{theme.hubToken.symbol} CA</span>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(theme.hubToken.ca);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
              className="shape-btn btn-ghost inline-flex h-7 items-center font-mono text-[11px]"
            >
              {short(theme.hubToken.ca, 6)} {copied ? '✓' : '⧉'}
            </button>
            <a href={addrUrl(theme.hubToken.ca)} target="_blank" rel="noreferrer" className="text-accent/80 hover:text-accent">
              solscan ↗
            </a>
          </div>
          <HarvestCountdown className="mt-8" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Big label={`${theme.hubToken.symbol} burned`} value={fmtCompact(burned)} />
          <Big label="pool for next" value={fmtSol(pool, 3)} />
          <Big label="fees collected (shown)" value={fmtSol(totals.fees, 2)} />
          <Big label={`${theme.hubToken.symbol} price`} value={`${price.toFixed(8)} SOL`} />
        </div>
      </div>

      <div className="mt-12">
        <h2 className="mb-3 font-heading text-2xl font-semibold tracking-tight">Burn per {theme.hubRitual}</h2>
        <div className="shape-card glass p-3">
          <div ref={chartRef} className="h-[240px] w-full" />
        </div>
      </div>

      <div className="mt-12">
        <h2 className="mb-3 font-heading text-2xl font-semibold tracking-tight">Every {theme.hubRitual}</h2>
        <div className="shape-card glass overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm tabular-nums">
            <thead className="text-[11px] uppercase tracking-wider text-text/50">
              <tr className="border-b border-accent/10">
                <th className="px-4 py-3 text-left font-medium">When</th>
                <th className="px-4 py-3 text-right font-medium">Fees in</th>
                <th className="px-4 py-3 text-right font-medium">{theme.hubToken.symbol} bought</th>
                <th className="px-4 py-3 text-right font-medium">Burned</th>
                <th className="px-4 py-3 text-left font-medium">{theme.copy.reward} to</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-right font-medium">Tx</th>
              </tr>
            </thead>
            <tbody>
              {harvests.map((h) => {
                const to = hives[h.jellyTo];
                return (
                  <tr key={h.id} className="log-in border-b border-accent/5">
                    <td className="px-4 py-3 text-text/70">{now === null ? '…' : timeAgo(h.at, now)}</td>
                    <td className="px-4 py-3 text-right">{fmtSol(h.feesIn, 3)}</td>
                    <td className="px-4 py-3 text-right">{fmtCompact(h.hiveBought)}</td>
                    <td className="px-4 py-3 text-right text-accent">{fmtCompact(h.burned)}</td>
                    <td className="px-4 py-3">
                      {to ? (
                        <Link href={`/hive/${to.ca}`} className="flex items-center gap-2 font-heading font-semibold tracking-tight hover:text-royal">
                          <Avatar hive={to} size={22} /> {to.name}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-royal">{fmtCompact(h.jellyAmount)}</td>
                    <td className="px-4 py-3 text-right">
                      <a href={txUrl(h.txSig)} target="_blank" rel="noreferrer" className="text-accent/80 hover:text-accent">
                        {short(h.txSig, 4)} ↗
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Big({ label, value }: { label: string; value: string }) {
  return (
    <div className="shape-card glass p-5">
      <div className="text-[11px] uppercase tracking-[0.18em] text-text/55">{label}</div>
      <PourCounter value={value} className="mt-2 text-2xl font-semibold sm:text-3xl" />
    </div>
  );
}
