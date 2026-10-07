'use client';
import { useEffect, useRef } from 'react';
import { createChart, ColorType, LineStyle, type IChartApi, type ISeriesApi, type SeriesMarker, type Time } from 'lightweight-charts';
import { useHive } from '@/lib/store';
import { theme } from '@/themes';
import { verbLabel } from './Badges';

export default function PriceChart({ ca, className = '' }: { ca: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const version = useHive((s) => s.version);
  const mode = useHive((s) => s.mode);

  useEffect(() => {
    if (!ref.current) return;
    const p = theme.palette;
    const chart = createChart(ref.current, {
      layout: { attributionLogo: false, background: { type: ColorType.Solid, color: 'transparent' }, textColor: mode === 'day' ? p.dayText : p.text, fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(245,165,36,0.06)' }, horzLines: { color: 'rgba(245,165,36,0.06)' } },
      rightPriceScale: { borderColor: 'rgba(245,165,36,0.2)' },
      timeScale: { borderColor: 'rgba(245,165,36,0.2)', timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: p.accent, style: LineStyle.Dotted }, horzLine: { color: p.accent, style: LineStyle.Dotted } },
      handleScroll: true,
      handleScale: true,
      autoSize: true,
    });
    const series = chart.addAreaSeries({
      lineColor: p.accent,
      topColor: 'rgba(245,165,36,0.35)',
      bottomColor: 'rgba(245,165,36,0.02)',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 9, minMove: 0.000000001 },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [mode]);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    const st = useHive.getState();
    const h = st.world.hives[ca];
    if (!h) return;
    s.setData(h.priceHistory.map((p) => ({ time: p.time as Time, value: p.value })));
    const p = theme.palette;
    const markers: SeriesMarker<Time>[] = st.world.actions
      .filter((a) => a.ca === ca && (a.verb === 'seal' || a.verb === 'swarm' || a.verb === 'jelly'))
      .slice(0, 30)
      .map((a) => ({
        time: Math.floor(a.at / 1000) as Time,
        position: (a.verb === 'seal' ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
        color: a.verb === 'swarm' ? p.raid : a.verb === 'jelly' ? p.royal : p.accentSoft,
        shape: (a.verb === 'seal' ? 'arrowUp' : a.verb === 'swarm' ? 'arrowDown' : 'circle') as 'arrowUp' | 'arrowDown' | 'circle',
        text: verbLabel(a.verb),
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    // markers must be unique+sorted by time
    const uniq: SeriesMarker<Time>[] = [];
    for (const m of markers) if (!uniq.length || uniq[uniq.length - 1].time !== m.time) uniq.push(m);
    s.setMarkers(uniq);
    chartRef.current?.timeScale().fitContent();
  }, [ca, version, mode]);

  return <div ref={ref} className={`w-full ${className}`} />;
}
