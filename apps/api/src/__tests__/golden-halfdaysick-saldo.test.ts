/**
 * Phase 76.32.1 Part B — SPEC-DERIVED golden verification: half-day SICK saldo
 *
 * OBJECTIVE: prove that the Monatsabschluss CORRECTLY halves the Soll-reduction
 * for a half-day SICK LeaveRequest (`halfDay=true, days=0.5, status=APPROVED`).
 *
 * Expected behaviour per spec (Ausfallprinzip, calcLeaveAbsenceMinutesTz halfDay branch):
 *   calcLeaveAbsenceMinutesTz(schedule, sickDay, sickDay, tz, { halfDay: true })
 *   → raw / 2 for FIXED_SCHEDULE (Math.round(480/2) = 240)
 *   → raw / 2 for SHIFT_BASED    (Math.round(456/2) = 228 using avgWorkMinutesCore)
 *
 * TWO golden cells (spec-derived, NEVER adjusted to match code):
 *
 * CELL A — fw-40-5-halfdaysick (FIXED_SCHEDULE, 40h/5-day, Feb 2026)
 *   Schedule:     FW_40_5  — Mon-Fri 8h, dailySoll = 480 min
 *   Month:        February 2026 (20 workdays, no holidays)
 *   Sick day:     2026-02-16 (Mon), halfDay=true — employee works the other 240 min
 *   Other 19 days: full entry (480 min each)
 *
 *   Derivation (FIXED_SCHEDULE path, close-employee-month.ts L570-581):
 *     calcLeaveAbsenceMinutesTz(schedule, feb16, feb16, TZ, { halfDay: true })
 *       raw = 480 (mondayHours=8, single day)
 *       → Math.round(480/2) = 240  (timezone.ts L438)
 *     leaveMinutes = 240
 *     workedMinutes = 19×480 + 240 = 9360    (entries only)
 *     expectedMinutes = calcExpectedMinutesTz = 20×480 = 9600
 *     holidayMinutes = 0; absenceMinutes = 0
 *     netExpected = max(0, 9600 - 0 - 240 - 0) = 9360
 *     balanceMinutes = Math.round(9360 - 9360) = 0
 *     carryOver      = 0 + 0 = 0
 *
 *   RED scenario (if halfDay is IGNORED by close):
 *     leaveMinutes = 480; netExpected = 9120; balanceMinutes = +240  ← phantom positive
 *
 * CELL B — sb-38-5-halfdaysick (SHIFT_BASED, 38h/5-day, Jan 2026)
 *   Schedule:     SB_38_5  — Mon-Fri 7.6h, dailySoll = round(38×60/5) = 456 min
 *   Month:        January 2026 (22 workdays Mon-Fri, including Jan 01 Thu)
 *   Sick day:     2026-01-09 (Fri), halfDay=true — employee works the other 228 min
 *   Seeding note: Jan 01 is NOT seeded as entry or shift (employee just starts Jan 02).
 *                 The contractSoll still covers Jan 01 (no PublicHoliday seeded).
 *                 Non-sick non-Jan01 days: 20 days × 456 min.
 *
 *   Derivation (SHIFT_BASED path, close-employee-month.ts L475-487):
 *     calcLeaveAbsenceMinutesTz(schedule, jan09, jan09, TZ, { halfDay: true })
 *       type=SHIFT_BASED → avgWorkMinutesCore: weeklyHours=38, workDaysPerWeek=5, workdaysInRange=1
 *       raw = Math.round(38×60×1/5) = 456
 *       → Math.round(456/2) = 228   (timezone.ts L438)
 *     sbLeaveCredit = 228
 *     coveredDates includes 2026-01-09 → sick day's shift excluded from shiftMinutes
 *     shiftMinutes (R)  = 20 × 456 = 9120   (Jan01 not shifted, Jan09 sick day excluded)
 *     workedMinutes (W) = 20 × 456 + 228 = 9348  (entries: 20 full days + half sick day)
 *     contractSoll = avgWorkMinutesCore(Jan1-31) = Math.round(38×60×22/5) = 10032
 *                    (22 Mo-Fr days in Jan 2026 including Jan01 Thu, no holidays)
 *     cNet = max(0, 10032 - 228 - 0) + 0 = 9804   (close-employee-month.ts L499)
 *     calcShiftBasedSaldo({C: 9804, R: 9120, W: 9348}):
 *       overtimeMinutes  = max(0, 9348 - 9804) = 0
 *       undertimeMinutes = max(0, 9120 - 9348) = 0   (§615: R<W, employer gap)
 *       balanceDelta = 0
 *     shiftBalanceOverride = 0 + (0 - 0) = 0   (bsWorked=0, bsExpected=0)
 *     balanceMinutes = Math.round(0) = 0
 *     carryOver      = 0 + 0 = 0
 *     expectedMinutes (stored) = cNet = 9804   ← KEY DISCRIMINATING ASSERTION
 *
 *   RED scenario (if halfDay is IGNORED by close — sbLeaveCredit ignores opts.halfDay):
 *     sbLeaveCredit = 456 (full day); cNet = 10032 - 456 = 9576
 *     calcShiftBasedSaldo({C: 9576, R: 9120, W: 9348}):
 *       overtimeMinutes  = max(0, 9348 - 9576) = 0
 *       undertimeMinutes = max(0, 9120 - 9348) = 0
 *       balanceDelta = 0  (balance stays 0 — same result!)
 *     → balanceMinutes = 0 in BOTH cases (D-01 floors absorb the difference here)
 *     → BUT expectedMinutes (cNet stored) = 9576 ≠ 9804 (WRONG — Soll under-credited)
 *     The discriminating assertion is expectedMinutes: 9804 (correct) vs 9576 (wrong).
 *
 * GREEN → close correctly halves half-day SICK for both schedule types.
 * RED   → close mis-values half-day SICK → SURFACED-DEFECT; escalate Part C scope.
 *
 * CRITICAL: expected values are derived from spec (above), NOT from code. A RED
 * cell is marked it.fails() with a SURFACED-DEFECT comment, never weakened.
 *
 * References:
 *   timezone.ts L401-440 (calcLeaveAbsenceMinutesTz, halfDay branch)
 *   close-employee-month.ts L475-487 (SHIFT_BASED sbLeaveCredit halfDay)
 *   close-employee-month.ts L570-581 (FIXED non-SHIFT leaveMinutes halfDay)
 *   golden-matrix.test.ts (harness pattern, seeder, pure-core assertion)
 *   golden-azubi-jan2026.test.ts (LeaveRequest seeding pattern)
 */

