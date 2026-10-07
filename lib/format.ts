export const fmtSol = (n: number, d = 2) =>
  `${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })} SOL`;

export const fmtNum = (n: number, d = 0) =>
  n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export const fmtCompact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : fmtNum(n);

export const short = (addr: string, n = 4) => (addr ? `${addr.slice(0, n)}…${addr.slice(-n)}` : '');

export function timeAgo(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function countdown(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export const txUrl = (sig: string) => `https://solscan.io/tx/${sig}`;
export const addrUrl = (a: string) => `https://solscan.io/account/${a}`;
export const pumpUrl = (ca: string) => `https://pump.fun/coin/${ca}`;

export function aliveFor(bornAt: number, now = Date.now()) {
  const h = Math.floor((now - bornAt) / 3600000);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
