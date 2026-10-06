/**
 * entry-durations.ts — Phase 79 (Issue #79), D-01/D-02/D-03/D-12.
 *
 * The ONE place a stored TimeEntry is turned into its presence time and its working time.
 *
 *   presence time = endTime - startTime
 *   working time  = presence time - the STORED `breakMinutes`
 *
 * `breakMinutes` is the authoritative recorded break: it is consolidated from the `Break[]` rows by
 * `services/clock/consolidate.ts` when the entry is written (D-02). The auto-break of
 * `break-effective.ts` is never re-applied here — whatever the write path stored is what counts,
 * and an auto-deducted break is presence, not working time.
 *
 * The values are exact minutes: never rounded, never clamped. Every caller keeps its own rounding
 * and clamping around the call (D-04), so a stored row yields the same float it always did. Both
 * quantities are DERIVED, never stored (D-01) — there is nothing to migrate and a locked month can
 * not drift. An open entry (no endTime) yields presence 0 and working 0 (D-03).
 *
 * Read by: Arbeitszeitkonto (close-employee-month, month-saldo, overtime-balance), the composition
 * layer (dashboard, reports), the ArbZG checks (arbzg.ts), the GET /time-entries per-entry fields
 * and the /time-entries/summary route. Other contexts import it through `contexts/time-tracking/
 * index.ts`, never this file (D-05).
 *
 * This module has no imports on purpose: it can never join an import cycle.
 *
 * NON-GOAL — deliberately different calculations that are NOT this rule and stay as they are:
 * the JArbSchG pre-write plan values (`plannedNetMinPost`, `plannedNetMinPut` in api/time-entries.ts,
 * `correctedNetWorkMin` in api/retro-entry-requests.ts — they round the presence first and clamp
 * at 0 on PROPOSED values), the gross presence fed into the auto-break decision of
 * `break-effective.ts`, `calcBreakMinutes` (it PRODUCES the break) and shift netto
 * (`scheduling/shift-netto.ts`, a Shift has no break column).
 */

/** The three fields of a TimeEntry the durations are derived from. */
export interface EntryDurationInput {
  /** Clock-in instant. */
  startTime: Date;
  /** Clock-out instant; null while the entry is open. */
  endTime: Date | null;
  /** Stored break in minutes (bigint accepted for the Prisma column type); null or missing means 0. */
  breakMinutes?: number | bigint | null;
}

/** Presence time, working time and the stored break of one entry, all in minutes. */
export interface EntryDurations {
  /** endTime - startTime in minutes; exact, unrounded, 0 for an open entry. */
  presenceMinutes: number;
  /** presenceMinutes - breakMinutes; exact, unrounded, NOT clamped (may be negative), 0 for an open entry. */
  workingMinutes: number;
  /** The stored break in minutes (0 when null or missing), also reported for an open entry. */
  breakMinutes: number;
}

export function entryDurations(e: EntryDurationInput): EntryDurations {
  const breakMinutes = Number(e.breakMinutes ?? 0);
  if (!e.endTime) {
    return { presenceMinutes: 0, workingMinutes: 0, breakMinutes };
  }
  const presenceMinutes = (e.endTime.getTime() - e.startTime.getTime()) / 60000;
  const workingMinutes = presenceMinutes - breakMinutes;
  return { presenceMinutes, workingMinutes, breakMinutes };
}

/**
 * One step of a left fold over working minutes: `(sum + presence) - break`, evaluated left to right
 * (D-12). An open entry returns `sum` unchanged.
 *
 * The association is deliberate. Floats are not associative, and the pre-79 folds in the saldo,
 * the reports and the ArbZG checks all computed `sum + presence - break` left to right. Do NOT
 * simplify this to `sum + entryDurations(e).workingMinutes`: that is `sum + (presence - break)` and
 * changes the last bit for millisecond-precision rows.
 */
export function addWorkingMinutes(sum: number, e: EntryDurationInput): number {
  if (!e.endTime) return sum;
  return sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes ?? 0);
}
