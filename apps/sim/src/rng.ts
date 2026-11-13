/**
 * Deterministic randomness for the whole simulation (Issue #715).
 *
 * Every decision of a bot hangs on a seed. A stream is addressed by its keys, never by the order in
 * which decisions happen to be taken: `rngFor(seed, "day", "2026-11-03", "person-017")` yields the
 * same numbers no matter how many other persons were simulated before. That is what makes a failure
 * reproducible from its seed, date and person key alone.
 */

/** FNV-1a over the string, folded to an unsigned 32-bit integer. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a tiny, well distributed 32-bit generator. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** True with the given probability. */
  chance(p: number): boolean;
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** One element, weighted; weights need not sum to 1. */
  weighted<T>(items: readonly { value: T; weight: number }[]): T;
  /** Fisher-Yates copy. */
  shuffle<T>(items: readonly T[]): T[];
}

export function rngFor(seed: string, ...keys: string[]): Rng {
  const next = mulberry32(hashString([seed, ...keys].join("\u0000")));
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    chance: (p) => next() < p,
    int,
    pick: (items) => {
      if (items.length === 0) throw new Error("pick() from an empty list");
      return items[int(0, items.length - 1)];
    },
    weighted: (items) => {
      const total = items.reduce((sum, item) => sum + item.weight, 0);
      if (!(total > 0)) throw new Error("weighted() needs a positive total weight");
      let roll = next() * total;
      for (const item of items) {
        roll -= item.weight;
        if (roll < 0) return item.value;
      }
      return items[items.length - 1].value;
    },
    shuffle: (items) => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = int(0, i);
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
  };
}
