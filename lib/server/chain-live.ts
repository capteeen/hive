import 'server-only';
/**
 * LiveChain: the real Solana / pump.fun / PumpPortal implementation of `Chain`.
 *
 *  - Reads go through one `Connection(config.rpcUrl, 'confirmed')`.
 *  - pump.fun actions (create, buy, collectCreatorFee) use PumpPortal's Local Transaction API:
 *    PumpPortal builds an unsigned transaction, we check it (fee payer, signers, direct SOL outflow),
 *    sign it with keys that never leave this process, and broadcast it through our own RPC.
 *  - Plain SOL / SPL transfers and burns are built locally.
 *  - Every send waits for 'confirmed' by polling getSignatureStatuses, re-broadcasting the same
 *    signed bytes (same signature, so never a double send) until it lands, fails or its blockhash expires.
 *
 * Nothing here logs or returns secret keys.
 */
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
  type ParsedInstruction,
  type PartiallyDecodedInstruction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { config } from './config';
import { BASE_FEE_LAMPORTS, TxError, type Chain, type PaymentCheck, type TokenBalance } from './chain';

/** pump.fun bonding-curve program and its AMM (PumpSwap), where coins trade after they graduate. */
export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
/** pump.fun tokens use 6 decimals; SOL uses 9. */
const PUMP_DECIMALS = 6;
const LAMPORTS = 1e9;
/** Rent-exempt minimum of a 0-byte system account (the pump creator vault). */
const RENT_EXEMPT_EMPTY = 890_880;
/** Token account layout (classic and Token-2022 base): mint 32 | owner 32 | amount u64. */
const TOKEN_AMOUNT_OFFSET = 64;
/** Mint layout: mintAuthority COption<Pubkey> (36) | supply u64 (8) | decimals u8. */
const MINT_DECIMALS_OFFSET = 44;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
/** DAS pages of 1000 token accounts read for a holder list (50k accounts). */
const HOLDER_PAGES = 50;

/**
 * The only programs a PumpPortal transaction may call at the top level. Any other program would get
 * our wallet's signer privilege and could move its SOL by CPI. PumpPortal's own fee is a plain System
 * transfer (counted against the outflow cap); pump.fun's SOL movement happens inside its programs.
 */
const PORTAL_PROGRAMS: readonly PublicKey[] = [
  ComputeBudgetProgram.programId,
  SystemProgram.programId,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
];
/**
 * Top-level token instructions a PumpPortal transaction may use (wrapping and unwrapping SOL, setting
 * up accounts): 1/16/18 InitializeAccount(2/3), 9 CloseAccount (rent back to us only), 17 SyncNative,
 * 22 InitializeImmutableOwner. Nothing that moves, burns or delegates tokens.
 */
const PORTAL_TOKEN_IXS = new Set([1, 9, 16, 17, 18, 22]);
/** The runtime's compute-unit ceiling and its default per instruction when no limit is set. */
const MAX_COMPUTE_UNITS = 1_400_000;
const DEFAULT_UNITS_PER_IX = 200_000;
/** Anchor discriminators of the pump.fun / PumpSwap buys and the argument that caps the SOL they spend. */
const anchorIx = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const PUMP_BUYS: { disc: Buffer; maxSolOffset: number }[] = [
  { disc: anchorIx('buy'), maxSolOffset: 16 }, // buy { amount, max_sol_cost } (PumpSwap: base_amount_out, max_quote_amount_in)
  { disc: anchorIx('buy_exact_sol_in'), maxSolOffset: 8 }, // { spendable_sol_in, min_tokens_out }
  { disc: anchorIx('buy_exact_quote_in'), maxSolOffset: 8 }, // PumpSwap { spendable_quote_in, min_base_amount_out }
];

/** A non-200 answer from PumpPortal; `body` is its (truncated) text for matching and display. */
export class PortalError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`PumpPortal answered ${status}${body ? `: ${body}` : ''}`);
    this.name = 'PortalError';
  }
}

