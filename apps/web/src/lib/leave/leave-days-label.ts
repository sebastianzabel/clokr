import { SICK_CODES } from "./team-calendar-visibility";
import { formatDays } from "./review-facts";

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
  if (isSick) return roundDays(days) === 1 ? "1 Arbeitstag" : `${formatDays(days)} Arbeitstage`;
  return formatDayCount(days);
}

/**
 * Issue #853-19 - a day figure of the leave area as text: "1 Tag", "15,42 Tage". The number goes
 * through `formatDays` (decimal comma, at most two decimals), so a balance that is the result of a
 * float subtraction (30 - 14.58 = 15.420000000000002) never reaches the screen unrounded. Use this
 * for every balance, entitlement or request day figure that carries the unit "Tag/Tage".
 */
export function formatDayCount(days: number): string {
  return roundDays(days) === 1 ? "1 Tag" : `${formatDays(days)} Tage`;
}

/** The value `formatDays` prints, as a number: the singular is decided on what is shown. */
function roundDays(days: number): number {
  return Math.round(days * 100) / 100;
}

/** Unit of the "Krankheitstage" KPI: the figure counts calendar days. */
export function calendarDaysUnit(n: number): string {
  return n === 1 ? "Kalendertag" : "Kalendertage";
}
