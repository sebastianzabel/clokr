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
 *   - its database name is EXACTLY `clokr_test` (test-database.ts's `TEST_DATABASE_NAME`),
 *   - the URL carries no `schema` query parameter (the retired Prisma-only isolation mechanism, D-01),
 *   - and `NODE_ENV` is not `"production"`.
 * This refusal is what makes it safe to ship inside the runtime image — apps/api/Dockerfile copies
 * the whole `apps/api/` directory (see `:34`/`:81`), so this script IS present there.
 *
 * On an accepted target: connects to the *maintenance* database (same URL, pathname swapped to
 * `/postgres`), creates `clokr_test` only if `pg_database` doesn't already list it (Postgres has no
 * `CREATE DATABASE IF NOT EXISTS` — a create failure is left fatal, never swallowed), then connects
 * to `clokr_test` itself and unconditionally (re-)stamps a `COMMENT ON DATABASE` marker so a re-run
 * repairs a missing comment. It issues NO DROP / TRUNCATE / DELETE under any input, ever.
 *
 * See apps/api/scripts/README.md for the inventory entry (classified: test infrastructure).
 */
import pg from "pg";
import {
  TEST_DATABASE_NAME,
  TEST_DATABASE_MARKER,
  parseDatabaseUrl,
  databaseNameOf,
  describeTarget,
} from "./test-database";

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
  if (dbName !== TEST_DATABASE_NAME) {
    refuse(
      `database name is "${dbName}", not the required "${TEST_DATABASE_NAME}". Refusing to ` +
        `provision or touch any database other than the dedicated test target.`,
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
      TEST_DATABASE_NAME,
    ]);
    if (existing.rowCount === 0) {
      // CREATE DATABASE cannot take a parameterised identifier. TEST_DATABASE_NAME is the fixed
      // module constant "clokr_test" (never user input), so building the statement directly is safe.
      await maintClient.query(`CREATE DATABASE "${TEST_DATABASE_NAME}"`);
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
    // defensively even though the marker text is a fixed constant, never user input.
    const escaped = comment.replace(/'/g, "''");
    await testClient.query(`COMMENT ON DATABASE "${TEST_DATABASE_NAME}" IS '${escaped}'`);
  } finally {
    await testClient.end();
  }

  console.log(
    `ensure-test-database: ${target} — ${created ? "created" : "already present"} (marker stamped).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("ensure-test-database: FATAL —", err instanceof Error ? err.message : err);
  process.exit(1);
});
