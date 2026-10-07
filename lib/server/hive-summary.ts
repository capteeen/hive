import 'server-only';
/**
 * A hive's headline numbers for server-rendered metadata (page title, description, OG image): the stored
 * hive when the public may see it (lib/shared/visibility.ts), else a simulated demo hive only while demo
 * hives are on. Never a made-up hive for an address that is not one.
 */
import { createWorld, SEED } from '@/lib/sim';
import type { HiveState } from '@/lib/types';
import { hiveIsPublic } from '@/lib/shared/visibility';
import { config } from './config';
import { getDb } from './db';

export interface HiveSummary {
  ca: string;
  name: string;
  ticker: string;
  honey: number;
  bees: number;
  state: HiveState;
  biggest: boolean;
  /** 'demo': simulated; 'preview': a mock launch; 'live': a real coin. */
  source: 'demo' | 'preview' | 'live';
}

const CA_RE = /^[A-Za-z0-9_-]{1,100}$/;

export async function hiveSummary(ca: string): Promise<HiveSummary | null> {
  if (!CA_RE.test(ca)) return null;
  try {
    const db = await getDb();
    const h = await db.getHive(ca);
    if (h && hiveIsPublic(config.launchMode, h)) {
      return { ca, name: h.name, ticker: h.ticker, honey: h.honey, bees: h.bees, state: h.state, biggest: false, source: h.status === 'live' ? 'live' : 'preview' };
    }
  } catch (e) {
    console.warn('[hive] hive summary lookup failed:', e instanceof Error ? e.message : e);
  }
  if (!config.demoHives) return null;
  const world = createWorld(SEED);
  const d = world.hives[ca];
  return d ? { ca, name: d.name, ticker: d.ticker, honey: d.honey, bees: d.bees, state: d.state, biggest: d.ca === world.biggestCa, source: 'demo' } : null;
}
