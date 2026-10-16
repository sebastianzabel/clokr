/**
 * Issue #595 (D-05, P-06) - the dev wrapper that closes the demo tenant's previous month with the
 * real closer (the exported core of `backfill-month-snapshots.ts`) and proves, per employee, that
 * the stored figures are the kernel's: `computeMonthReportFigures` before the close (open month,
 * kernel) equals the figures after it (snapshot, confirmed).
 *
 * No fixed minute expectations - only before == after - so the test cannot drift with a holiday
 * calendar or a kernel rule. Months are relative to the tenant-local today.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  salonIdForEmployee,
  auditRowsFor,
} from "../../src/__tests__/setup";
import {
  TEST_TZ,
  dbDateStr,
  dowOf,
  monthEndUtc,
  monthStartUtc,
  saldoSnapshotPeriodBounds,
} from "../../src/__tests__/test-dates";
import { monthRangeUtc } from "../../src/contexts/working-time-account/timezone";
import { computeMonthReportFigures } from "../../src/contexts/working-time-account";
import { assertDemoCloseTarget, runDemoClose } from "../demo-close-previous-month";

describe("assertDemoCloseTarget - hard target guards (T-595-14)", () => {
  it("refuses NODE_ENV=production, even with a matching confirmation", () => {
    expect(() =>
      assertDemoCloseTarget({
        nodeEnv: "production",
        confirmDatabase: "clokr_demo595",
        connectedDatabase: "clokr_demo595",
      }),
    ).toThrow(/production/i);
  });

  it("refuses a confirmation that differs from the connected database", () => {
    expect(() =>
      assertDemoCloseTarget({
        nodeEnv: "development",
        confirmDatabase: "x",
        connectedDatabase: "y",
      }),
    ).toThrow(/x/);
  });

  it("refuses a missing or empty confirmation", () => {
    expect(() =>
      assertDemoCloseTarget({
        nodeEnv: "development",
        confirmDatabase: undefined,
        connectedDatabase: "y",
      }),
    ).toThrow();
    expect(() =>
      assertDemoCloseTarget({
        nodeEnv: "development",
        confirmDatabase: "",
        connectedDatabase: "",
      }),
    ).toThrow();
  });

  it("passes for equal names outside production", () => {
    expect(() =>
      assertDemoCloseTarget({
        nodeEnv: "development",
        confirmDatabase: "clokr_demo595",
        connectedDatabase: "clokr_demo595",
      }),
    ).not.toThrow();
    expect(() =>
      assertDemoCloseTarget({
        nodeEnv: undefined,
        confirmDatabase: "clokr_demo595",
        connectedDatabase: "clokr_demo595",
      }),
    ).not.toThrow();
  });
});

describe("runDemoClose - DB-backed", () => {
  let app: FastifyInstance;
  const tenantIds: string[] = [];
  let tenantSlug: string;
  let otherTenantId: string;
  let empE: string; // chain head: zero row for M-2, entries in M-1
  let empF: string; // no snapshot at all, entries in M-1
  let empH: string; // chain head shape, but in ANOTHER tenant
  let year1 = 0;
  let month1 = 0;
  let beforeE: { workedMinutes: number; expectedMinutes: number; balanceMinutes: number } | null =
    null;

  const zeroFigures = {
    workedMinutes: 0,
    expectedMinutes: 0,
    balanceMinutes: 0,
    carryOver: 0,
  };

  async function createEmployee(tenantId: string, salonId: string, label: string): Promise<string> {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@example.invalid`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const hire = new Date("2025-06-01T00:00:00Z");
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `${label}-${suffix}`,
        firstName: label,
        lastName: "DemoClose595",
        hireDate: hire,
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: hire,
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId: employee.id,
        salonId,
        kind: "HOME",
        validFrom: hire,
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    return employee.id;
  }

  /** Closed valid WORK entries on the first workdays of M-1. */
  async function seedMonthEntries(employeeId: string): Promise<number> {
    const first = monthStartUtc(1);
    const last = monthEndUtc(1);
    let created = 0;
    for (let t = first.getTime(); t <= last.getTime() && created < 8; t += 86_400_000) {
      const dateStr = dbDateStr(new Date(t));
      const dow = dowOf(dateStr);
      if (dow < 1 || dow > 5) continue;
      const start = new Date(`${dateStr}T08:00:00Z`);
      await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: new Date(`${dateStr}T00:00:00Z`),
          startTime: start,
          endTime: new Date(start.getTime() + (450 + 30) * 60_000),
          breakMinutes: 30,
          type: "WORK",
          salonId: await salonIdForEmployee(app.prisma, employeeId),
        },
      });
      created++;
    }
    return created;
  }

  async function zeroRowForMonthBefore(employeeId: string, closedBy: string) {
    const bounds = saldoSnapshotPeriodBounds(monthStartUtc(2));
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: bounds.start,
        periodEnd: bounds.end,
        ...zeroFigures,
        closedAt: new Date(),
        closedBy,
        note: "Vor Erfassungsbeginn (Demo)",
      },
    });
  }

  function activeRows(employeeId: string) {
    return app.prisma.saldoSnapshot.findMany({
      where: { employeeId, periodType: "MONTHLY", superseded: false },
      orderBy: [{ periodStart: "asc" }, { id: "asc" }],
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    const seed = await seedTestData(app, "democlose-595");
    tenantIds.push(seed.tenant.id);
    tenantSlug = seed.tenant.slug;
    const other = await seedTestData(app, "democlose-other-595");
    tenantIds.push(other.tenant.id);
    otherTenantId = other.tenant.id;

    const monthStr = dbDateStr(monthStartUtc(1)); // YYYY-MM-01
    year1 = Number(monthStr.slice(0, 4));
    month1 = Number(monthStr.slice(5, 7));

    empE = await createEmployee(seed.tenant.id, seed.salonId, "de595");
    empF = await createEmployee(seed.tenant.id, seed.salonId, "df595");
    empH = await createEmployee(other.tenant.id, other.salonId, "dh595");

    await zeroRowForMonthBefore(empE, seed.adminUser.id);
    await zeroRowForMonthBefore(empH, other.adminUser.id);
    expect(await seedMonthEntries(empE)).toBeGreaterThan(0);
    expect(await seedMonthEntries(empF)).toBeGreaterThan(0);
    expect(await seedMonthEntries(empH)).toBeGreaterThan(0);
  }, 120_000);

  afterAll(async () => {
    try {
      for (const id of tenantIds) await cleanupTestData(app, id);
    } catch (err) {
      console.error("demo-close-previous-month-595 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("dry run writes nothing and reports the chain head as the plan", async () => {
    const summary = await runDemoClose(app, { tenantSlug, apply: false });

    expect(summary.tenantFound).toBe(true);
    expect(summary.apply).toBe(false);
    expect(summary.month).toEqual({ year: year1, month: month1 });
    expect(summary.rows.map((r) => r.employeeId)).toEqual([empE]);
    expect(summary.rows[0]!.after).toBeNull();
    expect(summary.rows[0]!.before.confirmed).toBe(false);
    beforeE = summary.rows[0]!.before;

    expect((await activeRows(empE)).length).toBe(1); // only the zero row
    expect(await auditRowsFor(app, "SaldoSnapshot", empE, "CREATE")).toHaveLength(0);
  });

  it("apply closes the previous month with the real closer: before == after, confirmed", async () => {
    const summary = await runDemoClose(app, { tenantSlug, apply: true });

    expect(summary.mismatches).toBe(0);
    expect(summary.rows).toHaveLength(1);
    const row = summary.rows[0]!;
    expect(row.employeeId).toBe(empE);
    expect(row.matches).toBe(true);
    expect(row.after).not.toBeNull();
    expect(row.after!.confirmed).toBe(true);
    expect(row.after!.workedMinutes).toBe(row.before.workedMinutes);
    expect(row.after!.expectedMinutes).toBe(row.before.expectedMinutes);
    expect(row.after!.balanceMinutes).toBe(row.before.balanceMinutes);
    // The dry run's kernel figures are the figures the close stored.
    expect(row.before.workedMinutes).toBe(beforeE!.workedMinutes);
    expect(row.before.expectedMinutes).toBe(beforeE!.expectedMinutes);
    expect(row.before.workedMinutes).toBeGreaterThan(0);

    // One active converted-convention row for M-1, next to the zero row for M-2.
    const rows = await activeRows(empE);
    expect(rows).toHaveLength(2);
    const closed = rows[1]!;
    expect(dbDateStr(closed.periodStart)).toBe(
      dbDateStr(monthRangeUtc(year1, month1, TEST_TZ).start),
    );
    expect(closed.workedMinutes).toBe(row.before.workedMinutes);
    expect(closed.expectedMinutes).toBe(row.before.expectedMinutes);
    expect(closed.balanceMinutes).toBe(row.before.balanceMinutes);

    // The reader agrees independently of the wrapper's own bookkeeping.
    const figures = await computeMonthReportFigures(app, empE, year1, month1);
    expect(figures.confirmed).toBe(true);
    expect(figures.workedMinutes).toBe(row.before.workedMinutes);

    // The month's entries are locked by the closer.
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: empE, deletedAt: null },
      select: { isLocked: true },
    });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.isLocked)).toBe(true);

    // Exactly one BACKFILL audit row.
    const audit = await auditRowsFor(app, "SaldoSnapshot", empE, "CREATE");
    expect(audit).toHaveLength(1);
    expect((audit[0]!.newValue as { origin?: string }).origin).toBe("BACKFILL");
  });

  it("touches neither an employee without a chain head nor another tenant's employee", async () => {
    expect(await activeRows(empF)).toHaveLength(0);
    expect(await auditRowsFor(app, "SaldoSnapshot", empF, "CREATE")).toHaveLength(0);
    expect(await activeRows(empH)).toHaveLength(1); // its zero row only
    expect(await auditRowsFor(app, "SaldoSnapshot", empH, "CREATE")).toHaveLength(0);
    expect(otherTenantId).not.toBe("");
  });

  it("a second apply run writes nothing and finds nothing left to close", async () => {
    const summary = await runDemoClose(app, { tenantSlug, apply: true });

    expect(summary.tenantFound).toBe(true);
    expect(summary.rows).toHaveLength(0);
    expect(summary.backfill).toBeNull();
    expect(summary.mismatches).toBe(0);
    expect(await activeRows(empE)).toHaveLength(2);
    expect(await auditRowsFor(app, "SaldoSnapshot", empE, "CREATE")).toHaveLength(1);
    expect(await activeRows(empF)).toHaveLength(0);
    expect(await activeRows(empH)).toHaveLength(1);
  });

  it("reports an unknown tenant slug without writing", async () => {
    const summary = await runDemoClose(app, { tenantSlug: "no-such-tenant-595", apply: true });
    expect(summary.tenantFound).toBe(false);
    expect(summary.rows).toHaveLength(0);
    expect(summary.backfill).toBeNull();
  });
});
