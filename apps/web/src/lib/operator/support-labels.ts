// German display labels of the support read views (Issue #93, AC-93-9). Display only: every map is
// keyed by the control value the API sends, and no code decides anything from these strings (D-13).
// An unknown value (a new enum value the console does not know yet) is shown raw by `labelFor`,
// never hidden and never an error. The maps are kept here, not shared with the tenant app, so the
// operator console imports nothing from the tenant client, session or stores (isolation scan).

/** `ScheduleType` (packages/db/prisma/schema.prisma). */
export const SCHEDULE_TYPE_LABELS = {
  FIXED_SCHEDULE: "Feste Arbeitszeiten",
  FLEXTIME: "Gleitzeit",
  MONTHLY_HOURS: "Monatsstunden",
  SHIFT_BASED: "Schichtbasiert",
} as const;

/** `TimeEntryType`. */
export const ENTRY_TYPE_LABELS = {
  WORK: "Arbeitszeit",
  OVERTIME: "Überstunden",
  PUBLIC_HOLIDAY: "Feiertag",
} as const;

/** `TimeEntrySource`. */
export const ENTRY_SOURCE_LABELS = {
  NFC: "NFC-Terminal",
  MOBILE: "Mobil",
  MANUAL: "Manuell",
  CORRECTION: "Korrektur",
  WIFI: "WLAN",
} as const;

/** `InvalidReasonCode`: the authoritative reason code of an invalid entry, never its derived text. */
export const INVALID_REASON_LABELS = {
  MISSING_CLOCK_OUT: "Ausstempeln fehlt",
  LEAVE_CANCELLATION_PENDING: "Urlaubsstornierung ausstehend",
  RETRO_APPROVAL_PENDING: "Nachtrag wartet auf Genehmigung",
  LEGACY_UNMAPPED: "Altbestand ohne Grund",
} as const;

/** `BreakStatus`. */
export const BREAK_STATUS_LABELS = {
  AUTO: "Automatisch",
  CONFIRMED: "Bestätigt",
  WAIVED: "Durchgearbeitet",
} as const;

/** `LeaveRequestStatus`. */
export const LEAVE_STATUS_LABELS = {
  PENDING: "Beantragt",
  APPROVED: "Genehmigt",
  REJECTED: "Abgelehnt",
  CANCELLED: "Storniert",
  CANCELLATION_REQUESTED: "Stornierung beantragt",
} as const;

/** `LeaveTypeCode`; it is also the type of an imposed `Absence`. */
export const LEAVE_TYPE_LABELS = {
  VACATION: "Urlaub",
  OVERTIME_COMP: "Überstundenausgleich",
  SPECIAL: "Sonderurlaub",
  UNPAID: "Unbezahlter Urlaub",
  SICK: "Krankheit",
  SICK_CHILD: "Kind krank",
  EDUCATION: "Bildungsurlaub",
  MATERNITY: "Mutterschutz",
  PARENTAL: "Elternzeit",
  VOCATIONAL_SCHOOL: "Berufsschule",
  OTHER: "Sonstiges",
} as const;

/** `AbsenceSource`. */
export const ABSENCE_SOURCE_LABELS = {
  PATTERN: "Automatisch (Muster)",
  MANUAL: "Manuell",
} as const;

/** Derived employee status of the support DTOs. */
export const EMPLOYEE_STATUS_LABELS = {
  ACTIVE: "Aktiv",
  EXITED: "Ausgetreten",
  ANONYMIZED: "Gelöscht",
} as const;

/** Basis of the month figures (`computeMonthReportFigures`). */
export const FIGURES_BASIS_LABELS = {
  snapshot: "Abgeschlossen",
  fullMonth: "Ganzer Monat",
  toDate: "Bis heute",
  untracked: "Ohne Erfassung",
} as const;

/** Why the month figures are missing. */
export const FIGURES_UNAVAILABLE_LABELS = {
  NO_ACTIVE_SALON: "Der Mandant hat keinen aktiven Salon.",
} as const;

/** `WorkSchedule.overtimeMode` (a plain string column: "CARRY_FORWARD" | "TRACK_ONLY"). */
export const OVERTIME_MODE_LABELS = {
  CARRY_FORWARD: "Überstunden übertragen",
  TRACK_ONLY: "Nur erfassen",
} as const;

/** Weekday numbers of the schedule columns (0 = Sunday .. 6 = Saturday), short German names. */
export const WEEKDAY_SHORT_LABELS = {
  "0": "So",
  "1": "Mo",
  "2": "Di",
  "3": "Mi",
  "4": "Do",
  "5": "Fr",
  "6": "Sa",
} as const;

/** The weekday order of the support views: Monday first, Sunday last. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/**
 * The German label of a control value. An unknown value is returned as it is (never hidden), a
 * missing one is a dash. Own keys only, so a value such as `constructor` is never resolved through
 * the prototype.
 */
export function labelFor(
  map: Readonly<Record<string, string>>,
  value: string | null | undefined,
): string {
  if (value === null || value === undefined) return "–";
  return Object.prototype.hasOwnProperty.call(map, value) ? map[value] : value;
}

function hoursAndMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

/** Minutes as `h:mm`, rounded to whole minutes; a negative value keeps its sign. */
export function formatMinutes(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 0) return `−${hoursAndMinutes(-rounded)}`;
  return hoursAndMinutes(rounded);
}

/** A saldo as `h:mm` with an explicit sign (`+1:30`, `−1:30`); zero has none. */
export function formatSignedMinutes(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded > 0) return `+${hoursAndMinutes(rounded)}`;
  if (rounded < 0) return `−${hoursAndMinutes(-rounded)}`;
  return "0:00";
}

/** A day count with the German decimal comma (`0,5`, `5`). */
export function formatDays(days: number): string {
  return String(days).replace(".", ",");
}

/** The badge recipe (`app.css`) of an employee status; an unknown status reads as the neutral one. */
export function employeeStatusBadgeClass(status: string): string {
  if (status === "ACTIVE") return "badge-green";
  if (status === "ANONYMIZED") return "badge-yellow";
  return "badge-gray";
}

/**
 * A list of weekday numbers (0 = Sunday .. 6 = Saturday) as `Mo, Di, ...` in Monday-first order.
 * A number outside 0..6 is shown raw after the known ones; an empty list is a dash.
 */
export function formatWeekdays(days: readonly number[]): string {
  if (days.length === 0) return "–";
  const known = WEEKDAY_ORDER.filter((day) => days.includes(day)).map((day) =>
    labelFor(WEEKDAY_SHORT_LABELS, String(day)),
  );
  const unknown = days.filter(
    (day) => !WEEKDAY_ORDER.includes(day as (typeof WEEKDAY_ORDER)[number]),
  );
  return [...known, ...unknown.map(String)].join(", ");
}
