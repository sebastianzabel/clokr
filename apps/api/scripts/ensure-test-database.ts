/**
 * Idempotent provisioning for the isolated integration-test database (`clokr_test`) — Phase 101,
 * Task 1 (TI-02).
 *
 * Invoked via `pnpm --filter @clokr/api run test:setup`, which sources `.env.test` FIRST (this
 * script deliberately does NOT load dotenv itself — it only reads `process.env.TEST_DATABASE_URL`,
 * whatever already put it there).
 *
 * REFUSES, with a non-zero exit and BEFORE opening any connection, unless:
 *   - `TEST_DATABASE_URL` parses as a valid postgres:// URL,
 *   - its database name is IN THE TEST NAMESPACE (test-database.ts's `TEST_DATABASE_NAME_PATTERN`
 *     — the template `clokr_test` or a worker database `clokr_test_<n>`, Phase 106 D-06),
 *   - the URL carries no `schema` query parameter (the retired Prisma-only isolation mechanism, D-01),
 *   - and `NODE_ENV` is not `"production"`.
 * This refusal is what makes it safe to ship inside the runtime image — apps/api/Dockerfile copies
 * the whole `apps/api/` directory (see `:34`/`:81`), so this script IS present there.
 *
 * Phase 106: this script now owns provisioning the template only (`clokr_test`) — but it accepts
 * (and provisions) whatever namespace database it is pointed at, since `reset-test-databases.ts`'s
 * clone phase (D-08) reuses the identical stamp-a-marker mechanism against each freshly-cloned
 * worker database rather than restating it. Dropping and cloning the per-worker databases lives
 * exclusively in `reset-test-databases.ts` (D-08) — never here.
 *
 * On an accepted target: connects to the *maintenance* database (same URL, pathname swapped to
 * `/postgres`), creates the target database only if `pg_database` doesn't already list it (Postgres
 * has no `CREATE DATABASE IF NOT EXISTS` — a create failure is left fatal, never swallowed), then
 * connects to the target itself and unconditionally (re-)stamps a `COMMENT ON DATABASE` marker so a
 * re-run repairs a missing comment. It issues NO DROP / TRUNCATE / DELETE under any input, ever.
 *
 * See apps/api/scripts/README.md for the inventory entry (classified: test infrastructure).
 *
 * test-database.ts lives under `src/utils/`, not alongside this file, because `apps/api/tsconfig.json`
 * pins `rootDir` to `./src` — a file under `src/` (e.g. the TI-01 proof test) cannot import a sibling
 * outside that root (TS6059), while a `scripts/` file (never part of the tsc-compiled program — its
 * `include` covers only `src`) can freely import inward either way. Keeping ONE canonical copy
 * inside `src/` and importing it from both directions was the only option that avoids restating
 * the constants.
 */
import pg from "pg";
import {
  TEST_DATABASE_NAME,
  TEST_DATABASE_MARKER,
  isTestDatabaseName,
  parseDatabaseUrl,
  databaseNameOf,
  describeTarget,
} from "../src/utils/test-database";

function refuse(reason: string, target: string): never {
  console.error(`ensure-test-database: REFUSED — ${reason}`);
  console.error(`  target: ${target}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const raw = process.env.TEST_DATABASE_URL;

  let url: URL;
  try {
    url = parseDatabaseUrl(raw, "TEST_DATABASE_URL");
  } catch (err) {
    console.error(`ensure-test-database: REFUSED — ${(err as Error).message}`);
    process.exit(1);
  }

  const target = describeTarget(url.toString());
  const dbName = databaseNameOf(url);

  // ── Refusal gate — every branch below exits before ANY connection is opened ──────────
  if (process.env.NODE_ENV === "production") {
    refuse('NODE_ENV is "production" — this script must never run against production.', target);
  }
  if (!isTestDatabaseName(dbName)) {
    refuse(
      `database name is "${dbName}", which is outside the test namespace ` +
        `("${TEST_DATABASE_NAME}" — the template — or "${TEST_DATABASE_NAME}_<n>"). Refusing to ` +
        `provision or touch any database other than a dedicated test target.`,
      target,
    );
  }
  if (url.searchParams.has("schema")) {
    refuse(
      `URL carries a "schema" query parameter ("${url.searchParams.get("schema")}") — that is ` +
        `the retired Prisma-only isolation mechanism (D-01). Remove ?schema= from TEST_DATABASE_URL.`,
      target,
    );
  }

  // ── Maintenance connection: same URL, pathname swapped to /postgres ──────────────────
  const maintenanceUrl = new URL(url.toString());
  maintenanceUrl.pathname = "/postgres";

  let created = false;
  const maintClient = new pg.Client({ connectionString: maintenanceUrl.toString() });
  try {
    await maintClient.connect();
    const existing = await maintClient.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      dbName,
    ]);
    if (existing.rowCount === 0) {
      // CREATE DATABASE cannot take a parameterised identifier. dbName has already passed the
      // anchored namespace pattern (isTestDatabaseName above), so it can contain only
      // "clokr_test" optionally followed by "_" and digits — no quoting hazard, and never user
      // input in the sense of an arbitrary string.
      await maintClient.query(`CREATE DATABASE "${dbName}"`);
      created = true;
    }
  } finally {
    await maintClient.end();
  }

  // ── Stamp the marker unconditionally — repairs a missing comment on re-run ───────────
  const testClient = new pg.Client({ connectionString: url.toString() });
  try {
    await testClient.connect();
    const comment =
      `${TEST_DATABASE_MARKER} — provisioned by apps/api/scripts/ensure-test-database.ts ` +
      `(Phase 101). Contents are disposable.`;
    // COMMENT ON DATABASE cannot take a parameterised literal either; escape single quotes
    // defensively even though the marker text is a fixed constant, never user input. dbName is
    // interpolated for the same reason as the CREATE DATABASE statement above.
    const escaped = comment.replace(/'/g, "''");
    await testClient.query(`COMMENT ON DATABASE "${dbName}" IS '${escaped}'`);
  } finally {
    await testClient.end();
  }

  // console.error, not console.log, per this repo's ESLint config (console.log warns) and the
  // convention already used by sibling scripts (e.g. audit-saldo-chain-integrity.ts) for CLI output.
  console.error(
    `ensure-test-database: ${target} — ${created ? "created" : "already present"} (marker stamped).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("ensure-test-database: FATAL —", err instanceof Error ? err.message : err);
  process.exit(1);
});
