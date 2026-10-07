import 'server-only';
/**
 * Queen (and mint) secret keys, encrypted at rest with AES-256-GCM.
 * Format: v1.<iv b64>.<tag b64>.<ciphertext b64>. The key comes from QUEEN_KEY_SECRET (32 bytes, base64 or hex).
 * In mock mode without QUEEN_KEY_SECRET a per-process dev key is used and logged once; never use that live.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { config } from './config';

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const g = globalThis as unknown as { __hiveDevKey?: Buffer };

/**
 * Mock mode without QUEEN_KEY_SECRET: one key per data dir, persisted so queens founded before a
 * restart stay decryptable, and shared via globalThis so the engine ticker (instrumentation) and the
 * route handlers, which can load separate module instances, use the same key.
 */
function devKeyFor(): Buffer {
  if (g.__hiveDevKey) return g.__hiveDevKey;
  const file = path.join(config.dataDir, 'dev-queen-key');
  let k: Buffer | null = null;
  try {
    const raw = readFileSync(file, 'utf8').trim();
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) k = b;
  } catch {
    /* first run */
  }
  if (!k) {
    k = randomBytes(32);
    try {
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(file, k.toString('base64'), { mode: 0o600 });
    } catch {
      /* read-only fs (e.g. serverless): in-memory only */
    }
    console.warn('[hive] QUEEN_KEY_SECRET not set: using a development key (mock mode only).');
  }
  g.__hiveDevKey = k;
  return k;
}

function key(): Buffer {
  const raw = config.queenKeySecret;
  if (raw) {
    const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (buf.length !== 32) throw new Error('QUEEN_KEY_SECRET must decode to exactly 32 bytes (base64 or 64 hex chars).');
    return buf;
  }
  if (config.launchMode === 'live') throw new Error('QUEEN_KEY_SECRET is required in live mode.');
  return devKeyFor();
}

export function encryptSecret(secret: Uint8Array): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(Buffer.from(secret)), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

export function decryptSecret(enc: string): Uint8Array {
  const [v, iv, tag, ct] = enc.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised secret format.');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return new Uint8Array(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]));
}

export function newKeypair(): { keypair: Keypair; enc: string } {
  const keypair = Keypair.generate();
  return { keypair, enc: encryptSecret(keypair.secretKey) };
}

export function keypairFromEnc(enc: string): Keypair {
  return Keypair.fromSecretKey(decryptSecret(enc));
}
