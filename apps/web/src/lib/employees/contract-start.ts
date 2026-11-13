// Issue #854 (D-854-07, AC-5) - the start day of a contract CHANGE. A change always takes effect on
// the first day of a month (`MONTH_FIRST_ERROR`, CLAUDE.md "Schedule Types"); the API stays the
// authority, these helpers only offer a valid default and name an invalid pick before the request.
// Pure calendar-string arithmetic on ISO days (`YYYY-MM-DD`): no `Date`, so no time zone can move
// a day. The caller passes the tenant-local (or, failing that, browser-local) calendar day.

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for an ISO day that is the first of its month. Anything else (also malformed input) is false. */
export function isMonthFirst(iso: string | null | undefined): boolean {
  const m = ISO_DAY.exec(iso ?? "");
  return m !== null && m[3] === "01";
}

/**
 * The first day of the month AFTER the month of `todayIso`; on the 1st that is still the next month's
 * first (a contract change is never effective on the day it is entered, a working-time change must be
 * communicated before it takes effect). A malformed input returns null.
 */
export function nextMonthFirst(todayIso: string): string | null {
  const m = ISO_DAY.exec(todayIso);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`;
}

const MONTH_NAMES = [
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

export interface MonthFirstOption {
  /** ISO day of the first of the month (`YYYY-MM-01`), the value the PUT sends. */
  value: string;
  /** „Dezember 2026“. */
  label: string;
}

/** „Dezember 2026“ for a month-first ISO day; null for anything else. */
export function monthFirstLabel(iso: string | null | undefined): string | null {
  const m = ISO_DAY.exec(iso ?? "");
  if (!m || m[3] !== "01") return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${MONTH_NAMES[month - 1]} ${Number(m[1])}`;
}

function shiftMonth(year: number, month: number, by: number): [number, number] {
  const index = year * 12 + (month - 1) + by;
  return [Math.floor(index / 12), (index % 12) + 1];
}

function firstOf(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

/**
 * The months a contract change may be chosen for, oldest first, as month-firsts only (the „Gültig ab“
 * choice of the Vertrag tab; the API stays the authority, a refusal such as a closed month comes back
 * as its text). The range runs from the first month-first on or after `earliest` (the hire day; without
 * one `monthsBack` months before today's month) to `monthsAhead` months after today's month. A
 * `include` day that is a month-first outside the range is added, so the current value is always
 * offered. Pure calendar-string arithmetic, no `Date`.
 */
export function monthFirstOptions(input: {
  today: string;
  earliest?: string | null;
  include?: string | null;
  monthsBack?: number;
  monthsAhead?: number;
}): MonthFirstOption[] {
  const t = ISO_DAY.exec(input.today);
  if (!t) return [];
  const ty = Number(t[1]);
  const tm = Number(t[2]);
  const back = input.monthsBack ?? 24;
  const ahead = input.monthsAhead ?? 24;

  let [fromY, fromM] = shiftMonth(ty, tm, -back);
  const e = ISO_DAY.exec(String(input.earliest ?? "").slice(0, 10));
  if (e) {
    // A hire on the 1st starts in that month, any later day on the next month's first.
    [fromY, fromM] =
      e[3] === "01" ? [Number(e[1]), Number(e[2])] : shiftMonth(Number(e[1]), Number(e[2]), 1);
  }
  const [toY, toM] = shiftMonth(ty, tm, ahead);

  const values: string[] = [];
  for (let [y, m] = [fromY, fromM]; y * 12 + m <= toY * 12 + toM; [y, m] = shiftMonth(y, m, 1)) {
    values.push(firstOf(y, m));
  }
  if (input.include && isMonthFirst(input.include) && !values.includes(input.include)) {
    values.push(input.include);
    values.sort();
  }
  return values.map((value) => ({ value, label: monthFirstLabel(value) ?? value }));
}
