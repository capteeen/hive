'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useUI } from '@/lib/ui';
import { useHive } from '@/lib/store';
import { LAUNCH_COST, QUEEN_RESERVE } from '@/lib/sim';
import { theme } from '@/themes';
import HexButton from './HexButton';
import { short } from '@/lib/format';

export default function LaunchModal() {
  const open = useUI((s) => s.launchOpen);
  const close = useUI((s) => s.closeLaunch);
  const found = useHive((s) => s.found);
  const router = useRouter();
  const { publicKey, signMessage } = useWallet();
  const { setVisible } = useWalletModal();
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [desc, setDesc] = useState('');
  const [tg, setTg] = useState('');
  const [devBuy, setDevBuy] = useState('');
  const [image, setImage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, close]);

  const dev = Math.max(0, parseFloat(devBuy) || 0);
  const total = useMemo(() => LAUNCH_COST + QUEEN_RESERVE + dev, [dev]);
  const valid = name.trim().length >= 2 && /^[A-Za-z0-9]{2,8}$/.test(ticker.trim());

  if (!open) return null;

  const onFile = (f?: File) => {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setImage(String(r.result));
    r.readAsDataURL(f);
  };

  const launch = async () => {
    if (!publicKey) {
      setVisible(true);
      return;
    }
    setBusy(true);
    setErr('');
    try {
      // Phase 1: mock. Phase 2 (TODO): POST /api/launch → server creates the queen keypair,
      // user pays `total` to it, server launches via PumpPortal with the queen as creator.
      if (signMessage) {
        try {
          await signMessage(new TextEncoder().encode(`${theme.name}: found "${name.trim()}" ($${ticker.trim().toUpperCase()}) — mock launch, nothing is sent.`));
        } catch {
          /* user may decline to sign in the mock; proceed anyway */
        }
      }
      await new Promise((r) => setTimeout(r, 900));
      const h = found({ name: name.trim(), ticker: ticker.trim(), image, description: desc, devBuy: dev });
      close();
      setName('');
      setTicker('');
      setDesc('');
      setTg('');
      setDevBuy('');
      setImage('');
      router.push(`/comb?focus=${h.ca}`);
    } catch (e) {
      setErr((e as Error).message ?? 'Launch failed');
    } finally {
      setBusy(false);
    }
  };

  const Row = ({ label, value, bold = false }: { label: string; value: string; bold?: boolean }) => (
    <div className={`flex items-center justify-between py-2 text-sm ${bold ? 'font-heading text-base font-semibold' : 'text-text/75'}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-night/70 p-0 backdrop-blur-sm sm:items-center sm:p-6" onClick={close} role="dialog" aria-modal>
      <div className="shape-card glass fade-up max-h-[92vh] w-full max-w-2xl overflow-y-auto scroll-thin bg-surface/90 p-6 sm:p-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-text/55">pump.fun · Solana</div>
            <h2 className="mt-1 font-heading text-3xl font-semibold tracking-tight">{theme.copy.launch.title}</h2>
          </div>
          <button onClick={close} className="shape-hex flex h-9 w-9 items-center justify-center bg-accent/10 text-text/70 hover:bg-accent/20" aria-label="Close">
            ×
          </button>
        </div>

        <div className="mt-6 grid gap-5 sm:grid-cols-[120px_1fr]">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="shape-hex relative aspect-square w-[120px] bg-accent/10 text-xs text-text/60 hover:bg-accent/20"
            style={image ? { backgroundImage: `url(${image})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
          >
            {!image && <span className="absolute inset-0 flex items-center justify-center">Image</span>}
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          <div className="grid gap-3">
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="Amber Comb" className="inp" />
            </Field>
            <Field label="Ticker">
              <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} maxLength={8} placeholder="AMBER" className="inp uppercase" />
            </Field>
          </div>
        </div>
        <div className="mt-3 grid gap-3">
          <Field label="Description">
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} maxLength={280} placeholder={`What is this ${theme.unit} about?`} className="inp resize-none" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Telegram (optional)">
              <input value={tg} onChange={(e) => setTg(e.target.value)} placeholder="t.me/…" className="inp" />
            </Field>
            <Field label="Dev buy (SOL, optional)">
              <input value={devBuy} onChange={(e) => setDevBuy(e.target.value)} inputMode="decimal" placeholder="0.5" className="inp" />
            </Field>
          </div>
        </div>

        <div className="mt-6 divide-y divide-accent/10 border-y border-accent/10">
          <Row label="Launch cost (now)" value={`${LAUNCH_COST.toFixed(3)} SOL`} />
          <Row label={theme.copy.launch.reserveLabel} value={`${QUEEN_RESERVE.toFixed(3)} SOL`} />
          <Row label="Dev buy" value={`${dev.toFixed(3)} SOL`} />
          <Row label="You pay" value={`${total.toFixed(3)} SOL`} bold />
        </div>
        <p className="mt-4 text-xs leading-relaxed text-text/60">{theme.copy.launch.sentence}</p>
        {err && <p className="mt-3 text-sm text-raid">{err}</p>}
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          {!publicKey ? (
            <HexButton variant="ghost" onClick={() => setVisible(true)}>
              Connect wallet
            </HexButton>
          ) : (
            <span className="shape-btn btn-ghost inline-flex h-11 items-center text-xs">{short(publicKey.toBase58())}</span>
          )}
          <HexButton onClick={launch} disabled={!valid || busy} className={!valid || busy ? 'opacity-50' : ''}>
            {busy ? 'Founding…' : theme.copy.launch.cta}
          </HexButton>
        </div>
      </div>
      <style jsx global>{`
        .inp {
          width: 100%;
          background: rgb(var(--c-base) / 0.6);
          box-shadow: inset 0 0 0 1px rgb(var(--c-accent) / 0.25);
          padding: 10px 12px;
          font-size: 14px;
          color: rgb(var(--c-text));
          outline: none;
          transition: box-shadow 600ms;
          clip-path: polygon(8px 0, calc(100% - 8px) 0, 100% 8px, 100% calc(100% - 8px), calc(100% - 8px) 100%, 8px 100%, 0 calc(100% - 8px), 0 8px);
        }
        html[data-shape='circle'] .inp {
          clip-path: none;
          border-radius: 12px;
        }
        .inp:focus {
          box-shadow: inset 0 0 0 1px rgb(var(--c-accent) / 0.7), inset 0 0 18px rgb(var(--c-accent) / 0.12);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-[0.16em] text-text/55">{label}</span>
      {children}
    </label>
  );
}
