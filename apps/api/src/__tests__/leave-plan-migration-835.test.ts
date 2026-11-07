/**
 * Issue #835 (AC-1, AC-10, AC-12; D-835-01/02/08, A-10) — the LeavePlan / LeavePlanWish tables and
 * their hand-written database backstops (CHECKs, the partial unique index, the exclusion constraint).
 *
 * Executes the REAL migration text (never a restatement of it): both directories are located by
 * their name suffix (`_leave_plan`, `_leave_plan_checks`, exactly one each), and every DDL replay or
 * probe insert runs inside a `$transaction` that always ends by throwing a module-private sentinel,
 * so nothing lands in the shared test database. Assertions run AFTER the rejection, on values
 * captured outside the callback. A failed statement aborts a transaction, so every refusal probe has
 * a transaction of its own. The replay holds ACCESS EXCLUSIVE locks while it is open: no
 * `app.inject` and no read on another connection inside.
 *
 * Cases: (1) the generated file is the enum, the column, the two tables, four indexes and six
 * RESTRICT keys, and the hand-written file is exactly the extension, the partial unique index, the
 * seven CHECKs and the exclusion constraint, (2) the catalog holds all of it and the column set of
 * LeavePlanWish has no free-text column, (3) one probe per refusal of the behaviour list with its
 * SQLSTATE (23505 unique, 23514 check, 23P01 exclusion, 23001/23503 restrict) next to the cases that
 * must pass, (4) the structural recognisers of `db-refusals.ts` against the REAL Prisma errors of the
 * two races, (5) replaying both files on a database without the tables rebuilds them.
 *
 * Mutation proof (Phase 835-04, 2026-11-06) — recorded here, not re-run by CI. The probe cases read
 * the live database, so the proofs mutate the four worker databases of this working directory
 * (`ALTER TABLE ... DROP CONSTRAINT`, `DROP INDEX`) and `test:setup` re-cloned them from the untouched
 * template afterwards:
 * M1 `LeavePlanWish_half_day_check` dropped -> red: the half-day probe, the catalog case and the replay
 *    (3 failed | 16 passed).
 * M2 `LeavePlanWish_no_overlap_active` dropped -> red: the 23P01 probe, the real-error recogniser case,
 *    the catalog case and the replay (4 failed | 15 passed).
 * M3 `LeavePlan_open_unique` dropped -> red: the 23505 probe, the real-error recogniser case and the
 *    catalog case (3 failed | 16 passed).
 * The text cases pin the migration FILES (a statement dropped or added there is red).
 *
 * No person names in fixtures. Every fixture id is a UUID.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import {
  isOpenPlanUniqueViolation,
  isWishOverlapExclusion,
} from "../contexts/absence/leave-plan/db-refusals";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages/db/prisma/migrations");

/** Thrown at the end of a transaction so its DDL and writes always roll back. */
class LeavePlanMigrationRollback extends Error {}

/** The one migration directory whose name ends with `suffix` (a timestamp prefix + `_` + suffix). */
function locate(suffix: string): string {
  const all = readdirSync(MIGRATIONS_DIR);
  expect(all.length, "the migrations directory is not empty").toBeGreaterThan(0);
  const dirs = all.filter((d) => /^\d{14}_/.test(d) && d.endsWith(suffix));
  const exact = dirs.filter((d) => d.slice(15) === suffix.slice(1));
  expect(exact, `exactly one migration directory ends with ${suffix}`).toHaveLength(1);
  return exact[0];
}

function readMigration(dir: string): string {
  return readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8");
}

/** Comment-only lines removed, then split on a semicolon that ends a line (the terminator). */
function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(/;\s*\n?/)
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter((s) => s.length > 0);
}

