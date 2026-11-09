/**
 * Issue #889 — a vitest reporter that writes the measured cost of every test file of a run:
 * environment setup + harness prepare + setup files + import/collect + tests and hooks, in ms,
 * keyed by the path relative to apps/api. CI runs it on every API shard; the merge job combines
 * the three files into the next `test-durations.json` (uploaded as an artifact), which the shard
 * sequencer (vitest.shard-sequencer.ts) reads to balance the shards.
 *
 * Output: `.vitest-durations/durations-<shard index>.json` (or `durations.json` without --shard) —
 * deliberately NOT in `.vitest-reports/`, which `--merge-reports` reads as blob files only.
 * Writes nothing else and never fails the run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Reporter, TestModule, Vitest } from "vitest/node";

export default class ShardDurationsReporter implements Reporter {
  private ctx: Vitest | undefined;

  onInit(ctx: Vitest): void {
    this.ctx = ctx;
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const root = ctx.config.root;
    const out: Record<string, number> = {};
    for (const module of testModules) {
      const d = module.diagnostic();
      const cost =
        d.environmentSetupDuration +
        d.prepareDuration +
        d.setupDuration +
        d.collectDuration +
        d.duration;
      out[relative(root, module.moduleId).split("\\").join("/")] = Math.round(cost);
    }
    const shard = ctx.config.shard;
    const dir = join(root, ".vitest-durations");
    try {
      mkdirSync(dir, { recursive: true });
      const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
      writeFileSync(
        join(dir, shard ? `durations-${shard.index}.json` : "durations.json"),
        `${JSON.stringify(sorted, null, 2)}\n`,
      );
    } catch (err) {
      console.warn(`[shard-durations] could not write the durations file: ${String(err)}`);
    }
  }
}
