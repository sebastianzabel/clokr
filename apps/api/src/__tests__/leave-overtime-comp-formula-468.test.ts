/**
 * Issue #468, finding 1 (D-01) — ONE function (`scheduledLeaveMinutes` in leave.ts) prices every
 * Überstundenausgleich amount: the POST/PATCH negative-balance gate, the approval booking, the
 * cancellation-reversal legacy fallback, `/correct`, and GET /hours-preview. For every
 * non-SHIFT_BASED type it calls the saldo's own per-row function (`calcLeaveAbsenceMinutesTz`,
 * reached through `contexts/working-time-account`) instead of reading the `{day}Hours`
 * placeholders — so a FLEXTIME day costs the real Ø-Methode average (480 min), not the measured
 * placeholder's 60. Holidays AND Berufsschultage are excluded exactly like the saldo's own
 * exclusion set. The negative-balance gate now also runs on the PENDING edit (`PATCH
 * /requests/:id`), closing the gap where POST enforced the limit but widening an already-created
 * PENDING request did not.
 *
 * RED before this plan's leave.ts changes: FLEXTIME priced 60 min/day instead of 480 (the old
 * `getScheduledHours` placeholder-hours branch), the Berufsschultag exclusion did not apply to
 * FIXED_SCHEDULE OVERTIME_COMP pricing, and the PENDING-edit gate did not exist at all (any
 * widening of a still-PENDING OVERTIME_COMP request was accepted unconditionally).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { calcLeaveAbsenceMinutesTz, getTenantTimezone } from "../contexts/working-time-account";
import { getHolidays, STATE_MAP } from "../contexts/platform/holidays";
import type { FastifyInstance } from "fastify";

/**
 * Computes the next Monday at least 14 days out from `now` (UTC arithmetic), advanced past any
 * NI (Niedersachsen — this file's fixture tenant's federalState) public holiday. Mirrors
 * `leave-overtime-comp-confirmed-check.test.ts`'s own helper (not exported there) — see that
 * file's docblock for why this must be computed rather than a hardcoded literal.
 */
function computeRequestMonday(now: Date): string {
  let candidate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 14),
  );
  const daysUntilMonday = (8 - candidate.getUTCDay()) % 7;
  candidate = new Date(
    Date.UTC(
      candidate.getUTCFullYear(),
      candidate.getUTCMonth(),
      candidate.getUTCDate() + daysUntilMonday,
    ),
  );
  for (let i = 0; i < 10; i++) {
    const iso = candidate.toISOString().slice(0, 10);
    const holidays = getHolidays(candidate.getUTCFullYear(), STATE_MAP.NIEDERSACHSEN);
    if (!holidays.some((h: { date: string }) => h.date === iso)) return iso;
    candidate = new Date(
      Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), candidate.getUTCDate() + 7),
    );
  }
  throw new Error("computeRequestMonday: exceeded bound without a non-holiday Monday");
}

