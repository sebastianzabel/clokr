// Issue #587 (D-587-4) — links from the team week and the attendance list into EXISTING flows.
//
// The receivers (`/team/time-entries`, `/team/leave`) validate every parameter themselves with
// `normalizeEmployeeIdParam` / `normalizeDateParam` and enforce their own permissions; these
// helpers only build relative URLs from ids the API already sent. A value that would not pass the
// receiver's validation yields `null`, so a caller leaves the element unlinked instead of
// rendering a link the target would ignore. No caller-supplied path segment ever enters a URL.
import { normalizeDateParam, normalizeEmployeeIdParam } from "$lib/breaks/deep-link";

/** Short German weekday names, indexed by the UTC weekday (0 = Sunday). */
const WEEKDAY_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"] as const;

/**
 * `/team/time-entries?employeeId=<id>` or `null` when the id is unusable (Issue #588, P-11): the
 * person link of the dashboard card "Salden". The receiver selects the person and shows their month;
 * the caller decides with `mayOpenTeamPage` whether the link may exist at all.
 */
export function teamPersonHref(employeeId: string): string | null {
  const id = normalizeEmployeeIdParam(employeeId);
  if (id === null) return null;
  const params = new URLSearchParams({ employeeId: id });
  return `/team/time-entries?${params.toString()}`;
}

/** `/team/time-entries?employeeId=<id>&date=<day>` or `null` when id or day is unusable. */
export function teamDayHref(employeeId: string, day: string): string | null {
  const id = normalizeEmployeeIdParam(employeeId);
  const date = normalizeDateParam(day);
  if (id === null || date === null || date !== day) return null;
  const params = new URLSearchParams({ employeeId: id, date });
  return `/team/time-entries?${params.toString()}`;
}

/** `/team/leave?create=1&employeeId=<id>&date=<day>` or `null` when id or day is unusable. */
export function teamLeaveCreateHref(employeeId: string, day: string): string | null {
  const id = normalizeEmployeeIdParam(employeeId);
  const date = normalizeDateParam(day);
  if (id === null || date === null || date !== day) return null;
  const params = new URLSearchParams({ create: "1", employeeId: id, date });
  return `/team/leave?${params.toString()}`;
}

/**
 * The accessible name of a team-week cell: „<name>, <Wochentag> <TT.MM.>: <status>“.
 * The weekday is read from the calendar day string at noon UTC, never from a local `getDay()`.
 */
export function teamCellAriaLabel(name: string, day: string, statusText: string): string {
  const weekday = WEEKDAY_SHORT[new Date(`${day}T12:00:00Z`).getUTCDay()];
  const dd = day.slice(8, 10);
  const mm = day.slice(5, 7);
  return `${name}, ${weekday} ${dd}.${mm}.: ${statusText}`;
}
