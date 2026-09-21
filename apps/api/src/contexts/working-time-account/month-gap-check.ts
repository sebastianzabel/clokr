/**
 * month-gap-check.ts — "does this employee's month still have gaps?", asked once.
 *
 * Phase 292 (GitHub issue #292). The body of this function was inline in
 * `plugins/auto-close-month.ts`'s backfill loop. It is shared now because the escalation
 * (`deferred-month-close.ts`) has to name the CONCRETE gap days behind a deferral, and a second,
 * independently written gap query would be a second definition of "gap". The measurement in
 * issue #292 turned on exactly which entries count; there must be one place that decides it.
 *
 * ── What counts as a gap, as measured (issue #292, first acceptance criterion) ────────────────
 * A day in [max(hireDate, 1st) .. last day of month] is a gap when ALL of:
 *   1. the schedule type has a daily gap rule at all — `MONTHLY_HOURS` and `FLEXTIME` never
 *      produce one ({@link findMissingWorkdays} returns `gaps: []` for them, so such an employee
 *      can never be gap-blocked, whatever their time entries look like);
 *   2. the day is EXPECTED — for `SHIFT_BASED` that means a roster `Shift` exists on it (never
 *      `{day}Hours`); for the FIXED family it means `isObligatedWorkday()` says so,
 *      `workDays`-primary;
 *   3. no approved leave, no absence and no public holiday covers the day;
 *   4. the day carries no entry in `entryDates`.
 *
 * Point 4 is the sharp one. `entryDates` is built from {@link getWorkedEntriesInRange} (facade
 * T2), whose `where` carries `endTime: { not: null }`. **A time entry without a clock-out is
 * therefore NOT an entry here, and its day IS a gap** — invalid rows still count as entries
 * (T2 has no `isInvalid` filter), open ones do not. The dashboard's own missing-entry card asks
 * the same question through {@link getRecordedWorkEntriesInRange} instead, which KEEPS open rows;
 * the two readers disagree about a forgotten clock-out by construction, and that divergence is
 * pre-existing and deliberate on the card's side (it must not nag about a day that already has a
 * claimed entry). Do not "unify" them here without deciding that question on its merits.
 *
 * A forgotten clock-out therefore blocks the Monatsabschluss only when its day is also an
 * EXPECTED day. That is why a single missing clock-out can leave one employee blocked for months
 * and another closed in the same month: on a `SHIFT_BASED` employee's non-rostered day, or on a
 * day covered by leave/holiday, condition 2 or 3 fails and no gap is produced.
 */

import type { Prisma } from "@clokr/db";
import { getHolidays, type FederalStateCode } from "../platform";
import { getShiftsInRange } from "../scheduling";
import { getWorkedEntriesInRange } from "../time-tracking";
import { getAbsencesOverlapping, getApprovedLeaveOverlapping } from "../absence";
import { findMissingWorkdays } from "./find-missing-workdays";
import { dateStrInTz, monthDayBounds, monthRangeUtc } from "./timezone";
import type { MonthKey } from "./month-close-window";

/** Schedule types that carry no daily gap rule (D-01) — stated once, read by both callers. */
export function hasDailyGapRule(scheduleType: string): boolean {
  return scheduleType !== "MONTHLY_HOURS" && scheduleType !== "FLEXTIME";
}

export type MonthGapCheckInput = {
  tenantId: string;
  employeeId: string;
  hireDate: Date;
  /** The `WorkSchedule` row valid FOR this month — not the employee's current one. */
  schedule: Record<string, unknown>;
  month: MonthKey;
  tz: string;
  /** Federal-state code for `getHolidays()` (e.g. "NI") — the value `STATE_MAP` yields. */
  stateCode: FederalStateCode;
};

export type MonthGapCheckResult = {
  /** false for `MONTHLY_HOURS` / `FLEXTIME` — no daily gap rule, `gapDates` is always empty. */
  gapRuleApplies: boolean;
  /** "YYYY-MM-DD" in tenant TZ, ascending. */
  gapDates: string[];
};

/**
 * Gap-readiness for ONE employee and ONE month. See this module's docblock for the rule.
 *
 * Tenant-scoped: every read goes through a facade with an `EmployeeScope` carrying `tenantId`,
 * or is filtered by `tenantId` directly (the holiday read).
 */
export async function detectMonthGaps(
  db: Prisma.TransactionClient,
  input: MonthGapCheckInput,
): Promise<MonthGapCheckResult> {
  const { tenantId, employeeId, hireDate, schedule, month, tz, stateCode } = input;
  const scheduleType = String(schedule.type ?? "");

  if (!hasDailyGapRule(scheduleType)) {
    return { gapRuleApplies: false, gapDates: [] };
  }

  const { start: monthStart, end: monthEnd } = monthRangeUtc(month.year, month.month, tz);
  const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
    monthStart,
    monthEnd,
    tz,
  );
  const scope = { kind: "employee" as const, employeeId, tenantId };

  // T2 (`endTime: { not: null }`) — an OPEN entry is not an entry here. See the docblock.
  const entries = await getWorkedEntriesInRange(db, scope, monthStart, monthEnd);
  const entryDates = new Set(entries.map((e) => dateStrInTz(e.date, tz)));

  const approvedLeave = await getApprovedLeaveOverlapping(db, scope, monthStart, monthEnd);
  const absences = await getAbsencesOverlapping(db, scope, monthStart, monthEnd);

  const holidayDateStrings = new Set<string>(getHolidays(month.year, stateCode).map((h) => h.date));
  const dbHolidays = await db.publicHoliday.findMany({
    where: { tenantId, date: { gte: monthStart, lte: monthEnd } },
  });
  for (const h of dbHolidays) {
    holidayDateStrings.add(dateStrInTz(h.date, tz));
  }

  // SHIFT_BASED obligation comes from the roster, never from {day}Hours (pitfall A4).
  let rosterDates: Set<string> | undefined;
  if (scheduleType === "SHIFT_BASED") {
    const shifts = await getShiftsInRange(db, scope, monthFirstDay, monthLastDay);
    rosterDates = new Set(shifts.map((sh) => dateStrInTz(sh.date, tz)));
  }

  // effectiveStart = max(hireDate, monthFirstDay) — TZ-normalised (CLOSE-04).
  const hireDateNorm = new Date(dateStrInTz(hireDate, tz) + "T00:00:00Z");
  const effectiveStart = hireDateNorm > monthFirstDay ? hireDateNorm : monthFirstDay;

  const result = findMissingWorkdays({
    schedule,
    effectiveStart,
    effectiveEnd: monthLastDay,
    tz,
    entryDates,
    approvedLeave: approvedLeave.map((lr) => ({
      startDate: lr.startDate,
      endDate: lr.endDate,
      halfDay: Boolean(lr.halfDay),
    })),
    absences: absences.map((ab) => ({
      startDate: ab.startDate,
      endDate: ab.endDate,
      halfDay: ab.halfDay,
    })),
    holidayDateStrings,
    rosterDates,
  });

  return { gapRuleApplies: true, gapDates: result.gaps.map((g) => g.date) };
}