const EXPECTED_CHECK_STATEMENTS = [
  `CREATE EXTENSION IF NOT EXISTS btree_gist`,
  `CREATE UNIQUE INDEX "LeavePlan_open_unique" ON "LeavePlan"("salonId", "year") WHERE "status" = 'OPEN'`,
  `ALTER TABLE "LeavePlan" ADD CONSTRAINT "LeavePlan_year_check" CHECK ("year" BETWEEN 2000 AND 2100)`,
  `ALTER TABLE "LeavePlan" ADD CONSTRAINT "LeavePlan_taken_over_shape_check" CHECK ( ("status" = 'OPEN' AND "takenOverAt" IS NULL AND "takenOverByUserId" IS NULL) OR ("status" = 'TAKEN_OVER' AND "takenOverAt" IS NOT NULL AND "takenOverByUserId" IS NOT NULL) )`,
  `ALTER TABLE "LeavePlanWish" ADD CONSTRAINT "LeavePlanWish_range_check" CHECK ("startDate" <= "endDate")`,
  `ALTER TABLE "LeavePlanWish" ADD CONSTRAINT "LeavePlanWish_half_day_check" CHECK (NOT "halfDay" OR "startDate" = "endDate")`,
  `ALTER TABLE "LeavePlanWish" ADD CONSTRAINT "LeavePlanWish_refusal_shape_check" CHECK ( ("refusalCode" IS NULL AND "refusalMessage" IS NULL AND "refusedAt" IS NULL) OR ("refusalCode" IS NOT NULL AND "refusalMessage" IS NOT NULL AND "refusedAt" IS NOT NULL) )`,
  `ALTER TABLE "LeavePlanWish" ADD CONSTRAINT "LeavePlanWish_link_shape_check" CHECK (("leaveRequestId" IS NULL) = ("takenOverAt" IS NULL))`,
  `ALTER TABLE "LeavePlanWish" ADD CONSTRAINT "LeavePlanWish_removal_shape_check" CHECK (("deletedAt" IS NULL) = ("deletedByUserId" IS NULL))`,
  `ALTER TABLE "LeavePlanWish" ADD CONSTRAINT "LeavePlanWish_no_overlap_active" EXCLUDE USING gist ("employeeId" WITH =, daterange("startDate", "endDate", '[]') WITH &&) WHERE ("deletedAt" IS NULL AND "leaveRequestId" IS NULL)`,
];

/** D-835-02: the wish carries no free text. Any added column must be argued here, never silently. */
const EXPECTED_WISH_COLUMNS = [
  "createdAt",
  "createdByUserId",
  "deletedAt",
  "deletedByUserId",
  "employeeId",
  "endDate",
  "halfDay",
  "id",
  "leaveRequestId",
  "planId",
  "refusalCode",
  "refusalMessage",
  "refusedAt",
  "startDate",
  "takenOverAt",
  "tenantId",
  "updatedAt",
];

/** Column -> SQL cast of the parameter, so no probe depends on the driver's parameter typing. */
const CASTS: Record<string, string> = {
  year: "int",
  status: `"LeavePlanStatus"`,
  deadline: "date",
  startDate: "date",
  endDate: "date",
  halfDay: "boolean",
  takenOverAt: "timestamptz",
  deletedAt: "timestamptz",
  refusedAt: "timestamptz",
  updatedAt: "timestamptz",
};

const NOW = "2027-01-15T10:00:00Z";

