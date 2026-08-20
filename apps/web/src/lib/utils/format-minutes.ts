// Quick task 260820-elk — shared minute formatters for the NEW SollIstBar /
// MonatSaldoCard / KontoSaldoCard components only.
//
// This is a DELIBERATE extraction, not a refactor: `routes/(app)/time-entries/+page.svelte`
// keeps its own `fmtMin` / `fmtSigned` (lines ~779-812) because the calendar cells depend on
// their EXACT existing behaviour. Re-pointing the page onto this shared module is out of scope
// for this task (see follow_ups in 260820-elk-PLAN.md).
//
// Semantics copied verbatim from the page's own formatters:
//   fmtMin    — zero-padded "H:MM", no sign (used for absolute quantities like Soll/Ist).
//   fmtSigned — sign-aware "H:MM" with a leading "+"/"−" (U+2212 MINUS SIGN, not ASCII
//               hyphen), matching SaldoAnzeige's own fmt() convention. Exact zero renders
//               bare "0:00" — no "±" prefix (that's fmtBalance's convention, not this one).

/** Format minutes as zero-padded "H:MM" (no sign). Negative input is treated as absolute. */
export function fmtMin(min: number): string {
  const h = Math.floor(Math.abs(min) / 60);
  const m = Math.abs(min) % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

/**
 * Format minutes as a sign-aware "H:MM": "+" for positive, U+2212 MINUS SIGN for negative,
 * no prefix for exact zero (bare "0:00").
 */
export function fmtSigned(min: number): string {
  if (min === 0) return fmtMin(0);
  return (min > 0 ? "+" : "−") + fmtMin(min);
}
