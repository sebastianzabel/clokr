import { config } from "dotenv";
import { resolve } from "path";
import { assertTestDatabaseMarker } from "./scripts/test-database-guard";
import {
  TEST_DATABASE_NAME,
  WORKER_DATABASE_NAMES,
  parseDatabaseUrl,
} from "./src/utils/test-database";

/**
 * globalSetup (Phase 101 plan 02, TI-03; widened Phase 106 plan 04) — runs ONCE, in the parent
 * process, before any test worker is spawned. Loads apps/api/.env.test, then requires
 * TEST_DATABASE_URL's target to be the SEPARATE `clokr_test` TEMPLATE database this project's own
 * tooling provisioned (D-01), and requires every one of the N per-worker databases
 * (`clokr_test_1` … `clokr_test_<n>`) to exist and carry the marker too — each verified by
 * POSSESSION of the marker `ensure-test-database.ts`/`reset-test-databases.ts` stamp, not merely by
 * name (see scripts/test-database-guard.ts). A throw here aborts the ENTIRE run before a single test
 * file loads: no partial run, no silent connection to whatever DATABASE_URL happened to resolve to.
 * Do not catch, warn, or continue on failure.
 */
export async function setup(): Promise<void> {
  // override: false — the shell / CI's own environment is authoritative; .env.test is the LOCAL
  // FALLBACK for keys not already set. This makes .github/workflows/ci.yml's TEST_DATABASE_URL live
  // configuration (previously always discarded by override: true), and makes a stale
  // TEST_DATABASE_URL=... prefix on a local command actually take effect — caught loudly by the
  // guard below instead of being silently discarded the way override: true discarded it before.
  config({ path: resolve(__dirname, ".env.test"), override: false });

  // Phase 104-07: mirror TEST_DATABASE_URL's own "host-exposed docker port" pattern for MinIO.
  // apps/api/src/plugins/storage.ts falls back to the docker-network hostname "minio" when
  // MINIO_ENDPOINT is unset — correct for the api container, unreachable from a vitest run on the
  // host. docker-compose.yml exposes MinIO on localhost:9000, same as postgres on localhost:5432.
  // Only a default (no override of an already-set value), so CI or a real .env.test entry wins.
  process.env.MINIO_ENDPOINT ??= "localhost";

  // Template first: it is what `prisma migrate deploy` ran against and what every worker database
  // was cloned from. Verified by POSSESSION of the marker, exactly as in Phase 101.
  await assertTestDatabaseMarker(process.env.TEST_DATABASE_URL ?? "", TEST_DATABASE_NAME);

  // Then every worker database, by EXACT name. A missing or unmarked one aborts the whole run here,
  // in the parent process, before a single worker is spawned — rather than surfacing later as one
  // confusing red file. `test:setup` provisions these (D-02: pre-provisioned, never created by a
  // worker), so a failure here means setup did not run or did not finish.
  const templateUrl = parseDatabaseUrl(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL");
  for (const name of WORKER_DATABASE_NAMES) {
    const workerUrl = new URL(templateUrl.toString());
    workerUrl.pathname = `/${name}`;
    await assertTestDatabaseMarker(workerUrl.toString(), name);
  }

  // DATABASE_URL is deliberately NOT assigned here (Phase 106). Assigning the TEMPLATE here would
  // mean that a worker whose setupFiles failed to run would silently write into the template —
  // poisoning every subsequent clone and breaking the next run's `CREATE DATABASE ... TEMPLATE`
  // (which requires zero connections on the source). vitest.worker-setup.ts is the SINGLE owner of
  // this assignment and throws if it cannot make it. Nothing here may set a fallback.
}
