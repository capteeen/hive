'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CombRenderer, type SafeArea } from '@/lib/comb3d';
import { useHive } from '@/lib/store';
import { useUI } from '@/lib/ui';
import { frontierCells } from '@/lib/sim';
import { cellKey } from '@/lib/hex';
import { theme } from '@/themes';
import { fmtSol, fmtNum } from '@/lib/format';
import { sfx } from '@/lib/sfx';
import { verbLabel } from '@/components/Badges';
import CellPanel from './CellPanel';
import { pickKey, type CombPick, type Hive } from '@/lib/types';

interface Props {
  mode?: 'comb' | 'single';
  ca?: string;
  className?: string;
  interactive?: boolean;
  /** Optional filter for the comb page. */
  filter?: (h: Hive) => boolean;
  /** Fly the camera to this cell on mount; replays the founding sequence if it was just born here. */
  focusCa?: string;
  /** Controlled selection. Leave undefined to let the scene manage it. */
  selection?: CombPick;
  onSelectionChange?: (p: CombPick) => void;
  /** Screen insets (px) covered by surrounding UI, e.g. the hero card or the list. */
  safeArea?: Partial<SafeArea>;
  wheelZoom?: 'always' | 'modifier';
  touchScroll?: boolean;
  /** Show the in-place panel for the selection (comb mode). */
  panel?: boolean;
}

const PANEL_W = 404;
const PANEL_H = 340;

