// Issue #854 (plan 09) - the shared shapes and day names of the Dienstplan configuration page
// (Verwalten › Regeln › Dienstplan): shift templates, coverage rules and the week pattern matrix.
// Plain `type` aliases, because a DataTable row must satisfy `Record<string, unknown>`.

export type ShiftTemplate = {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  color: string;
};

export type CoverageRule = {
  id: string;
  templateId: string | null;
  /** -1 = all days, 0..6 = Mo..So. */
  dayOfWeek: number;
  /** A Decimal arrives as a string from Prisma. */
  minStaff: number | string;
  requiresNonSupervised: boolean;
  /** Issue #647: display fields served by the list; null = a rule for all salons. */
  salonId: string | null;
  salonName: string | null;
  salonActive: boolean | null;
};

/** A SHIFT_BASED person of `GET /shifts/week`, the rows of the pattern matrix. */
export type PatternEmployee = {
  id: string;
  firstName: string;
  lastName: string;
  workSchedules?: Array<{
    type: "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED";
    weeklyHours: number | string | null;
  }>;
};

/** One stored tenant pattern cell, `GET /shift-patterns/tenant`. */
export type PatternRow = {
  employeeId: string;
  /** 0..6 = Mo..So. */
  dayOfWeek: number;
  templateId: string | null;
};

export const DAY_NAMES = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;
export const DAY_NAMES_LONG = [
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
  "Sonntag",
] as const;

/** Palette for shift template colours (theme-independent tokens). */
export const SHIFT_PALETTE = [
  { token: "--shift-violet", label: "Violett" },
  { token: "--shift-blue", label: "Blau" },
  { token: "--shift-green", label: "Grün" },
  { token: "--shift-amber", label: "Bernstein" },
  { token: "--shift-rose", label: "Rose" },
  { token: "--shift-slate", label: "Schiefer" },
] as const;

/** Reads a colour token from the document; `fallback` outside a browser or when the token is unset. */
export function resolveShiftToken(name: string, fallback = ""): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** matrix[employeeId][0..6] = templateId | null */
export type PatternMatrix = Record<string, Array<string | null>>;

/** The SHIFT_BASED persons of `GET /shifts/week`, sorted by last name, first name (German collation). */
export function shiftBasedEmployees(all: readonly PatternEmployee[]): PatternEmployee[] {
  return all
    .filter((employee) => employee.workSchedules?.[0]?.type === "SHIFT_BASED")
    .sort((a, b) =>
      `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`, "de"),
    );
}

/** One row of seven cells per person, filled from the stored tenant patterns. */
export function buildPatternMatrix(
  employees: readonly PatternEmployee[],
  patterns: readonly PatternRow[],
): PatternMatrix {
  const matrix: PatternMatrix = {};
  for (const employee of employees) matrix[employee.id] = Array(7).fill(null);
  for (const pattern of patterns) {
    if (matrix[pattern.employeeId] && pattern.dayOfWeek >= 0 && pattern.dayOfWeek <= 6) {
      matrix[pattern.employeeId][pattern.dayOfWeek] = pattern.templateId;
    }
  }
  return matrix;
}

/**
 * The Soll hint of a weekday column: the average weekly hours divided by 5, for Mo-Fr only. Null for
 * Sa/So (most salons are closed) and when no clean signal is available.
 */
export function sollHintForDay(employees: readonly PatternEmployee[], dow: number): string | null {
  if (dow > 4 || employees.length === 0) return null;
  const hours = employees
    .map((employee) => Number(employee.workSchedules?.[0]?.weeklyHours ?? NaN))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (hours.length === 0) return null;
  const perDay = hours.reduce((sum, n) => sum + n, 0) / hours.length / 5;
  return `Ø ${perDay.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
}
