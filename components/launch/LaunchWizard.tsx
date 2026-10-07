'use client';
/* eslint-disable @next/next/no-img-element -- data-URL previews, not optimisable */
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useUI } from '@/lib/ui';
import { useHive } from '@/lib/store';
import { LAUNCH_COST, QUEEN_RESERVE, isFoundable } from '@/lib/sim';
import { cellKey, hexDistance, neighbors } from '@/lib/hex';
import { theme } from '@/themes';
import { sfx } from '@/lib/sfx';
import { short } from '@/lib/format';
import {
  CROWNS,
  DEFAULT_LOOK,
  DIPS,
  FUZZ,
  GLOWS,
  MARKINGS,
  RULE_LIMITS,
  SHELLS,
  SWARMS,
  WINGS,
  clampRules,
  drawQueenImage,
  isLook,
  presetRules,
  randomLook,
  rulesSummary,
  type DipId,
  type QueenLook,
  type QueenRules,
  type Risk,
  type SwarmId,
} from '@/lib/queen';

const QueenPreview = dynamic(() => import('./QueenPreview'), { ssr: false });

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const pct = (n: number) => `${Math.round(n * 100)}%`;
const DRAFT_KEY = `${theme.id}:draft`;
const DEV_PRESETS = [0, 0.1, 0.5, 1, 2.5, 5];
const MAX_DEV = 10;
const MAX_UPLOAD = 4 * 1024 * 1024;

interface Draft {
  step: number;
  seen: number;
  look: QueenLook;
  dip: DipId;
  swarm: SwarmId;
  custom: QueenRules;
  name: string;
  ticker: string;
  desc: string;
  motto: string;
  tg: string;
  x: string;
  imageMode: 'queen' | 'upload';
  upload: string;
  devBuy: string;
}

const EMPTY: Draft = {
  step: 0,
  seen: 0,
  look: DEFAULT_LOOK,
  dip: 'steady',
  swarm: 'forager',
  custom: presetRules('steady', 'forager'),
  name: '',
  ticker: '',
  desc: '',
  motto: '',
  tg: '',
  x: '',
  imageMode: 'queen',
  upload: '',
  devBuy: '0',
};

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return EMPTY;
    const d = JSON.parse(raw) as Partial<Draft>;
    return {
      ...EMPTY,
      ...d,
      look: isLook(d.look) ? d.look : EMPTY.look,
      dip: DIPS.some((x) => x.id === d.dip) ? (d.dip as DipId) : EMPTY.dip,
      swarm: d.swarm === 'custom' || SWARMS.some((x) => x.id === d.swarm) ? (d.swarm as SwarmId) : EMPTY.swarm,
      custom: clampRules(d.custom ?? {}),
      step: Math.min(4, Math.max(0, Number(d.step) || 0)),
      seen: Math.min(4, Math.max(0, Number(d.seen) || 0)),
      imageMode: d.imageMode === 'upload' ? 'upload' : 'queen',
    };
  } catch {
    return EMPTY;
  }
}

const STEPS = [`${cap(theme.agent)}`, 'Temperament', 'Rules', 'Coin', 'Dev buy + launch'];

