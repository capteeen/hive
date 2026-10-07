/**
 * Shared contract between the browser and the server. No secrets in here.
 * A "remote" hive is one stored server-side (file store or Supabase) so every user sees it.
 */
import type { QueenLook, QueenRules } from '@/lib/queen';
import type { ActionVerb, Cell } from '@/lib/types';

export type LaunchMode = 'mock' | 'live';
/** 'mock': founded in mock launch mode (no chain). 'live': a real pump.fun coin. */
export type HiveStatus = 'mock' | 'live';
export type RemoteState = 'working' | 'starving' | 'abandoned';

export interface RemoteHive {
  ca: string;
  name: string;
  ticker: string;
  /** https / ipfs gateway URL, or a small (≤ 200 KB) data URL in mock mode. */
  image: string;
  description?: string;
  motto?: string;
  telegram?: string;
  twitter?: string;
  cell: Cell;
  queenWallet: string;
  ownerWallet: string;
  look?: QueenLook;
  rules?: QueenRules;
  temperament?: { dip: string; swarm: string };
  devBuy: number;
  status: HiveStatus;
  createTx?: string;
  /** Chain-derived (live) or seeded (mock) stats, refreshed server-side. SOL amounts. */
  honey: number;
  bees: number;
  feesTotal: number;
  royalJelly: number;
  price?: number;
  state: RemoteState;
  lastFeeAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface RemoteAction {
  id: string;
  ca: string;
  verb: ActionVerb;
  amount: number;
  targetCa?: string;
  reason: string;
  txSig?: string;
  at: number;
  /** Planned by the engine in dry-run mode: nothing was sent. */
  dryRun?: boolean;
}

export interface RemoteHarvest {
  id: string;
  at: number;
  feesIn: number;
  hiveBought: number;
  burned: number;
  jellyTo: string;
  jellyAmount: number;
  jellySol: number;
  txSig: string;
  dryRun?: boolean;
}

export type StreamEvent =
  | { type: 'hive'; hive: RemoteHive }
  | { type: 'action'; action: RemoteAction }
  | { type: 'harvest'; harvest: RemoteHarvest };

export interface PublicConfig {
  launchMode: LaunchMode;
  /** How the browser hears about other users' hives. */
  realtime: 'supabase' | 'sse';
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  demoHives: boolean;
  costs: { launchCost: number; queenReserve: number; maxDevBuy: number };
  /** The real $HIVE mint (HUB_TOKEN_MINT), once it exists. Public on chain anyway. */
  hubTokenMint?: string;
}

export interface HivesResponse {
  hives: RemoteHive[];
  actions: RemoteAction[];
  harvests: RemoteHarvest[];
  serverTime: number;
  /** Hives left out because the list is capped (abandoned and oldest first). */
  omitted?: number;
}

/* ---------- launching ---------- */
export type LaunchState = 'reserved' | 'paid' | 'metadata' | 'created' | 'live' | 'failed' | 'expired' | 'refunded';

export interface LaunchPayload {
  /** Wallet that owns the hive (base58). In mock mode without a wallet: `guest:<id>`. */
  owner: string;
  name: string;
  ticker: string;
  description?: string;
  motto?: string;
  telegram?: string;
  twitter?: string;
  /** PNG/JPEG/WebP/GIF data URL, already downscaled by the client (≤ 400 KB). */
  image: string;
  devBuy: number;
  cell?: Cell | null;
  look: QueenLook;
  rules: QueenRules;
  temperament: { dip: string; swarm: string };
  /** ms epoch; the signed message embeds it so old signatures can't be replayed. */
  issuedAt: number;
}

export interface LaunchPrepareRequest {
  payload: LaunchPayload;
  /** base58 ed25519 signature by `owner` over `launchMessage(payload)`. Required in live mode. */
  signature?: string;
}

export interface LaunchPrepareResponse {
  launchId: string;
  mode: LaunchMode;
  queenWallet: string;
  cell: Cell;
  /** True when the preferred cell was taken and the nearest free one was reserved instead. */
  cellChanged: boolean;
  lamports: number;
  breakdown: { launchCost: number; queenReserve: number; devBuy: number };
  expiresAt: number;
}

export interface LaunchConfirmRequest {
  /** The payment transaction signature (live mode). */
  signature?: string;
}

export interface LaunchStatusResponse {
  launchId: string;
  state: LaunchState;
  mode: LaunchMode;
  queenWallet: string;
  cell: Cell;
  ca?: string;
  txs: { payment?: string; create?: string; devTransfer?: string; refund?: string };
  error?: string;
  /** Present once live. */
  hive?: RemoteHive;
}

export const LIMITS = {
  name: { min: 2, max: 32 },
  ticker: /^[A-Za-z0-9]{2,10}$/,
  description: 500,
  motto: 80,
  link: 200,
  imageBytes: 200 * 1024,
  maxDevBuy: 10,
  /** Reservations expire if the payment never arrives. */
  reservationMs: 15 * 60 * 1000,
  /** Signed messages older than this are rejected. */
  signatureMaxAgeMs: 10 * 60 * 1000,
};

/** The exact message the owner signs to prove they control the wallet. */
export function launchMessage(p: Pick<LaunchPayload, 'owner' | 'name' | 'ticker' | 'issuedAt'>) {
  return `HIVE launch\nOwner: ${p.owner}\nCoin: ${p.name} ($${p.ticker.toUpperCase()})\nIssued: ${new Date(p.issuedAt).toISOString()}\nThis signature only proves you own this wallet. It costs nothing.`;
}

const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const isBase58Address = (s: string) => BASE58_RE.test(s);

/** Validate a launch payload. Returns a list of human-readable problems (empty = valid). */
export function validateLaunchPayload(p: unknown): string[] {
  const errs: string[] = [];
  if (!p || typeof p !== 'object') return ['Missing launch details.'];
  const x = p as Partial<LaunchPayload>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const name = str(x.name).trim();
  if (name.length < LIMITS.name.min || name.length > LIMITS.name.max) errs.push(`Name must be ${LIMITS.name.min}–${LIMITS.name.max} characters.`);
  if (!LIMITS.ticker.test(str(x.ticker).trim())) errs.push('Ticker must be 2–10 letters or digits.');
  if (str(x.description).length > LIMITS.description) errs.push('Description is too long.');
  if (str(x.motto).length > LIMITS.motto) errs.push('Motto is too long.');
  for (const k of ['telegram', 'twitter'] as const) if (str(x[k]).length > LIMITS.link) errs.push(`${k} link is too long.`);
  const owner = str(x.owner);
  if (!(isBase58Address(owner) || /^guest:[A-Za-z0-9_-]{6,40}$/.test(owner))) errs.push('Owner wallet is not a valid address.');
  const img = str(x.image);
  if (!IMAGE_RE.test(img)) errs.push('Image must be a PNG, JPEG, WebP or GIF.');
  else if (Math.floor((img.length - img.indexOf(',') - 1) * 0.75) > LIMITS.imageBytes) errs.push('Image is too large.');
  if (typeof x.devBuy !== 'number' || !Number.isFinite(x.devBuy) || x.devBuy < 0 || x.devBuy > LIMITS.maxDevBuy) errs.push(`Dev buy must be 0–${LIMITS.maxDevBuy} SOL.`);
  if (x.cell != null && (typeof x.cell !== 'object' || !Number.isInteger(x.cell.q) || !Number.isInteger(x.cell.r) || Math.abs(x.cell.q) > 60 || Math.abs(x.cell.r) > 60)) errs.push('Cell is invalid.');
  if (typeof x.issuedAt !== 'number' || !Number.isFinite(x.issuedAt)) errs.push('Missing timestamp.');
  if (!x.look || typeof x.look !== 'object') errs.push('Missing queen look.');
  if (!x.rules || typeof x.rules !== 'object') errs.push('Missing queen rules.');
  if (!x.temperament || typeof x.temperament.dip !== 'string' || typeof x.temperament.swarm !== 'string') errs.push('Missing temperament.');
  return errs;
}
