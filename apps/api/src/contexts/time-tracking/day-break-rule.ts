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
 *   - D-22  besides the minute sums the evaluation exposes the SAME day as time intervals: every
 *           break with the source it comes from (`breakSegments`), every gap between consecutive
 *           entries (`gaps`) and the continuous working stretches between the placed breaks
 *           (`workBlocks`). The view exists for § 4 ArbZG Satz 2 (break segments of at least 15
 *           minutes) and Satz 3 (no more than six hours in a row without a break), which are #511 —
 *           Phase 80 evaluates neither and builds every warning from the minute sums alone, so the
 *           interval view can never move a result. A segment with `source` "unplaced-entry-break"
 *           means "position unknown": stored `breakMinutes` that no Break row covers. It must never
 *           be read as proof of a break at a particular time, and it never splits a work block.
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
  /**
   * The entry's own Break rows, when the caller has loaded them (D-22). Absent or null means the
   * positions are unknown, which is the case for every caller of Phase 80 (the day lookup does not
   * load Break rows); #511 decides the loading. Never read by the minute sums.
   */
  breaks?: readonly DayBreakInterval[] | null;
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

/** Where a break segment of the day comes from (D-22). */
export type DayBreakSegmentSource =
  "entry-break" | "day-break" | "same-salon-gap" | "unplaced-entry-break";

/**
 * One break of the day as an interval with its source (D-22).
 *
 *   - "entry-break"          a Break row of an entry, clipped to that entry (`entryId` set)
 *   - "day-break"            a recorded day break clipped to a gap that does not count by itself
 *   - "same-salon-gap"       a same-salon gap of at most 120 minutes (D-01)
 *   - "unplaced-entry-break" stored `breakMinutes` of an entry that no Break row covers
 *
 * `startTime` and `endTime` are null for "unplaced-entry-break" and only then. `entryId` is null
 * for the two gap-based sources.
 */
export interface DayBreakSegment {
  source: DayBreakSegmentSource;
  entryId: string | null;
  startTime: Date | null;
  endTime: Date | null;
  /** Exact minutes of the segment. */
  minutes: number;
}

/** A positive gap between two consecutive entries of the day (D-22). */
export interface DayGap {
  previousEntryId: string;
  nextEntryId: string;
  startTime: Date;
  endTime: Date;
  /** Exact minutes of the gap. */
  minutes: number;
  /** True when the two entries were worked in different salons (travel, D-01). */
  crossSalon: boolean;
  /** True when the gap counts as a break by itself: same salon and at most 120 minutes (D-01). */
  countsAsBreak: boolean;
}

/**
 * A maximal continuous working stretch of the day between two placed breaks (D-22).
 *
 * A gap between different salons is travel and belongs to the block (D-01); only a recorded day
 * break inside it interrupts the block. `minutes` is the wall-clock length of the block, exact.
 * `positionUnknownBreakMinutes` is the sum of the "unplaced-entry-break" minutes of the entries
 * the block touches: an entry's unplaced minutes can lie in any of its blocks, so EACH of its
 * blocks carries them in full, and they never split a block.
 */
export interface DayWorkBlock {
  startTime: Date;
  endTime: Date;
  minutes: number;
  /** Ids of the entries that have working time inside the block, in entry order. */
  entryIds: string[];
  positionUnknownBreakMinutes: number;
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
  /**
   * Every break of the day as an interval with its source (D-22): placed segments ordered by start
   * time, then the unplaced ones in entry order. Descriptive only — no minute sum is derived from it.
   */
  breakSegments: DayBreakSegment[];
  /** Every positive gap between consecutive entries, in entry order (D-22). */
  gaps: DayGap[];
  /** The continuous working stretches between the placed breaks, in time order (D-22). */
  workBlocks: DayWorkBlock[];
}

/** A half-open span [start, end) in epoch milliseconds. */
type Span = readonly [number, number];

/** The union of `breaks` clipped to [from, to], as sorted, non-touching spans. */
/**
 * Ordinal (UTF-16 code unit) comparison for ids in the ack snapshot. Deliberately NOT
 * localeCompare: the snapshot must sort identically on every runtime and locale, otherwise a
 * current acknowledgement would read as stale (D-17). Same order as the default sort.
 */
