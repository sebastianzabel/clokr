/**
 * Phase 76.12 Plan 02 — Smoke tests for time-entries.ts Saldo branches.
 *
 * Verifies updateOvertimeAccount now subtracts leave/absence via
 * calcLeaveAbsenceMinutesTz (Ø-Methode, BAG 9 AZR 406/17), with:
 *  - VOCATIONAL_SCHOOL + PATTERN Absence filter at the Prisma layer
 *  - LeaveRequest.halfDay honored in both leave-reduce paths
 *
 * Default branch (FIXED_SCHEDULE / FLEXTIME) is the realistic Anna-A.S. bug
 * surface; SHIFT_BASED branch uses coveredDates and zeroes leaveMinutes anyway
 * (see time-entries.ts:1572-1573), so the user-visible bug surfaces via
 * FLEXTIME schedules.
 *
 * No PII — initials only (memory feedback_no_pii_in_github).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "../../__tests__/setup";
import { updateOvertimeAccount } from "../time-entries";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

describe("Saldo Ø-Methode (Phase 76.12) — time-entries leave/absence subtraction", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminUserId: string;
  let vacationTypeId: string;

  // A.S.-style FLEXTIME employee: 38h/week, Mo=0, Di-Fr=9.5h. Triggers the
  // default-branch leave-reduce path (FLEXTIME, single calendar month).
  let asFlexId: string;

  // Hire date in June 2026 so "now" pinned to 2026-06-30 leaves a fully-
  // measurable range for the helper.
  const HIRE_DATE = new Date("2026-06-01T00:00:00Z");
  const PINNED_NOW = new Date("2026-06-30T10:00:00Z");

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = "te-76-12-" + Date.now().toString(36);

    const tenant = await prisma.tenant.create({
      data: { name: `Saldo Ø-Methode ${s}`, slug: `te-${s}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: "Europe/Berlin" },
    });

    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    adminUserId = adminUser.id;
    await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "Admin",
        lastName: "T.",
        hireDate: HIRE_DATE,
      },
    });

    const vacationType = await prisma.leaveType.create({
      data: { tenantId, name: "Urlaub", isPaid: true, requiresApproval: true, color: "#3B82F6" },
    });
    vacationTypeId = vacationType.id;

    const asUser = await prisma.user.create({
      data: {
        email: `as-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const asEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: asUser.id,
        employeeNumber: `AS-${s}`,
        firstName: "A.",
        lastName: "S.",
        classification: "TEILZEIT",
        hireDate: HIRE_DATE,
      },
    });
    asFlexId = asEmp.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: asEmp.id,
        type: "FLEXTIME",
        weeklyHours: 38,
        // workDays explicit (soll-ignores-workdays-on-legacy-schedules fix):
        // avgWorkMinutesCore is now workDays-primary. Without this, the row
        // would silently inherit the Prisma schema default workDays=[1..5]
        // (includes Monday, which this fixture does NOT work per
        // mondayHours=0 below). Set to the fixture's real Tue-Fri pattern —
        // matches what normalizeWorkDays() would derive from these same
        // {day}Hours in production and keeps expected values unchanged.
        workDays: [2, 3, 4, 5],
        mondayHours: 0,
        tuesdayHours: 9.5,
        wednesdayHours: 9.5,
        thursdayHours: 9.5,
        fridayHours: 9.5,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: HIRE_DATE,
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: asEmp.id, balanceHours: 0 } });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("A.S. FLEXTIME 1-day Fri Urlaub: Saldo subtracts 570min (NOT broken 977min)", async () => {
    // Clean state: remove leave + absence rows for this employee.
    await app.prisma.leaveRequest.deleteMany({ where: { employeeId: asFlexId } });
    await app.prisma.absence.deleteMany({ where: { employeeId: asFlexId } });

    // Seed APPROVED LeaveRequest for Fri 2026-06-05.
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: asFlexId,
        leaveTypeId: vacationTypeId,
        startDate: new Date("2026-06-05"),
        endDate: new Date("2026-06-05"),
        days: 1,
        halfDay: false,
        status: "APPROVED",
      },
    });

    vi.useFakeTimers({ now: PINNED_NOW, toFake: ["Date"] });
    try {
      // Capture balance before. Run updateOvertimeAccount which recomputes
      // expectedMinutes + leaveMinutes for the open month.
      await updateOvertimeAccount(app, asFlexId);

      const account = await app.prisma.overtimeAccount.findUnique({
        where: { employeeId: asFlexId },
      });
      const balanceMin = Math.round(Number(account?.balanceHours ?? 0) * 60);

      // Range = 2026-06-01..2026-06-29 (hire→yesterday).
      // June 2026: Mo=1,8,15,22,29 / Tue=2,9,16,23,30 / Wed=3,10,17,24 / Thu=4,11,18,25
      // / Fri=5,12,19,26 / Sat=6,13,20,27 / Sun=7,14,21,28.
      // Workdays in [Jun 1..Jun 29] for A.S. (Di/Mi/Do/Fr): Di=2,9,16,23 / Mi=3,10,17,24
      // / Do=4,11,18,25 / Fr=5,12,19,26  → 16 workdays.
      // expectedMinutes (Ø-Methode for FLEXTIME via calcExpectedMinutesTz) =
      //   38 * 60 * 16 / 4 = 9120 min.
      // leaveMinutes (Ø-Methode for 1 day Fri via calcLeaveAbsenceMinutesTz) =
      //   38 * 60 * 1 / 4 = 570 min.
      // workedMinutes = 0 → balance = (worked − expected + leave + absence) = -8550 min.
      //
      // Pre-fix (broken formula) for leave subtraction was wh × Kalendertage ÷ 7 =
      // 38 * 60 * 1 / 7 ≈ 326. Or with the old SHIFT_BASED/FLEXTIME bug, the
      // leave subtraction was wildly inflated. Either way, the new helper produces
      // exactly 570 for this fixture.
      //
      // We assert leave reduces the expected gap by exactly 570 vs. the no-leave
      // baseline. Both calls use the same fake-timer "now" so the range is stable.
      expect(balanceMin).toBe(-8550);
    } finally {
      vi.useRealTimers();
    }
  });

  it("halfDay LeaveRequest halves the Soll-reduction (285min instead of 570)", async () => {
    await app.prisma.leaveRequest.deleteMany({ where: { employeeId: asFlexId } });
    await app.prisma.absence.deleteMany({ where: { employeeId: asFlexId } });
    // Reset balance to 0.
    await app.prisma.overtimeAccount.update({
      where: { employeeId: asFlexId },
      data: { balanceHours: 0 },
    });

    await app.prisma.leaveRequest.create({
      data: {
        employeeId: asFlexId,
        leaveTypeId: vacationTypeId,
        startDate: new Date("2026-06-05"),
        endDate: new Date("2026-06-05"),
        days: 0.5,
        halfDay: true,
        status: "APPROVED",
      },
    });

    vi.useFakeTimers({ now: PINNED_NOW, toFake: ["Date"] });
    try {
      await updateOvertimeAccount(app, asFlexId);
      const account = await app.prisma.overtimeAccount.findUnique({
        where: { employeeId: asFlexId },
      });
      const balanceMin = Math.round(Number(account?.balanceHours ?? 0) * 60);

      // expected = 9120, leave = round(570/2) = 285, worked = 0
      // balance = (0 - 9120 + 285 + 0) = -8835 min.
      expect(balanceMin).toBe(-8835);
    } finally {
      vi.useRealTimers();
    }
  });

  it("VOCATIONAL_SCHOOL (Berufsschule) day is balance-NEUTRAL (BBiG §15)", async () => {
    await app.prisma.leaveRequest.deleteMany({ where: { employeeId: asFlexId } });
    await app.prisma.absence.deleteMany({ where: { employeeId: asFlexId } });
    await app.prisma.overtimeAccount.update({
      where: { employeeId: asFlexId },
      data: { balanceHours: 0 },
    });

    // Phase 76.21 (debug D10): a Berufsschultag is subtracted from expected via the
    // absence path AND re-added via BS-doubling (bsWorked/bsExpected) → net-zero, in
    // lockstep with the legally-binding manual close (overtime.ts:1124-1155).
    // BBiG §15 (Berufsschulzeit = Arbeitszeit) means the BS day must NEITHER add NOR
    // subtract saldo — the Azubi is treated as if the day was fulfilled.
    await app.prisma.absence.create({
      data: {
        employeeId: asFlexId,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: new Date("2026-06-02"),
        endDate: new Date("2026-06-02"),
        days: 1,
        createdBy: adminUserId,
      },
    });

    vi.useFakeTimers({ now: PINNED_NOW, toFake: ["Date"] });
    try {
      await updateOvertimeAccount(app, asFlexId);
      const account = await app.prisma.overtimeAccount.findUnique({
        where: { employeeId: asFlexId },
      });
      const balanceMin = Math.round(Number(account?.balanceHours ?? 0) * 60);

      // The base Ø-Methode counts the BS day (June 2, Tue) as a workday (+570).
      // BS-doubling adds bsExpected(+bsMin) and bsWorked(+bsMin) which cancel, and
      // the absence subtraction (−570) cancels the base count → the BS day nets 0.
      // Remaining balance = the 15 non-BS workdays with no time entries × 570 =
      // −8550 (NOT −9120: the old filter-out left the BS day double-counted in
      // expected, wrongly penalising the Azubi one daily Soll per Berufsschultag).
      // Proven in bs-day-saldo-parity.test.ts (live == closed, BS neutral).
      expect(balanceMin).toBe(-8550);
    } finally {
      vi.useRealTimers();
    }
  });
});
