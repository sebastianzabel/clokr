/**
 * Issue #889 — `partitionByDuration()`: exact cover, determinism, balance, robustness against a
 * stale or missing duration. DB-free, disk-write-free.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { partitionByDuration, shardTotals } from "../shard-partition";

const PATHS = Array.from(
  { length: 40 },
  (_, i) => `src/__tests__/f${String(i).padStart(2, "0")}.test.ts`,
);
// deliberately skewed: a few expensive files, many cheap ones
const DURATIONS = Object.fromEntries(PATHS.map((p, i) => [p, i < 4 ? 60_000 : 1_000 + i * 37]));

const flat = (shards: string[][]) => shards.flat();

describe("partitionByDuration", () => {
  it("puts every path into exactly one shard", () => {
    const shards = partitionByDuration(PATHS, DURATIONS, 3);
    expect(shards).toHaveLength(3);
    expect(flat(shards).sort()).toEqual([...PATHS].sort());
    expect(new Set(flat(shards)).size).toBe(PATHS.length);
  });

  it("does not depend on the input order (every shard computes the same split)", () => {
    const a = partitionByDuration(PATHS, DURATIONS, 3);
    const b = partitionByDuration([...PATHS].reverse(), DURATIONS, 3);
    const c = partitionByDuration(
      [...PATHS].sort(() => 0.5 - Math.random()),
      DURATIONS,
      3,
    );
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("balances by duration far better than an equal-count split", () => {
    const shards = partitionByDuration(PATHS, DURATIONS, 3);
    const totals = shardTotals(shards, DURATIONS);
    const spread = Math.max(...totals) - Math.min(...totals);
    // the largest single file bounds the greedy split's spread
    expect(spread).toBeLessThanOrEqual(60_000);
    const equalCount = [PATHS.slice(0, 14), PATHS.slice(14, 27), PATHS.slice(27)];
    const naive = shardTotals(equalCount, DURATIONS);
    expect(Math.max(...totals)).toBeLessThan(Math.max(...naive));
  });

  it("a path missing from the durations still lands in exactly one shard (median estimate)", () => {
    const withNew = [...PATHS, "src/__tests__/brand-new.test.ts"];
    const shards = partitionByDuration(withNew, DURATIONS, 3);
    expect(flat(shards).sort()).toEqual([...withNew].sort());
  });

  it("stale entries for deleted files and bogus values change nothing about the cover", () => {
    const stale = {
      ...DURATIONS,
      "src/__tests__/deleted.test.ts": 999_999,
      [PATHS[5]]: -3,
      [PATHS[6]]: Number.NaN,
    };
    const shards = partitionByDuration(PATHS, stale, 3);
    expect(flat(shards).sort()).toEqual([...PATHS].sort());
    expect(flat(shards)).not.toContain("src/__tests__/deleted.test.ts");
  });

  it("works with no durations at all, and with more shards than files", () => {
    expect(flat(partitionByDuration(PATHS, {}, 3)).sort()).toEqual([...PATHS].sort());
    const tiny = partitionByDuration(PATHS.slice(0, 2), DURATIONS, 3);
    expect(flat(tiny).sort()).toEqual(PATHS.slice(0, 2).sort());
  });

  it("rejects a shard count below 1", () => {
    expect(() => partitionByDuration(PATHS, DURATIONS, 0)).toThrow(/shard count/);
  });
});

describe("the committed durations file", () => {
  const file = join(__dirname, "..", "..", "test-durations.json");

  it("is a flat map of relative test paths to positive milliseconds, when present", () => {
    if (!existsSync(file)) return; // optional by design: without it vitest's own split applies
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const entries = Object.entries(parsed);
    expect(entries.length).toBeGreaterThan(0);
    for (const [path, ms] of entries) {
      expect(path).toMatch(/^(src|scripts)\/.+\.test\.ts$/);
      expect(typeof ms === "number" && ms >= 0).toBe(true);
    }
  });
});
