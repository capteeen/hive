/**
 * Findings #7 and #16: every per-IP limit used the FIRST X-Forwarded-For entry, which the client writes
 * (`next start` keeps a client-sent header; nginx appends the real address after it). clientIp now only
 * trusts what the platform or a declared proxy (TRUST_PROXY) wrote, and keys IPv6 by /64.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { DEFAULT_LOOK, DEFAULT_RULES } from '@/lib/queen';
import { LIMITS, launchMessage, type LaunchPayload } from '@/lib/shared/api';
import { config } from '@/lib/server/config';
import { MockChain } from '@/lib/server/chain-mock';
import { setChainForTests } from '@/lib/server/chain';
import { setDbForTests } from '@/lib/server/db';
import { RATE, prepareLaunch } from '@/lib/server/launch';
import { UNKNOWN_IP, clientIp, normalizeIp, resetRateLimits } from '@/lib/server/ratelimit';
import { MemDb } from './fakes/memdb';
import { FakeChain } from './fakes/fakechain';
import { POST } from '@/app/api/launch/route';
import { GET as listRoute } from '@/app/api/hives/route';

const b64 = Buffer.alloc(LIMITS.imageBytes - (LIMITS.imageBytes % 3), 7).toString('base64');
const BIG = `data:image/webp;base64,${b64}`;
const xff = (v: string) => new Headers({ 'x-forwarded-for': v });

const payload = (owner: string, i: number): LaunchPayload => ({
  owner,
  name: `Spam ${i}`,
  ticker: `SP${i}`,
  image: BIG,
  devBuy: 0,
  cell: null,
  look: DEFAULT_LOOK,
  rules: DEFAULT_RULES,
  temperament: { dip: 'Steady', swarm: 'Forager' },
  issuedAt: Date.now(),
});

beforeEach(() => {
  resetRateLimits();
  config.demoHives = false;
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('TRUST_PROXY', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  setDbForTests(null);
  setChainForTests(null);
});

describe('clientIp', () => {
  it('behind a declared proxy, a proxy-appended X-Forwarded-For resolves to the real client, not the spoofed entry', () => {
    vi.stubEnv('TRUST_PROXY', '1');
    // client sent "X-Forwarded-For: 6.6.6.6"; nginx ($proxy_add_x_forwarded_for) appended the real 203.0.113.9
    expect(clientIp(xff('6.6.6.6, 203.0.113.9'))).toBe('203.0.113.9');
    expect(clientIp(xff('203.0.113.9'))).toBe('203.0.113.9');
    vi.stubEnv('TRUST_PROXY', '2'); // CDN -> nginx -> app: the CDN saw the client
    expect(clientIp(xff('6.6.6.6, 203.0.113.9, 10.0.0.2'))).toBe('203.0.113.9');
    expect(clientIp(xff('10.0.0.2'))).toBe(UNKNOWN_IP); // fewer hops than declared: nothing trustworthy
  });

  it('without a declared proxy, X-Forwarded-For and X-Real-IP are client-controlled: one shared bucket', () => {
    expect(clientIp(xff('6.6.6.6, 203.0.113.9'))).toBe(UNKNOWN_IP);
    expect(clientIp(new Headers({ 'x-real-ip': '6.6.6.6' }))).toBe(UNKNOWN_IP);
    expect(clientIp(new Headers())).toBe(UNKNOWN_IP);
  });

  it('on Vercel, uses the platform headers', () => {
    vi.stubEnv('VERCEL', '1');
    expect(clientIp(new Headers({ 'x-vercel-forwarded-for': '198.51.100.7', 'x-real-ip': '198.51.100.8', 'x-forwarded-for': '6.6.6.6' }))).toBe('198.51.100.7');
    expect(clientIp(new Headers({ 'x-real-ip': '198.51.100.8', 'x-forwarded-for': '6.6.6.6' }))).toBe('198.51.100.8');
  });

  it('keys IPv6 by /64 and normalises ports and mapped IPv4', () => {
    expect(normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(normalizeIp('2001:db8:1:2::1')).toBe(normalizeIp('2001:0db8:0001:0002:ffff::9'));
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8:0:0::/64');
    expect(normalizeIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeIp('203.0.113.9:5555')).toBe('203.0.113.9');
    vi.stubEnv('TRUST_PROXY', '1');
    const keys = new Set(Array.from({ length: 50 }, (_, i) => clientIp(xff(`2001:db8:aa:bb:${i.toString(16)}::1`))));
    expect(keys.size).toBe(1); // one /64 = one client
  });
});

describe('POST /api/launch: one client cannot exceed RATE.prepareIp by rotating X-Forwarded-For', () => {
  async function flood(n: number, header: (i: number) => string) {
    const db = new MemDb();
    setDbForTests(db);
    setChainForTests(new MockChain({ seed: 2 }));
    let ok = 0;
    for (let i = 0; i < n; i++) {
      const req = new Request('http://localhost/api/launch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': header(i) },
        body: JSON.stringify({ payload: payload(`guest:spam${i}xyz`, i) }),
      });
      const res = await POST(req);
      if (res.status === 200) ok++;
      else expect(res.status).toBe(429);
    }
    return { ok, db };
  }

  it('self-hosted without TRUST_PROXY', async () => {
    const { ok, db } = await flood(40, (i) => `10.0.${i}.1, 203.0.113.9`);
    expect(ok).toBeLessThanOrEqual(RATE.prepareIp.limit);
    expect(db.launches.size).toBeLessThanOrEqual(RATE.prepareIp.limit);
  });

  it('behind nginx with TRUST_PROXY=1', async () => {
    vi.stubEnv('TRUST_PROXY', '1');
    const { ok } = await flood(40, (i) => `10.0.${i}.1, 203.0.113.9`);
    expect(ok).toBeLessThanOrEqual(RATE.prepareIp.limit);
  });
});

describe('live mode: rotating X-Forwarded-For plus throwaway wallets', () => {
  it('no longer bypasses the per-IP prepare limit', async () => {
    const db = new MemDb();
    const chain = new FakeChain('live');
    const T0 = Date.now();
    let ok = 0;
    for (let i = 0; i < 40; i++) {
      const kp = nacl.sign.keyPair();
      const owner = bs58.encode(kp.publicKey);
      const p = payload(owner, i);
      const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(launchMessage(p)), kp.secretKey));
      try {
        await prepareLaunch({ payload: p, signature }, { db, chain, mode: 'live', now: T0, ip: clientIp(xff(`192.0.2.${i}`)), problems: [] });
        ok++;
      } catch {
        // 429
      }
    }
    expect(ok).toBe(RATE.prepareIp.limit);
  });
});

describe('GET /api/hives per-IP limit', () => {
  it('limits an identifiable client and never a shared unknown bucket', async () => {
    setDbForTests(new MemDb());
    vi.stubEnv('TRUST_PROXY', '1');
    const get = (ip?: string) => listRoute(new Request('http://localhost/api/hives', { headers: ip ? { 'x-forwarded-for': ip } : {} }));
    let last = 200;
    for (let i = 0; i < 200 && last === 200; i++) last = (await get('203.0.113.50')).status;
    expect(last).toBe(429);
    expect((await get('203.0.113.51')).status).toBe(200);
    vi.stubEnv('TRUST_PROXY', '');
    for (let i = 0; i < 200; i++) expect((await get('203.0.113.50')).status).toBe(200); // unknown: one bucket would lock everyone out
  });
});
