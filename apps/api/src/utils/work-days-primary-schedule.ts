/**
 * work-days-primary-schedule.ts
 *
 * Phase 111 — projects a WorkSchedule row into the shape findMissingWorkdays() needs
 * so that its FIXED branch becomes workDays-primary WITHOUT changing findMissingWorkdays()
 * itself (Umfangsgrenze of GitHub issue #114).
 *
 * findMissingWorkdays() enumerates expected FIXED days via getDayHoursFromSchedule(), i.e.
 * the {day}Hours columns. For every schedule type other than FIXED_SCHEDULE those columns are
 * a legacy 1/0 flag rather than hours, and even for FIXED_SCHEDULE legacy rows may diverge from
 * `workDays` (pre-Phase-61 rows; see scripts/audit-workdays-vs-day-hours.ts).
 *
 * This helper zeroes the {day}Hours of every weekday that isObligatedWorkday() — the SAME
 * predicate the three other dashboard sites use — reports as non-obligated. It therefore adds
 * NO new obligation semantics; it only re-expresses the existing one in the {day}Hours channel.
 *
 * `hasShift: false` is deliberate: SHIFT_BASED obligation comes from `rosterDates`, never from
 * this projection, so zeroing all seven keys for SHIFT_BASED is both correct and inert.
 *
 * Pure: no DB, no async, input object never mutated.
 */
import { isObligatedWorkday } from "./presence";

// MUST stay index-aligned with getDayHoursFromSchedule()'s array in
// apps/api/src/utils/timezone.ts (index 0 = Sunday). Do not reorder.
const DOW_KEYS = [
  "sundayHours",
  "mondayHours",
  "tuesdayHours",
  "wednesdayHours",
  "thursdayHours",
  "fridayHours",
  "saturdayHours",
] as const;

export function workDaysPrimarySchedule(
  schedule: Record<string, unknown>,
): Record<string, unknown> {
  const scheduleType = schedule.type == null ? null : String(schedule.type);
  const workDays = Array.isArray(schedule.workDays) ? schedule.workDays.map(Number) : [];

  const projected: Record<string, unknown> = { ...schedule };

  for (let dow = 0; dow < DOW_KEYS.length; dow++) {
    const key = DOW_KEYS[dow];
    const expectedHours = Number(schedule[key] ?? 0);
    const obligated = isObligatedWorkday({
      scheduleType,
      workDays,
      dow,
      expectedHours,
      hasShift: false,
    });
    if (!obligated) projected[key] = 0;
  }

  return projected;
}
