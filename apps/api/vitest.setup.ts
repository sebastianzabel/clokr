import { config } from "dotenv";
import { resolve } from "path";
import { assertTestDatabaseMarker } from "./scripts/test-database-guard";

/**
 * globalSetup (Phase 101 plan 02, TI-03) — runs ONCE, in the parent process, before any test
 * worker is spawned. Loads apps/api/.env.test, then requires TEST_DATABASE_URL's target to be the
 * SEPARATE `clokr_test` database this project's own tooling provisioned (D-01) — verified by
 * POSSESSION of the marker `ensure-test-database.ts` stamps, not merely by name (see
 * scripts/test-database-guard.ts). A throw here aborts the ENTIRE run before a single test file
 * loads: no partial run, no silent connection to whatever DATABASE_URL happened to resolve to. Only
 * once that is proven does DATABASE_URL get set to TEST_DATABASE_URL, so the Fastify app under test
 * connects to the verified target and nothing else. Do not catch, warn, or continue on failure.
 */
export async function setup(): Promise<void> {
  // override: false — the shell / CI's own environment is authoritative; .env.test is the LOCAL
  // FALLBACK for keys not already set. This makes .github/workflows/ci.yml's TEST_DATABASE_URL live
  // configuration (previously always discarded by override: true), and makes a stale
  // TEST_DATABASE_URL=... prefix on a local command actually take effect — caught loudly by the
  // guard below instead of being silently discarded the way override: true discarded it before.
  config({ path: resolve(__dirname, ".env.test"), override: false });

  await assertTestDatabaseMarker(process.env.TEST_DATABASE_URL ?? "");

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

  if (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL) {
    // Structurally unreachable given the direct assignment immediately above — kept as a
    // fail-closed belt-and-braces check (TI-03): if this file is ever refactored so the assignment
    // moves, this still catches the drift instead of silently proceeding.
    throw new Error(
      "TI-03: DATABASE_URL does not equal the verified TEST_DATABASE_URL after assignment — refusing to run.",
    );
  }
}
