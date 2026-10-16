/**
 * Issue #86 (AC-86-5) - display model of an employee's salon assignments. Display only: every rule
 * (overlap, weekday conflict, month lock, hire date, inactive salon) lives in the API
 * (`contexts/platform/api/salon-assignments.ts`) and its answers are shown verbatim. The assignment
 * DTO carries only the salon id, so names come from `GET /salons?includeInactive=true`.
 */

export type AssignmentKind = "HOME" | "DEPLOYMENT";

/** Mirror of the API `AssignmentDto` (calendar days are `YYYY-MM-DD` strings). */
export interface SalonAssignment {
  id: string;
  employeeId: string;
  salonId: string;
  kind: AssignmentKind;
  validFrom: string;
  validUntil: string | null;
  weekdays: number[];
  createdAt?: string;
  updatedAt?: string;
}

/** The slice of a `GET /salons` item this module needs. */
export interface SalonRef {
  id: string;
  name: string;
  isActive: boolean;
}

export interface AssignmentRow {
  id: string;
  kind: AssignmentKind;
  kindLabel: string;
  salonName: string;
  periodLabel: string;
  weekdaysLabel: string;
  ended: boolean;
  /** Only an Einsatzsalon that is open or ends today or later can be ended or shortened. */
  canEnd: boolean;
}

export const KIND_LABELS: Record<AssignmentKind, string> = {
  HOME: "Stammsalon",
  DEPLOYMENT: "Einsatzsalon",
};
export const UNKNOWN_SALON_LABEL = "Unbekannter Salon";
export const INACTIVE_SUFFIX = " (inaktiv)";
export const ALL_DAYS_LABEL = "alle Tage";

/** Weekday toggles in display order (Mo..So); the value is the JS weekday index (0 = Sunday). */
export const WEEKDAY_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "Mo" },
  { value: 2, label: "Di" },
  { value: 3, label: "Mi" },
  { value: 4, label: "Do" },
  { value: 5, label: "Fr" },
  { value: 6, label: "Sa" },
  { value: 0, label: "So" },
];

/** `2026-03-05` -> `05.03.2026` (pure string work, no time zone involved). */
export function formatCalendarDay(day: string): string {
  const [y, m, d] = day.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

function weekdaysLabel(weekdays: number[]): string {
  if (weekdays.length === 0) return ALL_DAYS_LABEL;
  return WEEKDAY_OPTIONS.filter((o) => weekdays.includes(o.value))
    .map((o) => o.label)
    .join(", ");
}

function isCurrent(a: SalonAssignment, today: string): boolean {
  return a.validUntil === null || a.validUntil >= today;
}

/**
 * Rows of the assignment list: current first (open, or ending today or later), then ended; each group
 * by `validFrom` descending (id as tie-break). `today` is a `YYYY-MM-DD` calendar day. Inputs are not
 * mutated.
 */
export function assignmentRows(
  assignments: readonly SalonAssignment[],
  salons: readonly SalonRef[],
  today: string,
): AssignmentRow[] {
  const byId = new Map(salons.map((s) => [s.id, s]));
  const sorted = [...assignments].sort((a, b) => {
    const ca = isCurrent(a, today) ? 0 : 1;
    const cb = isCurrent(b, today) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    if (a.validFrom !== b.validFrom) return a.validFrom < b.validFrom ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted.map((a) => {
    const salon = byId.get(a.salonId);
    const salonName = salon
      ? salon.isActive
        ? salon.name
        : `${salon.name}${INACTIVE_SUFFIX}`
      : UNKNOWN_SALON_LABEL;
    const current = isCurrent(a, today);
    return {
      id: a.id,
      kind: a.kind,
      kindLabel: KIND_LABELS[a.kind],
      salonName,
      periodLabel:
        a.validUntil === null
          ? `seit ${formatCalendarDay(a.validFrom)}`
          : `${formatCalendarDay(a.validFrom)} – ${formatCalendarDay(a.validUntil)}`,
      weekdaysLabel: a.kind === "HOME" ? "" : weekdaysLabel(a.weekdays),
      ended: !current,
      canEnd: a.kind === "DEPLOYMENT" && current,
    };
  });
}
