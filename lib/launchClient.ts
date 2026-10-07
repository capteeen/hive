/**
 * Browser client for the launch API (POST /api/launch, /confirm, /refund, GET /api/launch/[id]).
 * A plain module (no 'use client'): `refundMessage` is also imported by the server so both sides
 * sign / verify the exact same text. Browser-only helpers touch window APIs only when called.
 */
import { theme } from '@/themes';
import type { Cell } from './types';
import type { LaunchMode, LaunchPayload, LaunchPrepareResponse, LaunchState, LaunchStatusResponse, PublicConfig } from './shared/api';

/** The exact message the owner signs to ask for a refund of launch `id`. */
export const refundMessage = (launchId: string) => `HIVE refund ${launchId}`;

/** A failed API call. `network` = the server could not be reached at all (or has no launch API). */
export class LaunchApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reasons?: string[],
    readonly network = false,
  ) {
    super(message);
    this.name = 'LaunchApiError';
  }
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: 'no-store', headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  } catch {
    throw new LaunchApiError('Could not reach the server. Check your connection.', 0, undefined, true);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON (e.g. an HTML error page) */
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: unknown; reasons?: unknown };
    const message = typeof b.error === 'string' ? b.error : `Server error (${res.status}).`;
    const reasons = Array.isArray(b.reasons) ? b.reasons.filter((r): r is string => typeof r === 'string') : undefined;
    // A 404 without our JSON error means the launch API is not deployed here: treat like unreachable.
    throw new LaunchApiError(message, res.status, reasons, res.status === 404 && typeof b.error !== 'string');
  }
  return body as T;
}

let configPromise: Promise<PublicConfig> | null = null;
/** Server config (launch mode, costs). Cached; a failure is not cached so the next call retries. */
export function getConfig(force = false): Promise<PublicConfig> {
  if (!configPromise || force) {
    configPromise = call<PublicConfig>('/api/config').catch((e) => {
      configPromise = null;
      throw e;
    });
  }
  return configPromise;
}

export const prepareLaunch = (payload: LaunchPayload, signature?: string) =>
  call<LaunchPrepareResponse>('/api/launch', { method: 'POST', body: JSON.stringify({ payload, signature }) });

