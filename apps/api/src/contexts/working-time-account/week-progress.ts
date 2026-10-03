/**
 * week-progress.ts
 *
 * Issue #451 (D-06) — the dashboard week target is the Soll of the WHOLE week (Mon-Sun, tenant
 * timezone) after leave, absence, Berufsschule and holiday reduction — the same saldo core
 * (closeEmployeeMonth) the Monatsabschluss uses, never a composition-layer `{day}Hours` walk. A
 * full vacation week therefore shows target 0, not a flat Mon..today walk minus nothing (the
 * issue's literal example: -40h instead of 0).
 *
 * Progress through the week compares worked vs. Soll only up to YESTERDAY (issue #438: today
 * never counts) — the `toDateSollMinutes`/`toDateWorkedMinutes` pair below.
 *
 * Contract resolution mirrors Phase 451-05's per-month rule for the live lifetime saldo
 * (`getEffectiveSchedule(app, employeeId, <that month's midpoint>)`, the close paths' own rule):
 * a week is split into at most two contiguous calendar-month pieces (Mon-Sun straddles at most
 * one month boundary), and each piece resolves ITS OWN contract before any prefetch. Any piece
 * under a MONTHLY_HOURS contract degrades the whole result to `null` — that schedule type keeps
 * its own month view, never a week view (dashboard.ts does not even call this function for a
 * MONTHLY_HOURS employee's TODAY contract, but a contract change mid-week could still make one
 * piece MONTHLY_HOURS while the other is not, so the guard lives here too).
 *
 * Window convention (mirrors month-saldo.ts's day-by-day partial loop and overtime-balance.ts's
 * partial-month block): per piece, `closeEmployeeMonth` is called TWICE — once over the WHOLE
 * piece with no entries (the piece's own Soll, carryOverIn 0, no rosterProration), and once over
 * the piece clipped to <= yesterday WITH its entries (to-date Soll and Ist). `monthStart` is
 * unused by `closeEmployeeMonth` itself (its only consumers are callers' own bookkeeping) — any
 * valid Date satisfies the type.
 *
 * Pure read: no write, ever.
 */

import type { FastifyInstance } from "fastify";
import { getTenantTimezone, dateStrInTz, monthRangeUtc, weekRangeUtc } from "./timezone";
import { holidaysAtWorkLocation } from "../platform"; // Phase 71b (issue #71) — central resolver
import { getShiftsInRange } from "../scheduling"; // Phase 100B Plan 05 — S1
import { closeEmployeeMonth, toCloseMonthApprovedLeave } from "./close-employee-month";
import {
  getValidWorkedEntriesInRange, // Phase 100B Plan 08 — T1; THE SALDO INPUT
  getWorkedEntriesInRange, // Phase 71b (issue #71) — T2, feeds the holiday resolver below
  getEffectiveSchedule,
} from "../time-tracking";
import {
  getAbsencesOverlapping, // Phase 100B Plan 12 — A4
  getActiveLeaveOverlapping, // Issue #446 (D-02) — effective leave
  loadBsSlotOverrides, // Phase 76.31 (D-06) — BS slot overrides
} from "../absence";

export type WeekProgress = {
  /** The whole week's (Mon-Sun) net Soll, after leave/absence/BS/holiday reduction. */
  weekSollMinutes: number;
  /** The Soll of the part of the week up to and including yesterday (issue #438). */
  toDateSollMinutes: number;
  /** The Ist of the part of the week up to and including yesterday (issue #438). */
  toDateWorkedMinutes: number;
};

type WeekMonthPiece = { start: string; end: string };

/**
 * Split a Monday..Sunday run of tenant-local "YYYY-MM-DD" day strings into contiguous
 * calendar-month pieces. A Mon-Sun week straddles at most one month boundary (it can never span
 * three calendar months), so this returns one or two pieces.
 */
function splitWeekIntoMonthPieces(days: readonly string[]): WeekMonthPiece[] {
  const pieces: WeekMonthPiece[] = [];
  let pieceStart = days[0]!;
  for (let i = 1; i < days.length; i++) {
    if (days[i]!.slice(0, 7) !== days[i - 1]!.slice(0, 7)) {
      pieces.push({ start: pieceStart, end: days[i - 1]! });
      pieceStart = days[i]!;
    }
  }
  pieces.push({ start: pieceStart, end: days[days.length - 1]! });
  return pieces;
}

/**
 * Issue #451 (D-06) — the dashboard week block's whole-week Soll and to-date Soll/Ist, both from
 * the saldo core. Returns `null` for a missing/exempt employee, or when any day of the week falls
 * under a MONTHLY_HOURS contract (that schedule type keeps its own month view).
 */
