// Deterministic PRNG (mulberry32) so demo data is reproducible and stable
// across "Reset Demo Data" calls within the same session-quality look.
export function mulberry32(seed: number) {
  let a = seed;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rand = () => number;

export function pick<T>(arr: T[], rand: Rand): T {
  return arr[Math.floor(rand() * arr.length)];
}

export function pickN<T>(arr: T[], n: number, rand: Rand): T[] {
  const copy = [...arr];
  const out: T[] = [];
  while (out.length < n && copy.length > 0) {
    const idx = Math.floor(rand() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

export function randInt(min: number, max: number, rand: Rand): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

export function chance(p: number, rand: Rand): boolean {
  return rand() < p;
}
