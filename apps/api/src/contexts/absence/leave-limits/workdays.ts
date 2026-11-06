/**
 * Issue #836 (D-836-04, D-836-17) — which days of a window a person would work. Pure, no I/O.
 *
 * The one workday definition of the leave limits. It reuses the contract segment valid on the day
 * (`contractSegmentAt`, #450 semantics) and the segment's `resolvedWorkDays` / `usualWorkDays` —
 * never the `{day}Hours` placeholders and never the raw `workDays` column (CLAUDE.md § Schedule
 * Types). Weekday 0 = Sunday, the `workDays` convention (`getUTCDay`); the Monday-based helper of
 * the salon-assignment rules is deliberately not used here.
 *
 *  - Not SHIFT_BASED: a workday iff the contract's weekday set holds the weekday AND the day is no
 *    holiday at the person's work location.
 *  - SHIFT_BASED: a workday iff the roster holds a shift that day (it counts on a holiday or a
 *    weekend too — the shift is the actual plan), OR the weekday rule holds and the day is no holiday.
 *    The weekday rule is the `usualWorkDays` Angabe when it is non-empty, else the resolved workday
 *    set (the fallback chain of `workDaysSetFrom`).
 */
import type { LoadedContractSegment } from "../leave-days";
import { contractSegmentAt } from "../vacation-calc";

export function workdaysOf(input: {
  /** `YYYY-MM-DD`, ascending; the days to judge. */
  days: readonly string[];
  segments: readonly LoadedContractSegment[];
  /** Holidays at the person's work location, `YYYY-MM-DD`. */
  holidays: ReadonlySet<string>;
  /** Days with a roster shift of the person (only read for SHIFT_BASED segments). */
  rosterDays: ReadonlySet<string>;
}): Set<string> {
  const workdays = new Set<string>();
  for (const day of input.days) {
    const at = new Date(`${day}T00:00:00Z`);
    const segment = contractSegmentAt(input.segments, at);
    const dow = at.getUTCDay();
    const holiday = input.holidays.has(day);
    if (segment.type !== "SHIFT_BASED") {
      if (segment.resolvedWorkDays.includes(dow) && !holiday) workdays.add(day);
      continue;
    }
    if (input.rosterDays.has(day)) {
      workdays.add(day);
      continue;
    }
    const weekdays =
      segment.usualWorkDays.length > 0 ? segment.usualWorkDays : segment.resolvedWorkDays;
    if (weekdays.includes(dow) && !holiday) workdays.add(day);
  }
  return workdays;
}
