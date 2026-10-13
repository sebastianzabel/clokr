// Opening-hours helpers of the operator salon form (Issue #89, D-10).
//
// The API stores seven entries, `day` 0 = Montag … 6 = Sonntag. A closed day still carries valid
// `open` / `close` strings because the API schema requires them, so closing a day never empties
// its times. The form keeps one entry per index, so `days[index].day === index`.
import type { OpeningHoursDay } from "./types";

/** Display names, indexed by `day` (0 = Montag). */
export const DAY_NAMES: readonly string[] = [
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
  "Sonntag",
];

export const DEFAULT_OPEN = "09:00";
export const DEFAULT_CLOSE = "18:00";

export const HOURS_ORDER_MESSAGE = "Die Öffnungszeit muss vor der Schließzeit liegen.";
export const HOURS_MISSING_MESSAGE = "Uhrzeit angeben.";

// Same pattern as the API schema (`salonOpeningHoursSchema`).
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Montag-Freitag 09:00-18:00 open, Samstag and Sonntag closed. */
export function defaultOpeningHours(): OpeningHoursDay[] {
  return DAY_NAMES.map((_, day) => ({
    day,
    open: DEFAULT_OPEN,
    close: DEFAULT_CLOSE,
    closed: day >= 5,
  }));
}

function isUsable(hours: readonly OpeningHoursDay[] | null | undefined): boolean {
  if (!hours || hours.length !== 7) return false;
  const seen = new Set<number>();
  for (const entry of hours) {
    if (!Number.isInteger(entry.day) || entry.day < 0 || entry.day > 6) return false;
    if (!TIME_PATTERN.test(entry.open) || !TIME_PATTERN.test(entry.close)) return false;
    seen.add(entry.day);
  }
  return seen.size === 7;
}

/**
 * The hours a new salon starts with: a deep copy of the tenant's current Standardsalon hours when
 * those are seven valid entries, otherwise the default. The copy is ordered by `day` and always
 * carries an explicit `closed`, so the form edits it in place without touching the loaded salon.
 */
export function prefillOpeningHours(
  defaultSalon: { openingHours: readonly OpeningHoursDay[] } | null | undefined,
): OpeningHoursDay[] {
  const source = defaultSalon?.openingHours;
  if (!isUsable(source)) return defaultOpeningHours();
  return [...(source as readonly OpeningHoursDay[])]
    .sort((a, b) => a.day - b.day)
    .map((entry) => ({
      day: entry.day,
      open: entry.open,
      close: entry.close,
      closed: entry.closed === true,
    }));
}

/**
 * Problems per day index. Only an open day can have one: a closed day's times are ignored by the
 * API's order check. Zero-padded `HH:MM` strings compare correctly as text.
 */
export function validateOpeningHours(days: readonly OpeningHoursDay[]): Record<number, string> {
  const errors: Record<number, string> = {};
  days.forEach((entry, index) => {
    if (entry.closed) return;
    if (!TIME_PATTERN.test(entry.open) || !TIME_PATTERN.test(entry.close)) {
      errors[index] = HOURS_MISSING_MESSAGE;
    } else if (entry.open >= entry.close) {
      errors[index] = HOURS_ORDER_MESSAGE;
    }
  });
  return errors;
}

/** An empty PLZ is fine (the field is optional); a filled one is exactly five digits. */
export function isValidPostalCode(value: string): boolean {
  return value === "" || /^\d{5}$/.test(value);
}
