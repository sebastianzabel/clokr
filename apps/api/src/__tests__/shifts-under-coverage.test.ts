/**
 * Phase 76.23 — Under-coverage planner warning tests (§ 615 hybrid).
 *
 * Tests A–D verify:
 *   A. NO DRIFT (SC2): contractSollMinutesByEmp from GET /shifts/week equals the
 *      independently-computed 76.22 C_net for the same [monday, sunday] period.
 *      Uses calcExpectedMinutesTz from timezone utils as the reference — the same
 *      helper the endpoint calls — so the assertion is a genuine anti-drift guard.
 *
 *   B. AUSFALLPRINZIP (D-05): approved leave in the visible week reduces
 *      contractSollMinutesByEmp vs the same week without leave. The warning must
 *      not fire spuriously on legitimately reduced weeks.
 *
 *   C. UNDER-COVERAGE FIRES: when Σ assigned netto shifts < contractSoll, the
 *      server field supports the frontend computing geplant < Soll (gap > 0).
 *      When geplant ≥ Soll, gap ≤ 0.
 *
 *   D. PLANNING-ONLY (SC3 / D-04 / § 615): an under-rostered SHIFT_BASED
 *      employee's OvertimeAccount.balanceHours is UNCHANGED before/after calling
 *      GET /shifts/week — the planner warning never writes to OvertimeAccount.
 *
 * Setup pattern mirrors Phase 76.11 (shift-week-leave-absence-minutes.test.ts)
 * and the SHIFT_BASED fixture in overtime-calc.test.ts. Uses a future Monday
 * (> 4 weeks ahead) to avoid calendar collisions with other test suites.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { calcExpectedMinutesTz, calcLeaveAbsenceMinutesTz, weekRangeUtc } from "../utils/timezone";

const TZ = "Europe/Berlin";

function futureMondayIso(weeksAhead: number): string {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dow = today.getUTCDay(); // 0=Sun..6=Sat
  // Mirror the GET /week resolver logic (shifts.ts):
  // dow === 0 ? -6 : 1 - dow
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(today);
  monday.setUTCDate(monday.getUTCDate() + mondayOffset + weeksAhead * 7);
  return monday.toISOString().slice(0, 10);
}

function mondayDate(iso: string): Date {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// IN-01 fix (Phase 76.23): sundayDate now mirrors the production fix — it uses
// weekRangeUtc to produce the timezone-correct Sunday boundary, so the reference
// calcExpectedMinutesTz call in Test A exercises the same code path as the
// fixed GET /shifts/week handler and becomes a genuine anti-drift guard.
// The old setUTCHours(23,59,59,999) produced a UTC-Sunday end that caused
// iterateDaysInTz to count 8 days (not 7) in UTC+ timezones like Europe/Berlin
// CEST, matching the server's bug and masking it. This helper now calls
// weekRangeUtc with a noon-UTC anchor on the Monday so it always resolves the
// correct ISO week regardless of DST transitions.
function sundayDate(iso: string): Date {
  return weekRangeUtc(new Date(iso + "T12:00:00Z"), TZ).end;
}

describe("Phase 76.23 — contractSollMinutesByEmp in GET /shifts/week (§ 615 planning-only)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let vacationTypeId: string;
  let empId: string; // the SHIFT_BASED test employee
  let empUserId: string;
  let weekMonday: string; // ISO "YYYY-MM-DD" of the test week's Monday
  let monday: Date;
  let sunday: Date;

  // The SHIFT_BASED schedule object — mirrors what the endpoint returns for
  // the employee. We build it here to pass to calcExpectedMinutesTz in Test A.
  const schedule = {
    type: "SHIFT_BASED",
    weeklyHours: 40,
    mondayHours: 8,
    tuesdayHours: 8,
    wednesdayHours: 8,
    thursdayHours: 8,
    fridayHours: 8,
    saturdayHours: 0,
    sundayHours: 0,
    workDays: [1, 2, 3, 4, 5], // Mon–Fri
  };

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const suffix = "76-23-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // Use week 6 weeks ahead — avoids collision with other test suites that use
    // 4–5 weeks ahead (76.10, 76.11).
    weekMonday = futureMondayIso(6);
    monday = mondayDate(weekMonday);
    sunday = sundayDate(weekMonday);

    // ── Tenant + config ──────────────────────────────────────────────────────
    const tenant = await prisma.tenant.create({
      data: {
        name: `Phase 76.23 Test ${suffix}`,
        slug: `ph-76-23-${suffix}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: {
        tenantId,
        defaultVacationDays: 30,
        timezone: TZ,
      },
    });

    // ── Admin user (for GET /shifts/week auth) ───────────────────────────────
    const adminPasswordHash = await bcrypt.hash("test1234", 10);
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${suffix}@test.de`,
        passwordHash: adminPasswordHash,
        role: "ADMIN",
        isActive: true,
      },
    });
    const adminEmployee = await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${suffix}`,
        firstName: "Admin",
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: adminEmployee.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
    await prisma.overtimeAccount.create({
      data: { employeeId: adminEmployee.id, balanceHours: 0 },
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-${suffix}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken;

    // ── SHIFT_BASED employee ─────────────────────────────────────────────────
    const empUser = await prisma.user.create({
      data: {
        email: `emp-${suffix}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    empUserId = empUser.id;

    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: empUser.id,
        employeeNumber: `EMP-${suffix}`,
        firstName: "Shift",
        lastName: "Worker",
        hireDate: new Date("2024-01-01"),
      },
    });
    empId = emp.id;

    await prisma.workSchedule.create({
      data: {
        employeeId: empId,
        type: "SHIFT_BASED",
        weeklyHours: schedule.weeklyHours,
        mondayHours: schedule.mondayHours,
        tuesdayHours: schedule.tuesdayHours,
        wednesdayHours: schedule.wednesdayHours,
        thursdayHours: schedule.thursdayHours,
        fridayHours: schedule.fridayHours,
        saturdayHours: schedule.saturdayHours,
        sundayHours: schedule.sundayHours,
        workDays: schedule.workDays,
        validFrom: new Date("2024-01-01"),
      },
    });
    await prisma.overtimeAccount.create({
      data: { employeeId: empId, balanceHours: 0 },
    });

    // ── Leave type for vacation (Test B) ─────────────────────────────────────
    const vacationType = await prisma.leaveType.create({
      data: {
        tenantId,
        name: "Urlaub",
        isPaid: true,
        requiresApproval: true,
        color: "#3B82F6",
      },
    });
    vacationTypeId = vacationType.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Phase 76.23 test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Helper: GET /shifts/week for the test week ────────────────────────────
  async function getWeek() {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${weekMonday}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as {
      contractSollMinutesByEmp?: Record<string, number>;
      leaveMinutesByEmp?: Record<string, number>;
      absenceMinutesByEmp?: Record<string, number>;
      shifts?: Array<{ employeeId: string; startTime: string; endTime: string }>;
      shiftBreakMinutesByEmp?: Record<string, number>;
    };
  }

  // ── Test A: NO DRIFT ──────────────────────────────────────────────────────
  it("Test A: contractSollMinutesByEmp equals the 76.22 C_net for the same period (no drift)", async () => {
    // No leave/absence in this week — pure Ø-Methode for a Mon-Sun period.
    // Reference: C_net = max(0, calcExpectedMinutesTz − 0 − 0) + 0
    const expectedBase = calcExpectedMinutesTz(schedule, monday, sunday, TZ);
    const expectedCNet = Math.max(0, expectedBase);

    // IN-01 fix: pin the concrete expected value so this test is a genuine
    // anti-drift AND anti-off-by-one guard, not just a both-sides-same-bug check.
    // For a 40h Mon–Fri SHIFT_BASED schedule over exactly Mon–Sun (7 days),
    // Ø-Methode: weeklyHours × workdaysInRange / workDaysPerWeek
    //           = 40 × 60 × 5 / 5 = 2400 min (40h).
    // If this assertion fails at 2880 (48h), the CR-01 bug has regressed —
    // iterateDaysInTz is again counting 8 days (Mon–Mon) instead of 7 (Mon–Sun).
    expect(expectedCNet).toBe(2400);

    const body = await getWeek();
    const serverSoll = body.contractSollMinutesByEmp?.[empId];

    expect(serverSoll).toBeDefined();
    // Exact equality — the server must use the same formula, not a rounding variant.
    expect(serverSoll).toBe(expectedCNet);
    // Belt-and-suspenders: also assert the concrete value directly against the
    // server response so a future refactor that changes the reference formula
    // cannot silently mask the 40h→48h inflation.
    expect(serverSoll).toBe(2400);
  });

  // ── Test B: AUSFALLPRINZIP (D-05) ────────────────────────────────────────
  it("Test B: approved leave in the visible week reduces contractSollMinutesByEmp (Ausfallprinzip)", async () => {
    // Get baseline Soll without leave
    const bodyBefore = await getWeek();
    const sollWithoutLeave = bodyBefore.contractSollMinutesByEmp?.[empId] ?? 0;

    // Create 2-day APPROVED leave (Monday + Tuesday of the test week)
    const leaveStart = new Date(monday); // Monday
    const leaveEnd = new Date(monday);
    leaveEnd.setUTCDate(leaveEnd.getUTCDate() + 1); // Tuesday
    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: vacationTypeId,
        startDate: leaveStart,
        endDate: leaveEnd,
        days: 2,
        status: "APPROVED",
        reviewedBy: "system",
        reviewedAt: new Date(),
      },
    });

    const bodyAfter = await getWeek();
    const sollWithLeave = bodyAfter.contractSollMinutesByEmp?.[empId] ?? 0;

    // Soll must be lower with leave than without
    expect(sollWithLeave).toBeLessThan(sollWithoutLeave);

    // The reduction should match calcLeaveAbsenceMinutesTz for Mon+Tue of the week
    const expectedLeaveMin = calcLeaveAbsenceMinutesTz(schedule, leaveStart, leaveEnd, TZ);
    expect(sollWithoutLeave - sollWithLeave).toBe(expectedLeaveMin);

    // Cleanup leave — soft-delete to mirror production convention (CLAUDE.md).
    await app.prisma.leaveRequest.update({
      where: { id: leave.id },
      data: { deletedAt: new Date() },
    });
  });

  // ── Test C: UNDER-COVERAGE FIRES ─────────────────────────────────────────
  it("Test C: when Σ assigned netto shifts < contractSoll the gap is positive; when geplant > Soll the gap is negative", async () => {
    // The contractSoll for a 40h/week SHIFT_BASED employee over Mon-Sun
    // (Ø-Methode: weeklyHours × workdaysInRange / workDaysPerWeek)
    // for a standard Mon-Fri schedule over Mon-Sun = 40×60×5/5 = 2400 min.
    //
    // Under-coverage case: create just 1 × 4h shift (Mon) → geplant = 240 min << Soll.
    const shiftDate = new Date(monday); // Monday of test week
    const shift = await app.prisma.shift.create({
      data: {
        employeeId: empId,
        date: shiftDate,
        startTime: "08:00",
        endTime: "12:00", // 4h gross — below 6h threshold → 0 break → 240 min netto
      },
    });

    const body = await getWeek();
    const contractSollMin = body.contractSollMinutesByEmp?.[empId] ?? 0;
    const breakMin = body.shiftBreakMinutesByEmp?.[empId] ?? 0;

    // Compute geplant from returned shifts (mirror the frontend logic)
    const empShifts = (body.shifts ?? []).filter((s) => s.employeeId === empId);
    let grossMin = 0;
    for (const s of empShifts) {
      const [sh, sm] = s.startTime.split(":").map(Number);
      const [eh, em] = s.endTime.split(":").map(Number);
      grossMin += eh * 60 + em - (sh * 60 + sm);
    }
    const geplantMin = Math.max(0, grossMin - breakMin);

    // Under-rostered: 1 × 4h shift (240 min netto) << contractSoll (2400 min)
    expect(contractSollMin).toBeGreaterThan(0);
    expect(geplantMin).toBeLessThan(contractSollMin);
    const gap = contractSollMin - geplantMin;
    expect(gap).toBeGreaterThan(0);

    // Over-coverage case: add 7 × 12h shifts (Mon-Sun) — 12h gross, 45 min break
    // per shift (>9h threshold); netto = 7 × (720-45) = 7 × 675 = 4725 min.
    // This exceeds any contractSoll for a 40h/week schedule regardless of how
    // many workdays the Ø-Methode counts in the range (even at 7 workdays:
    // 40×60×7/5 = 3360 < 4725), so geplant > Soll and gap < 0.
    const additionalDates: Date[] = [];
    for (let i = 1; i <= 6; i++) {
      const d = new Date(monday);
      d.setUTCDate(d.getUTCDate() + i);
      additionalDates.push(d);
    }

    // Replace the Mon 4h shift with 12h, add 12h for Tue-Sun
    await app.prisma.shift.update({
      where: { id: shift.id },
      data: { startTime: "07:00", endTime: "19:00" }, // 12h gross
    });
    const additionalShifts = await Promise.all(
      additionalDates.map((d) =>
        app.prisma.shift.create({
          data: {
            employeeId: empId,
            date: d,
            startTime: "07:00",
            endTime: "19:00", // 12h gross each
          },
        }),
      ),
    );

    const bodyOver = await getWeek();
    const contractSollOver = bodyOver.contractSollMinutesByEmp?.[empId] ?? 0;
    const breakMinOver = bodyOver.shiftBreakMinutesByEmp?.[empId] ?? 0;
    const empShiftsOver = (bodyOver.shifts ?? []).filter((s) => s.employeeId === empId);
    let grossMinOver = 0;
    for (const s of empShiftsOver) {
      const [sh, sm] = s.startTime.split(":").map(Number);
      const [eh, em] = s.endTime.split(":").map(Number);
      grossMinOver += eh * 60 + em - (sh * 60 + sm);
    }
    const geplantMinOver = Math.max(0, grossMinOver - breakMinOver);

    // 7 × 12h gross − 7 × 45 min break = 7 × 675 = 4725 netto.
    // Even in the extreme case contractSoll = 40×60×7/5 = 3360 < 4725.
    // → geplant (4725) > contractSoll → gap < 0 → no under-coverage.
    expect(geplantMinOver).toBeGreaterThan(contractSollOver);
    const gapOver = contractSollOver - geplantMinOver;
    expect(gapOver).toBeLessThan(0);

    // Cleanup — soft-delete to mirror production convention (CLAUDE.md, Phase 67.2).
    await app.prisma.shift.updateMany({
      where: { id: { in: [shift.id, ...additionalShifts.map((s) => s.id)] } },
      data: { deletedAt: new Date() },
    });
  });

  // ── Test D: PLANNING-ONLY § 615 ──────────────────────────────────────────
  it("Test D (§ 615): under-rostered employee's OvertimeAccount.balanceHours is unchanged after GET /shifts/week", async () => {
    // Read the employee's OvertimeAccount BEFORE calling GET /shifts/week.
    const accountBefore = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: empId },
      select: { balanceHours: true },
    });
    expect(accountBefore).not.toBeNull();
    const balanceBefore = Number(accountBefore!.balanceHours);

    // The employee has no shifts in the test week — clearly under-rostered.
    // contractSollMin > 0, geplantMin = 0 → large under-coverage gap.
    const weekBody = await getWeek();
    const contractSollMin = weekBody.contractSollMinutesByEmp?.[empId] ?? 0;
    expect(contractSollMin).toBeGreaterThan(0); // confirms under-coverage scenario

    // Read OvertimeAccount AFTER the GET /shifts/week call.
    const accountAfter = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: empId },
      select: { balanceHours: true },
    });
    expect(accountAfter).not.toBeNull();
    const balanceAfter = Number(accountAfter!.balanceHours);

    // THE LOAD-BEARING ASSERTION: the planner endpoint must NEVER write to the
    // saldo. The balance must be byte-identical before and after (D-04, § 615).
    expect(balanceAfter).toBe(balanceBefore);

    // Extra: the balance must not be negative from the planning gap
    // (the § 615 guarantee — under-rostering is Betriebsrisiko, not employee debt).
    expect(balanceAfter).toBeGreaterThanOrEqual(0);
  });
});