export default function CombScene({
  mode = 'comb',
  ca,
  className = '',
  interactive = true,
  filter,
  focusCa,
  selection,
  onSelectionChange,
  safeArea,
  wheelZoom = 'always',
  touchScroll = false,
  panel = true,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<CombRenderer | null>(null);
  const lastEvent = useRef(0);
  const focused = useRef<string | null>(null);
  const emptiesKey = useRef('');
  const zoomNext = useRef<number | null>(null);
  const centered = useRef(false);
  const router = useRouter();
  const openLaunch = useUI((s) => s.openLaunch);
  const version = useHive((s) => s.version);
  const modeTheme = useHive((s) => s.mode);
  const [inner, setInner] = useState<CombPick>(null);
  const [hover, setHover] = useState<CombPick>(null);
  const [hint, setHint] = useState(false);
  const [wide, setWide] = useState(true);
  const controlled = selection !== undefined;
  const sel = controlled ? selection : inner;
  const selKey = pickKey(sel);
  const comb = mode === 'comb';

  const setSel = useCallback(
    (p: CombPick) => {
      if (!controlled) setInner(p);
      onSelectionChange?.(p);
    },
    [controlled, onSelectionChange],
  );
  const setSelRef = useRef(setSel);
  setSelRef.current = setSel;
  const selRef = useRef(sel);
  selRef.current = sel;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const hintTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 768);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // renderer lifecycle
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = new CombRenderer(canvas, {
      mode,
      interactive,
      wheelZoom,
      touchScroll,
      onHover: (p) => setHover(p),
      onSelect: (p) => {
        const prev = pickKey(selRef.current);
        if (!p) sfx(prev ? 'deselect' : 'tick');
        else sfx(p.kind === 'hive' ? 'select' : 'empty');
        setSelRef.current(p);
      },
      onOpen: (hca) => {
        sfx('open');
        router.push(`/hive/${hca}`);
      },
      onWheelHint: () => {
        setHint(true);
        clearTimeout(hintTimer.current);
        hintTimer.current = setTimeout(() => setHint(false), 1400);
      },
    });
    rendererRef.current = r;
    lastEvent.current = 0;
    focused.current = null;
    emptiesKey.current = '';
    centered.current = false;
    const io = new IntersectionObserver(([en]) => r.setVisible(en.isIntersecting), { threshold: 0.01 });
    io.observe(canvas);
    const onVis = () => r.setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      clearTimeout(hintTimer.current);
      r.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, ca]);

  // world → renderer
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    const s = useHive.getState();
    const world = s.world;
    let hives = world.order.map((c) => world.hives[c]);
    if (mode === 'single') hives = hives.filter((h) => h.ca === ca);
    else if (filterRef.current) hives = hives.filter(filterRef.current);
    r.sync(hives, world.biggestCa);
    if (comb) {
      const f = frontierCells(world);
      const key = f.map(cellKey).sort().join('|');
      if (key !== emptiesKey.current) {
        emptiesKey.current = key;
        r.setEmpties(f);
      }
    }
    const evs = world.events.filter((e) => e.id > lastEvent.current);
    if (lastEvent.current === 0) {
      lastEvent.current = world.eventSeq; // skip backlog on mount
    } else {
      for (const e of evs) {
        if (mode === 'single' && e.ca !== ca && e.targetCa !== ca) continue;
        r.handleEvent(mode === 'single' && e.type === 'swarm' && e.targetCa === ca ? { ...e, type: 'swarm', ca: ca!, targetCa: ca } : e);
        // a hive founded from this session: follow and select it
        if (e.type === 'spawn' && comb && s.mine.includes(e.ca)) {
          zoomNext.current = 1.9;
          setSelRef.current({ kind: 'hive', ca: e.ca });
        }
      }
      if (evs.length) lastEvent.current = evs[evs.length - 1].id;
    }
    // focus request (arriving from the launch flow or a shared link)
    if (focusCa && comb && focused.current !== focusCa && world.hives[focusCa]) {
      focused.current = focusCa;
      const h = world.hives[focusCa];
      zoomNext.current = 1.9;
      if (pickKey(selRef.current) === `h:${focusCa}`) {
        r.flyToPick({ kind: 'hive', ca: focusCa }, 1.9);
        zoomNext.current = null;
      } else setSelRef.current({ kind: 'hive', ca: focusCa });
      if (s.mine.includes(focusCa) && Date.now() - h.bornAt < 30000) r.handleEvent({ id: 0, type: 'spawn', ca: focusCa, at: Date.now() });
    }
  }, [version, mode, ca, focusCa, comb, filter]);

  useEffect(() => {
    rendererRef.current?.setBackground(modeTheme === 'day' ? theme.palette.dayBase : theme.palette.base, modeTheme === 'day');
  }, [modeTheme, version]);

  // safe area (UI that covers the canvas) and selection → renderer
  const areaKey = JSON.stringify(safeArea ?? {});
  const worldNow = useHive.getState().world;
  const selResolves = !!sel && (sel.kind === 'empty' || !!worldNow.hives[sel.ca]);
  const panelOpen = panel && comb && selResolves;
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !comb) return;
    const a: SafeArea = { left: 0, top: 72, right: 0, bottom: 0, ...(safeArea ?? {}) };
    if (panelOpen) {
      if (wide) a.right = Math.max(a.right, PANEL_W);
      else a.bottom = Math.max(a.bottom, PANEL_H);
    }
    const first = !centered.current && !!safeArea && Object.keys(safeArea).length > 0;
    if (first) centered.current = true;
    r.setSafeArea(a, first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaKey, panelOpen, wide, comb]);

  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.select(sel);
    if (!sel || !comb) return;
    if (zoomNext.current != null) {
      r.flyToPick(sel, zoomNext.current);
      zoomNext.current = null;
      return;
    }
    // wait out the double-click window before moving the camera under the pointer
    const t = setTimeout(() => rendererRef.current?.ensureVisible(selRef.current), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, comb, panelOpen]);

  // keyboard: Esc deselects, Enter opens the hive / starts founding on the empty cell
  useEffect(() => {
    if (!sel || !comb) return;
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return; // the launch wizard owns the keyboard
      const t = e.target as HTMLElement | null;
      if (t && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'Escape') {
        sfx('deselect');
        setSelRef.current(null);
      } else if (e.key === 'Enter') {
        if (t && t.closest('button, a')) return; // Enter activates the focused control
        const p = selRef.current;
        if (p?.kind === 'hive') router.push(`/hive/${p.ca}`);
        else if (p?.kind === 'empty') {
          sfx('open');
          openLaunch({ q: p.q, r: p.r });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, comb, router, openLaunch]);

  // tag that tracks the selected cell on screen
  useEffect(() => {
    if (!sel || !comb) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = labelRef.current;
      const r = rendererRef.current;
      if (!el || !r) return;
      const p = r.projectPick(selRef.current);
      if (!p) {
        el.style.opacity = '0';
        return;
      }
      el.style.opacity = '1';
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [selKey, sel, comb]);

  // tooltip follows the pointer without re-rendering React every frame
  const onWrapMove = (e: React.PointerEvent) => {
    const tip = tipRef.current;
    const wrap = wrapRef.current;
    if (!tip || !wrap || e.pointerType !== 'mouse') return;
    const rect = wrap.getBoundingClientRect();
    let x = e.clientX - rect.left + 16;
    let y = e.clientY - rect.top + 16;
    if (x + 240 > rect.width) x -= 260;
    if (y + 150 > rect.height) y -= 170;
    tip.style.transform = `translate(${x}px, ${y}px)`;
  };

  const world = useHive.getState().world;
  const hovered = hover?.kind === 'hive' ? world.hives[hover.ca] : null;
  const showTip = !!hover && pickKey(hover) !== selKey;
  const lastVerb = hovered ? world.actions.find((a) => a.ca === hovered.ca) : null;
  const selHive = sel?.kind === 'hive' ? world.hives[sel.ca] : null;

  return (
    <div ref={wrapRef} className={`relative ${className}`} onPointerMove={onWrapMove}>
      <canvas ref={canvasRef} className="block h-full w-full" aria-label={`${theme.name} ${theme.scene}: click a cell for details, or an empty cell to found a ${theme.unit}`} />
      {comb && sel && (
        <div ref={labelRef} className="pointer-events-none absolute left-0 top-0 z-10 opacity-0 transition-opacity duration-600" style={{ willChange: 'transform' }}>
          <div className={`shape-btn flex h-8 items-center whitespace-nowrap text-xs font-heading font-semibold ${sel.kind === 'hive' ? 'btn-honey' : 'btn-ghost'}`}>
            {sel.kind === 'hive' ? (selHive ? `${selHive.name} · $${selHive.ticker}` : '') : `+ Free cell`}
          </div>
          <div className="mx-auto mt-0.5 h-3 w-px bg-accent" />
        </div>
      )}
      {hint && (
        <div className="shape-btn glass pointer-events-none absolute left-1/2 top-1/2 z-10 flex h-10 -translate-x-1/2 -translate-y-1/2 items-center text-sm text-text/80">Hold Ctrl or ⌘ and scroll to zoom</div>
      )}
      {comb && (
        <div ref={tipRef} className={`pointer-events-none absolute left-0 top-0 z-30 transition-opacity duration-300 ${showTip ? 'opacity-100' : 'opacity-0'}`}>
          {hover?.kind === 'hive' && hovered && (
            <div className="shape-card glass px-4 py-3 text-sm" style={{ minWidth: 210 }}>
              <div className="font-heading text-base font-semibold tracking-tight">
                {hovered.name} <span className="text-accent">${hovered.ticker}</span>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 tabular-nums text-text/80">
                <span className="text-text/50">{theme.copy.resource}</span>
                <span>{fmtSol(hovered.honey)}</span>
                <span className="text-text/50">{theme.holderPlural}</span>
                <span>{fmtNum(hovered.bees)}</span>
                <span className="text-text/50">state</span>
                <span className={hovered.state === 'working' ? 'text-accent' : 'text-starving'}>{hovered.state}</span>
                <span className="text-text/50">last</span>
                <span>{lastVerb ? verbLabel(lastVerb.verb) : '—'}</span>
              </div>
              <div className="mt-2 text-[11px] text-text/45">Click for details · double-click to open</div>
            </div>
          )}
          {hover?.kind === 'empty' && (
            <div className="shape-card glass px-4 py-3 text-sm" style={{ minWidth: 200 }}>
              <div className="font-heading text-base font-semibold tracking-tight">+ Free cell</div>
              <div className="mt-1 text-xs text-text/60">
                cell {hover.q}, {hover.r} · click to found a {theme.unit} here
              </div>
            </div>
          )}
        </div>
      )}
      {panelOpen && sel && (
        <CellPanel
          pick={sel}
          wide={wide}
          onClose={() => setSel(null)} // the panel's buttons play their own 'close' sound
          onPick={(p) => setSel(p)}
        />
      )}
    </div>
  );
}
