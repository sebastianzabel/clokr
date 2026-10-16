import { SICK_CODES } from "./team-calendar-visibility";

/**
 * Issue #595 (D-04) - the one label for the STORED day count of a leave request (`LeaveRequest.days`),
 * replacing five private copies.
 *
 * "Krankheitstage" means calendar days everywhere (weekends included): the kernel behind
 * `GET /leave/sick-days`, the monthly report and both PDFs. A request's stored `days` is a different
 * quantity - a workday price - so for the sick types it is named "Arbeitstage" and the two figures
 * stay visibly distinct. Every other type keeps the text it always had.
 */
export function leaveDaysLabel(
  days: number,
  halfDay: boolean,
  typeCode: string | null | undefined,
): string {
  if (halfDay) return "½ Tag";
  const isSick = (SICK_CODES as readonly string[]).includes(typeCode ?? "");
  if (isSick) return days === 1 ? "1 Arbeitstag" : `${days} Arbeitstage`;
  return days === 1 ? "1 Tag" : `${days} Tage`;
}

/** Unit of the "Krankheitstage" KPI: the figure counts calendar days. */
export function calendarDaysUnit(n: number): string {
  return n === 1 ? "Kalendertag" : "Kalendertage";
}