export async function computeWeekProgress(
  app: FastifyInstance,
  employeeId: string,
  now: Date,
): Promise<WeekProgress | null> {
  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      tenantId: true,
      hireDate: true,
      exitDate: true,
      isTimeTrackingExempt: true,
      breakOver6hOverride: true,
      breakOver9hOverride: true,
    },
  });
  if (!employee || employee.isTimeTrackingExempt) return null;

  const tz = await getTenantTimezone(app.prisma, employee.tenantId);
  const { start: weekStart, end: weekEnd, days } = weekRangeUtc(now, tz);

  // Issue #438 — today never counts; the to-date cursor always ends yesterday.
  const todayStr = dateStrInTz(now, tz);
  const todayDate = new Date(todayStr + "T00:00:00Z");
  const yesterdayDate = new Date(todayDate.getTime() - 86400000);
  const yesterdayStr = dateStrInTz(yesterdayDate, tz);

  const pieces = splitWeekIntoMonthPieces(days);

  // Issue #451 (D-04/D-05 carry-over from Phase 451-05) — resolve EACH piece's own contract via
  // its calendar month's midpoint (the close paths' rule) before any prefetch, so a piece in a
  // different calendar month can never reuse another piece's (or "today's") contract.
  const midpointOf = (a: Date, b: Date) => new Date((a.getTime() + b.getTime()) / 2);
  const pieceSchedules = await Promise.all(
    pieces.map(async (piece) => {
      const [y, m] = piece.start.split("-").map(Number) as [number, number];
      const { start: calMonthStart, end: calMonthEnd } = monthRangeUtc(y, m, tz);
      const schedule = await getEffectiveSchedule(
        app,
        employeeId,
        midpointOf(calMonthStart, calMonthEnd),
      );
      return { piece, calMonthStart, schedule };
    }),
  );

  // Any part of the week under a MONTHLY_HOURS contract — that schedule type keeps its own
  // month view; this function answers no week question for it.
  if (pieceSchedules.some((p) => String(p.schedule.type ?? "") === "MONTHLY_HOURS")) {
    return null;
  }

  const anyPieceShiftBased = pieceSchedules.some(
    (p) => String(p.schedule.type ?? "") === "SHIFT_BASED",
  );

  const employeeScope = { kind: "employee" as const, employeeId, tenantId: employee.tenantId };

  // ── ONE prefetch for the whole week ──────────────────────────────────────────────────────
  const [weekWorkEntries, toDateEntries, weekLeave, weekAbsences, tenantConfig] = await Promise.all(
    [
      // T2 — closed WORK entries, carries salonId; feeds the holiday resolver (§ 2 EFZG).
      getWorkedEntriesInRange(app.prisma, employeeScope, weekStart, weekEnd),
      // T1 — THE SALDO INPUT, Monday..yesterday only (today never counts, issue #438).
      getValidWorkedEntriesInRange(
        app.prisma,
        employeeScope,
        weekStart,
        new Date(yesterdayStr + "T00:00:00Z"),
      ),
      getActiveLeaveOverlapping(app.prisma, employeeScope, weekStart, weekEnd),
      getAbsencesOverlapping(app.prisma, employeeScope, weekStart, weekEnd),
      app.prisma.tenantConfig.findUnique({ where: { tenantId: employee.tenantId } }),
    ],
  );

  const weekShifts = anyPieceShiftBased
    ? await getShiftsInRange(app.prisma, employeeScope, weekStart, weekEnd)
    : [];

  const workLocationEntries = weekWorkEntries.map((e) => ({
    employeeId,
    date: e.date,
    startTime: e.startTime,
    salonId: e.salonId,
  }));
  const employeeHolidaysMap = await holidaysAtWorkLocation(
    app.prisma,
    employee.tenantId,
    [employeeId],
    dateStrInTz(weekStart, tz),
    dateStrInTz(weekEnd, tz),
    workLocationEntries,
  );
  const weekHolidayDateStrings = new Set<string>(employeeHolidaysMap.get(employeeId)?.keys() ?? []);

  const tenantCfg = tenantConfig
    ? {
        defaultBreakOver6h: tenantConfig.defaultBreakOver6h,
        defaultBreakOver9h: tenantConfig.defaultBreakOver9h,
        defaultWorkDays: tenantConfig.defaultWorkDays ?? undefined,
        vocationalSchoolMinutesPerDay: tenantConfig.vocationalSchoolMinutesPerDay ?? undefined,
        vocationalSchoolBlockMinutesPerWeek:
          tenantConfig.vocationalSchoolBlockMinutesPerWeek ?? undefined,
        bsSlotFirstLongDayMinutes: tenantConfig.bsSlotFirstLongDayMinutes ?? undefined,
        bsSlotSecondLongDayMinutes: tenantConfig.bsSlotSecondLongDayMinutes ?? undefined,
        bsSlotShortDayMinutes: tenantConfig.bsSlotShortDayMinutes ?? undefined,
        bsSlotBlockWeekMinutes: tenantConfig.bsSlotBlockWeekMinutes ?? undefined,
      }
    : null;

  const approvedLeaveInput = toCloseMonthApprovedLeave(weekLeave);
  const absencesInput = weekAbsences.map((ab) => ({
    startDate: ab.startDate,
    endDate: ab.endDate,
    type: ab.type,
    source: ab.source,
    halfDay: Boolean(ab.halfDay),
    unterrichtsMinutes: ab.unterrichtsMinutes ?? null,
  }));

  let weekSollMinutes = 0;
  let toDateSollMinutes = 0;
  let toDateWorkedMinutes = 0;

  for (const { piece, calMonthStart, schedule } of pieceSchedules) {
    const pieceStartDate = new Date(piece.start + "T00:00:00Z");
    const pieceEndDate = new Date(piece.end + "T00:00:00Z");

    // Phase 76.31 (D-06) — BS slot overrides for the piece's own calendar month.
    const { employeeSlots, patternSlots, patternUnterrichtsMinutenByDow } =
      await loadBsSlotOverrides(app.prisma, employeeId, calMonthStart);

    const pieceHolidays = new Set(
      [...weekHolidayDateStrings].filter((d) => d >= piece.start && d <= piece.end),
    );
    const pieceShifts = weekShifts
      .filter(
        (sh) => dateStrInTz(sh.date, tz) >= piece.start && dateStrInTz(sh.date, tz) <= piece.end,
      )
      .map((sh) => ({ date: sh.date, startTime: sh.startTime, endTime: sh.endTime }));

    const sharedPieceInput = {
      employeeId,
      monthStart: pieceStartDate,
      monthFirstDay: pieceStartDate,
      tz,
      carryOverIn: 0,
      schedule: schedule as Record<string, unknown>,
      hireDate: employee.hireDate,
      exitDate: employee.exitDate ?? null,
      isTimeTrackingExempt: false as const,
      breakOver6hOverride: employee.breakOver6hOverride ?? null,
      breakOver9hOverride: employee.breakOver9hOverride ?? null,
      shifts: pieceShifts,
      approvedLeave: approvedLeaveInput,
      absences: absencesInput,
      tenantConfig: tenantCfg,
      employeeSlots,
      patternSlots,
      patternUnterrichtsMinutenByDow,
    };

    // Whole piece, no entries — the piece's own Soll (D-06: the WHOLE week's net Soll).
    const wholePieceResult = closeEmployeeMonth({
      ...sharedPieceInput,
      monthEnd: pieceEndDate,
      monthLastDay: pieceEndDate,
      entries: [],
      holidayDateStrings: pieceHolidays,
    });
    weekSollMinutes += wholePieceResult.expectedMinutes;

    // The piece clipped to <= yesterday, with its entries — to-date Soll and Ist (issue #438:
    // today never counts). A piece entirely after yesterday (a future piece of the current
    // week) contributes nothing to the to-date pair.
    if (piece.start > yesterdayStr) continue;
    const clippedEndStr = piece.end <= yesterdayStr ? piece.end : yesterdayStr;
    const clippedEndDate = new Date(clippedEndStr + "T00:00:00Z");
    const pieceEntries = toDateEntries
      .filter(
        (e) => dateStrInTz(e.date, tz) >= piece.start && dateStrInTz(e.date, tz) <= clippedEndStr,
      )
      .map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes,
      }));
    const clippedHolidays = new Set([...pieceHolidays].filter((d) => d <= clippedEndStr));

    const toDateResult = closeEmployeeMonth({
      ...sharedPieceInput,
      monthEnd: clippedEndDate,
      monthLastDay: clippedEndDate,
      entries: pieceEntries,
      holidayDateStrings: clippedHolidays,
    });
    toDateSollMinutes += toDateResult.expectedMinutes;
    toDateWorkedMinutes += toDateResult.workedMinutes;
  }

  return { weekSollMinutes, toDateSollMinutes, toDateWorkedMinutes };
}