describe("Überstundenausgleich — ONE formula for gate, booking and preview (Issue #468, D-01)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let overtimeCompTypeId: string;
  let f1EmployeeId: string;
  let f1Token: string;
  let m1EmployeeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "ot468f");

    const overtimeCompType = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("OVERTIME_COMP"), color: "#8B5CF6" },
    });
    overtimeCompTypeId = overtimeCompType.id;

    // F1 — FLEXTIME, weeklyHours 40, Mo–Fr, {day}Hours uniformly 1.00 (the measured legacy
    // placeholder CLAUDE.md names for this type).
    const f1PasswordHash = data.adminUser.passwordHash;
    const f1User = await app.prisma.user.create({
      data: {
        email: `ot468f-f1-${Date.now().toString(36)}@test.de`,
        passwordHash: f1PasswordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const f1Employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: f1User.id,
        employeeNumber: `OT468F-F1-${Date.now().toString(36)}`,
        firstName: "FL",
        lastName: "EX",
        hireDate: new Date("2024-01-01"),
      },
    });
    f1EmployeeId = f1Employee.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId: f1EmployeeId,
        type: "FLEXTIME",
        weeklyHours: 40,
        monthlyHours: null,
        mondayHours: 1,
        tuesdayHours: 1,
        wednesdayHours: 1,
        thursdayHours: 1,
        fridayHours: 1,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2024-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: f1EmployeeId, balanceHours: 0 },
    });
    const f1Login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: f1User.email, password: "test1234" },
    });
    f1Token = JSON.parse(f1Login.body).accessToken;

    // M1 — MONTHLY_HOURS, monthlyHours 80, workDays Mo–Fr.
    const m1User = await app.prisma.user.create({
      data: {
        email: `ot468f-m1-${Date.now().toString(36)}@test.de`,
        passwordHash: data.adminUser.passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const m1Employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: m1User.id,
        employeeNumber: `OT468F-M1-${Date.now().toString(36)}`,
        firstName: "MO",
        lastName: "NT",
        hireDate: new Date("2024-01-01"),
      },
    });
    m1EmployeeId = m1Employee.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId: m1EmployeeId,
        type: "MONTHLY_HOURS",
        weeklyHours: null,
        monthlyHours: 80,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2024-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: m1EmployeeId, balanceHours: 0 },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("leave-overtime-comp-formula-468 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("FLEXTIME hours-preview for one workday: minutesNeeded 480, hours 8 (RED: 60 / 1)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/hours-preview?startDate=2027-03-02&endDate=2027-03-02", // Tuesday
      headers: { authorization: `Bearer ${f1Token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(
      body.minutesNeeded,
      "FLEXTIME day costs the Ø-Methode 480 min, not the 60 placeholder",
    ).toBe(480);
    expect(body.hours).toBe(8);
  });

  it("FLEXTIME approval stores overtimeCompMinutes=480 and books -8.00 (RED: 60 / -1.00)", async () => {
    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: f1EmployeeId,
        leaveTypeId: overtimeCompTypeId,
        startDate: new Date("2027-03-02"), // Tuesday
        endDate: new Date("2027-03-02"),
        days: 1,
        status: "PENDING",
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${leave.id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).overtimeCompMinutes).toBe(480);

    const acct = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: f1EmployeeId },
    });
    const tx = await app.prisma.overtimeTransaction.findFirst({
      where: { overtimeAccountId: acct!.id },
      orderBy: { createdAt: "desc" },
    });
    expect(tx?.type).toBe("REDUCTION");
    expect(Number(tx?.hours)).toBe(-8);
  });

  it("FLEXTIME half day costs 240 min", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/hours-preview?startDate=2027-03-03&endDate=2027-03-03&halfDay=true", // Wednesday
      headers: { authorization: `Bearer ${f1Token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).minutesNeeded).toBe(240);
  });

  it("FLEXTIME range Mon–Wed with a manual salon holiday on the Wednesday costs 960 (2 full days)", async () => {
    await app.prisma.publicHoliday.create({
      data: {
        tenantId: data.tenant.id,
        salonId: data.salonId!,
        date: new Date("2027-03-09"), // Wednesday inside the 08-10 range
        name: "Stadtfest Test",
        federalState: "NIEDERSACHSEN",
        year: 2027,
      },
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/leave/hours-preview?startDate=2027-03-08&endDate=2027-03-10",
        headers: { authorization: `Bearer ${f1Token}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(JSON.parse(res.body).minutesNeeded).toBe(960);
    } finally {
      await app.prisma.publicHoliday.deleteMany({
        where: { tenantId: data.tenant.id, date: new Date("2027-03-09") },
      });
    }
  });

  it("FIXED_SCHEDULE: a Berufsschultag inside the range costs nothing (960, RED: 1440); the same range without it costs 1440 (unchanged FIXED amount)", async () => {
    // Absence.type is a plain LeaveTypeCode enum column, not an FK — no LeaveType row needed
    // (mirrors leave-bs-day-448.test.ts's createBsAbsence helper).
    const bsAbsence = await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        startDate: new Date("2027-03-17"), // Wednesday inside the 15-17 range
        endDate: new Date("2027-03-17"),
        days: 1,
        halfDay: false,
        createdBy: "test-system",
      },
    });
    try {
      const resWithBs = await app.inject({
        method: "GET",
        url: `/api/v1/leave/hours-preview?startDate=2027-03-15&endDate=2027-03-17&employeeId=${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(resWithBs.statusCode, resWithBs.body).toBe(200);
      expect(JSON.parse(resWithBs.body).minutesNeeded).toBe(960);
    } finally {
      await app.prisma.absence.delete({ where: { id: bsAbsence.id } });
    }

    const resWithoutBs = await app.inject({
      method: "GET",
      url: `/api/v1/leave/hours-preview?startDate=2027-03-15&endDate=2027-03-17&employeeId=${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(resWithoutBs.statusCode, resWithoutBs.body).toBe(200);
    expect(
      JSON.parse(resWithoutBs.body).minutesNeeded,
      "FIXED_SCHEDULE amount is unchanged by this plan",
    ).toBe(1440);
  });

  it("MONTHLY_HOURS: the booked minutes equal calcLeaveAbsenceMinutesTz's own answer (relational — Phase 433 changes the value, not this test)", async () => {
    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: m1EmployeeId,
        leaveTypeId: overtimeCompTypeId,
        startDate: new Date("2027-03-02"),
        endDate: new Date("2027-03-02"),
        days: 1,
        status: "PENDING",
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${leave.id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(res.statusCode, res.body).toBe(200);

    const schedule = await app.prisma.workSchedule.findFirst({
      where: { employeeId: m1EmployeeId },
      orderBy: { validFrom: "desc" },
    });
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    const expectedMinutes = calcLeaveAbsenceMinutesTz(
      schedule as unknown as Record<string, unknown>,
      new Date("2027-03-02"),
      new Date("2027-03-02"),
      tz,
      { halfDay: false, excludeHolidays: new Set<string>() },
    );

    const reloaded = await app.prisma.leaveRequest.findUnique({ where: { id: leave.id } });
    expect(reloaded?.overtimeCompMinutes).toBe(expectedMinutes);
  });

  it("POST gate: FLEXTIME with confirmed carry-over of 4h (no tolerance) rejects an 8h request — requested 8, available 4 (RED: 201)", async () => {
    const requestMonday = computeRequestMonday(new Date());

    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: f1EmployeeId,
        periodType: "MONTHLY",
        periodStart: new Date("2027-01-01T00:00:00Z"),
        periodEnd: new Date("2027-01-31T00:00:00Z"),
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 240, // 4h confirmed
        closedAt: new Date(),
        closedBy: "test-system",
      },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${f1Token}` },
        payload: { type: "OVERTIME_COMP", startDate: requestMonday, endDate: requestMonday },
      });
      expect(res.statusCode, res.body).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.requested).toBeCloseTo(8, 5);
      expect(body.available).toBeCloseTo(4, 5);
    } finally {
      await app.prisma.saldoSnapshot.deleteMany({
        where: { employeeId: f1EmployeeId, periodStart: new Date("2027-01-01T00:00:00Z") },
      });
    }
  });

  it("PENDING-edit gate: FLEXTIME with confirmed 10h may POST one day but not widen it to two (RED: no gate existed, 200)", async () => {
    const requestMonday = computeRequestMonday(new Date());
    const requestMondayDate = new Date(requestMonday + "T00:00:00Z");
    const requestTuesdayDate = new Date(requestMondayDate);
    requestTuesdayDate.setUTCDate(requestTuesdayDate.getUTCDate() + 1);
    const requestTuesday = requestTuesdayDate.toISOString().slice(0, 10);

    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: f1EmployeeId,
        periodType: "MONTHLY",
        periodStart: new Date("2027-02-01T00:00:00Z"),
        periodEnd: new Date("2027-02-28T00:00:00Z"),
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 600, // 10h confirmed
        closedAt: new Date(),
        closedBy: "test-system",
      },
    });
    try {
      const postRes = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${f1Token}` },
        payload: { type: "OVERTIME_COMP", startDate: requestMonday, endDate: requestMonday },
      });
      expect(postRes.statusCode, postRes.body).toBe(201);
      const created = JSON.parse(postRes.body);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${created.id}`,
        headers: { authorization: `Bearer ${f1Token}` },
        payload: { startDate: requestMonday, endDate: requestTuesday, halfDay: false },
      });
      expect(patchRes.statusCode, patchRes.body).toBe(400);
      expect(JSON.parse(patchRes.body).error).toContain("Nicht genug Überstunden");

      const reloaded = await app.prisma.leaveRequest.findUnique({ where: { id: created.id } });
      expect(
        reloaded?.endDate.toISOString().slice(0, 10),
        "the rejected widen must not have written new dates",
      ).toBe(requestMonday);
    } finally {
      await app.prisma.saldoSnapshot.deleteMany({
        where: { employeeId: f1EmployeeId, periodStart: new Date("2027-02-01T00:00:00Z") },
      });
    }
  });

  it("widening a VACATION request on PATCH /requests/:id is unaffected by the OVERTIME_COMP gate", async () => {
    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: f1EmployeeId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2027-03-22"),
        endDate: new Date("2027-03-22"),
        days: 1,
        status: "PENDING",
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${leave.id}`,
      headers: { authorization: `Bearer ${f1Token}` },
      payload: { startDate: "2027-03-22", endDate: "2027-03-24", halfDay: false },
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});
