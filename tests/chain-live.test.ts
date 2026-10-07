import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { config } from '@/lib/server/config';
import { TxError } from '@/lib/server/chain';
import { LiveChain, PUMP_PROGRAM_ID } from '@/lib/server/chain-live';

const BLOCKHASH = '11111111111111111111111111111111';

/** What PumpPortal would hand back: an unsigned v0 transaction paid by `payer`. */
function portalTx(payer: PublicKey, signers: PublicKey[], extra: TransactionInstruction[] = []) {
  const ix = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: signers.map((pubkey) => ({ pubkey, isSigner: true, isWritable: true })),
    data: Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]),
  });
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: [...extra, ix] }).compileToV0Message();
  return new VersionedTransaction(msg).serialize();
}

function fakeConnection() {
  const sent: Uint8Array[] = [];
  const conn = {
    sent,
    sendRawTransaction: vi.fn(async (raw: Uint8Array) => {
      sent.push(raw);
      return 'sig';
    }),
    getSignatureStatuses: vi.fn(async () => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] })),
    isBlockhashValid: vi.fn(async () => ({ context: { slot: 1 }, value: true })),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 })),
    getParsedTransaction: vi.fn(),
    getParsedAccountInfo: vi.fn(),
    getAccountInfo: vi.fn(async () => null),
    getMultipleAccountsInfo: vi.fn(async () => [null, null]),
    getBalance: vi.fn(async () => 0),
  };
  return conn;
}

type FakeConn = ReturnType<typeof fakeConnection>;

function chainWith(conn: FakeConn, fetchImpl?: typeof fetch) {
  return new LiveChain({ connection: conn as unknown as Connection, fetch: fetchImpl, pollMs: 0, confirmTimeoutMs: 2000 });
}

const bytesResponse = (bytes: Uint8Array) => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'application/octet-stream' } });

/** Signature `i` of a sent transaction verifies against `pubkey`. */
function signedBy(raw: Uint8Array, pubkey: PublicKey) {
  const tx = VersionedTransaction.deserialize(raw);
  const i = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).findIndex((k) => k.equals(pubkey));
  return i >= 0 && nacl.sign.detached.verify(tx.message.serialize(), tx.signatures[i], pubkey.toBytes());
}

