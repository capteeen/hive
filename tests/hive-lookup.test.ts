import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptIntoStore, watchHiveLookup, type HiveLookup, type HiveLookupDeps } from '@/components/hive/HivePage';
import { useHive } from '@/lib/store';
import type { HiveDetailResponse } from '@/lib/shared/rows';
import type { RemoteAction, RemoteHive } from '@/lib/shared/api';

// These cases exercise the demo hives a NEXT_PUBLIC_DEMO_HIVES=1 build shows before /api/config loads.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_DEMO_HIVES = '1';
});

/**
 * HivePage used to call an address "not found" once a 4s timer passed and the realtime feed was
 * 'live'. The feed says nothing about whether GET /api/hives has arrived, so a real remote hive on a
 * slow or failing first list showed "No hive at this address". The page now asks /api/hives/[ca]
 * and only a 404 means "missing". These tests drive that lookup with fake timers and fetches.
 */

const CA = 'RemoteCa111pump';
const T = Date.UTC(2026, 9, 7, 6, 0, 0);

function remoteHive(over: Partial<RemoteHive> = {}): RemoteHive {
  return {
    ca: CA,
    name: 'Far Comb',
    ticker: 'FAR',
    image: '',
    cell: { q: 917, r: -911 }, // far outside the demo comb, so the store never sees a cell clash
    queenWallet: 'Queen111',
    ownerWallet: 'Owner111',
    devBuy: 0,
    status: 'mock',
    honey: 1.5,
    bees: 12,
    feesTotal: 2,
    royalJelly: 0,
    state: 'working',
    createdAt: T - 3600_000,
    updatedAt: T,
    ...over,
  };
}

function action(over: Partial<RemoteAction> = {}): RemoteAction {
  return { id: 'act-1', ca: CA, verb: 'store', amount: 0.12, reason: 'kept the honey', at: T - 60_000, ...over };
}

const detail = (over: Partial<HiveDetailResponse> = {}): HiveDetailResponse => ({ hive: remoteHive(), actions: [action()], prices: [], serverTime: T, ...over });

/** Deps with recorded states; fetchDetail / adopt default to "the server knows it and the store takes it". */
function harness(over: Partial<HiveLookupDeps> = {}) {
  const states: HiveLookup[] = [];
  const deps: HiveLookupDeps = {
    fetchDetail: vi.fn(async () => detail()),
    adopt: vi.fn(() => true),
    onState: (s) => states.push(s),
    timeoutMs: 10_000,
    retryMs: () => 1_000,
    configReady: () => true, // /api/config has loaded unless a test says otherwise
    ...over,
  };
  return { deps, states };
}

