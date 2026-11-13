// Issue #854 (plan 854-12) - the pure half of the company shutdowns (Betriebsurlaub): the wire types, the
// checks the create form and the detail form share, and the date helpers of the list and the detail. No runes
// and no `$app` imports on purpose; `BetriebsurlaubPanel.svelte` and the detail sub-route own the state and the
// requests.
//
// The server stays the authority (the Zod schema of `/company-shutdowns` and the locked-month refusals); the
// checks here only save a round trip.

import { format } from "date-fns";
import { de } from "date-fns/locale";

// Type aliases, not interfaces: DataTable rows must satisfy `Record<string, unknown>`.
export type ShutdownEmployee = {
  id: string;
  firstName: string;
  lastName: string;
  employeeNumber: string;
};

export type ShutdownException = {
  id: string;
  employeeId: string;
  reason: string | null;
  employee: ShutdownEmployee;
};

export type CompanyShutdown = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  deductsFromVacation: boolean;
  notes: string | null;
  exceptions: ShutdownException[];
};

export type ShutdownForm = {
  name: string;
  startDate: string;
  endDate: string;
};

/** The longest name the API accepts. */
export const SHUTDOWN_NAME_MAX = 100;

/** The first problem of the form, or null. Dates are `YYYY-MM-DD`, which compare as text. */
export function shutdownFormMessage(form: ShutdownForm): string | null {
  if (!form.name.trim() || !form.startDate || !form.endDate)
    return "Bezeichnung, Start- und Enddatum sind Pflichtfelder.";
  if (form.startDate > form.endDate) return "Das Startdatum muss vor dem Enddatum liegen.";
  return null;
}

/** The message of each field of the detail form, "" for a valid one. The API limits the name to 100 characters. */
export function shutdownFieldMessages(form: ShutdownForm): Record<keyof ShutdownForm, string> {
  return {
    name: !form.name.trim()
      ? "Gib eine Bezeichnung an."
      : form.name.trim().length > SHUTDOWN_NAME_MAX
        ? `Die Bezeichnung darf höchstens ${SHUTDOWN_NAME_MAX} Zeichen lang sein.`
        : "",
    startDate: form.startDate ? "" : "Gib das Startdatum an.",
    endDate: !form.endDate
      ? "Gib das Enddatum an."
      : form.startDate && form.startDate > form.endDate
        ? "Das Enddatum darf nicht vor dem Startdatum liegen."
        : "",
  };
}

/** The body of `POST /company-shutdowns`. */
export function createShutdownBody(
  form: ShutdownForm & {
    deductsFromVacation: boolean;
    notes: string;
  },
) {
  return {
    name: form.name.trim(),
    startDate: form.startDate,
    endDate: form.endDate,
    deductsFromVacation: form.deductsFromVacation,
    notes: form.notes || undefined,
  };
}

/** The years offered by the list filter: last year to two years ahead. */
export function shutdownYears(currentYear: number): string[] {
  return [currentYear - 1, currentYear, currentYear + 1, currentYear + 2].map(String);
}

export function formatShutdownDate(date: string): string {
  return format(new Date(date), "dd.MM.yyyy", { locale: de });
}

/** Calendar days of the period, both ends included. */
export function dayCount(start: string, end: string): number {
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000) + 1;
}

/** „1 Tag“ / „8 Tage“. */
export function dayCountLabel(start: string, end: string): string {
  const days = dayCount(start, end);
  return `${days} ${days === 1 ? "Tag" : "Tage"}`;
}

/** „1 Ausnahme“ / „3 Ausnahmen“. */
export function exceptionCountLabel(count: number): string {
  return `${count} ${count === 1 ? "Ausnahme" : "Ausnahmen"}`;
}
