/**
 * "No fake hives by default" on the client:
 *   - the server's demo flag and the store's build-time default are both off unless NEXT_PUBLIC_DEMO_HIVES
 *     is set, so a page never flashes the 60 simulated hives before /api/config arrives;
 *   - a demo-free world invents nothing (no $HIVE price, no harvest), and an empty comb offers the origin;
 *   - the server can still turn demo hives on (=1) after the build said off;
 *   - pages show an invitation to found the first hive instead of made-up rows, and the harvest page
 *     shows the real $HIVE mint or "not launched yet", never the theme's placeholder address;
 *   - live mode: Supabase Realtime rows (anon SELECT returns every row) are filtered in the browser.
 * Each test gets fresh modules (the store reads the env once, at import).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublicConfig, RemoteHive } from '@/lib/shared/api';

// the vitest config keeps tsconfig's jsx: 'preserve', which esbuild turns into classic React.createElement
(globalThis as unknown as { React: typeof React }).React = React;

const costs = { launchCost: 0.02, queenReserve: 0.05, maxDevBuy: 10 };
const cfg = (over: Partial<PublicConfig> = {}): PublicConfig => ({ launchMode: 'mock', realtime: 'sse', demoHives: false, costs, ...over });

let stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock('@supabase/supabase-js');
  vi.useRealTimers();
});

async function fresh(env?: string) {
  vi.resetModules();
  if (env === undefined) delete process.env.NEXT_PUBLIC_DEMO_HIVES;
  else vi.stubEnv('NEXT_PUBLIC_DEMO_HIVES', env);
  const store = await import('@/lib/store');
  stops.push(store.stopSim);
  return { ...store, ...(await import('@/lib/sim')) };
}

/** A static render reads zustand's server snapshot (the initial state): make the current state that snapshot. */
async function render(el: () => Promise<React.ReactElement>) {
  const { useHive } = await import('@/lib/store');
  Object.assign(useHive.getInitialState(), useHive.getState());
  return renderToStaticMarkup(await el());
}

const remoteHive = (ca: string, status: 'mock' | 'live', q: number, over: Partial<RemoteHive> = {}): RemoteHive => ({
  ca,
  name: `Hive ${ca}`,
  ticker: 'HV',
  image: '',
  cell: { q, r: 0 },
  queenWallet: `queen-${ca}`,
  ownerWallet: `owner-${ca}`,
  devBuy: 0,
  status,
  honey: 1,
  bees: 2,
  feesTotal: 0,
  royalJelly: 0,
  state: 'working',
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now(),
  ...over,
});

