/**
 * shift-based-usual-workdays-consumers-436.test.ts
 *
 * Phase 436 Plan 03 (D-03) — regression per consumer: saldo (#429), planning warning/
 * Wochenübersicht (#430) and the per-request hours receipt (#429 D-13) all follow the stored
 * `WorkSchedule.usualWorkDays` Angabe through the ONE shared kernel (`leaveDaysPerWeek`), not
 * three independently-updated formulas.
 *
 * Two blocks:
 *   - a pure `closeEmployeeMonth` block (no DB) — the fixture builder is COPIED from
 *     `shift-based-leave-week-soll-429.test.ts` (that file's own docblock: "PURE unit tests: no
 *     DB"), not imported, per this plan's own `<read_first>` instruction.
 *   - a DB block, own tenant `c436-usual-consumers-...`, for `getShiftBasedLeaveDaysForWeek`,
 *     `detectWeekCapacityConflict` and `GET /leave/hours-preview`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  closeEmployeeMonth,
  toCloseMonthApprovedLeave,
  type CloseMonthInput,
} from "../contexts/working-time-account/close-employee-month";
import { monthRangeUtc, monthDayBounds } from "../contexts/working-time-account/timezone";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  salonIdForEmployee,
} from "./setup";
import { holidayFreeMondayStr, addDaysStr, utcMidnight } from "./test-dates";
import { getShiftBasedLeaveDaysForWeek } from "../contexts/absence";
// Owner decision #246: __tests__/*.test.ts files stay outside the context-boundary lint for the
// whole phase — a direct import of a foreign context's internal module from a test file is an
// accepted, scoped exception (eslint.boundaries.mjs BOUNDARY_IGNORES;
// measure-context-boundary-imports.ts's own discoverProductionFiles skips *.test.ts identically).
import { detectWeekCapacityConflict } from "../contexts/scheduling/shift-week-capacity";
import type { FastifyInstance } from "fastify";

// ── Saldo (#429) — pure closeEmployeeMonth, no DB (fixture copied from shift-based-leave-week-soll-429.test.ts) ──

const TZ = "Europe/Berlin";
const { start: JUNE_START, end: JUNE_END } = monthRangeUtc(2026, 6, TZ);
const { firstDay: JUNE_FIRST, lastDay: JUNE_LAST } = monthDayBounds(JUNE_START, JUNE_END, TZ);

const D = (s: string) => new Date(s + "T00:00:00Z");

function daysOfJune(): string[] {
  const out: string[] = [];
  for (let d = 1; d <= 30; d++) out.push(`2026-06-${String(d).padStart(2, "0")}`);
  return out;
}
const dow = (s: string) => D(s).getUTCDay();
const LEAVE_WEEK_MON = "2026-06-08"; // Monday
const LEAVE_WEEK_WED = "2026-06-10"; // Wednesday
const WEEK = [
  "2026-06-08",
  "2026-06-09",
  "2026-06-10",
  "2026-06-11",
  "2026-06-12",
  "2026-06-13",
  "2026-06-14",
];
const inWeek = (d: string) => WEEK.includes(d);

function entry(ds: string, netMin: number) {
  return {
    date: D(ds),
    startTime: new Date(ds + "T06:00:00Z"),
    endTime: new Date(D(ds).getTime() + 6 * 3600e3 + netMin * 60e3),
    breakMinutes: 0,
  };
}

function shift(ds: string, netMin: number) {
  const brk = netMin + 45 > 9 * 60 ? 45 : netMin + 30 > 6 * 60 ? 30 : 0;
  const s = 8 * 60;
  const e = s + netMin + brk;
  const hm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { date: D(ds), startTime: hm(s), endTime: hm(e) };
}

type Leave = { s: string; e: string };

function buildInput(
  schedule: Record<string, unknown>,
  perDay: (ds: string) => number,
  leave: Leave[],
  shiftsFn: (ds: string) => number,
): CloseMonthInput {
  const days = daysOfJune();
  return {
    employeeId: "x",
    monthStart: JUNE_START,
    monthEnd: JUNE_END,
    monthFirstDay: JUNE_FIRST,
    monthLastDay: JUNE_LAST,
    tz: TZ,
    carryOverIn: 0,
    schedule,
    hireDate: D("2025-01-01"),
    exitDate: null,
    isTimeTrackingExempt: false,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    entries: days.filter((d) => perDay(d) > 0).map((d) => entry(d, perDay(d))),
    shifts: days.filter((d) => shiftsFn(d) > 0).map((d) => shift(d, shiftsFn(d))),
    approvedLeave: toCloseMonthApprovedLeave(
      leave.map((l) => ({
        startDate: D(l.s),
        endDate: D(l.e),
        halfDay: false,
        leaveType: { code: "VACATION" },
      })),
    ),
    absences: [],
    holidayDateStrings: new Set(),
    tenantConfig: { defaultBreakOver6h: 30, defaultBreakOver9h: 45 },
  };
}

/** 38h/week, 4-day contract (mirrors shift-based-leave-week-soll-429.test.ts's own
 * shiftBasedSchedule — the per-day-hours fields feed calcExpectedMinutesTz's Ø-Methode cap inside
 * shiftBasedLeaveCreditByDate, so they must carry real values, not placeholders). `usualWorkDays`
 * empty (no Angabe) unless passed. */
