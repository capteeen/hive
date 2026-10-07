/**
 * Fakes for the queen engine tests (independent of the launch track's fakes).
 *  - EngineMemDb: an in-memory Db with the same idempotency rules as the real stores (actions and
 *    harvests are keyed by id, upserting an identical hive is a no-op) plus counters for assertions,
 *    and a `fail` hook that makes a read or write throw (a db outage, or the process dying there).
 *  - ScriptChain: a scriptable Chain. SOL and token balances live in maps, creator fees are set per
 *    queen, every send is logged in `sent`, and `fail` / `after` hooks inject errors before or after
 *    an operation takes effect (e.g. a buy that lands but times out).
 */
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { Cell } from '@/lib/types';
import type { LaunchState, RemoteAction, RemoteHarvest, RemoteHive, StreamEvent } from '@/lib/shared/api';
import type { Db, LaunchRecord } from '@/lib/server/db';
import { BASE_FEE_LAMPORTS, TxError, type Chain, type PaymentCheck, type TokenBalance } from '@/lib/server/chain';

const clone = <T>(v: T): T => structuredClone(v);

/* ================================================================== */
/* Db                                                                  */
/* ================================================================== */

export class EngineMemDb implements Db {
  readonly kind = 'file' as const;
  readonly hives = new Map<string, RemoteHive>();
  actions: RemoteAction[] = [];
  harvests: RemoteHarvest[] = [];
  readonly meta = new Map<string, string>();
  readonly secrets = new Map<string, string>();
  readonly locks = new Map<string, number>();
  readonly prices = new Map<string, { at: number; price: number }[]>();
  /** Writes that changed a hive. */
  upserts = 0;
  /** Called before getHive / upsertHive / addAction / setMeta: return an Error to throw it (nothing happens). */
  fail: ((op: 'getHive' | 'upsertHive' | 'addAction' | 'setMeta', key: string) => Error | undefined) | null = null;
  private check(op: 'getHive' | 'upsertHive' | 'addAction' | 'setMeta', key: string) {
    const e = this.fail?.(op, key);
    if (e) throw e;
  }

  async listHives() {
    return [...this.hives.values()].sort((a, b) => a.createdAt - b.createdAt).map(clone);
  }
  async getHive(ca: string) {
    this.check('getHive', ca);
    const h = this.hives.get(ca);
    return h ? clone(h) : null;
  }
  async upsertHive(h: RemoteHive) {
    this.check('upsertHive', h.ca);
    const prev = this.hives.get(h.ca);
    if (prev && JSON.stringify(prev) === JSON.stringify(h)) return;
    for (const o of this.hives.values()) if (o.ca !== h.ca && o.cell.q === h.cell.q && o.cell.r === h.cell.r) throw new Error('cell taken');
    this.hives.set(h.ca, clone(h));
    this.upserts++;
  }

  async listActions(limit: number, ca?: string) {
    return this.actions.filter((a) => !ca || a.ca === ca).slice(0, limit).map(clone);
  }
  async addAction(a: RemoteAction) {
    this.check('addAction', a.id);
    if (this.actions.some((x) => x.id === a.id)) return;
    this.actions.unshift(clone(a));
    this.actions.sort((x, y) => y.at - x.at);
  }
  async listHarvests(limit: number) {
    return this.harvests.slice(0, limit).map(clone);
  }
  async addHarvest(h: RemoteHarvest) {
    if (this.harvests.some((x) => x.id === h.id)) return;
    this.harvests.unshift(clone(h));
  }

  /* cells and launches are not used by the engine */
  async claimCell(): Promise<Cell | null> {
    throw new Error('not used');
  }
  async finalizeCell() {}
  async releaseCell() {}
  async takenCells(): Promise<Cell[]> {
    return [...this.hives.values()].map((h) => h.cell);
  }
  async createLaunch(_l: LaunchRecord) {
    throw new Error('not used');
  }
  async getLaunch(): Promise<LaunchRecord | null> {
    return null;
  }
  async updateLaunch(_id: string, _p: Partial<LaunchRecord>, _e: LaunchState[]): Promise<LaunchRecord | null> {
    return null;
  }
  async listLaunches(): Promise<LaunchRecord[]> {
    return [];
  }

  async putSecret(pubkey: string, enc: string) {
    if (!this.secrets.has(pubkey)) this.secrets.set(pubkey, enc);
  }
  async getSecret(pubkey: string) {
    return this.secrets.get(pubkey) ?? null;
  }
  async getMeta(key: string) {
    return this.meta.has(key) ? this.meta.get(key)! : null;
  }
  async setMeta(key: string, value: string) {
    this.check('setMeta', key);
    this.meta.set(key, value);
  }
  async lock(name: string, until: number) {
    const held = this.locks.get(name);
    if (held !== undefined && held > Date.now()) return false;
    this.locks.set(name, until);
    return true;
  }
  async unlock(name: string) {
    this.locks.delete(name);
  }

