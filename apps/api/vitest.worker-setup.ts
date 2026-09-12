/**
 * TI-03 — per-worker propagation check AND the VITEST_POOL_ID -> database mapping
 * (Phase 101 plan 02; rewritten Phase 106 plan 04 for per-worker database isolation;
 * namespace-aware Phase 132 plan 03).
 *
 * globalSetup (vitest.setup.ts) verifies the TEMPLATE and every one of the N per-worker databases
 * exactly ONCE, in the parent process, before any worker is spawned — but it deliberately assigns no
 * `DATABASE_URL`. This file is the second, narrower layer: registered as a `setupFiles` entry, it
 * runs inside EVERY worker, once per test file, and does two things:
 *
 *   1. Propagation check — proves the verified TEST_DATABASE_URL from globalSetup actually reached
 *      this worker's `process.env` and still names the resolved template.
 *   2. The mapping — resolves this worker's own database from `VITEST_POOL_ID` and is the SOLE
 *      place in the whole test harness that assigns `process.env.DATABASE_URL`. An unset or
 *      out-of-range pool id is a hard error, never a fallback to worker 1 or to the template.
 *
 * It is deliberately kept pure: no database connection, no async work, no `pg` import. globalSetup
 * already did the expensive, authoritative possession check for every database; re-opening a
 * connection here per test file would be redundant and slow. If any of the checks below does not
 * hold, the app would boot against something unverified — in CI that "something" is DATABASE_URL's
 * job-level value, the dev-shaped reference database (see .github/workflows/ci.yml). Refusing to run
 * this test file is always the correct outcome; there is no safe fallback value.
 *
 * Phase 132: the namespace arrives through the same `process.env` inheritance path
 * `TEST_DATABASE_URL` already travels — globalSetup (vitest.setup.ts) derives it exactly once, in
 * the parent process, and every worker forked from that process inherits it. It is NEVER derived
 * here: the call below is a plain environment read (the override branch), not a `git` spawn,
 * because `CLOKR_TEST_NAMESPACE` is already set by the time this file is imported. The two
 * comparisons in steps 1 and 4 are against the RESOLVED name — comparing against the bare template
 * constant would abort every run inside a linked worktree with a message that reads like an
 * unrelated misconfiguration, not a namespace bug.
 */
import {
  TEST_DATABASE_WORKER_COUNT,
  assertTestDatabaseUrlShape,
  databaseNameOf,
  describeTarget,
  isWorkerDatabaseName,
  resolveTestNamespace,
  templateDatabaseName,
  workerDatabaseName,
} from "./src/utils/test-database";

// globalSetup (vitest.setup.ts) already derived this and wrote it into process.env, which this
// forked worker inherited — so this call is a plain environment read, not a `git` spawn. That
// matters: this file is a `setupFiles` entry, re-imported once per test FILE under
// `isolate: true`, so anything expensive at module scope here is paid ~200 times per run.
const namespace = resolveTestNamespace();
const templateName = templateDatabaseName(namespace);

// 1. The verified template URL must have propagated from globalSetup.
const templateUrl = assertTestDatabaseUrlShape(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL");
if (databaseNameOf(templateUrl) !== templateName) {
  throw new Error(
    `TI-03 propagation check failed: TEST_DATABASE_URL names ` +
      `"${databaseNameOf(templateUrl)}", not the template "${templateName}" for this working ` +
      `directory (namespace ${namespace === "" ? "<main working tree>" : `"${namespace}"`} — set ` +
      `CLOKR_TEST_NAMESPACE to override). ` +
      `Target: ${describeTarget(process.env.TEST_DATABASE_URL ?? "")}.`,
  );
}

// 2. This worker's slot.
const poolId = process.env.VITEST_POOL_ID;
const workerIndex = Number(poolId);
if (
  !poolId ||
  !Number.isInteger(workerIndex) ||
  workerIndex < 1 ||
  workerIndex > TEST_DATABASE_WORKER_COUNT
) {
  throw new Error(
    `VITEST_POOL_ID is "${poolId ?? "<unset>"}" — expected an integer in 1..${TEST_DATABASE_WORKER_COUNT} ` +
      `(the pinned worker count, apps/api/src/utils/test-database.ts). Refusing to run this test ` +
      `file rather than guess which isolated database it owns. If you changed ` +
      `TEST_DATABASE_WORKER_COUNT, re-run: pnpm --filter @clokr/api run test:setup.`,
  );
}

// 3. Point this worker at its own database. This is the ONE place DATABASE_URL is assigned.
const expectedName = workerDatabaseName(workerIndex, namespace);
const workerUrl = new URL(templateUrl.toString());
workerUrl.pathname = `/${expectedName}`;
process.env.DATABASE_URL = workerUrl.toString();

// 4. Fail closed. If any of these does not hold, the app would boot against something unverified —
// in CI that "something" is DATABASE_URL's job-level value, the dev-shaped reference database.
const assigned = assertTestDatabaseUrlShape(process.env.DATABASE_URL, "DATABASE_URL");
const assignedName = databaseNameOf(assigned);
if (assignedName !== expectedName) {
  throw new Error(`Worker ${workerIndex} resolved "${assignedName}", expected "${expectedName}".`);
}
if (!isWorkerDatabaseName(assignedName)) {
  throw new Error(
    `Worker ${workerIndex} would connect to "${assignedName}", which is not a per-worker database. ` +
      `A worker must never connect to the template "${templateName}": writing into it would ` +
      `poison every subsequent clone and block the next run's CREATE DATABASE ... TEMPLATE.`,
  );
}