export const confirmLaunch = (id: string, signature?: string) =>
  call<LaunchStatusResponse>(`/api/launch/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: JSON.stringify(signature ? { signature } : {}) });

export const launchStatus = (id: string) => call<LaunchStatusResponse>(`/api/launch/${encodeURIComponent(id)}`);

export const refundLaunch = (id: string, signature?: string) =>
  call<LaunchStatusResponse>(`/api/launch/${encodeURIComponent(id)}/refund`, { method: 'POST', body: JSON.stringify(signature ? { signature } : {}) });

export const TERMINAL: readonly LaunchState[] = ['live', 'failed', 'expired', 'refunded'];
export const isTerminal = (s: LaunchState) => TERMINAL.includes(s);
/** Payment sent, server holds its signature, not confirmed yet. */
export const awaitingPayment = (s: LaunchStatusResponse) => s.state === 'reserved' && !!s.txs.payment;
/** Stuck until the user does something (retry, pay, refund). */
export const needsAction = (s: LaunchStatusResponse) => isTerminal(s.state) || (!!s.error && !awaitingPayment(s));

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Follow a launch until it needs the user (terminal state, or an error to retry). Uses backoff
 * (1 s → 8 s). While a payment is unconfirmed it calls confirm (status alone never verifies), and if
 * the launch sits still without an error for `resumeAfterMs` (a confirm run died), it calls confirm
 * again to resume it; the server's lock makes that safe. Network errors are retried until `timeoutMs`.
 */
export async function pollLaunch(
  id: string,
  opts: { onUpdate?: (s: LaunchStatusResponse) => void; signal?: AbortSignal; timeoutMs?: number; resumeAfterMs?: number; initial?: LaunchStatusResponse } = {},
): Promise<LaunchStatusResponse | null> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const resumeAfterMs = opts.resumeAfterMs ?? 90_000;
  let last: LaunchStatusResponse | null = opts.initial ?? null;
  let lastChange = Date.now();
  let delay = 1000;
  while (!opts.signal?.aborted && Date.now() - start < timeoutMs) {
    await sleep(delay, opts.signal);
    if (opts.signal?.aborted) break;
    delay = Math.min(8000, Math.round(delay * 1.5));
    try {
      const stale = last && !last.error && Date.now() - lastChange > resumeAfterMs;
      const s = last && (awaitingPayment(last) || stale) ? await confirmLaunch(id) : await launchStatus(id);
      if (!last || s.state !== last.state || s.error !== last.error) {
        lastChange = Date.now();
        delay = 1000;
      }
      last = s;
      opts.onUpdate?.(s);
      if (needsAction(s)) return s;
    } catch (e) {
      // the launch is gone or invalid: nothing to wait for
      if (e instanceof LaunchApiError && !e.network && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
    }
  }
  return last;
}

/* ---------- the launch in progress, remembered across reloads ---------- */

export interface PendingLaunch {
  id: string;
  mode: LaunchMode;
  owner: string;
  queenWallet: string;
  lamports: number;
  cell: Cell;
  cellChanged: boolean;
  expiresAt: number;
  startedAt: number;
  /** Payment transaction we sent (live), and the blockhash it used (to tell a dropped one). */
  paySig?: string;
  payBlockhash?: string;
}

const PENDING_KEY = `${theme.id}:pending-launch`;

export function loadPending(): PendingLaunch | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingLaunch>;
    if (typeof p.id !== 'string' || typeof p.queenWallet !== 'string' || typeof p.lamports !== 'number' || !p.cell) return null;
    return p as PendingLaunch;
  } catch {
    return null;
  }
}

export function savePending(p: PendingLaunch) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    /* storage full or blocked: the launch still works, it just cannot resume after a reload */
  }
}

export function clearPending() {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {}
}

/* ---------- resuming and forgetting a launch that may hold a payment ---------- */

/** Solana's base fee: a queen wallet holding no more than this has nothing to refund. */
export const BASE_FEE_LAMPORTS = 5000;

/**
 * The browser holds a payment signature (live) that the server has not recorded for this launch.
 * That signature may be the only record of SOL sitting in the queen wallet, so such a launch is
 * never forgotten before the server has seen it.
 */
export const paymentUnheard = (p: PendingLaunch | null | undefined, s: LaunchStatusResponse | null | undefined): p is PendingLaunch & { paySig: string } =>
  !!p?.paySig && p.mode === 'live' && s?.txs.payment !== p.paySig && s?.state !== 'live' && s?.state !== 'refunded';

/**
 * First call when a saved launch is reopened. With a payment signature saved here, hand it over
 * (confirm) instead of only reading the status: the confirm that carried it may never have arrived
 * (tab closed, a wallet deep link reloaded the page, network), and a status read past the reservation
 * deadline would expire a launch whose payment the server never heard of, leaving nothing to refund.
 * Confirm with the signature continues the launch, or records the late payment so it can be refunded.
 */
export const resumeLaunch = (p: PendingLaunch) => (p.paySig ? confirmLaunch(p.id, p.paySig) : launchStatus(p.id));

/**
 * Ask before forgetting a launch (Cancel / Start over). Returns `{ forget: true }` when it can be
 * dropped, or the server's new status when the saved payment turned out to matter (keep the launch:
 * continue or refund it). Throws when the server could not be asked: keep the launch and show why.
 */
export async function checkBeforeForget(p: PendingLaunch | null | undefined, s: LaunchStatusResponse | null | undefined): Promise<{ forget: true } | { forget: false; status: LaunchStatusResponse }> {
  if (!paymentUnheard(p, s)) return { forget: true };
  try {
    const next = await confirmLaunch(p.id, p.paySig);
    if (next.state === 'live' || next.txs.payment === p.paySig) return { forget: false, status: next };
    // The server looked at it and cannot use it (failed on chain, wrong amount, spent elsewhere).
    return { forget: true };
  } catch (e) {
    // The server answered for this launch and refused it for good (unknown launch, not a signature).
    // 409 (the server switched modes) and 429 are temporary: keep the launch for when it is back.
    if (e instanceof LaunchApiError && !e.network && e.status >= 400 && e.status < 500 && e.status !== 409 && e.status !== 429) return { forget: true };
    throw e;
  }
}