  async addPrice(ca: string, at: number, price: number) {
    const l = this.prices.get(ca) ?? [];
    const same = l.find((p) => p.at === at);
    if (same) same.price = price;
    else l.push({ at, price });
    l.sort((a, b) => a.at - b.at);
    this.prices.set(ca, l);
  }
  async listPrices(ca: string, since: number) {
    return (this.prices.get(ca) ?? []).filter((p) => p.at >= since).map((p) => ({ ...p }));
  }

  subscribe(_fn: (ev: StreamEvent) => void) {
    return () => {};
  }

  /* ---------- test helpers ---------- */
  actionsFor(ca: string) {
    return this.actions.filter((a) => a.ca === ca);
  }
}

/* ================================================================== */
/* Chain                                                               */
/* ================================================================== */

export type ChainOp = 'balance' | 'collect' | 'transferSol' | 'buy' | 'burn' | 'transferTokens' | 'tokenBalance' | 'coinInfo' | 'holders' | 'claimable';

export interface SentTx {
  op: 'collect' | 'transferSol' | 'buy' | 'burn' | 'transferTokens';
  from: string;
  to?: string;
  mint?: string;
  lamports?: number;
  sol?: number;
  amount?: bigint;
  signature: string;
}

type Hook = (op: ChainOp, info: { from?: string; to?: string; mint?: string; sol?: number; amount?: bigint; lamports?: number }) => Error | undefined;

export class ScriptChain implements Chain {
  readonly kind: 'live' | 'mock';
  readonly sol = new Map<string, number>();
  readonly tokens = new Map<string, bigint>();
  /** Claimable creator fees per creator wallet, lamports. */
  readonly fees = new Map<string, number>();
  /** SOL per token per mint (missing = coinInfo null). */
  readonly prices = new Map<string, number>();
  readonly holderLists = new Map<string, { count: number; top: { owner: string; amount: bigint }[] } | null>();
  readonly decimals = 6;
  sent: SentTx[] = [];
  /** Called before an operation takes effect: return an Error to throw it (nothing happens). */
  fail: Hook | null = null;
  /** Called after an operation took effect: return an Error to throw it anyway (e.g. landed, then timed out). */
  after: Hook | null = null;
  /** Expose claimableCreatorFees (dry-run previews), like LiveChain. */
  canPeek = true;
  private seq = 0;

  constructor(kind: 'live' | 'mock' = 'live') {
    this.kind = kind;
  }

  /* ---------- helpers ---------- */
  sig() {
    return `SIG${String(++this.seq).padStart(5, '0')}`;
  }
  lamports(pk: string) {
    return this.sol.get(pk) ?? 0;
  }
  setSol(pk: string, sol: number) {
    this.sol.set(pk, Math.round(sol * 1e9));
  }
  tokenOf(owner: string, mint: string) {
    return this.tokens.get(`${owner}|${mint}`) ?? 0n;
  }
  setTokens(owner: string, mint: string, amount: bigint) {
    this.tokens.set(`${owner}|${mint}`, amount);
  }
  sends(op?: SentTx['op']) {
    return this.sent.filter((s) => !op || s.op === op);
  }
  private check(op: ChainOp, info: Parameters<Hook>[1]) {
    const e = this.fail?.(op, info);
    if (e) throw e;
  }
  private checkAfter(op: ChainOp, info: Parameters<Hook>[1]) {
    const e = this.after?.(op, info);
    if (e) throw e;
  }
  private debit(pk: string, lamports: number) {
    const need = lamports + BASE_FEE_LAMPORTS;
    if (this.lamports(pk) < need) throw new TxError('insufficient SOL', this.sig(), true);
    this.sol.set(pk, this.lamports(pk) - need);
  }

  /* ---------- Chain ---------- */
  async verifyPayment(): Promise<PaymentCheck> {
    throw new Error('not used');
  }
  async uploadMetadata(): Promise<{ metadataUri: string }> {
    throw new Error('not used');
  }
  async createCoin(): Promise<{ signature: string }> {
    throw new Error('not used');
  }

  async balance(pk: string) {
    this.check('balance', { from: pk });
    return this.lamports(pk);
  }

