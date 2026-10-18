/**
 * Issue #670 - the vocabulary of `GET /dashboard/my-week`.
 *
 * "Meine Woche" reads the one day-status function (`resolveDayStatus`, Issue #587) with the same
 * person-day inputs as the team week and the attendance list. Its response keeps the field values
 * the web already renders, so this module is the DOCUMENTED MAPPING from the shared status to the
 * my-week value. It is a pure translation: it decides nothing about obligation, timing or presence
 * (that stays in `contexts/time-tracking/presence.ts`) and calls none of the status primitives.
 *
 *   shared status        my-week status
 *   clocked_in           clocked_in
 *   present              complete (worked >= expected) | partial (worked < expected)
 *   requested            requested
 *   absent (leave)       leave        - APPROVED and CANCELLATION_REQUESTED leave
 *   absent (absence)     sick (SICK, SICK_CHILD) | absent (every other imposed absence)
 *   holiday              holiday
 *   missing              missing
 *   scheduled            scheduled
 *   none                 weekend (Saturday/Sunday) | none (any other day)
 *
 * A weekend day that the contract owes (`workDays` contains it) or that carries a shift never
 * reaches "none": the shared function reads it as "scheduled" or "missing", exactly like the team
 * week (Issue #670, A5).
 */
import type { DayStatus } from "../contexts/time-tracking";

export type MyWeekStatus =
  | "clocked_in"
  | "complete"
  | "partial"
  | "leave"
  | "requested"
  | "sick"
  | "absent"
  | "holiday"
  | "missing"
  | "scheduled"
  | "weekend"
  | "none";

export function myWeekStatusOf(input: {
  status: DayStatus["status"];
  /** The effective leave of the day (after the Berufsschule displacement) was a leave row. */
  hasLeave: boolean;
  absenceType: string | null;
  isWeekend: boolean;
  workedMinutes: number;
  expectedMinutes: number;
}): MyWeekStatus {
  switch (input.status) {
    case "clocked_in":
      return "clocked_in";
    case "present":
      return input.workedMinutes >= input.expectedMinutes ? "complete" : "partial";
    case "requested":
      return "requested";
    case "absent":
      if (input.hasLeave) return "leave";
      return input.absenceType === "SICK" || input.absenceType === "SICK_CHILD" ? "sick" : "absent";
    case "holiday":
      return "holiday";
    case "missing":
      return "missing";
    case "scheduled":
      return "scheduled";
    case "none":
      return input.isWeekend ? "weekend" : "none";
  }
}
