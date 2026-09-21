/**
 * month-close-window.ts — the month-stepping and window arithmetic of the Monatsabschluss.
 *
 * Phase 292 (GitHub issue #292). These four helpers were private to
 * `plugins/auto-close-month.ts`. They are now shared, because a SECOND reader needs exactly the
 * same arithmetic: `deferred-month-close.ts` answers "which months of this employee are past
 * their window and still unclosed?" — the very question the cron answers implicitly while it
 * walks. A reader that re-derived the window would report a deferral the cron does not have, or
 * miss one it does; the escalation would then describe a state that never existed.
 *
 * Purity contract: no Prisma import, no DB/network call, no async. `isMonthPastItsWindow` takes
 * `now` explicitly instead of reading the clock, so the escalation and the cron can be measured
 * against the same instant.
 */

import { dateStrInTz } from "./timezone";

/** A calendar month in the tenant's timezone. `month` is 1-based (1 = January). */
export type MonthKey = { year: number; month: number };

/**
 * The default retro self-service window in days, used when a tenant has no
 * `TenantConfig.retroEntryWindowDays`. Stated once — `auto-close-month.ts` and the deferral
 * reader must not each carry their own literal.
 */
export const DEFAULT_RETRO_ENTRY_WINDOW_DAYS = 10;

/**
 * Compute the previous month (with year wrap: Jan → Dec of prior year).
 * Used inside the backward loop to step between months.
 */
export function computePrevMonthInLoop(month: number, year: number): MonthKey {
  if (month === 1) return { month: 12, year: year - 1 };
  return { month: month - 1, year };
}

/**
 * Build an ordered list of { year, month } keys from firstOpen to ceiling (both inclusive),
 * oldest-first. Returns empty if firstOpen > ceiling.
 *
 * The loop iterates by stepping month+1 and wrapping Dec→Jan. This handles cross-year
 * ranges without any special-casing at the call site.
 */
export function buildMonthRange(firstOpen: MonthKey, ceiling: MonthKey): MonthKey[] {
  const result: MonthKey[] = [];
  let cur = { ...firstOpen };
  // Safety: max 60 months to prevent runaway loops
  let guard = 0;
  while (guard++ < 60) {
    // Stop if cur > ceiling
    if (cur.year > ceiling.year || (cur.year === ceiling.year && cur.month > ceiling.month)) {
      break;
    }
    result.push({ ...cur });
    // Advance to next month
    if (cur.month === 12) {
      cur = { year: cur.year + 1, month: 1 };
    } else {
      cur = { year: cur.year, month: cur.month + 1 };
    }
  }
  return result;
}

/**
 * Compute the first open month for an employee: max(hireMonth, lastSnapshotMonth+1).
 * Returns null if the employee has no hire date (shouldn't happen in practice).
 */
// Returns a month for EVERY input — there is no "no first open month" case: with no prior
// snapshot the hire month is the answer, and with one it is max(hireMonth, lastClosed + 1).
// The return type said `MonthKey | null` when this was lifted out of auto-close-month.ts, which
// made both callers carry an `if (... === null) continue` that CodeQL correctly reported as a
// guard that always evaluates to false (js/useless-expression, PR #298). A guard that cannot
// fire is indistinguishable from one that has stopped working — the same defect family the
// anti-vacuity gate exists for — so the type is narrowed and the dead guards are gone.
export function computeFirstOpenMonth(
  hireDate: Date,
  lastSnap: { periodStart: Date } | null,
  tz: string,
): MonthKey {
  // TZ-normalize hireDate to get the calendar month in tenant timezone
  const hireDateStr = dateStrInTz(hireDate, tz);
  const [hireYearStr, hireMonthStr] = hireDateStr.split("-");
  const hireYear = parseInt(hireYearStr, 10);
  const hireMonth = parseInt(hireMonthStr, 10); // 1-based

  if (lastSnap === null) {
    // No prior snapshot → start from hire month
    return { year: hireYear, month: hireMonth };
  }

  // lastSnap.periodStart is a @db.Date — extract year and month from it.
  // The periodStart may be TZ-converted (e.g. 2026-05-31 for June/Berlin) or
  // UTC-naive (2026-06-01). Use the UTC date part and add 15 days, then extract the month,
  // which lands inside the correct month under either convention.
  // Since lastSnap is the newest active snapshot (found by orderBy:desc), its periodStart
  // tells us which calendar month was last closed. The next open month = that month + 1.
  const psDate = lastSnap.periodStart;
  const psMidMonthDate = new Date(psDate.getTime() + 15 * 24 * 60 * 60 * 1000); // +15d → definitely in the correct month
  const psMidMonthStr = dateStrInTz(psMidMonthDate, tz);
  const [snapYearStr, snapMonthStr] = psMidMonthStr.split("-");
  const snapYear = parseInt(snapYearStr, 10);
  const snapMonth = parseInt(snapMonthStr, 10); // 1-based

  // Next open month = snapMonth + 1 (with year wrap)
  let nextYear = snapYear;
  let nextMonth = snapMonth + 1;
  if (nextMonth === 13) {
    nextMonth = 1;
    nextYear += 1;
  }

  // Return max(hireMonth, nextMonth) in chronological order
  if (nextYear > hireYear || (nextYear === hireYear && nextMonth >= hireMonth)) {
    return { year: nextYear, month: nextMonth };
  }
  return { year: hireYear, month: hireMonth };
}

/**
 * Returns true when `now` (in the given tenant timezone) is AT or AFTER day N of month M+1
 * (the "window close" date for month M). Returns false while employees can still self-service.
 *
 * Decision matrix:
 *   - now is still in month M or earlier → false (window not yet open)
 *   - now is in month M+1 and todayDay < retroWindowDays → false (within window)
 *   - now is in month M+1 and todayDay >= retroWindowDays → true (at/after day N)
 *   - now is after month M+1 → true (long past window; old backfill)
 *
 * Handles Dec→Jan year rollover for M+1. Uses tenant-TZ dateStrInTz — never UTC math.
 */
export function isMonthPastItsWindow(
  monthYear: number,
  monthNum: number,
  tz: string,
  retroWindowDays: number,
  now: Date = new Date(),
): boolean {
  const todayStr = dateStrInTz(now, tz); // YYYY-MM-DD in tenant TZ
  const ty = parseInt(todayStr.slice(0, 4), 10);
  const tm = parseInt(todayStr.slice(5, 7), 10);
  const td = parseInt(todayStr.slice(8, 10), 10);
  const wm = monthNum === 12 ? 1 : monthNum + 1; // window-close month (M+1)
  const wy = monthNum === 12 ? monthYear + 1 : monthYear;
  if (ty < wy) return false; // now is before M+1 → still within window
  if (ty === wy && tm < wm) return false; // now is still in M or earlier → within window
  if (ty === wy && tm === wm) return td >= retroWindowDays; // in M+1: check day N
  return true; // now is after M+1 → long past window
}
