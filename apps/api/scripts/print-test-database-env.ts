/**
 * The bridge between `test-database.ts`'s namespace resolver and `apps/api/package.json`'s
 * `test:setup`, which is a raw POSIX shell one-liner and therefore cannot import TypeScript
 * (Phase 132, "The Seam" in 132-RESEARCH.md).
 *
 * Without this script, the `DATABASE_URL=$TEST_DATABASE_URL prisma migrate deploy` stage of
 * `test:setup` would always receive `.env.test`'s literal, unnamespaced template name and, inside
 * a linked git worktree, migrate the MAIN working tree's template — the exact cross-worktree
 * interference Phase 132 removes.
 *
 * This script must never construct a database name itself: it only calls
 * `resolveTestNamespace`/`namespacedDatabaseUrl`, so D-05's "one canonical place" rule survives
 * the trip through the shell. It opens no database connection and imports no `pg`, which is why
 * it is harmless inside the runtime image (it ships there alongside `ensure-test-database.ts`,
 * but unlike that script it does not even attempt to reach Postgres).
 *
 * Usage: `tsx scripts/print-test-database-env.ts --namespace` or `--url`. Every diagnostic goes
 * to stderr; on success, exactly one line terminated by `\n` is written to stdout and nothing
 * else — this is what makes `VAR="$(tsx scripts/print-test-database-env.ts --namespace)"` a safe
 * POSIX command substitution.
 */
import {
  assertTestDatabaseUrlShape,
  namespacedDatabaseUrl,
  resolveTestNamespace,
} from "../src/utils/test-database";

function fail(message: string): never {
  console.error(`print-test-database-env: ${message}`);
  process.exit(1);
}

function main(): void {
  const mode = process.argv[2];
  if (mode !== "--namespace" && mode !== "--url") {
    fail("usage: tsx scripts/print-test-database-env.ts --namespace | --url");
  }

  let namespace: string;
  try {
    namespace = resolveTestNamespace();
  } catch (err) {
    fail((err as Error).message);
  }

  if (mode === "--namespace") {
    process.stdout.write(`${namespace}\n`);
    process.exit(0);
  }

  let url: URL;
  try {
    // Shape gate FIRST, on the INPUT — refuse a dev-database or ?schema= target before any
    // rewrite. The rewrite can only move a name WITHIN the namespace, so it can never turn a
    // refused target into an accepted one; running it before the gate would only hide the reason.
    url = assertTestDatabaseUrlShape(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL");
  } catch (err) {
    fail((err as Error).message);
  }

  process.stdout.write(`${namespacedDatabaseUrl(url, namespace).toString()}\n`);
  process.exit(0);
}

main();