import { describe, it, expect, afterAll } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { monthRangeUtc, monthDayBounds } from "../utils/timezone";
import type { CloseMonthInput } from "../utils/close-employee-month";
import { closeEmployeeMonth } from "../utils/close-employee-month";
import bcrypt from "bcryptjs";

const TZ = "Europe/Berlin";

// ── Spec-derived golden constants ─────────────────────────────────────────────

/**
 * CELL A — FIXED_SCHEDULE 40h/5-day, Feb 2026, one half-day SICK on Feb 16.
 *
 * Derivation (see file-level comment above):
 *   workedMinutes = 19×480 + 240 = 9360
 *   expectedMinutes = netExpected = max(0, 9600 - 0 - 240 - 0) = 9360
 *   balanceMinutes = 9360 - 9360 = 0
 *   carryOver = 0
 *
 * If halfDay were IGNORED by close:
 *   expectedMinutes = 9120, balanceMinutes = +240 (phantom positive)
 */
const FW_SICK_WORKED = 9360; // 19×480 + 240
const FW_SICK_EXPECTED = 9360; // netExpected = 9600 - 240
const FW_SICK_BALANCE = 0;
const FW_SICK_CARRY = 0;

/**
 * CELL B — SHIFT_BASED 38h/5-day, Jan 2026, one half-day SICK on Jan 9.
 *
 * Seeding layout (see file-level comment above):
 *   - JAN_MO_FR in seeder = 21 dates (Jan02–Jan30, EXCLUDING Jan01 and the sick day Jan09)
 *     plus the sick day Jan09 itself = 21 total dates seeded.
 *   - Jan 01 (Thu) is NOT seeded as entry or shift → no entry for it.
 *   - contractSoll covers all 22 Mo-Fr days in Jan (including Jan01, no holidays seeded).
 *
 * Derivation (see file-level comment above):
 *   sbLeaveCredit = 228  (avgWorkMinutesCore for single Friday = 456, /2 = 228)
 *   shiftMinutes (R)  = 20 × 456 = 9120   (20 non-sick, non-Jan01 shifts)
 *   workedMinutes (W) = 20 × 456 + 228 = 9348  (20 full + sick half)
 *   contractSoll      = Math.round(38×60×22/5) = 10032  (22 Mo-Fr days, no holidays)
 *   cNet              = max(0, 10032 - 228) = 9804
 *   D-01: overtimeMinutes = max(0, 9348-9804) = 0; undertimeMinutes = max(0, 9120-9348) = 0
 *   balanceDelta = 0 → balanceMinutes = 0; carryOver = 0
 *   expectedMinutes (stored cNet) = 9804  ← KEY discriminating assertion vs 9576 if ignored
 *
 * If halfDay were IGNORED by close:
 *   sbLeaveCredit = 456; cNet = 9576; expectedMinutes stored = 9576 (WRONG)
 *   (balanceMinutes stays 0 in both cases — the discriminating assertion is expectedMinutes)
 */
