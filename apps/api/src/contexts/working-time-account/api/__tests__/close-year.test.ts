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

/**
 * Issue #242 — POST /api/v1/overtime/close-year had ZERO test coverage of any kind before
 * this file (RESEARCH.md). It rejects a Europe/Berlin tenant's fully-closed year FOREVER,
 * and the rejection message names the wrong missing month: a naive UTC year-range filter
 * drops January's periodStart (tenant-local month start, stored one day into the PREVIOUS
 * December for this timezone), and the month-number derivation used to name the gap
 * (`getUTCMonth() + 1` on that same tenant-local periodStart) is off by one for every month.
 * A third defect: the FOLLOWING January's periodStart also lands inside a naive year-range
 * filter and — before the fix — gets misread as the last (December) month of the year under
 * close, corrupting both the yearly total and the carried-over balance.
 *
 * Five cases, seeded with a Europe/Berlin tenant (`seedTestData`'s default) so the tenant
 * timezone is what actually exercises the bug (a UTC fixture would pass identically before
 * and after the fix).
 *
 * No PII in fixtures (memory feedback_no_pii_in_github) — synthetic initials only, as in the
 * sibling `opening-balance-endpoint.test.ts`.
 */
describe("POST /overtime/close-year (Issue #242)", () => {
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
    data = await seedTestData(app, "cy02");
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
  async function createEmployee(suffix: string) {
    const passwordHash = await bcrypt.hash("test1234", 10);
    const s = `${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cy02-${s}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `CY02-${s}`,
        firstName: "Test",
        lastName: suffix,
        hireDate: new Date(`${year}-01-01T00:00:00Z`),
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

  it("Test 1: twelve closed months -> 201, sums all twelve, carryOver = December's, periodStart stays naive", async () => {
    const emp = await createEmployee("t1");
    const allMonths = Array.from({ length: 12 }, (_, i) => i + 1);
    await seedMonths(emp.id, year, allMonths);

    const res = await postCloseYear(emp.id, year);
    expect(res.statusCode).toBe(201);

    const body = JSON.parse(res.body);
    expect(body.workedMinutes).toBe(sumMonths(allMonths, "workedMinutes"));
    expect(body.carryOver).toBe(monthValues(12).carryOver);
    // D-01: the YEARLY snapshot's stored periodStart identity stays the naive UTC year start —
    // it must NOT be converted through the tenant timezone.
    expect(String(body.periodStart).slice(0, 10)).toBe(`${year}-01-01`);

    const account = await app.prisma.overtimeAccount.findUnique({ where: { employeeId: emp.id } });
    expect(Number(account?.balanceHours)).toBe(monthValues(12).carryOver / 60);
  });

  it("Test 2: missing January is reported as January, not December", async () => {
    const emp = await createEmployee("t2");
    await seedMonths(emp.id, year, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    const res = await postCloseYear(emp.id, year);
    expect(res.statusCode).toBe(400);

    const body = JSON.parse(res.body);
    // Sharp assertion on purpose (not toContain("1")) — "Fehlend: 11, 12" would also contain
    // "1" and make this test decorative.
    expect(body.error).toMatch(/Fehlend: 1$/);
  });

  it("Test 3: missing December is reported as December — the fix must not filter December out", async () => {
    const emp = await createEmployee("t3");
    await seedMonths(emp.id, year, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    const res = await postCloseYear(emp.id, year);
    expect(res.statusCode).toBe(400);

    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/Fehlend: 12$/);
  });

  it("Test 4: the following year's already-closed January does not bleed into this year's total", async () => {
    const emp = await createEmployee("t4");
    const allMonths = Array.from({ length: 12 }, (_, i) => i + 1);
    await seedMonths(emp.id, year, allMonths);

    // An outlier MONTHLY snapshot for January of year+1 — stored periodStart lands on
    // `${year}-12-31` (monthRangeUtc TZ conversion truncated to @db.Date) and therefore falls
    // inside a naive [${year}-01-01, ${year}-12-31] range filter too. Deliberately far outside
    // any real value so a leak is unmistakable.
    const { start: nextJanStart, end: nextJanEnd } = monthRangeUtc(year + 1, 1, TZ);
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: emp.id,
        periodType: "MONTHLY",
        periodStart: nextJanStart,
        periodEnd: nextJanEnd,
        workedMinutes: 999_999,
        expectedMinutes: 999_999,
        balanceMinutes: 0,
        carryOver: 555_555,
        closedAt: new Date(),
        closedBy: "test-system",
        superseded: false,
      },
    });

    const res = await postCloseYear(emp.id, year);
    expect(res.statusCode).toBe(201);

    const body = JSON.parse(res.body);
    expect(body.workedMinutes).toBe(sumMonths(allMonths, "workedMinutes"));
    expect(body.carryOver).toBe(monthValues(12).carryOver);
  });

  it("Test 5: an already-closed year is still rejected with 409 on a second close", async () => {
    const emp = await createEmployee("t5");
    const allMonths = Array.from({ length: 12 }, (_, i) => i + 1);
    await seedMonths(emp.id, year, allMonths);

    const first = await postCloseYear(emp.id, year);
    expect(first.statusCode).toBe(201);

    const second = await postCloseYear(emp.id, year);
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error).toBe("Jahr ist bereits abgeschlossen");

    const yearly = await app.prisma.saldoSnapshot.findMany({
      where: { employeeId: emp.id, periodType: "YEARLY", superseded: false },
    });
    expect(yearly.length).toBe(1);
  });
});
