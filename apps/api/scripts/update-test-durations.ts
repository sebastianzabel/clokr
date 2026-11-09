/**
 * Issue #889 — refresh apps/api/test-durations.json from a CI run.
 *
 * Usage: `pnpm --filter @clokr/api run test:durations:update -- <run-id>`
 *
 * Downloads the `api-test-durations` artifact of that CI run (written by the `api-coverage` job
 * from the three shards' measurements) with the GitHub CLI and replaces test-durations.json. The
 * file is a balance hint only: running this is never required for correctness, a stale file just
 * balances the shards a little worse (see scripts/shard-partition.ts).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runId = process.argv.slice(2).find((a) => /^\d+$/.test(a));
if (!runId) {
  console.error("usage: test:durations:update -- <CI run id>");
  process.exit(1);
}
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "test-durations.json");
const dir = mkdtempSync(join(tmpdir(), "clokr-durations-"));
try {
  execFileSync("gh", ["run", "download", runId, "-n", "api-test-durations", "-D", dir], {
    stdio: "inherit",
  });
  const durations = JSON.parse(readFileSync(join(dir, "test-durations.json"), "utf8")) as Record<
    string,
    number
  >;
  const count = Object.keys(durations).length;
  if (count === 0) throw new Error("the artifact holds no durations");
  writeFileSync(target, `${JSON.stringify(durations, null, 2)}\n`);
  console.warn(`[test:durations:update] ${count} file(s) written to test-durations.json`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
