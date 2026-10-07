import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HiveDetailResponse } from '@/lib/shared/rows';
import type { LaunchStatusResponse, PublicConfig, RemoteHarvest, RemoteHive } from '@/lib/shared/api';

// These cases exercise the demo hives a NEXT_PUBLIC_DEMO_HIVES=1 build shows before /api/config loads.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_DEMO_HIVES = '1';
});

/**
 * Client view regressions (final review, client group):
 *   #19 HarvestPage linked made-up (demo / mock) harvest signatures to Solscan
 *   #20 HivePage called an existing hive "missing" when its lookup beat /api/config on a demo-off server
 *   #21 the launch view offered no button once polling had timed out on a non-terminal status
 *   #24 pack theme: the ambient layer flew a bee (and buzzed) over the wolves' site
 */

// the vitest config keeps tsconfig's jsx: 'preserve', which esbuild turns into classic React.createElement
(globalThis as unknown as { React: typeof React }).React = React;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const costs = { launchCost: 0.02, queenReserve: 0.05, maxDevBuy: 10 };
const cfg = (over: Partial<PublicConfig> = {}): PublicConfig => ({ launchMode: 'mock', realtime: 'sse', demoHives: true, costs, ...over });

const fresh = async () => {
  vi.resetModules();
  return import('@/lib/store');
};

describe('#19 HarvestPage tx links', () => {
  const serverHarvest = (over: Partial<RemoteHarvest> = {}): RemoteHarvest => ({ id: 'harvest-1', at: Date.now() - 1000, feesIn: 0.2, hiveBought: 1000, burned: 500, jellyTo: '', jellyAmount: 500, jellySol: 0.06, txSig: '4'.repeat(88), ...over });
  const render = async () => {
    const { useHive } = await import('@/lib/store');
    // a static render reads zustand's server snapshot, the store's initial state (config null): make it the current one
    Object.assign(useHive.getInitialState(), useHive.getState());
    const { default: HarvestPage } = await import('@/components/HarvestPage');
    const html = renderToStaticMarkup(React.createElement(HarvestPage));
    return { html, links: html.match(/href="https:\/\/solscan\.io\/tx\/[^"]+"/g) ?? [] };
  };

  it('mock mode: neither the demo harvests nor the server’s MockChain harvests link to Solscan', async () => {
    const { useHive } = await fresh();
    useHive.getState().setConfig(cfg());
    useHive.getState().applyRemote({ harvests: [serverHarvest()] }, { initial: true });
    expect(useHive.getState().world.harvests.length).toBeGreaterThan(1); // demo rows + the server row
    const { html, links } = await render();
    expect(links).toEqual([]);
    expect(html).toContain('simulated');
  });

  it('before /api/config has loaded nothing is linked', async () => {
    const { useHive } = await fresh();
    useHive.getState().applyRemote({ harvests: [serverHarvest()] }, { initial: true });
    expect((await render()).links).toEqual([]);
  });

  it('live mode: only the server’s sent harvests link, not demo rows or dry runs', async () => {
    const { useHive } = await fresh();
    useHive.getState().setConfig(cfg({ launchMode: 'live' }));
    useHive.getState().applyRemote({ harvests: [serverHarvest({ id: 'harvest-real', txSig: '7'.repeat(88) }), serverHarvest({ id: 'dry-harvest-2', txSig: '8'.repeat(88), dryRun: true })] }, { initial: true });
    const { html, links } = await render();
    expect(links).toEqual([`href="https://solscan.io/tx/${'7'.repeat(88)}"`]);
    expect(html).toContain('dry run');
  });
});

describe('#20 HivePage lookup before /api/config on a demo-off server', () => {
  const T = Date.now();
  const hive: RemoteHive = {
    ca: 'FirstHiveOnServer',
    name: 'First',
    ticker: 'FIRST',
    image: '',
    cell: { q: 0, r: 0 }, // a demo-off server hands out the ORIGIN first: a demo hive's cell in the browser
    queenWallet: 'Queen111',
    ownerWallet: 'guest:abcdefgh',
    devBuy: 0,
    status: 'mock',
    honey: 0.05,
    bees: 1,
    feesTotal: 0,
    royalJelly: 0,
    state: 'working',
    createdAt: T - 60_000,
    updatedAt: T,
  };
  const detail: HiveDetailResponse = { hive, actions: [], prices: [], serverTime: T };

  it('keeps checking until the config lands, then adopts the hive', async () => {
    const { useHive } = await fresh();
    const { adoptIntoStore, watchHiveLookup } = await import('@/components/hive/HivePage');
    expect(useHive.getState().config).toBeNull(); // /api/config still in flight
    const states: string[] = [];
    const stop = watchHiveLookup(hive.ca, { fetchDetail: async () => detail, adopt: (d) => adoptIntoStore(hive.ca, d), onState: (s) => states.push(s) });
    await new Promise((r) => setTimeout(r, 20));
    expect(states).toEqual(['checking']);
    expect(useHive.getState().world.hives[hive.ca]).toBeUndefined(); // refused: a demo hive sits there

    useHive.getState().setConfig(cfg({ demoHives: false }));
    expect(useHive.getState().world.hives[hive.ca]?.source).toBe('remote');
    expect(states).toEqual(['checking']);
    stop();
  });

  it('once the config is in and demo hives stay on, a clash is still "missing"', async () => {
    const { useHive } = await fresh();
    const { adoptIntoStore, watchHiveLookup } = await import('@/components/hive/HivePage');
    const states: string[] = [];
    const stop = watchHiveLookup(hive.ca, { fetchDetail: async () => detail, adopt: (d) => adoptIntoStore(hive.ca, d), onState: (s) => states.push(s) });
    await new Promise((r) => setTimeout(r, 20));
    expect(states).toEqual(['checking']);
    useHive.getState().setConfig(cfg({ demoHives: true }));
    expect(states).toEqual(['checking', 'missing']);
    stop();
  });

  it('stop() while waiting for the config reports nothing afterwards', async () => {
    const { useHive } = await fresh();
    const { adoptIntoStore, watchHiveLookup } = await import('@/components/hive/HivePage');
    const states: string[] = [];
    const adopt = vi.fn((d: HiveDetailResponse) => adoptIntoStore(hive.ca, d));
    const stop = watchHiveLookup(hive.ca, { fetchDetail: async () => detail, adopt, onState: (s) => states.push(s) });
    await new Promise((r) => setTimeout(r, 20));
    stop();
    useHive.getState().setConfig(cfg({ demoHives: true }));
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['checking']);
  });
});

