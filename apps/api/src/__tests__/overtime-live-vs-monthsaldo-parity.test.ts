/**
 * overtime-live-vs-monthsaldo-parity.test.ts
 *
 * Bug 5 regression (v1.8.24): the dashboard KPI + Reports overtime-overview read a LIVE saldo via
 * computeOvertimeBalanceHours (extracted from updateOvertimeAccount). It MUST agree with the
 * calendar's computeMonthSaldo for the current month through the same windowEnd (today only if today
 * has completed entries, else yesterday).
 *
 * The bug: updateOvertimeAccount pre-fetched SHIFT_BASED shifts only up to effectiveEnd (= yesterday
 * when today has no entries), so rosterPeriodMinutes (the §615 proration denominator, which must be
 * the FULL current-month roster incl. future-planned shifts) collapsed to rosterToDateMinutes →
 * proration factor 1 → the open partial month contributed ~0 → the current month was dropped from the
 * running total (helper returned only the prior-month carry-over).
 *
 * This test reproduces the exact shape (prior-month snapshot + current-month shifts with FUTURE
 * shifts after "today" + entries through yesterday + NO entry today) at a frozen "now", and asserts:
 *   computeOvertimeBalanceHours(emp)  ==  computeMonthSaldo(emp, curYear, curMonth).days[last]
 *                                          .cumulativeSaldoMinutes / 60
 * and that the value is NOT merely the prior-month carry-over (i.e. the current month is included).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { monthRangeUtc, monthDayBounds } from "../utils/timezone";
import { computeOvertimeBalanceHours } from "../routes/time-entries";
import { computeMonthSaldo } from "../utils/month-saldo";
import bcrypt from "bcryptjs";

const TZ = "Europe/Berlin";

// Current month = July 2026. "Today" (frozen) = 2026-07-23 with NO entry → windowEnd = 2026-07-22.
const CUR_YEAR = 2026;
const CUR_MONTH = 7;
const FROZEN_NOW = new Date("2026-07-23T10:00:00.000Z");
// Prior month = June 2026 (snapshot carry-over base).
const PRIOR_YEAR = 2026;
const PRIOR_MONTH = 6;

describe("Bug 5 — live overtime helper == month-saldo lastCumulative (SHIFT_BASED, current partial month)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let employeeId: string;
  let adminToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;

    const suffix = "b5-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `Bug5 ${suffix}`, slug: `bug5-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;

    const passwordHash = await bcrypt.hash("test1234", 10);

    // Admin (same tenant) for HTTP-level GET /overtime/:id + /overtime/month-saldo assertions.
    const adminUser = await prisma.user.create({
      data: { email: `b5admin-${suffix}@test.de`, passwordHash, role: "ADMIN", isActive: true },
    });
    await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `B5A-${suffix}`,
        firstName: "Bug5",
        lastName: "Admin",
        hireDate: new Date("2024-01-01"),
      },
    });

    const user = await prisma.user.create({
      data: { email: `b5-${suffix}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `B5-${suffix}`,
        firstName: "Bug5",
        lastName: "Shift",
        hireDate: new Date("2024-01-01"),
        // No break deduction so 9:30h brutto shifts = 9:30h netto (clean §615 arithmetic).
        breakOver6hOverride: 0,
        breakOver9hOverride: 0,
      },
    });
    employeeId = emp.id;

    // SHIFT_BASED, 38h/week over Mon–Fri. day-hours ARE set (7.6h Mon–Fri) so the contract Ø-Soll
    // (avgWorkMinutesCore: weeklyHours/workDaysPerWeek × workdaysInRange) is > 0 — REQUIRED for the
    // §615 roster-proration to actually scale C. With all-zero day-hours C would be 0 and proration
    // would be a no-op (the bug would not manifest). The actual roster lives in the Shift table.
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
    const { firstDay: juneFirst, lastDay: juneLast } = monthDayBounds(juneStart, juneEnd, TZ);
    void juneFirst;
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: emp.id,
        periodType: "MONTHLY",
        periodStart: juneStart,
        periodEnd: juneLast,
        workedMinutes: 9120,
        expectedMinutes: 9120,
        balanceMinutes: 0,
        carryOver: 194, // +3:14 lifetime carry into July
        closedAt: new Date("2026-07-01T06:00:00Z"),
        superseded: false,
      },
    });

    // Current month (July 2026). Shifts on EVERY Mon–Fri through the frozen "today" (worked, WITH a
    // little daily overtime so §615 July balance is NON-ZERO) PLUS future-planned shifts after today.
    // The future shifts are what make rosterPeriodMinutes (the §615 proration denominator) larger than
    // rosterToDateMinutes; the Bug-5 fix requires the roster pre-fetch to include them. NO entry on
    // 2026-07-23 (today) → windowEnd = 2026-07-22.
    // All July 2026 Mon–Fri: 01,02,03, 06,07,08,09,10, 13,14,15,16,17, 20,21,22, 23,24, 27,28,29,30,31.
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
      "2026-07-22", // last worked day (yesterday relative to frozen now)
    ];
    const futureShiftDays = [
      "2026-07-23", // TODAY — shift exists, but NO entry
      "2026-07-24",
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
    ];

    // Roster shift = 08:00–17:30 (9:30h netto) on every worked + future day.
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
    // Worked entries on the past days: 08:00–18:00 (10:00h netto) = +0:30 overtime per day vs the
    // 9:30h shift. 16 days × +30min → the §615 to-date balance is clearly positive.
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

    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `b5admin-${suffix}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(adminLogin.body).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Bug5 test cleanup failed:", err);
    }
  });

  it("computeOvertimeBalanceHours == computeMonthSaldo(currentMonth).lastCumulative (through windowEnd)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    try {
      const liveHours = await computeOvertimeBalanceHours(app, employeeId);
      expect(liveHours).not.toBeNull();

      const ms = await computeMonthSaldo(app, employeeId, CUR_YEAR, CUR_MONTH);
      expect(ms.days.length).toBeGreaterThan(0);
      const lastCumMin = ms.days[ms.days.length - 1]!.cumulativeSaldoMinutes;
      const lastCumHours = lastCumMin / 60;

      // EQUALITY: the live helper must equal the calendar's last cumulative (both through windowEnd
      // = 2026-07-22, since 2026-07-23 has no entry). Allow a tiny rounding tolerance.
      expect(liveHours as number).toBeCloseTo(lastCumHours, 4);

      // The current partial month MUST be included — the value is NOT just the +3:14 June carry.
      // (If Bug 5 regressed, liveHours would collapse to 194/60 = 3.233h.)
      const juneCarryHours = 194 / 60;
      expect(Math.abs((liveHours as number) - juneCarryHours)).toBeGreaterThan(0.01);

      // windowEnd sanity: the day series must end at 2026-07-22 (today 07-23 excluded, no entry).
      expect(ms.days[ms.days.length - 1]!.date).toBe("2026-07-22");
    } finally {
      vi.useRealTimers();
    }
  });

  it("GET /overtime/:id (live lifetime GESAMT-SALDO) is MONTH-INDEPENDENT and == currentMonth lastCumulative", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    try {
      // The header GESAMT-SALDO is bound to GET /overtime/:id.balanceHours. That value must be the
      // live lifetime saldo through windowEnd — the SAME regardless of which booking month the user
      // is viewing (July, June, or August). The frontend also fetches month-saldo per viewed month
      // (MONAT-SALDO / cells), but GESAMT-SALDO must NOT change with it.
      const readGesamt = async (): Promise<number> => {
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/overtime/${employeeId}`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(res.statusCode).toBe(200);
        return (JSON.parse(res.body) as { balanceHours: number }).balanceHours;
      };

      // Read GESAMT-SALDO three times, each "alongside" fetching a different month's §615 saldo
      // (simulating the user navigating months). The GESAMT value must be identical every time.
      const gJulyView = await readGesamt();
      await computeMonthSaldo(app, employeeId, 2026, 6); // June view
      const gJuneView = await readGesamt();
      await computeMonthSaldo(app, employeeId, 2026, 8); // August view
      const gAugView = await readGesamt();

      expect(gJuneView).toBe(gJulyView);
      expect(gAugView).toBe(gJulyView);

      // And it equals the CURRENT month's last cumulative (both live-lifetime through windowEnd).
      const ms = await computeMonthSaldo(app, employeeId, CUR_YEAR, CUR_MONTH);
      const lastCumHours = ms.days[ms.days.length - 1]!.cumulativeSaldoMinutes / 60;
      expect(gJulyView).toBeCloseTo(lastCumHours, 2);

      // Includes the current partial month (not just the +3:14 June carry).
      expect(Math.abs(gJulyView - 194 / 60)).toBeGreaterThan(0.01);
    } finally {
      vi.useRealTimers();
    }
  });
});
