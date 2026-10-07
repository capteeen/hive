import 'server-only';
/**
 * MockChain: a no-network stand-in for Solana + pump.fun, used in mock launch mode (the default).
 *
 *  - SOL balances live in memory per pubkey and start from deposits: `verifyPayment` always succeeds
 *    and credits the payment to `to` once per signature, so a mock launch funds its queen.
 *  - `createCoin` charges the queen a create cost plus the dev buy and gives her the tokens.
 *  - Creator fees accrue randomly per creator (steady for young hives, drying up with age) so the
 *    hourly engine has real-looking work: seals, stores, swarms, and eventually starving hives.
 *  - Prices random-walk; holders grow slowly. Signatures are fake 88-char base58 strings.
 *
 * Everything resets when the process restarts; unknown pubkeys simply have zero balances.
 */
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { Keypair } from '@solana/web3.js';
import { HOUR_MS } from '@/lib/sim';
import { base58, mockSig, mulberry32, type Rng } from '@/lib/rng';
import { BASE_FEE_LAMPORTS, TxError, type Chain, type PaymentCheck, type TokenBalance } from './chain';

const LAMPORTS = 1e9;
const TOKEN_UNITS = 1e6; // pump tokens have 6 decimals
/** What a pump.fun create costs the creator in the mock (rent + fees), in lamports. */
const CREATE_COST_LAMPORTS = 0.02 * LAMPORTS;
/** pump.fun's starting price, SOL per token (≈ 30 SOL virtual / 1.073B tokens). */
const START_PRICE = 0.000000028;
const MAX_PRICE = 0.001;

interface MockCoin {
  creator?: string;
  createdAt: number;
  price: number;
  priceAt: number;
  holders: number;
  holdersAt: number;
}

interface FeeVault {
  /** 0..1, how busy this creator's coin trades. */
  vigor: number;
  lastAt: number;
  bornAt: number;
}