describe('#21 a launch whose polling timed out', () => {
  const paid: LaunchStatusResponse = {
    launchId: 'launch_abcdefgh',
    state: 'paid',
    mode: 'live',
    queenWallet: 'Queen1111111111111111111111111111111111111',
    cell: { q: 9, r: 0 },
    txs: { payment: '5'.repeat(88) },
  };
  const reservation = { cell: paid.cell, cellChanged: false, queenWallet: paid.queenWallet, lamports: 70_000_000, expiresAt: Date.now() + 600_000 };

  it('pollLaunch gives up with a non-terminal status and no error (the precondition)', async () => {
    const { needsAction, pollLaunch } = await import('@/lib/launchClient');
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const p = pollLaunch(paid.launchId, { initial: paid });
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    const s = await p;
    expect(s?.state).toBe('paid');
    expect(s?.error).toBeUndefined();
    expect(needsAction(s!)).toBe(false);
  });

  const render = async (over: Record<string, unknown> = {}) => {
    const { default: LaunchProgress } = await import('@/components/launch/LaunchProgress');
    return renderToStaticMarkup(
      React.createElement(LaunchProgress, { mode: 'live', phase: 'confirm', status: paid, reservation, error: undefined, busy: false, canPay: false, onPay: () => {}, onRetry: () => {}, onRefund: () => {}, onDismiss: () => {}, onOpenHive: () => {}, ...over }),
    );
  };

  it('the idle run offers "Check again" instead of pulsing forever with no button', async () => {
    const html = await render();
    expect(html.match(/<button/g)?.length ?? 0).toBeGreaterThan(0);
    expect(html).toContain('Check again');
    expect(html).not.toContain('animate-pulse');
  });

  it('while the wizard is still following the launch there is nothing to press', async () => {
    const html = await render({ busy: true });
    expect(html).not.toContain('Check again');
    expect(html).toContain('animate-pulse');
  });

  it('a mock launch that stalled the same way gets the button too', async () => {
    const html = await render({ mode: 'mock', status: { ...paid, mode: 'mock', state: 'metadata', txs: {} } });
    expect(html).toContain('Check again');
  });
});

describe('#24 the ambient critter comes from the theme', () => {
  it('hive keeps its bee; pack (and any other theme) flies nothing', async () => {
    const { critterFor } = await import('@/components/fx/Ambient');
    expect(critterFor('hive')).not.toBeNull();
    expect(critterFor('pack')).toBeNull();
    expect(critterFor('something-else')).toBeNull();
  });
});