describe('watchHiveLookup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says "missing" only when the server answers 404', async () => {
    const { deps, states } = harness({ fetchDetail: vi.fn(async () => null) });
    watchHiveLookup(CA, deps);
    await vi.runAllTimersAsync();
    expect(states).toEqual(['checking', 'missing']);
    expect(deps.fetchDetail).toHaveBeenCalledWith(CA, expect.any(AbortSignal));
    expect(deps.adopt).not.toHaveBeenCalled();
  });

  it('adopts a hive the server knows instead of waiting for the list sync', async () => {
    const d = detail();
    const { deps, states } = harness({ fetchDetail: vi.fn(async () => d) });
    watchHiveLookup(CA, deps);
    await vi.runAllTimersAsync();
    expect(deps.adopt).toHaveBeenCalledWith(d);
    expect(states).toEqual(['checking']); // never "missing", even long after the old 4s cut-off
  });

  it('keeps retrying through 5xx errors (the reviewer scenario) and never calls the hive missing', async () => {
    let calls = 0;
    const fetchDetail = vi.fn(async () => {
      calls++;
      if (calls <= 3) throw new Error('Could not load hive (HTTP 500).');
      return detail();
    });
    const retryMs = vi.fn((attempt: number) => 1000 * 2 ** attempt);
    const { deps, states } = harness({ fetchDetail, retryMs });
    watchHiveLookup(CA, deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['checking', 'unreachable']);
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    expect(fetchDetail).toHaveBeenCalledTimes(4);
    expect(retryMs.mock.calls.map((c) => c[0])).toEqual([0, 1, 2]);
    expect(deps.adopt).toHaveBeenCalledTimes(1);
    expect(states).not.toContain('missing');
  });

  it('times out a hung request instead of "looking" forever, then retries', async () => {
    const signals: AbortSignal[] = [];
    const fetchDetail = vi.fn((_ca: string, signal: AbortSignal) => {
      signals.push(signal);
      if (signals.length === 1) {
        // never resolves on its own: only the abort ends it
        return new Promise<HiveDetailResponse | null>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return Promise.resolve(null);
    });
    const { deps, states } = harness({ fetchDetail, timeoutMs: 5_000 });
    watchHiveLookup(CA, deps);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(states).toEqual(['checking']);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(true);
    expect(states).toEqual(['checking', 'unreachable']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(states).toEqual(['checking', 'unreachable', 'missing']);
  });

  it('treats a body for another address or a garbled hive as a server fault, not as a hive', async () => {
    const bodies = [detail({ hive: remoteHive({ ca: 'SomeOtherCa' }) }), detail({ hive: remoteHive({ cell: { q: 1.5, r: 0 } }) }), { nope: true } as unknown as HiveDetailResponse, null];
    const fetchDetail = vi.fn(async () => bodies.shift() ?? null);
    const { deps, states } = harness({ fetchDetail });
    watchHiveLookup(CA, deps);
    await vi.runAllTimersAsync();
    expect(deps.adopt).not.toHaveBeenCalled();
    expect(states).toEqual(['checking', 'unreachable', 'unreachable', 'unreachable', 'missing']);
  });

  it('says "missing" when the store refuses the hive (its cell is taken by a demo hive)', async () => {
    const { deps, states } = harness({ adopt: vi.fn(() => false) });
    watchHiveLookup(CA, deps);
    await vi.runAllTimersAsync();
    expect(states).toEqual(['checking', 'missing']);
  });

  it('a refusal before /api/config has loaded waits for the config, then asks the store again', async () => {
    let ready = false;
    let fire: () => void = () => {};
    const adopt = vi.fn(() => ready); // the demo hive on the cell goes away with the config (demo off)
    const { deps, states } = harness({
      adopt,
      configReady: () => ready,
      whenConfigReady: (fn) => {
        fire = fn;
        return () => (fire = () => {});
      },
    });
    watchHiveLookup(CA, deps);
    await vi.runAllTimersAsync();
    expect(states).toEqual(['checking']);
    ready = true;
    fire();
    expect(adopt).toHaveBeenCalledTimes(2);
    expect(states).toEqual(['checking']);
  });

  it('a refusal that still stands once the config is in is "missing"', async () => {
    let fire: () => void = () => {};
    const { deps, states } = harness({ adopt: vi.fn(() => false), configReady: () => false, whenConfigReady: (fn) => ((fire = fn), () => {}) });
    watchHiveLookup(CA, deps);
    await vi.runAllTimersAsync();
    expect(states).toEqual(['checking']);
    fire();
    expect(states).toEqual(['checking', 'missing']);
  });

  it('stop() aborts the request in flight and reports nothing afterwards', async () => {
    let signal: AbortSignal | null = null;
    let resolve: (d: HiveDetailResponse | null) => void = () => {};
    const fetchDetail = vi.fn((_ca: string, s: AbortSignal) => {
      signal = s;
      return new Promise<HiveDetailResponse | null>((r) => (resolve = r));
    });
    const { deps, states } = harness({ fetchDetail });
    const stop = watchHiveLookup(CA, deps);
    stop();
    expect(signal!.aborted).toBe(true);
    resolve(detail());
    await vi.runAllTimersAsync();
    expect(states).toEqual(['checking']);
    expect(deps.adopt).not.toHaveBeenCalled();
  });

  it('stop() cancels a pending retry', async () => {
    const fetchDetail = vi.fn(async () => {
      throw new Error('offline');
    });
    const { deps, states } = harness({ fetchDetail });
    const stop = watchHiveLookup(CA, deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['checking', 'unreachable']);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchDetail).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['checking', 'unreachable']);
  });
});

describe('adoptIntoStore', () => {
  it('puts the server copy and its own actions into the store, as catch-up', () => {
    const before = useHive.getState().world.events.length;
    const d = detail({ actions: [action(), action({ id: 'act-2', verb: 'swarm', targetCa: 'nowhere', at: T - 30_000 }), action({ id: 'stranger', ca: 'OtherCa' })] });
    expect(adoptIntoStore(CA, d)).toBe(true);
    const s = useHive.getState();
    expect(s.world.hives[CA]?.source).toBe('remote');
    expect(s.world.hives[CA]?.name).toBe('Far Comb');
    const ids = s.world.actions.filter((a) => a.ca === CA).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['act-1', 'act-2']));
    expect(s.world.actions.some((a) => a.id === 'stranger')).toBe(false);
    expect(s.world.events.length).toBe(before); // initial: no spawn / store animations for old news
    // a second adoption (or the list sync arriving later) does not double count
    const swarmsOut = s.world.hives[CA].swarmsOut;
    expect(adoptIntoStore(CA, d)).toBe(true);
    expect(useHive.getState().world.hives[CA].swarmsOut).toBe(swarmsOut);
  });

  it('reports false when the store will not place the hive', () => {
    const w = useHive.getState().world;
    const demo = w.hives[w.order[0]];
    expect(demo.source).not.toBe('remote');
    const ca = 'ClashCa222pump';
    expect(adoptIntoStore(ca, detail({ hive: remoteHive({ ca, cell: { ...demo.cell } }), actions: [] }))).toBe(false);
    expect(useHive.getState().world.hives[ca]).toBeUndefined();
  });
});
