import 'server-only';
/**
 * The launch state machine.
 *
 *   reserved ──pay──▶ paid ──upload──▶ metadata ──create──▶ created ──dev tokens + hive──▶ live
 *      │                 │                  │
 *      ▼                 ▼ (5 failures)     ▼ (5 failures)
 *   expired            failed ◀────────────┘          failed / expired (paid) ──refund──▶ refunded
 *
 * - prepare: validate, prove wallet ownership (live), rate-limit, generate the queen + mint keys,
 *   reserve a cell and quote the exact lamports to pay to the queen wallet.
 * - confirm: idempotent and resumable. Runs under `db.lock('launch:<id>')` and every transition is
 *   a compare-and-set on the previous state, so two confirms can never both send. Before (re)sending
 *   `create`, the mint account is checked on chain: a create that landed after a lost response is
 *   treated as success, never repeated. The mint keypair is fixed at prepare, so even a racing
 *   duplicate create would fail on chain rather than make a second coin.
 * - status: read-only, except that a reservation past its deadline is expired (and its cell freed).
 * - refund: owner-signed; returns the queen wallet's SOL for launches that failed or expired after
 *   the payment arrived. Fails closed: never while a create could still land or while the chain
 *   cannot say whether the coin exists.
 *
 * Responses never include secret keys (only `toStatus` shapes what leaves this module).
 */
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  LIMITS,
  isBase58Address,
  launchMessage,
  validateLaunchPayload,
  type LaunchMode,
  type LaunchPayload,
  type LaunchPrepareResponse,
  type LaunchStatusResponse,
  type RemoteHive,
} from '@/lib/shared/api';
import { DEFAULT_LOOK, clampRules, isLook } from '@/lib/queen';
import { refundMessage } from '@/lib/launchClient';
import { theme } from '@/themes';
import { config, liveModeProblems } from './config';
import { getDb, type Db, type LaunchRecord } from './db';
import { BASE_FEE_LAMPORTS, TxError, getChain, type Chain } from './chain';
import { claimLaunchCell } from './cells';
import { keypairFromEnc, newKeypair } from './keys';
import { rateLimit } from './ratelimit';

/* ---------------- knobs ---------------- */
export const MAX_ATTEMPTS = 5;
/** Confirm runs up to the route's maxDuration (60 s); the lock outlives it so a killed run cannot be doubled. */
const LOCK_MS = 75_000;
/** A reservation whose payment signature we already hold gets this much longer to confirm. */
const PAYMENT_GRACE_MS = 10 * 60 * 1000;
/**
 * A failed launch that ever signed a `create` is not refunded until this long after it failed. A
 * create that timed out may still land while its blockhash lives (~150 slots, 60–90 s, and it was
 * fetched before the 50 s confirm wait); refunding first would drain the queen of a coin that then
 * exists. After the wait the mint check below is final.
 */
export const CREATE_SETTLE_MS = 3 * 60 * 1000;
export const RATE = {
  prepareIp: { limit: 12, windowMs: 10 * 60 * 1000 },
  prepareOwner: { limit: 6, windowMs: 10 * 60 * 1000 },
  confirmIp: { limit: 40, windowMs: 60 * 1000 },
  statusIp: { limit: 120, windowMs: 60 * 1000 },
  refundIp: { limit: 10, windowMs: 10 * 60 * 1000 },
};
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/**
 * Clears `error` in a patch. An empty string rather than `undefined`, because a JSON-backed store
 * (Supabase) drops undefined keys and would keep the stale message. `toStatus` maps it back to undefined.
 */
const NO_ERROR = '';
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/** An error with an HTTP status for the route handlers. `reasons` lists every problem when there are several. */
export class LaunchError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly reasons?: string[],
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LaunchError';
  }
}

/** Dependencies; everything defaults to the real thing. Tests pass fakes. */
export interface LaunchCtx {
  db?: Db;
  chain?: Chain;
  mode?: LaunchMode;
  /** Fixed clock (ms) for tests. */
  now?: number;
  /** Client IP, for rate limiting. */
  ip?: string;
  /** Live-mode configuration problems (defaults to liveModeProblems()). */
  problems?: string[];
  costs?: { launchCost: number; queenReserve: number; maxDevBuy: number };
}

interface Deps {
  db: Db;
  chain: () => Promise<Chain>;
  mode: LaunchMode;
  now: () => number;
}

