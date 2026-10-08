/**
 * day-break-rule.ts — Issue #80 (D-01, D-04, D-05, D-16, D-17, D-18).
 *
 * The ONE place the day-level § 4 ArbZG break rule and the § 3 ArbZG day sum are evaluated over
 * SEVERAL entries of one employee and one day, possibly in several salons.
 *
 *   - D-01  a gap between entries of DIFFERENT salons is travel time, never a break; a gap of
 *           0 < gap <= 120 minutes between entries of the SAME salon counts as a break (the rule
 *           that held before Phase 80, unchanged).
 *   - D-04/D-05  a recorded day break counts only inside a gap between two entries (clipped to the
 *           gap, overlapping day breaks merged, nothing added inside a same-salon gap that already
 *           counts) and NEVER reduces working time: `netWorkedMin` is the sum of what
 *           `entryDurations()` yields per entry, nothing else.
 *   - D-16  an entry-level WAIVED ("durchgearbeitet") waives a single-salon day exactly as before;
 *           on a cross-salon day only an acknowledgement of the current day state waives it.
 *   - D-17  an acknowledgement is valid only while its stored snapshot (entry ids, salon ids,
 *           net working minutes, total break minutes) equals the day's current snapshot.
 *   - D-18  the § 3 day sum is part of the evaluation; an acknowledgement never downgrades it
 *           (the caller builds the MAX_DAILY_EXCEEDED finding from `netWorkedMin` alone).
 *
 * Input = the closed WORK entries of ONE employee and ONE day in start order, plus the day breaks
 * and acknowledgements recorded for that day. This module never computes presence or working time
 * itself (`entryDurations()` does) and never touches the database.
 *
 * Read by: `checkArbZG` (arbzg.ts), the day-break routes, the month-close detector and the
 * next-day notification job.
 *
 * The only import is the working-time kernel on purpose: no Prisma, no Fastify, no other context.
 */
import { entryDurations } from "./entry-durations";

/** One closed WORK entry of the day, as the evaluation needs it. */
export interface DayBreakRow {
  /** TimeEntry id; part of the acknowledgement snapshot. */
  id: string;
  /** Clock-in instant. */
  startTime: Date;
  /** Clock-out instant; the evaluation only receives closed entries. */
  endTime: Date;
  /** Stored break in minutes (bigint accepted for the Prisma column type); null means 0. */
  breakMinutes: number | bigint | null;
  /** Entry-level break status; only WAIVED matters here (D-16). */
  breakStatus?: string | null;
  /** The salon the entry was worked in (decides whether a gap is travel, D-01). */
  salonId: string;
}

/** A half-open time interval [startTime, endTime). */
export interface DayBreakInterval {
  /** Start instant. */
  startTime: Date;
  /** End instant. */
  endTime: Date;
}

/** One stored acknowledgement of the day; only its snapshot is read. */
export interface DayBreakAckInput {
  /** The snapshot stored at acknowledgement time (untrusted JSON, parsed defensively). */
  snapshot: unknown;
}

/** The state of a day an acknowledgement is bound to (D-17). */
export interface DaySnapshot {
  /** Ids of the day's entries, sorted ascending. */
  entryIds: string[];
  /** Distinct salon ids of the day's entries, sorted ascending. */
  salonIds: string[];
  /** Net working minutes of the day (sum of the entries' working time). */
  netWorkedMin: number;
  /** Total break minutes counted for the day (entry breaks + same-salon gaps + day breaks). */
  totalBreakMin: number;
}

/** Result of evaluating one day. All minute values are exact, unrounded floats. */
export interface DayBreakEvaluation {
  /** Sum of the entries' working time (presence minus stored break); never reduced by day breaks (D-05). */
  netWorkedMin: number;
  /** Sum of the entries' stored break minutes. */
  explicitBreakMin: number;
  /** Same-salon gaps of 0 < gap <= 120 minutes, counted as break (D-01). */
  gapBreakMin: number;
  /** Union of the recorded day breaks inside the gaps that do not already count (D-04/D-05). */
  dayBreakMin: number;
  /** explicitBreakMin + gapBreakMin + dayBreakMin, evaluated left to right. */
  totalBreakMin: number;
  /** Distinct salon ids of the day's entries, sorted ascending. */
  salonIds: string[];
  /** True when the entries lie in two or more salons. */
  crossSalon: boolean;
  /** § 4 ArbZG minimum break for netWorkedMin: 45 above 9 h, 30 above 6 h, else 0 (strict). */
  requiredBreakMin: 0 | 30 | 45;
  /** True when a break is required and totalBreakMin is below it. */
  breakShortfall: boolean;
  /** True when a cross-salon day has an acknowledgement matching the current snapshot (D-17). */
  acknowledged: boolean;
  /** True when the § 4 finding is waived: acknowledgement on a cross-salon day, entry WAIVED otherwise (D-16). */
  waived: boolean;
  /** The snapshot an acknowledgement of this evaluation would store. */
  snapshot: DaySnapshot;
}

