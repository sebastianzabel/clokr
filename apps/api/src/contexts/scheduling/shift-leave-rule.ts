/**
 * Issue #744 — the ONE place that decides how an effective leave row relates to a shift.
 *
 * A full-day leave row blocks a shift on its day (409 `SHIFT_CONFLICT_LEAVE`, the
 * `conflictsWithLeave` flag, the leave-approval reverse hook, the generate/copy-week skip). A
 * HALF-day row (`LeaveRequest.halfDay`, always a single date, #449) does not: the employee works
 * the other half of the day (owner decision 25.10.2026, same case class as #728 for clocking), so
 * the shift is allowed and the caller shows a non-blocking hint with the stable code
 * `HALF_DAY_LEAVE`. Half-day plus full-day on the same date: the full day wins.
 *
 * Deliberately a dependency-free leaf (type-only shapes, no import) so the scheduling facade, the
 * shift routes and the Phorest sync can all use it without joining the measured import cycle.
 * The decision is made on the stored `halfDay` boolean only, never on a display string or
 * `leaveType.name`.
 */

/** Stable control value of the non-blocking hint; the German text is display only. */
export const HALF_DAY_LEAVE_CODE = "HALF_DAY_LEAVE";

/** A leave row as far as this rule is concerned. */
export interface ShiftLeaveRow {
  halfDay: boolean;
}

/** `true` when the row blocks a shift on its day (a full-day row). */
export function leaveBlocksShift(row: ShiftLeaveRow): boolean {
  return !row.halfDay;
}

/**
 * Splits the effective leave rows of ONE day: the first blocking (full-day) row wins, a half-day
 * row is only reported when no full-day row exists.
 */
export function splitLeaveForShift<T extends ShiftLeaveRow>(
  rows: readonly T[],
): { blocking: T | null; halfDay: T | null } {
  const blocking = rows.find(leaveBlocksShift) ?? null;
  const halfDay = blocking ? null : (rows.find((r) => r.halfDay) ?? null);
  return { blocking, halfDay };
}

/** The non-blocking hint a shift write returns when its day carries a half-day leave. */
export interface HalfDayLeaveHint {
  code: typeof HALF_DAY_LEAVE_CODE;
  message: string;
  leaveRequestId: string;
}

export function halfDayLeaveHint(leaveRequestId: string, dateDe: string): HalfDayLeaveHint {
  return {
    code: HALF_DAY_LEAVE_CODE,
    message: `Am ${dateDe} hat die Person einen halben Tag frei. Plane die Schicht nur für die andere Tageshälfte.`,
    leaveRequestId,
  };
}
