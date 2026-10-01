// Issue #435 — zero-import leaf module (D-07/D-08).
//
// Extracted verbatim from jarbschg.ts (Phase 63), which stays the re-export point for its own
// existing consumers. This file has ZERO imports so vacation-calc.ts can use `ageAtDate` without
// importing jarbschg.ts — jarbschg.ts imports "../working-time-account" (Phase 101B), and
// importing it from vacation-calc.ts would pull vacation-calc.ts into the capped import-cycle
// count (RESEARCH.md Pitfall 1). Both jarbschg.ts and vacation-calc.ts import FROM this leaf,
// never from each other.

/**
 * Returns whole years between `birthDate` and `atDate`, ignoring sub-day precision.
 *
 * UTC-only — TZ-agnostic by design (the JArbSchG age gate operates on the calendar
 * date of the work shift; the choice of TZ for that date is the route's problem, not
 * this helper's).
 *
 * Birthday EXACTLY on `atDate` returns the new age (whole-year boundary inclusive) — § 187
 * Abs. 2 S. 2 BGB.
 * Source equivalent to date-fns `differenceInYears`. No external dep — `date-fns`
 * (plain) is NOT installed in @clokr/api (verified in package.json).
 */
export function ageAtDate(birthDate: Date, atDate: Date): number {
  const by = birthDate.getUTCFullYear();
  const bm = birthDate.getUTCMonth();
  const bd = birthDate.getUTCDate();
  const ay = atDate.getUTCFullYear();
  const am = atDate.getUTCMonth();
  const ad = atDate.getUTCDate();
  let years = ay - by;
  if (am < bm || (am === bm && ad < bd)) years--;
  return years;
}
