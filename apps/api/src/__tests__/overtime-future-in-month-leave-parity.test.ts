/**
 * overtime-future-in-month-leave-parity.test.ts
 *
 * Regression (v1.8.26): header GESAMT-SALDO (computeOvertimeBalanceHours) diverged from the
 * calendar cells (computeMonthSaldo) for a SHIFT_BASED employee who has an APPROVED leave that
 * STARTS LATER in the current month than windowEnd (= yesterday when today has no entries).
 *
 * Root cause: computeOvertimeBalanceHours pre-fetched approved leave / absences only up to
 * effectiveEnd (`startDate: { lte: effectiveEnd }`), while the SHIFT_BASED partial-month C_net
 * credit uses the FULL current month (closeEmployeeMonth monthEnd = currentMonthRange.end). A
 * vacation starting after windowEnd (e.g. 07-27 when windowEnd = 07-22) was therefore NOT loaded,
 * its Soll-credit was never subtracted from C_net, the roster-prorated effective Soll was inflated
 * above W → the whole open-month §615 contribution collapsed to 0. computeMonthSaldo fetches the
 * full-month leave (`startDate: { lte: monthEnd }`) and DID credit it → the two diverged by exactly
 * the open-month balance. The fix widens the leave/absence pre-fetch to shiftRangeLastDay (= full
 * current calendar month), mirroring the existing shift pre-fetch widening (Bug 5).
 *
 * Shape: prior-month snapshot carry + current-month shifts+entries through windowEnd + an APPROVED
 * leave 07-27..07-31 (no shifts on those days). Asserts header == cells and that the header is NOT
 * merely the prior-month carry (i.e. the open month is included with the leave credit applied).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { monthRangeUtc, monthDayBounds } from "../utils/timezone";
import { computeOvertimeBalanceHours } from "../routes/time-entries";
import { computeMonthSaldo } from "../utils/month-saldo";
import bcrypt from "bcryptjs";

const TZ = "Europe/Berlin";

const CUR_YEAR = 2026;
const CUR_MONTH = 7;
// "Today" (frozen) = 2026-07-23 with NO entry → windowEnd = 2026-07-22.
const FROZEN_NOW = new Date("2026-07-23T10:00:00.000Z");
const PRIOR_YEAR = 2026;
const PRIOR_MONTH = 6;

describe("v1.8.26 — future-in-month approved leave: header == month-saldo (SHIFT_BASED)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let employeeId: string;
  let adminToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;

    const suffix = "fiml-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `FIML ${suffix}`, slug: `fiml-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;

    const passwordHash = await bcrypt.hash("test1234", 10);

    const adminUser = await prisma.user.create({
      data: { email: `fimladmin-${suffix}@test.de`, passwordHash, role: "ADMIN", isActive: true },
    });
    await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `FIMLA-${suffix}`,
        firstName: "Fiml",
        lastName: "Admin",
        hireDate: new Date("2024-01-01"),
      },
    });

    const user = await prisma.user.create({
      data: { email: `fiml-${suffix}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `FIML-${suffix}`,
        firstName: "Fiml",
        lastName: "Shift",
        hireDate: new Date("2024-01-01"),
        // No break deduction so 9:30h brutto shifts = 9:30h netto (clean §615 arithmetic).
        breakOver6hOverride: 0,
        breakOver9hOverride: 0,
      },
    });
    employeeId = emp.id;

    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "SHIFT_BASED",
        weeklyHours: 38,
        mondayHours: 7.6,
        tuesdayHours: 7.6,
        wednesdayHours: 7.6,
        thursdayHours: 7.6,
        fridayHours: 7.6,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });

    // Prior-month (June 2026) MONTHLY snapshot with a non-zero carry-over (+3:14 = 194 min).
    const { start: juneStart, end: juneEnd } = monthRangeUtc(PRIOR_YEAR, PRIOR_MONTH, TZ);
    const { lastDay: juneLast } = monthDayBounds(juneStart, juneEnd, TZ);
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: emp.id,
        periodType: "MONTHLY",
        periodStart: juneStart,
        periodEnd: juneLast,
        workedMinutes: 9120,
        expectedMinutes: 9120,
        balanceMinutes: 0,
        carryOver: 194,
        closedAt: new Date("2026-07-01T06:00:00Z"),
        superseded: false,
      },
    });

    // Worked shift days through windowEnd (2026-07-22) + a couple of future shift days that are NOT
    // on the leave week. The leave week 07-27..07-31 has NO shifts (employee on vacation).
    const pastWorkdays = [
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
      "2026-07-13",
      "2026-07-14",
      "2026-07-15",
      "2026-07-16",
      "2026-07-17",
      "2026-07-20",
      "2026-07-21",
      "2026-07-22", // windowEnd (yesterday relative to frozen now)
    ];
    const futureShiftDays = [
      "2026-07-23", // TODAY — shift exists, but NO entry
      "2026-07-24",
    ];
    // NOTE: 07-27..07-31 deliberately have NO shifts — they are covered by the approved leave below.

    for (const d of [...pastWorkdays, ...futureShiftDays]) {
      await prisma.shift.create({
        data: {
          employeeId: emp.id,
          date: new Date(d + "T00:00:00Z"),
          startTime: "08:00",
          endTime: "17:30",
        },
      });
    }
    // Worked entries 08:00–18:00 (10:00h netto) = +0:30 overtime per day vs the 9:30h shift.
    for (const d of pastWorkdays) {
      await prisma.timeEntry.create({
        data: {
          employeeId: emp.id,
          date: new Date(d + "T00:00:00Z"),
          startTime: new Date(d + "T08:00:00.000Z"),
          endTime: new Date(d + "T18:00:00.000Z"),
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
          isInvalid: false,
        },
      });
    }

    // The trigger: an APPROVED leave that STARTS after windowEnd (07-22) but within July (07-27),
    // spilling into August. Pre-fix, computeOvertimeBalanceHours never loaded this row (startDate
    // 07-27 > effectiveEnd 07-22) → its C_net credit was dropped → header diverged from the cells.
    const leaveType = await prisma.leaveType.create({
      data: { tenantId, name: "Urlaub FIML", isPaid: true, requiresApproval: false },
    });
    await prisma.leaveRequest.create({
      data: {
        employeeId: emp.id,
        leaveTypeId: leaveType.id,
        startDate: new Date("2026-07-27T00:00:00Z"),
        endDate: new Date("2026-08-07T00:00:00Z"),
        days: 10,
        status: "APPROVED",
        halfDay: false,
      },
    });

    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `fimladmin-${suffix}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(adminLogin.body).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("FIML test cleanup failed:", err);
    }
  });

  it("header (computeOvertimeBalanceHours) == month-saldo lastCumulative despite future-in-month leave", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    try {
      const liveHours = await computeOvertimeBalanceHours(app, employeeId);
      expect(liveHours).not.toBeNull();

      const ms = await computeMonthSaldo(app, employeeId, CUR_YEAR, CUR_MONTH);
      expect(ms.days.length).toBeGreaterThan(0);
      const lastCumMin = ms.days[ms.days.length - 1]!.cumulativeSaldoMinutes;
      const lastCumHours = lastCumMin / 60;

      // The core assertion: header must match the calendar's last cumulative. Pre-fix, the header
      // dropped the 07-27 leave credit → its open-month contribution collapsed to ~0 → it read the
      // bare June carry (194/60) while the cells showed the real (higher) to-date saldo.
      expect(liveHours as number).toBeCloseTo(lastCumHours, 4);

      // The open month is included with the leave credit applied — NOT just the +3:14 June carry.
      const juneCarryHours = 194 / 60;
      expect(Math.abs((liveHours as number) - juneCarryHours)).toBeGreaterThan(0.01);

      // windowEnd sanity: today (07-23, no entry) excluded → series ends 07-22.
      expect(ms.days[ms.days.length - 1]!.date).toBe("2026-07-22");
    } finally {
      vi.useRealTimers();
    }
  });
});
