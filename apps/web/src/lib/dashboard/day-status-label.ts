// Issue #587 (P-06) — the ONE place the web names a person's day status.
//
// The API decides the status (`resolveDayStatus`, Zeiterfassung); this module only words it. No
// status is derived here, no clock is read and no time is computed: the expected start and the
// minutes late arrive as finished values on the attendance row (D-587-3), and the expected hours
// of a team-week cell are the contract hours the cell already carries.
import { fmtMin } from "$lib/utils/format-minutes";

export type DayStatusValue =
  "present" | "clocked_in" | "absent" | "missing" | "scheduled" | "requested" | "holiday" | "none";

export const DAY_STATUS_LABEL: Record<DayStatusValue, string> = {
  present: "Anwesend",
  clocked_in: "Eingestempelt",
  absent: "Abwesend",
  missing: "Fehlt",
  scheduled: "Geplant",
  requested: "Beantragt",
  holiday: "Feiertag",
  none: "—",
};

/** The text of one row of the attendance list. */
export function attendanceStatusText(row: {
  status: string;
  reason: string | null;
  expectedStart?: string | null;
  lateMinutes?: number | null;
}): string {
  switch (row.status) {
    case "present":
      return DAY_STATUS_LABEL.present;
    case "clocked_in":
      return DAY_STATUS_LABEL.clocked_in;
    case "absent":
      return row.reason ?? DAY_STATUS_LABEL.absent;
    case "holiday":
      return row.reason ?? DAY_STATUS_LABEL.holiday;
    case "requested":
      return DAY_STATUS_LABEL.requested;
    case "missing":
      // Issue #743: a past half day of leave without an entry is "missing" and carries the leave
      // type as its reason (the only "missing" row with a reason): the absence stays visible.
      if (row.reason) return `${DAY_STATUS_LABEL.missing} · halber Tag ${row.reason}`;
      return row.expectedStart != null && row.lateMinutes != null
        ? `${DAY_STATUS_LABEL.missing} · erwartet ${row.expectedStart} · ${row.lateMinutes} Min. zu spät`
        : DAY_STATUS_LABEL.missing;
    case "scheduled":
      return row.expectedStart != null
        ? `${DAY_STATUS_LABEL.scheduled} · ab ${row.expectedStart}`
        : DAY_STATUS_LABEL.scheduled;
    default:
      return DAY_STATUS_LABEL.none;
  }
}

/** The title of a „Fehlt“ cell in the team week: the shift times, else the contract day hours. */
export function teamMissingTitle(day: {
  shift?: { startTime: string; endTime: string } | null;
  expectedHours?: number;
}): string {
  if (day.shift) {
    return `${DAY_STATUS_LABEL.missing} – erwartet ${day.shift.startTime}–${day.shift.endTime}`;
  }
  const hours = day.expectedHours ?? 0;
  if (hours > 0) {
    return `${DAY_STATUS_LABEL.missing} – erwartet ${fmtMin(Math.round(hours * 60))} h`;
  }
  return `${DAY_STATUS_LABEL.missing} – Arbeitstag`;
}
