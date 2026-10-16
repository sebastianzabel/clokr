/**
 * Issue #86, D-01 - the employment state of a person, decided from `exitDate` and a calendar day,
 * never from a display string. The exit date is the END OF THE EMPLOYMENT: the person stays visible
 * with all data (retention), and the app login stays active until someone with access management
 * locks it separately (a deliberate split, see the exit-date hint on the detail page).
 *
 * `exitDate` is read by its UTC calendar day, the convention of the employee form (`@db.Timestamptz`
 * holding a UTC-midnight date). The web has no tenant-local "today" helper, so callers pass the
 * browser-local calendar day from `localCalendarDay()`; a person whose last day is today is still
 * employed (EXIT_PLANNED) until the day is over.
 */
export type EmploymentKind = "EMPLOYED" | "EXIT_PLANNED" | "ENDED";

export interface EmploymentState {
  kind: EmploymentKind;
  /** „Austritt am TT.MM.JJJJ“ / „Ausgeschieden am TT.MM.JJJJ“; empty for EMPLOYED. */
  label: string;
}

/** The browser-local calendar day as `YYYY-MM-DD`. */
export function localCalendarDay(now: Date = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${mm}-${dd}`;
}

function germanDay(isoDay: string): string {
  const [y, m, d] = isoDay.split("-");
  return `${d}.${m}.${y}`;
}

/** `today` is a `YYYY-MM-DD` calendar day. */
export function employmentState(
  exitDate: string | null | undefined,
  today: string,
): EmploymentState {
  if (!exitDate) return { kind: "EMPLOYED", label: "" };
  const exitDay = String(exitDate).slice(0, 10);
  if (exitDay >= today) return { kind: "EXIT_PLANNED", label: `Austritt am ${germanDay(exitDay)}` };
  return { kind: "ENDED", label: `Ausgeschieden am ${germanDay(exitDay)}` };
}
