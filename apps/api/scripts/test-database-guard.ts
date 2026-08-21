/**
 * TI-03 — the loud startup guard (Phase 101, plan 02).
 *
 * Fixing the connection (D-01/D-02) was nearly a one-liner. The defect that cost months was that a
 * misconfigured target produced NO SIGNAL AT ALL. This module is the fix for that: two composable,
 * fail-closed functions that ABORT (throw) rather than warn when the suite is about to run against
 * anything other than the database `ensure-test-database.ts` provisioned.
 *
 * Layer 1 — `assertTestDatabaseUrlShape`: pure, no I/O. Rejects the cheap, common misconfigurations
 * instantly (unset var, wrong protocol, wrong database name, the retired `?schema=` parameter)
 * without ever opening a connection.
 *
 * Layer 2 — `assertTestDatabaseMarker`: opens exactly one connection and requires POSSESSION of the
 * `COMMENT ON DATABASE` marker `ensure-test-database.ts` stamps. A name check alone can be satisfied
 * by any database someone happens to call `clokr_test` on any Postgres instance; this layer cannot —
 * it is the mechanism, not a name convention, that makes the guard un-fakeable.
 *
 * Neither function returns a boolean, logs a warning, or accepts an opt-out flag or environment
 * variable. Both throw. A connection error is a REJECTION, never swallowed into a pass. This is
 * deliberate: there is no way to proceed past either check short of pointing at a database this
 * project's own tooling actually provisioned.
 *
 * Imports every constant from `../src/utils/test-database` — never redeclares `clokr_test` or the
 * marker string. This file lives under `apps/api/scripts/`, not `apps/api/src/`, so it can import
 * inward from `src/` freely (see that module's own header comment for why the reverse direction
 * cannot happen, and `apps/api/scripts/README.md`'s "Test infrastructure" section).
 */
import pg from "pg";
import {
  TEST_DATABASE_NAME,
  TEST_DATABASE_MARKER,
  parseDatabaseUrl,
  databaseNameOf,
  describeTarget,
} from "../src/utils/test-database";

/**
 * Pure shape assertion — no network I/O. Throws for: an unset/empty/whitespace-only value, a
 * non-URL string, a non-`postgres(ql):` protocol, a database name that is not exactly
 * `TEST_DATABASE_NAME`, or a URL carrying a `schema` query parameter (the retired Prisma-only
 * isolation mechanism `pg` silently ignores — D-01). Returns the parsed `URL` only when every check
 * passes. Every thrown message names `source` and includes `describeTarget(raw)` (credential-free);
 * none of them can contain a password, because `describeTarget` never emits one.
 */
export function assertTestDatabaseUrlShape(raw: string | undefined, source: string): URL {
  let url: URL;
  try {
    url = parseDatabaseUrl(raw, source);
  } catch (err) {
    // parseDatabaseUrl already covers "unset/empty/whitespace", "not a valid URL", and "wrong
    // protocol" with a source-labelled message. Re-wrap so describeTarget(raw) is present on
    // EVERY rejection this function throws, not just the two it adds below.
    const target = describeTarget(raw ?? "");
    throw new Error(`${(err as Error).message} Target: ${target}.`, { cause: err });
  }

  const target = describeTarget(raw as string);
  const dbName = databaseNameOf(url);

  if (dbName !== TEST_DATABASE_NAME) {
    throw new Error(
      `${source} must point at the "${TEST_DATABASE_NAME}" database — got "${dbName}". ` +
        `Refusing to run against any database other than the one this project's own tooling ` +
        `provisioned. Target: ${target}. Remedy: pnpm --filter @clokr/api run test:setup, then ` +
        `point ${source} at "${TEST_DATABASE_NAME}".`,
    );
  }

  if (url.searchParams.has("schema")) {
    throw new Error(
      `${source} carries a "schema" query parameter ("${url.searchParams.get("schema")}"). ` +
        `"?schema=" is a Prisma-only connection-string convention — the "pg" driver this app ` +
        `actually connects with silently ignores it. That silent ignore is the exact ` +
        `misconfiguration Phase 101 removed (D-01): every test run was landing in the dev database ` +
        `while ?schema=test was believed to isolate it. The fix is a SEPARATE DATABASE, not a ` +
        `schema parameter — remove "?schema=" from ${source}. Target: ${target}.`,
    );
  }

  return url;
}

/**
 * Possession check — opens exactly one connection and requires the target to be `TEST_DATABASE_NAME`
 * AND carry a database-level comment starting with `TEST_DATABASE_MARKER`. That comment is written
 * once, by `ensure-test-database.ts`, as `COMMENT ON DATABASE`; `prisma db push`/`migrate deploy`
 * reconcile objects inside a schema and never touch `pg_shdescription`, so the marker's presence
 * proves this exact provisioning script ran against this exact database — a name match alone cannot
 * be forged by any other database that merely happens to be called `clokr_test`.
 *
 * Closes its connection on every path (success, mismatch, or connection failure) via `finally`. A
 * connection error is treated as a rejection, not swallowed — the guard fails closed, never open.
 */
export async function assertTestDatabaseMarker(raw: string): Promise<void> {
  // Layer 1 first — cheap, no network. If the shape is already wrong there is no point opening a
  // connection at all, and the shape-check message is more specific for that case anyway.
  const url = assertTestDatabaseUrlShape(raw, "TEST_DATABASE_URL");
  const target = describeTarget(raw);

  const client = new pg.Client({ connectionString: url.toString() });
  let connectError: Error | null = null;
  let currentDb: string | null = null;
  let marker: string | null = null;

  try {
    await client.connect();
    const result = await client.query<{ current_database: string; marker: string | null }>(
      `SELECT current_database() AS current_database, shobj_description(
         (SELECT oid FROM pg_database WHERE datname = current_database()), 'pg_database'
       ) AS marker`,
    );
    currentDb = result.rows[0]?.current_database ?? null;
    marker = result.rows[0]?.marker ?? null;
  } catch (err) {
    connectError = err as Error;
  } finally {
    try {
      await client.end();
    } catch {
      // The connection is already being torn down or never opened — a close-time error here is
      // not the story we need to report; the connectError / mismatch branches above already
      // capture the real failure.
    }
  }

  const remedy = "pnpm --filter @clokr/api run test:setup";

  if (connectError) {
    throw new Error(
      `Refusing to run — could not verify the test-database marker.\n` +
        `  expected: a reachable "${TEST_DATABASE_NAME}" database carrying the ` +
        `"${TEST_DATABASE_MARKER}" marker\n` +
        `  target:   ${target}\n` +
        `  error:    ${connectError.message}\n` +
        `  remedy:   ${remedy}`,
      { cause: connectError },
    );
  }

  const markerOk = marker !== null && marker.startsWith(TEST_DATABASE_MARKER);
  if (currentDb !== TEST_DATABASE_NAME || !markerOk) {
    throw new Error(
      `Refusing to run against an unverified database — this is not the database this project's ` +
        `own tooling provisioned.\n` +
        `  expected:        "${TEST_DATABASE_NAME}" carrying the "${TEST_DATABASE_MARKER}" marker\n` +
        `  target:          ${target}\n` +
        `  actual database: ${currentDb ?? "<unknown>"}\n` +
        `  actual marker:   ${marker ?? "<none>"}\n` +
        `  remedy:          ${remedy}`,
    );
  }
}
