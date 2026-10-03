/**
 * Phase 60 (v1.6.5, GitHub #220) — WorkSchedule.validFrom month-1st enforcement.
 *
 * Background: WorkSchedule.validFrom landing mid-month caused hybrid-month saldo
 * behavior. When `getEffectiveSchedule(employeeId)` is called without a `forDate`
 * argument (e.g. in updateOvertimeAccount), it picks the newest schedule row and
 * applies it to the entire open-period range — including days BEFORE the switch.
 * an employee (a-tenant tenant, 2026-05-18) switched FIXED_SCHEDULE → SHIFT_BASED
 * mid-month and her May 1-17 worked hours got matched against SHIFT_BASED's
 * Σ-shifts-expected = 0, producing 70h of phantom overtime.
 *
 * Fix shape: validate that every NEW schedule-change writes a validFrom that is
 * the 1st of a calendar month. Existing non-1st rows are preserved (audit trail
 * per CLAUDE.md Revisionssicherheit) and surfaced by a one-off audit script.
 *
 * This module is the single source of truth for:
 *   - the German error string surfaced to the API client
 *   - the Zod refinement predicate
 *   - the deterministic snap-to-1st helper used by the bulk-apply flow
 *   - Issue #450 (D-04), read side: `snapToMonthFirstUtc`'s `"up"` direction, consumed by
 *     `contexts/absence/leave-days.ts`'s `loadVacationContractSegments` — a pre-Phase-60
 *     contract change whose `validFrom` is not the 1st of a month takes effect on the 1st of the
 *     FOLLOWING month for the vacation-entitlement segment calculation, never as a fractional
 *     month. This is additive (Unterbau Erweiterung, ADR 0002 Entscheidung 7) — the default
 *     `"down"` direction and every existing caller are unchanged.
 *
 * Out of scope (kept stable):
 *   - POST /employees initial schedule (validFrom = hireDate may be mid-month)
 *   - EmployeeShiftPattern.validFrom (different semantics)
 *   - EmployeeAvailability.validFrom (different semantics — calendar-day overrides)
 *   - Auto-migration of existing non-1st WorkSchedule rows (audit script flags them)
 */

/**
 * German error string surfaced to the API client when a non-month-1st validFrom
 * is submitted. Kept as a named constant so tests can assert against it without
 * string duplication, and so CLAUDE.md grep targets a single canonical phrase.
 */
export const MONTH_FIRST_ERROR = "Vertragswechsel sind nur zum Monats-1. erlaubt.";

/**
 * Phase 76.24 (v1.8.16, GitHub #220 extension) — same-month AZ-model-switch collision.
 *
 * Background: `PUT /settings/work/:employeeId` had a history-loss gap: when a
 * WorkSchedule row already existed at `validFrom` (same month-1st) and the submitted
 * `type` differed, the prior model was silently overwritten in place. This makes it
 * impossible for past-month closes to resolve the model that was actually in effect.
 *
 * This constant is the canonical German error message returned (HTTP 400) when
 * a model-type change collides with an existing same-month-1st row. It is kept as a
 * named constant so tests can assert against it without string duplication (D-01b),
 * and so grep targets a single canonical phrase for audit trail compliance.
 *
 * Fire condition: WorkSchedule row exists for {employeeId, validFrom = month-1st}
 * AND the submitted `type` differs from that row's type. A pure hours-only edit
 * within the same type keeps the existing update-in-place path (D-01a — no rejection).
 */
export const MODEL_SWITCH_SAME_MONTH_ERROR =
  "Für diesen Monat existiert bereits ein Arbeitszeitmodell — ein Modellwechsel ist nur zum 1. eines Monats ohne bestehendes Modell möglich.";

/**
 * Returns true if `s` is the string "YYYY-MM-01" (month-1st), false otherwise.
 * Defensive against non-date strings — does NOT throw on garbage input.
 *
 * The Zod schema already enforces the YYYY-MM-DD shape via .regex(), so this
 * check is reached only with well-formed date strings in production. The
 * defensive parsing is for direct unit-test invocation and future callers.
 */
export function isMonthFirstDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  return m[3] === "01";
}

/**
 * Zod refinement predicate. Use as:
 *   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(monthFirstRefinement, { message: MONTH_FIRST_ERROR })
 *
 * Returns true when the value is acceptable (= month-1st).
 */
export const monthFirstRefinement = (s: string): boolean => isMonthFirstDate(s);

/**
 * Returns a new Date set to the 1st of the input's UTC month at 00:00:00.000Z — direction
 * `"down"` (the default, pre-existing behavior). Idempotent: snap(snap(d)) === snap(d).
 *
 * Used by the applyToExisting bulk-apply flow so server-side "now" timestamps
 * are normalized to month-1st before being written to WorkSchedule.validFrom.
 *
 * UTC components are used deliberately — WorkSchedule.validFrom is stored as
 * Timestamptz and the saldo engine compares it against UTC midnights elsewhere
 * (recalculate-snapshots.ts midpoint heuristic).
 *
 * Issue #450 (D-04) — direction `"up"`: a date already on the 1st (any time-of-day) stays in its
 * own UTC month; any other date moves to the 1st of the FOLLOWING UTC month. Also idempotent
 * (the result of `"up"` is always on the 1st, so a second `"up"` call takes the `"down"` branch
 * and returns the same value). Used by `loadVacationContractSegments` (Issue #450, D-04) so a
 * pre-Phase-60 contract change that was not written on the 1st takes effect on the 1st of the
 * following month, never as a fractional month.
 */
export function snapToMonthFirstUtc(date: Date, direction: "down" | "up" = "down"): Date {
  if (direction === "up" && date.getUTCDate() !== 1) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}