describe('defaults', () => {
  it('the server shows no demo hives unless NEXT_PUBLIC_DEMO_HIVES is set', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_DEMO_HIVES;
    expect((await import('@/lib/server/config')).config.demoHives).toBe(false);
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_DEMO_HIVES', '1');
    expect((await import('@/lib/server/config')).config.demoHives).toBe(true);
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_DEMO_HIVES', '0');
    expect((await import('@/lib/server/config')).config.demoHives).toBe(false);
  });

  it('the store starts demo-free (before /api/config) unless the build enabled demo hives', async () => {
    let s = await fresh();
    expect(s.BUILD_DEMO_HIVES).toBe(false);
    expect(s.useHive.getState().world.order).toHaveLength(0);
    expect(s.useHive.getState().world.hubPrice).toBe(0);
    expect(s.useHive.getState().stats.hives).toBe(0);
    s = await fresh('1');
    expect(s.BUILD_DEMO_HIVES).toBe(true);
    expect(s.useHive.getState().world.order).toHaveLength(s.SEED_HIVES);
    s = await fresh('off');
    expect(s.useHive.getState().world.order).toHaveLength(0);
  });

  it('a started store without config simulates nothing', async () => {
    vi.stubGlobal('window', {});
    vi.useFakeTimers();
    const s = await fresh();
    s.useHive.getState().start();
    vi.advanceTimersByTime(3 * s.HOUR_MS);
    const st = s.useHive.getState();
    expect(st.world.order).toHaveLength(0);
    expect(st.world.harvests).toEqual([]);
    expect(st.world.actions).toEqual([]);
    expect(st.positions).toEqual([]);
    expect(st.stats.burned).toBe(0);
  });

  it('a demo-free world has no $HIVE price, never harvests, and offers the origin cell', async () => {
    const { createWorld, createClock, stepWorld, frontierCells, isFoundable, SEED, HOUR_MS } = await fresh();
    const w = createWorld(SEED, Date.now(), false);
    expect(w.hubPrice).toBe(0);
    const clock = createClock(Date.now());
    for (let t = Date.now(); t < Date.now() + 2 * HOUR_MS; t += 1000) stepWorld(w, clock, t);
    expect(w.harvests).toEqual([]);
    expect(Number.isNaN(w.hubBurnedTotal)).toBe(false);
    expect(frontierCells(w)).toEqual([{ q: 0, r: 0 }]);
    expect(isFoundable(w, { q: 0, r: 0 })).toBe(true);
  });

  it('the server can still turn demo hives on after a demo-free build; remote hives keep their cells', async () => {
    vi.stubGlobal('window', {});
    const s = await fresh();
    s.useHive.getState().start();
    s.useHive.getState().applyRemote({ hives: [remoteHive('RemoteOnOrigin', 'mock', 0)] }, { initial: true });
    s.useHive.getState().setConfig(cfg({ demoHives: true }));
    const st = s.useHive.getState();
    expect(st.world.hives.RemoteOnOrigin?.source).toBe('remote');
    expect(st.world.order.length).toBe(s.SEED_HIVES); // 59 demo hives (the origin one gave way) + the remote one
    const cells = new Set(st.world.order.map((ca) => `${st.world.hives[ca].cell.q},${st.world.hives[ca].cell.r}`));
    expect(cells.size).toBe(st.world.order.length); // never two hives on one cell
    expect(st.world.hubPrice).toBeGreaterThan(0);
    expect(st.positions).toHaveLength(4);
  });
});

describe('empty states', () => {
  it('home explore preview and the leaderboard invite founding the first hive', async () => {
    await fresh();
    const { useHive } = await import('@/lib/store');
    useHive.getState().setConfig(cfg());
    const explore = await render(async () => React.createElement((await import('@/components/home/ExplorePreview')).default));
    expect(explore).toContain('data-empty="hives"');
    expect(explore).toContain('Found the first');
    const board = await render(async () => React.createElement((await import('@/components/home/HivesOrEmpty')).default, { body: 'Nothing ranked yet.' }, React.createElement('table', { id: 'board' })));
    expect(board).toContain('Nothing ranked yet.');
    expect(board).not.toContain('id="board"');
  });

  it('the leaderboard shows the table once a hive exists', async () => {
    await fresh();
    const { useHive } = await import('@/lib/store');
    useHive.getState().setConfig(cfg());
    useHive.getState().applyRemote({ hives: [remoteHive('First', 'mock', 0)] }, { initial: true });
    const board = await render(async () => React.createElement((await import('@/components/home/HivesOrEmpty')).default, {}, React.createElement('table', { id: 'board' })));
    expect(board).toContain('id="board"');
  });

  it('the harvest page: no made-up mint, price or pool, and a "nothing yet" row', async () => {
    await fresh();
    const { useHive } = await import('@/lib/store');
    const { theme } = await import('@/themes');
    useHive.getState().setConfig(cfg());
    const html = await render(async () => React.createElement((await import('@/components/HarvestPage')).default));
    expect(html).not.toContain(theme.hubToken.ca.slice(0, 6));
    expect(html).toContain('not launched yet');
    expect(html).toContain('data-empty="harvests"');
    expect(html).toContain('Found the first');
    expect(html).not.toMatch(/0\.0000\d+ SOL/); // no simulated $HIVE price
  });

  it('the harvest page links the real $HIVE mint once the server has one', async () => {
    await fresh();
    const { useHive } = await import('@/lib/store');
    const mint = 'So11111111111111111111111111111111111111112';
    useHive.getState().setConfig(cfg({ launchMode: 'live', hubTokenMint: mint }));
    const html = await render(async () => React.createElement((await import('@/components/HarvestPage')).default));
    expect(html).toContain(`https://solscan.io/account/${mint}`);
  });
});

