/**
 * Phase 99 Plan 01 (OB-01) — DB-level proof that the partial unique index on
 * OpeningBalance actually holds.
 *
 * This is the constraint that makes getCarryOverBase()'s
 * `findFirst({ superseded: false })` unambiguous (a later plan in this phase) — if it
 * does not hold at the database level, that helper is unsound.
 *
 * Infra finding (discovered while writing this test; documented, NOT fixed here — Rule 4
 * territory, out of this plan's scope, recorded in
 * .planning/phases/99-openingbalance-modell/deferred-items.md): `apps/api/src/plugins/
 * prisma.ts` constructs its `pg.Pool` with `connectionString: process.env.DATABASE_URL`.
 * node-postgres does NOT interpret the Prisma-specific `?schema=` query parameter —
 * that convention is only understood by Prisma's own query compiler for TYPED queries
 * when NOT using driver adapters. With `@prisma/adapter-pg` (driver adapters, as used
 * here), BOTH typed model queries AND raw SQL land wherever the pg connection's default
 * `search_path` resolves — verified empirically to be `public`, i.e. the SAME schema as
 * local dev, regardless of `TEST_DATABASE_URL`'s `?schema=test`. So despite `pretest`
 * provisioning a separate "test" schema via `db push`, the running test suite never
 * actually reads or writes it — integration tests currently execute against the local
 * dev database. This is pre-existing and suite-wide, not caused by this plan; fixing it
 * (passing `options: "-c search_path=..."` to the pg.Pool, or equivalent) is out of
 * scope here given the blast radius across the whole existing suite.
 *
 * Consequence for THIS test: the partial unique index must exist in `public` (the schema
 * every query — typed or raw — actually resolves to). Task 1's migration already created
 * it there via the real `migrate dev` + hand-edited SQL. `beforeAll` below re-asserts it
 * with `IF NOT EXISTS`, byte-identical to the migration, as cheap defensive idempotency —
 * not a workaround for a Prisma DSL gap (that's the schema.prisma comment's job), but for
 * the case where a local dev DB reset happens outside the documented migration flow.
 *
 * No PII — initials only (memory feedback_no_pii_in_github).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";

describe("OpeningBalance — partial unique index (superseded = false)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let employeeAId: string;
  let employeeBId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "ob-model");
    employeeAId = data.employee.id;
    employeeBId = data.adminEmployee.id;

    // Byte-identical to the migration's hand-edited raw SQL. See file-header comment for
    // why this is defensive idempotency, not a workaround for a schema mismatch.
    await app.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "OpeningBalance_active_unique"
         ON "OpeningBalance" ("employeeId")
         WHERE "superseded" = false;`,
    );
  });

  afterAll(async () => {
    try {
      await app.prisma.openingBalance.deleteMany({
        where: { employeeId: { in: [employeeAId, employeeBId] } },
      });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("opening-balance-model test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("Test 1: creating one active OpeningBalance for an employee succeeds", async () => {
    const row = await app.prisma.openingBalance.create({
      data: {
        employeeId: employeeAId,
        minutes: 600,
        effectiveFrom: new Date("2026-01-01"),
        reason: "Alt-Überstunden aus Vorgängersystem",
        source: "MIGRATED_FROM_SNAPSHOT",
        createdBy: data.adminUser.id,
      },
    });
    expect(row.superseded).toBe(false);
    expect(row.minutes).toBe(600);
  });

  it("Test 2: a SECOND active OpeningBalance for the SAME employee is rejected by the database", async () => {
    await expect(
      app.prisma.openingBalance.create({
        data: {
          employeeId: employeeAId,
          minutes: 120,
          effectiveFrom: new Date("2026-01-01"),
          reason: "Zweiter Versuch — muss an der Partial-Unique scheitern",
          source: "ADMIN_ENTRY",
          createdBy: data.adminUser.id,
        },
      }),
    ).rejects.toThrow();
  });

  it("Test 3: superseding the active row and THEN creating a replacement succeeds (supersede-before-create)", async () => {
    const active = await app.prisma.openingBalance.findFirstOrThrow({
      where: { employeeId: employeeAId, superseded: false },
    });

    const superseded = await app.prisma.openingBalance.update({
      where: { id: active.id },
      data: { superseded: true, supersededReason: "Korrektur — Betrag war falsch" },
    });
    expect(superseded.superseded).toBe(true);

    const replacement = await app.prisma.openingBalance.create({
      data: {
        employeeId: employeeAId,
        minutes: 90,
        effectiveFrom: new Date("2026-01-01"),
        reason: "Korrigierter Eröffnungssaldo",
        source: "ADMIN_ENTRY",
        createdBy: data.adminUser.id,
      },
    });
    expect(replacement.superseded).toBe(false);
    expect(replacement.minutes).toBe(90);

    await app.prisma.openingBalance.update({
      where: { id: superseded.id },
      data: { supersededBy: replacement.id },
    });

    const activeRows = await app.prisma.openingBalance.findMany({
      where: { employeeId: employeeAId, superseded: false },
    });
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].id).toBe(replacement.id);
  });

  it("Test 4: two DIFFERENT employees may each hold one active OpeningBalance", async () => {
    const rowB = await app.prisma.openingBalance.create({
      data: {
        employeeId: employeeBId,
        minutes: -300,
        effectiveFrom: new Date("2026-01-01"),
        reason: "Übernommene Minusstunden aus Vorgängersystem",
        source: "RECONSTRUCTED",
        createdBy: data.adminUser.id,
      },
    });
    expect(rowB.employeeId).toBe(employeeBId);
    expect(rowB.minutes).toBe(-300);

    // Employee A still has exactly one active row (from Test 3) — proves the index is
    // scoped per-employee, not global.
    const activeA = await app.prisma.openingBalance.findMany({
      where: { employeeId: employeeAId, superseded: false },
    });
    expect(activeA).toHaveLength(1);
  });
});
