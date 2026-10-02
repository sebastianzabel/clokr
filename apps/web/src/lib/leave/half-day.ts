/**
 * Issue #449 (D-4): a half-day leave request may only ever cover a single calendar date — the
 * entitlement booking deducts a flat 0.5 days for a half day while the saldo halves the whole
 * requested range, so a multi-day half-day request makes entitlement and saldo permanently
 * disagree (Befund G5). `apps/api/src/contexts/absence/api/leave.ts` enforces this server-side
 * (the sole authority); this module is the client-side convenience layer two forms share:
 * `LeaveRequestForm.svelte` (create/edit) and `team/leave/+page.svelte`'s Korrektur-Modal.
 *
 * Plain `.ts`, no `$app`/`$stores` imports, so it stays importable from a unit test
 * (apps/web/vitest.config.ts registers no `$app/*` alias).
 */

/** Must stay byte-identical to the API's own message (`leave.ts`'s `HALF_DAY_SINGLE_DATE_MESSAGE`). */
export const HALF_DAY_SINGLE_DATE_MESSAGE =
  "Ein halber Tag ist nur für ein einzelnes Datum möglich.";

/**
 * `null` when the combination is valid (not a half day, both dates equal, or a required date is
 * still empty — required-field validation lives elsewhere, this helper never reports on it).
 * Returns the shared message otherwise, so a caller can render it as a hint and/or refuse submit.
 */
export function halfDayRangeError(
  halfDay: boolean,
  startDate: string,
  endDate: string,
): string | null {
  if (!halfDay) return null;
  if (!startDate || !endDate) return null;
  return startDate === endDate ? null : HALF_DAY_SINGLE_DATE_MESSAGE;
}

/**
 * The end date a half-day request should carry: the start date when `halfDay` is ticked,
 * `endDate` unchanged otherwise. Callers invoke this only on USER ACTION (ticking the box,
 * changing the start date) — never reactively on load, or a loaded legacy multi-day half-day
 * request would be silently collapsed the moment its edit/correction dialog opens.
 */
export function endDateForHalfDay(halfDay: boolean, startDate: string, endDate: string): string {
  return halfDay ? startDate : endDate;
}
