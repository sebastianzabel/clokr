/**
 * day-break-violation.ts
 *
 * Issue #80 (D-09 / D-11 / D-20) + Issue #511 (D-10 / D-12 / D-18) — presentation helpers for the
 * SERVER-computed day check (`GET /api/v1/day-breaks/checks`). The browser never computes a break
 * finding itself, neither the cross-salon sum nor the § 4 Satz 2/3 placement: a salon-scoped
 * manager's entry list is partial, so a client-side sum would under-report the day, and a redacted
 * day deliberately carries no times to compute from. Markers, badges, toasts and chips are built
 * from the day check's `warnings` and `breakFinding`; no threshold and no § 4 sentence lives here.
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
 * One server-built finding of a day (mirror of `ArbZGWarning` as `GET /day-breaks/checks` and the
 * save responses return it). The `message` is final text; the browser renders it as it is.
 */
export interface DayCheckWarning {
  code: string;
  severity: "warning" | "error";
  message: string;
  /** Satz-2/3 findings only: a certain violation or one that unrecorded travel decides. */
  certainty?: "VIOLATION" | "UNCLEAR";
  legalBasis?: string;
  /** A hint (position of the break not recorded) never counts as a finding or a marker. */
  hint?: true;
  waived?: true;
  crossSalon?: true;
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
  /** The day carries a finding a manager can acknowledge (cross-salon shortfall or Satz 2/3). */
  breakFinding: boolean;
  /** A break exists whose position is not recorded, so Satz 2/3 could not be checked. */
  positionUnknown: boolean;
  /** The day's complete server-built finding list (§ 3, § 4 / § 11 and placement items). */
  warnings: DayCheckWarning[];
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
 * The badge a day with a break finding gets; null when the server reports no finding. The #80
 * cross-salon labels stay as they were; every other finding (Satz 2/3 on a single-salon day, or
 * on a cross-salon day without a Satz-1 shortfall) reads "Pausenregel verletzt", or "Pause:
 * Klärung nötig" while an UNCLEAR finding is open. An acknowledged day keeps a quiet marker so
 * the trail stays visible (D-08, Revisionssicherheit).
 */
export function dayCheckBadge(check: DayCheck): DayCheckBadge | null {
  if (!check.breakFinding) return null;
  if (check.crossSalon && check.breakShortfall) {
    return check.acknowledged
      ? { cls: "badge-gray", label: "Salonübergreifend: quittiert" }
      : { cls: "badge-yellow", label: "Salonübergreifend: Pause fehlt" };
  }
  if (check.acknowledged) return { cls: "badge-gray", label: "Pausenverstoß: quittiert" };
  const unclear = (check.warnings ?? []).some((w) => !w.hint && w.certainty === "UNCLEAR");
  return unclear
    ? { cls: "badge-yellow", label: "Pause: Klärung nötig" }
    : { cls: "badge-yellow", label: "Pausenregel verletzt" };
}

/**
 * The calendar-marker warnings of one server day: the server's `warnings` in server order, hints
 * excluded (a hint never becomes a marker, A5). Nothing is composed or compared here; an API
 * without the field yields [].
 */
export function dayCheckWarnings(check: DayCheck): DayWarning[] {
  return (check.warnings ?? [])
    .filter((w) => !w.hint)
    .map((w) => ({ code: w.code, severity: w.severity, message: w.message }));
}

/** Date -> marker warnings for every server day that has at least one non-hint warning. */
export function dayChecksToArbzgMap(days: DayCheck[]): Map<string, DayWarning[]> {
  const map = new Map<string, DayWarning[]>();
  for (const day of days) {
    const warnings = dayCheckWarnings(day);
    if (warnings.length > 0) map.set(day.date, warnings);
  }
  return map;
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
  const server = dayChecksToArbzgMap(days);
  for (const day of days) {
    const warnings = server.get(day.date);
    if (warnings) merged.set(day.date, warnings);
    else merged.delete(day.date);
  }
  return merged;
}

/** The Satz-2/3 finding codes (§ 4 ArbZG / § 11 JArbSchG) a save response can return. */
const PLACEMENT_CODES = new Set([
  "BREAK_SEGMENT_TOO_SHORT",
  "BREAK_TOO_LATE",
  "BREAK_OUTSIDE_WINDOW",
]);

/**
 * The toast text for a break finding that the API returned with a save (POST / PUT of an entry,
 * clock-out) — Issue #80 D-09a + Issue #511 D-10. `warnings` is the raw response field and is read
 * defensively: anything that is not an object with a string code (no field, empty, malformed)
 * yields null. Two kinds of finding count:
 *   - a warning with `crossSalon: true` (BREAK_TOO_SHORT / MAX_DAILY_EXCEEDED) — the fixed #80
 *     texts, byte-identical;
 *   - a Satz-2/3 warning (BREAK_SEGMENT_TOO_SHORT, BREAK_TOO_LATE, BREAK_OUTSIDE_WINDOW) — the
 *     server's own message follows "Pausenregel nicht eingehalten:", never a client-built text.
 * A hint (`hint: true`, e.g. the position of the break is not recorded) never shows a toast.
 * The save itself has already succeeded; the notice only tells what the day now lacks. It is shown
 * to employees AND managers (team page), so the text carries no pronoun. Per-entry § 4 findings
 * stay with the existing client-side modal warnings.
 */
export function breakFindingSaveNotice(warnings: unknown): string | null {
  if (!Array.isArray(warnings)) return null;
  const crossCodes = new Set<string>();
  const placementMessages: string[] = [];
  for (const w of warnings) {
    if (typeof w !== "object" || w === null) continue;
    const { code, crossSalon, hint, message } = w as {
      code?: unknown;
      crossSalon?: unknown;
      hint?: unknown;
      message?: unknown;
    };
    if (typeof code !== "string" || hint === true) continue;
    if (crossSalon === true) crossCodes.add(code);
    if (PLACEMENT_CODES.has(code) && typeof message === "string" && message.length > 0) {
      placementMessages.push(message);
    }
  }

  const parts: string[] = [];
  if (crossCodes.has("BREAK_TOO_SHORT")) {
    parts.push(
      "Gespeichert. Über beide Salons gerechnet fehlt für diesen Tag eine ausreichende Pause " +
        "(§ 4 ArbZG, salonübergreifend). Fahrzeit zwischen zwei Salons ist Arbeitszeit und " +
        "keine Pause – eine tatsächlich genommene Pause kann für den Tag eingetragen werden.",
    );
  }
  if (crossCodes.has("MAX_DAILY_EXCEEDED")) {
    parts.push(
      "Gespeichert. Die salonübergreifende Tagessumme überschreitet die 10-Stunden-Grenze " +
        "(§ 3 ArbZG).",
    );
  }
  if (placementMessages.length > 0) {
    const prefix = parts.length === 0 ? "Gespeichert. " : "";
    parts.push(`${prefix}Pausenregel nicht eingehalten: ${placementMessages.join(" ")}`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

export interface MonthCloseHint {
  label: string;
  title: string;
}

/**
 * The display-only chip of the admin month-close page for the days on which an employee's
 * § 4 ArbZG / § 11 JArbSchG break finding is still open and unacknowledged (D-09b / D-12 / D-15).
 * `days` is the API's `breakFindingDays` ("YYYY-MM-DD"); a malformed entry is dropped rather than
 * printed. Null when nothing is open — the chip then does not render. The chip decides nothing:
 * whether the close is blocked is the server's rule (tenant flag), this only makes the reason
 * visible.
 */
export function breakFindingMonthCloseHint(
  days: string[] | null | undefined,
): MonthCloseHint | null {
  if (!Array.isArray(days)) return null;
  const valid = days.filter((d) => typeof d === "string" && DAY_KEY.test(d));
  if (valid.length === 0) return null;

  const shown = valid
    .slice(0, 3)
    .map((d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`)
    .join(", ");
  const more = valid.length > 3 ? ` (+${valid.length - 3} weitere)` : "";
  return {
    label: `Pausenverstoß offen (${valid.length})`,
    title:
      `Offener Pausenverstoß (§ 4 ArbZG / § 11 JArbSchG) an: ${shown}${more}; ` +
      "vor dem Abschluss eine Pause erfassen oder den Tag quittieren.",
  };
}
