/**
 * #5: the PumpPortal transaction guard refuses programs outside the allow-list (they would get the
 * payer's signer privilege), caps the priority fee (unit limit x unit price) at twice PRIORITY_FEE_SOL,
 * and caps what a pump.fun buy may spend; a normal-looking PumpPortal transaction still goes through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createBurnInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { config } from '@/lib/server/config';
import { LiveChain, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from '@/lib/server/chain-live';

const BLOCKHASH = '11111111111111111111111111111111';
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

function fakeConnection() {
  const sent: Uint8Array[] = [];
  return {
    sent,
    sendRawTransaction: vi.fn(async (raw: Uint8Array) => {
      sent.push(raw);
      return 'sig';
    }),
    getSignatureStatuses: vi.fn(async () => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] })),
    isBlockhashValid: vi.fn(async () => ({ context: { slot: 1 }, value: true })),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 })),
  };
}

/** A pump.fun buy { amount, max_sol_cost } with the payer as signer. */
function pumpBuy(payer: PublicKey, maxSolLamports: bigint, program = PUMP_PROGRAM_ID, name = 'buy') {
  const data = Buffer.alloc(24);
  disc(name).copy(data, 0);
  if (name === 'buy') {
    data.writeBigUInt64LE(123_456n, 8);
    data.writeBigUInt64LE(maxSolLamports, 16);
  } else {
    data.writeBigUInt64LE(maxSolLamports, 8);
    data.writeBigUInt64LE(1n, 16);
  }
  return new TransactionInstruction({ programId: program, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data });
}

/** Build the PumpPortal answer, run a 0.01 SOL buy through LiveChain, and return what was broadcast. */
async function buyWith(payer: Keypair, ixs: TransactionInstruction[]) {
  const bytes = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message()).serialize();
  const conn = fakeConnection();
  const chain = new LiveChain({ connection: conn as unknown as Connection, fetch: (async () => new Response(new Uint8Array(bytes), { status: 200 })) as unknown as typeof fetch, pollMs: 0, confirmTimeoutMs: 2000 });
  const res = await chain.buy({ payer, mint: Keypair.generate().publicKey.toBase58(), sol: 0.01 }).then(
    (r) => ({ ok: true as const, sig: r.signature }),
    (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
  );
  return { res, sent: conn.sent };
}

beforeEach(() => {
  config.priorityFeeSol = 0.0005;
  config.slippagePct = 10;
});

describe('#5 LiveChain guard on PumpPortal transactions', () => {
  it('refuses an arbitrary program and an unbounded priority fee (the reported transaction)', async () => {
    const payer = Keypair.generate();
    const drainer = Keypair.generate().publicKey;
    const { res, sent } = await buyWith(payer, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 700_000 }), // 0.98 SOL of priority fee
      new TransactionInstruction({ programId: drainer, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1]) }),
      pumpBuy(payer.publicKey, 11_000_000n),
    ]);
    expect(res.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('refuses an unexpected program on its own', async () => {
    const payer = Keypair.generate();
    const drainer = Keypair.generate().publicKey;
    const { res, sent } = await buyWith(payer, [
      new TransactionInstruction({ programId: drainer, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1]) }),
      pumpBuy(payer.publicKey, 11_000_000n),
    ]);
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/unexpected program/) });
    expect(sent).toHaveLength(0);
  });

  it('refuses a priority fee above twice PRIORITY_FEE_SOL, with or without an explicit unit limit', async () => {
    const payer = Keypair.generate();
    // 200k units x 6M micro-lamports = 0.0012 SOL > 2 x 0.0005
    let r = await buyWith(payer, [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 6_000_000 }), pumpBuy(payer.publicKey, 11_000_000n)]);
    expect(r.res).toMatchObject({ ok: false, error: expect.stringMatching(/priority fee/) });
    // no limit: the runtime default (200k per instruction) is assumed
    r = await buyWith(payer, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 6_000_000 }), pumpBuy(payer.publicKey, 11_000_000n)]);
    expect(r.res).toMatchObject({ ok: false, error: expect.stringMatching(/priority fee/) });
    expect(r.sent).toHaveLength(0);
  });

  it('refuses a pump.fun or PumpSwap buy allowed to spend more than the cap, and token burns', async () => {
    const payer = Keypair.generate();
    let r = await buyWith(payer, [pumpBuy(payer.publicKey, 1_000_000_000n)]);
    expect(r.res).toMatchObject({ ok: false, error: expect.stringMatching(/spend up to 1 SOL/) });
    r = await buyWith(payer, [pumpBuy(payer.publicKey, 1_000_000_000n, PUMP_PROGRAM_ID, 'buy_exact_sol_in')]);
    expect(r.res.ok).toBe(false);
    r = await buyWith(payer, [pumpBuy(payer.publicKey, 1_000_000_000n, PUMP_AMM_PROGRAM_ID)]);
    expect(r.res.ok).toBe(false);
    const mint = Keypair.generate().publicKey;
    const ata = getAssociatedTokenAddressSync(mint, payer.publicKey);
    r = await buyWith(payer, [createBurnInstruction(ata, mint, payer.publicKey, 5n), pumpBuy(payer.publicKey, 11_000_000n)]);
    expect(r.res).toMatchObject({ ok: false, error: expect.stringMatching(/unexpected token instruction/) });
    expect(r.sent).toHaveLength(0);
  });

  it('signs a normal PumpPortal buy: priority fee within the cap, ATA, pump buy within the cap, the PumpPortal fee transfer', async () => {
    const payer = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, true, TOKEN_PROGRAM_ID);
    const { res, sent } = await buyWith(payer, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_000 }), // 0.0005 SOL
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, payer.publicKey, mint),
      pumpBuy(payer.publicKey, 11_000_000n), // 0.01 SOL + 10% slippage
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 100_000 }),
    ]);
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
