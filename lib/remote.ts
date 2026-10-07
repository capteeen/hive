'use client';
/**
 * Browser side of "see other users' hives".
 *
 *   startRemoteSync()
 *     1. GET /api/config            -> store.setConfig (launch mode, realtime transport, demo hives)
 *     2. open the live feed:
 *          realtime 'supabase' -> Supabase Realtime postgres_changes (anon key; RLS allows SELECT only)
 *          realtime 'sse'      -> EventSource('/api/stream'), reconnecting with exponential backoff
 *     3. GET /api/hives             -> store.applyRemote(data, { initial: true })
 *     4. stream events are batched (~120ms) into store.applyRemote; every (re)connect and every 60s
 *        the full list is re-fetched as a safety net for anything missed while disconnected.
 *   store.feed: 'connecting' until the feed first opens, 'live' while open, 'offline' while lost.
 *     Anything heard on the feed (an event, or the SSE ping every 20s) marks it live again, and a
 *     browser 'online' re-checks a connection that survived an 'offline' blip. An SSE connection that
 *     stays silent for SSE_STALE_MS (missed pings: it died without an error) is dropped and reopened.
 *
 * One sync per page: calls are reference counted and teardown is deferred briefly, so React strict
 * mode's mount -> unmount -> mount (or several components asking for it) never starts it twice.
 */
import { useHive } from './store';
import type { HivesResponse, PublicConfig, RemoteAction, RemoteHarvest, RemoteHive } from './shared/api';
import { rowToAction, rowToHarvest, rowToHive, type HiveDetailResponse } from './shared/rows';

const SAFETY_REFETCH_MS = 60_000;
const BATCH_MS = 120;
const TEARDOWN_GRACE_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** /api/stream pings every 20s; this long without hearing anything means the connection is dead. */
const SSE_STALE_MS = 50_000;
/** EventSource.OPEN (read as a number so the module never touches EventSource before it exists). */
const SSE_OPEN = 1;

type Feed = 'connecting' | 'live' | 'offline';

interface Session {
  refs: number;
  teardown: () => void;
  stopTimer: ReturnType<typeof setTimeout> | null;
}

let session: Session | null = null;

/** Start syncing remote hives into the store (once per page). Returns a stop function for this caller. */
export function startRemoteSync(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (!session) session = { refs: 0, teardown: run(), stopTimer: null };
  const s = session;
  s.refs++;
  if (s.stopTimer) {
    clearTimeout(s.stopTimer);
    s.stopTimer = null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    s.refs--;
    if (s.refs > 0 || s.stopTimer) return;
    s.stopTimer = setTimeout(() => {
      s.stopTimer = null;
      if (s.refs > 0) return;
      if (session === s) session = null;
      s.teardown();
    }, TEARDOWN_GRACE_MS);
  };
}

