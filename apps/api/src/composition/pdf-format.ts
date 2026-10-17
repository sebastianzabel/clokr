/**
 * Issue #617 (D-617-3) - the ONE place PDF numbers become German text.
 *
 * Input is always MINUTES (or a plain number of days), never an hours figure that was rounded for
 * the JSON report: `fmtHM(9225)` is "153:45 h" because the minutes are split, whereas deriving it
 * from 153.75 rounded to two places would drift by a minute on other values (research Pitfall 8).
 *
 * Pure and dependency-free: no PDFKit, no ICU (`Intl` / `toLocaleString` depend on the runtime's
 * locale data and are not used), integer arithmetic only. The minus sign is the ASCII hyphen because
 * PDFKit's built-in Helvetica (WinAnsi) has no U+2212. No PDF output path calls `.toFixed` - the
 * decimal point it writes is exactly what this module exists to avoid.
 */

/** Hours and minutes from a minute count, e.g. 9225 -> "153:45 h", -30 -> "-0:30 h". */
export function fmtHM(minutes: number): string {
  const whole = Math.round(minutes);
  const abs = Math.abs(whole);
  const h = Math.floor(abs / 60);
  const mm = String(abs % 60).padStart(2, "0");
  return `${whole < 0 ? "-" : ""}${h}:${mm} h`;
}

/** Like `fmtHM` with an explicit "+" for a positive value; zero is printed unsigned. */
export function fmtSignedHM(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole > 0) return `+${fmtHM(whole)}`;
  return fmtHM(whole);
}

/**
 * A number with a decimal comma and without trailing zeros, e.g. 0.5 -> "0,5", 1 -> "1",
 * 2.25 -> "2,25". `maxDigits` is the maximum number of decimal places (default 2).
 */
export function fmtDecimalDe(n: number, maxDigits = 2): string {
  const scale = 10 ** maxDigits;
  // The epsilon keeps a binary-float value such as 2.255 * 10 = 22.549999... on the side the
  // decimal reading expects.
  const scaled = Math.round(Math.abs(n) * scale + 1e-9);
  const intPart = Math.floor(scaled / scale);
  const fraction = scaled % scale;
  const sign = n < 0 && scaled !== 0 ? "-" : "";
  if (fraction === 0) return `${sign}${intPart}`;
  // Trailing zeros are dropped by integer division, not by a regex (fraction is non-zero here).
  let trimmed = fraction;
  let width = maxDigits;
  while (trimmed % 10 === 0) {
    trimmed /= 10;
    width -= 1;
  }
  const digits = String(trimmed).padStart(width, "0");
  return `${sign}${intPart},${digits}`;
}

/** A day count with the right number word: "1 Tag", "2 Tage", "0,5 Tage", "0 Tage". */
export function fmtDays(n: number): string {
  const text = fmtDecimalDe(n);
  return text === "1" ? "1 Tag" : `${text} Tage`;
}
