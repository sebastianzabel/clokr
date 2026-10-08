/**
 * day-break-violation.ts
 *
 * Issue #80 (D-09 / D-11 / D-20) — presentation helpers for the SERVER-computed day check
 * (`GET /api/v1/day-breaks/checks`). The browser never computes a cross-salon finding itself:
 * a salon-scoped manager's entry list is partial, so a client-side sum would under-report the
 * day, and a redacted day deliberately carries no times to compute from.
 *
 * Lives in `$lib` because route pages cannot be mounted in this repo's vitest setup
 * (apps/web/vitest.config.ts deliberately excludes the SvelteKit pipeline). Pure module: type
 * imports only.
 */

/** One entry of a day as the API returns it on a `full` day (D-11: absent on a redacted day). */
export interface DayCheckEntry {
  id: string;
  startTime: string;
  endTime: string;
  salonId: string;
}

/** One gap between two closed entries of the day, from the day-break kernel. */
export interface DayCheckGap {
  startTime: string;
  endTime: string;
  crossSalon: boolean;
  countsAsBreak: boolean;
}

/** A break recorded on the day itself (not on an entry). */
export interface DayCheckDayBreak {
  id: string;
  startTime: string;
  endTime: string;
}

/** The current acknowledgement of a cross-salon violation (D-08). */
export interface DayCheckAcknowledgement {
  id: string;
  createdAt: string;
  reason: string;
}

/**
 * Mirror of the `DayCheck` of `apps/api/src/contexts/time-tracking/api/day-breaks.ts`.
 * `detail: "redacted"` means the caller's reach covers only part of the day: totals and the
 * finding are present, `entries`, `gaps`, `dayBreaks` and `acknowledgement` are null.
 */
export interface DayCheck {
  /** "YYYY-MM-DD" calendar-day key. */
  date: string;
  detail: "full" | "redacted";
  crossSalon: boolean;
  netWorkedMinutes: number;
  totalBreakMinutes: number;
  requiredBreakMinutes: number;
  breakShortfall: boolean;
  maxDailyExceeded: boolean;
  acknowledged: boolean;
  locked: boolean;
  mayAcknowledge: boolean;
  mayRecordDayBreak: boolean;
  acknowledgement: DayCheckAcknowledgement | null;
  entries: DayCheckEntry[] | null;
  gaps: DayCheckGap[] | null;
  dayBreaks: DayCheckDayBreak[] | null;
}

export interface DayChecksResponse {
  employeeId: string;
  from: string;
  to: string;
  days: DayCheck[];
}

/** The warning shape of the time-entries page's calendar markers and day lists. */
export interface DayWarning {
  code: string;
  severity: "warning" | "error";
  message: string;
}

export interface DayCheckBadge {
  cls: "badge-yellow" | "badge-gray";
  label: string;
}

/** The API refuses a window of more than 62 inclusive days (D-20, T-80-31). */
const MAX_RANGE_DAYS = 62;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function dayKeyMs(key: string): number {
  return DAY_KEY.test(key) ? Date.parse(`${key}T00:00:00Z`) : Number.NaN;
}

/** True when `from`..`to` is a non-inverted window of at most 62 inclusive calendar days. */
export function isChecksRangeAllowed(from: string, to: string): boolean {
  const a = dayKeyMs(from);
  const b = dayKeyMs(to);
  if (Number.isNaN(a) || Number.isNaN(b) || a > b) return false;
  return (b - a) / 86_400_000 + 1 <= MAX_RANGE_DAYS;
}

/** Hours with one decimal and a German decimal comma, e.g. 480 -> "8,0". */
export function hoursDe(minutes: number): string {
  return (minutes / 60).toFixed(1).replace(".", ",");
}

/**
 * The badge a cross-salon § 4 finding gets on its day; null when there is no such finding.
 * An acknowledged day keeps a quiet marker so the trail stays visible (D-08, Revisionssicherheit).
 */
export function dayCheckBadge(check: DayCheck): DayCheckBadge | null {
  if (!check.crossSalon || !check.breakShortfall) return null;
  return check.acknowledged
    ? { cls: "badge-gray", label: "Salonübergreifend: quittiert" }
    : { cls: "badge-yellow", label: "Salonübergreifend: Pause fehlt" };
}

/**
 * The calendar-marker warnings of one server day. § 4 is downgraded to a warning once the day is
 * acknowledged (the API waives only the § 4 finding); the § 3 daily cap is never waived (D-18).
 */
export function dayCheckWarnings(check: DayCheck): DayWarning[] {
  const warnings: DayWarning[] = [];
  const cross = check.crossSalon ? " (salonübergreifend)" : "";

  if (check.breakShortfall) {
    const severity: DayWarning["severity"] =
      check.requiredBreakMinutes === 45 && !check.acknowledged ? "error" : "warning";
    const acked = check.acknowledged ? " – quittiert" : "";
    warnings.push({
      code: "BREAK_TOO_SHORT",
      severity,
      message:
        `§ 4 ArbZG${cross}: Insgesamt ${hoursDe(check.netWorkedMinutes)} h gearbeitet, ` +
        `${Math.round(check.totalBreakMinutes)} Min Pause erfasst, ` +
        `${check.requiredBreakMinutes} Min vorgeschrieben${acked}.`,
    });
  }

  if (check.maxDailyExceeded) {
    warnings.push({
      code: "MAX_DAILY_EXCEEDED",
      severity: "error",
      message:
        `§ 3 ArbZG${cross}: Tägliche Höchstarbeitszeit von 10 Stunden überschritten ` +
        `(${hoursDe(check.netWorkedMinutes)} h).`,
    });
  }

  return warnings;
}

/**
 * Overlays the server's day checks onto the client-computed marker map. For every server day the
 * client warnings of that date are REPLACED (an empty result removes the date); dates without a
 * server day are untouched. The input map is not mutated.
 */
export function mergeDayChecksIntoArbzgMap(
  clientMap: Map<string, DayWarning[]>,
  days: DayCheck[],
): Map<string, DayWarning[]> {
  const merged = new Map(clientMap);
  for (const day of days) {
    const warnings = dayCheckWarnings(day);
    if (warnings.length > 0) merged.set(day.date, warnings);
    else merged.delete(day.date);
  }
  return merged;
}
