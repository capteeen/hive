/** Convert server-side (remote) records into the client's world model. */
import type { Hive, Action, Harvest } from './types';
import type { RemoteAction, RemoteHarvest, RemoteHive } from './shared/api';

export function remoteToHive(r: RemoteHive, prev?: Hive): Hive {
  const price = r.price ?? prev?.price ?? 0;
  const t = Math.floor((r.updatedAt || Date.now()) / 1000);
  const history = prev?.priceHistory ?? [];
  const priceHistory = price > 0 && (!history.length || history[history.length - 1].value !== price) ? [...history, { time: Math.max(t, (history[history.length - 1]?.time ?? 0) + 1), value: price }].slice(-600) : history;
  return {
    ca: r.ca,
    name: r.name,
    ticker: r.ticker,
    image: r.image,
    queenWallet: r.queenWallet,
    honey: r.honey,
    bees: r.bees,
    beesPeak: Math.max(r.bees, prev?.beesPeak ?? 0),
    feesTotal: r.feesTotal,
    feesHour: prev?.feesHour ?? 0,
    feesPrevHour: prev?.feesPrevHour ?? 0,
    feeAvgHour: prev?.feeAvgHour ?? 0,
    price,
    avg24h: prev?.avg24h ?? price,
    state: r.state,
    swarmsIn: prev?.swarmsIn ?? 0,
    swarmsOut: prev?.swarmsOut ?? 0,
    swarmsWon: prev?.swarmsWon ?? 0,
    royalJelly: r.royalJelly,
    sealed: prev?.sealed ?? 0,
    bornAt: r.createdAt,
    lastFeeAt: r.lastFeeAt ?? r.createdAt,
    cell: { q: r.cell.q, r: r.cell.r },
    vigor: 0,
    priceHistory,
    look: r.look,
    rules: r.rules,
    description: r.description,
    motto: r.motto,
    temperament: r.temperament,
    source: 'remote',
    status: r.status,
    ownerWallet: r.ownerWallet,
    createTx: r.createTx,
  };
}

export const remoteToAction = (a: RemoteAction): Action => ({ id: a.id, ca: a.ca, verb: a.verb, amount: a.amount, targetCa: a.targetCa, reason: a.dryRun ? `[dry run] ${a.reason}` : a.reason, txSig: a.dryRun ? undefined : a.txSig, at: a.at });

export const remoteToHarvest = (h: RemoteHarvest): Harvest => ({ id: h.id, at: h.at, feesIn: h.feesIn, hiveBought: h.hiveBought, burned: h.burned, jellyTo: h.jellyTo, jellyAmount: h.jellyAmount, jellySol: h.jellySol, txSig: h.txSig });