/** One hive's detail (newest 100 actions, last 24h of prices). Null when the server does not know it. */
export async function fetchHiveDetail(ca: string, signal?: AbortSignal): Promise<HiveDetailResponse | null> {
  const res = await fetch(`/api/hives/${encodeURIComponent(ca)}`, { cache: 'no-store', signal, headers: { Accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load hive (HTTP ${res.status}).`);
  return (await res.json()) as HiveDetailResponse;
}

/* ---------- the sync itself ---------- */

const backoff = (attempt: number) => {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 10));
  return Math.round(base * (0.8 + Math.random() * 0.4));
};

const isCell = (c: unknown) => !!c && typeof c === 'object' && Number.isInteger((c as { q: unknown }).q) && Number.isInteger((c as { r: unknown }).r);
const isHive = (h: unknown): h is RemoteHive => !!h && typeof (h as RemoteHive).ca === 'string' && isCell((h as RemoteHive).cell) && Number.isFinite((h as RemoteHive).updatedAt);
const isAction = (a: unknown): a is RemoteAction => !!a && typeof (a as RemoteAction).id === 'string' && typeof (a as RemoteAction).ca === 'string' && Number.isFinite((a as RemoteAction).at);
const isHarvest = (h: unknown): h is RemoteHarvest => !!h && typeof (h as RemoteHarvest).id === 'string' && Number.isFinite((h as RemoteHarvest).at);

function run(): () => void {
  let stopped = false;
  const aborter = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const cleanups: (() => void)[] = [];

  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!stopped) fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const cancel = (t: ReturnType<typeof setTimeout> | null) => {
    if (t) {
      clearTimeout(t);
      timers.delete(t);
    }
  };

  const store = () => useHive.getState();
  const setFeed = (f: Feed) => {
    if (!stopped && store().feed !== f) store().setFeed(f);
  };

  async function getJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { cache: 'no-store', signal: aborter.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /* ----- applying data: newest wins per hive, stream events batched ----- */

  /** updatedAt of the newest version of each hive applied so far (drops stale, out-of-order copies). */
  const applied = new Map<string, number>();
  let initialDone = false;
  const pending = { hives: new Map<string, RemoteHive>(), actions: [] as RemoteAction[], harvests: [] as RemoteHarvest[] };
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const fresh = (hives: RemoteHive[]) =>
    hives.filter((h) => {
      const seen = applied.get(h.ca);
      if (seen !== undefined && h.updatedAt < seen) return false;
      applied.set(h.ca, h.updatedAt);
      return true;
    });

  function enqueue(part: { hive?: RemoteHive; action?: RemoteAction; harvest?: RemoteHarvest }) {
    if (part.hive) {
      const prev = pending.hives.get(part.hive.ca);
      if (!prev || part.hive.updatedAt >= prev.updatedAt) pending.hives.set(part.hive.ca, part.hive);
    }
    if (part.action) pending.actions.push(part.action);
    if (part.harvest) pending.harvests.push(part.harvest);
    if (initialDone && !flushTimer) flushTimer = later(flush, BATCH_MS);
  }

  function flush() {
    flushTimer = null;
    if (stopped || !initialDone) return;
    const world = store().world;
    let missingImage = false;
    const hives = fresh([...pending.hives.values()]).map((h) => {
      if (h.image) return h;
      // the stream omits unchanged images (and Realtime may drop oversized ones): keep ours
      const image = world.hives[h.ca]?.image ?? '';
      if (!image) missingImage = true;
      return { ...h, image };
    });
    const actions = pending.actions;
    const harvests = pending.harvests;
    pending.hives = new Map();
    pending.actions = [];
    pending.harvests = [];
    if (hives.length || actions.length || harvests.length) store().applyRemote({ hives, actions, harvests });
    if (missingImage) scheduleRefetch(1_500);
  }

  /* ----- full fetches ----- */

  let fetching: Promise<void> | null = null;
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFetchAt = 0;

  /** Fetch /api/hives and apply it. Catch-up data never replays animations (initial: true). */
  function refetch(): Promise<void> {
    if (fetching) return fetching;
    fetching = (async () => {
      try {
        const data = await getJson<HivesResponse>('/api/hives');
        if (stopped) return;
        lastFetchAt = Date.now();
        const hives = fresh((data.hives ?? []).filter(isHive));
        store().applyRemote({ hives, actions: (data.actions ?? []).filter(isAction), harvests: (data.harvests ?? []).filter(isHarvest) }, { initial: true });
        if (!initialDone) {
          initialDone = true;
          flush(); // stream events that arrived while the first list was loading
        }
      } finally {
        fetching = null;
      }
    })();
    return fetching;
  }

  function scheduleRefetch(ms: number) {
    if (refetchTimer) return;
    refetchTimer = later(() => {
      refetchTimer = null;
      refetch().catch(() => {});
    }, ms);
  }

  /* ----- transports ----- */

  function startSse(): () => void {
    let es: EventSource | null = null;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    /** When the open connection last said anything (open, event or ping). */
    let heardAt = 0;

    const parse = (e: MessageEvent) => {
      try {
        return JSON.parse(e.data as string) as unknown;
      } catch {
        return null;
      }
    };
    /** Close `src` and reconnect with backoff (EventSource's own retry gives up on HTTP errors and never backs off). */
    const drop = (src: EventSource) => {
      if (es !== src) return;
      src.close();
      es = null;
      if (stopped) return;
      setFeed('offline');
      retry = later(connect, backoff(attempt++));
    };
    const connect = () => {
      retry = null;
      if (stopped) return;
      const src = new EventSource('/api/stream');
      es = src;
      /** Something arrived on this connection: it is alive. */
      const heard = () => {
        if (es !== src) return false;
        heardAt = Date.now();
        setFeed('live');
        return true;
      };
      src.onopen = () => {
        if (!heard()) return;
        attempt = 0;
        scheduleRefetch(250); // catch up on anything sent before this connection existed
      };
      src.addEventListener('ping', () => heard());
      src.addEventListener('hive', (e) => {
        if (!heard()) return;
        const h = parse(e as MessageEvent);
        if (isHive(h)) enqueue({ hive: h });
      });
      src.addEventListener('action', (e) => {
        if (!heard()) return;
        const a = parse(e as MessageEvent);
        if (isAction(a)) enqueue({ action: a });
      });
      src.addEventListener('harvest', (e) => {
        if (!heard()) return;
        const h = parse(e as MessageEvent);
        if (isHarvest(h)) enqueue({ harvest: h });
      });
      src.onerror = () => drop(src);
    };
    connect();

    // A connection can die without an error event (sleep, network switch, a proxy dropping it): the
    // pings stop. Reopen it rather than showing 'live' over a dead feed.
    const watchdog = setInterval(() => {
      if (es && es.readyState === SSE_OPEN && Date.now() - heardAt > SSE_STALE_MS) drop(es);
    }, SSE_STALE_MS / 5);

    const onOnline = () => {
      if (stopped) return;
      if (es) {
        // The connection outlived the blip ('offline' already set the feed offline): live again if it
        // is open and still hearing pings. A connecting one turns live in onopen.
        if (es.readyState === SSE_OPEN && Date.now() - heardAt <= SSE_STALE_MS) setFeed('live');
        return;
      }
      cancel(retry);
      attempt = 0;
      connect();
    };
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(watchdog);
      cancel(retry);
      es?.close();
      es = null;
    };
  }

  function startSupabase(cfg: PublicConfig): () => void {
    let closed = false;
    let teardown: (() => void) | null = null;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    /** Bumped for every client we build, so callbacks from a torn-down channel are ignored. */
    let gen = 0;
    /** Whether the current channel is joined (re-checked when the browser comes back online). */
    let joined: () => boolean = () => false;
    const dropClient = () => {
      const t = teardown;
      teardown = null;
      gen++;
      t?.();
    };

    const open = async () => {
      retry = null;
      try {
        const { createClient } = await import('@supabase/supabase-js');
        if (closed || stopped) return;
        const mine = ++gen;
        const client = createClient(cfg.supabaseUrl!, cfg.supabaseAnonKey!, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
        /** A change arrived on this channel: the feed is live (unless the channel was already dropped). */
        const heard = () => {
          if (closed || stopped || mine !== gen) return false;
          setFeed('live');
          return true;
        };
        const onHive = (row: unknown) => {
          if (!heard()) return;
          const h = rowToHive(row);
          if (h) enqueue({ hive: h });
        };
        const channel = client
          .channel('hive-feed')
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'hives' }, (p) => onHive(p.new))
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'hives' }, (p) => onHive(p.new))
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'actions' }, (p) => {
            if (!heard()) return;
            const a = rowToAction(p.new);
            if (a) enqueue({ action: a });
          })
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'harvests' }, (p) => {
            if (!heard()) return;
            const h = rowToHarvest(p.new);
            if (h) enqueue({ harvest: h });
          })
          .subscribe((status) => {
            if (closed || stopped || mine !== gen) return;
            if (status === 'SUBSCRIBED') {
              attempt = 0;
              setFeed('live');
              scheduleRefetch(250);
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              setFeed('offline'); // the client keeps retrying the join itself
            } else if (status === 'CLOSED') {
              // closed by the server: build a fresh client after a backoff
              setFeed('offline');
              dropClient();
              if (!retry) retry = later(open, backoff(attempt++));
            }
          });
        joined = () => mine === gen && channel.state === 'joined';
        teardown = () => {
          joined = () => false;
          void client.removeChannel(channel);
          client.realtime.disconnect();
        };
      } catch (e) {
        if (closed || stopped) return;
        console.warn('[hive] realtime unavailable, retrying:', e instanceof Error ? e.message : e);
        setFeed('offline');
        retry = later(open, backoff(attempt++));
      }
    };
    void open();
    // The socket can outlive an 'offline' blip (then no new SUBSCRIBED status arrives): if the channel
    // is still joined, the feed is live. A socket that did drop rejoins by itself and reports SUBSCRIBED.
    const onOnline = () => {
      if (!closed && !stopped && joined()) setFeed('live');
    };
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
      closed = true;
      cancel(retry);
      dropClient();
    };
  }

  /* ----- boot ----- */

  async function boot() {
    setFeed('connecting');
    let cfg: PublicConfig | null = null;
    for (let attempt = 0; !stopped && !cfg; attempt++) {
      try {
        cfg = await getJson<PublicConfig>('/api/config');
      } catch {
        if (stopped) return;
        setFeed('offline');
        await new Promise<void>((resolve) => later(resolve, backoff(attempt)));
      }
    }
    if (stopped || !cfg) return;
    store().setConfig(cfg);

    const useSupabase = cfg.realtime === 'supabase' && !!cfg.supabaseUrl && !!cfg.supabaseAnonKey;
    cleanups.push(useSupabase ? startSupabase(cfg) : startSse());

    for (let attempt = 0; !stopped && !initialDone; attempt++) {
      try {
        await refetch();
      } catch {
        if (stopped) return;
        await new Promise<void>((resolve) => later(resolve, backoff(attempt)));
      }
    }
    if (stopped) return;

    const safety = setInterval(() => {
      if (!stopped) refetch().catch(() => {});
    }, SAFETY_REFETCH_MS);
    cleanups.push(() => clearInterval(safety));
  }

  const onOffline = () => setFeed('offline');
  const onVisible = () => {
    if (document.visibilityState === 'visible' && initialDone && Date.now() - lastFetchAt > 30_000) refetch().catch(() => {});
  };
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisible);
  cleanups.push(() => {
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', onVisible);
  });

  boot().catch((e) => console.warn('[hive] remote sync stopped:', e instanceof Error ? e.message : e));

  return () => {
    if (stopped) return;
    stopped = true;
    aborter.abort();
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const c of cleanups.splice(0)) {
      try {
        c();
      } catch {
        // best effort
      }
    }
  };
}