describe("Issue #835 — leave plan migrations", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let tableDir: string;
  let checksDir: string;

  type Tx = Prisma.TransactionClient;

  /** Insert one row with explicit columns; unset columns fall to the table defaults. */
  async function insert(tx: Tx, table: string, row: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    const full: Record<string, unknown> = { id, tenantId: data.tenant.id, updatedAt: NOW, ...row };
    const cols = Object.keys(full);
    const params = cols.map((c, i) => `$${i + 1}${CASTS[c] ? `::${CASTS[c]}` : ""}`);
    await tx.$executeRawUnsafe(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${params.join(", ")})`,
      ...cols.map((c) => full[c]),
    );
    return id;
  }

  function insertPlan(tx: Tx, row: Record<string, unknown> = {}): Promise<string> {
    return insert(tx, "LeavePlan", {
      salonId: data.salonId,
      year: 2027,
      status: "OPEN",
      openedByUserId: data.adminUser.id,
      ...row,
    });
  }

  function insertWish(
    tx: Tx,
    planId: string,
    row: Record<string, unknown> = {},
    employeeId: string = data.employee.id,
  ): Promise<string> {
    return insert(tx, "LeavePlanWish", {
      planId,
      employeeId,
      startDate: "2027-03-01",
      endDate: "2027-03-05",
      halfDay: false,
      createdByUserId: data.adminUser.id,
      ...row,
    });
  }

  async function insertRequest(tx: Tx, startDate = "2027-09-01", endDate = "2027-09-02") {
    const request = await tx.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(`${startDate}T00:00:00Z`),
        endDate: new Date(`${endDate}T00:00:00Z`),
        days: 1,
        status: "PENDING",
      },
    });
    return request.id;
  }

  /** Runs `steps` in a rolled-back transaction; "ok" or the inspected database error of the first failure. */
  async function attempt(steps: (tx: Tx) => Promise<unknown>): Promise<string> {
    let outcome = "unset";
    await expect(
      app.prisma.$transaction(async (tx) => {
        try {
          await steps(tx);
          outcome = "ok";
        } catch (err) {
          outcome = inspect(err, { depth: 10 });
        }
        throw new LeavePlanMigrationRollback();
      }),
    ).rejects.toThrow(LeavePlanMigrationRollback);
    return outcome;
  }

  /** Like `attempt` but hands the raw error to the caller (for the recogniser cases). */
  async function realError(steps: (tx: Tx) => Promise<unknown>): Promise<unknown> {
    let caught: unknown = null;
    await expect(
      app.prisma.$transaction(async (tx) => {
        try {
          await steps(tx);
        } catch (err) {
          caught = err;
        }
        throw new LeavePlanMigrationRollback();
      }),
    ).rejects.toThrow(LeavePlanMigrationRollback);
    return caught;
  }

  /** Database collation orders `_` and letters differently from JS; compare with a plain sort. */
  function byName<T extends { name: string }>(rows: T[]): T[] {
    return [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "mig835");
    tableDir = locate("_leave_plan");
    checksDir = locate("_leave_plan_checks");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("the generated file is the enum, the column, two tables, four indexes and six RESTRICT keys", () => {
    const statements = splitStatements(readMigration(tableDir));
    expect(statements.filter((s) => s.startsWith("CREATE TYPE")).length).toBe(1);
    expect(
      statements.filter((s) => s.startsWith("ALTER TABLE") && s.includes("ADD COLUMN")),
    ).toHaveLength(1);
    expect(statements.filter((s) => s.startsWith("CREATE TABLE")).length).toBe(2);
    expect(statements.filter((s) => /^CREATE (UNIQUE )?INDEX/.test(s)).length).toBe(4);
    const keys = statements.filter((s) => s.includes("FOREIGN KEY"));
    expect(keys).toHaveLength(6);
    for (const key of keys) expect(key).toContain("ON DELETE RESTRICT ON UPDATE CASCADE");
    expect(statements, "nothing beyond the 14 generated statements").toHaveLength(14);
  });

  it("the hand-written file is exactly the extension, the partial unique index, seven CHECKs and the exclusion", () => {
    expect(splitStatements(readMigration(checksDir))).toEqual(EXPECTED_CHECK_STATEMENTS);
    const sql = readMigration(checksDir);
    expect(sql).toContain("LeavePlan_open_unique");
    expect(sql).toContain("LeavePlanWish_no_overlap_active");
    expect((sql.match(/CHECK/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });

  it("the catalog holds the keys, the CHECKs, the partial unique index and the exclusion constraint", async () => {
    const fks = await app.prisma.$queryRaw<{ name: string; del: string; target: string }[]>`
      SELECT conname AS name, confdeltype::text AS del, confrelid::regclass::text AS target
      FROM pg_constraint
      WHERE conrelid IN ('"LeavePlan"'::regclass, '"LeavePlanWish"'::regclass) AND contype = 'f'
      ORDER BY conname`;
    expect(byName(fks)).toEqual(
      byName([
        { name: "LeavePlan_salonId_fkey", del: "r", target: '"Salon"' },
        { name: "LeavePlan_tenantId_fkey", del: "r", target: '"Tenant"' },
        { name: "LeavePlanWish_employeeId_fkey", del: "r", target: '"Employee"' },
        { name: "LeavePlanWish_leaveRequestId_fkey", del: "r", target: '"LeaveRequest"' },
        { name: "LeavePlanWish_planId_fkey", del: "r", target: '"LeavePlan"' },
        { name: "LeavePlanWish_tenantId_fkey", del: "r", target: '"Tenant"' },
      ]),
    );

    const checks = await app.prisma.$queryRaw<{ name: string }[]>`
      SELECT conname AS name FROM pg_constraint
      WHERE conrelid IN ('"LeavePlan"'::regclass, '"LeavePlanWish"'::regclass) AND contype = 'c'
      ORDER BY conname`;
    expect(checks.map((c) => c.name).sort()).toEqual(
      [
        "LeavePlan_taken_over_shape_check",
        "LeavePlan_year_check",
        "LeavePlanWish_half_day_check",
        "LeavePlanWish_link_shape_check",
        "LeavePlanWish_range_check",
        "LeavePlanWish_refusal_shape_check",
        "LeavePlanWish_removal_shape_check",
      ].sort(),
    );

    const exclusion = await app.prisma.$queryRaw<{ name: string }[]>`
      SELECT conname AS name FROM pg_constraint
      WHERE conrelid = '"LeavePlanWish"'::regclass AND contype = 'x'`;
    expect(exclusion.map((c) => c.name)).toEqual(["LeavePlanWish_no_overlap_active"]);

    const partial = await app.prisma.$queryRaw<{ def: string }[]>`
      SELECT indexdef AS def FROM pg_indexes
      WHERE tablename = 'LeavePlan' AND indexname = 'LeavePlan_open_unique'`;
    expect(partial).toHaveLength(1);
    expect(partial[0].def).toContain("UNIQUE");
    expect(partial[0].def).toContain("'OPEN'");
  });

  it("LeavePlanWish has exactly the D-835-02 columns — no free-text column", async () => {
    const columns = await app.prisma.$queryRaw<{ name: string }[]>`
      SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'LeavePlanWish' ORDER BY column_name`;
    expect(columns.map((c) => c.name)).toEqual([...EXPECTED_WISH_COLUMNS].sort());
  });

  it("a second OPEN plan of one salon and year is refused with 23505, after a takeover a new one passes", async () => {
    expect(
      await attempt(async (tx) => {
        await insertPlan(tx);
        await insertPlan(tx);
      }),
    ).toContain("23505");
    // The first plan taken over -> the pair is free again (AC-12).
    expect(
      await attempt(async (tx) => {
        await insertPlan(tx, {
          status: "TAKEN_OVER",
          takenOverAt: NOW,
          takenOverByUserId: data.adminUser.id,
        });
        await insertPlan(tx);
      }),
    ).toBe("ok");
    // Another year, and another salon, are different pairs.
    expect(
      await attempt(async (tx) => {
        await insertPlan(tx);
        await insertPlan(tx, { year: 2028 });
        const other = await createTestSalon(tx, data.tenant.id, { name: "Salon other 835" });
        await insertPlan(tx, { salonId: other.id });
      }),
    ).toBe("ok");
  });

  it("a plan year outside 2000..2100 is refused with 23514, the bounds pass", async () => {
    expect(await attempt((tx) => insertPlan(tx, { year: 1999 }))).toContain("23514");
    expect(await attempt((tx) => insertPlan(tx, { year: 2101 }))).toContain("23514");
    expect(await attempt((tx) => insertPlan(tx, { year: 2000 }))).toBe("ok");
    expect(await attempt((tx) => insertPlan(tx, { year: 2100 }))).toBe("ok");
  });

  it("a TAKEN_OVER plan without takenOverAt or takenOverByUserId (and an OPEN one with them) is refused with 23514", async () => {
    expect(
      await attempt((tx) =>
        insertPlan(tx, { status: "TAKEN_OVER", takenOverByUserId: data.adminUser.id }),
      ),
    ).toContain("23514");
    expect(
      await attempt((tx) => insertPlan(tx, { status: "TAKEN_OVER", takenOverAt: NOW })),
    ).toContain("23514");
    expect(await attempt((tx) => insertPlan(tx, { status: "TAKEN_OVER" }))).toContain("23514");
    expect(await attempt((tx) => insertPlan(tx, { takenOverAt: NOW }))).toContain("23514");
    expect(
      await attempt((tx) => insertPlan(tx, { takenOverByUserId: data.adminUser.id })),
    ).toContain("23514");
  });

  it("an inverted wish is refused with 23514, a one-day and a longer range pass", async () => {
    expect(
      await attempt(async (tx) => {
        const plan = await insertPlan(tx);
        await insertWish(tx, plan, { startDate: "2027-03-05", endDate: "2027-03-01" });
      }),
    ).toContain("23514");
    expect(
      await attempt(async (tx) => {
        const plan = await insertPlan(tx);
        await insertWish(tx, plan, { startDate: "2027-03-01", endDate: "2027-03-01" });
        await insertWish(tx, plan, { startDate: "2027-04-01", endDate: "2027-04-10" });
      }),
    ).toBe("ok");
  });

  it("a half day over two days is refused with 23514, a half day on one day passes", async () => {
    expect(
      await attempt(async (tx) => {
        const plan = await insertPlan(tx);
        await insertWish(tx, plan, { halfDay: true });
      }),
    ).toContain("23514");
    expect(
      await attempt(async (tx) => {
        const plan = await insertPlan(tx);
        await insertWish(tx, plan, {
          halfDay: true,
          startDate: "2027-03-01",
          endDate: "2027-03-01",
        });
      }),
    ).toBe("ok");
  });

  it("a refusal code without message or time (and the reverse) is refused with 23514, the full triple passes", async () => {
    const code = { refusalCode: "LEAVE_PLAN_WISH_NOT_IN_SALON" };
    const message = { refusalMessage: "Text" };
    const time = { refusedAt: NOW };
    for (const partial of [
      { ...code },
      { ...code, ...message },
      { ...code, ...time },
      { ...message },
      { ...time },
      { ...message, ...time },
    ]) {
      expect(
        await attempt(async (tx) => insertWish(tx, await insertPlan(tx), partial)),
        JSON.stringify(partial),
      ).toContain("23514");
    }
    expect(
      await attempt(async (tx) =>
        insertWish(tx, await insertPlan(tx), { ...code, ...message, ...time }),
      ),
    ).toBe("ok");
  });

  it("a request link without takenOverAt (and the reverse) is refused with 23514, both together pass", async () => {
    expect(
      await attempt(async (tx) =>
        insertWish(tx, await insertPlan(tx), { leaveRequestId: await insertRequest(tx) }),
      ),
    ).toContain("23514");
    expect(
      await attempt(async (tx) => insertWish(tx, await insertPlan(tx), { takenOverAt: NOW })),
    ).toContain("23514");
    expect(
      await attempt(async (tx) =>
        insertWish(tx, await insertPlan(tx), {
          leaveRequestId: await insertRequest(tx),
          takenOverAt: NOW,
        }),
      ),
    ).toBe("ok");
  });

  it("a removal time without remover (and the reverse) is refused with 23514, both together pass", async () => {
    expect(
      await attempt(async (tx) => insertWish(tx, await insertPlan(tx), { deletedAt: NOW })),
    ).toContain("23514");
    expect(
      await attempt(async (tx) =>
        insertWish(tx, await insertPlan(tx), { deletedByUserId: data.adminUser.id }),
      ),
    ).toContain("23514");
    expect(
      await attempt(async (tx) =>
        insertWish(tx, await insertPlan(tx), {
          deletedAt: NOW,
          deletedByUserId: data.adminUser.id,
        }),
      ),
    ).toBe("ok");
  });

  it("two overlapping active, not-taken-over wishes of one person are refused with 23P01", async () => {
    // Inclusive on both ends: a shared boundary day is an overlap.
    expect(
      await attempt(async (tx) => {
        const plan = await insertPlan(tx);
        await insertWish(tx, plan, { startDate: "2027-03-01", endDate: "2027-03-05" });
        await insertWish(tx, plan, { startDate: "2027-03-05", endDate: "2027-03-08" });
      }),
    ).toContain("23P01");
    // The same range in another plan of the same person is the same overlap.
    expect(
      await attempt(async (tx) => {
        await insertWish(tx, await insertPlan(tx));
        const other = await createTestSalon(tx, data.tenant.id, { name: "Salon other 835" });
        await insertWish(tx, await insertPlan(tx, { salonId: other.id }));
      }),
    ).toContain("23P01");
  });

  it("the same ranges pass for another person, on the next day, or with one wish removed or linked", async () => {
    expect(
      await attempt(async (tx) => {
        const plan = await insertPlan(tx);
        await insertWish(tx, plan);
        // Another person.
        await insertWish(tx, plan, {}, data.adminEmployee.id);
        // The day after the end.
        await insertWish(tx, plan, { startDate: "2027-03-06", endDate: "2027-03-07" });
      }),
    ).toBe("ok");
    // One of the two is removed.
    expect(
      await attempt(async (tx) => {
        const plan = await insertPlan(tx);
        await insertWish(tx, plan, { deletedAt: NOW, deletedByUserId: data.adminUser.id });
        await insertWish(tx, plan);
      }),
    ).toBe("ok");
    // One of the two is taken over (linked to its request).
    expect(
      await attempt(async (tx) => {
        const plan = await insertPlan(tx);
        await insertWish(tx, plan, { leaveRequestId: await insertRequest(tx), takenOverAt: NOW });
        await insertWish(tx, plan);
      }),
    ).toBe("ok");
  });

  it("a salon, an employee or a request referenced by a plan or wish cannot be deleted", async () => {
    const refusals: Record<string, string> = {};
    await expect(
      app.prisma.$transaction(async (tx) => {
        const salon = await createTestSalon(tx, data.tenant.id, { name: "Salon referenced 835" });
        await insertPlan(tx, { salonId: salon.id });
        try {
          await tx.$executeRawUnsafe(`DELETE FROM "Salon" WHERE "id" = $1`, salon.id);
        } catch (err) {
          refusals.salon = inspect(err, { depth: 10 });
        }
        throw new LeavePlanMigrationRollback();
      }),
    ).rejects.toThrow(LeavePlanMigrationRollback);
    expect(refusals.salon, "restrict_violation (23001) or foreign_key_violation (23503)").toMatch(
      /23001|23503/,
    );
    expect(refusals.salon).toContain("LeavePlan_salonId_fkey");

    await expect(
      app.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: `fk-${randomUUID()}@test.de`, passwordHash: "x", isActive: true },
        });
        const employee = await tx.employee.create({
          data: {
            tenantId: data.tenant.id,
            userId: user.id,
            employeeNumber: `fk-${randomUUID().slice(0, 8)}`,
            firstName: "Fk",
            lastName: "Test",
            hireDate: new Date("2024-01-01"),
          },
        });
        await insertWish(tx, await insertPlan(tx), {}, employee.id);
        try {
          await tx.$executeRawUnsafe(`DELETE FROM "Employee" WHERE "id" = $1`, employee.id);
        } catch (err) {
          refusals.employee = inspect(err, { depth: 10 });
        }
        throw new LeavePlanMigrationRollback();
      }),
    ).rejects.toThrow(LeavePlanMigrationRollback);
    expect(refusals.employee).toMatch(/23001|23503/);
    expect(refusals.employee).toContain("LeavePlanWish_employeeId_fkey");

    await expect(
      app.prisma.$transaction(async (tx) => {
        const requestId = await insertRequest(tx);
        await insertWish(tx, await insertPlan(tx), { leaveRequestId: requestId, takenOverAt: NOW });
        try {
          await tx.$executeRawUnsafe(`DELETE FROM "LeaveRequest" WHERE "id" = $1`, requestId);
        } catch (err) {
          refusals.request = inspect(err, { depth: 10 });
        }
        throw new LeavePlanMigrationRollback();
      }),
    ).rejects.toThrow(LeavePlanMigrationRollback);
    expect(refusals.request).toMatch(/23001|23503/);
    expect(refusals.request).toContain("LeavePlanWish_leaveRequestId_fkey");

    // Control: an unreferenced salon of the same tenant is deletable.
    let control = -1;
    await expect(
      app.prisma.$transaction(async (tx) => {
        const salon = await createTestSalon(tx, data.tenant.id, { name: "Salon unreferenced 835" });
        control = await tx.$executeRawUnsafe(`DELETE FROM "Salon" WHERE "id" = $1`, salon.id);
        throw new LeavePlanMigrationRollback();
      }),
    ).rejects.toThrow(LeavePlanMigrationRollback);
    expect(control).toBe(1);
  });

  describe("the structural recognisers of db-refusals.ts", () => {
    it("recognise the real error of a racing second OPEN plan, and not an unrelated P2002", async () => {
      const err = await realError(async (tx) => {
        const plan = { tenantId: data.tenant.id, salonId: data.salonId, year: 2027 };
        await tx.leavePlan.create({ data: { ...plan, openedByUserId: data.adminUser.id } });
        await tx.leavePlan.create({ data: { ...plan, openedByUserId: data.adminUser.id } });
      });
      expect(err, "the second create was refused").not.toBeNull();
      expect((err as { code?: string }).code).toBe("P2002");
      expect(isOpenPlanUniqueViolation(err)).toBe(true);
      expect(isWishOverlapExclusion(err)).toBe(false);

      // A real P2002 on another index: two wishes linked to ONE request (LeavePlanWish_leaveRequestId_key).
      const viaClient = await realError(async (tx) => {
        const requestId = await insertRequest(tx);
        const planId = await insertPlan(tx);
        const wish = {
          tenantId: data.tenant.id,
          planId,
          startDate: new Date("2027-03-01T00:00:00Z"),
          endDate: new Date("2027-03-02T00:00:00Z"),
          createdByUserId: data.adminUser.id,
          leaveRequestId: requestId,
          takenOverAt: new Date(NOW),
        };
        await tx.leavePlanWish.create({ data: { ...wish, employeeId: data.employee.id } });
        await tx.leavePlanWish.create({ data: { ...wish, employeeId: data.adminEmployee.id } });
      });
      expect((viaClient as { code?: string }).code).toBe("P2002");
      expect(isOpenPlanUniqueViolation(viaClient)).toBe(false);
    });

    it("recognise the real error of two racing overlapping wishes, and not a CHECK refusal", async () => {
      const err = await realError(async (tx) => {
        const planId = (
          await tx.leavePlan.create({
            data: {
              tenantId: data.tenant.id,
              salonId: data.salonId,
              year: 2027,
              openedByUserId: data.adminUser.id,
            },
          })
        ).id;
        const wish = {
          tenantId: data.tenant.id,
          planId,
          employeeId: data.employee.id,
          createdByUserId: data.adminUser.id,
        };
        await tx.leavePlanWish.create({
          data: {
            ...wish,
            startDate: new Date("2027-03-01T00:00:00Z"),
            endDate: new Date("2027-03-05T00:00:00Z"),
          },
        });
        await tx.leavePlanWish.create({
          data: {
            ...wish,
            startDate: new Date("2027-03-04T00:00:00Z"),
            endDate: new Date("2027-03-08T00:00:00Z"),
          },
        });
      });
      expect(err, "the second create was refused").not.toBeNull();
      expect((err as { code?: string }).code).toBe("P2039");
      expect(isWishOverlapExclusion(err)).toBe(true);
      expect(isOpenPlanUniqueViolation(err)).toBe(false);

      // A real CHECK refusal (inverted range) is neither of the two races.
      const check = await realError(async (tx) => {
        const planId = (
          await tx.leavePlan.create({
            data: {
              tenantId: data.tenant.id,
              salonId: data.salonId,
              year: 2027,
              openedByUserId: data.adminUser.id,
            },
          })
        ).id;
        await tx.leavePlanWish.create({
          data: {
            tenantId: data.tenant.id,
            planId,
            employeeId: data.employee.id,
            createdByUserId: data.adminUser.id,
            startDate: new Date("2027-03-05T00:00:00Z"),
            endDate: new Date("2027-03-01T00:00:00Z"),
          },
        });
      });
      expect(check).not.toBeNull();
      expect(isWishOverlapExclusion(check)).toBe(false);
      expect(isOpenPlanUniqueViolation(check)).toBe(false);
    });

    it("reject look-alikes: other constraint names, other codes, a message that merely names the index", () => {
      const exclusion = (message: string, originalCode = "23P01", code = "P2039") => ({
        code,
        meta: { driverAdapterError: { cause: { originalCode, originalMessage: message } } },
      });
      expect(
        isWishOverlapExclusion(
          exclusion(
            'conflicting key value violates exclusion constraint "LeavePlanWish_no_overlap_active"',
          ),
        ),
      ).toBe(true);
      expect(
        isWishOverlapExclusion(
          exclusion('violates exclusion constraint "TimeEntry_no_overlap_closed"'),
        ),
      ).toBe(false);
      expect(isWishOverlapExclusion(exclusion('"LeavePlanWish_no_overlap_active"', "22000"))).toBe(
        false,
      );
      expect(
        isWishOverlapExclusion(exclusion('"LeavePlanWish_no_overlap_active"', "23P01", "P2002")),
      ).toBe(false);
      // A message that names the constraint but carries no structured cause.
      expect(
        isWishOverlapExclusion({ code: "P2039", message: "LeavePlanWish_no_overlap_active" }),
      ).toBe(false);
      expect(isWishOverlapExclusion(null)).toBe(false);
      expect(isWishOverlapExclusion("LeavePlanWish_no_overlap_active")).toBe(false);

      const unique = (index: string, message = "") => ({
        code: "P2002",
        message,
        meta: { driverAdapterError: { cause: { constraint: { index } } } },
      });
      expect(isOpenPlanUniqueViolation(unique("LeavePlan_open_unique"))).toBe(true);
      expect(
        isOpenPlanUniqueViolation(
          unique("LeavePlanWish_leaveRequestId_key", "LeavePlan_open_unique"),
        ),
      ).toBe(false);
      expect(
        isOpenPlanUniqueViolation({ code: "P2003", meta: { target: "LeavePlan_open_unique" } }),
      ).toBe(false);
      expect(isOpenPlanUniqueViolation(undefined)).toBe(false);
    });
  });

  it("replaying both files rebuilds the tables and leaves every other table's columns unchanged", async () => {
    const statements = [
      ...splitStatements(readMigration(tableDir)),
      ...splitStatements(readMigration(checksDir)),
    ];
    type Col = Record<string, unknown>;
    const snapshot = (tx: Pick<typeof app.prisma, "$queryRawUnsafe">, own: boolean) =>
      tx.$queryRawUnsafe<Col[]>(
        `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND (table_name IN ('LeavePlan', 'LeavePlanWish')) = ${own}
         ORDER BY table_name, ordinal_position`,
      );
    const constraints = (tx: Pick<typeof app.prisma, "$queryRawUnsafe">) =>
      tx.$queryRawUnsafe<Col[]>(
        `SELECT conrelid::regclass::text AS tbl, conname, contype::text AS kind,
                pg_get_constraintdef(oid) AS def
         FROM pg_constraint
         WHERE conrelid IN ('"LeavePlan"'::regclass, '"LeavePlanWish"'::regclass)
         ORDER BY conname`,
      );
    let ownBefore: Col[] = [];
    let ownAfter: Col[] = [];
    let othersBefore: Col[] = [];
    let othersAfter: Col[] = [];
    let constraintsBefore: Col[] = [];
    let constraintsAfter: Col[] = [];
    let droppedFirst = false;

    await expect(
      app.prisma.$transaction(
        async (tx) => {
          ownBefore = await snapshot(tx, true);
          othersBefore = await snapshot(tx, false);
          constraintsBefore = await constraints(tx);
          await tx.$executeRawUnsafe(`DROP TABLE "LeavePlanWish"`);
          await tx.$executeRawUnsafe(`DROP TABLE "LeavePlan"`);
          await tx.$executeRawUnsafe(`DROP TYPE "LeavePlanStatus"`);
          await tx.$executeRawUnsafe(
            `ALTER TABLE "TenantConfig" DROP COLUMN "leavePlanDeadlineLocksWishes"`,
          );
          droppedFirst = (await snapshot(tx, true)).length === 0;
          for (const statement of statements) await tx.$executeRawUnsafe(statement);
          ownAfter = await snapshot(tx, true);
          othersAfter = await snapshot(tx, false);
          constraintsAfter = await constraints(tx);
          throw new LeavePlanMigrationRollback();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(LeavePlanMigrationRollback);

    expect(droppedFirst, "the tables were gone before the replay").toBe(true);
    expect(ownBefore.length, "the tables have columns to compare").toBeGreaterThan(20);
    expect(ownAfter).toEqual(ownBefore);
    expect(othersBefore.length, "other tables were captured").toBeGreaterThan(100);
    expect(othersAfter).toEqual(othersBefore);
    expect(constraintsBefore.length, "constraints were captured").toBeGreaterThanOrEqual(14);
    expect(constraintsAfter).toEqual(constraintsBefore);

    // Rollback proof: the tables are back for every other file.
    const back = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.tables
      WHERE table_name IN ('LeavePlan', 'LeavePlanWish')`;
    expect(Number(back[0].n)).toBe(2);
  });
});
