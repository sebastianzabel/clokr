/**
 * shift-netto.ts
 *
 * Phase 100 (OTC-04) — pure shift netto-minutes arithmetic, extracted from the `sumShiftNetto`
 * closure at `apps/api/src/utils/month-saldo.ts:390-404` (quoted below verbatim as the source of
 * truth this module is meant to agree with byte-for-byte):
 *
 *   let brutto = hmToMin(sh.endTime) - hmToMin(sh.startTime);
 *   if (brutto < 0) brutto += 24 * 60;                    // midnight-crossing shift
 *   if (brutto <= 0) continue;
 *   const breakMin = getEffectiveBreakDuration(employeeBreakShape, tenantBreakShape, brutto);
 *   total += Math.max(0, brutto - breakMin);
 *
 * `Shift.startTime` / `Shift.endTime` are STRINGS ("06:00"), not DateTime columns (see the
 * `Shift` model in the shared database schema). This module therefore lives entirely in
 * minutes-since-midnight space and never constructs a timezone-aware object from a local time —
 * the same convention `time-arithmetic.ts` states and follows for the Phorest
 * Vor-/Nachbereitungszeit padding.
 *
 * `Shift` has NO `breakMinutes` column. The pre-Phase-100 KNOWN GAP docblock on
 * `getScheduledHours()` (apps/api/src/routes/leave.ts) prescribed a formula of
 * `(endTime - startTime - breakMinutes)`, naming a field that does not exist on `Shift`. The break
 * here instead comes from the shared `getEffectiveBreakDuration()` helper (`break-effective.ts`),
 * the same auto-break resolution TimeEntry and the month-saldo roster-proration already use.
 *
 * NON-GOAL: this module does NOT rewire `month-saldo.ts` onto itself. `month-saldo.ts` sits inside
 * `100-CONTEXT.md`'s scope fence (Saldo-Berechnung), which D-17 leaves standing — D-17 lifts only
 * the forward-going `OvertimeAccount.balanceHours` delta for the OVERTIME_COMP write paths in
 * `leave.ts`, nothing else. The resulting one-phase duplication between this file and the
 * `sumShiftNetto` closure is accepted; a follow-up phase should rewire `month-saldo.ts` onto this
 * module instead of maintaining the arithmetic twice.
 *
 * ONE intentional behavioural difference from the extracted closure: `month-saldo.ts`'s
 * `sumShiftNetto` also skips shifts that fall on a leave/absence-covered date (its `covered` set,
 * built from approved leave + absences) — that is a saldo PRORATION concern ("does this day's
 * roster count toward the month's expected minutes"), not a "how many hours does this request
 * cost" concern. This module deliberately does NOT filter by covered dates; a caller that needs
 * that exclusion applies it to the input array before calling in.
 */
import {
  getEffectiveBreakDuration,
  type BreakEmployeeShape,
  type BreakTenantConfigShape,
} from "./break-effective";

/** Parse "HH:mm" into minutes since 00:00 (mirrors month-saldo.ts's hmToMin). */
function hmToMin(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Netto minutes of a single shift: brutto (end - start, midnight-crossing corrected) minus the
 * auto-break the tenant/employee break configuration prescribes for that brutto duration. Never
 * negative — a break configured longer than the shift floors at 0, not a negative netto.
 */
export function shiftNettoMinutes(
  shift: { startTime: string; endTime: string },
  employee: BreakEmployeeShape,
  tenantConfig: BreakTenantConfigShape,
): number {
  let brutto = hmToMin(shift.endTime) - hmToMin(shift.startTime);
  if (brutto < 0) brutto += 24 * 60; // midnight-crossing shift (e.g. 22:00 -> 06:00)
  if (brutto <= 0) return 0;
  const breakMin = getEffectiveBreakDuration(employee, tenantConfig, brutto);
  return Math.max(0, brutto - breakMin);
}

/** Sum of shiftNettoMinutes() over a list of shifts. Empty list -> 0. */
export function sumShiftNettoMinutes(
  shifts: { startTime: string; endTime: string }[],
  employee: BreakEmployeeShape,
  tenantConfig: BreakTenantConfigShape,
): number {
  return shifts.reduce(
    (total, shift) => total + shiftNettoMinutes(shift, employee, tenantConfig),
    0,
  );
}
