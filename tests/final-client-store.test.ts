import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicConfig, RemoteAction, RemoteHarvest, RemoteHive } from '@/lib/shared/api';

// These cases exercise the demo hives a NEXT_PUBLIC_DEMO_HIVES=1 build shows before /api/config loads.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_DEMO_HIVES = '1';
});

/**
 * Client store regressions (final review, client group):
 *   #10 remote swarm counters re-counted on every safety re-fetch once the action left the capped log
 *   #11 setOwnerIds / applyRemote only ever added to `mine`: the previous wallet's hives stayed "yours"
 *   #12 demo hives off: demo hub numbers stayed and the simulator kept inventing harvests
 *   #13 live mode: the harvest countdown counted 60 s mock hours instead of the server's real hours
 *   #22 the guest-id fallback 'guest:anonymous' was shared by every visitor without storage
 * Each test gets a fresh store (and simulator) module.
 */

let current: typeof import('@/lib/store') | null = null;
const fresh = async () => {
  vi.resetModules();
  const store = (current = await import('@/lib/store'));
  const sim = await import('@/lib/sim');
  return { ...store, ...sim };
};

afterEach(() => {
  current?.stopSim(); // the simulator interval of the store instance this test started
  current = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const costs = { launchCost: 0.02, queenReserve: 0.05, maxDevBuy: 10 };
const cfg = (over: Partial<PublicConfig> = {}): PublicConfig => ({ launchMode: 'mock', realtime: 'sse', demoHives: true, costs, ...over });

function remoteHive(ca: string, over: Partial<RemoteHive> = {}): RemoteHive {
  const t = Date.now();
  return {
    ca,
    name: ca,
    ticker: ca.slice(0, 4).toUpperCase(),
    image: '',
    cell: { q: 40, r: 0 },
    queenWallet: 'Queen' + ca,
    ownerWallet: 'Owner' + ca,
    devBuy: 0,
    status: 'live',
    honey: 1,
    bees: 3,
    feesTotal: 0.5,
    royalJelly: 0,
    state: 'working',
    createdAt: t - 3_600_000,
    updatedAt: t,
    ...over,
  };
}

/** Lets store.start() run in node (it only checks that `window` exists). */
const fakeWindow = () => vi.stubGlobal('window', {});

describe('#10 remote swarm counters across safety re-fetches', () => {
  it('counts a swarm action once, even after the demo log pushed it out of world.actions', async () => {
    const { useHive, createClock, stepWorld } = await fresh();
    const T0 = 1_760_000_000_000 + 1_000; // the store's FIXED_EPOCH world, before start()
    const A = remoteHive('RemoteAAAA', { cell: { q: 30, r: 0 }, createdAt: T0 - 3_600_000, updatedAt: T0 });
    const B = remoteHive('RemoteBBBB', { cell: { q: 31, r: 0 }, createdAt: T0 - 3_600_000, updatedAt: T0 });
    const swarm: RemoteAction = { id: 'swarm-1', ca: A.ca, verb: 'swarm', amount: 0.3, targetCa: B.ca, reason: 'raid', at: T0 };
    const payload = { hives: [A, B], actions: [swarm], harvests: [] };

    useHive.getState().applyRemote(payload, { initial: true });
    expect(useHive.getState().world.hives[A.ca].swarmsOut).toBe(1);
    expect(useHive.getState().world.hives[B.ca].swarmsIn).toBe(1);

    // ~10 minutes of the demo simulator (store.start()'s 250 ms interval)
    const w = useHive.getState().world;
    const clock = createClock(T0);
    let now = T0;
    for (let i = 0; i < 2400; i++) stepWorld(w, clock, (now += 250));
    useHive.setState({ world: w, version: useHive.getState().version + 1 });
    expect(useHive.getState().world.actions.some((a) => a.id === 'swarm-1')).toBe(false); // the precondition

    // the 60 s safety re-fetch returns exactly the same server data, twice
    useHive.getState().applyRemote(payload, { initial: true });
    useHive.getState().applyRemote(payload, { initial: true });
    expect(useHive.getState().world.hives[A.ca].swarmsOut).toBe(1);
    expect(useHive.getState().world.hives[B.ca].swarmsIn).toBe(1);
  });

  it('counts the target side once it arrives, and duplicates within one payload once', async () => {
    const { useHive } = await fresh();
    const A = remoteHive('RemoteCCCC', { cell: { q: 32, r: 0 } });
    const B = remoteHive('RemoteDDDD', { cell: { q: 33, r: 0 } });
    const swarm: RemoteAction = { id: 'swarm-2', ca: A.ca, verb: 'swarm', amount: 0.3, targetCa: B.ca, reason: 'raid', at: Date.now() };
    useHive.getState().applyRemote({ hives: [A], actions: [swarm, swarm] }, { initial: true });
    expect(useHive.getState().world.hives[A.ca].swarmsOut).toBe(1);
    useHive.getState().applyRemote({ hives: [A, B], actions: [swarm] }, { initial: true });
    expect(useHive.getState().world.hives[A.ca].swarmsOut).toBe(1);
    expect(useHive.getState().world.hives[B.ca].swarmsIn).toBe(1);
    expect(useHive.getState().world.actions.filter((a) => a.id === 'swarm-2')).toHaveLength(1);
  });
});

describe('#11 mine follows the connected wallet', () => {
  const WALLET_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const WALLET_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const GUEST = 'guest:abcdefgh';

  it('drops the previous wallet’s hives when the wallet changes, and takes them back on return', async () => {
    const { useHive } = await fresh();
    useHive.getState().setOwnerIds([WALLET_A, GUEST]);
    useHive.getState().applyRemote({ hives: [remoteHive('HiveOfA111', { ownerWallet: WALLET_A }), remoteHive('HiveOfGuest', { ownerWallet: GUEST, cell: { q: 41, r: 0 } })] }, { initial: true });
    expect(useHive.getState().mine).toEqual(expect.arrayContaining(['HiveOfA111', 'HiveOfGuest']));

    useHive.getState().setOwnerIds([WALLET_B, GUEST]); // RemoteSync after a wallet switch
    expect(useHive.getState().mine).not.toContain('HiveOfA111');
    expect(useHive.getState().mine).toContain('HiveOfGuest');

    useHive.getState().setOwnerIds([GUEST]); // disconnected
    expect(useHive.getState().mine).toEqual(['HiveOfGuest']);

    useHive.getState().setOwnerIds([WALLET_A, GUEST]);
    expect(useHive.getState().mine).toEqual(expect.arrayContaining(['HiveOfA111', 'HiveOfGuest']));
  });

  it('a later copy of a hive that is no longer owned by these ids leaves `mine`', async () => {
    const { useHive } = await fresh();
    useHive.getState().setOwnerIds([WALLET_B]);
    const h = remoteHive('HiveOfB222', { ownerWallet: WALLET_B });
    useHive.getState().applyRemote({ hives: [h] }, { initial: true });
    expect(useHive.getState().mine).toContain(h.ca);
    useHive.getState().applyRemote({ hives: [{ ...h, ownerWallet: WALLET_A, updatedAt: h.updatedAt + 1 }] });
    expect(useHive.getState().mine).not.toContain(h.ca);
  });

  it('keeps hives founded in this browser (and markMine of a local hive) across wallet changes', async () => {
    const { useHive } = await fresh();
    useHive.getState().setOwnerIds([WALLET_A, GUEST]);
    const local = useHive.getState().found({ name: 'Local One', ticker: 'LOC', image: '', devBuy: 0 });
    expect(useHive.getState().mine).toContain(local.ca);
    useHive.getState().setOwnerIds([WALLET_B, GUEST]);
    useHive.getState().setOwnerIds([GUEST]);
    expect(useHive.getState().mine).toContain(local.ca);
  });
});

describe('#12 demo hives off', () => {
  it('leaves no simulated hub data, and the simulator adds no harvests', async () => {
    const { useHive, createClock, stepWorld, HOUR_MS } = await fresh();
    useHive.getState().setConfig(cfg({ demoHives: false }));
    let s = useHive.getState();
    expect(s.world.order).toHaveLength(0);
    expect(s.world.harvests).toHaveLength(0);
    expect(s.world.hubBurnedTotal).toBe(0);
    expect(s.world.hubPool).toBe(0);
    expect(s.stats.burned).toBe(0);

    // stepping the world (what the store's interval used to do) for two mock hours invents nothing
    const w = s.world;
    const clock = createClock(Date.now());
    const t0 = Date.now();
    for (let t = t0; t < t0 + 2 * HOUR_MS + 2_000; t += 250) stepWorld(w, clock, t);
    useHive.setState({ world: w });
    s = useHive.getState();
    expect(s.world.harvests).toEqual([]);
    expect(s.world.hubBurnedTotal).toBe(0);
    expect(s.world.hubPool).toBe(0);
  });

  it('the running store lists only the server’s harvests and counts down to the server’s next one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 7, 6, 10, 20));
    fakeWindow();
    const { useHive, HOUR_MS } = await fresh();
    useHive.getState().start();
    useHive.getState().setConfig(cfg({ demoHives: false }));
    const events = useHive.getState().world.events.length;
    vi.advanceTimersByTime(2 * HOUR_MS + 5_000);
    let s = useHive.getState();
    expect(s.world.harvests).toEqual([]);
    expect(s.world.events.length).toBe(events); // no harvest pulse on the comb
    expect(s.stats.burned).toBe(0);
    const now = Date.now();
    expect(s.stats.nextHarvestAt).toBe(Math.ceil(now / HOUR_MS) * HOUR_MS);

    const harvest: RemoteHarvest = { id: 'harvest-1', at: now - 1_000, feesIn: 0.2, hiveBought: 1_000, burned: 500, jellyTo: '', jellyAmount: 500, jellySol: 0.06, txSig: 'sig' };
    const dry: RemoteHarvest = { ...harvest, id: 'dry-harvest-2', at: now - 500, burned: 300, dryRun: true };
    s.applyRemote({ harvests: [harvest, dry] }, { initial: true });
    s = useHive.getState();
    expect(s.world.harvests.map((h) => h.id)).toEqual(['dry-harvest-2', 'harvest-1']);
    expect(s.stats.burned).toBe(500); // what the server's listed harvests burned (a dry run burns nothing)
  });

  it('a store started after the config arrives never seeds demo hives', async () => {
    fakeWindow();
    const { useHive } = await fresh();
    useHive.getState().setConfig(cfg({ demoHives: false }));
    useHive.getState().start();
    const s = useHive.getState();
    expect(s.world.order).toHaveLength(0);
    expect(s.world.hubBurnedTotal).toBe(0);
    expect(s.positions).toEqual([]);
  });
});

describe('#13 harvest countdown follows the server’s cadence', () => {
  const REAL_HOUR = 3_600_000;
  const live = (demoHives: boolean) => cfg({ launchMode: 'live', realtime: 'supabase', supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon', demoHives });

  it('live, demo off: counts down to the top of the next UTC hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 7, 6, 10, 20));
    fakeWindow();
    const { useHive } = await fresh();
    useHive.getState().start();
    useHive.getState().setConfig(live(false));
    const next = Date.UTC(2026, 9, 7, 7, 0, 0);
    expect(useHive.getState().stats.nextHarvestAt).toBe(next);
    vi.advanceTimersByTime(61_000); // a mock hour passes: nothing changes
    expect(useHive.getState().stats.nextHarvestAt).toBe(next);
    vi.advanceTimersByTime(next - Date.now() + 1_000); // the real hour passes
    expect(useHive.getState().stats.nextHarvestAt).toBe(next + REAL_HOUR);
    expect(useHive.getState().world.harvests).toEqual([]);
  });

  it('live, demo on: the simulated demo harvest waits for the real hour too', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 7, 6, 10, 20));
    fakeWindow();
    const { useHive } = await fresh();
    useHive.getState().start();
    useHive.getState().setConfig(live(true));
    const next = Date.UTC(2026, 9, 7, 7, 0, 0);
    expect(useHive.getState().stats.nextHarvestAt).toBe(next);
    const before = useHive.getState().world.harvests.length;
    vi.advanceTimersByTime(3 * 61_000);
    expect(useHive.getState().world.harvests.length).toBe(before);
    expect(useHive.getState().stats.nextHarvestAt).toBe(next);
    vi.advanceTimersByTime(next - Date.now() + 1_000);
    expect(useHive.getState().world.harvests.length).toBe(before + 1);
    expect(useHive.getState().stats.nextHarvestAt).toBe(next + REAL_HOUR);
  });

  it('mock mode keeps the 60 s mock hour (the server’s mock engine harvests every HOUR_MS)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 7, 6, 10, 20));
    fakeWindow();
    const { useHive, HOUR_MS } = await fresh();
    useHive.getState().start();
    useHive.getState().setConfig(cfg());
    expect(useHive.getState().stats.nextHarvestAt).toBe(Math.ceil(Date.now() / HOUR_MS) * HOUR_MS);
    const before = useHive.getState().world.harvests.length;
    vi.advanceTimersByTime(HOUR_MS);
    expect(useHive.getState().world.harvests.length).toBe(before + 1);
    expect(useHive.getState().stats.nextHarvestAt).toBe(Math.ceil(Date.now() / HOUR_MS) * HOUR_MS);
  });
});

