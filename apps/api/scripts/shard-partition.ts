/**
 * Issue #889 — split the API test files over the CI shards by measured duration.
 *
 * vitest's own `--shard` gives every shard the same NUMBER of files (by path hash), but the cost of
 * a file varies a lot (setup with buildApp, number of tests), so the shards ran 9 / 13 / 13 min.
 * `partitionByDuration()` is the greedy "longest first" split (LPT): files sorted by duration,
 * descending, each one onto the shard with the smallest total so far.
 *
 * Correctness never depends on the durations: every input path lands in exactly one shard, a path
 * the durations do not know gets the median of the known ones, and with no durations at all the
 * caller falls back to vitest's own split. A stale `test-durations.json` only costs balance.
 *
 * Deterministic: all shards of one run compute the same split from the same file set and the same
 * durations file; ties are broken by the path, never by input order.
 */

/** A file's duration in ms, keyed by its path relative to apps/api with forward slashes. */
export type Durations = Readonly<Record<string, number>>;

function median(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The paths split into `count` shards (index 0 = shard 1). Every path appears in exactly one
 * shard; the result does not depend on the order of `paths`.
 */
export function partitionByDuration(
  paths: readonly string[],
  durations: Durations,
  count: number,
): string[][] {
  if (!Number.isInteger(count) || count < 1)
    throw new Error(`shard count must be >= 1, got ${count}`);
  const unique = [...new Set(paths)];
  const known = unique
    .map((p) => durations[p])
    .filter((d): d is number => Number.isFinite(d) && d > 0);
  const fallback = median(known);
  const weighted = unique
    .map((path) => {
      const d = durations[path];
      return { path, cost: Number.isFinite(d) && d > 0 ? d : fallback };
    })
    .sort((a, b) => b.cost - a.cost || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const shards: string[][] = Array.from({ length: count }, () => []);
  const totals: number[] = new Array(count).fill(0);
  for (const { path, cost } of weighted) {
    let target = 0;
    for (let i = 1; i < count; i++) if (totals[i] < totals[target]) target = i;
    shards[target].push(path);
    totals[target] += cost;
  }
  for (const shard of shards) shard.sort();
  return shards;
}

/** The summed known-or-estimated cost of each shard, for logging. */
export function shardTotals(shards: readonly string[][], durations: Durations): number[] {
  const known = Object.values(durations).filter((d) => Number.isFinite(d) && d > 0);
  const fallback = median(known);
  return shards.map((s) =>
    s.reduce((sum, p) => sum + (durations[p] > 0 ? durations[p] : fallback), 0),
  );
}
