'use client';
/**
 * The five launch steps as they happen: Reserve cell · Pay · Upload · Create coin · Live.
 * Pure view: the wizard owns the flow and passes the latest server status plus callbacks for
 * Pay / Retry / Refund / Dismiss. Transaction links go to Solscan (live) or are marked simulated (mock).
 */
import type { LaunchMode, LaunchStatusResponse } from '@/lib/shared/api';
import type { Cell } from '@/lib/types';
import { addrUrl, pumpUrl, short, txUrl } from '@/lib/format';
import { hexDistance } from '@/lib/hex';
import { useNow } from '@/lib/useNow';
import { theme } from '@/themes';

export type LaunchPhase = 'sign' | 'prepare' | 'pay' | 'confirm' | 'done';

export interface LaunchProgressProps {
  mode: LaunchMode;
  phase: LaunchPhase;
  status: LaunchStatusResponse | null;
  /** From prepare (or the launch saved in this browser). */
  reservation: { cell: Cell; cellChanged: boolean; queenWallet: string; lamports: number; expiresAt: number } | null;
  /** A problem on this side (wallet declined, server unreachable). Server problems arrive in `status.error`. */
  error?: string;
  busy?: boolean;
  canPay?: boolean;
  /** Expired with no payment on record, but SOL sits in the queen wallet: offer Refund anyway. */
  stranded?: boolean;
  onPay?: () => void;
  onRetry?: () => void;
  onRefund?: () => void;
  onDismiss?: () => void;
  onOpenHive?: () => void;
}

type StepState = 'todo' | 'active' | 'done' | 'failed' | 'skipped';
const STEP_LABELS = ['Reserve cell', 'Pay', 'Upload', 'Create coin', 'Live'] as const;
const sol = (lamports: number) => `${(lamports / 1e9).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} SOL`;

/** Which step a failed / refunded launch stopped at. */
function stoppedAt(s: LaunchStatusResponse): number {
  if (s.state === 'expired') return 1;
  if (!s.txs.payment && s.mode === 'live') return 1;
  if (/upload/i.test(s.error ?? '')) return 2;
  return 3;
}

function currentStep(phase: LaunchPhase, s: LaunchStatusResponse | null, hasReservation: boolean, mode: LaunchMode): number {
  if (!s) return hasReservation ? (mode === 'live' ? 1 : 2) : 0;
  switch (s.state) {
    case 'reserved':
      return 1;
    case 'paid':
      return 2;
    case 'metadata':
      return 3;
    case 'created':
      return 4;
    case 'live':
      return 5;
    default:
      return stoppedAt(s);
  }
}