export default function LaunchWizard() {
  const open = useUI((s) => s.launchOpen);
  const close = useUI((s) => s.closeLaunch);
  const launchCell = useUI((s) => s.launchCell);
  const setLaunchCell = useUI((s) => s.setLaunchCell);
  const found = useHive((s) => s.found);
  const world = useHive((s) => s.world);
  useHive((s) => s.version);
  const router = useRouter();
  const pathname = usePathname();
  const { publicKey, signMessage } = useWallet();
  const { setVisible } = useWalletModal();
  const [d, setD] = useState<Draft>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [agreed, setAgreed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // restore the saved design once, client-side
  useEffect(() => {
    setD(loadDraft());
    setLoaded(true);
  }, []);
  // save the design as it changes
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
      } catch {
        try {
          localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...d, upload: '' })); // too big: keep everything but the upload
        } catch {}
      }
    }, 250);
    return () => clearTimeout(t);
  }, [d, loaded]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.wallet-adapter-modal')) {
        sfx('close');
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    setErr('');
    setTimeout(() => dialogRef.current?.focus(), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, close]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [d.step]);

  const rules = useMemo(() => (d.swarm === 'custom' ? clampRules(d.custom) : presetRules(d.dip, d.swarm)), [d.dip, d.swarm, d.custom]);
  const sum = rulesSummary(rules);
  const lookKey = JSON.stringify(d.look);
  const queenImg = useMemo(() => (typeof document !== 'undefined' && open ? drawQueenImage(d.look, 384) : ''), [lookKey, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const image = d.imageMode === 'upload' && d.upload ? d.upload : queenImg;
  const dev = Math.min(MAX_DEV, Math.max(0, parseFloat(d.devBuy) || 0));
  const total = LAUNCH_COST + QUEEN_RESERVE + dev;
  const nameOk = d.name.trim().length >= 2 && d.name.trim().length <= 32;
  const tickerOk = /^[A-Za-z0-9]{2,8}$/.test(d.ticker.trim());
  const devOk = d.devBuy.trim() === '' || (/^\d*\.?\d*$/.test(d.devBuy.trim()) && parseFloat(d.devBuy) <= MAX_DEV);
  const coinOk = nameOk && tickerOk;
  const dipName = DIPS.find((x) => x.id === d.dip)?.name ?? '';
  const swarmName = d.swarm === 'custom' ? 'Custom' : SWARMS.find((x) => x.id === d.swarm)?.name ?? '';
  const cellFree = launchCell ? isFoundable(world, launchCell) : false;
  const ring = launchCell ? hexDistance(launchCell, { q: 0, r: 0 }) : null;
  const neighbourNames = useMemo(() => {
    if (!launchCell) return [];
    const occ = new Map(world.order.map((ca) => [cellKey(world.hives[ca].cell), world.hives[ca].name]));
    return neighbors(launchCell)
      .map((c) => occ.get(cellKey(c)))
      .filter(Boolean) as string[];
  }, [launchCell, world, world.order.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const up = (patch: Partial<Draft>) => setD((p) => ({ ...p, ...patch }));
  const go = (step: number) => {
    const s = Math.max(0, Math.min(4, step));
    sfx(s > d.step ? 'next' : 'back');
    setErr('');
    up({ step: s, seen: Math.max(d.seen, s) });
  };
  const setRule = (k: keyof QueenRules, v: number) => up({ swarm: 'custom', custom: clampRules({ ...rules, [k]: v }) });

  const onFile = (f?: File) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) return setErr('That file is not an image.');
    if (f.size > MAX_UPLOAD) return setErr('Images up to 4 MB, please.');
    const r = new FileReader();
    r.onload = () => up({ upload: String(r.result), imageMode: 'upload' });
    r.readAsDataURL(f);
  };

  const launch = async () => {
    if (!coinOk) {
      sfx('error');
      setErr(`Your coin needs a name (2–32 characters) and a ticker (2–8 letters or digits).`);
      up({ step: 3 });
      return;
    }
    if (!devOk) {
      sfx('error');
      setErr(`Dev buy must be between 0 and ${MAX_DEV} SOL.`);
      return;
    }
    if (!agreed) {
      sfx('error');
      setErr('Tick the box to confirm your queen acts on her own.');
      return;
    }
    if (!publicKey) {
      setVisible(true);
      return;
    }
    setBusy(true);
    setErr('');
    try {
      // Phase 1: mock. Phase 2 (TODO): POST /api/launch → server creates the queen keypair, the user pays
      // `total` to it, the server launches via PumpPortal with the queen as creator and stores look + rules.
      if (signMessage) {
        try {
          await signMessage(new TextEncoder().encode(`${theme.name}: found "${d.name.trim()}" ($${d.ticker.trim().toUpperCase()}). Mock launch, nothing is sent.`));
        } catch {
          /* declining the signature is fine in the mock */
        }
      }
      await new Promise((r) => setTimeout(r, 700));
      const target = launchCell && isFoundable(useHive.getState().world, launchCell) ? launchCell : null;
      const h = found({
        name: d.name.trim(),
        ticker: d.ticker.trim(),
        image,
        description: d.desc,
        devBuy: dev,
        cell: target,
        look: d.look,
        rules,
        motto: d.motto,
        temperament: { dip: dipName, swarm: swarmName },
      });
      sfx('launch');
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {}
      setD(EMPTY);
      setAgreed(false);
      close();
      // stay and watch the founding on a page that shows the comb; otherwise go to it
      if (pathname === '/') window.scrollTo({ top: 0, behavior: 'smooth' });
      else if (pathname !== '/comb') router.push(`/comb?focus=${h.ca}`);
    } catch (e) {
      sfx('error');
      setErr((e as Error).message ?? 'Launch failed');
    } finally {
      setBusy(false);
    }
  };

  const bubble =
    d.step === 0
      ? 'Do I look royal?'
      : d.step === 1
        ? d.swarm === 'berserker'
          ? 'Neighbours, run.'
          : d.dip === 'fierce'
            ? 'Dips make me burn.'
            : 'I keep the comb full.'
        : d.step === 2
          ? 'Every number is public.'
          : d.step === 3
            ? !d.name.trim()
              ? 'Name my coin.'
              : d.motto.trim() || `${d.name.trim()}. I like it.`
            : 'Ready when you are.';

  const doneStep = (i: number) => (i === 3 ? coinOk && d.seen > 3 : i < d.seen || (i < d.step && i !== 3));

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-night/75 backdrop-blur-sm sm:p-4 lg:p-6" role="dialog" aria-modal="true" aria-labelledby="wiz-title">
      <div ref={dialogRef} tabIndex={-1} className="fade-up flex h-full w-full max-w-[1280px] flex-col overflow-hidden bg-surface outline-none sm:shape-card sm:glass sm:bg-surface/95">
        {/* header */}
        <div className="flex items-center justify-between border-b border-accent/10 px-4 py-4 sm:px-6">
          <h2 id="wiz-title" className="flex items-center gap-3 font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
            <span className="inline-block h-7 w-1.5 rounded-full bg-accent" />
            {theme.copy.launch.title}
          </h2>
          <button
            onClick={() => {
              sfx('close');
              close();
            }}
            data-sfx="none"
            className="shape-hex flex h-10 w-10 items-center justify-center bg-text/10 text-lg text-text/80 hover:bg-text/20"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {/* stepper */}
        <div className="scroll-thin flex gap-2 overflow-x-auto border-b border-accent/10 px-4 py-3 sm:px-6" role="tablist">
          {STEPS.map((label, i) => {
            const cur = i === d.step;
            const done = !cur && doneStep(i);
            return (
              <button
                key={label}
                role="tab"
                aria-selected={cur}
                onClick={() => go(i)}
                data-sfx="none"
                className={`flex min-w-[150px] flex-1 items-center gap-3 border px-3 py-2.5 text-left font-heading text-sm font-semibold tracking-tight transition-colors duration-600 ${cur ? 'border-accent bg-accent/10 text-text' : 'border-text/10 bg-night/40 text-text/75 hover:border-accent/40'}`}
                style={{ clipPath: 'polygon(8px 0, calc(100% - 8px) 0, 100% 8px, 100% calc(100% - 8px), calc(100% - 8px) 100%, 8px 100%, 0 calc(100% - 8px), 0 8px)' }}
              >
                <span className={`shape-hex flex h-7 w-7 shrink-0 items-center justify-center text-xs ${cur ? 'bg-accent text-night' : done ? 'bg-soft/80 text-night' : 'bg-text/10 text-text/60'}`}>{done ? '✓' : i + 1}</span>
                {label}
              </button>
            );
          })}
        </div>
        {/* banners */}
        <div className="border-b border-accent/10 bg-accent/[0.04] px-4 py-2 text-xs leading-relaxed sm:px-6 sm:text-[13px]">
          <span className="font-semibold text-soft">✓ No wallet needed to build it.</span> <span className="text-text/70">You connect only at the last step. Your design is saved in this browser.</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-accent/10 bg-accent/[0.04] px-4 py-2 text-xs leading-relaxed sm:px-6 sm:text-[13px]">
          <span className="shape-hex inline-block h-3 w-3 bg-accent" />
          {launchCell ? (
            cellFree ? (
              <>
                <span className="font-semibold text-soft">
                  Your cell: ring {ring}, the empty cell you clicked.
                </span>
                <span className="text-text/70">
                  {neighbourNames.length ? `Next to ${neighbourNames.slice(0, 3).join(', ')}. ` : ''}If someone takes it before you launch, your {theme.unit} gets the nearest free one.
                </span>
              </>
            ) : (
              <span className="text-raid">That cell was just taken. Your {theme.unit} will get the nearest free cell.</span>
            )
          ) : (
            <>
              <span className="font-semibold text-soft">Your cell: the next free cell on the edge of the {theme.scene}.</span>
              <span className="text-text/70">To choose your spot, close this and click an empty + cell on the {theme.scene}.</span>
            </>
          )}
          {launchCell && (
            <button onClick={() => setLaunchCell(null)} className="ml-auto text-accent underline-offset-2 hover:underline">
              any free cell
            </button>
          )}
        </div>

        {/* body */}
        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_460px]">
          <div ref={bodyRef} className="scroll-thin min-h-0 overflow-y-auto px-4 py-5 sm:px-6">
            {d.step === 0 && (
              <section>
                <div className="mb-4 lg:hidden">
                  <QueenPreview look={d.look} speaking={bubble} className="h-56 border border-text/10" />
                </div>
                <div className="flex items-start justify-between gap-4">
                  <StepTitle icon="♛" title={`${cap(theme.agent)} look`} />
                  <button
                    onClick={() => up({ look: randomLook() })}
                    data-sfx="shuffle"
                    className="shape-btn btn-ghost h-10 font-heading text-sm font-semibold"
                  >
                    Shuffle
                  </button>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-text/70">
                  Your {theme.agent} hovers over your cell on the {theme.scene}. She is also drawn as your coin&rsquo;s logo, unless you upload your own on step 4.
                </p>
                <Field label="Shell">
                  <Swatches colors={SHELLS} value={d.look.body} onPick={(c) => up({ look: { ...d.look, body: c } })} />
                </Field>
                <Field label="Marking">
                  <Cycler options={MARKINGS} value={d.look.marking} onPick={(v) => up({ look: { ...d.look, marking: v } })} />
                </Field>
                <Field label="Fuzz">
                  <Swatches colors={FUZZ} value={d.look.fuzz} onPick={(c) => up({ look: { ...d.look, fuzz: c } })} />
                </Field>
                <Field label="Glow">
                  <Swatches colors={GLOWS} value={d.look.glow} onPick={(c) => up({ look: { ...d.look, glow: c } })} />
                </Field>
                <Field label="Wings">
                  <Swatches colors={WINGS} value={d.look.wings} onPick={(c) => up({ look: { ...d.look, wings: c } })} />
                </Field>
                <Field label="Crown">
                  <Cycler options={CROWNS} value={d.look.crown} onPick={(v) => up({ look: { ...d.look, crown: v } })} />
                </Field>
              </section>
            )}

            {d.step === 1 && (
              <section>
                <StepTitle icon="◆" title="Her temperament" sub="what she does when the price dips" />
                <p className="mt-2 text-sm leading-relaxed text-text/70">
                  Your coin&rsquo;s creator fees are split for good at launch: {pct(1 - theme.feeToHub)} to your {theme.agent}, {pct(theme.feeToHub)} to the hourly {theme.hubRitual}. Her temperament decides how much of a dip hour she {theme.verbs.burn}s.
                </p>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  {DIPS.map((x) => (
                    <OptionCard key={x.id} active={d.dip === x.id} onClick={() => up({ dip: x.id, swarm: d.swarm === 'custom' ? 'forager' : d.swarm })} icon={x.icon} title={x.name} body={x.body} />
                  ))}
                </div>
                <div className="mt-7 flex items-baseline gap-3">
                  <StepTitle icon="⬡" title={`How she ${theme.verbs.interact}s`} sub={`${theme.verbs.interact}s buy the nearest ${theme.unit} with the fastest fee growth`} />
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {SWARMS.map((x) => (
                    <OptionCard
                      key={x.id}
                      active={d.swarm === x.id}
                      onClick={() => up({ swarm: x.id })}
                      icon="⬢"
                      title={x.name}
                      risk={x.risk}
                      body={x.body}
                      foot={`${x.rules.interactThreshold}× fees, ${pct(x.rules.interactShare)} of ${theme.copy.resource}, every ${x.rules.cooldownH >= 1 ? `${x.rules.cooldownH} h` : `${Math.round(x.rules.cooldownH * 60)} min`}`}
                    />
                  ))}
                  <OptionCard active={d.swarm === 'custom'} onClick={() => up({ swarm: 'custom', custom: rules })} icon="⚙" title="Custom" risk="high" body="Your own sliders." foot="Your own numbers on the next step" />
                </div>
              </section>
            )}

            {d.step === 2 && (
              <section>
                <StepTitle icon="⚙" title="Her rules" sub={d.swarm === 'custom' ? 'Custom' : `${dipName} · ${swarmName} preset`} />
                <p className="mt-2 text-sm leading-relaxed text-text/70">
                  {d.swarm === 'custom' ? 'Your own numbers.' : `These are the ${dipName} + ${swarmName} numbers.`} Move any slider to make them your own (Custom). They are public on your {theme.unit}&rsquo;s page and run every hour, no LLM.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Meter label={`${cap(theme.copy.resource)} kept in a dip hour`} value={pct(1 - rules.burnShare)} fill={1 - rules.burnShare} />
                  <Meter label={`Most ${theme.copy.resource} out per ${theme.verbs.interact}`} value={pct(rules.interactShare)} fill={rules.interactShare / RULE_LIMITS.interactShare.max} warn={rules.interactShare >= 0.35} />
                </div>
                <div className="mt-6 grid gap-x-8 gap-y-6 md:grid-cols-2">
                  <Slider
                    label={`${cap(theme.verbs.burn)} share (dip hours)`}
                    value={rules.burnShare}
                    shown={pct(rules.burnShare)}
                    lim={RULE_LIMITS.burnShare}
                    onChange={(v) => setRule('burnShare', v)}
                    help={`In a dip hour ${pct(rules.burnShare)} of her fees buy and burn your coin; ${pct(1 - rules.burnShare)} is stored.`}
                  />
                  <Slider
                    label="Dip trigger (below 24h avg)"
                    value={rules.sealTrigger}
                    shown={rules.sealTrigger === 0 ? 'any dip' : pct(rules.sealTrigger)}
                    lim={RULE_LIMITS.sealTrigger}
                    onChange={(v) => setRule('sealTrigger', v)}
                    help={rules.sealTrigger === 0 ? `She ${theme.verbs.burn}s whenever the price is under its 24h average.` : `She ${theme.verbs.burn}s only when the price is at least ${pct(rules.sealTrigger)} under its 24h average.`}
                  />
                  <Slider
                    label={`${cap(theme.verbs.interact)} threshold`}
                    value={rules.interactThreshold}
                    shown={`${rules.interactThreshold.toFixed(1)}×`}
                    lim={RULE_LIMITS.interactThreshold}
                    onChange={(v) => setRule('interactThreshold', v)}
                    help={`She ${theme.verbs.interact}s once ${theme.copy.resource} is ${rules.interactThreshold.toFixed(1)}× her hourly fee average.`}
                  />
                  <Slider
                    label={`${cap(theme.verbs.interact)} size`}
                    value={rules.interactShare}
                    shown={pct(rules.interactShare)}
                    lim={RULE_LIMITS.interactShare}
                    onChange={(v) => setRule('interactShare', v)}
                    help={`Each ${theme.verbs.interact} spends ${pct(rules.interactShare)} of ${theme.copy.resource} buying a neighbour.`}
                  />
                  <Slider
                    label={`Cooldown between ${theme.verbs.interact}s`}
                    value={rules.cooldownH}
                    shown={sum.cooldown}
                    lim={RULE_LIMITS.cooldownH}
                    onChange={(v) => setRule('cooldownH', v)}
                    help={`At most one ${theme.verbs.interact} every ${sum.cooldown}.`}
                  />
                </div>
                <div className="mt-7 border border-text/10 bg-night/40 p-4 text-xs leading-relaxed text-text/65">
                  <div className="mb-1 font-heading text-sm font-semibold text-text">🔒 Fixed for every {theme.unit}</div>
                  {pct(theme.feeToHub)} of fees go to the hourly {theme.hubRitual}. No fees for {theme.rules.starveHours} hours and {theme.holderPlural} start leaving. At {theme.rules.abandonHours} hours the {theme.unit} is abandoned and the vault pays out pro-rata to holders.
                </div>
              </section>
            )}

            {d.step === 3 && (
              <section className="grid gap-6 md:grid-cols-[minmax(0,1fr)_260px]">
                <div>
                  <StepTitle icon="◎" title="Its coin" sub={`launched on pump.fun by your ${theme.agent}'s own wallet`} />
                  <Field label="Name">
                    <input value={d.name} onChange={(e) => up({ name: e.target.value })} maxLength={32} placeholder="Amber Comb" className="inp" aria-invalid={!!d.name && !nameOk} />
                  </Field>
                  <Field label="Ticker">
                    <input value={d.ticker} onChange={(e) => up({ ticker: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} maxLength={8} placeholder="AMBER" className="inp uppercase" aria-invalid={!!d.ticker && !tickerOk} />
                  </Field>
                  <Field label="Description" hint="optional, shown on pump.fun">
                    <textarea value={d.desc} onChange={(e) => up({ desc: e.target.value })} rows={3} maxLength={280} placeholder={`A patient ${theme.agent} on the ${theme.scene}.`} className="inp resize-none" />
                  </Field>
                  <Field label="Motto" hint={`one line, how your ${theme.agent} talks`}>
                    <input value={d.motto} onChange={(e) => up({ motto: e.target.value })} maxLength={80} placeholder="Slow honey, sharp sting." className="inp" />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Telegram" hint="optional">
                      <input value={d.tg} onChange={(e) => up({ tg: e.target.value })} placeholder="t.me/…" className="inp" />
                    </Field>
                    <Field label="X" hint="optional">
                      <input value={d.x} onChange={(e) => up({ x: e.target.value })} placeholder="x.com/…" className="inp" />
                    </Field>
                  </div>
                  <Field label="Coin image">
                    <div className="flex flex-wrap gap-2">
                      <Toggle active={d.imageMode === 'queen'} onClick={() => up({ imageMode: 'queen' })}>
                        Draw it from my {theme.agent}
                      </Toggle>
                      <Toggle active={d.imageMode === 'upload'} onClick={() => (d.upload ? up({ imageMode: 'upload' }) : fileRef.current?.click())}>
                        Upload
                      </Toggle>
                      {d.imageMode === 'upload' && d.upload && (
                        <button onClick={() => fileRef.current?.click()} className="text-xs text-accent hover:underline">
                          replace
                        </button>
                      )}
                    </div>
                    <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
                  </Field>
                  <p className="mt-4 text-xs leading-relaxed text-text/50">The image and details are saved to IPFS when you launch. Never put a wallet address or contract address in them.</p>
                </div>
                <div className="shape-card h-fit border border-text/10 bg-night/40 p-5 text-center">
                  <div className="shape-hex mx-auto h-40 w-[139px] overflow-hidden bg-accent/20">{image && <img src={image} alt="Coin image" className="h-full w-full object-cover" />}</div>
                  <div className="mt-4 font-heading text-2xl font-semibold text-accent">${d.ticker.trim() || 'TICKER'}</div>
                  <div className="font-heading text-base font-semibold">{d.name.trim() || 'Name'}</div>
                  <div className="mt-1 text-xs text-text/55">{d.desc.trim() || 'No description yet.'}</div>
                </div>
              </section>
            )}

            {d.step === 4 && (
              <section>
                <StepTitle icon="◈" title="Dev buy" sub={`optional, 0 to ${MAX_DEV} SOL`} />
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {DEV_PRESETS.map((v) => (
                    <button
                      key={v}
                      onClick={() => up({ devBuy: String(v) })}
                      aria-pressed={dev === v && d.devBuy !== ''}
                      className={`border px-3 py-2 text-sm font-semibold tabular-nums transition-colors duration-600 ${dev === v ? 'border-accent bg-accent/10 text-accent' : 'border-text/15 text-text/75 hover:border-accent/40'}`}
                      style={{ clipPath: 'polygon(6px 0, calc(100% - 6px) 0, 100% 6px, 100% calc(100% - 6px), calc(100% - 6px) 100%, 6px 100%, 0 calc(100% - 6px), 0 6px)' }}
                    >
                      {v} SOL
                    </button>
                  ))}
                  <label className="flex items-center gap-2 border border-text/15 px-3 py-1.5" style={{ clipPath: 'polygon(6px 0, calc(100% - 6px) 0, 100% 6px, 100% calc(100% - 6px), calc(100% - 6px) 100%, 6px 100%, 0 calc(100% - 6px), 0 6px)' }}>
                    <input value={d.devBuy} onChange={(e) => up({ devBuy: e.target.value.replace(',', '.') })} inputMode="decimal" className="w-20 bg-transparent text-sm font-semibold tabular-nums outline-none" aria-label="Dev buy in SOL" aria-invalid={!devOk} />
                    <span className="text-sm text-text/60">SOL</span>
                  </label>
                </div>
                {!devOk && <p className="mt-2 text-xs text-raid">Dev buy must be a number from 0 to {MAX_DEV}.</p>}
                <div className="mt-5 divide-y divide-text/10 border-y border-text/10">
                  <Row label="Launch cost (now)" sub="Creating the coin on pump.fun and locking its fee split." value={`${LAUNCH_COST.toFixed(3)} SOL`} />
                  <Row label={theme.copy.launch.reserveLabel} sub={`Gas for her hourly ${theme.verbs.burn}, ${theme.verbs.store.split(' ')[0]} and ${theme.verbs.interact} transactions.`} value={`${QUEEN_RESERVE.toFixed(3)} SOL`} />
                  <Row label="Dev buy" sub="Bought at launch, the tokens go to your wallet." value={`${dev.toFixed(3)} SOL`} />
                  <Row label="You send" value={`${total.toFixed(3)} SOL`} strong />
                </div>
                <Note icon="✓">
                  <b>What you sign:</b> one plain SOL transfer of {total.toFixed(3)} SOL from your wallet to your {theme.unit}&rsquo;s {theme.agent} wallet. Nothing else.
                </Note>
                <Note icon="⬡">
                  <b>Fees:</b> your coin&rsquo;s creator fees go {pct(1 - theme.feeToHub)} to your {theme.agent}, {pct(theme.feeToHub)} to the hourly {theme.hubRitual} that buys {theme.hubToken.symbol}. Locked at launch.
                </Note>
                <label className="mt-3 flex cursor-pointer items-start gap-3 border border-raid/30 bg-raid/[0.07] p-4 text-sm leading-relaxed">
                  <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1 h-4 w-4 accent-[rgb(var(--c-accent))]" />
                  <span>
                    <b>My {theme.agent} acts on her own by these rules.</b> <span className="text-text/70">A meme, not an investment. I only use what I can afford to lose.</span>
                  </span>
                </label>
                <div className="mt-4 border border-accent/30 bg-accent/[0.06] p-4">
                  <div className="font-heading text-base font-semibold text-accent">◈ Last step: connect the wallet that will own the {theme.unit}</div>
                  <p className="mt-1 text-xs leading-relaxed text-text/65">Connecting signs nothing. Launching asks for one transfer. In this preview build the launch is simulated and nothing is sent.</p>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {publicKey ? (
                      <span className="shape-btn btn-ghost inline-flex h-9 items-center text-xs font-semibold">Connected {short(publicKey.toBase58())} ✓</span>
                    ) : (
                      <button onClick={() => setVisible(true)} data-sfx="open" className="shape-btn btn-ghost h-9 text-xs font-semibold">
                        Connect wallet
                      </button>
                    )}
                  </div>
                </div>
              </section>
            )}
            {err && <p className="mt-4 text-sm text-raid" role="alert">{err}</p>}
          </div>

          {/* live preview */}
          <aside className="scroll-thin hidden min-h-0 overflow-y-auto border-l border-accent/10 p-5 lg:block">
            <div className="mb-3 flex items-center gap-2 font-heading text-sm font-semibold">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-soft" /> Live preview
            </div>
            <QueenPreview look={d.look} speaking={bubble} className="h-56 border border-text/10" />
            <div className="mt-4 border border-text/10 bg-night/40 p-5">
              <div className="flex items-start gap-3">
                <div className="shape-hex h-14 w-12 shrink-0 overflow-hidden bg-accent/20">{image && <img src={image} alt="" className="h-full w-full object-cover" />}</div>
                <div className="min-w-0">
                  <div className="truncate font-heading text-2xl font-semibold text-accent">${d.ticker.trim() || 'TICKER'}</div>
                  <div className="truncate text-sm text-text/70">{d.name.trim() || `Your ${theme.unit}`}</div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Chip>◆ {dipName}</Chip>
                <Chip>⬢ {swarmName}</Chip>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Stat k="Dev buy" v={`${dev.toFixed(2)} SOL`} />
                <Stat k="You send" v={`${total.toFixed(3)} SOL`} />
                <Stat k={`${cap(theme.verbs.burn)}s`} v={sum.seal} />
                <Stat k={`${cap(theme.verbs.interact)}s`} v={sum.swarm} />
                <Stat k={`${cap(theme.verbs.interact)} size`} v={sum.size} />
                <Stat k="Cell" v={launchCell && cellFree ? `ring ${ring}` : 'next free'} />
              </dl>
              <p className="mt-4 text-xs text-accent/90">Her rules are public on your {theme.unit}&rsquo;s page. Every action is logged with its tx.</p>
            </div>
          </aside>
        </div>

        {/* footer */}
        <div className="flex items-center justify-between gap-3 border-t border-accent/10 px-4 py-3 sm:px-6">
          {d.step > 0 ? (
            <button onClick={() => go(d.step - 1)} data-sfx="none" className="shape-btn btn-ghost h-11 font-heading text-base font-semibold">
              Back
            </button>
          ) : (
            <span />
          )}
          <span className="font-heading text-sm font-semibold text-text/55">
            Step {d.step + 1} of {STEPS.length}
          </span>
          {d.step < 4 ? (
            <button onClick={() => go(d.step + 1)} data-sfx="none" className="shape-btn btn-honey h-11 font-heading text-base font-semibold">
              Next
            </button>
          ) : (
            <button onClick={launch} disabled={busy} data-sfx="none" className={`shape-btn btn-honey h-11 font-heading text-base font-semibold ${busy ? 'opacity-60' : ''}`}>
              {busy ? 'Founding…' : publicKey ? theme.copy.launch.cta : 'Connect wallet'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- pieces ---------- */
function StepTitle({ icon, title, sub }: { icon: string; title: string; sub?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h3 className="flex items-center gap-2 font-heading text-xl font-semibold tracking-tight">
        <span className="text-accent">{icon}</span> {title}
      </h3>
      {sub && <span className="text-sm text-text/55">{sub}</span>}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <div className="mb-1.5 font-heading text-sm font-semibold">
        {label} {hint && <span className="text-xs font-normal text-text/50">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Swatches({ colors, value, onPick }: { colors: string[]; value: string; onPick: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {colors.map((c) => (
        <button
          key={c}
          onClick={() => onPick(c)}
          data-sfx="swatch"
          aria-label={c}
          aria-pressed={value.toLowerCase() === c.toLowerCase()}
          className={`h-9 w-9 rounded-lg border-2 transition-transform duration-300 hover:scale-110 ${value.toLowerCase() === c.toLowerCase() ? 'border-accent ring-2 ring-accent/40' : 'border-text/15'}`}
          style={{ background: c }}
        />
      ))}
    </div>
  );
}

function Cycler<T extends string>({ options, value, onPick }: { options: readonly { id: T; label: string }[]; value: T; onPick: (v: T) => void }) {
  const i = Math.max(0, options.findIndex((o) => o.id === value));
  const step = (dir: number) => onPick(options[(i + dir + options.length) % options.length].id);
  return (
    <div className="flex items-center gap-2">
      <button onClick={() => step(-1)} data-sfx="swatch" className="flex h-10 w-10 items-center justify-center rounded-lg border border-text/15 hover:border-accent/50" aria-label="Previous">
        ‹
      </button>
      <div className="flex h-10 flex-1 items-center justify-center rounded-lg border border-text/15 bg-night/40 font-heading text-base font-semibold" aria-live="polite">
        {options[i].label}
      </div>
      <button onClick={() => step(1)} data-sfx="swatch" className="flex h-10 w-10 items-center justify-center rounded-lg border border-text/15 hover:border-accent/50" aria-label="Next">
        ›
      </button>
    </div>
  );
}

const RISK: Record<Risk, string> = {
  low: 'border-soft/40 bg-soft/10 text-soft',
  medium: 'border-accent/50 bg-accent/10 text-accent',
  high: 'border-raid/50 bg-raid/10 text-raid',
  extreme: 'border-raid bg-raid text-night',
};

function OptionCard({ active, onClick, icon, title, body, risk, foot }: { active: boolean; onClick: () => void; icon: string; title: string; body: string; risk?: Risk; foot?: string }) {
  return (
    <button
      onClick={onClick}
      data-sfx="select"
      aria-pressed={active}
      className={`flex h-full gap-3 border-2 p-4 text-left transition-colors duration-600 ${active ? 'border-accent bg-accent/10' : 'border-text/10 bg-night/30 hover:border-accent/40'}`}
      style={{ clipPath: 'polygon(10px 0, calc(100% - 10px) 0, 100% 10px, 100% calc(100% - 10px), calc(100% - 10px) 100%, 10px 100%, 0 calc(100% - 10px), 0 10px)' }}
    >
      <span className="mt-0.5 text-lg text-accent">{icon}</span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2 font-heading text-base font-semibold">
          {title}
          {risk && <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${RISK[risk]}`}>{risk} risk</span>}
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-text/70">{body}</span>
        {foot && <span className="mt-1.5 block text-xs font-semibold text-accent/90">{foot}</span>}
      </span>
    </button>
  );
}

function Meter({ label, value, fill, warn = false }: { label: string; value: string; fill: number; warn?: boolean }) {
  return (
    <div className="border border-text/10 bg-night/30 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-text/75">{label}</span>
        <span className={`font-heading text-lg font-semibold ${warn ? 'text-raid' : 'text-accent'}`}>{value}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-text/10">
        <div className={`h-full rounded-full transition-all duration-900 ${warn ? 'bg-raid' : 'bg-gradient-to-r from-soft to-accent'}`} style={{ width: `${Math.round(Math.max(0.03, Math.min(1, fill)) * 100)}%` }} />
      </div>
    </div>
  );
}

function Slider({ label, value, shown, lim, onChange, help }: { label: string; value: number; shown: string; lim: { min: number; max: number; step: number }; onChange: (v: number) => void; help: string }) {
  const p = ((value - lim.min) / (lim.max - lim.min)) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm">{label}</span>
        <span className="font-heading text-base font-semibold text-accent">{shown}</span>
      </div>
      <input
        type="range"
        min={lim.min}
        max={lim.max}
        step={lim.step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="wiz-range mt-3"
        style={{ ['--p' as string]: `${p}%` }}
        aria-label={label}
      />
      <p className="mt-2 text-xs leading-relaxed text-text/55">{help}</p>
    </div>
  );
}

function Toggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={active} data-sfx="toggle" className={`rounded-lg border px-3 py-2 font-heading text-sm font-semibold transition-colors duration-600 ${active ? 'border-accent bg-accent/10 text-text' : 'border-text/15 text-text/70 hover:border-accent/40'}`}>
      {children}
    </button>
  );
}

function Row({ label, sub, value, strong = false }: { label: string; sub?: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <div className={strong ? 'font-heading text-lg font-semibold text-accent' : 'text-sm font-semibold'}>{label}</div>
        {sub && <div className="mt-0.5 text-xs text-text/55">{sub}</div>}
      </div>
      <div className={`shrink-0 font-heading tabular-nums ${strong ? 'text-lg font-semibold text-accent' : 'text-base font-semibold text-accent/90'}`}>{value}</div>
    </div>
  );
}

function Note({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 flex gap-3 border border-text/10 bg-night/30 p-4 text-sm leading-relaxed text-text/75">
      <span className="text-accent">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-md border border-text/15 bg-night/40 px-2.5 py-1 font-heading text-xs font-semibold">{children}</span>;
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-text/55">{k}</dt>
      <dd className="font-heading font-semibold text-accent">{v}</dd>
    </div>
  );
}
