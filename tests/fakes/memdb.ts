/**
 * In-memory Db for tests. Same semantics as FileDb where it matters: CAS updateLaunch, exclusive
 * locks with expiry, cell claims that lapse at `expiresAt` unless finalized. Records are cloned in
 * and out so tests cannot mutate stored state by accident. `now` drives claim and lock expiry.
 */
import type { Cell } from '@/lib/types';
import type { LaunchRecord, Db } from '@/lib/server/db';
import type { LaunchState, RemoteAction, RemoteHarvest, RemoteHive, StreamEvent } from '@/lib/shared/api';

const clone = <T>(v: T): T => structuredClone(v);
const same = (a: Cell, b: Cell) => a.q === b.q && a.r === b.r;

interface Claim extends Cell {
  launchId: string;
  expiresAt: number | null;
}

export class MemDb implements Db {
  readonly kind = 'file' as const;
  now: () => number;
  hives = new Map<string, RemoteHive>();
  actions: RemoteAction[] = [];
  harvests: RemoteHarvest[] = [];
  claims: Claim[] = [];
  launches = new Map<string, LaunchRecord>();
  secrets = new Map<string, string>();
  meta = new Map<string, string>();
  locks = new Map<string, number>();
  prices: { ca: string; at: number; price: number }[] = [];
  private subs = new Set<(ev: StreamEvent) => void>();

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private emit(ev: StreamEvent) {
    for (const fn of this.subs) fn(ev);
  }

  async listHives() {
    return [...this.hives.values()].map(clone);
  }
  async getHive(ca: string) {
    const h = this.hives.get(ca);
    return h ? clone(h) : null;
  }
  async upsertHive(h: RemoteHive) {
    this.hives.set(h.ca, clone(h));
    this.emit({ type: 'hive', hive: clone(h) });
  }

  async listActions(limit: number, ca?: string) {
    return this.actions.filter((a) => !ca || a.ca === ca).slice(0, limit).map(clone);
  }
  async addAction(a: RemoteAction) {
    if (this.actions.some((x) => x.id === a.id)) return; // idempotent by id
    this.actions.unshift(clone(a));
    this.emit({ type: 'action', action: clone(a) });
  }
  async listHarvests(limit: number) {
    return this.harvests.slice(0, limit).map(clone);
  }
  async addHarvest(h: RemoteHarvest) {
    this.harvests.unshift(clone(h));
    this.emit({ type: 'harvest', harvest: clone(h) });
  }

  async claimCell(candidates: Cell[], launchId: string, expiresAt: number) {
    const now = this.now();
    this.claims = this.claims.filter((c) => c.expiresAt === null || c.expiresAt > now);
    for (const cand of candidates) {
      if ([...this.hives.values()].some((h) => same(h.cell, cand))) continue;
      const held = this.claims.find((c) => same(c, cand));
      if (held) {
        if (held.launchId !== launchId) continue;
        if (held.expiresAt !== null) held.expiresAt = expiresAt;
        return { q: cand.q, r: cand.r };
      }
      this.claims = this.claims.filter((c) => !(c.launchId === launchId && c.expiresAt !== null));
      this.claims.push({ q: cand.q, r: cand.r, launchId, expiresAt });
      return { q: cand.q, r: cand.r };
    }
    return null;
  }
  async finalizeCell(launchId: string) {
    for (const c of this.claims) if (c.launchId === launchId) c.expiresAt = null;
  }
  async releaseCell(launchId: string) {
    this.claims = this.claims.filter((c) => c.launchId !== launchId);
  }
  async takenCells(now: number) {
    const out: Cell[] = [...this.hives.values()].map((h) => ({ q: h.cell.q, r: h.cell.r }));
    for (const c of this.claims) if (c.expiresAt === null || c.expiresAt > now) out.push({ q: c.q, r: c.r });
    return out;
  }

  async createLaunch(l: LaunchRecord) {
    if (this.launches.has(l.id)) throw new Error(`launch ${l.id} exists`);
    this.launches.set(l.id, clone(l));
  }
  async getLaunch(id: string) {
    const l = this.launches.get(id);
    return l ? clone(l) : null;
  }
  async updateLaunch(id: string, patch: Partial<LaunchRecord>, expect: LaunchState[]) {
    const cur = this.launches.get(id);
    if (!cur || !expect.includes(cur.state)) return null;
    const next = { ...cur, ...clone(patch), id: cur.id };
    this.launches.set(id, next);
    return clone(next);
  }
  async listLaunches(states: LaunchState[]) {
    return [...this.launches.values()].filter((l) => states.includes(l.state)).map(clone);
  }

  async putSecret(pubkey: string, enc: string) {
    this.secrets.set(pubkey, enc);
  }
  async getSecret(pubkey: string) {
    return this.secrets.get(pubkey) ?? null;
  }
  async getMeta(key: string) {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key: string, value: string) {
    this.meta.set(key, value);
  }
  async lock(name: string, until: number) {
    const held = this.locks.get(name);
    if (held !== undefined && held > this.now()) return false;
    this.locks.set(name, until);
    return true;
  }
  async unlock(name: string) {
    this.locks.delete(name);
  }

  async addPrice(ca: string, at: number, price: number) {
    this.prices.push({ ca, at, price });
  }
  async listPrices(ca: string, since: number) {
    return this.prices.filter((p) => p.ca === ca && p.at >= since).map(({ at, price }) => ({ at, price }));
  }

  subscribe(fn: (ev: StreamEvent) => void) {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }
}
