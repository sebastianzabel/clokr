/**
 * Issue #846 — the pure derivations of the start page „Heute im Salon“ (Team › Heute im Salon).
 *
 * Every status is the server's decision (`resolveDayStatus`, #587) as `GET /dashboard/today-attendance`
 * and `GET /dashboard/team-week` answer it, inside the caller's reach and salon filter (#82/#84/#85).
 * This module only COUNTS those statuses and words them; it never derives a status, an hour or a Soll.
 *
 * - `attendanceBand()`     — the counts of the Kennzahlen-Band (Anwesend x von y, Erwartet, Abwesend).
 * - `ATTENDANCE_FILTERS`   — the list filter a Kennzahl links to (D-01: every figure opens its list).
 * - `openTeamLeaveTasks()` — the open leave requests this person may decide (never the own one: the
 *   four-eyes rule of the review route, mirrored so no impossible decision is offered).
 * - `TEAM_WEEK_PAGE_SIZE`  — D-02: the team week pages only from 25 persons on.
 */
import type { TodayAttendanceData, TodayEmployee } from "$lib/reports/today-attendance";
import type { LeaveReviewRequest } from "$lib/leave/leave-review";
import { LEAVE_TYPE_OPTIONS } from "$lib/leave/team-calendar-visibility";

export const TEAM_WEEK_PAGE_SIZE = 25;

/** Statuses that mean the person is expected in the salon today. */
const EXPECTED_TODAY: ReadonlySet<TodayEmployee["status"]> = new Set([
  "clocked_in",
  "present",
  "missing",
  "scheduled",
]);

export interface AttendanceBand {
  /** Clocked in right now. */
  present: number;
  /** Persons expected today (clocked in, worked already, missing or still to come). */
  expected: number;
  /** Persons whose shift started and who have not clocked in („Fehlt“). */
  missing: number;
  /** Persons still to come today („Geplant“). */
  scheduled: number;
  /** Absent today (leave, sickness, Berufsschule …). */
  absent: number;
  /** Already worked today and clocked out. */
  done: number;
}

export function attendanceBand(data: TodayAttendanceData | null): AttendanceBand {
  const band: AttendanceBand = {
    present: 0,
    expected: 0,
    missing: 0,
    scheduled: 0,
    absent: 0,
    done: 0,
  };
  for (const e of data?.employees ?? []) {
    if (EXPECTED_TODAY.has(e.status)) band.expected++;
    if (e.status === "clocked_in") band.present++;
    else if (e.status === "missing") band.missing++;
    else if (e.status === "scheduled") band.scheduled++;
    else if (e.status === "present") band.done++;
    else if (e.status === "absent") band.absent++;
  }
  return band;
}

/** The filters of the „Jetzt im Salon“ list; the key is the URL value (`?status=`). */
export const ATTENDANCE_FILTERS = {
  alle: { label: "Alle", statuses: null },
  anwesend: { label: "Anwesend", statuses: ["clocked_in", "present"] },
  erwartet: { label: "Erwartet", statuses: ["missing", "scheduled"] },
  abwesend: { label: "Abwesend", statuses: ["absent"] },
} as const satisfies Record<
  string,
  { label: string; statuses: readonly TodayEmployee["status"][] | null }
>;

export type AttendanceFilter = keyof typeof ATTENDANCE_FILTERS;

/** Reads the filter from a URL value; anything unknown is „alle“ (allow-list). */
export function attendanceFilterOf(value: string | null | undefined): AttendanceFilter {
  return value !== null && value !== undefined && value in ATTENDANCE_FILTERS
    ? (value as AttendanceFilter)
    : "alle";
}

/** The rows of the list under a filter; „alle“ hides only persons with nothing today. */
export function filterAttendance(
  rows: readonly TodayEmployee[],
  filter: AttendanceFilter,
): TodayEmployee[] {
  const statuses = ATTENDANCE_FILTERS[filter].statuses as readonly string[] | null;
  if (statuses === null) return rows.filter((r) => r.status !== "none");
  return rows.filter((r) => statuses.includes(r.status));
}

/** A row of `GET /leave/requests?status=PENDING`, the shape the shared review dialog takes. */
export type TeamTaskLeave = LeaveReviewRequest;

/** The open requests the caller may decide: PENDING, not the caller's own, oldest start first. */
export function openTeamLeaveTasks(
  rows: readonly TeamTaskLeave[],
  myEmployeeId: string | null | undefined,
): TeamTaskLeave[] {
  return rows
    .filter((r) => r.status === "PENDING" && r.employeeId !== (myEmployeeId ?? null))
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
}

/** The display name of a leave type code (the one requestable list), never `leaveType.name`. */
export function leaveTypeLabel(code: string): string {
  return LEAVE_TYPE_OPTIONS.find((t) => t.code === code)?.label ?? code;
}
