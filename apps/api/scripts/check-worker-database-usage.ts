/**
 * Run-level proof that every one of the N per-worker test databases was actually used
 * (Phase 106, plan 04 — R2).
 *
 * `worker-database-isolation.test.ts` proves per-worker isolation from INSIDE the suite, but one
 * test file runs inside exactly one worker — it cannot prove all N workers actually ran. This
 * script is the complementary, run-level check: after a full `pnpm test`, it connects through the
 * maintenance database and reads Postgres's OWN write counters (`pg_stat_database`) for every
 * `WORKER_DATABASE_NAMES` entry.
 *
 * `tup_inserted` — not a row count of any application table — is the signal on purpose. Suites call
 * `cleanupTestData` in `afterAll`, so a table row count can legitimately be zero after a fully green
 * run while `tup_inserted` cannot: Postgres counts every row insert regardless of whether it was
 * later deleted in the same session. Exits non-zero if any worker database is missing entirely, or
 * shows zero inserts (either signals fewer than N workers ran, or the VITEST_POOL_ID -> database
 * mapping is broken). Exits 0 with a one-line summary per database otherwise.
 *
 * Deliberately non-vacuous: run this against a freshly-cloned `test:setup` (no test run yet) and it
 * MUST fail, naming every worker database — see the acceptance criteria in
 * .planning/phases/106-.../106-04-PLAN.md Task 3 and this script's own header comment.
 */
import pg from "pg";
import {
  WORKER_DATABASE_NAMES,
  parseDatabaseUrl,
  describeTarget,
} from "../src/utils/test-database";

function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

interface StatRow {
  datname: string;
  tup_inserted: string;
  xact_commit: string;
}

async function main(): Promise<void> {
  const raw = process.env.TEST_DATABASE_URL;

  let url: URL;
  try {
    url = parseDatabaseUrl(raw, "TEST_DATABASE_URL");
  } catch (err) {
    fatal(`check-worker-database-usage: REFUSED — ${(err as Error).message}`);
  }

  const target = describeTarget(url.toString());

  const maintenanceUrl = new URL(url.toString());
  maintenanceUrl.pathname = "/postgres";
  const client = new pg.Client({ connectionString: maintenanceUrl.toString() });
  await client.connect();

  let rows: StatRow[];
  try {
    const result = await client.query<StatRow>(
      "SELECT datname, tup_inserted, xact_commit FROM pg_stat_database WHERE datname = ANY($1)",
      [WORKER_DATABASE_NAMES],
    );
    rows = result.rows;
  } finally {
    await client.end();
  }

  const byName = new Map(rows.map((r) => [r.datname, r]));

  const unused: string[] = [];
  const missing: string[] = [];
  const lines: string[] = [];

  for (const name of WORKER_DATABASE_NAMES) {
    const row = byName.get(name);
    if (!row) {
      missing.push(name);
      continue;
    }
    const tupInserted = Number(row.tup_inserted);
    if (tupInserted === 0) {
      unused.push(name);
      continue;
    }
    lines.push(`  ${name}: tup_inserted=${tupInserted} xact_commit=${row.xact_commit} — USED`);
  }

  if (missing.length > 0 || unused.length > 0) {
    for (const name of missing) {
      console.error(
        `check-worker-database-usage: "${name}" is missing entirely — it does not appear in ` +
          `pg_stat_database. Either fewer than TEST_DATABASE_WORKER_COUNT workers ran, or ` +
          `TEST_DATABASE_WORKER_COUNT was changed without re-running test:setup (target: ${target}).`,
      );
    }
    for (const name of unused) {
      console.error(
        `check-worker-database-usage: "${name}" received no writes during the run. Either fewer ` +
          `than TEST_DATABASE_WORKER_COUNT workers ran, or the VITEST_POOL_ID -> database mapping ` +
          `is broken (R2). Target: ${target}.`,
      );
    }
    process.exit(1);
  }

  console.log(
    `check-worker-database-usage: all ${WORKER_DATABASE_NAMES.length} worker databases were used.`,
  );
  for (const line of lines) {
    console.log(line);
  }
}

main().catch((err) => {
  console.error(`check-worker-database-usage: FATAL — ${(err as Error).message}`);
  process.exit(1);
});