function shiftBasedSchedule(usualWorkDays: number[] = []): Record<string, unknown> {
  return {
    type: "SHIFT_BASED",
    weeklyHours: 38,
    contractWorkDaysPerWeek: 4,
    usualWorkDays,
    workDays: [1, 2, 3, 4, 5, 6],
    mondayHours: 8,
    tuesdayHours: 8,
    wednesdayHours: 8,
    thursdayHours: 8,
    fridayHours: 8,
    saturdayHours: 8,
    sundayHours: 0,
  };
}

/** Every week other than the leave week: Mon-Thu 9.5h (570 min = 38h*60/4), the contract;
 * unplanned leave week: no work, no shift planned (perDay/shiftsFn both 0 that week). */
const base = (d: string) => (dow(d) >= 1 && dow(d) <= 4 ? 570 : 0);
const unplannedLeaveWeek = (d: string) => (inWeek(d) ? 0 : base(d));

describe("Saldo (#429) — closeEmployeeMonth follows usualWorkDays for a SHIFT_BASED fragment week", () => {
  it("D-03/436-AC-10: unplanned VACATION Mo-Mi, usual Di-Fr -> expectedMinutes (C_net) is exactly 570 higher than without the Angabe (Monday no longer credited)", () => {
    const leave: Leave[] = [{ s: LEAVE_WEEK_MON, e: LEAVE_WEEK_WED }];

    const withoutAngabe = closeEmployeeMonth(
      buildInput(shiftBasedSchedule([]), unplannedLeaveWeek, leave, unplannedLeaveWeek),
    );
    const withAngabe = closeEmployeeMonth(
      buildInput(shiftBasedSchedule([2, 3, 4, 5]), unplannedLeaveWeek, leave, unplannedLeaveWeek),
    );

    expect(withAngabe.expectedMinutes - withoutAngabe.expectedMinutes).toBe(570);
  });
});

// ── Planning (#430) + receipt (#429 D-13) — DB block ─────────────────────────────────────────

