/**
 * Issue #612, UI-SPEC "Number format" — minutes in, German text out.
 *
 * Hours are always H:MM taken from whole minutes (built on `fmtMin` / `fmtBalance`) with a German
 * thousands separator on the hour part; never from rounded decimal hours (Pitfall 8). Days carry
 * at most one decimal comma.
 */

import { fmtBalance, fmtMin } from "$lib/utils/format-minutes";
import { MONTH_NAMES_DE } from "./period-state";

function group(digits: string): string {
  // A linear walk instead of a look-ahead regex (Sonar S8786: super-linear backtracking).
  const parts: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    parts.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return parts.join(".");
}

/**
 * Minutes as H:MM with a grouped hour part: 230535 → "3.842:15". With `signed` a sign
 * character is always shown: "+12:45", "−0:45" (U+2212), "±0:00".
 */
export function fmtHoursDe(min: number, opts?: { signed?: boolean }): string {
  const whole = Math.round(min);
  const [hours, minutes] = fmtMin(whole).split(":");
  const body = `${group(hours)}:${minutes}`;
  if (!opts?.signed) return body;
  const sign = fmtBalance(whole).charAt(0);
  return `${sign}${body}`;
}

/** Days with at most one decimal comma: 12.5 → "12,5", 12 → "12", 0.25 → "0,3". */
export function fmtDaysDe(days: number): string {
  const rounded = Math.round(Math.abs(days) * 10) / 10;
  const [int, frac] = String(rounded).split(".");
  const text = frac ? `${group(int)},${frac}` : group(int);
  return days < 0 && rounded !== 0 ? `−${text}` : text;
}

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-03-31" → "31.03.2026"; anything else is returned unchanged. */
export function fmtDateDe(isoDay: string): string {
  const m = ISO_DAY_RE.exec(isoDay);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : isoDay;
}

/** "2026-03-31" → "31.03."; anything else is returned unchanged. */
export function fmtDateShortDe(isoDay: string): string {
  const m = ISO_DAY_RE.exec(isoDay);
  return m ? `${m[3]}.${m[2]}.` : isoDay;
}

/** (2026, 7) → "Juli 2026". */
export function monthNameDe(year: number, month: number): string {
  return `${MONTH_NAMES_DE[month - 1]} ${year}`;
}