export interface LiveChainOptions {
  /** Injected for tests; defaults to `new Connection(config.rpcUrl, 'confirmed')`. */
  connection?: Connection;
  /** Injected for tests; defaults to the global fetch (looked up at call time). */
  fetch?: typeof fetch;
  /** How long a send waits for 'confirmed' before giving up (the tx may still land). */
  confirmTimeoutMs?: number;
  pollMs?: number;
  rebroadcastMs?: number;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LiveChain implements Chain {
  readonly kind = 'live' as const;
  private readonly conn: Connection;
  private readonly fetchImpl?: typeof fetch;
  private readonly confirmTimeoutMs: number;
  private readonly pollMs: number;
  private readonly rebroadcastMs: number;
  /** Mint -> token program + decimals. Both are immutable for a mint, so caching is safe. */
  private readonly mints = new Map<string, { program: PublicKey; decimals: number }>();

  constructor(opts: LiveChainOptions = {}) {
    this.conn = opts.connection ?? new Connection(config.rpcUrl, 'confirmed');
    this.fetchImpl = opts.fetch;
    this.confirmTimeoutMs = opts.confirmTimeoutMs ?? 50_000;
    this.pollMs = opts.pollMs ?? 1500;
    this.rebroadcastMs = opts.rebroadcastMs ?? 4000;
  }

  private fetch(url: string, init: RequestInit) {
    return (this.fetchImpl ?? globalThis.fetch)(url, init);
  }

  /* ---------------- reads ---------------- */

  async verifyPayment(signature: string, from: string, to: string, lamports: number, notBefore: number): Promise<PaymentCheck> {
    if (!SIGNATURE_RE.test(signature)) return { ok: false, reason: 'That is not a transaction signature.' };
    let tx;
    try {
      tx = await this.conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    } catch (e) {
      return { ok: false, retry: true, reason: `Could not read the payment from Solana yet (${errText(e)}).` };
    }
    if (!tx || !tx.meta) return { ok: false, retry: true, reason: 'Payment not confirmed yet.' };
    if (tx.meta.err) return { ok: false, reason: 'The payment transaction failed on chain.' };
    if (tx.blockTime == null) return { ok: false, retry: true, reason: 'Payment block time not available yet.' };
    if (tx.blockTime * 1000 < notBefore - 120_000) return { ok: false, reason: 'That payment was sent before this launch was prepared.' };

    // Top-level and inner (CPI) instructions: smart wallets may move the SOL through a program.
    const ixs: (ParsedInstruction | PartiallyDecodedInstruction)[] = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions)];
    let paid = 0;
    for (const ix of ixs) {
      if (!('parsed' in ix) || ix.program !== 'system') continue;
      const p = ix.parsed as { type?: string; info?: Record<string, unknown> };
      if (p.type !== 'transfer' && p.type !== 'transferWithSeed') continue;
      const info = p.info ?? {};
      const fromOk = info.source === from || (p.type === 'transferWithSeed' && info.sourceBase === from);
      if (fromOk && info.destination === to && typeof info.lamports === 'number') paid += info.lamports;
    }
    if (paid < lamports) {
      return { ok: false, lamports: paid, reason: paid ? `Payment too small: ${paid / LAMPORTS} SOL sent, ${lamports / LAMPORTS} SOL needed.` : 'That transaction has no SOL transfer from your wallet to the queen wallet.' };
    }
    return { ok: true, lamports: paid };
  }

  async balance(pubkey: string): Promise<number> {
    return this.conn.getBalance(new PublicKey(pubkey), 'confirmed');
  }

  async accountExists(pubkey: string): Promise<boolean> {
    return (await this.conn.getAccountInfo(new PublicKey(pubkey), 'confirmed')) !== null;
  }

  /** Token program (classic SPL or Token-2022) and decimals of a mint, read from the mint account. */
  async mintInfo(mint: string): Promise<{ program: PublicKey; decimals: number }> {
    const hit = this.mints.get(mint);
    if (hit) return hit;
    const res = await this.conn.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
    const acc = res.value;
    if (!acc) throw new Error(`Mint ${mint} was not found on chain.`);
    let program: PublicKey;
    if (acc.owner.equals(TOKEN_PROGRAM_ID)) program = TOKEN_PROGRAM_ID;
    else if (acc.owner.equals(TOKEN_2022_PROGRAM_ID)) program = TOKEN_2022_PROGRAM_ID;
    else throw new Error(`${mint} is not a token mint.`);
    let decimals: number | undefined;
    const data = acc.data as unknown;
    if (data && typeof data === 'object' && 'parsed' in data) {
      const d = (data as { parsed?: { info?: { decimals?: unknown } } }).parsed?.info?.decimals;
      if (typeof d === 'number') decimals = d;
    } else if (Buffer.isBuffer(data) && data.length > MINT_DECIMALS_OFFSET) {
      decimals = data[MINT_DECIMALS_OFFSET];
    }
    if (decimals === undefined) throw new Error(`Could not read the decimals of ${mint}.`);
    const info = { program, decimals };
    this.mints.set(mint, info);
    return info;
  }

  async tokenBalance(owner: string, mint: string): Promise<TokenBalance> {
    const { program, decimals } = await this.mintInfo(mint);
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, program);
    const acc = await this.conn.getAccountInfo(ata, 'confirmed');
    const amount = acc && acc.data.length >= TOKEN_AMOUNT_OFFSET + 8 ? Buffer.from(acc.data).readBigUInt64LE(TOKEN_AMOUNT_OFFSET) : 0n;
    return { amount, decimals, program: program.toBase58() };
  }

  async coinInfo(mint: string): Promise<{ priceSol: number; marketCapSol?: number; complete?: boolean } | null> {
    try {
      const res = await this.fetch(`${config.pumpCoinApi}/${encodeURIComponent(mint)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const j = (await res.json()) as Record<string, unknown>;
      const vsr = Number(j.virtual_sol_reserves);
      const vtr = Number(j.virtual_token_reserves);
      if (!(vsr > 0 && vtr > 0)) return null;
      const priceSol = vsr / LAMPORTS / (vtr / 10 ** PUMP_DECIMALS);
      const supply = Number(j.total_supply);
      const marketCapSol = supply > 0 ? priceSol * (supply / 10 ** PUMP_DECIMALS) : typeof j.market_cap === 'number' ? j.market_cap : undefined;
      return { priceSol, marketCapSol, complete: j.complete === true };
    } catch {
      return null;
    }
  }

  /**
   * Every owner with a positive balance (token accounts summed per owner), largest first, from Helius
   * DAS. The whole list is returned, not a top-N: the abandon payout needs to know every holder to
   * split a vault (it pays at most MAX_PAYOUT_RECIPIENTS of them, see engine.ts). `complete: false`
   * when the page cap was hit before the last page, so the list may be missing holders.
   */
  async holders(mint: string): Promise<{ count: number; top: { owner: string; amount: bigint }[]; complete: boolean } | null> {
    const key = config.heliusApiKey;
    if (!key) return null;
    const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
    const byOwner = new Map<string, bigint>();
    const limit = 1000;
    let complete = false;
    try {
      // DAS pages are 1-based; stop at a short page (or after 50k accounts, which is plenty for a count).
      for (let page = 1; page <= HOLDER_PAGES; page++) {
        const res = await this.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'hive-holders', method: 'getTokenAccounts', params: { mint, page, limit } }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return null;
        const j = (await res.json()) as { result?: { token_accounts?: { owner?: string; amount?: number | string }[] }; error?: unknown };
        const accounts = j.result?.token_accounts;
        if (!Array.isArray(accounts)) return null;
        for (const a of accounts) {
          if (typeof a.owner !== 'string') continue;
          const amt = toBigInt(a.amount);
          if (amt > 0n) byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0n) + amt);
        }
        if (accounts.length < limit) {
          complete = true;
          break;
        }
      }
    } catch {
      return null;
    }
    const top = [...byOwner.entries()]
      .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([owner, amount]) => ({ owner, amount }));
    return { count: byOwner.size, top, complete };
  }

  /* ---------------- pump.fun via PumpPortal ---------------- */

  async uploadMetadata(input: Parameters<Chain['uploadMetadata']>[0]): Promise<{ metadataUri: string; imageUri?: string }> {
    const form = new FormData();
    // copy into a fresh ArrayBuffer-backed view (Blob does not take shared buffers)
    form.append('file', new Blob([new Uint8Array(input.image.bytes)], { type: input.image.mime }), input.image.filename);
    form.append('name', input.name);
    form.append('symbol', input.symbol);
    form.append('description', input.description);
    if (input.twitter) form.append('twitter', input.twitter);
    if (input.telegram) form.append('telegram', input.telegram);
    if (input.website) form.append('website', input.website);
    form.append('showName', 'true');
    const res = await this.fetch(config.pumpIpfsUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`IPFS upload failed (${res.status}): ${(await safeText(res)) || 'no details'}`);
    const j = (await res.json().catch(() => null)) as { metadataUri?: unknown; metadata?: { image?: unknown } } | null;
    const uri = j?.metadataUri;
    if (typeof uri !== 'string' || !/^(https?|ipfs):\/\/\S+$/.test(uri)) throw new Error('IPFS upload returned no metadata URI.');
    const image = j?.metadata?.image;
    return { metadataUri: uri, imageUri: typeof image === 'string' && /^(https?|ipfs):\/\//.test(image) ? image : undefined };
  }

  async createCoin(input: { creator: Keypair; mint: Keypair; name: string; symbol: string; uri: string; devBuySol: number }): Promise<{ signature: string }> {
    const { creator, mint } = input;
    const tx = await this.portalTx({
      publicKey: creator.publicKey.toBase58(),
      action: 'create',
      tokenMetadata: { name: input.name, symbol: input.symbol, uri: input.uri },
      mint: mint.publicKey.toBase58(),
      denominatedInSol: 'true',
      amount: input.devBuySol,
      slippage: config.slippagePct,
      priorityFee: config.priorityFeeSol,
      pool: 'pump',
    });
    this.guard(tx, { payer: creator.publicKey, signers: [creator.publicKey, mint.publicKey], mustSign: mint.publicKey, maxDirectOutLamports: this.spendCap(input.devBuySol) });
    tx.sign([mint, creator]);
    return { signature: await this.sendSigned(tx) };
  }

  async buy(input: { payer: Keypair; mint: string; sol: number }): Promise<{ signature: string }> {
    if (!(input.sol > 0) || !Number.isFinite(input.sol)) throw new Error('Buy amount must be a positive number of SOL.');
    const tx = await this.portalTx({
      publicKey: input.payer.publicKey.toBase58(),
      action: 'buy',
      mint: input.mint,
      amount: input.sol,
      denominatedInSol: 'true',
      slippage: config.slippagePct,
      priorityFee: config.priorityFeeSol,
      pool: 'auto',
    });
    this.guard(tx, { payer: input.payer.publicKey, signers: [input.payer.publicKey], maxDirectOutLamports: this.spendCap(input.sol) });
    tx.sign([input.payer]);
    return { signature: await this.sendSigned(tx) };
  }

  /**
   * Claim pump.fun creator fees. Checks the creator vaults first (bonding curve: SOL in the
   * `creator-vault` PDA above rent; PumpSwap: WSOL in the `creator_vault` authority's ATA) and
   * returns null when there is not enough to be worth a transaction. If that check itself fails
   * we still ask PumpPortal, which answers with an error when there is nothing to claim.
   */
  async collectCreatorFees(creator: Keypair): Promise<{ signature: string } | null> {
    const claimable = await this.claimableCreatorFees(creator.publicKey).catch(() => null);
    const minClaim = Math.max(100_000, Math.round(config.priorityFeeSol * LAMPORTS * 2) + 2 * BASE_FEE_LAMPORTS);
    if (claimable !== null && claimable < minClaim) return null;
    let tx: VersionedTransaction;
    try {
      tx = await this.portalTx({ publicKey: creator.publicKey.toBase58(), action: 'collectCreatorFee', priorityFee: config.priorityFeeSol, pool: 'pump' });
    } catch (e) {
      if (e instanceof PortalError && e.status >= 400 && e.status < 500 && /no (creator )?fees?|nothing to (claim|collect)|zero|insufficient/i.test(e.body)) return null;
      throw e;
    }
    // allow a small service fee proportional to the claim (PumpPortal may take a cut), never more
    this.guard(tx, { payer: creator.publicKey, signers: [creator.publicKey], maxDirectOutLamports: this.spendCap(0) + Math.ceil((claimable ?? 0) * 0.05) });
    tx.sign([creator]);
    return { signature: await this.sendSigned(tx) };
  }

  /** Lamports claimable from both creator vaults. */
  async claimableCreatorFees(creator: PublicKey): Promise<number> {
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), creator.toBuffer()], PUMP_PROGRAM_ID);
    const [ammAuthority] = PublicKey.findProgramAddressSync([Buffer.from('creator_vault'), creator.toBuffer()], PUMP_AMM_PROGRAM_ID);
    const ammVault = getAssociatedTokenAddressSync(NATIVE_MINT, ammAuthority, true, TOKEN_PROGRAM_ID);
    const [v, a] = await this.conn.getMultipleAccountsInfo([vault, ammVault], 'confirmed');
    const curve = v ? Math.max(0, v.lamports - RENT_EXEMPT_EMPTY) : 0;
    const amm = a && a.data.length >= TOKEN_AMOUNT_OFFSET + 8 ? Number(Buffer.from(a.data).readBigUInt64LE(TOKEN_AMOUNT_OFFSET)) : 0;
    return curve + amm;
  }

  /* ---------------- local transactions ---------------- */

  async transferTokens(input: { from: Keypair; mint: string; to: string; amount: bigint }): Promise<{ signature: string }> {
    if (input.amount <= 0n) throw new Error('Token amount must be positive.');
    const { program, decimals } = await this.mintInfo(input.mint);
    const mint = new PublicKey(input.mint);
    const to = new PublicKey(input.to);
    const src = getAssociatedTokenAddressSync(mint, input.from.publicKey, true, program);
    const dst = getAssociatedTokenAddressSync(mint, to, true, program);
    const ixs = [
      ...this.priorityIxs(80_000),
      createAssociatedTokenAccountIdempotentInstruction(input.from.publicKey, dst, to, mint, program, ASSOCIATED_TOKEN_PROGRAM_ID),
      createTransferCheckedInstruction(src, mint, dst, input.from.publicKey, input.amount, decimals, [], program),
    ];
    return { signature: await this.sendIxs(ixs, input.from) };
  }

  async burn(input: { owner: Keypair; mint: string; amount: bigint }): Promise<{ signature: string }> {
    if (input.amount <= 0n) throw new Error('Burn amount must be positive.');
    const { program, decimals } = await this.mintInfo(input.mint);
    const mint = new PublicKey(input.mint);
    const ata = getAssociatedTokenAddressSync(mint, input.owner.publicKey, true, program);
    const ixs = [...this.priorityIxs(40_000), createBurnCheckedInstruction(ata, mint, input.owner.publicKey, input.amount, decimals, [], program)];
    return { signature: await this.sendIxs(ixs, input.owner) };
  }

  /** Plain transfer that pays only the base fee (no compute-budget instructions), so `balance - BASE_FEE_LAMPORTS` drains exactly. */
  async transferSol(input: { from: Keypair; to: string; lamports: number }): Promise<{ signature: string }> {
    if (!Number.isSafeInteger(input.lamports) || input.lamports <= 0) throw new Error('Lamports must be a positive integer.');
    const ix = SystemProgram.transfer({ fromPubkey: input.from.publicKey, toPubkey: new PublicKey(input.to), lamports: input.lamports });
    return { signature: await this.sendIxs([ix], input.from) };
  }

  /* ---------------- plumbing ---------------- */

  /** Most SOL a PumpPortal transaction may move straight out of the signer (WSOL wrap, PumpPortal's fee). */
  private spendCap(sol: number) {
    return Math.ceil(sol * LAMPORTS * (1 + config.slippagePct / 100) * 1.02) + 0.01 * LAMPORTS;
  }

  private priorityIxs(units: number): TransactionInstruction[] {
    const lamports = Math.max(0, Math.round(config.priorityFeeSol * LAMPORTS));
    if (!lamports) return [];
    return [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor((lamports * 1e6) / units) })];
  }

  private async portalTx(body: Record<string, unknown>): Promise<VersionedTransaction> {
    const res = await this.fetch(config.pumpPortalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status !== 200) throw new PortalError(res.status, await safeText(res));
    const bytes = new Uint8Array(await res.arrayBuffer());
    try {
      return VersionedTransaction.deserialize(bytes);
    } catch {
      throw new Error('PumpPortal returned something that is not a transaction.');
    }
  }

  /**
   * Refuse to sign a PumpPortal transaction that does not look like what we asked for: the fee payer
   * must be our wallet, only our keys may sign, only allow-listed programs may be called at the top
   * level (PORTAL_PROGRAMS), the priority fee (unit limit × unit price) may not exceed twice
   * PRIORITY_FEE_SOL, top-level System instructions may only create accounts or transfer (with a cap on
   * SOL moved out of the payer), top-level token instructions may only set up, sync or close accounts,
   * and a pump.fun / PumpSwap buy may not allow itself to spend more than that same cap. pump.fun's
   * own SOL movement happens inside its programs (CPI).
   */
  private guard(tx: VersionedTransaction, opts: { payer: PublicKey; signers: PublicKey[]; mustSign?: PublicKey; maxDirectOutLamports: number }) {
    const msg = tx.message;
    const keys = msg.staticAccountKeys;
    const nSig = msg.header.numRequiredSignatures;
    if (!keys[0]?.equals(opts.payer)) throw new Error('PumpPortal returned a transaction with an unexpected fee payer; not signing it.');
    const signers = keys.slice(0, nSig);
    for (const s of signers) if (!opts.signers.some((k) => k.equals(s))) throw new Error('PumpPortal returned a transaction that needs an unexpected signer; not signing it.');
    if (opts.mustSign && !signers.some((s) => s.equals(opts.mustSign!))) throw new Error('PumpPortal returned a create transaction that does not use our mint; not signing it.');
    let out = 0n;
    let viaPump = 0n;
    let unitLimit: number | null = null;
    let unitPrice = 0n; // micro-lamports per compute unit
    let otherIxs = 0;
    for (const ix of msg.compiledInstructions) {
      // Program ids are always static keys; an index into the lookup tables is not a known program.
      const program = ix.programIdIndex < keys.length ? keys[ix.programIdIndex] : undefined;
      if (!program || !PORTAL_PROGRAMS.some((p) => p.equals(program))) {
        throw new Error(`PumpPortal transaction calls an unexpected program (${program?.toBase58() ?? 'from a lookup table'}); not signing it.`);
      }
      const data = Buffer.from(ix.data);
      const acct = (i: number) => keys[ix.accountKeyIndexes[i]];
      if (program.equals(ComputeBudgetProgram.programId)) {
        // 1 RequestHeapFrame(u32), 2 SetComputeUnitLimit(u32), 3 SetComputeUnitPrice(u64), 4 SetLoadedAccountsDataSizeLimit(u32)
        const kind = data.length ? data[0] : -1;
        if (kind === 2 && data.length >= 5) unitLimit = Math.max(unitLimit ?? 0, data.readUInt32LE(1));
        else if (kind === 3 && data.length >= 9) unitPrice = maxBig(unitPrice, data.readBigUInt64LE(1));
        else if (!((kind === 1 || kind === 4) && data.length >= 5)) throw new Error(`PumpPortal transaction has an unexpected compute-budget instruction (${kind}); not signing it.`);
        continue;
      }
      otherIxs++;
      if (program.equals(SystemProgram.programId)) {
        const kind = data.length >= 4 ? data.readUInt32LE(0) : -1;
        // 0 CreateAccount { lamports, space, owner }, 2 Transfer { lamports }
        if ((kind === 0 || kind === 2) && data.length >= 12) {
          if (acct(0)?.equals(opts.payer)) out += data.readBigUInt64LE(4);
        } else {
          throw new Error(`PumpPortal transaction has an unexpected System instruction (${kind}); not signing it.`);
        }
      } else if (program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID)) {
        const kind = data.length ? data[0] : -1;
        if (!PORTAL_TOKEN_IXS.has(kind)) throw new Error(`PumpPortal transaction has an unexpected token instruction (${kind}); not signing it.`);
        // 9 CloseAccount: the rent must come back to us
        if (kind === 9 && !acct(1)?.equals(opts.payer)) throw new Error('PumpPortal transaction closes an account to someone else; not signing it.');
      } else if (program.equals(PUMP_PROGRAM_ID) || program.equals(PUMP_AMM_PROGRAM_ID)) {
        const buy = PUMP_BUYS.find((b) => data.length >= 8 && data.subarray(0, 8).equals(b.disc));
        if (buy) {
          if (data.length < buy.maxSolOffset + 8) throw new Error('PumpPortal transaction has a buy without a spending limit; not signing it.');
          viaPump += data.readBigUInt64LE(buy.maxSolOffset);
        }
      }
    }
    const cap = BigInt(opts.maxDirectOutLamports);
    if (out > cap) throw new Error(`PumpPortal transaction moves ${Number(out) / LAMPORTS} SOL directly out of the wallet; not signing it.`);
    if (viaPump > cap) throw new Error(`PumpPortal transaction lets pump.fun spend up to ${Number(viaPump) / LAMPORTS} SOL; not signing it.`);
    // Priority fee = unit limit × unit price; without a limit the runtime grants 200k units per instruction.
    const units = BigInt(Math.min(MAX_COMPUTE_UNITS, unitLimit ?? DEFAULT_UNITS_PER_IX * Math.max(1, otherIxs)));
    const priorityLamports = (units * unitPrice + 999_999n) / 1_000_000n;
    const maxPriority = BigInt(Math.max(0, Math.ceil(config.priorityFeeSol * 2 * LAMPORTS)));
    if (priorityLamports > maxPriority) throw new Error(`PumpPortal transaction sets a priority fee of ${Number(priorityLamports) / LAMPORTS} SOL; not signing it.`);
  }

  private async sendIxs(ixs: TransactionInstruction[], payer: Keypair): Promise<string> {
    const { blockhash } = await this.conn.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);
    return this.sendSigned(tx);
  }

  /**
   * Broadcast a fully signed transaction and wait for 'confirmed'. Throws TxError (with the
   * signature) when it fails on chain, can no longer land, or is still unconfirmed at the timeout.
   */
  private async sendSigned(tx: VersionedTransaction): Promise<string> {
    const sig = bs58.encode(tx.signatures[0]);
    const raw = tx.serialize();
    try {
      await this.conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
    } catch (e) {
      const m = errText(e);
      // Preflight rejected it: it was not broadcast and cannot land. "Already processed" means it did land.
      if (e instanceof SendTransactionError && !/already been processed/i.test(m)) throw new TxError(`Transaction rejected: ${m}`, sig, false);
      // Anything else (network) is ambiguous: fall through and watch for it, re-broadcasting below.
    }
    const start = Date.now();
    let lastSend = start;
    let lastBlockhashCheck = start;
    for (;;) {
      if (this.pollMs) await sleep(this.pollMs);
      let st: Awaited<ReturnType<Connection['getSignatureStatuses']>>['value'][number] | undefined;
      try {
        st = (await this.conn.getSignatureStatuses([sig], { searchTransactionHistory: false })).value[0];
      } catch {
        st = undefined; // RPC hiccup: unknown, keep waiting
      }
      if (st) {
        if (st.err) throw new TxError(`Transaction failed on chain: ${JSON.stringify(st.err)}`, sig, true);
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return sig;
      }
      const now = Date.now();
      if (now - start > this.confirmTimeoutMs) throw new TxError('Transaction not confirmed in time. It may still land; retrying will check first.', sig);
      if (st === null && now - lastBlockhashCheck > 10_000) {
        lastBlockhashCheck = now;
        const valid = await this.conn.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'processed' }).then((r) => r.value).catch(() => true);
        if (!valid) {
          const final = await this.conn.getSignatureStatuses([sig], { searchTransactionHistory: true }).then((r) => r.value[0]).catch(() => undefined);
          if (final === null) throw new TxError('Transaction expired before it landed.', sig, false);
        }
      }
      if (!st && now - lastSend >= this.rebroadcastMs) {
        lastSend = now;
        // same signed bytes = same signature: re-broadcasting can never double-spend
        this.conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      }
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    return '';
  }
}

const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);

function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return 0n;
}