function compareOrdinal(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function unionClippedSpans(breaks: readonly DayBreakInterval[], from: Date, to: Date): Span[] {
  const lo = from.getTime();
  const hi = to.getTime();
  const clipped: Array<[number, number]> = [];
  for (const b of breaks) {
    const s = Math.max(b.startTime.getTime(), lo);
    const e = Math.min(b.endTime.getTime(), hi);
    if (e > s) clipped.push([s, e]);
  }
  clipped.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of clipped) {
    const last = merged[merged.length - 1];
    if (last === undefined || s > last[1]) {
      merged.push([s, e]);
    } else if (e > last[1]) {
      last[1] = e;
    }
  }
  return merged;
}

/** Sum, in minutes, of the union of `breaks` clipped to [from, to]. */
function unionClippedMinutes(breaks: readonly DayBreakInterval[], from: Date, to: Date): number {
  let totalMs = 0;
  for (const [s, e] of unionClippedSpans(breaks, from, to)) totalMs += e - s;
  return totalMs / 60000;
}

/** A positive gap between two consecutive rows, with the D-01 classification. */
interface GapSpan {
  previous: DayBreakRow;
  next: DayBreakRow;
  startTime: Date;
  endTime: Date;
  minutes: number;
  crossSalon: boolean;
  countsAsBreak: boolean;
}

/**
 * The ONE place that decides what a gap is: every positive gap between consecutive rows (start
 * order), classified by D-01 — a gap between different salons is travel, a same-salon gap of at
 * most 120 minutes counts as a break. Overlapping and adjacent rows yield no gap. Used by the
 * evaluation (sums and interval view) and by the write-side `findGapForInterval`.
 */
