import 'server-only';
/**
 * Fan-out for GET /api/stream. One hub per Db and process: it holds ONE subscription to the store's
 * change feed (or one polling loop), turns each event into SSE bytes once (images mapped once, JSON
 * encoded once) and hands the same bytes to every open connection. Connections are capped in total
 * and per client, and a connection that stops reading is dropped instead of queueing without bound.
 */
import type { Db } from '@/lib/server/db';
import { config } from '@/lib/server/config';
import { UNKNOWN_IP } from '@/lib/server/ratelimit';
import type { LaunchMode, RemoteAction, RemoteHarvest, RemoteHive, StreamEvent } from '@/lib/shared/api';
import { actionIsPublic, harvestIsPublic, hiveIsPublic, publicView } from '@/lib/shared/visibility';
import { publicHive } from './public';

/** Keep in step with SSE_STALE_MS in lib/remote.ts (the browser gives up after ~2.5 missed pings). */
export const HEARTBEAT_MS = 20_000;
/** Open SSE connections per process, and per client address (when the address is known). */
export const MAX_CONNECTIONS = 200;
export const MAX_PER_IP = 6;
/** Bytes a connection may have queued and unread before it counts as stalled and is dropped. */
export const MAX_QUEUED_BYTES = 512 * 1024;
/** Polling period when the store has no in-process feed (Supabase without an anon key for Realtime). */
export const POLL_MS = 5_000;

const enc = new TextEncoder();

export interface StreamClient {
  /** Queue bytes; the client drops itself when it cannot keep up. */
  push(bytes: Uint8Array): void;
}

type Source = (emit: (ev: StreamEvent) => void) => () => void;

/** Says whether an event may reach the public; `start` runs when the hub's source starts. */
interface EventFilter {
  start(): void;
  pass(ev: StreamEvent): boolean;
}

/**
 * Live mode over an in-process feed: only live hives, and only real actions / harvests of live hives
 * (lib/shared/visibility.ts). Which hives are live is learnt from the store when the feed starts and
 * from every hive event after that. An action that arrives before the list has loaded is dropped; the
 * browser re-fetches /api/hives (filtered the same way) on every connect, so it loses nothing.
 */
function liveFilter(db: Db): EventFilter {
  const live = new Set<string>();
  const isLive = (ca: string) => live.has(ca);
  return {
    start() {
      db.listHives()
        .then((hives) => {
          for (const h of hives) if (hiveIsPublic('live', h)) live.add(h.ca);
        })
        .catch((e) => console.warn('[hive] stream: could not load the live hives:', e instanceof Error ? e.message : e));
    },
    pass(ev) {
      if (ev.type === 'hive') {
        if (hiveIsPublic('live', ev.hive)) live.add(ev.hive.ca);
        else live.delete(ev.hive.ca);
        return hiveIsPublic('live', ev.hive);
      }
      return ev.type === 'action' ? actionIsPublic('live', ev.action, isLive) : harvestIsPublic('live', ev.harvest, isLive);
    },
  };
}

class Hub {
  private readonly clients = new Set<StreamClient>();
  private stopSource: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly source: Source,
    private readonly filter: EventFilter | null = null,
  ) {}

  add(c: StreamClient) {
    this.clients.add(c);
    if (this.stopSource) return;
    this.filter?.start();
    this.stopSource = this.source((ev) => this.broadcast(ev));
    this.heartbeat = setInterval(() => this.send(`event: ping\ndata: ${Date.now()}\n\n`), HEARTBEAT_MS);
  }

  remove(c: StreamClient) {
    if (!this.clients.delete(c) || this.clients.size) return;
    this.stopSource?.();
    this.stopSource = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  get size() {
    return this.clients.size;
  }

  private broadcast(ev: StreamEvent) {
    if (this.filter && !this.filter.pass(ev)) return;
    if (!this.clients.size) return;
    const data = ev.type === 'hive' ? publicHive(ev.hive) : ev.type === 'action' ? ev.action : ev.harvest;
    this.send(`event: ${ev.type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private send(text: string) {
    const bytes = enc.encode(text);
    for (const c of [...this.clients]) c.push(bytes);
  }
}

const hubs = new WeakMap<Db, { events?: Hub; poll?: Hub }>();

/**
 * The hub for `db`: its in-process change feed, or (`poll`) a loop that diffs the store every POLL_MS.
 * In live launch mode both carry only what the public may see (lib/shared/visibility.ts).
 */
export function hubFor(db: Db, mode: 'events' | 'poll', launchMode: LaunchMode = config.launchMode): Hub {
  let entry = hubs.get(db);
  if (!entry) hubs.set(db, (entry = {}));
  if (mode === 'poll') return (entry.poll ??= new Hub(pollSource(db, launchMode)));
  return (entry.events ??= new Hub((emit) => db.subscribe(emit), launchMode === 'live' ? liveFilter(db) : null));
}

/**
 * Change feed from polling: hives whose public form changed, and actions / harvests not seen before
 * (oldest first). The first round only learns the current state: a client loads /api/hives on every
 * (re)connect, so it already has it.
 */
function pollSource(db: Db, launchMode: LaunchMode): Source {
  return (emit) => {
    let stopped = false;
    let busy = false;
    let primed = false;
    const hiveSig = new Map<string, string>();
    let seenActions = new Set<string>();
    let seenHarvests = new Set<string>();
    let warned = false;

    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        const real = launchMode === 'live';
        const lists = await Promise.all([db.listHives(), db.listActions(200, undefined, { real }), db.listHarvests(60, { real })]);
        if (stopped) return;
        const { hives, actions, harvests } = publicView(launchMode, { hives: lists[0], actions: lists[1], harvests: lists[2] });
        const changed: RemoteHive[] = [];
        for (const h of hives) {
          const pub = publicHive(h);
          const sig = JSON.stringify(pub);
          if (hiveSig.get(h.ca) === sig) continue;
          hiveSig.set(h.ca, sig);
          changed.push(pub);
        }
        const freshActions: RemoteAction[] = actions.filter((a) => !seenActions.has(a.id)).reverse();
        const freshHarvests: RemoteHarvest[] = harvests.filter((x) => !seenHarvests.has(x.id)).reverse();
        seenActions = new Set(actions.map((a) => a.id));
        seenHarvests = new Set(harvests.map((x) => x.id));
        if (primed) {
          for (const hive of changed) emit({ type: 'hive', hive });
          for (const action of freshActions) emit({ type: 'action', action });
          for (const harvest of freshHarvests) emit({ type: 'harvest', harvest });
        }
        primed = true;
        warned = false;
      } catch (e) {
        if (!warned) console.warn('[hive] stream polling failed:', e instanceof Error ? e.message : e);
        warned = true;
      } finally {
        busy = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  };
}

/* ---------- connection slots ---------- */

let total = 0;
const perIp = new Map<string, number>();

/** Take a connection slot, or say why not. `release` is idempotent. */
export function acquireSlot(ip: string): { ok: true; release: () => void } | { ok: false; status: 429 | 503 } {
  if (total >= MAX_CONNECTIONS) return { ok: false, status: 503 };
  const known = ip !== UNKNOWN_IP; // unidentifiable clients share the total cap only
  if (known && (perIp.get(ip) ?? 0) >= MAX_PER_IP) return { ok: false, status: 429 };
  total++;
  if (known) perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  let held = true;
  return {
    ok: true,
    release: () => {
      if (!held) return;
      held = false;
      total--;
      if (!known) return;
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n > 0) perIp.set(ip, n);
      else perIp.delete(ip);
    },
  };
}

/** Open connections (for tests and diagnostics). */
export const openConnections = () => total;