describe('#22 guest id without storage', () => {
  const blocked = {
    getItem: () => {
      throw new DOMException('denied', 'SecurityError');
    },
    setItem: () => {
      throw new DOMException('denied', 'SecurityError');
    },
  };

  it('is a random id for this page, not a constant shared with other visitors', async () => {
    vi.stubGlobal('localStorage', blocked);
    const { guestId } = await import('@/lib/guest');
    const me = guestId();
    expect(me).not.toBe('guest:anonymous');
    expect(me).toMatch(/^guest:[A-Za-z0-9_-]{6,40}$/); // still a valid owner for the launch API
    expect(guestId()).toBe(me); // stable for the page

    vi.resetModules(); // another visitor (another page)
    const other = (await import('@/lib/guest')).guestId();
    expect(other).not.toBe(me);
  });

  it('does not make a stranger’s storage-less launch "mine"', async () => {
    vi.stubGlobal('localStorage', blocked);
    const { useHive } = await fresh();
    const { guestId } = await import('@/lib/guest');
    useHive.getState().setOwnerIds([guestId()]);
    useHive.getState().applyRemote({ hives: [remoteHive('StrangerHive1', { ownerWallet: 'guest:anonymous', status: 'mock' })] }, { initial: true });
    expect(useHive.getState().mine).not.toContain('StrangerHive1');
  });

  it('still persists the id when storage works', async () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
    const { guestId } = await import('@/lib/guest');
    const id = guestId();
    expect(mem.get('hive:guest')).toBe(id);
    expect(guestId()).toBe(id);
  });
});
