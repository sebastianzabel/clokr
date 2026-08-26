/**
 * R2 per-worker proof (Phase 106, plan 04).
 *
 * `test-isolation.test.ts` (TI-01, Phase 101) proves the app never writes into the DEV database.
 * This file proves the complementary, Phase-106-specific claim: the booted app is on THIS worker's
 * OWN database — `clokr_test_<VITEST_POOL_ID>` — and nowhere else. One test file runs inside exactly
 * one worker, so this file alone can only prove isolation for the worker it happens to land on;
 * `scripts/check-worker-database-usage.ts` is the run-level complement that proves all N workers
 * were actually exercised (see that script and .github/workflows/ci.yml).
 *
 * No `skipIf`, no conditional: an unset `VITEST_POOL_ID` must fail this file loudly, not skip it —
 * a skip here would be exactly the silent failure this phase exists to eliminate.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import {
  TEST_DATABASE_NAME,
  TEST_DATABASE_MARKER,
  workerDatabaseName,
  parseDatabaseUrl,
  databaseNameOf,
} from "../utils/test-database";
import type { FastifyInstance } from "fastify";

describe("Per-worker database isolation (Phase 106, R2)", () => {
  let app: FastifyInstance;
  let seeded: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    seeded = await seedTestData(app, "workeriso");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seeded.tenant.id);
    } catch (err) {
      console.error("Cleanup tenant (worker-database-isolation) failed:", err);
    }
    await closeTestApp();
  });

  it("the booted app is on THIS worker's own database, not the template, not the dev database", async () => {
    const poolId = process.env.VITEST_POOL_ID;
    expect(poolId, "VITEST_POOL_ID must be set inside a worker").toBeTruthy();
    const expected = workerDatabaseName(poolId as string);

    const rows = await app.prisma.$queryRaw<
      { current_database: string }[]
    >`SELECT current_database()`;
    const actual = rows[0]?.current_database;

    expect(actual, `worker ${poolId} must be on its OWN database`).toBe(expected);
    expect(actual, "a worker must never run against the template").not.toBe(TEST_DATABASE_NAME);
    expect(actual, "a worker must never run against the dev database").not.toBe(
      databaseNameOf(
        parseDatabaseUrl(
          process.env.ISOLATION_CHECK_DEV_DATABASE_URL,
          "ISOLATION_CHECK_DEV_DATABASE_URL",
        ),
      ),
    );

    const markerRows = await app.prisma.$queryRaw<{ comment: string | null }[]>`
      SELECT shobj_description((SELECT oid FROM pg_database WHERE datname = current_database()), 'pg_database') AS comment`;
    expect(markerRows[0]?.comment?.startsWith(TEST_DATABASE_MARKER)).toBe(true);

    // Non-vacuity: the tenant just seeded through the app must be visible HERE, so the assertions
    // above describe the connection the app actually writes through, not an unrelated one.
    expect(
      await app.prisma.tenant.findUnique({ where: { slug: seeded.tenant.slug } }),
    ).not.toBeNull();
  });
});
