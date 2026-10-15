// The month of the support month view (Issue #93). The API accepts `YYYY-MM` for the years 2000 to
// 2100 only; the view validates the `monat` query against the same bounds and steps inside them.
import { format } from "date-fns";
import { de } from "date-fns/locale";

export const MIN_MONTH = "2000-01";
export const MAX_MONTH = "2100-12";

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The value when it is a supported `YYYY-MM`, otherwise null. */
export function monthFromQuery(value: string | null): string | null {
  if (value === null) return null;
  const match = MONTH_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 2000 && year <= 2100 ? value : null;
}

/** The month of the given instant in the browser's zone (D-03). */
export function currentMonth(now: Date = new Date()): string {
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** The month `delta` months away, clamped to the supported range. */
export function shiftMonth(month: string, delta: number): string {
  const match = MONTH_PATTERN.exec(month);
  if (!match) return month;
  const index = Number(match[1]) * 12 + (Number(match[2]) - 1) + delta;
  const year = Math.floor(index / 12);
  const shifted = `${String(year).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
  if (shifted < MIN_MONTH) return MIN_MONTH;
  if (shifted > MAX_MONTH) return MAX_MONTH;
  return shifted;
}

/** `September 2026` for a `YYYY-MM`; an unsupported value is returned as it is. */
export function monthLabel(month: string): string {
  const match = MONTH_PATTERN.exec(month);
  if (!match) return month;
  return format(new Date(Number(match[1]), Number(match[2]) - 1, 1), "LLLL yyyy", { locale: de });
}
