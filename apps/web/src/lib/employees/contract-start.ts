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
