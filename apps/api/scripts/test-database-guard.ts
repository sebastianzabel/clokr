/**
 * TI-03 — the loud startup guard (Phase 101, plan 02; namespace-aware since Phase 106, plan 02).
 *
 * Fixing the connection (D-01/D-02) was nearly a one-liner. The defect that cost months was that a
 * misconfigured target produced NO SIGNAL AT ALL. This module is the fix for that: two composable,
 * fail-closed functions that ABORT (throw) rather than warn when the suite is about to run against
 * anything other than a database `ensure-test-database.ts` (or its per-worker clone) provisioned.
 *
 * Layer 1 — `assertTestDatabaseUrlShape`: pure, no I/O, checks NAMESPACE membership (rejects the
 * cheap, common misconfigurations instantly: unset var, wrong protocol, a database name outside
 * `clokr_test`/`clokr_test_<n>`, the retired `?schema=` parameter). It now lives in
 * `../src/utils/test-database` (re-exported below) so that it stays importable without pulling in
 * `pg` — see that module's header for why.
 *
 * Layer 2 — `assertTestDatabaseMarker`: opens exactly one connection and requires POSSESSION of the
 * `COMMENT ON DATABASE` marker `ensure-test-database.ts` stamps, in addition to namespace
 * membership. A name check alone can be satisfied by any database someone happens to name
 * identically, on any Postgres instance; this layer cannot — it is the mechanism, not a name
 * convention, that makes the guard un-fakeable. Widening Layer 1 from one exact name to a namespace
 * does not weaken this: the marker is a `COMMENT ON DATABASE` stored in `pg_shdescription`, keyed to
 * the database OID; a `TEMPLATE` copy does NOT inherit it (verified), so every worker database must
 * be stamped individually and possession remains per-database proof, not inherited decoration.
 * Callers that know precisely which database they expect (e.g. a per-worker globalSetup verifying
 * exactly `clokr_test_3`) may additionally pass `expectedName` to demand that exact name.
 *
 * Neither function returns a boolean, logs a warning, or accepts an opt-out flag or environment
 * variable. Both throw. A connection error is a REJECTION, never swallowed into a pass. This is
 * deliberate: there is no way to proceed past either check short of pointing at a database this
 * project's own tooling actually provisioned.
 *
 * Imports every constant/predicate from `../src/utils/test-database` — never redeclares the target
 * database namespace or the marker string. This file lives under `apps/api/scripts/`, not
 * `apps/api/src/`, so it can import inward from `src/` freely (see that module's own header comment
 * for why the reverse direction cannot happen, and `apps/api/scripts/README.md`'s "Test
 * infrastructure" section).
 */
import pg from "pg";
import {
  TEST_DATABASE_NAME,
  TEST_DATABASE_MARKER,
  isTestDatabaseName,
  assertTestDatabaseUrlShape,
  describeTarget,
} from "../src/utils/test-database";

// Layer 1 lives in src/utils/test-database.ts (Phase 106): it is pure and must be importable
// without dragging `pg` into every test file's setupFiles evaluation. Re-exported here so the
// two-layer story stays discoverable from the guard, and so existing imports keep working.
export { assertTestDatabaseUrlShape } from "../src/utils/test-database";

/**
 * Possession check — opens exactly one connection and requires the target to be in the test
 * namespace (`clokr_test` or `clokr_test_<n>`; exactly `expectedName` if one is given) AND carry a
 * database-level comment starting with `TEST_DATABASE_MARKER`. That comment is written once, by
 * `ensure-test-database.ts`, as `COMMENT ON DATABASE`; `prisma db push`/`migrate deploy` reconcile
 * objects inside a schema and never touch `pg_shdescription`, so the marker's presence proves this
 * exact provisioning script ran against this exact database — a name match alone cannot be forged
 * by any other database that merely happens to share the same name.
 *
 * Closes its connection on every path (success, mismatch, or connection failure) via `finally`. A
 * connection error is treated as a rejection, not swallowed — the guard fails closed, never open.
 */
export async function assertTestDatabaseMarker(raw: string, expectedName?: string): Promise<void> {
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
  const nameOk =
    currentDb !== null &&
    isTestDatabaseName(currentDb) &&
    (expectedName === undefined || currentDb === expectedName);
  if (!nameOk || !markerOk) {
    throw new Error(
      `Refusing to run against an unverified database — this is not the database this project's ` +
        `own tooling provisioned.\n` +
        `  expected:        ${expectedName ?? `a database in the ${TEST_DATABASE_NAME}[_<n>] namespace`} ` +
        `carrying the "${TEST_DATABASE_MARKER}" marker\n` +
        `  target:          ${target}\n` +
        `  actual database: ${currentDb ?? "<unknown>"}\n` +
        `  actual marker:   ${marker ?? "<none>"}\n` +
        `  remedy:          ${remedy}`,
    );
  }
}