  async collectCreatorFees(creator: Keypair) {
    const pk = creator.publicKey.toBase58();
    this.check('collect', { from: pk });
    const fee = this.fees.get(pk) ?? 0;
    if (fee <= 0) return null;
    this.fees.set(pk, 0);
    this.sol.set(pk, this.lamports(pk) + fee - BASE_FEE_LAMPORTS); // the claim pays its own fee
    const signature = this.sig();
    this.sent.push({ op: 'collect', from: pk, lamports: fee, signature });
    this.checkAfter('collect', { from: pk });
    return { signature };
  }

  /** Like LiveChain.claimableCreatorFees (not part of Chain). */
  async claimableCreatorFees(creator: PublicKey) {
    if (!this.canPeek) throw new Error('no preview');
    this.check('claimable', { from: creator.toBase58() });
    return this.fees.get(creator.toBase58()) ?? 0;
  }

  async transferSol(input: { from: Keypair; to: string; lamports: number }) {
    const from = input.from.publicKey.toBase58();
    this.check('transferSol', { from, to: input.to, lamports: input.lamports });
    if (!Number.isSafeInteger(input.lamports) || input.lamports <= 0) throw new Error('bad lamports');
    this.debit(from, input.lamports);
    this.sol.set(input.to, this.lamports(input.to) + input.lamports);
    const signature = this.sig();
    this.sent.push({ op: 'transferSol', from, to: input.to, lamports: input.lamports, signature });
    this.checkAfter('transferSol', { from, to: input.to, lamports: input.lamports });
    return { signature };
  }

  async buy(input: { payer: Keypair; mint: string; sol: number }) {
    const from = input.payer.publicKey.toBase58();
    this.check('buy', { from, mint: input.mint, sol: input.sol });
    if (!(input.sol > 0)) throw new Error('bad amount');
    const price = this.prices.get(input.mint);
    if (!price) throw new Error(`no market for ${input.mint}`);
    this.debit(from, Math.round(input.sol * 1e9));
    const amount = BigInt(Math.floor((input.sol / price) * 10 ** this.decimals));
    this.setTokens(from, input.mint, this.tokenOf(from, input.mint) + amount);
    const signature = this.sig();
    this.sent.push({ op: 'buy', from, mint: input.mint, sol: input.sol, amount, signature });
    this.checkAfter('buy', { from, mint: input.mint, sol: input.sol, amount });
    return { signature };
  }

  async burn(input: { owner: Keypair; mint: string; amount: bigint }) {
    const from = input.owner.publicKey.toBase58();
    this.check('burn', { from, mint: input.mint, amount: input.amount });
    const have = this.tokenOf(from, input.mint);
    if (input.amount <= 0n || have < input.amount) throw new TxError('insufficient tokens', this.sig(), true);
    this.debit(from, 0);
    this.setTokens(from, input.mint, have - input.amount);
    const signature = this.sig();
    this.sent.push({ op: 'burn', from, mint: input.mint, amount: input.amount, signature });
    this.checkAfter('burn', { from, mint: input.mint, amount: input.amount });
    return { signature };
  }

  async transferTokens(input: { from: Keypair; mint: string; to: string; amount: bigint }) {
    const from = input.from.publicKey.toBase58();
    this.check('transferTokens', { from, to: input.to, mint: input.mint, amount: input.amount });
    const have = this.tokenOf(from, input.mint);
    if (input.amount <= 0n || have < input.amount) throw new TxError('insufficient tokens', this.sig(), true);
    this.debit(from, 0);
    this.setTokens(from, input.mint, have - input.amount);
    this.setTokens(input.to, input.mint, this.tokenOf(input.to, input.mint) + input.amount);
    const signature = this.sig();
    this.sent.push({ op: 'transferTokens', from, to: input.to, mint: input.mint, amount: input.amount, signature });
    this.checkAfter('transferTokens', { from, to: input.to, mint: input.mint, amount: input.amount });
    return { signature };
  }

  async tokenBalance(owner: string, mint: string): Promise<TokenBalance> {
    this.check('tokenBalance', { from: owner, mint });
    return { amount: this.tokenOf(owner, mint), decimals: this.decimals, program: TOKEN_PROGRAM_ID.toBase58() };
  }

  async coinInfo(mint: string) {
    this.check('coinInfo', { mint });
    const p = this.prices.get(mint);
    return p ? { priceSol: p } : null;
  }

  async holders(mint: string) {
    this.check('holders', { mint });
    return this.holderLists.get(mint) ?? null;
  }

  async accountExists(pk: string) {
    return this.lamports(pk) > 0;
  }
}

/** A program-derived (off-curve) address, like a pump.fun bonding curve. */
export function pdaAddress(seed: string) {
  return PublicKey.findProgramAddressSync([Buffer.from(seed)], new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'))[0].toBase58();
}

export const walletAddress = () => Keypair.generate().publicKey.toBase58();