export default function LaunchProgress(p: LaunchProgressProps) {
  const now = useNow(1000);
  const s = p.status;
  const r = p.reservation;
  const live = p.mode === 'live';
  const cur = currentStep(p.phase, s, !!r, p.mode);
  const stopped = !!s && (s.state === 'failed' || s.state === 'expired' || s.state === 'refunded');
  const problem = p.error || s?.error;
  const waitingPayment = !!s && s.state === 'reserved' && !!s.txs.payment;

  const states: StepState[] = STEP_LABELS.map((_, i) => (i < cur ? 'done' : i === cur ? (stopped ? 'failed' : 'active') : 'todo'));
  if (!live) states[1] = cur > 1 || s?.state === 'live' ? 'skipped' : states[1];
  if (s?.state === 'live') states.fill('done').splice(1, 1, live ? 'done' : 'skipped');

  const cell = s?.cell ?? r?.cell;
  const queen = s?.queenWallet ?? r?.queenWallet;
  const expiresIn = r && s?.state === 'reserved' && !s.txs.payment && now ? Math.max(0, r.expiresAt - now) : null;
  const refundable = !!s && (s.state === 'failed' || (s.state === 'expired' && (!!s.txs.payment || !!p.stranded)));
  const canRetry = !!p.onRetry && !stopped && s?.state !== 'live' && !!problem && !p.canPay;

  const tx = (sig: string | undefined, label: string) =>
    !sig ? null : live ? (
      <a href={txUrl(sig)} target="_blank" rel="noreferrer" className="text-accent hover:underline">
        {label} ↗
      </a>
    ) : (
      <span className="text-text/50" title="Preview launch: simulated transaction">
        {label} (simulated)
      </span>
    );

  const detail: React.ReactNode[] = [
    <>
      {cell ? (
        <>
          Cell {cell.q},{cell.r} · ring {hexDistance(cell, { q: 0, r: 0 })}
          {expiresIn !== null && live && <span className="text-text/50"> · held for {Math.floor(expiresIn / 60000)}:{String(Math.floor((expiresIn % 60000) / 1000)).padStart(2, '0')}</span>}
        </>
      ) : (
        `Finding a free cell on the edge of the ${theme.scene}…`
      )}
      {r?.cellChanged && <span className="mt-1 block text-accent">The cell you picked was just taken, so your {theme.unit} got the nearest free one.</span>}
    </>,
    live ? (
      <>
        {r ? `${sol(r.lamports)} to your ${theme.agent} wallet ` : `One transfer to your ${theme.agent} wallet `}
        {queen && (
          <a href={addrUrl(queen)} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            {short(queen)} ↗
          </a>
        )}
        {s?.txs.payment && <span className="block">{tx(s.txs.payment, waitingPayment ? 'Payment sent, waiting for confirmation' : 'Payment')}</span>}
      </>
    ) : (
      'Preview: nothing to pay, no SOL moves.'
    ),
    'Coin image and details to IPFS.',
    <>
      {live ? `pump.fun create, with the ${theme.agent} wallet as creator.` : `Simulated pump.fun create by the ${theme.agent} wallet.`}
      {s?.txs.create && <span className="block">{tx(s.txs.create, 'Create transaction')}</span>}
      {s?.ca && live && (
        <a href={pumpUrl(s.ca)} target="_blank" rel="noreferrer" className="block text-accent hover:underline">
          {short(s.ca, 6)} on pump.fun ↗
        </a>
      )}
    </>,
    <>
      {`On the ${theme.scene} for everyone.`}
      {s?.txs.devTransfer && <span className="block">{tx(s.txs.devTransfer, 'Dev-buy tokens sent to you')}</span>}
    </>,
  ];

  const activeText =
    p.phase === 'sign'
      ? 'Sign the message in your wallet (free).'
      : p.phase === 'prepare'
        ? 'Reserving your cell…'
        : p.phase === 'pay' && !p.canPay
          ? 'Approve the transfer in your wallet.'
          : waitingPayment
            ? 'Waiting for the payment to confirm…'
            : null;

  return (
    <section aria-live="polite">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="flex items-center gap-2 font-heading text-xl font-semibold tracking-tight">
          <span className="text-accent">⬢</span> {s?.state === 'live' ? `Your ${theme.unit} is live` : s?.state === 'refunded' ? 'Refunded' : stopped ? 'Launch stopped' : 'Launching'}
        </h3>
        {!live && <span className="rounded border border-accent/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent">preview</span>}
      </div>

      <ol className="mt-4 space-y-2">
        {STEP_LABELS.map((label, i) => {
          const st = states[i];
          const icon = st === 'done' ? '✓' : st === 'failed' ? '✕' : st === 'skipped' ? '–' : String(i + 1);
          return (
            <li key={label} className={`flex gap-3 border p-3 transition-colors duration-600 ${st === 'active' ? 'border-accent/60 bg-accent/[0.07]' : st === 'failed' ? 'border-raid/50 bg-raid/[0.06]' : 'border-text/10 bg-night/30'}`}>
              <span
                className={`shape-hex flex h-8 w-8 shrink-0 items-center justify-center text-xs font-semibold ${
                  st === 'done' ? 'bg-soft/80 text-night' : st === 'active' ? 'bg-accent text-night' : st === 'failed' ? 'bg-raid text-night' : 'bg-text/10 text-text/60'
                } ${st === 'active' && (p.busy || p.phase !== 'done') && !problem ? 'animate-pulse' : ''}`}
                aria-hidden
              >
                {icon}
              </span>
              <div className="min-w-0 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-2 font-heading font-semibold">
                  {label}
                  <span className="text-xs font-normal text-text/50">{st === 'done' ? 'done' : st === 'active' ? (problem ? 'needs you' : 'in progress') : st === 'failed' ? 'stopped' : st === 'skipped' ? 'skipped' : ''}</span>
                </div>
                <div className="mt-0.5 break-words text-xs leading-relaxed text-text/65">{detail[i]}</div>
                {st === 'active' && activeText && i === cur && <div className="mt-1 text-xs font-semibold text-accent">{activeText}</div>}
              </div>
            </li>
          );
        })}
      </ol>

      {s?.state === 'refunded' && (
        <div className="mt-3 border border-soft/40 bg-soft/10 p-3 text-sm">
          The SOL in the {theme.agent} wallet went back to you. {tx(s.txs.refund, 'Refund transaction')}
        </div>
      )}

      {problem && s?.state !== 'refunded' && (
        <p className={`mt-3 text-sm ${waitingPayment && !p.error ? 'text-text/70' : 'text-raid'}`} role="alert">
          {problem}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {s?.state === 'live' && p.onOpenHive && (
          <button onClick={p.onOpenHive} className="shape-btn btn-honey h-10 font-heading text-sm font-semibold">
            Go to my {theme.unit}
          </button>
        )}
        {p.canPay && p.onPay && (
          <button onClick={p.onPay} disabled={p.busy} className={`shape-btn btn-honey h-10 font-heading text-sm font-semibold ${p.busy ? 'opacity-60' : ''}`}>
            {r ? `Pay ${sol(r.lamports)}` : 'Pay'}
          </button>
        )}
        {canRetry && (
          <button onClick={p.onRetry} disabled={p.busy} className={`shape-btn btn-honey h-10 font-heading text-sm font-semibold ${p.busy ? 'opacity-60' : ''}`}>
            {p.busy ? 'Working…' : 'Retry'}
          </button>
        )}
        {refundable && p.onRefund && (
          <button onClick={p.onRefund} disabled={p.busy} className={`shape-btn btn-ghost h-10 font-heading text-sm font-semibold ${p.busy ? 'opacity-60' : ''}`}>
            Refund
          </button>
        )}
        {p.onDismiss && (stopped || s?.state === 'live' || (!s?.txs.payment && !p.busy && (p.canPay || !!p.error))) && (
          <button onClick={p.onDismiss} disabled={p.busy} className="shape-btn btn-ghost h-10 font-heading text-sm font-semibold">
            {s?.state === 'live' ? 'Launch another' : stopped ? 'Start over' : 'Cancel launch'}
          </button>
        )}
      </div>
      {live && !stopped && s?.state !== 'live' && (
        <p className="mt-3 text-xs leading-relaxed text-text/50">You can close this window: the launch is saved in this browser and picks up where it left off when you come back.</p>
      )}
    </section>
  );
}