function listGaps(rows: readonly DayBreakRow[]): GapSpan[] {
  const gaps: GapSpan[] = [];
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    const next = rows[i];
    const minutes = (next.startTime.getTime() - previous.endTime.getTime()) / 60000;
    if (!(minutes > 0)) continue;
    const crossSalon = previous.salonId !== next.salonId;
    gaps.push({
      previous,
      next,
      startTime: previous.endTime,
      endTime: next.startTime,
      minutes,
      crossSalon,
      countsAsBreak: !crossSalon && minutes <= 120,
    });
  }
  return gaps;
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
  const gapSpans = listGaps(rows);
  let gapBreakMin = 0;
  let dayBreakMin = 0;
  for (const g of gapSpans) {
    if (g.countsAsBreak) {
      // Same salon, up to two hours: counts as a break exactly as before Phase 80 (D-01).
      // A recorded day break inside such a gap adds nothing (no double counting).
      gapBreakMin += g.minutes;
    } else {
      // Travel between salons, or a same-salon gap above two hours (a separate shift): only a
      // recorded day break counts, clipped to the gap and merged where they overlap (D-04/D-05).
      dayBreakMin += unionClippedMinutes(dayBreaks, g.startTime, g.endTime);
    }
  }

  const totalBreakMin = explicitBreakMin + gapBreakMin + dayBreakMin;

  const requiredBreakMin: 0 | 30 | 45 = netWorkedMin > 9 * 60 ? 45 : netWorkedMin > 6 * 60 ? 30 : 0;
  const breakShortfall = requiredBreakMin > 0 && totalBreakMin < requiredBreakMin;

  const salonIds = [...new Set(rows.map((r) => r.salonId))].sort(compareOrdinal);
  const crossSalon = salonIds.length >= 2;
  const snapshot: DaySnapshot = {
    entryIds: rows.map((r) => r.id).sort(compareOrdinal),
    salonIds,
    netWorkedMin,
    totalBreakMin,
  };

  const acknowledged = crossSalon && acks.some((a) => isAckSnapshotCurrent(a.snapshot, snapshot));
  // D-16: an entry-level WAIVED never waives a cross-salon day.
  const waived = crossSalon ? acknowledged : rows.some((r) => r.breakStatus === "WAIVED");

  // D-22 interval view — built after the sums and read by nothing above this line.
  const placedSegments: DayBreakSegment[] = [];
  const unplacedSegments: DayBreakSegment[] = [];
  const rowPlacedSpans: Span[][] = [];
  const rowUnplacedMin: number[] = [];
  for (const row of rows) {
    const placedSpans = row.breaks?.length
      ? unionClippedSpans(row.breaks, row.startTime, row.endTime)
      : [];
    rowPlacedSpans.push(placedSpans);
    let placedMs = 0;
    for (const [s, e] of placedSpans) {
      placedMs += e - s;
      placedSegments.push({
        source: "entry-break",
        entryId: row.id,
        startTime: new Date(s),
        endTime: new Date(e),
        minutes: (e - s) / 60000,
      });
    }
    // Stored break minutes that no Break row covers: position unknown, never placed (D-22).
    const unplacedMin = (entryDurations(row).breakMinutes * 60000 - placedMs) / 60000;
    rowUnplacedMin.push(unplacedMin > 0 ? unplacedMin : 0);
    if (unplacedMin > 0) {
      unplacedSegments.push({
        source: "unplaced-entry-break",
        entryId: row.id,
        startTime: null,
        endTime: null,
        minutes: unplacedMin,
      });
    }
  }
  for (const g of gapSpans) {
    if (g.countsAsBreak) {
      placedSegments.push({
        source: "same-salon-gap",
        entryId: null,
        startTime: g.startTime,
        endTime: g.endTime,
        minutes: g.minutes,
      });
    } else {
      for (const [s, e] of unionClippedSpans(dayBreaks, g.startTime, g.endTime)) {
        placedSegments.push({
          source: "day-break",
          entryId: null,
          startTime: new Date(s),
          endTime: new Date(e),
          minutes: (e - s) / 60000,
        });
      }
    }
  }
  placedSegments.sort((a, b) => (a.startTime as Date).getTime() - (b.startTime as Date).getTime());
  const breakSegments = [...placedSegments, ...unplacedSegments];

  // Work blocks: the working pieces of every entry (its span minus its placed breaks) plus the
  // travel between salons (a cross-salon gap minus the day breaks inside it), merged where they
  // touch. A counting same-salon gap and a same-salon gap above two hours contribute nothing, so
  // they end the block (D-01). Unplaced minutes have no position and split nothing.
  const pieces: Array<{ span: Span; rowIndex: number | null }> = [];
  rows.forEach((row, i) => {
    let cursor = row.startTime.getTime();
    const end = row.endTime.getTime();
    for (const [s, e] of rowPlacedSpans[i]) {
      if (s > cursor) pieces.push({ span: [cursor, s], rowIndex: i });
      cursor = Math.max(cursor, e);
    }
    if (end > cursor) pieces.push({ span: [cursor, end], rowIndex: i });
  });
  for (const g of gapSpans) {
    if (!g.crossSalon) continue;
    let cursor = g.startTime.getTime();
    const end = g.endTime.getTime();
    for (const [s, e] of unionClippedSpans(dayBreaks, g.startTime, g.endTime)) {
      if (s > cursor) pieces.push({ span: [cursor, s], rowIndex: null });
      cursor = Math.max(cursor, e);
    }
    if (end > cursor) pieces.push({ span: [cursor, end], rowIndex: null });
  }
  pieces.sort((a, b) => a.span[0] - b.span[0]);
  const workBlocks: DayWorkBlock[] = [];
  let open: { start: number; end: number; rowIndexes: Set<number> } | null = null;
  const closeBlock = (): void => {
    if (open === null) return;
    const indexes = [...open.rowIndexes].sort((a, b) => a - b);
    workBlocks.push({
      startTime: new Date(open.start),
      endTime: new Date(open.end),
      minutes: (open.end - open.start) / 60000,
      entryIds: indexes.map((i) => rows[i].id),
      positionUnknownBreakMinutes: indexes.reduce((sum, i) => sum + rowUnplacedMin[i], 0),
    });
    open = null;
  };
  for (const { span, rowIndex } of pieces) {
    if (open !== null && span[0] <= open.end) {
      if (span[1] > open.end) open.end = span[1];
    } else {
      closeBlock();
      open = { start: span[0], end: span[1], rowIndexes: new Set() };
    }
    if (rowIndex !== null) open.rowIndexes.add(rowIndex);
  }
  closeBlock();

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
    breakSegments,
    workBlocks,
    gaps: gapSpans.map((g) => ({
      previousEntryId: g.previous.id,
      nextEntryId: g.next.id,
      startTime: g.startTime,
      endTime: g.endTime,
      minutes: g.minutes,
      crossSalon: g.crossSalon,
      countsAsBreak: g.countsAsBreak,
    })),
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
  for (const g of listGaps(rows)) {
    if (g.startTime.getTime() <= start && end <= g.endTime.getTime()) {
      return {
        previousEntryId: g.previous.id,
        nextEntryId: g.next.id,
        crossSalon: g.crossSalon,
      };
    }
  }
  return null;
}