describe("Planning (#430) and hours receipt (#429 D-13) follow usualWorkDays for a SHIFT_BASED employee", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let token: string;

  // Far-future, holiday-free week, isolated from every other fixture in the suite.
  const MONDAY = holidayFreeMondayStr(60);
  const SUNDAY = addDaysStr(MONDAY, 6);
  const weekStart = utcMidnight(MONDAY);
  const weekEnd = utcMidnight(SUNDAY);

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "c436-usual-consumers");
    await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 38,
        contractWorkDaysPerWeek: 4,
        usualWorkDays: [2, 3, 4, 5], // Di-Fr
        validFrom: new Date("2024-06-01"),
      },
    });
    token = data.empToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("shift-based-usual-workdays-consumers-436 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function approveLeave(startIso: string, endIso: string, days: number) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: utcMidnight(startIso),
        endDate: utcMidnight(endIso),
        days,
        status: "APPROVED",
        halfDay: false,
      },
    });
  }

  async function createShiftsOn(dates: string[]): Promise<void> {
    for (const iso of dates) {
      await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          salonId: await salonIdForEmployee(app.prisma, data.employee.id),
          date: utcMidnight(iso),
          startTime: "08:00",
          endTime: "12:00",
        },
      });
    }
  }

  it("D-03/436-AC-10: getShiftBasedLeaveDaysForWeek returns {days: 2, weekdays: [Di, Mi]} for an approved Mo-Mi VACATION with usual Di-Fr", async () => {
    const mo = MONDAY;
    const mi = addDaysStr(MONDAY, 2);
    await approveLeave(mo, mi, 3);

    const result = await getShiftBasedLeaveDaysForWeek(
      app.prisma,
      data.employee.id,
      data.tenant.id,
      weekStart,
      weekEnd,
    );
    expect(result).toEqual({ days: 2, weekdays: ["Di", "Mi"] });
  });

  it("D-03/436-AC-10: detectWeekCapacityConflict allows 2 shifts that week (null, no conflict); 3 shifts -> overbookedBy 1", async () => {
    // 2 shifts: Di + Mi — exactly the days the Angabe counts.
    const di = addDaysStr(MONDAY, 1);
    const mi = addDaysStr(MONDAY, 2);
    await createShiftsOn([di, mi]);

    const noConflict = await detectWeekCapacityConflict(
      app.prisma,
      data.employee.id,
      data.tenant.id,
      weekStart,
      weekEnd,
    );
    expect(noConflict).toBeNull();

    const doIso = addDaysStr(MONDAY, 3);
    await createShiftsOn([doIso]); // now 3 shifts (Di, Mi, Do) that week

    const conflict = await detectWeekCapacityConflict(
      app.prisma,
      data.employee.id,
      data.tenant.id,
      weekStart,
      weekEnd,
    );
    expect(conflict).not.toBeNull();
    expect(conflict?.overbookedBy).toBe(1);
  });

  it("D-03/436-AC-10 receipt: GET /api/v1/leave/hours-preview Mo-Mi returns hours 19 (2 x 9.5h) and days 2", async () => {
    const mo = MONDAY;
    const mi = addDaysStr(MONDAY, 2);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/hours-preview?startDate=${mo}&endDate=${mi}&halfDay=false`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hours).toBe(19);
    expect(body.days).toBe(2);
  });
});

describe("Planning (#430) — Sunday follows set membership (usual [5,6,0,1])", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  const MONDAY = holidayFreeMondayStr(70);
  const weekStart = utcMidnight(MONDAY);
  const weekEnd = utcMidnight(addDaysStr(MONDAY, 6));

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "c436-usual-sunday");
    await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 32,
        contractWorkDaysPerWeek: 4,
        usualWorkDays: [5, 6, 0, 1], // Fr, Sa, So, Mo
        validFrom: new Date("2024-06-01"),
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("shift-based-usual-workdays-consumers-436 (Sunday) cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("approved Sa-So VACATION -> weekdays [Sa, So]", async () => {
    const sa = addDaysStr(MONDAY, 5);
    const so = addDaysStr(MONDAY, 6);
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: utcMidnight(sa),
        endDate: utcMidnight(so),
        days: 2,
        status: "APPROVED",
        halfDay: false,
      },
    });

    const result = await getShiftBasedLeaveDaysForWeek(
      app.prisma,
      data.employee.id,
      data.tenant.id,
      weekStart,
      weekEnd,
    );
    expect(result).toEqual({ days: 2, weekdays: ["Sa", "So"] });
  });
});
