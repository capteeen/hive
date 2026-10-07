/**
 * Findings #3 and #8: GET /api/hives (and the stream, and Supabase Realtime) used to carry every hive's
 * full data-URL image. Images now live apart from the hive record (meta `image:<ca>`), hives carry a
 * short `/api/hives/<ca>/image?v=…` path, and that route serves the bytes with long caching.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_LOOK, DEFAULT_RULES } from '@/lib/queen';
import { LIMITS, type LaunchPayload, type RemoteHive } from '@/lib/shared/api';
import { hiveToRow } from '@/lib/shared/rows';
import { config } from '@/lib/server/config';
import { MockChain } from '@/lib/server/chain-mock';
import { setDbForTests, type LaunchRecord } from '@/lib/server/db';
import { FileDb } from '@/lib/server/db-file';
import { SupabaseDb } from '@/lib/server/db-supabase';
import { LaunchError, confirmLaunch, prepareLaunch, type LaunchCtx } from '@/lib/server/launch';
import { clientIp, resetRateLimits } from '@/lib/server/ratelimit';
import { MemDb } from './fakes/memdb';
import { FakeChain } from './fakes/fakechain';
import { GET as listRoute } from '@/app/api/hives/route';
import { GET as detailRoute } from '@/app/api/hives/[ca]/route';
import { GET as imageRoute } from '@/app/api/hives/[ca]/image/route';

const VERCEL_RESPONSE_LIMIT = 4.5 * 1024 * 1024;
/** A data URL whose decoded size is exactly the server's limit. */
const RAW = Buffer.alloc(LIMITS.imageBytes - (LIMITS.imageBytes % 3), 7);
const BIG = `data:image/webp;base64,${RAW.toString('base64')}`;
const PATH_RE = /^\/api\/hives\/[A-Za-z0-9_-]+\/image\?v=[0-9a-z]+$/;

const payload = (owner: string, i: number): LaunchPayload => ({
  owner,
  name: `Big ${i}`,
  ticker: `BIG${i}`,
  description: '',
  motto: '',
  telegram: '',
  twitter: '',
  image: BIG,
  devBuy: 0,
  cell: null,
  look: DEFAULT_LOOK,
  rules: DEFAULT_RULES,
  temperament: { dip: 'Steady', swarm: 'Forager' },
  issuedAt: Date.now(),
});

const list = async () => {
  const res = await listRoute(new Request('http://localhost/api/hives'));
  return { res, text: await res.text() };
};
const image = (ca: string, query = '', headers: Record<string, string> = {}) =>
  imageRoute(new Request(`http://localhost/api/hives/${ca}/image${query}`, { headers }), { params: { ca } });

let dirs: string[] = [];
beforeEach(() => {
  resetRateLimits();
  config.demoHives = false;
});
afterEach(async () => {
  setDbForTests(null);
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});
async function fileDb() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'final-server-img-'));
  dirs.push(dir);
  return { dir, db: new FileDb(dir, { isolated: true }) };
}