async function deps(ctx: LaunchCtx): Promise<Deps> {
  const db = ctx.db ?? (await getDb());
  let chain: Promise<Chain> | null = ctx.chain ? Promise.resolve(ctx.chain) : null;
  return {
    db,
    chain: () => (chain ??= getChain()),
    mode: ctx.mode ?? config.launchMode,
    now: () => ctx.now ?? Date.now(),
  };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 240);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** SOL → lamports, rounded up, immune to float dust (0.07 * 1e9 = 70000000.00000001). */
export function lamportsFor(sol: number) {
  return Math.ceil(Number((sol * 1e9).toFixed(3)));
}

function rate(key: string, r: { limit: number; windowMs: number }, now: number, what: string) {
  const res = rateLimit(key, r.limit, r.windowMs, now);
  if (!res.ok) throw new LaunchError(`Too many ${what}. Try again in ${Math.ceil(res.retryAfterMs / 1000)} s.`, 429, undefined, res.retryAfterMs);
}

/** Verify a base58 ed25519 signature by `owner` over `message`. */
export function verifyOwnerSignature(owner: string, message: string, signature: unknown): boolean {
  if (typeof signature !== 'string' || !SIG_RE.test(signature) || !isBase58Address(owner)) return false;
  try {
    const sig = bs58.decode(signature);
    const pk = bs58.decode(owner);
    if (sig.length !== 64 || pk.length !== 32) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pk);
  } catch {
    return false;
  }
}

/** pump.fun wants full URLs. Accept `t.me/x`, `x.com/x`, `@handle` or an https URL; anything else is dropped. */
function normaliseLink(raw: string | undefined, kind: 'telegram' | 'twitter'): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  if (/^@?[A-Za-z0-9_]{2,64}$/.test(s)) return kind === 'telegram' ? `https://t.me/${s.replace(/^@/, '')}` : `https://x.com/${s.replace(/^@/, '')}`;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    return u.toString().slice(0, LIMITS.link);
  } catch {
    return undefined;
  }
}

function decodeImage(dataUrl: string) {
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error('The coin image is not a valid data URL.');
  return { bytes: new Uint8Array(Buffer.from(m[2], 'base64')), mime: `image/${m[1]}`, filename: `coin.${m[1] === 'jpeg' ? 'jpg' : m[1]}` };
}

