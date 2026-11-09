/**
 * Issue #889 — the vitest sequencer of apps/api. Only `shard()` differs from vitest's own
 * BaseSequencer: with `--shard=i/n` the files are split by the measured durations in
 * `test-durations.json` (scripts/shard-partition.ts) instead of into equal counts. Without that
 * file, or when it cannot be read, vitest's own split applies unchanged. `sort()` (the order inside
 * a run) is vitest's own.
 *
 * The durations are a balance hint, never a correctness input: every file is assigned to exactly
 * one shard whatever the file says, and the merge job of CI proves that against `vitest list`.
 * Refresh: `pnpm --filter @clokr/api run test:durations:update -- <run-id>` (scripts/README.md).
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { partitionByDuration, shardTotals, type Durations } from "./scripts/shard-partition";

export const TEST_DURATIONS_FILE = "test-durations.json";

function readDurations(root: string): Durations | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, TEST_DURATIONS_FILE), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Durations;
  } catch {
    return null;
  }
}

export class DurationShardSequencer extends BaseSequencer {
  async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    const durations = shard ? readDurations(root) : null;
    if (!shard || !durations) return super.shard(files);

    const byPath = new Map<string, TestSpecification>();
    for (const spec of files) byPath.set(relative(root, spec.moduleId).split("\\").join("/"), spec);
    const shards = partitionByDuration([...byPath.keys()], durations, shard.count);
    const mine = shards[shard.index - 1] ?? [];
    const totals = shardTotals(shards, durations).map((ms) => Math.round(ms / 1000));
    console.warn(
      `[shard] ${shard.index}/${shard.count}: ${mine.length} of ${byPath.size} file(s) by duration ` +
        `(${TEST_DURATIONS_FILE}; summed file seconds per shard: ${totals.join(" / ")})`,
    );
    return mine.map((path) => byPath.get(path)!);
  }
}
