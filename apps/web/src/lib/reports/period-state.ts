/**
 * Issue #612, D-612-1 — the ONE place the /reports URL state is parsed and written.
 *
 * Pure: no SvelteKit app-module import and no clock read — the page passes `today` (the
 * tenant-local current month). The URL contract
 *
 *   /reports?from=YYYY-MM&to=YYYY-MM&tab=zeiten|urlaub|heute[&salonId=<uuid>][&person=<uuid>]
 *
 * is what #591's chart clicks open, so key names and the stable key order are API.
 *
 * Planner decisions that live here:
 * - P-10: a period is whole months, at most {@link MAX_PERIOD_MONTHS}, never after the current month.
 * - P-16: a month picked in the future is clamped to the current month, never refused.
 * - P-20: the period kind is detected with the precedence month > quarter > year > range, so
 *   2026-01..2026-03 is a quarter and a single month is never a "quarter".
 *
 * Month names below are calendar names, not leave-type names; they are never a control value.
 */

import type { YearMonth } from "./period-report";

/** At most this many whole months in one period (P-10). */
export const MAX_PERIOD_MONTHS = 12;

export type PeriodTab = "zeiten" | "urlaub" | "heute";

export interface PeriodState {
  from: YearMonth;
  to: YearMonth;
  /** The active tab; `null` only when the caller may see no tab at all. */
  tab: PeriodTab | null;
  /** Employee id of the open drill-down, or `null`. */
  person: string | null;
  /** Salon id carried in the URL, or `null` (the header salon context decides otherwise). */
  salonId: string | null;
}

export type PeriodKind = "month" | "quarter" | "year" | "range";

/** Full month names (index 0 = January). */
export const MONTH_NAMES_DE: readonly string[] = [
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
];

/** Abbreviated month names (index 0 = January). */
export const MONTH_NAMES_SHORT_DE: readonly string[] = [
  "Jan",
  "Feb",
  "Mär",
  "Apr",
  "Mai",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Okt",
  "Nov",
  "Dez",
];

const YEAR_MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABS: readonly PeriodTab[] = ["zeiten", "urlaub", "heute"];

// ── Month arithmetic ─────────────────────────────────────────────────────────

function toIndex(ym: YearMonth): number {
  return ym.year * 12 + (ym.month - 1);
}

