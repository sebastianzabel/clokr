/**
 * Opening hours of a salon as the tenant admin edits them (Issue #563).
 *
 * Tenant-only module: it never imports from `$lib/operator/*` (the operator console keeps its own
 * copy; the #89 isolation scan forbids a shared import across that boundary).
 *
 * Index convention — `day` 0 = Montag … 6 = Sonntag, like the API's `salonOpeningHoursSchema`.
 * This is NOT the convention of `WorkSchedule.workDays` (0 = Sonntag); never mix the two.
 */

export interface OpeningHoursDay {
  /** 0 = Montag … 6 = Sonntag. */
  day: number;
  /** HH:MM. */
  open: string;
  /** HH:MM. */
  close: string;
  closed?: boolean;
}

/** German long weekday names, index = `OpeningHoursDay.day`. */
export const WEEKDAY_LABELS: readonly string[] = [
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
  "Sonntag",
];

/**
 * Display mirror of the API's `DEFAULT_SALON_OPENING_HOURS` (Mo-Sa 08:00-20:00, So closed). The
 * server stays the authority; a test pins the two against each other.
 */
export const DEFAULT_OPENING_HOURS: readonly OpeningHoursDay[] = [
  { day: 0, open: "08:00", close: "20:00", closed: false },
  { day: 1, open: "08:00", close: "20:00", closed: false },
  { day: 2, open: "08:00", close: "20:00", closed: false },
  { day: 3, open: "08:00", close: "20:00", closed: false },
  { day: 4, open: "08:00", close: "20:00", closed: false },
  { day: 5, open: "08:00", close: "20:00", closed: false },
  { day: 6, open: "08:00", close: "20:00", closed: true },
];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function freshDefault(): OpeningHoursDay[] {
  return DEFAULT_OPENING_HOURS.map((entry) => ({ ...entry }));
}

function isWellFormedEntry(value: unknown): value is OpeningHoursDay {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.day === "number" &&
    Number.isInteger(entry.day) &&
    entry.day >= 0 &&
    entry.day <= 6 &&
    typeof entry.open === "string" &&
    typeof entry.close === "string"
  );
}

/**
 * Turns a stored value into the seven editable rows, ordered by `day`, each with an explicit
 * boolean `closed`. A stored week with seven well-formed entries covering every day once is shown
 * as stored (even when it would fail the server's strict schema, so the admin can correct it and
 * the server validates on save); anything else becomes a fresh copy of the default week.
 */
export function prefillOpeningHours(raw: unknown): OpeningHoursDay[] {
  if (!Array.isArray(raw) || raw.length !== 7 || !raw.every(isWellFormedEntry)) {
    return freshDefault();
  }
  const days = new Set(raw.map((entry) => entry.day));
  if (days.size !== 7) return freshDefault();
  return raw
    .map((entry) => ({
      day: entry.day,
      open: entry.open,
      close: entry.close,
      closed: entry.closed === true,
    }))
    .sort((a, b) => a.day - b.day);
}

/**
 * German message per `day` for every row that would be refused by the server; empty for a valid
 * week. A closed day is never an error.
 */
export function validateOpeningHours(days: readonly OpeningHoursDay[]): Record<number, string> {
  const errors: Record<number, string> = {};
  for (const entry of days) {
    if (entry.closed) continue;
    if (!TIME_RE.test(entry.open) || !TIME_RE.test(entry.close)) {
      errors[entry.day] = "Bitte eine gültige Uhrzeit angeben.";
    } else if (entry.open >= entry.close) {
      errors[entry.day] = "Öffnung muss vor der Schließung liegen.";
    }
  }
  return errors;
}