beforeEach(() => {
  config.priorityFeeSol = 0.0005;
  config.slippagePct = 10;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LiveChain: pump.fun via PumpPortal', () => {
  it('uploads image + metadata as multipart to the pump IPFS endpoint', async () => {
    let form: FormData | null = null;
    let url = '';
    const fetchMock = vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
      url = String(u);
      form = init?.body as FormData;
      return Response.json({ metadataUri: 'https://ipfs.io/ipfs/QmMeta', metadata: { name: 'Amber', symbol: 'AMBER', image: 'https://ipfs.io/ipfs/QmImg' } });
    });
    vi.stubGlobal('fetch', fetchMock); // the chain uses the global fetch when none is injected
    const chain = chainWith(fakeConnection());
    const res = await chain.uploadMetadata({
      image: { bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png', filename: 'coin.png' },
      name: 'Amber',
      symbol: 'AMBER',
      description: 'desc',
      twitter: 'https://x.com/a',
      telegram: 'https://t.me/a',
      website: 'https://hive.example/hive/x',
    });
    expect(url).toBe(config.pumpIpfsUrl);
    const f = form as unknown as FormData;
    const file = f.get('file') as File;
    expect(file.type).toBe('image/png');
    expect(file.name).toBe('coin.png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(Object.fromEntries([...f.entries()].filter(([k]) => k !== 'file'))).toEqual({
      name: 'Amber',
      symbol: 'AMBER',
      description: 'desc',
      twitter: 'https://x.com/a',
      telegram: 'https://t.me/a',
      website: 'https://hive.example/hive/x',
      showName: 'true',
    });
    expect(res).toEqual({ metadataUri: 'https://ipfs.io/ipfs/QmMeta', imageUri: 'https://ipfs.io/ipfs/QmImg' });
  });

  it('createCoin posts the PumpPortal create body and signs with [mint, creator]', async () => {
    const creator = Keypair.generate();
    const mint = Keypair.generate();
    let body: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
      expect(String(u)).toBe(config.pumpPortalUrl);
      body = JSON.parse(String(init?.body));
      return bytesResponse(portalTx(creator.publicKey, [creator.publicKey, mint.publicKey]));
    });
    const conn = fakeConnection();
    const chain = chainWith(conn, fetchMock as unknown as typeof fetch);
    const { signature } = await chain.createCoin({ creator, mint, name: 'Amber', symbol: 'AMBER', uri: 'https://ipfs.io/ipfs/QmMeta', devBuySol: 0.5 });
    expect(body).toEqual({
      publicKey: creator.publicKey.toBase58(),
      action: 'create',
      tokenMetadata: { name: 'Amber', symbol: 'AMBER', uri: 'https://ipfs.io/ipfs/QmMeta' },
      mint: mint.publicKey.toBase58(),
      denominatedInSol: 'true',
      amount: 0.5,
      slippage: 10,
      priorityFee: 0.0005,
      pool: 'pump',
    });
    expect(conn.sent).toHaveLength(1);
    expect(signedBy(conn.sent[0], mint.publicKey)).toBe(true);
    expect(signedBy(conn.sent[0], creator.publicKey)).toBe(true);
    expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    expect(conn.getSignatureStatuses).toHaveBeenCalled();
  });

  it('refuses to sign a PumpPortal transaction that drains the creator or needs a stranger', async () => {
    const creator = Keypair.generate();
    const mint = Keypair.generate();
    const thief = Keypair.generate().publicKey;
    const drain = SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: thief, lamports: 5e9 });
    const conn = fakeConnection();
    let chain = chainWith(conn, (async () => bytesResponse(portalTx(creator.publicKey, [creator.publicKey, mint.publicKey], [drain]))) as unknown as typeof fetch);
    await expect(chain.createCoin({ creator, mint, name: 'A', symbol: 'A', uri: 'https://x', devBuySol: 0.1 })).rejects.toThrow(/not signing/);
    const stranger = Keypair.generate().publicKey;
    chain = chainWith(conn, (async () => bytesResponse(portalTx(creator.publicKey, [creator.publicKey, mint.publicKey, stranger]))) as unknown as typeof fetch);
    await expect(chain.createCoin({ creator, mint, name: 'A', symbol: 'A', uri: 'https://x', devBuySol: 0 })).rejects.toThrow(/unexpected signer/);
    chain = chainWith(conn, (async () => bytesResponse(portalTx(stranger, [stranger, creator.publicKey]))) as unknown as typeof fetch);
    await expect(chain.createCoin({ creator, mint, name: 'A', symbol: 'A', uri: 'https://x', devBuySol: 0 })).rejects.toThrow(/fee payer/);
    expect(conn.sent).toHaveLength(0);
  });

  it('surfaces on-chain errors and preflight rejections as TxError with the signature', async () => {
    const creator = Keypair.generate();
    const mint = Keypair.generate();
    const conn = fakeConnection();
    conn.getSignatureStatuses.mockResolvedValue({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] } as never);
    const chain = chainWith(conn, (async () => bytesResponse(portalTx(creator.publicKey, [creator.publicKey, mint.publicKey]))) as unknown as typeof fetch);
    const e = await chain.createCoin({ creator, mint, name: 'A', symbol: 'A', uri: 'https://x', devBuySol: 0 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TxError);
    expect((e as TxError).landed).toBe(true);
    expect((e as TxError).signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  });

  it('buy posts action buy with pool auto; non-200 answers become errors', async () => {
    const payer = Keypair.generate();
    const mint = Keypair.generate().publicKey.toBase58();
    let body: Record<string, unknown> = {};
    const chain = chainWith(fakeConnection(), (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return bytesResponse(portalTx(payer.publicKey, [payer.publicKey]));
    }) as unknown as typeof fetch);
    await chain.buy({ payer, mint, sol: 0.2 });
    expect(body).toEqual({ publicKey: payer.publicKey.toBase58(), action: 'buy', mint, amount: 0.2, denominatedInSol: 'true', slippage: 10, priorityFee: 0.0005, pool: 'auto' });
    const bad = chainWith(fakeConnection(), (async () => new Response('Bad Request: invalid mint', { status: 400 })) as unknown as typeof fetch);
    await expect(bad.buy({ payer, mint, sol: 0.2 })).rejects.toThrow(/400.*invalid mint/);
  });

  it('collectCreatorFees returns null without calling PumpPortal when the vaults are empty', async () => {
    const creator = Keypair.generate();
    const conn = fakeConnection();
    conn.getMultipleAccountsInfo.mockResolvedValue([{ lamports: 890_880 + 50, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false }, null] as never);
    const fetchMock = vi.fn();
    const chain = chainWith(conn, fetchMock as unknown as typeof fetch);
    expect(await chain.collectCreatorFees(creator)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('collectCreatorFees claims when the vault holds fees', async () => {
    const creator = Keypair.generate();
    const conn = fakeConnection();
    conn.getMultipleAccountsInfo.mockResolvedValue([{ lamports: 890_880 + 0.05e9, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false }, null] as never);
    let body: Record<string, unknown> = {};
    const chain = chainWith(conn, (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return bytesResponse(portalTx(creator.publicKey, [creator.publicKey]));
    }) as unknown as typeof fetch);
    const res = await chain.collectCreatorFees(creator);
    expect(res?.signature).toBeTruthy();
    expect(body).toEqual({ publicKey: creator.publicKey.toBase58(), action: 'collectCreatorFee', priorityFee: 0.0005, pool: 'pump' });
    expect(signedBy(conn.sent[0], creator.publicKey)).toBe(true);
  });
});

