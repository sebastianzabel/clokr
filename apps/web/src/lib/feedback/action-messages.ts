/**
 * #843 (D-843-08, D-843-19) - the acknowledgement texts of the start-page writes, in ONE place.
 * A page hands the result of a write to `toasts.success(...)` through one of these functions and
 * never assembles the sentence itself, so the wording of „what happened" cannot drift per page.
 *
 * Pure functions, no store and no request: the caller decides WHEN to acknowledge (only after the
 * server answered), this module decides WHAT is said. Salon names and leave labels are display
 * values handed in by the caller from server data; nothing here is compared as a control value.
 */
import { format } from "date-fns";

/**
 * HH:MM of an instant, in the time zone the dashboard already displays (the browser's local zone,
 * `format(date, "HH:mm")` like the clock card's „gestartet um" line).
 */
export function clockTime(instant: string | Date): string {
  return format(typeof instant === "string" ? new Date(instant) : instant, "HH:mm");
}

/** „Eingestempelt 10:02 · Salon Nord"; the salon part is left out when no salon name is known. */
export function clockedIn(time: string, salonName?: string | null): string {
  const salon = salonName?.trim();
  return salon ? `Eingestempelt ${time} · ${salon}` : `Eingestempelt ${time}`;
}

/** „Ausgestempelt 18:01". */
export function clockedOut(time: string): string {
  return `Ausgestempelt ${time}`;
}

/** „Pause gestartet 12:03" - local only, the server-side pause is #596 (D-843-19). */
export function breakStarted(time: string): string {
  return `Pause gestartet ${time}`;
}

/** „Pause beendet 12:33" - said after the break POST succeeded. */
export function breakEnded(time: string): string {
  return `Pause beendet ${time}`;
}

/** „Korrektur gespeichert". */
export function correctionSaved(): string {
  return "Korrektur gespeichert";
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})/;

/** Splits a calendar day `YYYY-MM-DD` (or an ISO string starting with one) without any Date/zone math. */
function dayParts(day: string): { y: string; m: string; d: string } {
  const match = DATE_ONLY.exec(day);
  if (!match) throw new Error(`Not a calendar day: ${day}`);
  return { y: match[1], m: match[2], d: match[3] };
}

/**
 * The period of a leave request: „10.11.2026" for one day, „10.11.–14.11.2026" inside a year,
 * „29.12.2026–02.01.2027" across years.
 */
function leavePeriod(startDate: string, endDate: string): string {
  const s = dayParts(startDate);
  const e = dayParts(endDate);
  const startFull = `${s.d}.${s.m}.${s.y}`;
  const endFull = `${e.d}.${e.m}.${e.y}`;
  if (startFull === endFull) return startFull;
  if (s.y === e.y) return `${s.d}.${s.m}.–${endFull}`;
  return `${startFull}–${endFull}`;
}

/**
 * „Antrag gestellt · Urlaub 10.11.–14.11.2026"; a half day appends „ (halber Tag)".
 * `typeLabel` is the display name of the leave type (DISPLAY_NAME), never `leaveType.name`.
 */
export function leaveRequested(
  typeLabel: string,
  startDate: string,
  endDate: string,
  halfDay = false,
): string {
  const base = `Antrag gestellt · ${typeLabel} ${leavePeriod(startDate, endDate)}`;
  return halfDay ? `${base} (halber Tag)` : base;
}

/**
 * #846 (D-03): „Urlaub genehmigt · 14.12.–18.12.2026“ / „Urlaub abgelehnt · …“ — the acknowledgement of a
 * decision in the shared review dialog (Aufgaben and Heute im Salon). `typeLabel` as in `leaveRequested`.
 */
export function leaveDecided(
  typeLabel: string,
  startDate: string,
  endDate: string,
  status: "APPROVED" | "REJECTED",
): string {
  const verb = status === "APPROVED" ? "genehmigt" : "abgelehnt";
  return `${typeLabel} ${verb} · ${leavePeriod(startDate, endDate)}`;
}
