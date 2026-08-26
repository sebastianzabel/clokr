/**
 * TI-01 isolation proof (Phase 101, D-01).
 *
 * Writes a tenant through the REAL running application, then proves mechanically that the write
 * landed in the isolated `clokr_test` database and is provably absent from the dev database
 * (addressed here only via the read-only `ISOLATION_CHECK_DEV_DATABASE_URL`, never written to).
 *
 * Every assertion is ordered so a vacuous pass is structurally impossible: if the dev reference
 * target coincides with the test target, is unreachable, or lacks the `Tenant` relation, THIS FILE
 * FAILS — it never skips. A skip is exactly the silent failure this phase exists to eliminate.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import {
  TEST_DATABASE_MARKER,
  parseDatabaseUrl,
  databaseNameOf,
  describeTarget,
  isTestDatabaseName,
} from "../utils/test-database";
import type { FastifyInstance } from "fastify";

describe("Test database isolation (TI-01)", () => {
  let app: FastifyInstance;
  let seeded: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    seeded = await seedTestData(app, "isolation");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seeded.tenant.id);
    } catch (err) {
      console.error("Cleanup tenant (test-isolation) failed:", err);
    }
    await closeTestApp();
  });

  it("proves a tenant written through the app lands in clokr_test and is absent from the dev database", async () => {
    // The sentinel is the tenant slug seedTestData() just created through the real app stack —
    // it already carries a per-run-unique suffix, so no calendar date or hardcoded literal is
    // needed anywhere in this file.
    const sentinelSlug = seeded.tenant.slug;

    const testUrlRaw = process.env.TEST_DATABASE_URL;
    const devUrlRaw = process.env.ISOLATION_CHECK_DEV_DATABASE_URL;

    // (a) Both URLs parse, and resolve to DIFFERENT database names. A same-target reference would
    // make every assertion below vacuous — this MUST fail loudly, never silently pass.
    const testUrl = parseDatabaseUrl(testUrlRaw, "TEST_DATABASE_URL");
    const devUrl = parseDatabaseUrl(devUrlRaw, "ISOLATION_CHECK_DEV_DATABASE_URL");
    const testDbName = databaseNameOf(testUrl);
    const devDbName = databaseNameOf(devUrl);

    expect(
      devDbName,
      `ISOLATION_CHECK_DEV_DATABASE_URL (${describeTarget(testUrlRaw!)} vs ` +
        `${describeTarget(devUrlRaw!)}) must name a DIFFERENT database than TEST_DATABASE_URL — ` +
        `a same-target reference would make this proof vacuous.`,
    ).not.toBe(testDbName);

    // (b) The dev reference target is reachable and has the Tenant relation. Connection failures
    // are intentionally NOT caught here — an uncaught error fails this test loudly rather than
    // skipping it, which is the whole point of this file.
    const devClient = new pg.Client({ connectionString: devUrlRaw });
    try {
      try {
        await devClient.connect();
      } catch (err) {
        throw new Error(
          `Dev reference database (${describeTarget(devUrlRaw!)}) is unreachable — the TI-01 ` +
            `proof cannot run without it. Underlying error: ${(err as Error).message}`,
          { cause: err },
        );
      }

      const relCheck = await devClient.query<{ to_regclass: string | null }>(
        `SELECT to_regclass('public."Tenant"') AS to_regclass`,
      );
      expect(
        relCheck.rows[0]?.to_regclass,
        `Dev reference database (${describeTarget(devUrlRaw!)}) has no public."Tenant" relation — ` +
          `it was never schema-pushed, so this proof cannot be non-vacuous against it.`,
      ).not.toBeNull();

      // (c) The app's OWN connection reports it is talking to a database in the test namespace,
      // and specifically to the one DATABASE_URL names. Under Phase 106 that is a per-worker
      // database (clokr_test_<VITEST_POOL_ID>), not the template — so an exact equality against
      // TEST_DATABASE_NAME would now be wrong. The strength is unchanged: the dev database can
      // never satisfy the namespace predicate, and (e)/(f) below still carry the real proof.
      const currentDbResult = await app.prisma.$queryRaw<
        { current_database: string }[]
      >`SELECT current_database()`;
      const appDbName = currentDbResult[0]?.current_database ?? "";
      const urlDbName = databaseNameOf(parseDatabaseUrl(process.env.DATABASE_URL, "DATABASE_URL"));
      expect(
        isTestDatabaseName(appDbName),
        `app.prisma is connected to "${appDbName}", which is outside the test namespace ` +
          `(expected clokr_test or clokr_test_<n>). Target: ${describeTarget(testUrlRaw!)}.`,
      ).toBe(true);
      expect(
        appDbName,
        `app.prisma is connected to "${appDbName}" but DATABASE_URL names "${urlDbName}".`,
      ).toBe(urlDbName);
      expect(appDbName, "the app must never connect to the dev database").not.toBe(devDbName);
      expect(
        isTestDatabaseName(testDbName),
        "TEST_DATABASE_URL itself must name a database in the test namespace",
      ).toBe(true);

      // (d) The sentinel slug the app just wrote is present in the test database.
      const inTestDb = await app.prisma.tenant.findUnique({ where: { slug: sentinelSlug } });
      expect(
        inTestDb,
        `Sentinel tenant slug "${sentinelSlug}" was not found in the test database ` +
          `(${describeTarget(testUrlRaw!)}) immediately after seedTestData() created it through ` +
          `the running app.`,
      ).not.toBeNull();

      // (e) THE actual proof: the same slug returns ZERO rows from the dev reference database.
      // Strictly read-only against ISOLATION_CHECK_DEV_DATABASE_URL — one parameterised SELECT,
      // nothing else, ever.
      const devCount = await devClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public."Tenant" WHERE slug = $1`,
        [sentinelSlug],
      );
      expect(
        Number(devCount.rows[0]?.count),
        `Sentinel tenant slug "${sentinelSlug}" WAS found in the dev database ` +
          `(${describeTarget(devUrlRaw!)}) — the app's write leaked out of the isolated test ` +
          `database (${describeTarget(testUrlRaw!)}).`,
      ).toBe(0);

      // (f) The test database carries the marker ensure-test-database.ts stamps on provisioning.
      const markerResult = await app.prisma.$queryRaw<{ comment: string | null }[]>`
        SELECT shobj_description(
          (SELECT oid FROM pg_database WHERE datname = current_database()), 'pg_database'
        ) AS comment
      `;
      const comment = markerResult[0]?.comment;
      expect(
        comment,
        `Test database (${describeTarget(testUrlRaw!)}) has no database comment — was it ` +
          `provisioned by ensure-test-database.ts (pnpm run test:setup)?`,
      ).not.toBeNull();
      expect(
        comment?.startsWith(TEST_DATABASE_MARKER),
        `Test database (${describeTarget(testUrlRaw!)}) comment does not start with ` +
          `"${TEST_DATABASE_MARKER}": got "${comment}"`,
      ).toBe(true);
    } finally {
      await devClient.end();
    }
  });
});
