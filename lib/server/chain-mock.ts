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
 * State is process-wide (kept on globalThis, see `sharedMockState`) for the default instance that
 * getChain() builds, so the launch routes and the mock engine ticker see the same balances and coins.
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

export interface MockCoin {
  creator?: string;
  createdAt: number;
  price: number;
  priceAt: number;
  holders: number;
  holdersAt: number;
}

export interface FeeVault {
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

/** Everything a MockChain remembers: the mock ledger. */
export interface MockState {
  /** Lamports per pubkey. */
  sol: Map<string, number>;
  /** Token units per `owner|mint`. */
  tokens: Map<string, bigint>;
  coins: Map<string, MockCoin>;
  vaults: Map<string, FeeVault>;
  /** Payment signatures already credited (each one counts once). */
  credited: Set<string>;
}

const freshState = (): MockState => ({ sol: new Map(), tokens: new Map(), coins: new Map(), vaults: new Map(), credited: new Set() });

/**
 * The process-wide ledger, on globalThis. Next.js bundles route handlers and instrumentation.ts (which
 * starts the mock engine ticker) as separate module copies, each with its own getChain() singleton and
 * so its own MockChain. With per-instance state the engine would never see the SOL a launch deposited,
 * the coin it created or its dev-buy tokens, and would overwrite the new hive's honey with 0. Same
 * pattern as db-file.ts and engine-autorun.ts.
 */
const registry = globalThis as unknown as { __hiveMockChainV1?: MockState };
export function sharedMockState(): MockState {
  return (registry.__hiveMockChainV1 ??= freshState());
}

export interface MockChainOptions {
  seed?: number;
  /** Clock (ms); defaults to Date.now. */
  now?: () => number;
  /**
   * Use the process-wide ledger (true) or a private one (false). Defaults to shared for a plain
   * `new MockChain()` (what getChain() builds) and private when a seed or clock is injected (tests,
   * simulations), so those never see or disturb the server's mock balances.
   */
  shared?: boolean;
}

export class MockChain implements Chain {
  readonly kind = 'mock' as const;
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly sol: Map<string, number>;
  private readonly tokens: Map<string, bigint>;
  private readonly coins: Map<string, MockCoin>;
  private readonly vaults: Map<string, FeeVault>;
  private readonly credited: Set<string>;

  constructor(opts: MockChainOptions = {}) {
    this.rng = mulberry32(opts.seed ?? (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
    this.now = opts.now ?? Date.now;
    const shared = opts.shared ?? (opts.seed === undefined && opts.now === undefined);
    const state = shared ? sharedMockState() : freshState();
    this.sol = state.sol;
    this.tokens = state.tokens;
    this.coins = state.coins;
    this.vaults = state.vaults;
    this.credited = state.credited;
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

  /**
   * Take over a hive this ledger has never seen (it was founded before a restart, or on another server
   * instance): the hives are persisted, the ledger is not. Her balance is rebuilt from the stored honey
   * (`lamports`), and her coin from the stored price and bees, so the engine and the refresh carry on
   * from what everybody already sees instead of resetting it (honey 0, made-up price and bees). A queen
   * or coin the ledger already knows is left exactly as it is. Returns whether anything was adopted.
   */
  adopt(input: { queenWallet: string; mint: string; lamports: number; price?: number; holders: number; createdAt: number }): boolean {
    let changed = false;
    if (!this.sol.has(input.queenWallet)) {
      this.sol.set(input.queenWallet, Math.max(0, Math.round(input.lamports)));
      changed = true;
    }
    const c = this.coins.get(input.mint);
    if (!c?.creator) {
      // unknown, or only made up on the fly by coin() for a read: the stored hive knows better
      const t = this.now();
      const price = input.price && Number.isFinite(input.price) && input.price > 0 ? Math.min(MAX_PRICE, input.price) : (c?.price ?? START_PRICE);
      this.coins.set(input.mint, { creator: input.queenWallet, createdAt: input.createdAt, price, priceAt: t, holders: Math.max(0, Math.round(input.holders)), holdersAt: t });
      changed = true;
    }
    if (!this.vaults.has(input.queenWallet)) {
      // her fee vault ages from the hive's birth, not from the restart
      const t = this.now();
      this.vaults.set(input.queenWallet, { vigor: 0.2 + 0.8 * hash01(input.queenWallet), lastAt: t, bornAt: Math.min(t, input.createdAt) });
      changed = true;
    }
    return changed;
  }
}
