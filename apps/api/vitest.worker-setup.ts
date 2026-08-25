/**
 * TI-03 — per-worker propagation check (Phase 101, plan 02).
 *
 * globalSetup (vitest.setup.ts) verifies the target exactly ONCE, in the parent process, via
 * `assertTestDatabaseMarker` — a real connection plus a possession check — and aborts the ENTIRE run
 * before any worker is spawned if that fails. This file is the second, narrower layer: registered as
 * a `setupFiles` entry, it runs inside EVERY worker, once per test file, and proves the verified
 * value from globalSetup actually REACHED this worker's `process.env`.
 *
 * It is a propagation check, not an authorisation control, and is deliberately kept pure: no
 * database connection, no async work. globalSetup already did the expensive, authoritative check;
 * re-opening a connection here per test file would be redundant and slow. Instead this file
 * re-asserts the cheap shape check plus the `DATABASE_URL === TEST_DATABASE_URL` equality that
 * globalSetup itself establishes — if that equality doesn't hold inside a worker, the verified value
 * never arrived, and this throws rather than letting the file silently connect to whatever
 * `DATABASE_URL` happens to hold.
 */
import { assertTestDatabaseUrlShape } from "./scripts/test-database-guard";

assertTestDatabaseUrlShape(process.env.DATABASE_URL, "DATABASE_URL");

if (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL) {
  throw new Error(
    "TI-03 propagation check failed: process.env.DATABASE_URL does not equal " +
      "process.env.TEST_DATABASE_URL inside this worker. globalSetup verified the target in the " +
      "parent process, but that verified value did not reach this worker's environment — refusing " +
      "to run this test file rather than connect to an unverified target.",
  );
}
