/** Deterministic PRNG (mulberry32) so the seeded world is identical on server and client. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(rng: Rng, len: number) {
  let s = '';
  for (let i = 0; i < len; i++) s += B58[Math.floor(rng() * B58.length)];
  return s;
}
export const mockAddress = (rng: Rng) => base58(rng, 44);
export const mockSig = (rng: Rng) => base58(rng, 88);
export const pick = <T,>(rng: Rng, arr: T[]) => arr[Math.floor(rng() * arr.length)];
export const range = (rng: Rng, a: number, b: number) => a + rng() * (b - a);
