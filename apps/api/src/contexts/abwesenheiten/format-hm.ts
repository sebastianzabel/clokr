/**
 * format-hm.ts
 *
 * Phase 100 (OTC-06) — H:MM formatter for the API-side German OVERTIME_COMP
 * rejection copy (`apps/api/src/routes/leave.ts`).
 *
 * `apps/web`'s equivalent formatter (`fmtMin`,
 * `apps/web/src/lib/utils/format-minutes.ts`) lives in a separate package and is
 * not importable from `apps/api` — this is the SAME algorithm, deliberately
 * duplicated across the package boundary rather than reached across it (no
 * shared-utils package exists for one function).
 */

/**
 * Formats a signed minute count as `H:MM`, e.g. `120` -> `"2:00"`, `-90` ->
 * `"−1:30"` (U+2212 MINUS SIGN, never an ASCII hyphen — matches `fmtSigned`/
 * `fmt()` on the web side).
 */
export function formatMinutesHM(minutes: number): string {
  const sign = minutes < 0 ? "−" : "";
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const mins = String(abs % 60).padStart(2, "0");
  return `${sign}${hours}:${mins}`;
}