const ipfsToHttps = (u: string) => (u.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${u.slice(7)}` : u);

/** Keep only what we store: trimmed strings, clamped rules, a known look. */
function sanitise(p: LaunchPayload): LaunchPayload {
  const opt = (s: string | undefined, max: number) => {
    const t = (s ?? '').trim();
    return t ? t.slice(0, max) : undefined;
  };
  return {
    owner: p.owner,
    name: p.name.trim(),
    ticker: p.ticker.trim().toUpperCase(),
    description: opt(p.description, LIMITS.description),
    motto: opt(p.motto, LIMITS.motto),
    telegram: opt(p.telegram, LIMITS.link),
    twitter: opt(p.twitter, LIMITS.link),
    image: p.image,
    devBuy: Math.round(p.devBuy * 1e9) / 1e9,
    cell: p.cell ? { q: p.cell.q, r: p.cell.r } : null,
    look: isLook(p.look) ? p.look : DEFAULT_LOOK,
    rules: clampRules(p.rules),
    temperament: { dip: String(p.temperament.dip).slice(0, 40), swarm: String(p.temperament.swarm).slice(0, 40) },
    issuedAt: p.issuedAt,
  };
}

/* ================================================================== */
/* prepare                                                             */
/* ================================================================== */

export async function prepareLaunch(body: unknown, ctx: LaunchCtx = {}): Promise<LaunchPrepareResponse> {
  const d = await deps(ctx);
  const now = d.now();
  rate(`prepare:ip:${ctx.ip ?? 'unknown'}`, RATE.prepareIp, now, 'launch attempts from this network');

  const req = (body && typeof body === 'object' ? body : {}) as { payload?: unknown; signature?: unknown };
  const problems = validateLaunchPayload(req.payload);
  if (problems.length) throw new LaunchError(problems[0], 400, problems);
  const raw = req.payload as LaunchPayload;
  const costs = ctx.costs ?? config.costs;
  if (raw.devBuy > costs.maxDevBuy) throw new LaunchError(`Dev buy must be 0–${costs.maxDevBuy} SOL.`, 400);

  if (d.mode === 'live') {
    const notReady = ctx.problems ?? liveModeProblems();
    if (notReady.length) throw new LaunchError('Live launches are not available on this server right now.', 503, notReady);
    if (!isBase58Address(raw.owner)) throw new LaunchError('Connect a wallet to launch. Guest launches are preview-only.', 400);
    const age = now - raw.issuedAt;
    if (age > LIMITS.signatureMaxAgeMs || age < -2 * 60 * 1000) throw new LaunchError('Your signature is too old. Please sign again.', 400);
    if (!req.signature) throw new LaunchError('Sign the launch message with your wallet to continue.', 400);
    if (!verifyOwnerSignature(raw.owner, launchMessage(raw), req.signature)) throw new LaunchError('The wallet signature does not match. Please sign again.', 400);
  }
  rate(`prepare:owner:${raw.owner}`, RATE.prepareOwner, now, 'launch attempts for this wallet');

  const payload = sanitise(raw);
  const id = randomBytes(12).toString('base64url');
  const expiresAt = now + LIMITS.reservationMs;

  let claim: { cell: { q: number; r: number }; changed: boolean };
  try {
    claim = await claimLaunchCell(d.db, payload.cell ?? null, id, expiresAt, now);
  } catch (e) {
    throw new LaunchError(errText(e), 503);
  }

  try {
    const queen = newKeypair();
    const mint = newKeypair();
    const queenWallet = queen.keypair.publicKey.toBase58();
    const mintPubkey = mint.keypair.publicKey.toBase58();
    await d.db.putSecret(queenWallet, queen.enc);
    await d.db.putSecret(mintPubkey, mint.enc);
    const lamports = lamportsFor(costs.launchCost + costs.queenReserve + payload.devBuy);
    const rec: LaunchRecord = {
      id,
      mode: d.mode,
      state: 'reserved',
      owner: payload.owner,
      payload,
      queenWallet,
      mintPubkey,
      mintSecretEnc: mint.enc,
      cell: claim.cell,
      lamports,
      createdAt: now,
      expiresAt,
      updatedAt: now,
      txs: {},
      attempts: 0,
    };
    await d.db.createLaunch(rec);
    return {
      launchId: id,
      mode: d.mode,
      queenWallet,
      cell: claim.cell,
      cellChanged: claim.changed,
      lamports,
      breakdown: { launchCost: costs.launchCost, queenReserve: costs.queenReserve, devBuy: payload.devBuy },
      expiresAt,
    };
  } catch (e) {
    await d.db.releaseCell(id).catch(() => {});
    throw e;
  }
}

/* ================================================================== */
/* confirm                                                             */
/* ================================================================== */

export async function confirmLaunch(id: string, body: unknown, ctx: LaunchCtx = {}): Promise<LaunchStatusResponse> {
  const d = await deps(ctx);
  if (!ID_RE.test(id)) throw new LaunchError('Launch not found.', 404);
  rate(`confirm:ip:${ctx.ip ?? 'unknown'}`, RATE.confirmIp, d.now(), 'requests');
  const sigRaw = body && typeof body === 'object' ? (body as { signature?: unknown }).signature : undefined;
  if (sigRaw !== undefined && sigRaw !== null && (typeof sigRaw !== 'string' || !SIG_RE.test(sigRaw))) throw new LaunchError('That is not a transaction signature.', 400);
  const paySig = typeof sigRaw === 'string' ? sigRaw : undefined;

  let l = await d.db.getLaunch(id);
  if (!l) throw new LaunchError('Launch not found.', 404);
  if (l.mode !== d.mode) throw new LaunchError(`This launch was prepared in ${l.mode} mode, but the server now runs in ${d.mode} mode.`, 409);

  const lockName = `launch:${id}`;
  // Someone else is advancing it right now: report where it is; the client keeps polling.
  if (!(await d.db.lock(lockName, d.now() + LOCK_MS))) return toStatus(d.db, l);
  try {
    l = (await d.db.getLaunch(id)) ?? l; // re-read under the lock
    l = await advance(d, l, paySig);
  } finally {
    await d.db.unlock(lockName).catch(() => {});
  }
  return toStatus(d.db, l);
}

async function advance(d: Deps, l: LaunchRecord, paySig?: string): Promise<LaunchRecord> {
  if (l.state === 'reserved' || (l.state === 'expired' && paySig)) {
    l = await stepPay(d, l, paySig);
    if (l.state !== 'paid') return l;
  }
  if (l.state === 'paid') {
    l = await stepMetadata(d, l);
    if (l.state !== 'metadata') return l;
  }
  if (l.state === 'metadata') {
    l = await stepCreate(d, l);
    if (l.state !== 'created') return l;
  }
  if (l.state === 'created') l = await stepLive(d, l);
  return l;
}

/** Compare-and-set; if someone else moved the launch, return its current record instead. */
async function cas(d: Deps, l: LaunchRecord, patch: Partial<LaunchRecord>, expect = [l.state]): Promise<LaunchRecord> {
  const next = await d.db.updateLaunch(l.id, { ...patch, updatedAt: d.now() }, expect);
  return next ?? (await d.db.getLaunch(l.id)) ?? l;
}

/** Record a transient failure. After MAX_ATTEMPTS in a paying-for-something step the launch fails (refundable). */
async function failStep(d: Deps, l: LaunchRecord, message: string, extra: Partial<LaunchRecord> = {}, canFail = true): Promise<LaunchRecord> {
  const attempts = l.attempts + 1;
  if (canFail && attempts >= MAX_ATTEMPTS) {
    const next = await cas(d, l, { ...extra, attempts, state: 'failed', error: `${message} Gave up after ${attempts} attempts; you can refund.` });
    if (next.state === 'failed') await d.db.releaseCell(l.id).catch(() => {});
    return next;
  }
  return cas(d, l, { ...extra, attempts, error: message });
}

async function expire(d: Deps, l: LaunchRecord, message = 'The reservation expired before the payment arrived.', extra: Partial<LaunchRecord> = {}): Promise<LaunchRecord> {
  const next = await d.db.updateLaunch(l.id, { ...extra, state: 'expired', error: message, updatedAt: d.now() }, ['reserved']);
  if (next) {
    await d.db.releaseCell(l.id).catch(() => {});
    return next;
  }
  return (await d.db.getLaunch(l.id)) ?? l;
}

/** Past its deadline? A reservation whose payment signature we hold gets a grace period. */
const isDue = (l: LaunchRecord, now: number) => l.state === 'reserved' && now > l.expiresAt + (l.txs.payment ? PAYMENT_GRACE_MS : 0);

/** Mark a payment signature as spent by this launch. False if another launch already used it. */
async function claimPayment(d: Deps, sig: string, id: string): Promise<boolean> {
  const key = `payment:${sig}`;
  const used = await d.db.getMeta(key);
  if (used && used !== id) return false;
  if (!used) await d.db.setMeta(key, id);
  return (await d.db.getMeta(key)) === id;
}

async function paymentUsedElsewhere(d: Deps, sig: string, id: string) {
  const used = await d.db.getMeta(`payment:${sig}`);
  return !!used && used !== id;
}

/** reserved → paid (or stays reserved with an error, or expires). */
async function stepPay(d: Deps, l: LaunchRecord, paySig?: string): Promise<LaunchRecord> {
  const now = d.now();

  if (d.mode === 'mock') {
    if (l.state !== 'reserved') return l;
    if (isDue(l, now)) return expire(d, l);
    // No payment in mock mode. MockChain still "receives" the funds so the queen has a balance to show.
    const chain = await d.chain();
    await chain.verifyPayment(`mock-payment-${l.id}`, l.owner, l.queenWallet, l.lamports, l.createdAt);
    await d.db.finalizeCell(l.id);
    return cas(d, l, { state: 'paid', attempts: 0, error: NO_ERROR }, ['reserved']);
  }

  const sig = paySig ?? l.txs.payment;
  if (!sig) {
    if (isDue(l, now)) return expire(d, l);
    return { ...l, error: 'Waiting for your payment.' };
  }
  if (await paymentUsedElsewhere(d, sig, l.id)) {
    const msg = 'That payment was already used for another launch.';
    return l.state === 'reserved' ? cas(d, l, { error: msg }) : { ...l, error: msg };
  }

  const chain = await d.chain();
  const check = await chain.verifyPayment(sig, l.owner, l.queenWallet, l.lamports, l.createdAt);

  if (!check.ok) {
    const reason = check.reason ?? 'Payment not confirmed yet.';
    if (l.state === 'expired') {
      // A late payment on an expired reservation: remember it so the owner can refund it.
      return check.retry && !l.txs.payment ? cas(d, l, { txs: { ...l.txs, payment: sig } }, ['expired']) : l;
    }
    if (check.retry) {
      // Not confirmed yet: keep the signature so a later confirm (or status poll) can finish the job.
      if (now > l.expiresAt + PAYMENT_GRACE_MS) return expire(d, l, `Your payment did not confirm in time. ${reason}`, { txs: { ...l.txs, payment: sig } });
      return cas(d, l, { txs: { ...l.txs, payment: sig }, error: reason });
    }
    // Definitely not a valid payment for this launch: forget it so a correct one can be sent.
    if (isDue({ ...l, txs: {} }, now)) return expire(d, l);
    return cas(d, l, { txs: { ...l.txs, payment: undefined }, error: reason });
  }

  if (!(await claimPayment(d, sig, l.id))) {
    const msg = 'That payment was already used for another launch.';
    return l.state === 'reserved' ? cas(d, l, { error: msg }) : { ...l, error: msg };
  }

  if (l.state === 'expired') {
    if (l.txs.payment === sig) return { ...l, error: 'Your payment arrived after the reservation expired. You can refund it.' };
    const next = await cas(d, l, { txs: { ...l.txs, payment: sig }, error: 'Your payment arrived after the reservation expired. You can refund it.' }, ['expired']);
    return next;
  }

  // Paid. Make the cell ours for good; if the claim lapsed while the payment confirmed, claim again.
  let cell = l.cell;
  if (now > l.expiresAt) {
    try {
      const again = await claimLaunchCell(d.db, l.cell, l.id, now + LIMITS.reservationMs, now);
      cell = again.cell;
    } catch (e) {
      return cas(d, l, { txs: { ...l.txs, payment: sig }, error: `Paid, but no free cell right now (${errText(e)}). Retry in a moment.` });
    }
  }
  await d.db.finalizeCell(l.id);
  const next = await cas(d, l, { state: 'paid', cell, txs: { ...l.txs, payment: sig }, attempts: 0, error: NO_ERROR }, ['reserved']);
  if (next.state === 'expired' && next.txs.payment !== sig) {
    // a status poll expired it while we were verifying: keep the verified payment on record for a refund
    return cas(d, next, { txs: { ...next.txs, payment: sig } }, ['expired']);
  }
  return next;
}

/** paid → metadata: image + metadata to IPFS. */
async function stepMetadata(d: Deps, l: LaunchRecord): Promise<LaunchRecord> {
  const p = l.payload;
  try {
    const chain = await d.chain();
    const site = config.siteUrl?.replace(/\/+$/, '');
    const res = await chain.uploadMetadata({
      image: decodeImage(p.image),
      name: p.name,
      symbol: p.ticker,
      description: p.description || p.motto || `A ${theme.unit} on the ${theme.name} ${theme.scene}.`,
      twitter: normaliseLink(p.twitter, 'twitter'),
      telegram: normaliseLink(p.telegram, 'telegram'),
      website: site ? `${site}/hive/${l.mintPubkey}` : undefined,
    });
    return cas(d, l, { state: 'metadata', metadataUri: res.metadataUri, imageUri: res.imageUri, attempts: 0, error: NO_ERROR }, ['paid']);
  } catch (e) {
    return failStep(d, l, `Uploading the coin image failed: ${errText(e)}`);
  }
}

async function mintExists(d: Deps, l: LaunchRecord): Promise<boolean> {
  const chain = await d.chain();
  if (chain.accountExists) return chain.accountExists(l.mintPubkey);
  if (chain.kind === 'live') throw new Error('This chain cannot check whether the coin exists; refusing to risk a second create.');
  return false;
}

async function queenKeypair(d: Deps, l: LaunchRecord) {
  const enc = await d.db.getSecret(l.queenWallet);
  if (!enc) throw new LaunchError('The queen key for this launch is missing.', 500);
  const kp = keypairFromEnc(enc);
  if (kp.publicKey.toBase58() !== l.queenWallet) throw new LaunchError('The stored queen key does not match its wallet.', 500);
  return kp;
}

/** metadata → created: the pump.fun create, sent at most once per landed coin. */
async function stepCreate(d: Deps, l: LaunchRecord): Promise<LaunchRecord> {
  const created = (sig?: string) => cas(d, l, { state: 'created', ca: l.mintPubkey, txs: { ...l.txs, ...(sig ? { create: sig } : {}) }, attempts: 0, error: NO_ERROR }, ['metadata']);
  try {
    // A previous attempt may have landed even though its answer was lost: never create twice.
    if (await mintExists(d, l)) return created();
  } catch (e) {
    return failStep(d, l, `Could not check the coin on chain: ${errText(e)}`, {}, false);
  }
  const mint = keypairFromEnc(l.mintSecretEnc);
  if (mint.publicKey.toBase58() !== l.mintPubkey) throw new LaunchError('The stored mint key does not match.', 500);
  const queen = await queenKeypair(d, l);
  const chain = await d.chain();
  try {
    const { signature } = await chain.createCoin({ creator: queen, mint, name: l.payload.name, symbol: l.payload.ticker, uri: l.metadataUri ?? '', devBuySol: l.payload.devBuy });
    return created(signature);
  } catch (e) {
    const sig = e instanceof TxError ? e.signature : undefined;
    // Timed out (may still land) or a network error: look once more before counting a failure.
    if (!(e instanceof TxError && e.landed !== undefined)) {
      const exists = await mintExists(d, l).catch(() => false);
      if (exists) return created(sig);
    }
    return failStep(d, l, `Creating the coin failed: ${errText(e)}`, sig ? { txs: { ...l.txs, create: sig } } : {});
  }
}

/** created → live: dev-buy tokens to the owner (live), then the hive appears on the comb for everyone. */
async function stepLive(d: Deps, l: LaunchRecord): Promise<LaunchRecord> {
  const chain = await d.chain();
  const p = l.payload;
  let note: string | undefined;

  if (d.mode === 'live' && p.devBuy > 0 && !l.txs.devTransfer && isBase58Address(l.owner)) {
    try {
      const queen = await queenKeypair(d, l);
      const bal = await chain.tokenBalance(l.queenWallet, l.mintPubkey);
      // Balance is the source of truth: 0 means an earlier transfer already landed.
      if (bal.amount > 0n) {
        const r = await chain.transferTokens({ from: queen, mint: l.mintPubkey, to: l.owner, amount: bal.amount });
        l = await cas(d, l, { txs: { ...l.txs, devTransfer: r.signature } }, ['created']);
        if (l.state !== 'created') return l;
      }
    } catch (e) {
      if (l.attempts + 1 < MAX_ATTEMPTS) return failStep(d, l, `Sending your dev-buy tokens failed: ${errText(e)} Retry to try again.`, {}, false);
      note = `Your dev-buy tokens could not be sent (${errText(e)}). They are still in the ${theme.agent} wallet.`;
    }
  }

  const t = d.now();
  const prev = await d.db.getHive(l.mintPubkey);
  const honey = (await chain.balance(l.queenWallet).catch(() => 0)) / 1e9;
  const hive: RemoteHive = {
    ca: l.mintPubkey,
    name: p.name,
    ticker: p.ticker,
    image: d.mode === 'live' && l.imageUri ? ipfsToHttps(l.imageUri) : p.image,
    description: p.description,
    motto: p.motto,
    telegram: normaliseLink(p.telegram, 'telegram'),
    twitter: normaliseLink(p.twitter, 'twitter'),
    cell: l.cell,
    queenWallet: l.queenWallet,
    ownerWallet: l.owner,
    look: p.look,
    rules: p.rules,
    temperament: p.temperament,
    devBuy: p.devBuy,
    status: l.mode === 'live' ? 'live' : 'mock',
    createTx: l.txs.create,
    honey,
    bees: prev?.bees ?? 1,
    feesTotal: prev?.feesTotal ?? 0,
    royalJelly: prev?.royalJelly ?? 0,
    price: prev?.price,
    state: 'working',
    lastFeeAt: prev?.lastFeeAt ?? t,
    createdAt: prev?.createdAt ?? t,
    updatedAt: t,
  };
  await d.db.upsertHive(hive);
  const how = l.mode === 'live' ? '' : ' (preview launch: simulated, nothing was sent)';
  await d.db.addAction({
    id: `born-${l.id}`,
    ca: hive.ca,
    verb: 'born',
    amount: p.devBuy,
    reason: `${cap(theme.unit)} founded${how}. ${cap(theme.agent)} wallet ${l.queenWallet} launched $${p.ticker} on pump.fun as creator${l.txs.create ? ` in tx ${l.txs.create}` : ''}${p.devBuy ? ` with a ${p.devBuy} SOL dev buy` : ''}.`,
    txSig: l.txs.create,
    at: prev?.createdAt ?? t,
  });
  await d.db.finalizeCell(l.id);
  return cas(d, l, { state: 'live', attempts: 0, error: note ?? NO_ERROR }, ['created']);
}

/* ================================================================== */
/* status                                                              */
/* ================================================================== */

export async function launchStatus(id: string, ctx: LaunchCtx = {}): Promise<LaunchStatusResponse> {
  const d = await deps(ctx);
  if (!ID_RE.test(id)) throw new LaunchError('Launch not found.', 404);
  rate(`status:ip:${ctx.ip ?? 'unknown'}`, RATE.statusIp, d.now(), 'requests');
  let l = await d.db.getLaunch(id);
  if (!l) throw new LaunchError('Launch not found.', 404);
  if (isDue(l, d.now())) l = await expire(d, l, l.txs.payment ? 'Your payment did not confirm in time.' : undefined);
  return toStatus(d.db, l);
}

/** The only shape that leaves this module: no secrets, no payload image. */
async function toStatus(db: Db, l: LaunchRecord): Promise<LaunchStatusResponse> {
  const res: LaunchStatusResponse = {
    launchId: l.id,
    state: l.state,
    mode: l.mode,
    queenWallet: l.queenWallet,
    cell: { q: l.cell.q, r: l.cell.r },
    ca: l.ca,
    txs: { ...l.txs },
    error: l.error || undefined,
  };
  if (l.state === 'live' && l.ca) res.hive = (await db.getHive(l.ca)) ?? undefined;
  return res;
}

/* ================================================================== */
/* refund                                                              */
/* ================================================================== */

export async function refundLaunch(id: string, body: unknown, ctx: LaunchCtx = {}): Promise<LaunchStatusResponse> {
  const d = await deps(ctx);
  if (!ID_RE.test(id)) throw new LaunchError('Launch not found.', 404);
  rate(`refund:ip:${ctx.ip ?? 'unknown'}`, RATE.refundIp, d.now(), 'refund requests');
  let l = await d.db.getLaunch(id);
  if (!l) throw new LaunchError('Launch not found.', 404);
  if (l.state === 'refunded') return toStatus(d.db, l);
  if (isDue(l, d.now())) l = await expire(d, l);
  if (l.state !== 'failed' && l.state !== 'expired') throw new LaunchError('Only a failed or expired launch can be refunded.', 409);

  // Only the owner may ask. In mock mode guests cannot sign, and no real SOL is involved.
  const signature = body && typeof body === 'object' ? (body as { signature?: unknown }).signature : undefined;
  if (d.mode === 'live' || signature !== undefined) {
    if (!verifyOwnerSignature(l.owner, refundMessage(id), signature)) throw new LaunchError('Sign the refund message with the wallet that paid.', 400);
  }

  const lockName = `launch:${id}`;
  if (!(await d.db.lock(lockName, d.now() + LOCK_MS))) throw new LaunchError('This launch is busy. Try again in a minute.', 409);
  try {
    l = (await d.db.getLaunch(id)) ?? l;
    if (l.state === 'refunded') return toStatus(d.db, l);
    if (l.state !== 'failed' && l.state !== 'expired') throw new LaunchError('Only a failed or expired launch can be refunded.', 409);
    const chain = await d.chain();
    /** Expired with no payment signature on record: refund only what actually sits in the queen wallet. */
    let unrecordedPayment = false;

    if (d.mode === 'live') {
      if (l.state === 'expired') {
        const sig = l.txs.payment;
        if (sig) {
          // A payment signature we hold: it must verify (and belong to this launch) first.
          if ((await d.db.getMeta(`payment:${sig}`)) !== l.id) {
            const check = await chain.verifyPayment(sig, l.owner, l.queenWallet, l.lamports, l.createdAt);
            if (!check.ok) throw new LaunchError(check.retry ? 'Your payment is not confirmed yet. Try again shortly.' : check.reason ?? 'No valid payment found.', 409);
            if (!(await claimPayment(d, sig, l.id))) throw new LaunchError('That payment belongs to another launch.', 409);
          }
        } else {
          // The confirm that carried the signature may never have reached us (tab closed, page reloaded
          // by a wallet). An expired launch's queen wallet was made for it alone and never did anything,
          // so whatever arrived there is the owner's: the balance check below decides.
          unrecordedPayment = true;
        }
      }
      if (l.state === 'failed') {
        // The last create may still be in flight: a confirm timeout is not a failure on chain.
        const wait = l.txs.create ? l.updatedAt + CREATE_SETTLE_MS - d.now() : 0;
        if (wait > 0) {
          throw new LaunchError(`Your coin's create transaction could still land, so the refund opens in ${Math.ceil(wait / 1000)} s. Nothing was sent.`, 409, undefined, wait);
        }
        // Fail closed: if the chain cannot tell us whether the coin exists, do not drain its queen.
        let exists: boolean;
        try {
          exists = await mintExists(d, l);
        } catch (e) {
          throw new LaunchError(`Could not check on chain whether your coin was created (${errText(e)}). Nothing was sent; try the refund again in a moment.`, 503);
        }
        // A create that landed after we gave up means the coin exists: finish the launch instead of draining it.
        if (exists) {
          const again = await claimLaunchCell(d.db, l.cell, l.id, d.now() + LIMITS.reservationMs, d.now()).catch(() => null);
          if (again) await d.db.finalizeCell(l.id);
          await cas(d, l, { state: 'metadata', attempts: 0, cell: again?.cell ?? l.cell, error: 'Your coin was created after all. Press Retry to finish the launch.' }, ['failed']);
          throw new LaunchError('Your coin was created after all. Press Retry to finish the launch instead.', 409);
        }
      }
    }

    const queen = await queenKeypair(d, l);
    const balance = await chain.balance(l.queenWallet);
    const lamports = balance - BASE_FEE_LAMPORTS;
    // Nothing arrived (yet): stay expired so a payment that lands later can still be refunded. With a
    // refund signature on record the SOL is gone because that refund landed: settle as refunded below.
    if (lamports <= 0 && unrecordedPayment && !l.txs.refund) throw new LaunchError('No payment was received for this launch, so there is nothing to refund.', 409);
    if (lamports <= 0) {
      // Nothing left (or an earlier refund landed after its answer was lost).
      l = await cas(d, l, { state: 'refunded', error: l.txs.refund ? NO_ERROR : 'Nothing was left to refund.' }, ['failed', 'expired']);
    } else {
      try {
        const r = await chain.transferSol({ from: queen, to: l.owner, lamports });
        l = await cas(d, l, { state: 'refunded', txs: { ...l.txs, refund: r.signature }, error: NO_ERROR }, ['failed', 'expired']);
      } catch (e) {
        const sig = e instanceof TxError ? e.signature : undefined;
        await cas(d, l, { error: `Refund failed: ${errText(e)}`, ...(sig ? { txs: { ...l.txs, refund: sig } } : {}) });
        throw new LaunchError(`Refund failed: ${errText(e)} Try again.`, 502);
      }
    }
    await d.db.releaseCell(l.id).catch(() => {});
    return toStatus(d.db, l);
  } finally {
    await d.db.unlock(lockName).catch(() => {});
  }
}

/* ================================================================== */
/* HTTP helpers for the route handlers                                 */
/* ================================================================== */

/** Largest launch request body we read (a 400 KB image is ~540 KB as base64 JSON). */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Read a JSON body with a size cap. Throws LaunchError(400/413). Empty body → {}. */
export async function readJson(req: Request): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) throw new LaunchError('Request is too large.', 413);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES * 1.1) throw new LaunchError('Request is too large.', 413);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LaunchError('Request body must be JSON.', 400);
  }
}

/** Map any error to a JSON response. Unexpected errors are logged (message only) and hidden. */
export function errorResponse(e: unknown): Response {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (e instanceof LaunchError) {
    if (e.retryAfterMs) headers['Retry-After'] = String(Math.ceil(e.retryAfterMs / 1000));
    return Response.json({ error: e.message, reasons: e.reasons }, { status: e.status, headers });
  }
  console.error('[hive] launch API error:', errText(e));
  return Response.json({ error: 'Something went wrong on the server. Try again.' }, { status: 500, headers });
}

export const okJson = (data: unknown) => Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
