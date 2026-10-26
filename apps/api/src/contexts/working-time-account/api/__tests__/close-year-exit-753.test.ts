import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
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
import {
  expectedCloseMonthsOfYear,
  assignYearMonthSnapshots,
  resolveYearCarryOver,
} from "../../expected-close-months";
import { createPopulationPerson } from "../../../../__tests__/population-fixtures-613";
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
  async function createEmployee(
    suffix: string,
    exitDate: Date | null = null,
    hireDate: Date = new Date(`${year - 1}-01-01T00:00:00Z`),
  ) {
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
        hireDate,
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
  async function seedMonths(
    employeeId: string,
    snapshotYear: number,
    months: number[],
    overrides: { carryOver?: number } = {},
  ) {
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
          carryOver: overrides.carryOver ?? v.carryOver,
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
    expect(JSON.parse(res.body).error).toBe("Nicht alle Monate abgeschlossen. Fehlend: 6");
    expect(
      await app.prisma.saldoSnapshot.count({ where: { employeeId: emp.id, periodType: "YEARLY" } }),
    ).toBe(0);
  });

  it("refuses a year in which the person no longer worked", async () => {
    const emp = await createEmployee("t3", new Date(`${year - 1}-11-30T10:00:00Z`));
    const res = await postCloseYear(emp.id, year);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe(
      "Für dieses Jahr gibt es keine Monate zum Abschließen, weil die Person vor diesem Jahr ausgetreten ist.",
    );
  });

  it("refuses a year before the person was hired, worded by that cause", async () => {
    const emp = await createEmployee("t3b", null, new Date(`${year + 1}-02-01T00:00:00Z`));
    const res = await postCloseYear(emp.id, year);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe(
      "Für dieses Jahr gibt es keine Monate zum Abschließen, weil die Person erst nach diesem Jahr eingestellt wurde.",
    );
  });

  it("hired in March, left in June: Mar-Jun closed is enough (owner decision #763)", async () => {
    const emp = await createEmployee(
      "t5",
      new Date(`${year}-06-15T10:00:00Z`),
      new Date(`${year}-03-01T00:00:00Z`),
    );
    const months = [3, 4, 5, 6];
    await seedMonths(emp.id, year, months);
    const res = await postCloseYear(emp.id, year);
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).workedMinutes).toBe(sumMonths(months, "workedMinutes"));
  });

  it("hired in July: Jul-Dec closed is enough, and a missing month is named by number", async () => {
    const hired = new Date(`${year}-07-01T00:00:00Z`);
    const ok = await createEmployee("t6", null, hired);
    await seedMonths(ok.id, year, [7, 8, 9, 10, 11, 12]);
    const res = await postCloseYear(ok.id, year);
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).carryOver).toBe(monthValues(12).carryOver);

    const gap = await createEmployee("t6b", null, hired);
    await seedMonths(gap.id, year, [7, 8, 9, 11, 12]);
    const res2 = await postCloseYear(gap.id, year);
    expect(res2.statusCode).toBe(400);
    expect(JSON.parse(res2.body).error).toBe("Nicht alle Monate abgeschlossen. Fehlend: 10");
  });

  it("a duplicate pair in one month counts once and does not mask a missing month", async () => {
    const emp = await createEmployee("t7", new Date(`${year}-06-15T10:00:00Z`));
    await seedMonths(emp.id, year, [1, 2, 4, 5, 6]);
    // A legacy UTC-naive duplicate of February: six rows, but March still has none.
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: emp.id,
        periodType: "MONTHLY",
        periodStart: new Date(`${year}-02-01T00:00:00Z`),
        periodEnd: new Date(`${year}-02-28T00:00:00Z`),
        workedMinutes: 999_999,
        expectedMinutes: 1,
        balanceMinutes: 1,
        carryOver: 1,
        closedAt: new Date(),
        closedBy: "test-system",
        superseded: false,
      },
    });
    const res = await postCloseYear(emp.id, year);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Nicht alle Monate abgeschlossen. Fehlend: 3");
  });

  it("snapshots after the exit month are ignored (backdated exit)", async () => {
    const emp = await createEmployee("t8", new Date(`${year}-06-15T10:00:00Z`));
    await seedMonths(emp.id, year, [1, 2, 3, 4, 5, 6, 7, 8]);
    const res = await postCloseYear(emp.id, year);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.workedMinutes).toBe(sumMonths([1, 2, 3, 4, 5, 6], "workedMinutes"));
    expect(body.carryOver).toBe(monthValues(6).carryOver);
  });

  describe("carry-over rules and a year of exit (owner decision 26.10.2026)", () => {
    afterEach(async () => {
      await app.prisma.tenantConfig.update({
        where: { tenantId: data.tenant.id },
        data: { overtimeCarryOverMode: "FULL", overtimeCarryOverCap: null },
      });
    });
    const setRule = (mode: string, cap: number | null) =>
      app.prisma.tenantConfig.update({
        where: { tenantId: data.tenant.id },
        data: { overtimeCarryOverMode: mode, overtimeCarryOverCap: cap },
      });

    it("RESET does not zero a leaver's +20h", async () => {
      await setRule("RESET", null);
      const emp = await createEmployee("t9", new Date(`${year}-06-15T10:00:00Z`));
      await seedMonths(emp.id, year, [1, 2, 3, 4, 5, 6], { carryOver: 1200 });
      const res = await postCloseYear(emp.id, year);
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.carryOver).toBe(1200);
      expect(body.note).not.toContain("Reset");
      const acc = await app.prisma.overtimeAccount.findUnique({ where: { employeeId: emp.id } });
      expect(Number(acc?.balanceHours)).toBe(20);
    });

    it("RESET still zeroes a person who did not leave", async () => {
      await setRule("RESET", null);
      const emp = await createEmployee("t10");
      await seedMonths(emp.id, year, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], { carryOver: 1200 });
      const res = await postCloseYear(emp.id, year);
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).carryOver).toBe(0);
      expect(JSON.parse(res.body).note).toBe("Jahresübertrag: Reset auf 0");
    });

    it("CAPPED does not cap a leaver's +20h, but caps a non-leaver", async () => {
      await setRule("CAPPED", 600);
      const leaver = await createEmployee("t11", new Date(`${year}-06-15T10:00:00Z`));
      await seedMonths(leaver.id, year, [1, 2, 3, 4, 5, 6], { carryOver: 1200 });
      const res = await postCloseYear(leaver.id, year);
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).carryOver).toBe(1200);

      const stayer = await createEmployee("t12");
      await seedMonths(stayer.id, year, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], {
        carryOver: 1200,
      });
      const res2 = await postCloseYear(stayer.id, year);
      expect(res2.statusCode).toBe(201);
      expect(JSON.parse(res2.body).carryOver).toBe(600);
    });
  });

  it("a person who left in a later year keeps the tenant rule (not a year of exit)", () => {
    expect(
      resolveYearCarryOver({ finalCarryOver: 1200, mode: "RESET", cap: null, leftInYear: false })
        .appliedCarryOver,
    ).toBe(0);
  });

  it("a person without exit date still needs all twelve months", async () => {
    const emp = await createEmployee("t4");
    await seedMonths(emp.id, year, [1, 2, 3, 4, 5, 6]);
    const res = await postCloseYear(emp.id, year);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe(
      "Nicht alle Monate abgeschlossen. Fehlend: 7, 8, 9, 10, 11, 12",
    );
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
  it("is empty for a hire after the year", () => {
    expect(
      expectedCloseMonthsOfYear({
        year: 2025,
        tz,
        hireDate: d("2026-02-01T00:00:00Z"),
        exitDate: null,
      }),
    ).toEqual([]);
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

describe("assignYearMonthSnapshots (Issue #753)", () => {
  const tz = "Europe/Berlin";
  const row = (id: string, periodStart: string, closedAt = "2026-02-01T00:00:00Z") => ({
    id,
    periodStart: new Date(periodStart),
    closedAt: new Date(closedAt),
  });
  it("assigns one row per month, the smallest periodStart of a duplicate pair, ignores outsiders", () => {
    const rows = [
      row("feb-naive", "2025-02-01T00:00:00Z"),
      row("feb-tz", "2025-01-31T00:00:00Z"),
      row("jan-tz", "2024-12-31T00:00:00Z"),
      row("jul", "2025-06-30T00:00:00Z"),
    ];
    const r = assignYearMonthSnapshots(rows, [1, 2], 2025, tz);
    expect(r.missing).toEqual([]);
    expect(r.assigned.map((x) => x.id)).toEqual(["jan-tz", "feb-tz"]);
  });
  it("names a month without a row even when the row count suffices", () => {
    const rows = [
      row("jan", "2024-12-31T00:00:00Z"),
      row("feb", "2025-01-31T00:00:00Z"),
      row("feb2", "2025-02-01T00:00:00Z"),
    ];
    expect(assignYearMonthSnapshots(rows, [1, 2, 3], 2025, tz).missing).toEqual([3]);
  });
});

describe("auto-close cron yearly snapshot (Issue #753)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const Y = 2026;
  const TZ = "Europe/Berlin";

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cyc753");
  }, 120_000);

  afterAll(async () => {
    try {
      const ids = (
        await app.prisma.employee.findMany({
          where: { tenantId: data.tenant.id },
          select: { id: true },
        })
      ).map((e) => e.id);
      await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: ids } } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  afterEach(async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { overtimeCarryOverMode: "FULL", overtimeCarryOverCap: null },
    });
  });

  const person = (tag: string, exit: string | null, hire = `${Y}-01-01`) =>
    createPopulationPerson(app, {
      tenantId: data.tenant.id,
      salonId: data.salonId,
      tag,
      hireDate: new Date(`${hire}T00:00:00.000Z`),
      exitDate: exit ? new Date(`${exit}T10:00:00.000Z`) : null,
    });

  async function seed(employeeId: string, months: number[], carryOver = 1200) {
    for (const m of months) {
      const { start, end } = monthRangeUtc(Y, m, TZ);
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: start,
          periodEnd: end,
          workedMinutes: 1000 + m,
          expectedMinutes: 900 + m,
          balanceMinutes: 100,
          carryOver,
          closedAt: new Date("2027-01-02T06:00:00Z"),
          superseded: false,
        },
      });
    }
  }

  async function runCron(mode: string, cap: number | null) {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { overtimeCarryOverMode: mode, overtimeCarryOverCap: cap },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${Y + 1}-01-20T10:00:00Z`));
    try {
      await app.tryAutoCloseMonth();
    } finally {
      vi.useRealTimers();
    }
  }

  const yearly = (employeeId: string) =>
    app.prisma.saldoSnapshot.findMany({
      where: { employeeId, periodType: "YEARLY", superseded: false },
    });

  it("RESET: a leaver keeps +20h, a non-leaver is reset", async () => {
    const leaver = await person("l1", `${Y}-06-15`);
    const stayer = await person("s1", null);
    await seed(leaver.employeeId, [1, 2, 3, 4, 5, 6]);
    await seed(stayer.employeeId, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    await runCron("RESET", null);
    const l = await yearly(leaver.employeeId);
    expect(l).toHaveLength(1);
    expect(l[0].carryOver).toBe(1200);
    expect(l[0].note).not.toContain("Reset");
    const s = await yearly(stayer.employeeId);
    expect(s).toHaveLength(1);
    expect(s[0].carryOver).toBe(0);
    expect(s[0].note).toBe("Automatischer Jahresübertrag: Reset auf 0");
  });

  it("CAPPED: a leaver is not capped, a non-leaver is", async () => {
    const leaver = await person("l2", `${Y}-06-15`);
    const stayer = await person("s2", null);
    await seed(leaver.employeeId, [1, 2, 3, 4, 5, 6]);
    await seed(stayer.employeeId, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    await runCron("CAPPED", 600);
    expect((await yearly(leaver.employeeId))[0].carryOver).toBe(1200);
    expect((await yearly(stayer.employeeId))[0].carryOver).toBe(600);
  });

  it("a duplicate pair in one month does not mask a month without a row", async () => {
    const leaver = await person("l3", `${Y}-06-15`);
    await seed(leaver.employeeId, [1, 2, 4, 5, 6]);
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: leaver.employeeId,
        periodType: "MONTHLY",
        periodStart: new Date(`${Y}-02-01T00:00:00Z`),
        periodEnd: new Date(`${Y}-02-28T00:00:00Z`),
        workedMinutes: 1,
        expectedMinutes: 1,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date("2027-01-02T06:00:00Z"),
        superseded: false,
      },
    });
    await runCron("FULL", null);
    expect(await yearly(leaver.employeeId)).toHaveLength(0);
  });

  it("snapshots after a backdated exit are ignored", async () => {
    const leaver = await person("l4", `${Y}-06-15`);
    await seed(leaver.employeeId, [1, 2, 3, 4, 5, 6, 7, 8]);
    await runCron("FULL", null);
    const y = await yearly(leaver.employeeId);
    expect(y).toHaveLength(1);
    expect(y[0].workedMinutes).toBe([1, 2, 3, 4, 5, 6].reduce((a, m) => a + 1000 + m, 0));
  });
});

describe("one expected-months computation (Issue #753 guard)", () => {
  const root = join(__dirname, "..", "..");
  const read = (f: string) => readFileSync(join(root, f), "utf8");
  it("cron and close-year route both call expectedCloseMonthsOfYear", () => {
    for (const f of ["plugins/auto-close-month.ts", "api/overtime.ts"]) {
      expect(read(f)).toMatch(/expectedCloseMonthsOfYear\(/);
    }
  });
  it("cron and route both use the shared month assignment and carry-over decision", () => {
    for (const f of ["plugins/auto-close-month.ts", "api/overtime.ts"]) {
      expect(read(f)).toMatch(/assignYearMonthSnapshots\(/);
      expect(read(f)).toMatch(/resolveYearCarryOver\(/);
    }
    // No hand-rolled per-month find or `.length` comparison left next to the yearly close.
    expect(read("plugins/auto-close-month.ts")).not.toMatch(/monthSnapshots\.length\s*</);
    expect(read("api/overtime.ts")).not.toMatch(/monthSnapshots\.find\(/);
  });
  it("no second month-span computation in the cron", () => {
    expect(read("plugins/auto-close-month.ts")).not.toMatch(/lastMonth\s*-\s*firstMonth/);
  });
});
