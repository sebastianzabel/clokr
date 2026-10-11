// Issue #511 (D-05) — the ONE decision "is the employee under 18 on this calendar day".
//
// Read by the § 11 JArbSchG break regime (time-tracking/arbzg.ts, the month-close detector, the
// day-break routes) and by the § 9 JArbSchG Berufsschule block (jarbschg.ts), so the two can never
// disagree about who is a minor.
//
// IMPORT DISCIPLINE: this file imports only the two zero-import leaves below. It must stay a leaf
// so that adding it to the absence index never pulls another module into the capped import-cycle
// count (`measure-context-boundary-imports.ts --cycles`). `age-at-date.ts` keeps its zero-import
// contract; the threshold lives in `vocational-school-constants.ts`.
import { ageAtDate } from "./age-at-date";
import { JARBSCHG_MINOR_AGE_THRESHOLD } from "./vocational-school-constants";

/**
 * True when `birthDate` makes the employee younger than 18 on `atDate`.
 *
 * Calendar-day semantics in UTC: callers pass the UTC-midnight date of the tenant-local work day,
 * exactly as it is stored in `TimeEntry.date`. The 18th birthday itself is already adult (§ 187
 * Abs. 2 S. 2 BGB, same rule as `ageAtDate`).
 *
 * Fail-open on purpose: a missing birth date is NOT a minor. Surfacing a stricter regime on missing
 * data would misjudge every adult employee whose birth date was never entered; the callers decide
 * whether the gap is worth a note (apprentices only, see `isApprenticeWithoutBirthDate`).
 */
export function isMinorAtDate(birthDate: Date | null | undefined, atDate: Date): boolean {
  if (!birthDate) return false;
  return ageAtDate(birthDate, atDate) < JARBSCHG_MINOR_AGE_THRESHOLD;
}