describe('live mode: Supabase Realtime rows are filtered in the browser', () => {
  it('drops preview hives, their actions and dry runs; keeps live rows', async () => {
    const handlers: Record<string, (p: { new: unknown }) => void> = {};
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => {
        const channel = {
          state: 'joined',
          on(_kind: string, f: { event: string; table: string }, cb: (p: { new: unknown }) => void) {
            handlers[`${f.event}:${f.table}`] = cb;
            return channel;
          },
          subscribe(cb: (status: string) => void) {
            setTimeout(() => cb('SUBSCRIBED'), 0);
            return channel;
          },
        };
        return { channel: () => channel, removeChannel: async () => {}, realtime: { disconnect() {} } };
      },
    }));
    const noop = () => {};
    vi.stubGlobal('window', { addEventListener: noop, removeEventListener: noop });
    vi.stubGlobal('document', { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible' });
    const live = cfg({ launchMode: 'live', realtime: 'supabase', supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon' });
    vi.stubGlobal('fetch', async (url: string) => {
      const body = url === '/api/config' ? live : { hives: [], actions: [], harvests: [], serverTime: Date.now() };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await fresh();
    const { useHive } = await import('@/lib/store');
    const { startRemoteSync } = await import('@/lib/remote');
    const { hiveToRow, actionToRow, harvestToRow } = await import('@/lib/shared/rows');
    stops.push(startRemoteSync());
    for (let i = 0; i < 50 && !handlers['INSERT:hives']; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 400)); // the first list is in (Realtime events wait for it)
    expect(useHive.getState().config?.launchMode).toBe('live');

    handlers['INSERT:hives']({ new: hiveToRow(remoteHive('PreviewRow', 'mock', 1)) });
    handlers['INSERT:hives']({ new: hiveToRow(remoteHive('LiveRow', 'live', 2)) });
    handlers['INSERT:actions']({ new: actionToRow({ id: 'a-preview', ca: 'PreviewRow', verb: 'store', amount: 1, reason: 'x', at: Date.now() }) });
    handlers['INSERT:actions']({ new: actionToRow({ id: 'a-dry', ca: 'LiveRow', verb: 'seal', amount: 1, reason: 'x', at: Date.now(), dryRun: true }) });
    handlers['INSERT:actions']({ new: actionToRow({ id: 'a-real', ca: 'LiveRow', verb: 'store', amount: 1, reason: 'x', at: Date.now() }) });
    handlers['INSERT:harvests']({ new: harvestToRow({ id: 'h-dry', at: Date.now(), feesIn: 1, hiveBought: 1, burned: 1, jellyTo: 'LiveRow', jellyAmount: 1, jellySol: 1, txSig: '', dryRun: true }) });
    handlers['INSERT:harvests']({ new: harvestToRow({ id: 'h-preview', at: Date.now(), feesIn: 1, hiveBought: 1, burned: 1, jellyTo: 'PreviewRow', jellyAmount: 1, jellySol: 1, txSig: 'mock' }) });
    handlers['INSERT:harvests']({ new: harvestToRow({ id: 'h-real', at: Date.now(), feesIn: 1, hiveBought: 1, burned: 7, jellyTo: 'LiveRow', jellyAmount: 1, jellySol: 1, txSig: 'real' }) });
    await new Promise((r) => setTimeout(r, 300)); // one batch
    const w = useHive.getState().world;
    expect(Object.keys(w.hives)).toEqual(['LiveRow']);
    expect(w.actions.map((a) => a.id)).toEqual(['a-real']);
    expect(w.harvests.map((h) => h.id)).toEqual(['h-real']);
    expect(useHive.getState().stats.burned).toBe(7);
  });
});
