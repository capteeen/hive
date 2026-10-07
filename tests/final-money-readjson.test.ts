/**
 * #2: readJson streams the body with a byte cap (a chunked upload without Content-Length is abandoned
 * as soon as it passes MAX_BODY_BYTES), refuses an oversized Content-Length before reading, and applies
 * the launch route's per-IP rate limit before reading the body, counting each request only once.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LOOK, DEFAULT_RULES } from '@/lib/queen';
import { config } from '@/lib/server/config';
import { LaunchError, MAX_BODY_BYTES, RATE, prepareLaunch, readJson } from '@/lib/server/launch';
import { clientIp, resetRateLimits } from '@/lib/server/ratelimit';
import { MemDb } from './fakes/memdb';
import { FakeChain } from './fakes/fakechain';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const CHUNK = 64 * 1024;

/** A streamed request body (no Content-Length) of `totalBytes` spaces that counts how much was pulled. */
function chunkedRequest(totalBytes: number, url = 'http://x/api/launch', headers: Record<string, string> = {}) {
  const chunk = new Uint8Array(CHUNK).fill(0x20); // spaces: valid JSON whitespace
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= totalBytes) return c.close();
      sent += chunk.length;
      c.enqueue(chunk);
    },
  });
  const req = new Request(url, { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
  return { req, pulled: () => sent };
}

const errOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

beforeEach(() => {
  resetRateLimits();
  config.demoHives = false;
});

describe('#2 readJson', () => {
  it('abandons a chunked body as soon as it passes the cap instead of buffering all of it', async () => {
    const total = 64 * 1024 * 1024; // 64 MiB, 64x the cap
    const { req, pulled } = chunkedRequest(total);
    expect(req.headers.get('content-length')).toBeNull();
    const err = await errOf(readJson(req));
    expect(err).toBeInstanceOf(LaunchError);
    expect((err as LaunchError).status).toBe(413);
    expect(pulled()).toBeLessThan(MAX_BODY_BYTES + 4 * CHUNK); // was: all 64 MiB
  });

  it('refuses a declared Content-Length over the cap (or an invalid one) without reading', async () => {
    const { req, pulled } = chunkedRequest(4 * MAX_BODY_BYTES, 'http://x/api/launch', { 'content-length': String(4 * MAX_BODY_BYTES) });
    expect(((await errOf(readJson(req))) as LaunchError).status).toBe(413);
    expect(pulled()).toBeLessThanOrEqual(CHUNK); // at most what the stream queued by itself
    const bad = new Request('http://x/api/launch', { method: 'POST', body: '{}', headers: { 'content-length': 'abc' } });
    expect(((await errOf(readJson(bad))) as LaunchError).status).toBe(400);
  });

  it('still reads ordinary bodies: JSON objects, empty bodies, non-objects as {}, bad JSON as 400', async () => {
    const post = (body: string) => new Request('http://x/api/other', { method: 'POST', body });
    expect(await readJson(post('{"a":1,"b":"é"}'))).toEqual({ a: 1, b: 'é' });
    expect(await readJson(post(''))).toEqual({});
    expect(await readJson(post('  '))).toEqual({});
    expect(await readJson(post('42'))).toEqual({});
    expect(((await errOf(readJson(post('{nope')))) as LaunchError).status).toBe(400);
    // exactly at the cap is fine
    const big = `{"x":"${'a'.repeat(MAX_BODY_BYTES - 8)}"}`;
    expect(Buffer.byteLength(big)).toBe(MAX_BODY_BYTES);
    expect(await readJson(post(big))).toEqual({ x: 'a'.repeat(MAX_BODY_BYTES - 8) });
  });

  it('applies the per-IP launch limit before reading the body, and counts each request once', async () => {
    const db = new MemDb();
    const chain = new FakeChain('mock');
    const payload = (n: number) => ({
      payload: { owner: `guest:abcdef${n.toString().padStart(2, '0')}`, name: 'Amber Comb', ticker: 'AMBER', image: PNG, devBuy: 0, cell: null, look: DEFAULT_LOOK, rules: DEFAULT_RULES, temperament: { dip: 'Steady', swarm: 'Forager' }, issuedAt: Date.now() },
    });
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' };
    // what the route does: readJson, then prepareLaunch with the same client IP
    const route = async (body: string) => {
      const req = new Request('http://x/api/launch', { method: 'POST', body, headers });
      const parsed = await readJson(req);
      return prepareLaunch(parsed, { db, chain, mode: 'mock', ip: clientIp(req.headers) });
    };
    for (let i = 0; i < RATE.prepareIp.limit; i++) await route(JSON.stringify(payload(i)));
    expect(db.launches.size).toBe(RATE.prepareIp.limit); // not halved by double counting

    // over the limit: refused before the body is read
    const { req, pulled } = chunkedRequest(8 * MAX_BODY_BYTES, 'http://x/api/launch', headers);
    const err = await errOf(readJson(req));
    expect(err).toBeInstanceOf(LaunchError);
    expect((err as LaunchError).status).toBe(429);
    expect(pulled()).toBeLessThanOrEqual(CHUNK);
  });
});
