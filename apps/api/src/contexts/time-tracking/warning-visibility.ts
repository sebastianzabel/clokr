// Issue #85 (D-12) - which ArbZG warnings of a save response the writing caller may see.
//
// `checkArbZG` sums EVERY entry of the person: the day (all salons), the previous and next day
// (rest period), the ISO week (weekly total) and the last 168 days (24-week average). A manager
// whose read reach covers only one salon therefore learns from "Diese Woche: 47.5 h" or
// "Ruhezeit: 8.5 h" how much the person worked in a salon the manager cannot see (DSGVO Art. 5
// Abs. 1 lit. c, the same leak class as the day check of D-07).
//
// This module decides VISIBILITY only, never whether a warning exists. A warning stays exactly as
// it is when every non-deleted entry of the person inside the window it rests on is in the
// caller's scope; otherwise it is replaced - together with every other withheld warning - by ONE
// neutral item (`withheldFindingWarning()`), appended after the kept ones. The windows are calendar
// days of `TimeEntry.date` and deliberately at least as wide as what `checkArbZG` reads, so a doubt
// withholds. The scope decision is the Unterbau's (`scopedTimeEntryIds`); no Stammsalon or salon
// rule is re-derived here.
import type { Prisma } from "@clokr/db";
import { resolveAccessReach, scopedTimeEntryIds, type AccessContext } from "../platform";
import { dateStrInTz, weekDateRange } from "../working-time-account";
import { withheldFindingWarning, type ArbZGWarning } from "./arbzg";

const DAY_MS = 86_400_000;
/** The 24-week window `checkArbZG` averages over, in days (one more than it reads on purpose). */
const AVERAGE_WINDOW_DAYS = 168;

/** A closed interval of calendar days (UTC-midnight dates). */
export interface WarningWindow {
  from: Date;
  to: Date;
}

function shiftDays(day: Date, days: number): Date {
  return new Date(day.getTime() + days * DAY_MS);
}

/**
 * The calendar-day window of the person's entries a warning rests on.
 *
 *   - BREAK_* and MAX_DAILY_EXCEEDED: the entry's day
 *   - MIN_REST_VIOLATED: the previous day to the next day
 *   - MAX_WEEKLY_EXCEEDED: the ISO week of the day
 *   - MAX_DAILY_AVG_EXCEEDED: the 168 days up to the day
 *   - any other code: the widest window, so a code added later withholds instead of leaking
 *
 * Pure. `day` is the UTC-midnight date of the tenant-local day; `week` its Monday and Sunday.
 */
export function warningWindow(
  code: string,
  day: Date,
  week: { firstDay: Date; lastDay: Date },
): WarningWindow {
  if (code.startsWith("BREAK_") || code === "MAX_DAILY_EXCEEDED") {
    return { from: day, to: day };
  }
  if (code === "MIN_REST_VIOLATED") {
    return { from: shiftDays(day, -1), to: shiftDays(day, 1) };
  }
  if (code === "MAX_WEEKLY_EXCEEDED") {
    return { from: week.firstDay, to: week.lastDay };
  }
  if (code === "MAX_DAILY_AVG_EXCEEDED") {
    return { from: shiftDays(day, -AVERAGE_WINDOW_DAYS), to: day };
  }
  const next = shiftDays(day, 1);
  return {
    from: shiftDays(day, -AVERAGE_WINDOW_DAYS),
    to: next.getTime() > week.lastDay.getTime() ? next : week.lastDay,
  };
}

export interface WarningVisibilityInput {
  tenantId: string;
  access: AccessContext;
  /** The caller's own employee id; `null` for an actor without one (API key). */
  callerEmployeeId: string | null;
  /** The person the warnings were computed for. */
  employeeId: string;
  /** The changed date as passed to `checkArbZG`. */
  date: Date;
  tz: string;
  warnings: ArbZGWarning[];
}

/**
 * The warnings the caller may see: kept as they are when the caller's `time-entry:read` reach
 * covers every entry they rest on, otherwise collapsed into one neutral item. No extra read for an
 * empty list, the person themself or a whole-tenant caller; otherwise one scope query and one read
 * of the person's entry ids and dates over the union window.
 */
export async function warningsVisibleToCaller(
  db: Prisma.TransactionClient,
  input: WarningVisibilityInput,
): Promise<ArbZGWarning[]> {
  const { warnings, employeeId, tenantId } = input;
  if (warnings.length === 0) return warnings;
  if (input.callerEmployeeId !== null && input.callerEmployeeId === employeeId) return warnings;

  const reach = await resolveAccessReach(db, input.access, "time-entry:read:ZUGEWIESEN");
  if (reach.kind === "wholeTenant") return warnings;

  const dayStr = dateStrInTz(input.date, input.tz);
  const day = new Date(`${dayStr}T00:00:00Z`);
  // Noon keeps the reference instant on the same calendar day in every time zone.
  const week = weekDateRange(new Date(`${dayStr}T12:00:00Z`), input.tz);
  const windows = warnings.map((w) => warningWindow(w.code, day, week));
  const unionFrom = new Date(Math.min(...windows.map((w) => w.from.getTime())));
  const unionTo = new Date(Math.max(...windows.map((w) => w.to.getTime())));

  const [scoped, rows] = await Promise.all([
    scopedTimeEntryIds(db, tenantId, reach, unionFrom, unionTo),
    db.timeEntry.findMany({
      where: {
        employeeId,
        employee: { tenantId },
        deletedAt: null,
        date: { gte: unionFrom, lte: unionTo },
      },
      select: { id: true, date: true },
    }),
  ]);
  const inScope = scoped === "all" ? null : new Set(scoped);

  const kept: ArbZGWarning[] = [];
  let withheld = false;
  warnings.forEach((warning, index) => {
    const { from, to } = windows[index];
    const covered = rows.every(
      (row) =>
        row.date.getTime() < from.getTime() ||
        row.date.getTime() > to.getTime() ||
        inScope === null ||
        inScope.has(row.id),
    );
    if (covered) kept.push(warning);
    else withheld = true;
  });
  if (withheld) kept.push(withheldFindingWarning());
  return kept;
}
