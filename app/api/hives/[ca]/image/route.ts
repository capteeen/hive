import { getDb } from '@/lib/server/db';
import { UNKNOWN_IP, clientIp, rateLimit } from '@/lib/server/ratelimit';
import { hiveImageMetaKey, imageVersion, isDataUrl } from '@/lib/shared/rows';

/**
 * GET /api/hives/[ca]/image: a hive's stored data-URL image as bytes. Hive records carry
 * `/api/hives/<ca>/image?v=<hash>` instead of the data URL (lib/shared/rows.ts hiveImagePath).
 *   - `?v=` matching the current image: cached for a year (immutable); a new image gets a new `v`.
 *   - anything else: cached briefly. ETag / If-None-Match -> 304.
 *   - a hive whose image is an https URL (live coins on IPFS): redirect there.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CA_RE = /^[A-Za-z0-9_-]{1,100}$/;
const DATA_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;
/** Per client address; images are cached by browsers and CDNs, so this only meets cache misses. */
const RATE = { limit: 300, windowMs: 60_000 };
const SHORT = 'public, max-age=60';
const FOREVER = 'public, max-age=31536000, immutable';

const notFound = () => new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'public, max-age=60', 'Content-Type': 'text/plain; charset=utf-8' } });

export async function GET(req: Request, { params }: { params: { ca: string } }) {
  const ca = params.ca;
  if (!CA_RE.test(ca)) return notFound();
  const ip = clientIp(req.headers);
  if (ip !== UNKNOWN_IP && !rateLimit(`image:ip:${ip}`, RATE.limit, RATE.windowMs).ok) {
    return new Response('Too many requests.', { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } });
  }
  try {
    const db = await getDb();
    let src = await db.getMeta(hiveImageMetaKey(ca));
    if (!src) {
      // a hive written before images moved out of the hive record still carries its data URL
      const hive = await db.getHive(ca);
      if (!hive) return notFound();
      if (/^https:\/\//i.test(hive.image)) return new Response(null, { status: 302, headers: { Location: hive.image, 'Cache-Control': SHORT } });
      if (!isDataUrl(hive.image)) return notFound();
      src = hive.image;
    }
    const m = DATA_RE.exec(src);
    if (!m) return notFound();
    const version = imageVersion(src);
    const etag = `"${version}"`;
    const cache = new URL(req.url).searchParams.get('v') === version ? FOREVER : SHORT;
    const inm = req.headers.get('if-none-match');
    if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cache } });
    }
    const bytes = new Uint8Array(Buffer.from(m[2], 'base64'));
    return new Response(bytes, {
      headers: {
        'Content-Type': m[1],
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': cache,
        ETag: etag,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    console.error('[hive] GET /api/hives/[ca]/image failed:', e instanceof Error ? e.message : e);
    return new Response('Could not load this image.', { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