describe('LiveChain: tokens (classic SPL vs Token-2022)', () => {
  function mintAccount(program: PublicKey, decimals = 6) {
    return { context: { slot: 1 }, value: { owner: program, lamports: 1, executable: false, data: { program: program.equals(TOKEN_2022_PROGRAM_ID) ? 'spl-token-2022' : 'spl-token', parsed: { type: 'mint', info: { decimals } }, space: 82 } } };
  }
  function tokenAccount(amount: bigint) {
    const data = Buffer.alloc(165);
    data.writeBigUInt64LE(amount, 64);
    return { owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false, data };
  }

  it('detects Token-2022 from the mint owner and reads the right ATA', async () => {
    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const conn = fakeConnection();
    conn.getParsedAccountInfo.mockResolvedValue(mintAccount(TOKEN_2022_PROGRAM_ID) as never);
    const ata2022 = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
    conn.getAccountInfo.mockImplementation((async (pk: PublicKey) => (pk.equals(ata2022) ? tokenAccount(1234n) : null)) as never);
    const bal = await chainWith(conn).tokenBalance(owner.toBase58(), mint.toBase58());
    expect(bal).toEqual({ amount: 1234n, decimals: 6, program: TOKEN_2022_PROGRAM_ID.toBase58() });
  });

  it('transferTokens creates the ATA idempotently and uses transferChecked under the mint program', async () => {
    for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const from = Keypair.generate();
      const to = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const conn = fakeConnection();
      conn.getParsedAccountInfo.mockResolvedValue(mintAccount(program) as never);
      await chainWith(conn).transferTokens({ from, mint: mint.toBase58(), to: to.toBase58(), amount: 500n });
      const tx = VersionedTransaction.deserialize(conn.sent[0]);
      const keys = tx.message.staticAccountKeys;
      const ixs = tx.message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex], data: Buffer.from(ix.data), accounts: ix.accountKeyIndexes.map((i) => keys[i]) }));
      const ata = ixs.find((i) => i.program.toBase58() === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')!;
      expect(ata.data[0]).toBe(1); // CreateIdempotent
      expect(ata.accounts.some((k) => k.equals(program))).toBe(true);
      const xfer = ixs.find((i) => i.program.equals(program))!;
      expect(xfer.data[0]).toBe(12); // TransferChecked
      expect(xfer.data.readBigUInt64LE(1)).toBe(500n);
      expect(xfer.data[9]).toBe(6); // decimals
      expect(xfer.accounts[2].equals(getAssociatedTokenAddressSync(mint, to, true, program))).toBe(true);
      expect(signedBy(conn.sent[0], from.publicKey)).toBe(true);
    }
  });

  it('burn uses burnChecked under the mint program', async () => {
    const owner = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const conn = fakeConnection();
    conn.getParsedAccountInfo.mockResolvedValue(mintAccount(TOKEN_2022_PROGRAM_ID) as never);
    await chainWith(conn).burn({ owner, mint: mint.toBase58(), amount: 77n });
    const tx = VersionedTransaction.deserialize(conn.sent[0]);
    const keys = tx.message.staticAccountKeys;
    const burn = tx.message.compiledInstructions.find((ix) => keys[ix.programIdIndex].equals(TOKEN_2022_PROGRAM_ID))!;
    expect(burn.data[0]).toBe(15); // BurnChecked
    expect(Buffer.from(burn.data).readBigUInt64LE(1)).toBe(77n);
  });

  it('transferSol is a plain transfer paying only the base fee', async () => {
    const from = Keypair.generate();
    const to = Keypair.generate().publicKey;
    const conn = fakeConnection();
    await chainWith(conn).transferSol({ from, to: to.toBase58(), lamports: 1234 });
    const tx = VersionedTransaction.deserialize(conn.sent[0]);
    expect(tx.message.compiledInstructions).toHaveLength(1);
    expect(tx.message.staticAccountKeys[tx.message.compiledInstructions[0].programIdIndex].equals(SystemProgram.programId)).toBe(true);
  });
});