const SB_SICK_WORKED = 9348; // 20×456 + 228 (Jan01 not seeded, 20 full days + sick half)
const SB_SICK_EXPECTED = 9804; // cNet = 10032 - halfDay(228); discriminates vs 9576 if ignored
const SB_SICK_BALANCE = 0;
const SB_SICK_CARRY = 0;

// ── Seeder helpers ────────────────────────────────────────────────────────────

interface SeededContext {
  tenantId: string;
  employeeId: string;
  scheduleType: "FIXED_SCHEDULE" | "SHIFT_BASED";
}

/**
 * Seed a minimal scenario for the FIXED_SCHEDULE half-day SICK cell.
 *
 * February 2026, 40h/5-day, Mon-Fri 8h each.
 * Half-day SICK LeaveRequest on 2026-02-16 (Mon), halfDay=true.
 * Entry for 240 min on the sick day + full 480 min on the other 19 Mon-Fri days.
 */
async function seedFixedSick(app: FastifyInstance): Promise<SeededContext> {
  const prisma = app.prisma;
  const s = `hds-fw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

  const tenant = await prisma.tenant.create({
    data: { name: `HDS-FW ${s}`, slug: s, federalState: "NIEDERSACHSEN" },
  });
  const tenantId = tenant.id;
  await prisma.tenantConfig.create({
    data: { tenantId, defaultVacationDays: 30, timezone: TZ },
  });

  const empUser = await prisma.user.create({
    data: {
      email: `emp-${s}@hds.test`,
      passwordHash: await bcrypt.hash("test1234", 10),
      role: "EMPLOYEE",
      isActive: true,
    },
  });
  const emp = await prisma.employee.create({
    data: {
      tenantId,
      userId: empUser.id,
      employeeNumber: `HDS-FW-${s}`,
      firstName: "Test",
      lastName: "HDS-FW",
      hireDate: new Date("2024-01-01T00:00:00Z"),
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
    },
  });
  const employeeId = emp.id;

  await prisma.workSchedule.create({
    data: {
      employeeId,
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
      overtimeMode: "CARRY_FORWARD",
      validFrom: new Date("2024-01-01T00:00:00Z"),
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId, balanceHours: 0 } });

  // Jan 2026 zero-snapshot anchor (prior month)
  const { start: janStart, end: janEnd } = monthRangeUtc(2026, 1, TZ);
  await prisma.saldoSnapshot.create({
    data: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: janStart,
      periodEnd: janEnd,
      workedMinutes: 0,
      expectedMinutes: 0,
      balanceMinutes: 0,
      carryOver: 0,
      closedAt: new Date(),
      closedBy: "test-seed",
    },
  });

  // Feb 2026 Mon-Fri dates
  const FEB_MO_FR = [
    "2026-02-02",
    "2026-02-03",
    "2026-02-04",
    "2026-02-05",
    "2026-02-06",
    "2026-02-09",
    "2026-02-10",
    "2026-02-11",
    "2026-02-12",
    "2026-02-13",
    "2026-02-16",
    "2026-02-17",
    "2026-02-18",
    "2026-02-19",
    "2026-02-20",
    "2026-02-23",
    "2026-02-24",
    "2026-02-25",
    "2026-02-26",
    "2026-02-27",
  ];

  const SICK_DATE = "2026-02-16";

  // Time entries: 240 min on sick day, 480 on all others
  for (const dateStr of FEB_MO_FR) {
    const netto = dateStr === SICK_DATE ? 240 : 480;
    const start = new Date(dateStr + "T08:00:00Z");
    const end = new Date(start.getTime() + netto * 60_000);
    await prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date(dateStr + "T00:00:00Z"),
        startTime: start,
        endTime: end,
        breakMinutes: 0,
        type: "WORK",
      },
    });
  }

  // Half-day SICK LeaveRequest on 2026-02-16
  const lt = await prisma.leaveType.create({
    data: { tenantId, name: "Krankenstand", isPaid: true },
  });
  await prisma.leaveRequest.create({
    data: {
      employeeId,
      leaveTypeId: lt.id,
      status: "APPROVED",
      startDate: new Date(SICK_DATE + "T00:00:00Z"),
      endDate: new Date(SICK_DATE + "T00:00:00Z"),
      days: 0.5,
      halfDay: true,
    },
  });

  return { tenantId, employeeId, scheduleType: "FIXED_SCHEDULE" };
}

/**
 * Seed a minimal scenario for the SHIFT_BASED half-day SICK cell.
 *
 * January 2026, 38h/5-day, Mon-Fri 7.6h each. dailySoll = round(38×60/5) = 456 min.
 * Half-day SICK LeaveRequest on 2026-01-09 (Fri), halfDay=true.
 * Shift on sick day is seeded but excluded by coveredDates.
 * Entry for 228 min on sick day + full 456 min entries on the other 21 Mon-Fri days.
 * No holidays seeded (matches spec — Neujahr not seeded for this cell to isolate halfDay logic).
 */
async function seedShiftSick(app: FastifyInstance): Promise<SeededContext> {
  const prisma = app.prisma;
  const s = `hds-sb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

  const tenant = await prisma.tenant.create({
    data: { name: `HDS-SB ${s}`, slug: s, federalState: "NIEDERSACHSEN" },
  });
  const tenantId = tenant.id;
  await prisma.tenantConfig.create({
    data: { tenantId, defaultVacationDays: 30, timezone: TZ },
  });

  const empUser = await prisma.user.create({
    data: {
      email: `emp-${s}@hds.test`,
      passwordHash: await bcrypt.hash("test1234", 10),
      role: "EMPLOYEE",
      isActive: true,
    },
  });
  const emp = await prisma.employee.create({
    data: {
      tenantId,
      userId: empUser.id,
      employeeNumber: `HDS-SB-${s}`,
      firstName: "Test",
      lastName: "HDS-SB",
      hireDate: new Date("2025-12-01T00:00:00Z"),
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
    },
  });
  const employeeId = emp.id;

  await prisma.workSchedule.create({
    data: {
      employeeId,
      type: "SHIFT_BASED",
      weeklyHours: 38,
      mondayHours: 7.6,
      tuesdayHours: 7.6,
      wednesdayHours: 7.6,
      thursdayHours: 7.6,
      fridayHours: 7.6,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [1, 2, 3, 4, 5],
      overtimeMode: "CARRY_FORWARD",
      validFrom: new Date("2025-12-01T00:00:00Z"),
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId, balanceHours: 0 } });

  // Dec-2025 zero-snapshot anchor
  const { start: decStart, end: decEnd } = monthRangeUtc(2025, 12, TZ);
  await prisma.saldoSnapshot.create({
    data: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: decStart,
      periodEnd: decEnd,
      workedMinutes: 0,
      expectedMinutes: 0,
      balanceMinutes: 0,
      carryOver: 0,
      closedAt: new Date(),
      closedBy: "test-seed",
    },
  });

  // Jan 2026 Mon-Fri (22 workdays — includes Jan 01 which would be a holiday in reality,
  // but we seed NO PublicHoliday rows for this cell to isolate the halfDay SICK logic)
  const JAN_MO_FR = [
    "2026-01-02",
    "2026-01-05",
    "2026-01-06",
    "2026-01-07",
    "2026-01-08",
    "2026-01-09",
    "2026-01-12",
    "2026-01-13",
    "2026-01-14",
    "2026-01-15",
    "2026-01-16",
    "2026-01-19",
    "2026-01-20",
    "2026-01-21",
    "2026-01-22",
    "2026-01-23",
    "2026-01-26",
    "2026-01-27",
    "2026-01-28",
    "2026-01-29",
    "2026-01-30",
  ];
  // Jan 01 (Thu) excluded — not seeded (would be holiday; not relevant for this cell)

  const SICK_DATE = "2026-01-09"; // Friday

  // Shifts: all 21 non-sick Mon-Fri days at 456 min. Sick day has NO shift
  // (the half-day SICK covers the whole day from the scheduling perspective;
  // coveredDates excludes a halfDay date from shift counting — see find-missing-workdays.ts L21).
  // NOTE: even if we seeded a shift on the sick day, coveredDates would exclude it.
  // We omit it for clarity.
  for (const dateStr of JAN_MO_FR) {
    if (dateStr === SICK_DATE) continue; // no shift on sick day
    const totalH = Math.floor(456 / 60);
    const totalM = 456 % 60;
    const endHHMM = `${String(8 + totalH).padStart(2, "0")}:${String(totalM).padStart(2, "0")}`;
    await prisma.shift.create({
      data: {
        employeeId,
        date: new Date(dateStr + "T00:00:00Z"),
        startTime: "08:00",
        endTime: endHHMM,
        deletedAt: null,
      },
    });
  }

  // Time entries: 228 min on sick day, 456 on all other 21 days
  for (const dateStr of JAN_MO_FR) {
    const netto = dateStr === SICK_DATE ? 228 : 456;
    const start = new Date(dateStr + "T08:00:00Z");
    const end = new Date(start.getTime() + netto * 60_000);
    await prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date(dateStr + "T00:00:00Z"),
        startTime: start,
        endTime: end,
        breakMinutes: 0,
        type: "WORK",
      },
    });
  }

  // Half-day SICK LeaveRequest on 2026-01-09
  const lt = await prisma.leaveType.create({
    data: { tenantId, name: "Krankenstand", isPaid: true },
  });
  await prisma.leaveRequest.create({
    data: {
      employeeId,
      leaveTypeId: lt.id,
      status: "APPROVED",
      startDate: new Date(SICK_DATE + "T00:00:00Z"),
      endDate: new Date(SICK_DATE + "T00:00:00Z"),
      days: 0.5,
      halfDay: true,
    },
  });

  return { tenantId, employeeId, scheduleType: "SHIFT_BASED" };
}

