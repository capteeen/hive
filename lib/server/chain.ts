import 'server-only';
/**
 * Everything that touches Solana / pump.fun / PumpPortal goes through this interface, so the launch
 * flow and the hourly engine can be tested with a fake. LiveChain lives in lib/server/chain-live.ts,
 * MockChain in lib/server/chain-mock.ts.
 */
import type { Keypair } from '@solana/web3.js';
import { config } from './config';

export interface PaymentCheck {
  ok: boolean;
  /** Why it failed; `retry` = not final yet (e.g. not confirmed), try again shortly. */
  reason?: string;
  retry?: boolean;
  lamports?: number;
}

export interface TokenBalance {
  amount: bigint;
  decimals: number;
  /** Token program that owns the mint (classic SPL or Token-2022). */
  program: string;
}

export interface Chain {
  readonly kind: 'live' | 'mock';
  /** A confirmed SOL transfer of ≥ `lamports` from `from` to `to`, sent after `notBefore` (ms). */
  verifyPayment(signature: string, from: string, to: string, lamports: number, notBefore: number): Promise<PaymentCheck>;
  /** Lamports. */
  balance(pubkey: string): Promise<number>;
  /** Upload image + metadata to IPFS (pump.fun). */
  uploadMetadata(input: { image: { bytes: Uint8Array; mime: string; filename: string }; name: string; symbol: string; description: string; twitter?: string; telegram?: string; website?: string }): Promise<{ metadataUri: string; imageUri?: string }>;
  /** Create the coin on pump.fun with `creator` as creator, optional dev buy (SOL). */
  createCoin(input: { creator: Keypair; mint: Keypair; name: string; symbol: string; uri: string; devBuySol: number }): Promise<{ signature: string }>;
  tokenBalance(owner: string, mint: string): Promise<TokenBalance>;
  transferTokens(input: { from: Keypair; mint: string; to: string; amount: bigint }): Promise<{ signature: string }>;
  transferSol(input: { from: Keypair; to: string; lamports: number }): Promise<{ signature: string }>;
  /** Claim pump.fun creator fees for `creator`. Null when there was nothing to claim. */
  collectCreatorFees(creator: Keypair): Promise<{ signature: string } | null>;
  buy(input: { payer: Keypair; mint: string; sol: number }): Promise<{ signature: string }>;
  burn(input: { owner: Keypair; mint: string; amount: bigint }): Promise<{ signature: string }>;
  /** Current price in SOL per token (and whether the bonding curve completed). */
  coinInfo(mint: string): Promise<{ priceSol: number; marketCapSol?: number; complete?: boolean } | null>;
  /** Holder count (needs HELIUS_API_KEY in live mode). Null when unknown. */
  holders(mint: string): Promise<{ count: number; top: { owner: string; amount: bigint }[] } | null>;
}

let instance: Promise<Chain> | null = null;

export function getChain(): Promise<Chain> {
  if (!instance) {
    instance = (async () => {
      if (config.launchMode === 'live') {
        const { LiveChain } = await import('./chain-live');
        return new LiveChain();
      }
      const { MockChain } = await import('./chain-mock');
      return new MockChain();
    })();
  }
  return instance;
}

export function setChainForTests(c: Chain | null) {
  instance = c ? Promise.resolve(c) : null;
}