describe('#3 /api/hives size (MemDb keeps data URLs: the API layer maps them)', () => {
  it('stays tiny after one visitor\'s allowed launches with maximum-size images; images come from the image route', async () => {
    const db = new MemDb();
    setDbForTests(db);
    const chain = new MockChain({ seed: 1 });
    let launched = 0;
    for (let i = 0; i < 12; i++) {
      const ctx: LaunchCtx = { db, chain, mode: 'mock', ip: '9.9.9.9' };
      const prep = await prepareLaunch({ payload: payload(`guest:visitor${i}x`, i) }, ctx);
      const st = await confirmLaunch(prep.launchId, {}, ctx);
      if (st.state === 'live') launched++;
    }
    expect(launched).toBe(12);
    const { res, text } = await list();
    expect(res.status).toBe(200);
    expect(text.length).toBeLessThan(VERCEL_RESPONSE_LIMIT);
    expect(text.length).toBeLessThan(64 * 1024); // was ~6.3 MB
    expect(text).not.toContain('data:image');
    expect(res.headers.get('Cache-Control')).toMatch(/s-maxage=\d+/);
    const hives = (JSON.parse(text) as { hives: RemoteHive[] }).hives;
    expect(hives).toHaveLength(12);
    for (const h of hives) expect(h.image).toMatch(PATH_RE);

    // the detail route maps too
    const one = hives[0];
    const detail = await detailRoute(new Request(`http://localhost/api/hives/${one.ca}`), { params: { ca: one.ca } });
    expect(((await detail.json()) as { hive: RemoteHive }).hive.image).toBe(one.image);

    // and the image route serves the bytes, cacheable for good under the current version
    const query = one.image.slice(one.image.indexOf('?'));
    const img = await image(one.ca, query);
    expect(img.status).toBe(200);
    expect(img.headers.get('Content-Type')).toBe('image/webp');
    expect(img.headers.get('Cache-Control')).toContain('immutable');
    expect(img.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const etag = img.headers.get('ETag')!;
    expect(etag).toMatch(/^"[0-9a-z]+"$/);
    expect(Buffer.from(await img.arrayBuffer()).equals(RAW)).toBe(true);
    expect((await image(one.ca, query, { 'If-None-Match': etag })).status).toBe(304);
    // a stale or missing version still gets the image, but only briefly cached
    const stale = await image(one.ca, '?v=old');
    expect(stale.status).toBe(200);
    expect(stale.headers.get('Cache-Control')).not.toContain('immutable');
    expect((await image('NoSuchHive')).status).toBe(404);
    expect((await image('../etc')).status).toBe(404);
  });

  it('redirects to an https image (live coins on IPFS)', async () => {
    const db = new MemDb();
    setDbForTests(db);
    await db.upsertHive(hive('LiveCa1', 0, 'https://ipfs.io/ipfs/QmImage'));
    const res = await image('LiveCa1');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://ipfs.io/ipfs/QmImage');
    const { text } = await list();
    expect(text).toContain('https://ipfs.io/ipfs/QmImage');
  });
});

function hive(ca: string, q: number, img: string, extra: Partial<RemoteHive> = {}): RemoteHive {
  return {
    ca,
    name: `Hive ${ca}`,
    ticker: 'HV',
    image: img,
    cell: { q, r: 0 },
    queenWallet: `queen-${ca}`,
    ownerWallet: `guest:owner-${ca}`,
    look: DEFAULT_LOOK,
    rules: DEFAULT_RULES,
    temperament: { dip: 'steady', swarm: 'social' },
    devBuy: 0,
    status: 'mock',
    honey: 0,
    bees: 2,
    feesTotal: 0,
    royalJelly: 0,
    state: 'working',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...extra,
  };
}

describe('#8 FileDb: rotating X-Forwarded-For no longer bypasses the limit, and hives never hold image bytes', () => {
  it('one client gets 12 mock launches, and the hive list stays small', async () => {
    const { dir, db } = await fileDb();
    setDbForTests(db);
    const T0 = Date.now();
    const chain = new FakeChain('mock');
    const ctx = (ip: string): LaunchCtx => ({ db, chain, mode: 'mock', now: T0, ip, problems: [] });
    let live = 0;
    let limited = 0;
    for (let i = 0; i < 60; i++) {
      const ip = clientIp(new Headers({ 'x-forwarded-for': `10.${i >> 8}.${i & 255}.1, 198.51.100.9` })); // spoofed entry first, proxy hop last
      try {
        const prep = await prepareLaunch({ payload: payload(`guest:spammer${i}`, i) }, ctx(ip));
        const st = await confirmLaunch(prep.launchId, {}, ctx(ip));
        if (st.state === 'live') live++;
      } catch (e) {
        expect(e).toBeInstanceOf(LaunchError);
        expect((e as LaunchError).status).toBe(429);
        limited++;
      }
    }
    expect(live).toBeLessThanOrEqual(12);
    expect(limited).toBeGreaterThanOrEqual(48);

    const hives = await db.listHives();
    expect(hives).toHaveLength(live);
    const bytes = JSON.stringify(hives).length;
    expect(bytes).toBeLessThan(live * 4_000); // was > 500 KB per hive
    for (const h of hives) {
      expect(h.image).toMatch(PATH_RE);
      expect(await db.getMeta(`image:${h.ca}`)).toBe(BIG); // the image itself is kept, on disk
    }
    expect(await readdir(path.join(dir, 'images'))).toHaveLength(live);
    const hiveFile = await readFile(path.join(dir, 'hives', `${hives[0].ca}.json`), 'utf8');
    expect(hiveFile).not.toContain('data:image');

    const { text } = await list();
    expect(text.length).toBeLessThan(64 * 1024);
    const img = await image(hives[0].ca, hives[0].image.slice(hives[0].image.indexOf('?')));
    expect(img.status).toBe(200);
    expect(Buffer.from(await img.arrayBuffer()).equals(RAW)).toBe(true);
  });

  it('upserting the same image again writes nothing new; a new image gets a new version', async () => {
    const { db } = await fileDb();
    await db.upsertHive(hive('A', 0, BIG));
    const first = (await db.getHive('A'))!.image;
    await db.upsertHive({ ...(await db.getHive('A'))!, honey: 1, updatedAt: 2_000 }); // the engine writes the path back
    expect((await db.getHive('A'))!.image).toBe(first);
    expect(await db.getMeta('image:A')).toBe(BIG);
    const other = 'data:image/png;base64,iVBORw0KGgo=';
    await db.upsertHive(hive('A', 0, other, { updatedAt: 3_000 }));
    expect((await db.getHive('A'))!.image).not.toBe(first);
    expect(await db.getMeta('image:A')).toBe(other);
    // survives a restart
    const again = new FileDb((db as unknown as { s: { dir: string } }).s.dir, { isolated: true });
    expect(await again.getMeta('image:A')).toBe(other);
    expect(await again.getMeta('image:B')).toBeNull();
  });

  it('serves a hive written before images moved out of the record (legacy data URL in the hive file)', async () => {
    const { dir } = await fileDb();
    const { writeFile } = await import('node:fs/promises');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'hives'), { recursive: true });
    await writeFile(path.join(dir, 'hives', 'Old.json'), JSON.stringify(hive('Old', 0, BIG)));
    const db = new FileDb(dir, { isolated: true });
    setDbForTests(db);
    const { text } = await list();
    expect(text).not.toContain('data:image');
    const h = (JSON.parse(text) as { hives: RemoteHive[] }).hives[0];
    expect(h.image).toMatch(PATH_RE);
    const img = await image('Old', h.image.slice(h.image.indexOf('?')));
    expect(img.status).toBe(200);
    expect(img.headers.get('Cache-Control')).toContain('immutable');
  });
});

