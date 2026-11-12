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