describe('LiveChain: reads', () => {
  const from = Keypair.generate().publicKey.toBase58();
  const to = Keypair.generate().publicKey.toBase58();
  const SIG = '5'.repeat(88);
  const parsed = (ixs: unknown[], extra: Record<string, unknown> = {}) => ({
    blockTime: 1_800_000_000,
    meta: { err: null, innerInstructions: [] },
    transaction: { message: { instructions: ixs } },
    ...extra,
  });
  const transfer = (lamports: number, source = from, destination = to) => ({ program: 'system', programId: SystemProgram.programId, parsed: { type: 'transfer', info: { source, destination, lamports } } });

  it('verifyPayment: retry when unseen, fail on error / too small / too early, sum several transfers', async () => {
    const conn = fakeConnection();
    const chain = chainWith(conn);
    const nb = 1_800_000_000_000;
    conn.getParsedTransaction.mockResolvedValueOnce(null);
    expect(await chain.verifyPayment(SIG, from, to, 100, nb)).toMatchObject({ ok: false, retry: true });
    conn.getParsedTransaction.mockResolvedValueOnce(parsed([transfer(100)], { meta: { err: { InstructionError: [0, 'x'] } } }));
    expect(await chain.verifyPayment(SIG, from, to, 100, nb)).toMatchObject({ ok: false });
    conn.getParsedTransaction.mockResolvedValueOnce(parsed([transfer(99)]));
    expect(await chain.verifyPayment(SIG, from, to, 100, nb)).toMatchObject({ ok: false, lamports: 99 });
    conn.getParsedTransaction.mockResolvedValueOnce(parsed([transfer(100)], { blockTime: (nb - 200_000) / 1000 }));
    expect((await chain.verifyPayment(SIG, from, to, 100, nb)).ok).toBe(false);
    conn.getParsedTransaction.mockResolvedValueOnce(parsed([transfer(60), transfer(40), transfer(1000, to, from)]));
    expect(await chain.verifyPayment(SIG, from, to, 100, nb)).toEqual({ ok: true, lamports: 100 });
    // within the 120 s clock-skew allowance
    conn.getParsedTransaction.mockResolvedValueOnce(parsed([transfer(100)], { blockTime: (nb - 60_000) / 1000 }));
    expect((await chain.verifyPayment(SIG, from, to, 100, nb)).ok).toBe(true);
    expect(conn.getParsedTransaction).toHaveBeenLastCalledWith(SIG, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    expect(await chain.verifyPayment('not-a-sig', from, to, 100, nb)).toMatchObject({ ok: false });
  });

  it('coinInfo: price in SOL from the virtual reserves', async () => {
    const chain = chainWith(fakeConnection(), (async (u: string) => {
      expect(u).toBe(`${config.pumpCoinApi}/MINT`);
      return Response.json({ virtual_sol_reserves: 30_000_000_000, virtual_token_reserves: 1_073_000_000_000_000, total_supply: 1_000_000_000_000_000, complete: false });
    }) as unknown as typeof fetch);
    const info = await chain.coinInfo('MINT');
    expect(info?.priceSol).toBeCloseTo(30 / 1_073_000_000, 15);
    expect(info?.marketCapSol).toBeCloseTo(27.96, 1);
    expect(info?.complete).toBe(false);
    const down = chainWith(fakeConnection(), (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch);
    expect(await down.coinInfo('MINT')).toBeNull();
  });

  it('holders: null without HELIUS_API_KEY, paginated DAS count with it', async () => {
    const prev = config.heliusApiKey;
    try {
      config.heliusApiKey = undefined;
      expect(await chainWith(fakeConnection()).holders('MINT')).toBeNull();
      config.heliusApiKey = 'k';
      const pages = [
        Array.from({ length: 1000 }, (_, i) => ({ owner: `o${i % 600}`, amount: 10 })),
        [{ owner: 'whale', amount: 1_000_000 }, { owner: 'zero', amount: 0 }],
      ];
      const fetchMock = vi.fn(async (_u: unknown, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body));
        expect(b.method).toBe('getTokenAccounts');
        expect(b.params.mint).toBe('MINT');
        return Response.json({ result: { token_accounts: pages[b.params.page - 1] ?? [] } });
      });
      const h = await chainWith(fakeConnection(), fetchMock as unknown as typeof fetch).holders('MINT');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(h?.count).toBe(601);
      expect(h?.top[0]).toEqual({ owner: 'whale', amount: 1_000_000n });
    } finally {
      config.heliusApiKey = prev;
    }
  });
});