describe('#16 FileDb drops a finished launch\'s payload image', () => {
  const launch = (id: string, extra: Partial<LaunchRecord> = {}): LaunchRecord => ({
    id,
    mode: 'mock',
    state: 'reserved',
    owner: 'guest:owner01',
    payload: { owner: 'guest:owner01', name: 'Test', ticker: 'TEST', image: BIG, devBuy: 0, look: DEFAULT_LOOK, rules: DEFAULT_RULES, temperament: { dip: 'steady', swarm: 'social' }, issuedAt: 1 },
    queenWallet: `queen-${id}`,
    mintPubkey: `mint-${id}`,
    mintSecretEnc: 'v1.a.b.c',
    cell: { q: 1, r: 0 },
    lamports: 70_000_000,
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
    updatedAt: 1,
    txs: {},
    attempts: 0,
    ...extra,
  });

  it('keeps it while the launch may still need it, drops it (memory and file) once live, expired or refunded', async () => {
    const { dir, db } = await fileDb();
    await db.createLaunch(launch('L1'));
    await db.createLaunch(launch('L2'));
    expect((await db.getLaunch('L1'))!.payload.image).toBe(BIG);
    await db.updateLaunch('L1', { state: 'expired' }, ['reserved']); // a late payment is only ever refunded
    expect((await db.getLaunch('L1'))!.payload.image).toBe('');
    expect(await readFile(path.join(dir, 'launches', 'L1.json'), 'utf8')).not.toContain('data:image');
    await db.updateLaunch('L2', { state: 'live', ca: 'mint-L2' }, ['reserved']);
    expect((await db.getLaunch('L2'))!.payload.image).toBe('');
    expect(await readFile(path.join(dir, 'launches', 'L2.json'), 'utf8')).not.toContain('data:image');
    await db.updateLaunch('L1', { state: 'refunded' }, ['expired']);
    expect((await db.getLaunch('L1'))!.payload.image).toBe('');
  });

  it('does not load finished launches\' images into memory on start', async () => {
    const { dir } = await fileDb();
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'launches'), { recursive: true });
    await writeFile(path.join(dir, 'launches', 'L9.json'), JSON.stringify(launch('L9', { state: 'live' })));
    await writeFile(path.join(dir, 'launches', 'L8.json'), JSON.stringify(launch('L8')));
    const db = new FileDb(dir, { isolated: true });
    expect((await db.getLaunch('L9'))!.payload.image).toBe('');
    expect((await db.getLaunch('L8'))!.payload.image).toBe(BIG);
  });
});

describe('SupabaseDb keeps data-URL images out of the hives row (and so out of Realtime)', () => {
  interface Call {
    method: string;
    path: string;
    body: unknown;
  }
  function fakeSupabase() {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      calls.push({ method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response('', { status: 201 });
    }) as typeof fetch;
    return { db: new SupabaseDb('https://example.supabase.co', 'service-key', { fetch: fetchImpl }), calls };
  }

  it('writes the data URL to meta first, then the row with the image route path', async () => {
    const { db, calls } = fakeSupabase();
    await db.upsertHive(hive('CaAbc', 0, BIG));
    expect(calls.map((c) => c.path)).toEqual(['/rest/v1/meta', '/rest/v1/hives']);
    expect(calls[0].body).toMatchObject({ key: 'image:CaAbc', value: BIG });
    const row = calls[1].body as { image: string };
    expect(row.image).toMatch(PATH_RE);
    expect(JSON.stringify(calls[1].body).length).toBeLessThan(4_000);
  });

  it('leaves URL images alone (one request)', async () => {
    const { db, calls } = fakeSupabase();
    await db.upsertHive(hive('CaAbc', 0, 'https://ipfs.io/ipfs/xyz'));
    expect(calls).toHaveLength(1);
    expect((calls[0].body as { image: string }).image).toBe(hiveToRow(hive('CaAbc', 0, 'https://ipfs.io/ipfs/xyz')).image);
  });
});