/** Stable 0..1 from a string (FNV-1a), so a creator keeps its character across restarts. */
function hash01(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

export class MockChain implements Chain {
  readonly kind = 'mock' as const;
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly sol = new Map<string, number>();
  private readonly tokens = new Map<string, bigint>();
  private readonly coins = new Map<string, MockCoin>();
  private readonly vaults = new Map<string, FeeVault>();
  private readonly credited = new Set<string>();

  constructor(opts: { seed?: number; now?: () => number } = {}) {
    this.rng = mulberry32(opts.seed ?? (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
    this.now = opts.now ?? Date.now;
  }

  /* ---------- helpers ---------- */
  private sig() {
    return mockSig(this.rng);
  }
  private lamportsOf(pubkey: string) {
    return this.sol.get(pubkey) ?? 0;
  }
  private credit(pubkey: string, lamports: number) {
    this.sol.set(pubkey, this.lamportsOf(pubkey) + lamports);
  }
  /** Debit `lamports` plus the base fee, or fail like a real transaction would. */
  private debit(pubkey: string, lamports: number) {
    const need = lamports + BASE_FEE_LAMPORTS;
    const have = this.lamportsOf(pubkey);
    if (have < need) throw new TxError(`Mock: insufficient SOL in ${pubkey.slice(0, 6)}… (${have / LAMPORTS} < ${need / LAMPORTS}).`, this.sig(), true);
    this.sol.set(pubkey, have - need);
  }
  private tkey(owner: string, mint: string) {
    return `${owner}|${mint}`;
  }
  private coin(mint: string): MockCoin {
    let c = this.coins.get(mint);
    if (!c) {
      // a coin we did not create (e.g. created before a restart): start it somewhere plausible
      const t = this.now();
      c = { createdAt: t, price: START_PRICE * (1 + hash01(mint) * 20), priceAt: t, holders: 1 + Math.floor(hash01(`${mint}h`) * 200), holdersAt: t };
      this.coins.set(mint, c);
    }
    return c;
  }
  private vault(creator: string): FeeVault {
    let v = this.vaults.get(creator);
    if (!v) {
      const t = this.now();
      v = { vigor: 0.2 + 0.8 * hash01(creator), lastAt: t, bornAt: t };
      this.vaults.set(creator, v);
    }
    return v;
  }

  /* ---------- Chain ---------- */
  async verifyPayment(signature: string, _from: string, to: string, lamports: number, _notBefore?: number): Promise<PaymentCheck> {
    if (!this.credited.has(signature)) {
      this.credited.add(signature);
      this.credit(to, lamports);
    }
    return { ok: true, lamports };
  }

  async balance(pubkey: string): Promise<number> {
    return this.lamportsOf(pubkey);
  }

  async accountExists(pubkey: string): Promise<boolean> {
    return (this.coins.has(pubkey) && !!this.coins.get(pubkey)!.creator) || this.lamportsOf(pubkey) > 0;
  }

  async uploadMetadata(): Promise<{ metadataUri: string; imageUri?: string }> {
    return { metadataUri: `ipfs://mock${base58(this.rng, 40)}`, imageUri: `ipfs://mock${base58(this.rng, 40)}` };
  }

  async createCoin(input: { creator: Keypair; mint: Keypair; name: string; symbol: string; uri: string; devBuySol: number }): Promise<{ signature: string }> {
    const mint = input.mint.publicKey.toBase58();
    const creator = input.creator.publicKey.toBase58();
    if (this.coins.get(mint)?.creator) throw new TxError('Mock: mint account already in use.', this.sig(), true);
    const dev = Math.max(0, input.devBuySol);
    this.debit(creator, CREATE_COST_LAMPORTS + Math.round(dev * LAMPORTS));
    const t = this.now();
    const coin: MockCoin = { creator, createdAt: t, price: START_PRICE, priceAt: t, holders: dev > 0 ? 1 : 0, holdersAt: t };
    this.coins.set(mint, coin);
    if (dev > 0) {
      const amount = BigInt(Math.floor((dev / START_PRICE) * TOKEN_UNITS * 0.99));
      this.tokens.set(this.tkey(creator, mint), amount);
      coin.price = Math.min(MAX_PRICE, START_PRICE * (1 + dev / 30) ** 2);
    }
    this.vault(creator).bornAt = t;
    return { signature: this.sig() };
  }

  async tokenBalance(owner: string, mint: string): Promise<TokenBalance> {
    return { amount: this.tokens.get(this.tkey(owner, mint)) ?? 0n, decimals: 6, program: TOKEN_PROGRAM_ID.toBase58() };
  }

  async transferTokens(input: { from: Keypair; mint: string; to: string; amount: bigint }): Promise<{ signature: string }> {
    const from = input.from.publicKey.toBase58();
    const k = this.tkey(from, input.mint);
    const have = this.tokens.get(k) ?? 0n;
    if (input.amount <= 0n || have < input.amount) throw new TxError('Mock: insufficient token balance.', this.sig(), true);
    this.debit(from, 0);
    this.tokens.set(k, have - input.amount);
    const tk = this.tkey(input.to, input.mint);
    if (!this.tokens.get(tk)) this.coin(input.mint).holders++;
    this.tokens.set(tk, (this.tokens.get(tk) ?? 0n) + input.amount);
    return { signature: this.sig() };
  }

  async transferSol(input: { from: Keypair; to: string; lamports: number }): Promise<{ signature: string }> {
    if (!Number.isSafeInteger(input.lamports) || input.lamports <= 0) throw new Error('Lamports must be a positive integer.');
    this.debit(input.from.publicKey.toBase58(), input.lamports);
    this.credit(input.to, input.lamports);
    return { signature: this.sig() };
  }

  /**
   * Fees since the last claim: busy creators earn up to ~0.06 SOL per mock hour; the chance of a
   * dead hour grows with age, so old hives eventually starve unless something revives them.
   */
  async collectCreatorFees(creator: Keypair): Promise<{ signature: string } | null> {
    const pk = creator.publicKey.toBase58();
    const v = this.vault(pk);
    const t = this.now();
    const hours = (t - v.lastAt) / HOUR_MS;
    if (hours <= 0) return null;
    const ageH = (t - v.bornAt) / HOUR_MS;
    const pDead = Math.min(0.92, 0.15 + ageH / 240);
    let lamports = 0;
    // one roll per whole elapsed hour (at least one), each hour busy or dead
    const rolls = Math.max(1, Math.min(48, Math.round(hours)));
    for (let i = 0; i < rolls; i++) {
      if (this.rng() < pDead) continue;
      lamports += v.vigor * (0.005 + this.rng() * 0.055) * LAMPORTS * Math.min(1, hours / rolls);
    }
    v.lastAt = t;
    lamports = Math.floor(lamports);
    if (lamports < 10_000) return null;
    this.credit(pk, lamports);
    return { signature: this.sig() };
  }

  async buy(input: { payer: Keypair; mint: string; sol: number }): Promise<{ signature: string }> {
    if (!(input.sol > 0) || !Number.isFinite(input.sol)) throw new Error('Buy amount must be a positive number of SOL.');
    const payer = input.payer.publicKey.toBase58();
    this.debit(payer, Math.round(input.sol * LAMPORTS));
    const c = this.coin(input.mint);
    const amount = BigInt(Math.floor((input.sol / c.price) * TOKEN_UNITS * 0.99));
    const k = this.tkey(payer, input.mint);
    if (!this.tokens.get(k)) c.holders++;
    this.tokens.set(k, (this.tokens.get(k) ?? 0n) + amount);
    c.price = Math.min(MAX_PRICE, c.price * (1 + input.sol * 0.03));
    return { signature: this.sig() };
  }

  async burn(input: { owner: Keypair; mint: string; amount: bigint }): Promise<{ signature: string }> {
    const owner = input.owner.publicKey.toBase58();
    const k = this.tkey(owner, input.mint);
    const have = this.tokens.get(k) ?? 0n;
    if (input.amount <= 0n || have < input.amount) throw new TxError('Mock: insufficient token balance to burn.', this.sig(), true);
    this.debit(owner, 0);
    this.tokens.set(k, have - input.amount);
    return { signature: this.sig() };
  }

  /** Geometric random walk, one step per elapsed mock-minute-ish, with a faint upward drift. */
  async coinInfo(mint: string): Promise<{ priceSol: number; marketCapSol?: number; complete?: boolean } | null> {
    const c = this.coin(mint);
    const t = this.now();
    const steps = Math.min(240, Math.max(0, Math.floor((t - c.priceAt) / (HOUR_MS / 12))));
    for (let i = 0; i < steps; i++) {
      const g = (this.rng() + this.rng() + this.rng() - 1.5) * 2; // ≈ normal(0, 1)
      c.price = Math.min(MAX_PRICE, Math.max(START_PRICE / 4, c.price * Math.exp(0.035 * g + 0.002)));
    }
    if (steps) c.priceAt = t;
    const marketCapSol = c.price * 1e9;
    return { priceSol: c.price, marketCapSol, complete: marketCapSol >= 400 };
  }

  async holders(mint: string): Promise<{ count: number; top: { owner: string; amount: bigint }[] } | null> {
    const c = this.coin(mint);
    const t = this.now();
    const hours = (t - c.holdersAt) / HOUR_MS;
    if (hours >= 1) {
      const vigor = c.creator ? this.vault(c.creator).vigor : 0.5;
      c.holders += Math.floor(this.rng() * 3 * vigor * Math.min(hours, 24));
      c.holdersAt = t;
    }
    return { count: c.holders, top: [] };
  }

  /* ---------- test / dev helpers (not part of Chain) ---------- */
  /** Give a pubkey SOL out of thin air (mock only). */
  airdrop(pubkey: string, lamports: number) {
    this.credit(pubkey, lamports);
  }
}
