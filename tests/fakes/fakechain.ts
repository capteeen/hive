/**
 * Scriptable Chain for tests. Every call is recorded in `calls`; behaviour defaults to "everything
 * works" and can be overridden per method through `script`. Created mints are tracked so
 * `accountExists` answers like the real chain would.
 */
import type { Keypair } from '@solana/web3.js';
import type { Chain, PaymentCheck, TokenBalance } from '@/lib/server/chain';

type Fn<K extends keyof Chain> = NonNullable<Chain[K]> extends (...a: infer A) => infer R ? (...a: A) => R : never;
export type Script = { [K in keyof Chain]?: Fn<K> };

let seq = 0;
/** 88-char base58 fake signature, unique per call. */
export const fakeSig = (tag = 'S') => {
  const n = (++seq).toString().replace(/0/g, 'z');
  return `${tag}${n}`.padEnd(88, '1').slice(0, 88);
};

export class FakeChain implements Chain {
  readonly kind: 'live' | 'mock';
  calls: { method: string; args: unknown[] }[] = [];
  script: Script = {};
  /** On-chain accounts (mints that were created, plus anything a test adds). */
  accounts = new Set<string>();
  sol = new Map<string, number>();
  tokens = new Map<string, bigint>();

  constructor(kind: 'live' | 'mock' = 'live') {
    this.kind = kind;
  }

  count(method: string) {
    return this.calls.filter((c) => c.method === method).length;
  }

  private rec(method: string, args: unknown[]) {
    this.calls.push({ method, args });
  }

  async verifyPayment(signature: string, from: string, to: string, lamports: number, notBefore: number): Promise<PaymentCheck> {
    this.rec('verifyPayment', [signature, from, to, lamports, notBefore]);
    if (this.script.verifyPayment) return this.script.verifyPayment(signature, from, to, lamports, notBefore);
    this.sol.set(to, (this.sol.get(to) ?? 0) + lamports);
    return { ok: true, lamports };
  }
  async balance(pubkey: string): Promise<number> {
    this.rec('balance', [pubkey]);
    if (this.script.balance) return this.script.balance(pubkey);
    return this.sol.get(pubkey) ?? 0;
  }
  async accountExists(pubkey: string): Promise<boolean> {
    this.rec('accountExists', [pubkey]);
    if (this.script.accountExists) return this.script.accountExists(pubkey);
    return this.accounts.has(pubkey);
  }
  async uploadMetadata(input: Parameters<Chain['uploadMetadata']>[0]) {
    this.rec('uploadMetadata', [input]);
    if (this.script.uploadMetadata) return this.script.uploadMetadata(input);
    return { metadataUri: 'https://ipfs.io/ipfs/QmMeta', imageUri: 'https://ipfs.io/ipfs/QmImage' };
  }
  async createCoin(input: { creator: Keypair; mint: Keypair; name: string; symbol: string; uri: string; devBuySol: number }) {
    this.rec('createCoin', [input]);
    if (this.script.createCoin) return this.script.createCoin(input);
    const mint = input.mint.publicKey.toBase58();
    if (this.accounts.has(mint)) throw new Error('mint already in use');
    this.accounts.add(mint);
    if (input.devBuySol > 0) this.tokens.set(`${input.creator.publicKey.toBase58()}|${mint}`, BigInt(Math.round(input.devBuySol * 1e12)));
    return { signature: fakeSig('C') };
  }
  async tokenBalance(owner: string, mint: string): Promise<TokenBalance> {
    this.rec('tokenBalance', [owner, mint]);
    if (this.script.tokenBalance) return this.script.tokenBalance(owner, mint);
    return { amount: this.tokens.get(`${owner}|${mint}`) ?? 0n, decimals: 6, program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
  }
  async transferTokens(input: { from: Keypair; mint: string; to: string; amount: bigint }) {
    this.rec('transferTokens', [input]);
    if (this.script.transferTokens) return this.script.transferTokens(input);
    const k = `${input.from.publicKey.toBase58()}|${input.mint}`;
    const have = this.tokens.get(k) ?? 0n;
    if (have < input.amount) throw new Error('insufficient tokens');
    this.tokens.set(k, have - input.amount);
    const tk = `${input.to}|${input.mint}`;
    this.tokens.set(tk, (this.tokens.get(tk) ?? 0n) + input.amount);
    return { signature: fakeSig('T') };
  }
  async transferSol(input: { from: Keypair; to: string; lamports: number }) {
    this.rec('transferSol', [input]);
    if (this.script.transferSol) return this.script.transferSol(input);
    const from = input.from.publicKey.toBase58();
    const have = this.sol.get(from) ?? 0;
    if (have < input.lamports + 5000) throw new Error('insufficient SOL');
    this.sol.set(from, have - input.lamports - 5000);
    this.sol.set(input.to, (this.sol.get(input.to) ?? 0) + input.lamports);
    return { signature: fakeSig('R') };
  }
  async collectCreatorFees(creator: Keypair) {
    this.rec('collectCreatorFees', [creator]);
    if (this.script.collectCreatorFees) return this.script.collectCreatorFees(creator);
    return null;
  }
  async buy(input: { payer: Keypair; mint: string; sol: number }) {
    this.rec('buy', [input]);
    if (this.script.buy) return this.script.buy(input);
    return { signature: fakeSig('B') };
  }
  async burn(input: { owner: Keypair; mint: string; amount: bigint }) {
    this.rec('burn', [input]);
    if (this.script.burn) return this.script.burn(input);
    return { signature: fakeSig('X') };
  }
  async coinInfo(mint: string) {
    this.rec('coinInfo', [mint]);
    if (this.script.coinInfo) return this.script.coinInfo(mint);
    return { priceSol: 0.00000003, marketCapSol: 30, complete: false };
  }
  async holders(mint: string) {
    this.rec('holders', [mint]);
    if (this.script.holders) return this.script.holders(mint);
    return { count: 1, top: [] };
  }
}
