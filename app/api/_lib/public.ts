import 'server-only';
/**
 * What the API sends for a hive. Images are never inlined: a data-URL image (mock launches, or a row
 * written before the stores moved images out of the hive record) becomes the image route's URL path,
 * `/api/hives/<ca>/image?v=<hash>`. Both stores already write that path for new images; this covers
 * old rows and any Db that keeps the data URL (tests' MemDb).
 */
import type { LaunchStatusResponse, RemoteHive } from '@/lib/shared/api';
import { hiveImagePath, isDataUrl } from '@/lib/shared/rows';

/** ca -> the path computed for its image, keyed by the image's size and the hive's updatedAt (no image bytes are kept). */
const memo = new Map<string, { len: number; updatedAt: number; path: string }>();
const MEMO_MAX = 5000;

export function publicHive(h: RemoteHive): RemoteHive {
  if (!isDataUrl(h.image)) return h;
  let m = memo.get(h.ca);
  if (!m || m.len !== h.image.length || m.updatedAt !== h.updatedAt) {
    if (memo.size >= MEMO_MAX) memo.clear();
    m = { len: h.image.length, updatedAt: h.updatedAt, path: hiveImagePath(h.ca, h.image) };
    memo.set(h.ca, m);
  }
  return { ...h, image: m.path };
}

export function publicStatus(s: LaunchStatusResponse): LaunchStatusResponse {
  return s.hive ? { ...s, hive: publicHive(s.hive) } : s;
}
