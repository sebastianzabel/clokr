/**
 * Phase 76.31 Plan 04 — Slot-resolved BS amount (Deliverable B).
 *
 * Proves that a LONG Berufsschultag is credited the individual daily Soll (via the
 * D-06 4-layer bsSlot* hierarchy → daily-Soll fallback) in BOTH saldo amount sites:
 *
 *   1. closeEmployeeMonth() inline BS accumulator (pure — asserted here directly).
 *   2. getVocationalSchoolMinutesForDate() live resolver (live-path smoke).
 *
 * The signature amount is 570 min: a 38h/4-day Azubi → round(38*60/4) = 570 (NOT the
 * flat 480 pauschal). SHIFT_BASED stays net-neutral (worked==expected, balance 0) at
 * the new amount, and the four override layers + block-week distribution are honored.
 *
 * Uses closeEmployeeMonth (pure) for the amount assertions — no route needed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { monthRangeUtc, monthDayBounds } from "../utils/timezone";
import bcrypt from "bcryptjs";
import type { CloseMonthInput } from "../utils/close-employee-month";
import { closeEmployeeMonth, computeDailySollMinutes } from "../utils/close-employee-month";
import { getVocationalSchoolMinutesForDate } from "../utils/vocational-school-saldo";

const TZ = "Europe/Berlin";

// ── computeDailySollMinutes (pure helper) ────────────────────────────────────

describe("computeDailySollMinutes (pure)", () => {
  it("38h over a 4-day week (mon..thu markers) → 570 min", () => {
    const schedule = {
      weeklyHours: 38,
      mondayHours: 1,
      tuesdayHours: 1,
      wednesdayHours: 1,
      thursdayHours: 1,
      fridayHours: 0,
      saturdayHours: 0,
      sundayHours: 0,
    };
    // round(38 * 60 / 4) = round(570) = 570
    expect(computeDailySollMinutes(schedule)).toBe(570);
  });

  it("40h over a 5-day week → 480 min", () => {
    const schedule = {
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
    };
    expect(computeDailySollMinutes(schedule)).toBe(480);
  });

  it("uses weeklyHours/workDaysPerWeek — NOT the {day}Hours values directly (markers only)", () => {
    // 38h over 4 markers (each marker just = 1, not the real per-day hours) → 570, not 60.
    const schedule = {
      weeklyHours: 38,
      mondayHours: 0.5,
      tuesdayHours: 0.5,
      wednesdayHours: 0.5,
      thursdayHours: 0.5,
      fridayHours: 0,
      saturdayHours: 0,
      sundayHours: 0,
    };
    expect(computeDailySollMinutes(schedule)).toBe(570);
  });

  it("0-guard: no workdays → 0 (no divide-by-zero)", () => {
    const schedule = {
      weeklyHours: 38,
      mondayHours: 0,
      tuesdayHours: 0,
      wednesdayHours: 0,
      thursdayHours: 0,
      fridayHours: 0,
      saturdayHours: 0,
      sundayHours: 0,
    };
    expect(computeDailySollMinutes(schedule)).toBe(0);
  });
});

// ── Slot-resolved amount in closeEmployeeMonth (pure) ────────────────────────

describe("closeEmployeeMonth — slot-resolved BS amount (daily Soll for LONG day)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;

  const { start: FEB_START, end: FEB_END } = monthRangeUtc(2026, 2, TZ);
  const { firstDay: FEB_FIRST, lastDay: FEB_LAST } = monthDayBounds(FEB_START, FEB_END, TZ);

  // 38h/4-day SHIFT_BASED schedule → daily Soll = round(38*60/4) = 570.
  const schedule4Day = {
    type: "SHIFT_BASED",
    weeklyHours: 38,
    mondayHours: 1,
    tuesdayHours: 1,
    wednesdayHours: 1,
    thursdayHours: 1,
    fridayHours: 0,
    saturdayHours: 0,
    sundayHours: 0,
    workDays: [1, 2, 3, 4],
    overtimeMode: "CARRY_FORWARD",
  } as unknown as Record<string, unknown>;

  function baseInput(overrides: Partial<CloseMonthInput> = {}): CloseMonthInput {
    return {
      employeeId: empId,
      monthStart: FEB_START,
      monthEnd: FEB_END,
      monthFirstDay: FEB_FIRST,
      monthLastDay: FEB_LAST,
      tz: TZ,
      carryOverIn: 0,
      schedule: schedule4Day,
      hireDate: new Date("2026-01-01T00:00:00Z"),
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
      entries: [],
      shifts: [],
      approvedLeave: [],
      absences: [],
      holidayDateStrings: new Set<string>(),
      tenantConfig: null,
      ...overrides,
    };
  }

  // A single BS day (Feb 2, Monday) — startDate === endDate at UTC-midnight, mirroring
  // production BS-absence creation (avoids the Europe/Berlin next-day spill).
  const oneBsDay: CloseMonthInput["absences"] = [
    {
      startDate: new Date("2026-02-02T00:00:00Z"),
      endDate: new Date("2026-02-02T00:00:00Z"),
      type: "VOCATIONAL_SCHOOL",
      source: "PATTERN",
    },
  ];

  beforeAll(async () => {
    app = await getTestApp();
    const s = `bsslot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const prisma = app.prisma;

    const tenant = await prisma.tenant.create({
      data: { name: `BSSlot ${s}`, slug: s, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({ data: { tenantId, defaultVacationDays: 30, timezone: TZ } });

    const empUser = await prisma.user.create({
      data: {
        email: `emp-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: empUser.id,
        employeeNumber: `EMP-${s}`,
        firstName: "Azubi",
        lastName: "Slot",
        hireDate: new Date("2026-01-01T00:00:00Z"),
        breakOver6hOverride: 0,
        breakOver9hOverride: 0,
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "SHIFT_BASED",
        weeklyHours: 38,
        mondayHours: 9.5,
        tuesdayHours: 9.5,
        wednesdayHours: 9.5,
        thursdayHours: 9.5,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4],
        validFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    empId = emp.id;
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("slot-amount cleanup:", err);
    }
  });

  it("LONG BS day, all bsSlot* null → 570 (daily Soll), NOT 480; single-count, balance 0", () => {
    const input = baseInput({ absences: oneBsDay });
    const result = closeEmployeeMonth(input);
    const baseline = closeEmployeeMonth({ ...input, absences: [] });

    // The BS day is credited the individual daily Soll (570), NOT the flat 480 pauschal.
    // worked rises by the slot credit (570 = bsWorked). v1.8.27 single-count: expected is
    // UNCHANGED — the BS day (Feb 2, Mon) is already in contractSoll at its Ø-Method day
    // credit (570); that credit is now subtracted before the §15 slot credit (570) is
    // re-added, and the two cancel (slot == dayAvg here). balance 0 via §615 (R=0) + bsWorked==bsExpected.
    expect(result.workedMinutes).toBe(baseline.workedMinutes + 570);
    expect(result.expectedMinutes).toBe(baseline.expectedMinutes); // single-count: 570 subtracted, 570 re-added → cancels
    expect(result.balanceMinutes).toBe(0);
    expect(result.balanceMinutes).toBe(baseline.balanceMinutes);
  });

  it("Employee.bsSlotFirstLongDayMinutes=600 → worked +600, expected +30 (slot−dayAvg), balance 0", () => {
    const input = baseInput({
      absences: oneBsDay,
      employeeSlots: {
        bsSlotFirstLongDayMinutes: 600,
        bsSlotSecondLongDayMinutes: null,
        bsSlotShortDayMinutes: null,
        bsSlotBlockWeekMinutes: null,
      },
    });
    const result = closeEmployeeMonth(input);
    const baseline = closeEmployeeMonth({ ...input, absences: [] });

    // worked rises by the slot credit (600 = bsWorked). v1.8.27 single-count: expected rises
    // by (slot 600 − Ø-Method day credit 570) = +30. The BS day contributes exactly 600 to
    // expected (its 570 in contractSoll is removed, the 600 §15 slot credit added). balance 0.
    expect(result.workedMinutes).toBe(baseline.workedMinutes + 600);
    expect(result.expectedMinutes).toBe(baseline.expectedMinutes + 30); // 600 slot − 570 Ø-day-credit
    expect(result.balanceMinutes).toBe(0);
  });

  it("legacy tenantConfig.vocationalSchoolMinutesPerDay=480 does NOT drive FIRST → daily Soll 570 (§15)", () => {
    // §15 Abs. 2 Nr. 2 BBiG / owner decision 2026-07-21: the legacy NOT-NULL
    // vocationalSchoolMinutesPerDay was removed from the FIRST_LONG_DAY chain because
    // it silently shadowed the individual daily Soll. With bsSlot* null, the 38h/4-day
    // schedule (daily Soll = round(38*60/4) = 570) is credited — NOT the legacy 480.
    // A tenant that wants a flat pauschal must set bsSlotFirstLongDayMinutes explicitly.
    const input = baseInput({
      absences: oneBsDay,
      tenantConfig: {
        defaultBreakOver6h: 30,
        defaultBreakOver9h: 45,
        vocationalSchoolMinutesPerDay: 480,
        vocationalSchoolBlockMinutesPerWeek: 2400,
      },
    });
    const result = closeEmployeeMonth(input);
    const baseline = closeEmployeeMonth({ ...input, absences: [] });

    // slot credit = 570 (daily Soll, legacy 480 does NOT drive FIRST). v1.8.27 single-count:
    // worked +570; expected unchanged (570 subtracted, 570 re-added → cancels). balance 0.
    expect(result.workedMinutes).toBe(baseline.workedMinutes + 570);
    expect(result.expectedMinutes).toBe(baseline.expectedMinutes); // single-count: 570 == Ø-day-credit → cancels
    expect(result.balanceMinutes).toBe(0);
  });

  it("block week (5 BS days same ISO week), vocationalSchoolBlockMinutesPerWeek=2400 → 480/day", () => {
    // Mon 2026-02-02 … Fri 2026-02-06 — all in ISO week 6. N=5 → 2400/5 = 480/day.
    const blockWeek: CloseMonthInput["absences"] = ["02", "03", "04", "05", "06"].map((dd) => ({
      startDate: new Date(`2026-02-${dd}T00:00:00Z`),
      endDate: new Date(`2026-02-${dd}T00:00:00Z`),
      type: "VOCATIONAL_SCHOOL",
      source: "PATTERN",
    }));
    const input = baseInput({
      absences: blockWeek,
      tenantConfig: {
        defaultBreakOver6h: 30,
        defaultBreakOver9h: 45,
        vocationalSchoolMinutesPerDay: null,
        vocationalSchoolBlockMinutesPerWeek: 2400,
      },
    });
    const result = closeEmployeeMonth(input);
    const baseline = closeEmployeeMonth({ ...input, absences: [] });

    // Block week: 5 BS days × 480 = 2400 credited to worked (bsWorked). v1.8.27 single-count:
    // the Ø-Method day credit is subtracted for the 4 SCHEDULED workdays Feb2–5 (Mo–Do, 4×570
    // = 2280); Feb6 (Fri, fridayHours=0) was never in contractSoll → 0 subtracted. So expected
    // rises by (bsExpected 2400 − Ø-credit 2280) = +120. worked rises by the full 2400. balance 0
    // (R=0 → §615 no minus; bsWorked==bsExpected). OLD (double-count) asserted expected +2400.
    expect(result.workedMinutes).toBe(baseline.workedMinutes + 2400);
    expect(result.expectedMinutes).toBe(baseline.expectedMinutes + 120); // 2400 block credit − 2280 Ø-day-credit (4 sched. workdays)
    expect(result.balanceMinutes).toBe(0);
  });

  it("MONTHLY_HOURS: BS credited to worked only (contributesToExpected false)", () => {
    const monthlySchedule = {
      type: "MONTHLY_HOURS",
      monthlyHours: 60,
      weeklyHours: 38,
      mondayHours: 1,
      tuesdayHours: 1,
      wednesdayHours: 1,
      thursdayHours: 1,
      fridayHours: 0,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [1, 2, 3, 4],
      overtimeMode: "CARRY_FORWARD",
    } as unknown as Record<string, unknown>;
    const input = baseInput({ schedule: monthlySchedule, absences: oneBsDay });
    const result = closeEmployeeMonth(input);
    const baseline = closeEmployeeMonth({ ...input, absences: [] });

    // worked rises by the resolved amount; expected does NOT (D-04).
    expect(result.workedMinutes).toBe(baseline.workedMinutes + 570);
    expect(result.expectedMinutes).toBe(baseline.expectedMinutes);
  });

  // ── live-path smoke via getVocationalSchoolMinutesForDate ──────────────────

  it("live path: getVocationalSchoolMinutesForDate with a 4-day schedule returns 570", async () => {
    await app.prisma.absence.create({
      data: {
        employeeId: empId,
        startDate: new Date("2026-02-02T00:00:00Z"),
        endDate: new Date("2026-02-02T00:00:00Z"),
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        days: 1,
        createdBy: empId,
      },
    });
    const schedule = await app.prisma.workSchedule.findFirst({ where: { employeeId: empId } });
    const min = await getVocationalSchoolMinutesForDate(
      app.prisma,
      empId,
      new Date("2026-02-02T00:00:00Z"),
      null,
      { schedule: schedule as unknown as Record<string, unknown>, scheduleType: "SHIFT_BASED" },
    );
    expect(min).toBe(570);
    await app.prisma.absence.deleteMany({ where: { employeeId: empId } });
  }, 30_000);
});
