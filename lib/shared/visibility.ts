/**
 * What the public may see, per launch mode. Shared by the API routes, the SSE hub and the browser's
 * Supabase Realtime listener (anon SELECT returns every row, so the browser filters too).
 *
 *  - mock mode: everything stored (preview hives are labelled as such in the UI).
 *  - live mode: only real chain data. Hives with status 'live'; actions and harvests that were really
 *    sent (not dry runs) and belong to live hives. A live database may still hold preview rows (a mock
 *    deployment sharing it, or test launches before go-live; supabase/cleanup-fake-data.sql deletes
 *    them), and dry runs are for the admin: the cron route's JSON shows what they would have done.
 */
import type { LaunchMode, RemoteAction, RemoteHarvest, RemoteHive } from './api';

export const hiveIsPublic = (mode: LaunchMode, h: Pick<RemoteHive, 'status'>) => mode !== 'live' || h.status === 'live';

/** `isLiveHive(ca)`: whether `ca` is a live hive (only consulted in live mode). */
export function actionIsPublic(mode: LaunchMode, a: Pick<RemoteAction, 'ca' | 'targetCa' | 'dryRun'>, isLiveHive: (ca: string) => boolean): boolean {
  if (mode !== 'live') return true;
  return !a.dryRun && isLiveHive(a.ca) && (!a.targetCa || isLiveHive(a.targetCa));
}

/** A real harvest always pays its royal jelly to a live hive; one without (or to a preview hive) is not real. */
export function harvestIsPublic(mode: LaunchMode, h: Pick<RemoteHarvest, 'jellyTo' | 'dryRun'>, isLiveHive: (ca: string) => boolean): boolean {
  if (mode !== 'live') return true;
  return !h.dryRun && !!h.jellyTo && isLiveHive(h.jellyTo);
}

/** Filter a list response for `mode`. Actions and harvests are checked against the hives in `data` plus `alsoLive`. */
export function publicView<T extends { hives: RemoteHive[]; actions: RemoteAction[]; harvests: RemoteHarvest[] }>(mode: LaunchMode, data: T, alsoLive: (ca: string) => boolean = () => false): T {
  if (mode !== 'live') return data;
  const hives = data.hives.filter((h) => hiveIsPublic(mode, h));
  const live = new Set(hives.map((h) => h.ca));
  const isLive = (ca: string) => live.has(ca) || alsoLive(ca);
  return { ...data, hives, actions: data.actions.filter((a) => actionIsPublic(mode, a, isLive)), harvests: data.harvests.filter((h) => harvestIsPublic(mode, h, isLive)) };
}
