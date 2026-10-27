/** Calendar and time-zone helpers. All simulation dates are tenant-local calendar days. */

export const DEFAULT_TZ = "Europe/Berlin";

/** "YYYY-MM-DD" of an instant in the given zone. */
export function dayInTz(instant: Date, tz: string = DEFAULT_TZ): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Offset of the zone at an instant, in minutes east of UTC. */
function offsetMinutes(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/** The UTC instant of a tenant-local wall clock time ("HH:MM" on "YYYY-MM-DD"). */
export function localInstant(day: string, hhmm: string, tz: string = DEFAULT_TZ): Date {
  const [y, mo, d] = day.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  // Two passes settle the offset across a DST switch.
  let instant = new Date(guess - offsetMinutes(new Date(guess), tz) * 60000);
  instant = new Date(guess - offsetMinutes(instant, tz) * 60000);
  return instant;
}

export function localIso(day: string, hhmm: string, tz: string = DEFAULT_TZ): string {
  return localInstant(day, hhmm, tz).toISOString();
}

/** "HH:MM" from minutes since midnight. */
export function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + delta));
  return date.toISOString().slice(0, 10);
}

/** 0 = Sunday .. 6 = Saturday, like WorkSchedule.workDays. */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function monthOf(day: string): { year: number; month: number } {
  const [y, m] = day.split("-").map(Number);
  return { year: y, month: m };
}

export function firstOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

export function previousMonth(day: string): { year: number; month: number } {
  const { year, month } = monthOf(day);
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

export function dayOfMonth(day: string): number {
  return Number(day.slice(8, 10));
}