/** Sum, in minutes, of the union of `breaks` clipped to [from, to]. */
function unionClippedMinutes(breaks: readonly DayBreakInterval[], from: Date, to: Date): number {
  const lo = from.getTime();
  const hi = to.getTime();
  const clipped: Array<[number, number]> = [];
  for (const b of breaks) {
    const s = Math.max(b.startTime.getTime(), lo);
    const e = Math.min(b.endTime.getTime(), hi);
    if (e > s) clipped.push([s, e]);
  }
  clipped.sort((a, b) => a[0] - b[0]);
  let totalMs = 0;
  let curStart = 0;
  let curEnd = 0;
  let open = false;
  for (const [s, e] of clipped) {
    if (!open) {
      curStart = s;
      curEnd = e;
      open = true;
    } else if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      totalMs += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  if (open) totalMs += curEnd - curStart;
  return totalMs / 60000;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * True only when `stored` is a well-formed snapshot equal to `current` (D-17). Anything malformed
 * (non-object, array, missing or wrongly typed keys) is NOT current, so a damaged or hand-edited
 * acknowledgement can never waive a day.
 */
export function isAckSnapshotCurrent(stored: unknown, current: DaySnapshot): boolean {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return false;
  const s = stored as Record<string, unknown>;
  if (!isStringArray(s.entryIds) || !isStringArray(s.salonIds)) return false;
  if (typeof s.netWorkedMin !== "number" || typeof s.totalBreakMin !== "number") return false;
  return (
    sameStrings(s.entryIds, current.entryIds) &&
    sameStrings(s.salonIds, current.salonIds) &&
    s.netWorkedMin === current.netWorkedMin &&
    s.totalBreakMin === current.totalBreakMin
  );
}

/**
 * Evaluates the § 4 break rule of one day over its closed WORK entries (`rows`, start order).
 * See the file docblock for the decisions it carries.
 */
export function evaluateDayBreaks(input: {
  rows: readonly DayBreakRow[];
  dayBreaks: readonly DayBreakInterval[];
  acks: readonly DayBreakAckInput[];
}): DayBreakEvaluation {
  const { rows, dayBreaks, acks } = input;

  // Net working time + explicit breaks — the statements and their order are the pre-80 ones; the
  // float association is part of the contract (Issue #79).
  let netWorkedMin = 0;
  let explicitBreakMin = 0;
  for (const row of rows) {
    const d = entryDurations(row);
    explicitBreakMin += d.breakMinutes;
    netWorkedMin += d.workingMinutes;
  }

  // Gaps between consecutive entries.
  let gapBreakMin = 0;
  let dayBreakMin = 0;
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    const next = rows[i];
    const gap = (next.startTime.getTime() - previous.endTime.getTime()) / 60000;
    if (!(gap > 0)) continue;
    if (previous.salonId === next.salonId && gap <= 120) {
      // Same salon, up to two hours: counts as a break exactly as before Phase 80 (D-01).
      // A recorded day break inside such a gap adds nothing (no double counting).
      gapBreakMin += gap;
    } else {
      // Travel between salons, or a same-salon gap above two hours (a separate shift): only a
      // recorded day break counts, clipped to the gap and merged where they overlap (D-04/D-05).
      dayBreakMin += unionClippedMinutes(dayBreaks, previous.endTime, next.startTime);
    }
  }

  const totalBreakMin = explicitBreakMin + gapBreakMin + dayBreakMin;

  const requiredBreakMin: 0 | 30 | 45 = netWorkedMin > 9 * 60 ? 45 : netWorkedMin > 6 * 60 ? 30 : 0;
  const breakShortfall = requiredBreakMin > 0 && totalBreakMin < requiredBreakMin;

  const salonIds = [...new Set(rows.map((r) => r.salonId))].sort();
  const crossSalon = salonIds.length >= 2;
  const snapshot: DaySnapshot = {
    entryIds: rows.map((r) => r.id).sort(),
    salonIds,
    netWorkedMin,
    totalBreakMin,
  };

  const acknowledged = crossSalon && acks.some((a) => isAckSnapshotCurrent(a.snapshot, snapshot));
  // D-16: an entry-level WAIVED never waives a cross-salon day.
  const waived = crossSalon ? acknowledged : rows.some((r) => r.breakStatus === "WAIVED");

  return {
    netWorkedMin,
    explicitBreakMin,
    gapBreakMin,
    dayBreakMin,
    totalBreakMin,
    salonIds,
    crossSalon,
    requiredBreakMin,
    breakShortfall,
    acknowledged,
    waived,
    snapshot,
  };
}

/**
 * True when the half-open intervals [a.start, a.end) and [b.start, b.end) share any time.
 * Adjacent intervals (one ends exactly where the other starts) do not overlap.
 */
export function intervalsOverlap(a: DayBreakInterval, b: DayBreakInterval): boolean {
  return a.startTime.getTime() < b.endTime.getTime() && b.startTime.getTime() < a.endTime.getTime();
}

/**
 * Write-side validation of a day break (D-05): finds the gap between two consecutive entries
 * (`rows` in start order) that fully contains `interval`. Returns the two neighbouring entry ids
 * and whether the gap crosses a salon boundary, or null when the interval is empty or reversed,
 * touches an entry, spans across one, lies before the first or after the last entry, or lies in a
 * gap that is not positive.
 *
 * Used by `POST /api/v1/day-breaks`; the evaluation itself stays robust at read time by clipping
 * every day break to its gap.
 */
export function findGapForInterval(
  rows: readonly DayBreakRow[],
  interval: DayBreakInterval,
): { previousEntryId: string; nextEntryId: string; crossSalon: boolean } | null {
  const start = interval.startTime.getTime();
  const end = interval.endTime.getTime();
  if (!(start < end)) return null;
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    const next = rows[i];
    const gapStart = previous.endTime.getTime();
    const gapEnd = next.startTime.getTime();
    if (!(gapEnd > gapStart)) continue;
    if (gapStart <= start && end <= gapEnd) {
      return {
        previousEntryId: previous.id,
        nextEntryId: next.id,
        crossSalon: previous.salonId !== next.salonId,
      };
    }
  }
  return null;
}
