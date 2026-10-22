/** mulberry32: tiny deterministic PRNG so the mock's seed data is identical on every start (seed 42). */
export function createPrng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(arr: readonly T[]): T => arr[int(0, arr.length - 1)] as T;
  const chars = (alphabet: string, n: number): string =>
    Array.from({ length: n }, () => pick([...alphabet])).join('');
  return {
    next,
    int,
    pick,
    digits: (n: number) => chars('0123456789', n),
    letters: (n: number) => chars('ABCDEFGHIJKLMNOPQRSTUVWXYZ', n),
    alnum: (n: number) => chars('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', n),
  };
}

export type Prng = ReturnType<typeof createPrng>;