// ── Test helpers ──────────────────────────────────────────────────────────────

async function buildCoreInput(
  app: FastifyInstance,
  ctx: SeededContext,
  monthStart: Date,
  monthEnd: Date,
  tz: string,
): Promise<CloseMonthInput> {
  const { firstDay, lastDay } = monthDayBounds(monthStart, monthEnd, tz);
  const prisma = app.prisma;

  const schedule = await prisma.workSchedule.findFirst({ where: { employeeId: ctx.employeeId } });
  const employee = await prisma.employee.findUnique({ where: { id: ctx.employeeId } });
  const entries = await prisma.timeEntry.findMany({
    where: { employeeId: ctx.employeeId, deletedAt: null },
    select: { date: true, startTime: true, endTime: true, breakMinutes: true },
  });
  const shifts = await prisma.shift.findMany({
    where: { employeeId: ctx.employeeId, deletedAt: null },
    select: { date: true, startTime: true, endTime: true },
  });
  const approvedLeave = await prisma.leaveRequest.findMany({
    where: { employeeId: ctx.employeeId, status: "APPROVED", deletedAt: null },
    select: { startDate: true, endDate: true, halfDay: true },
  });
  const tc = await prisma.tenantConfig.findFirst({ where: { tenantId: ctx.tenantId } });

  return {
    employeeId: ctx.employeeId,
    monthStart,
    monthEnd,
    monthFirstDay: firstDay,
    monthLastDay: lastDay,
    tz,
    carryOverIn: 0,
    schedule: schedule as unknown as Record<string, unknown>,
    hireDate: employee!.hireDate,
    exitDate: null,
    isTimeTrackingExempt: false,
    breakOver6hOverride: 0,
    breakOver9hOverride: 0,
    entries: entries as CloseMonthInput["entries"],
    shifts: shifts as CloseMonthInput["shifts"],
    approvedLeave: approvedLeave as CloseMonthInput["approvedLeave"],
    absences: [],
    holidayDateStrings: new Set<string>(), // no holidays seeded for these cells
    tenantConfig: tc
      ? {
          defaultBreakOver6h: tc.defaultBreakOver6h,
          defaultBreakOver9h: tc.defaultBreakOver9h,
          monthlyHoursHolidayDeduction: tc.monthlyHoursHolidayDeduction ?? undefined,
          vocationalSchoolMinutesPerDay: tc.vocationalSchoolMinutesPerDay ?? undefined,
          vocationalSchoolBlockMinutesPerWeek: tc.vocationalSchoolBlockMinutesPerWeek ?? undefined,
          bsSlotFirstLongDayMinutes: tc.bsSlotFirstLongDayMinutes ?? undefined,
          bsSlotSecondLongDayMinutes: tc.bsSlotSecondLongDayMinutes ?? undefined,
          bsSlotShortDayMinutes: tc.bsSlotShortDayMinutes ?? undefined,
          bsSlotBlockWeekMinutes: tc.bsSlotBlockWeekMinutes ?? undefined,
        }
      : null,
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

const seededTenants: string[] = [];
let sharedApp: FastifyInstance;

afterAll(async () => {
  if (!sharedApp) return;
  for (const t of seededTenants) {
    try {
      await cleanupTestData(sharedApp, t);
    } catch (err) {
      console.error("golden-halfdaysick cleanup:", err);
    }
  }
});

describe("Phase 76.32.1 Part B — half-day SICK saldo: FIXED_SCHEDULE golden cell", () => {
  /**
   * CELL A — fw-40-5-halfdaysick
   *
   * Spec-derived expected values (see file-level comment):
   *   workedMinutes  = 9360   (19×480 + 240)
   *   expectedMinutes = 9360  (netExpected = 9600 - 240)
   *   balanceMinutes  = 0     (net-neutral: worked half, Soll halved)
   *   carryOver       = 0
   *
   * VERDICT: GREEN → close halves halfDay SICK for FIXED_SCHEDULE.
   *          RED   → SURFACED-DEFECT: close ignores halfDay for FIXED SICK.
   */
  it("fw-40-5-halfdaysick: close snapshot == spec (worked=9360, expected=9360, balance=0, carryOver=0)", async () => {
    sharedApp = await getTestApp();
    const app = sharedApp;

    const ctx = await seedFixedSick(app);
    seededTenants.push(ctx.tenantId);

    const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 2, TZ);
    const input = await buildCoreInput(app, ctx, monthStart, monthEnd, TZ);
    const core = closeEmployeeMonth(input);

    // SPEC-DERIVED assertions — NEVER adjusted to code.
    // If any fails, the close is mis-valuing half-day SICK for FIXED_SCHEDULE.
    // SURFACED-DEFECT trigger: if balanceMinutes === 240, code ignored halfDay.
    expect(core.workedMinutes, "workedMinutes = 19×480 + 240 = 9360").toBe(FW_SICK_WORKED);
    expect(core.expectedMinutes, "expectedMinutes = netExpected = 9600 - halfDay(240) = 9360").toBe(
      FW_SICK_EXPECTED,
    );
    expect(
      core.balanceMinutes,
      "balanceMinutes = 0 (half-day SICK + half-day work nets to zero; halfDay halves Soll)",
    ).toBe(FW_SICK_BALANCE);
    expect(core.carryOverOut, "carryOver = 0").toBe(FW_SICK_CARRY);
  }, 60_000);
});

describe("Phase 76.32.1 Part B — half-day SICK saldo: SHIFT_BASED golden cell", () => {
  /**
   * CELL B — sb-38-5-halfdaysick
   *
   * Spec-derived expected values (see constants above + file-level comment):
   *   workedMinutes   = 9348  (20×456 + 228; Jan01 not seeded)
   *   expectedMinutes = 9804  (cNet = 10032 - halfDay(228); key discriminating assertion)
   *   balanceMinutes  = 0     (D-01: W=9348, C=9804, R=9120 → all max(0,…) = 0)
   *   carryOver       = 0
   *
   * Discriminating assertion: expectedMinutes = 9804 (correct) vs 9576 (if halfDay ignored).
   * balanceMinutes is 0 in BOTH cases (D-01 absorbs gap), but expectedMinutes diverges.
   *
   * VERDICT: GREEN → close halves halfDay SICK (cNet correctly reduced by 228 not 456).
   *          RED   → SURFACED-DEFECT: close ignores halfDay in SHIFT_BASED sbLeaveCredit.
   */
  it("sb-38-5-halfdaysick: close snapshot == spec (worked=9348, expected=9804, balance=0, carryOver=0)", async () => {
    sharedApp = await getTestApp();
    const app = sharedApp;

    const ctx = await seedShiftSick(app);
    seededTenants.push(ctx.tenantId);

    const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 1, TZ);
    const input = await buildCoreInput(app, ctx, monthStart, monthEnd, TZ);
    const core = closeEmployeeMonth(input);

    // SPEC-DERIVED assertions — NEVER adjusted to code.
    // Key discriminating assertion: expectedMinutes = 9804 (halfDay respected) vs 9576 (ignored).
    expect(core.workedMinutes, "workedMinutes = 20×456 + 228 = 9348").toBe(SB_SICK_WORKED);
    expect(
      core.expectedMinutes,
      "expectedMinutes = cNet = max(0, 10032 - halfDay(228)) = 9804 [not 9576 if ignored]",
    ).toBe(SB_SICK_EXPECTED);
    expect(
      core.balanceMinutes,
      "balanceMinutes = 0 (D-01: W=9348<C=9804 → no overtime; R=9120<W=9348 → no undertime)",
    ).toBe(SB_SICK_BALANCE);
    expect(core.carryOverOut, "carryOver = 0").toBe(SB_SICK_CARRY);
  }, 60_000);
});
