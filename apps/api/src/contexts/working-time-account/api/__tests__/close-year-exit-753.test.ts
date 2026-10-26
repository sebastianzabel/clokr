import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
} from "../../../../__tests__/setup";
import { monthRangeUtc } from "../../timezone";
import type { FastifyInstance } from "fastify";

/** Issue #753 - the manual yearly close expects months only through the exit month. */
import { expectedCloseMonthsOfYear } from "../../expected-close-months";
import { readFileSync } from "node:fs";
import { join } from "node:path";
describe("POST /overtime/close-year for a leaver (Issue #753)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  const TZ = "Europe/Berlin";
  // Always a fully past year — the handler's own `yearEnd > new Date()` guard would otherwise
  // 400 every case for a reason unrelated to what this file tests, and no clock manipulation
  // is needed to arrange that (CLOKR_TEST_FAKE_CLOCK only shifts time within today — unusable
  // for a year boundary, per docs/testing.md).
  const year = new Date().getUTCFullYear() - 1;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cy753");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  /** Create a fresh Employee (own User + WorkSchedule + OvertimeAccount) in `data`'s tenant. */
  async function createEmployee(suffix: string, exitDate: Date | null = null) {
    const passwordHash = await bcrypt.hash("test1234", 10);
    const s = `${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cy753-${s}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `CY753-${s}`,
        firstName: "Test",
        lastName: suffix,
        hireDate: new Date(`${year - 1}-01-01T00:00:00Z`),
        exitDate,
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date(`${year}-01-01T00:00:00Z`),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: 0 },
    });
    return employee;
  }

  /** Per-month, distinguishable-by-construction values — no two months share a total. */
  function monthValues(month: number) {
    const workedMinutes = 10_000 + month;
    const expectedMinutes = 8_000 + month;
    return {
      workedMinutes,
      expectedMinutes,
      balanceMinutes: workedMinutes - expectedMinutes,
      carryOver: month * 100,
    };
  }

  /** Seed a MONTHLY SaldoSnapshot for each of `months` of `snapshotYear`, via monthRangeUtc
   *  — the same tenant-timezone conversion the API paths use, so periodStart is stored under
   *  the TZ-converted convention (RESEARCH.md, snapshot-period.ts docblock). */
  async function seedMonths(employeeId: string, snapshotYear: number, months: number[]) {
    for (const month of months) {
      const { start, end } = monthRangeUtc(snapshotYear, month, TZ);
      const v = monthValues(month);
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: start,
          periodEnd: end,
          workedMinutes: v.workedMinutes,
          expectedMinutes: v.expectedMinutes,
          balanceMinutes: v.balanceMinutes,
          carryOver: v.carryOver,
          closedAt: new Date(),
          closedBy: "test-system",
          superseded: false,
        },
      });
    }
  }

  function postCloseYear(employeeId: string, closeYear: number) {
    return app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-year",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId, year: closeYear },
    });
  }

  function sumMonths(months: number[], field: "workedMinutes" | "expectedMinutes") {
    return months.reduce((s, m) => s + monthValues(m)[field], 0);
  }

  it("closes the year after six closed months for a person who left in June", async () => {
    const emp = await createEmployee("t1", new Date(`${year}-06-15T10:00:00Z`));
    const months = [1, 2, 3, 4, 5, 6];
    await seedMonths(emp.id, year, months);

    const res = await postCloseYear(emp.id, year);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.workedMinutes).toBe(sumMonths(months, "workedMinutes"));
    expect(body.expectedMinutes).toBe(sumMonths(months, "expectedMinutes"));
    // The carry-over is the exit month's, not a December that never existed.
    expect(body.carryOver).toBe(monthValues(6).carryOver);
    expect(String(body.periodStart).slice(0, 10)).toBe(`${year}-01-01`);
  });

  it("still names the missing month for a leaver (exit month open -> 400)", async () => {
    const emp = await createEmployee("t2", new Date(`${year}-06-15T10:00:00Z`));
    await seedMonths(emp.id, year, [1, 2, 3, 4, 5]);
    const res = await postCloseYear(emp.id, year);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("Fehlend: 6");
    expect(
      await app.prisma.saldoSnapshot.count({ where: { employeeId: emp.id, periodType: "YEARLY" } }),
    ).toBe(0);
  });

  it("refuses a year in which the person no longer worked", async () => {
    const emp = await createEmployee("t3", new Date(`${year - 1}-11-30T10:00:00Z`));
    const res = await postCloseYear(emp.id, year);
    expect(res.statusCode).toBe(400);
  });

  it("a person without exit date still needs all twelve months", async () => {
    const emp = await createEmployee("t4");
    await seedMonths(emp.id, year, [1, 2, 3, 4, 5, 6]);
    const res = await postCloseYear(emp.id, year);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("Fehlend: 7, 8, 9, 10, 11, 12");
  });
});

describe("expectedCloseMonthsOfYear (Issue #753)", () => {
  const tz = "Europe/Berlin";
  const d = (s: string) => new Date(s);
  it("covers the whole year without hire or exit in it", () => {
    expect(
      expectedCloseMonthsOfYear({
        year: 2025,
        tz,
        hireDate: d("2020-01-01T00:00:00Z"),
        exitDate: null,
      }),
    ).toHaveLength(12);
  });
  it("starts at the hire month when hired in the year (cron)", () => {
    expect(
      expectedCloseMonthsOfYear({
        year: 2025,
        tz,
        hireDate: d("2025-07-01T00:00:00Z"),
        exitDate: null,
      }),
    ).toEqual([7, 8, 9, 10, 11, 12]);
  });
  it("ignores the hire date when none is passed (manual route)", () => {
    expect(
      expectedCloseMonthsOfYear({ year: 2025, tz, hireDate: null, exitDate: null }),
    ).toHaveLength(12);
  });
  it("ends at the exit month in the tenant zone", () => {
    // 2025-06-30 23:30 UTC is already 1 July in Berlin.
    expect(
      expectedCloseMonthsOfYear({
        year: 2025,
        tz,
        hireDate: null,
        exitDate: d("2025-06-30T23:30:00Z"),
      }),
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it("is empty after an exit in an earlier year, and ignores a later exit", () => {
    expect(
      expectedCloseMonthsOfYear({
        year: 2025,
        tz,
        hireDate: null,
        exitDate: d("2024-12-31T10:00:00Z"),
      }),
    ).toEqual([]);
    expect(
      expectedCloseMonthsOfYear({
        year: 2025,
        tz,
        hireDate: null,
        exitDate: d("2026-02-01T10:00:00Z"),
      }),
    ).toHaveLength(12);
  });
});

describe("one expected-months computation (Issue #753 guard)", () => {
  const root = join(__dirname, "..", "..");
  const read = (f: string) => readFileSync(join(root, f), "utf8");
  it("cron and close-year route both call expectedCloseMonthsOfYear", () => {
    for (const f of ["plugins/auto-close-month.ts", "api/overtime.ts"]) {
      expect(read(f)).toMatch(/expectedCloseMonthsOfYear\(\{/);
    }
  });
  it("no second month-span computation in the cron", () => {
    expect(read("plugins/auto-close-month.ts")).not.toMatch(/lastMonth\s*-\s*firstMonth/);
  });
});
