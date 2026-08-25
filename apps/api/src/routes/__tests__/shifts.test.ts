import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";
import { getHolidays } from "../../utils/holidays";
import { closeEmployeeMonth } from "../../utils/close-employee-month";
import { monthRangeUtc, monthDayBounds, calcExpectedMinutesTz } from "../../utils/timezone";
import type { CloseMonthInput } from "../../utils/close-employee-month";

/**
 * Phase 76.12 Plan 02 — Smoke tests for GET /api/v1/shifts/week
 *
 * Verifies that the leaveMinutesByEmp + absenceMinutesByEmp aggregation
 * (Phase 76.11 code path) now uses calcLeaveAbsenceMinutesTz with:
 *  - VOCATIONAL_SCHOOL + PATTERN Absence filter at the Prisma layer
 *  - LeaveRequest.halfDay honored end-to-end
 *  - BAG 9 AZR 406/17 Ø-Methode math (NOT the broken × Kalendertage ÷ 7)
 *
 * Fixture: A.S.-style SHIFT_BASED employee (weeklyHours=38, tue/wed/thu/fri=9.5).
 * No full names — initials only (memory `feedback_no_pii_in_github`).
 */
describe("GET /shifts/week — Ø-Methode leave/absence aggregation (Phase 76.12)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let asEmployeeId: string;

  // Week containing Fri 2026-06-05 → Monday is 2026-06-01.
  const WEEK_START = "2026-06-01";

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "shifts-svc-76-12");

    // Create an A.S.-style SHIFT_BASED employee (weeklyHours=38, Mo=0h, Di-Fr=9.5h).
    // Initials only — no PII per memory feedback_no_pii_in_github.
    const asUser = await app.prisma.user.create({
      data: {
        email: `as-${data.tenant.id.slice(0, 8)}@test.de`,
        passwordHash: "test-only-hash",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const asEmployee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: asUser.id,
        employeeNumber: `AS-${data.tenant.id.slice(0, 6)}`,
        firstName: "A.",
        lastName: "S.",
        classification: "TEILZEIT",
        hireDate: new Date("2024-01-01"),
      },
    });
    asEmployeeId = asEmployee.id;

    await app.prisma.workSchedule.create({
      data: {
        employeeId: asEmployee.id,
        type: "SHIFT_BASED",
        weeklyHours: 38,
        // workDays explicit (soll-ignores-workdays-on-legacy-schedules fix):
        // avgWorkMinutesCore is now workDays-primary. Without this, the row
        // would silently inherit the Prisma schema default workDays=[1..5]
        // (includes Monday, which this fixture does NOT work per
        // mondayHours=0 below) — the opposite-direction divergence a
        // workDays-primary divisor must NOT trust. Setting it explicitly to
        // the fixture's real Tue-Fri pattern matches what normalizeWorkDays()
        // would derive from these same {day}Hours in production and keeps
        // this test's expected values (570/285min) unchanged.
        workDays: [2, 3, 4, 5],
        mondayHours: 0,
        tuesdayHours: 9.5,
        wednesdayHours: 9.5,
        thursdayHours: 9.5,
        fridayHours: 9.5,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });

    await app.prisma.overtimeAccount.create({
      data: { employeeId: asEmployee.id, balanceHours: 0 },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("A.S. SHIFT_BASED 1-day-Fri Urlaub yields leaveMinutes=570 (NOT 977 from broken formula)", async () => {
    // Seed APPROVED LeaveRequest for Fri 2026-06-05, halfDay=false.
    const lr = await app.prisma.leaveRequest.create({
      data: {
        employeeId: asEmployeeId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-06-05"),
        endDate: new Date("2026-06-05"),
        days: 1,
        halfDay: false,
        status: "APPROVED",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${WEEK_START}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      leaveMinutesByEmp: Record<string, number>;
    };

    // Ø-Methode: 38h × 60min × 1 workday-in-range / 4 workdays-per-week = 570min
    // Broken formula was: 38 × 60 × 1 / 7 ≈ 326 OR × 9.5 / 7 × 60 = 81 OR
    // many wrong shapes; what matters here is the new helper returns exactly 570
    // for this fixture (Fri only, A.S. fri=9.5 → 38/4 × 1 = 9.5h = 570min).
    expect(body.leaveMinutesByEmp[asEmployeeId]).toBe(570);

    // Cleanup leave for next test
    await app.prisma.leaveRequest.delete({ where: { id: lr.id } });
  });

  it("excludes DSGVO-anonymized employees from the week grid employees list", async () => {
    const uid = `anon-week-${Date.now().toString(36)}`;
    const anonUser = await app.prisma.user.create({
      data: {
        email: `deleted-${uid}@anonymized.local`,
        passwordHash: "ANONYMIZED",
        role: "EMPLOYEE",
        isActive: false,
      },
    });
    const anonEmp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: anonUser.id,
        firstName: "Gelöscht",
        lastName: `GELÖSCHT-${uid}`,
        employeeNumber: `GELÖSCHT-${uid}`,
        hireDate: new Date("2024-01-01"),
      },
    });
    // Anonymized employees keep a SHIFT_BASED schedule for retention — must STILL be hidden.
    await app.prisma.workSchedule.create({
      data: {
        employeeId: anonEmp.id,
        type: "SHIFT_BASED",
        weeklyHours: 38,
        validFrom: new Date("2024-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: anonEmp.id, balanceHours: 0 } });

    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/week?date=${WEEK_START}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { employees: Array<{ id: string }> };
      expect(body.employees.some((e) => e.id === anonEmp.id)).toBe(false);
      // sanity: the non-anonymized A.S. fixture IS present
      expect(body.employees.some((e) => e.id === asEmployeeId)).toBe(true);
    } finally {
      await app.prisma.workSchedule.deleteMany({ where: { employeeId: anonEmp.id } });
      await app.prisma.overtimeAccount.deleteMany({ where: { employeeId: anonEmp.id } });
      await app.prisma.employee.delete({ where: { id: anonEmp.id } });
      await app.prisma.user.delete({ where: { id: anonUser.id } });
    }
  });

  it("VOCATIONAL_SCHOOL + PATTERN Absence is excluded from absenceMinutes (BBiG §15)", async () => {
    // Seed an Absence type=VOCATIONAL_SCHOOL, source=PATTERN on Tue 2026-06-02.
    const ab = await app.prisma.absence.create({
      data: {
        employeeId: asEmployeeId,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: new Date("2026-06-02"),
        endDate: new Date("2026-06-02"),
        days: 1,
        createdBy: data.adminUser.id,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${WEEK_START}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      absenceMinutesByEmp: Record<string, number>;
    };

    // VOCATIONAL_SCHOOL+PATTERN MUST be filtered out at Prisma layer per D-11.
    // A.S. has no other absences this week → absenceMinutes for A.S. is undefined or 0.
    const minutes = body.absenceMinutesByEmp[asEmployeeId] ?? 0;
    expect(minutes).toBe(0);

    await app.prisma.absence.delete({ where: { id: ab.id } });
  });

  it("halfDay LeaveRequest reduces leaveMinutes to half (285 = round(570/2))", async () => {
    const lr = await app.prisma.leaveRequest.create({
      data: {
        employeeId: asEmployeeId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-06-05"),
        endDate: new Date("2026-06-05"),
        days: 0.5,
        halfDay: true,
        status: "APPROVED",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${WEEK_START}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      leaveMinutesByEmp: Record<string, number>;
    };

    // Math.round(570 / 2) = 285. Per D-06 (halfDay applies to TOTAL, not per-day).
    expect(body.leaveMinutesByEmp[asEmployeeId]).toBe(285);

    await app.prisma.leaveRequest.delete({ where: { id: lr.id } });
  });
});

/**
 * Phase 104 (D-15, Tier 2) — day-based Soll dedup for the Schichtplanung planner Soll.
 *
 * NOTE (project memory): this file has historically carried date-dependent tests that
 * expire — every date below is computed relative to `new Date()` at test-run time, never
 * hard-coded, and the target week is verified holiday-free (Niedersachsen) before use so
 * the fixture's expected minutes never silently drift.
 */
describe("GET /shifts/week — day-based Soll dedup (Phase 104, D-15 Tier 2)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  /** Monday `weeksAhead` weeks from today (UTC), zeroed to midnight. */
  function mondayWeeksFromNow(weeksAhead: number): Date {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    const dow = d.getUTCDay();
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    d.setUTCDate(d.getUTCDate() + mondayOffset + weeksAhead * 7);
    return d;
  }
  function isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
  function addDays(d: Date, n: number): Date {
    const r = new Date(d);
    r.setUTCDate(r.getUTCDate() + n);
    return r;
  }
  /** A hireDate/validFrom anchor safely in the past relative to "now" — computed, not
   * hard-coded, so this fixture never becomes a future-dated time-bomb. */
  function farPastJan1(): Date {
    return new Date(Date.UTC(new Date().getUTCFullYear() - 5, 0, 1));
  }

  /** First Monday (searching forward from `startWeeksAhead`) whose Mon-Sun span has
   * zero Niedersachsen public holidays — keeps the fixture's expected minutes exact
   * without hard-coding a calendar date. */
  function findCleanMonday(startWeeksAhead: number): Date {
    for (let w = startWeeksAhead; w < startWeeksAhead + 104; w++) {
      const monday = mondayWeeksFromNow(w);
      const sunday = addDays(monday, 6);
      const years = new Set([monday.getUTCFullYear(), sunday.getUTCFullYear()]);
      const holidayDates = new Set<string>();
      for (const y of years) {
        for (const h of getHolidays(y, "NI")) holidayDates.add(h.date);
      }
      const mondayStr = isoDate(monday);
      const sundayStr = isoDate(sunday);
      let clean = true;
      for (const hd of holidayDates) {
        if (hd >= mondayStr && hd <= sundayStr) {
          clean = false;
          break;
        }
      }
      if (clean) return monday;
    }
    throw new Error("no holiday-free week found within 104 weeks");
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "shifts-104-dedup");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  /** Fresh SHIFT_BASED employee, weeklyHours=40, uniform 8h Mon-Fri, workDays explicit
   * (workDays-primary — see the A.S. fixture's own comment above for why this matters). */
  async function createEmployee(): Promise<string> {
    const s = `d15-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `${s}@test.de`,
        passwordHash: "test-only-hash",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `D15-${s}`,
        firstName: "Dedup",
        lastName: s,
        hireDate: farPastJan1(),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        workDays: [1, 2, 3, 4, 5],
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: farPastJan1(),
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    return emp.id;
  }

  async function approvedLeave(employeeId: string, startDateStr: string, endDateStr: string) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(startDateStr + "T00:00:00Z"),
        endDate: new Date(endDateStr + "T00:00:00Z"),
        days: 1,
        status: "APPROVED",
      },
    });
  }

  it("Test 1: overlapping VACATION Mo-Mi + SICK Di-Mi reduces the planner Soll by 3 distinct days, not 5 day-credits", async () => {
    const monday = findCleanMonday(6);
    const empId = await createEmployee();
    await approvedLeave(empId, isoDate(monday), isoDate(addDays(monday, 2))); // Mon-Wed
    await approvedLeave(empId, isoDate(addDays(monday, 1)), isoDate(addDays(monday, 2))); // Tue-Wed overlap

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${isoDate(monday)}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      contractSollMinutesByEmp: Record<string, number>;
    };

    // baseSoll = 40h = 2400min (no holiday in the clean week).
    // Without the fix: leaveMin = 3*480 (Mon-Wed) + 2*480 (Tue-Wed, doubled) = 2400
    //   -> contractSoll = max(0, 2400-2400) = 0.
    // With the fix: 3 distinct days (Mon,Tue,Wed) claimed once = 1440
    //   -> contractSoll = max(0, 2400-1440) = 960min = 16h.
    expect(body.contractSollMinutesByEmp[empId]).toBe(960);
  });

  it("Test 2: the planner Soll's credited minutes equal closeEmployeeMonth()'s sbLeaveCredit for the identical overlap", async () => {
    const monday = findCleanMonday(7);
    const empId = await createEmployee();
    const lr1 = await approvedLeave(empId, isoDate(monday), isoDate(addDays(monday, 2))); // Mon-Wed
    await approvedLeave(empId, isoDate(addDays(monday, 1)), isoDate(addDays(monday, 2))); // Tue-Wed overlap

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${isoDate(monday)}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      leaveMinutesByEmp: Record<string, number>;
      absenceMinutesByEmp: Record<string, number>;
    };
    const plannerCredit =
      (body.leaveMinutesByEmp[empId] ?? 0) + (body.absenceMinutesByEmp[empId] ?? 0);
    expect(plannerCredit).toBe(1440);

    // Cross-check against the shared saldo core (Tier 1): both requests live entirely
    // inside the target week, so closeEmployeeMonth()'s sbLeaveCredit for the containing
    // month — derived from the SAME two rows, the SAME sortForDedup ordering rule, and
    // the SAME Ø-Methode schedule — must equal the planner's credited minutes exactly.
    // No drifting second Soll (Phase 76.23, D-02) — now proven for the § 9 overlap case,
    // not just asserted.
    const schedule = await app.prisma.workSchedule.findFirstOrThrow({
      where: { employeeId: empId },
    });
    const tz = "Europe/Berlin";
    const year = monday.getUTCFullYear();
    const month = monday.getUTCMonth() + 1;
    const { start, end } = monthRangeUtc(year, month, tz);
    const { firstDay, lastDay } = monthDayBounds(start, end, tz);
    const approvedLeaveRows = await app.prisma.leaveRequest.findMany({
      where: { employeeId: empId, status: "APPROVED", deletedAt: null },
      select: { startDate: true, endDate: true, halfDay: true },
    });
    const contractSollMonth = calcExpectedMinutesTz(
      schedule as unknown as Record<string, unknown>,
      start,
      end,
      tz,
    );
    const result = closeEmployeeMonth({
      employeeId: empId,
      monthStart: start,
      monthEnd: end,
      monthFirstDay: firstDay,
      monthLastDay: lastDay,
      tz,
      carryOverIn: 0,
      schedule: schedule as unknown as Record<string, unknown>,
      hireDate: farPastJan1(),
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: null,
      breakOver9hOverride: null,
      entries: [],
      shifts: [],
      approvedLeave: approvedLeaveRows as CloseMonthInput["approvedLeave"],
      absences: [],
      holidayDateStrings: new Set<string>(),
      tenantConfig: null,
      employeeSlots: null,
      patternSlots: null,
      patternUnterrichtsMinutenByDow: null,
    });
    const monthCredit = contractSollMonth - result.expectedMinutes;
    expect(monthCredit).toBe(plannerCredit);

    await app.prisma.leaveRequest.delete({ where: { id: lr1.id } });
  });

  it("Test 3 (parity): a week with no overlapping requests produces the planner Soll a non-overlap fixture must always produce", async () => {
    const monday = findCleanMonday(8);
    const empId = await createEmployee();
    await approvedLeave(empId, isoDate(monday), isoDate(monday)); // Mon only, no overlap

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${isoDate(monday)}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      contractSollMinutesByEmp: Record<string, number>;
    };
    // No two rows share a day, so the dedup mechanism is a structural no-op: this MUST
    // equal what the pre-Phase-104 code already produced (2400 - 480 = 1920 = 32h).
    expect(body.contractSollMinutesByEmp[empId]).toBe(1920);
  });

  it("Test 4 (WR-02 preserved): a holiday inside the overlapping range is still excluded exactly once", async () => {
    const monday = findCleanMonday(9);
    const empId = await createEmployee();
    // Declare a DB PublicHoliday override on Wednesday of the target week — deterministic
    // regardless of the real German holiday calendar.
    const wednesday = addDays(monday, 2);
    await app.prisma.publicHoliday.create({
      data: {
        tenantId: data.tenant.id,
        date: wednesday,
        name: "D-15 Test Feiertag",
        federalState: "NIEDERSACHSEN",
        year: wednesday.getUTCFullYear(),
      },
    });
    // VACATION Mon-Wed, Wed also a declared holiday — WR-02 says the leave credit must
    // NOT also claim Wed a second time on top of the holiday deduction already baked
    // into baseSoll.
    await approvedLeave(empId, isoDate(monday), isoDate(wednesday));

    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/week?date=${isoDate(monday)}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        contractSollMinutesByEmp: Record<string, number>;
      };
      // baseSoll = 2400 - 480 (Wed holiday) = 1920. Leave credit: Wed already excluded
      // (seeded from the holiday set) -> only Mon+Tue credited = 960.
      // contractSoll = max(0, 1920-960) = 960min = 16h.
      // If the D-15 claim set were NOT seeded from the holiday set (a regression of
      // WR-02), Wed would be credited a second time -> 1920-1440=480, a different,
      // wrong value this assertion would catch.
      expect(body.contractSollMinutesByEmp[empId]).toBe(960);
    } finally {
      await app.prisma.publicHoliday.deleteMany({
        where: { tenantId: data.tenant.id, date: wednesday },
      });
    }
  });
});