function fromIndex(index: number): YearMonth {
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** `ym` moved by `delta` whole months (negative = earlier). */
export function addMonths(ym: YearMonth, delta: number): YearMonth {
  return fromIndex(toIndex(ym) + delta);
}

/** Negative, zero or positive like a comparator: `a` before, equal to or after `b`. */
export function compareMonths(a: YearMonth, b: YearMonth): number {
  return toIndex(a) - toIndex(b);
}

function sameMonth(a: YearMonth, b: YearMonth): boolean {
  return a.year === b.year && a.month === b.month;
}

/** Number of whole months from `from` to `to`, both included. */
export function monthsBetween(from: YearMonth, to: YearMonth): number {
  return toIndex(to) - toIndex(from) + 1;
}

/** `ym` itself, or `today` when `ym` lies after it (P-16). */
export function clampToToday(ym: YearMonth, today: YearMonth): YearMonth {
  return compareMonths(ym, today) > 0 ? { ...today } : ym;
}

function parseYearMonth(value: string | null): YearMonth | null {
  if (value === null) return null;
  const m = YEAR_MONTH_RE.exec(value);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

function formatYearMonth(ym: YearMonth): string {
  return `${String(ym.year).padStart(4, "0")}-${String(ym.month).padStart(2, "0")}`;
}

// ── URL state ────────────────────────────────────────────────────────────────

/** Anything with `get(name)`: `URLSearchParams` and `URL["searchParams"]` both fit. */
export interface SearchParamsLike {
  get(name: string): string | null;
}

/**
 * Parses the page's URL state. Never throws: every untrusted value is validated strictly and
 * falls back (the API re-validates whatever the page sends, T-612-17).
 *
 * @param allowedTabs the tabs the caller may see, in display order (the rights decision stays
 *   in `page-rights.ts`); an unknown or not allowed `tab` becomes the first of them.
 */
export function parsePeriodState(
  params: SearchParamsLike,
  today: YearMonth,
  allowedTabs: readonly PeriodTab[],
): PeriodState {
  const rawFrom = parseYearMonth(params.get("from"));
  const rawTo = parseYearMonth(params.get("to"));

  let from: YearMonth = { ...today };
  let to: YearMonth = { ...today };
  if (rawFrom && rawTo && compareMonths(rawFrom, rawTo) <= 0) {
    to = clampToToday(rawTo, today);
    from = compareMonths(rawFrom, to) > 0 ? { ...to } : rawFrom;
    if (monthsBetween(from, to) > MAX_PERIOD_MONTHS) {
      from = addMonths(to, -(MAX_PERIOD_MONTHS - 1));
    }
  }

  const requestedTab = params.get("tab");
  const tab: PeriodTab | null =
    TABS.find((t) => t === requestedTab && allowedTabs.includes(t)) ?? allowedTabs[0] ?? null;

  const person = params.get("person");
  const salonId = params.get("salonId");

  return {
    from,
    to,
    tab,
    person: person !== null && UUID_RE.test(person) ? person : null,
    salonId: salonId !== null && UUID_RE.test(salonId) ? salonId : null,
  };
}

/**
 * The query string (no leading "?") of a state, in the stable key order
 * from, to, tab, salonId, person. Empty values are left out.
 */
export function periodSearch(state: PeriodState): string {
  const q = new URLSearchParams();
  q.set("from", formatYearMonth(state.from));
  q.set("to", formatYearMonth(state.to));
  if (state.tab) q.set("tab", state.tab);
  if (state.salonId) q.set("salonId", state.salonId);
  if (state.person) q.set("person", state.person);
  return q.toString();
}

// ── Period kinds, labels, arrows ─────────────────────────────────────────────

function isQuarterStart(ym: YearMonth): boolean {
  return (ym.month - 1) % 3 === 0;
}

/**
 * Detects what kind of period `from..to` is (P-20 precedence: month > quarter > year > range).
 * A quarter ends on its last month or — the running quarter — on the current month; a year
 * ends in December or — the running year — on the current month.
 */
export function periodKind(from: YearMonth, to: YearMonth, today: YearMonth): PeriodKind {
  if (sameMonth(from, to)) return "month";
  const sameYear = from.year === to.year;
  const toIsToday = sameMonth(to, today);
  const withinQuarter = to.month > from.month && to.month <= from.month + 2;
  if (
    sameYear &&
    isQuarterStart(from) &&
    withinQuarter &&
    (to.month === from.month + 2 || toIsToday)
  ) {
    return "quarter";
  }
  if (sameYear && from.month === 1 && (to.month === 12 || toIsToday)) return "year";
  return "range";
}

/** The bar's label: „Oktober 2026“, „Jul – Sep 2026“, „Nov 2025 – Jan 2026“. */
export function periodLabel(from: YearMonth, to: YearMonth, today: YearMonth): string {
  if (periodKind(from, to, today) === "month") {
    return `${MONTH_NAMES_DE[from.month - 1]} ${from.year}`;
  }
  const a = MONTH_NAMES_SHORT_DE[from.month - 1];
  const b = MONTH_NAMES_SHORT_DE[to.month - 1];
  if (from.year === to.year) return `${a} – ${b} ${to.year}`;
  return `${a} ${from.year} – ${b} ${to.year}`;
}

/** The bar's eyebrow above the label. */
export function periodEyebrow(from: YearMonth, to: YearMonth, today: YearMonth): string {
  switch (periodKind(from, to, today)) {
    case "month":
      return "Monat";
    case "quarter":
      return "Quartal";
    case "year":
      return "Jahr";
    default:
      return `Zeitraum · ${monthsBetween(from, to)} Monate`;
  }
}

/** Accessible names of the two arrows for a period kind. */
export function arrowLabels(kind: PeriodKind): { prev: string; next: string } {
  switch (kind) {
    case "month":
      return { prev: "Vorheriger Monat", next: "Nächster Monat" };
    case "quarter":
      return { prev: "Vorheriges Quartal", next: "Nächstes Quartal" };
    case "year":
      return { prev: "Vorheriges Jahr", next: "Nächstes Jahr" };
    default:
      return { prev: "Vorheriger Zeitraum", next: "Nächster Zeitraum" };
  }
}

/**
 * One arrow step by the period's kind: a month by one, a quarter by one quarter, a year by one
 * year (the running quarter/year is clamped to the current month), a range by its own length.
 * `null` when the step would start or end after the current month.
 */
export function stepPeriod(
  from: YearMonth,
  to: YearMonth,
  dir: 1 | -1,
  today: YearMonth,
): { from: YearMonth; to: YearMonth } | null {
  const kind = periodKind(from, to, today);
  let next: { from: YearMonth; to: YearMonth };

  if (kind === "month") {
    next = { from: addMonths(from, dir), to: addMonths(to, dir) };
  } else if (kind === "quarter") {
    const start = addMonths(from, 3 * dir);
    next = { from: start, to: addMonths(start, 2) };
  } else if (kind === "year") {
    const start = { year: from.year + dir, month: 1 };
    next = { from: start, to: { year: start.year, month: 12 } };
  } else {
    const length = monthsBetween(from, to);
    next = { from: addMonths(from, length * dir), to: addMonths(to, length * dir) };
    if (compareMonths(next.to, today) > 0) return null;
    return next;
  }

  if (compareMonths(next.from, today) > 0) return null;
  return { from: next.from, to: clampToToday(next.to, today) };
}

/** Whether the next arrow may be used. */
export function canStepNext(from: YearMonth, to: YearMonth, today: YearMonth): boolean {
  return stepPeriod(from, to, 1, today) !== null;
}

// ── Presets ──────────────────────────────────────────────────────────────────

export type PresetKey = "this-month" | "previous-month" | "quarter" | "year" | "last-3-months";

export interface PeriodPreset {
  key: PresetKey;
  label: string;
  from: YearMonth;
  to: YearMonth;
}

/** The five presets in display order, resolved against `today`. */
export function presetPeriods(today: YearMonth): PeriodPreset[] {
  const quarterStart = { year: today.year, month: today.month - ((today.month - 1) % 3) };
  const previous = addMonths(today, -1);
  return [
    { key: "this-month", label: "Dieser Monat", from: { ...today }, to: { ...today } },
    { key: "previous-month", label: "Vormonat", from: previous, to: { ...previous } },
    { key: "quarter", label: "Quartal", from: quarterStart, to: { ...today } },
    { key: "year", label: "Jahr", from: { year: today.year, month: 1 }, to: { ...today } },
    {
      key: "last-3-months",
      label: "Letzte 3 Monate",
      from: addMonths(today, -2),
      to: { ...today },
    },
  ];
}

/** Every preset equal to `from..to` — several can match at once (P-20). */
export function activePresets(from: YearMonth, to: YearMonth, today: YearMonth): PresetKey[] {
  return presetPeriods(today)
    .filter((p) => sameMonth(p.from, from) && sameMonth(p.to, to))
    .map((p) => p.key);
}

// ── Range validation ─────────────────────────────────────────────────────────

export type RangeError = "TO_BEFORE_FROM" | "TOO_LONG" | "FUTURE";

/** The copy-deck texts of the range dialog. */
export const RANGE_ERROR_TEXT: Record<RangeError, string> = {
  TO_BEFORE_FROM: "„Bis“ liegt vor „Von“.",
  TOO_LONG: "Höchstens 12 Monate auf einmal.",
  FUTURE: "„Bis“ darf nicht in der Zukunft liegen.",
};

/**
 * Validates a range chosen in the dialog. "Bis" before "Von" is reported first, then a "Bis"
 * after the current month, then more than {@link MAX_PERIOD_MONTHS} months.
 */
export function validateRange(from: YearMonth, to: YearMonth, today: YearMonth): RangeError | null {
  if (compareMonths(to, from) < 0) return "TO_BEFORE_FROM";
  if (compareMonths(to, today) > 0) return "FUTURE";
  if (monthsBetween(from, to) > MAX_PERIOD_MONTHS) return "TOO_LONG";
  return null;
}

// ── Click helper ─────────────────────────────────────────────────────────────

/**
 * True for a plain primary-button click — the only click a link handler may turn into an
 * in-page navigation; a modified or middle click keeps the browser's new-tab behaviour.
 */
export function isPlainLeftClick(e: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
