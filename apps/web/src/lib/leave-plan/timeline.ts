// Issue #835 (D-835-21) — the planner timeline's date ↔ column math, pure. Days are
// `YYYY-MM-DD` strings and every calculation is UTC arithmetic on whole days, so a DST change or
// the viewer's time zone can never shift a bar by a day. Move and resize clamp to the plan year
// and never produce start > end. The server stays authoritative; this only shapes the preview.
import type { DayRange } from "./types";

const DAY_MS = 86_400_000;

const MONTH_LABELS = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
] as const;

export type TimelineView = "year" | number;

export interface MonthSegment {
  month: number;
  label: string;
  startIndex: number;
  length: number;
}

export interface ColumnSpan {
  /** 1-based grid column of the first visible day inside the view. */
  startColumn: number;
  /** Number of visible days inside the view. */
  span: number;
  /** The range begins before the view (the bar is cut on its left). */
  clippedStart: boolean;
  /** The range ends after the view (the bar is cut on its right). */
  clippedEnd: boolean;
}

function utcMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}

/** Zero-based day of the year; not clamped (a day outside the year is negative or too large). */
export function dayIndex(year: number, day: string): number {
  return Math.round((utcMs(day) - Date.UTC(year, 0, 1)) / DAY_MS);
}

export function dayFromIndex(year: number, index: number): string {
  return new Date(Date.UTC(year, 0, 1 + index)).toISOString().slice(0, 10);
}

export function monthSegments(year: number): MonthSegment[] {
  const segments: MonthSegment[] = [];
  let startIndex = 0;
  for (let month = 0; month < 12; month++) {
    const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    segments.push({ month, label: MONTH_LABELS[month], startIndex, length });
    startIndex += length;
  }
  return segments;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

function indexesOf(range: DayRange, year: number): { start: number; end: number } {
  const last = daysInYear(year) - 1;
  const start = clamp(dayIndex(year, range.startDate), 0, last);
  const end = clamp(dayIndex(year, range.endDate), 0, last);
  return { start, end: Math.max(start, end) };
}

function rangeOf(year: number, start: number, end: number): DayRange {
  return { startDate: dayFromIndex(year, start), endDate: dayFromIndex(year, end) };
}

/** Both bounds forced inside the year; a range lying wholly outside collapses to one edge day. */
export function clampRangeToYear(range: DayRange, year: number): DayRange {
  const { start, end } = indexesOf(range, year);
  return rangeOf(year, start, end);
}

/** Shifts the range by whole days, keeping its length; the whole range is kept inside the year. */
export function moveRange(range: DayRange, deltaDays: number, year: number): DayRange {
  const { start, end } = indexesOf(range, year);
  const length = end - start;
  const last = daysInYear(year) - 1;
  const newStart = clamp(start + Math.trunc(deltaDays), 0, last - length);
  return rangeOf(year, newStart, newStart + length);
}

/** Moves one edge; never start > end (a one-day minimum) and never outside the year. */
export function resizeRange(
  range: DayRange,
  edge: "start" | "end",
  deltaDays: number,
  year: number,
): DayRange {
  const { start, end } = indexesOf(range, year);
  const delta = Math.trunc(deltaDays);
  const last = daysInYear(year) - 1;
  if (edge === "start") return rangeOf(year, clamp(start + delta, 0, end), end);
  return rangeOf(year, start, clamp(end + delta, start, last));
}

/** A pointer movement in pixels as whole columns (rounded to the nearest column). */
export function pointerDeltaToDays(dx: number, columnWidthPx: number): number {
  if (!(columnWidthPx > 0)) return 0;
  return Math.round(dx / columnWidthPx) || 0;
}

/** First day index and length of what the view shows: the whole year or one month. */
export function viewWindow(
  year: number,
  view: TimelineView,
): { startIndex: number; length: number } {
  if (view === "year") return { startIndex: 0, length: daysInYear(year) };
  const segment = monthSegments(year)[clamp(view, 0, 11)];
  return { startIndex: segment.startIndex, length: segment.length };
}

/** The grid columns a range takes inside the view, or null when it lies outside the view. */
export function rangeToColumns(
  range: DayRange,
  year: number,
  view: TimelineView,
): ColumnSpan | null {
  const window = viewWindow(year, view);
  const viewEnd = window.startIndex + window.length - 1;
  const start = dayIndex(year, range.startDate);
  const end = dayIndex(year, range.endDate);
  if (end < window.startIndex || start > viewEnd) return null;
  const visibleStart = Math.max(start, window.startIndex);
  const visibleEnd = Math.min(end, viewEnd);
  return {
    startColumn: visibleStart - window.startIndex + 1,
    span: visibleEnd - visibleStart + 1,
    clippedStart: start < window.startIndex,
    clippedEnd: end > viewEnd,
  };
}

/**
 * Greedy lane packing for overlapping bars of one row: returns, per item (same order), the lane
 * index (0-based) so that no two items of one lane overlap. Day indexes are inclusive.
 */
export function assignLanes(items: ReadonlyArray<{ start: number; end: number }>): number[] {
  const order = items
    .map((item, i) => ({ ...item, i }))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.i - b.i);
  const laneEnds: number[] = [];
  const lanes = new Array<number>(items.length).fill(0);
  for (const item of order) {
    let lane = laneEnds.findIndex((end) => end < item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    lanes[item.i] = lane;
  }
  return lanes;
}
