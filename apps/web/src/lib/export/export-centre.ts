/**
 * The pure rules of Verwalten > Daten > Export (Issue #854, plan 854-24, D-854-13/-22): the hint before a payroll
 * export of a month that is not closed, the history of past exports read from the tenant's `EXPORT` audit rows, and
 * the preselection a link can carry in the URL. No store, no `$app`, no request - the page loads and downloads.
 *
 * The words of an export kind come only from `$lib/audit/labels` (the code stays the control value), so the history
 * says the same as the Protokoll.
 */
import { format } from "date-fns";
import { auditActorLabel } from "$lib/audit/actor-label";
import { exportTypeLabel } from "$lib/audit/labels";
import { RANGE_ERROR_TEXT, validateRange } from "$lib/reports/period-state";
import type { YearMonth } from "$lib/reports/period-report";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_KEY = /^(\d{4})-(\d{2})$/;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The year range the month-close status accepts (`GET /overtime/close-month/year-status`). */
const MIN_YEAR = 2020;
const MAX_YEAR = 2099;

/** „Oktober 2026“. */
export function monthName(ym: YearMonth): string {
  return new Intl.DateTimeFormat("de-DE", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(ym.year, ym.month - 1, 1)));
}

/**
 * The warning before exporting `month` of `year`, or null when there is nothing to warn about. `status` is the
 * month's status from `GET /overtime/close-month/year-status`; it is `undefined` for a caller without
 * `month-close:read` or after a failed read - then there is neither a hint nor an error (the export itself is
 * decided by the API). Advisory only: the button stays usable.
 */
export function openMonthHint(
  status: string | undefined,
  year: number,
  month: number,
): string | null {
  if (status === undefined || status === "closed") return null;
  const name = monthName({ year, month });
  if (status === "partial") {
    return `${name} ist erst für einen Teil der Personen abgeschlossen. Exportiere erst nach dem Monatsabschluss, sonst können sich die Zahlen noch ändern.`;
  }
  return `${name} ist noch nicht abgeschlossen. Exportiere erst nach dem Monatsabschluss, sonst können sich die Zahlen noch ändern.`;
}

/** The fields of a `GET /audit-logs` row the history reads. */
export interface ExportLogLike {
  id: string;
  createdAt: string;
  user: { email: string } | null;
  newValue: unknown;
  affectedEmployee?: { firstName: string; lastName: string } | null;
}

export interface ExportHistoryRow {
  id: string;
  /** „03.11.2026 14:05“ in the browser's local time, like the Protokoll. */
  when: string;
  who: string;
  /** The German word of the export kind. */
  kind: string;
  /** What was exported: the person and/or the period; „—“ when the row names neither. */
  scope: string;
}

function field(newValue: unknown, key: string): unknown {
  if (typeof newValue !== "object" || newValue === null) return undefined;
  return (newValue as Record<string, unknown>)[key];
}

function wholeNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && /^\d{1,4}$/.test(value)) return Number(value);
  return null;
}

function dayLabel(day: string): string {
  const [, y, m, d] = DAY_KEY.exec(day) ?? [];
  return `${d}.${m}.${y}`;
}

/** The period a row names, as words; null when it names none. */
function periodScope(newValue: unknown): string | null {
  // The writers store year and month as numbers or as digit strings ("2026", "7"); both are read.
  const year = wholeNumber(field(newValue, "year"));
  const month = wholeNumber(field(newValue, "month"));
  if (year !== null && month !== null && month >= 1 && month <= 12) {
    return monthName({ year, month });
  }
  const from = field(newValue, "from");
  const to = field(newValue, "to");
  if (typeof from !== "string" || typeof to !== "string") return null;
  const fromMonth = MONTH_KEY.exec(from);
  const toMonth = MONTH_KEY.exec(to);
  if (fromMonth && toMonth) {
    const a = monthName({ year: Number(fromMonth[1]), month: Number(fromMonth[2]) });
    const b = monthName({ year: Number(toMonth[1]), month: Number(toMonth[2]) });
    return a === b ? a : `${a} bis ${b}`;
  }
  if (DAY_KEY.test(from) && DAY_KEY.test(to)) {
    // „01.09.–30.09.2026“ within one year, the full form across years.
    return from.slice(0, 4) === to.slice(0, 4)
      ? `${dayLabel(from).slice(0, 6)}–${dayLabel(to)}`
      : `${dayLabel(from)}–${dayLabel(to)}`;
  }
  return null;
}

/**
 * The exports this page starts, by the control value `newValue.type` of their `EXPORT` audit row (#854 owner
 * review): DATEV (all persons or one), the two period CSVs and the Monatsexport. Other `EXPORT` rows (the
 * Protokoll CSV, a person's Stundennachweis, documents retired by #617) belong to other pages and are not listed.
 */
export const EXPORT_CENTRE_TYPES: ReadonlySet<string> = new Set([
  "DATEV",
  "DATEV_EMPLOYEE",
  "PERIOD_CSV",
  "PERIOD_ABSENCES_CSV",
  "MONTHLY_EXPORT_PDF",
]);

/** How many rows „Letzte Exporte“ shows. */
export const EXPORT_HISTORY_SIZE = 20;

/** The history list: one row per `EXPORT` audit row of this page's kinds, newest first, in German words only. */
export function exportHistoryRows(logs: readonly ExportLogLike[]): ExportHistoryRow[] {
  return [...logs]
    .filter((log) => {
      const type = field(log.newValue, "type");
      return typeof type === "string" && EXPORT_CENTRE_TYPES.has(type);
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((log) => {
      const type = field(log.newValue, "type");
      const person = log.affectedEmployee
        ? `${log.affectedEmployee.lastName}, ${log.affectedEmployee.firstName}`
        : null;
      const scope = [person, periodScope(log.newValue)].filter((part) => part !== null).join(" · ");
      return {
        id: log.id,
        when: format(new Date(log.createdAt), "dd.MM.yyyy HH:mm"),
        who: auditActorLabel(log).text,
        kind: exportTypeLabel(typeof type === "string" ? type : ""),
        scope: scope === "" ? "—" : scope,
      };
    })
    .slice(0, EXPORT_HISTORY_SIZE);
}

export interface ExportPreselection {
  personId: string | null;
  year: number | null;
  month: number | null;
}

/** What a link to the page preselects: `?person=<uuid>&year=2026&month=10`. Every malformed value is dropped. */
export function exportPreselection(url: URL): ExportPreselection {
  const person = url.searchParams.get("person");
  const year = url.searchParams.get("year");
  const month = url.searchParams.get("month");
  const asInt = (value: string | null, min: number, max: number): number | null => {
    if (value === null || !/^\d{1,4}$/.test(value)) return null;
    const n = Number(value);
    return n >= min && n <= max ? n : null;
  };
  return {
    personId: person !== null && UUID.test(person) ? person : null,
    year: asInt(year, MIN_YEAR, MAX_YEAR),
    month: asInt(month, 1, 12),
  };
}

/**
 * The link into the export page with a choice preselected (D-854-22): the inverse of
 * `exportPreselection`, so the keys are spelled in this module only. A person is optional.
 */
export function exportHref(choice: {
  personId?: string | null;
  year: number;
  month: number;
}): string {
  const query = new URLSearchParams();
  if (choice.personId) query.set("person", choice.personId);
  query.set("year", String(choice.year));
  query.set("month", String(choice.month));
  return `/verwalten/daten/export?${query.toString()}`;
}

/** The problem of a chosen CSV period in German (`GET /reports/period/csv` takes months, at most 12, none in the future); null when fine. */
export function csvPeriodProblem(from: YearMonth, to: YearMonth, today: YearMonth): string | null {
  const problem = validateRange(from, to, today);
  return problem === null ? null : RANGE_ERROR_TEXT[problem];
}

/**
 * The German problem of a whole-number setting, or null when fine. `label` is the field's name as the page
 * shows it (the page owns every word of the DATEV numbers); an empty optional field is fine.
 */
export function wholeNumberProblem(
  label: string,
  value: number | null | undefined,
  range: { min: number; max: number; optional?: boolean },
): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return range.optional ? null : `${label} ist eine Pflichtangabe.`;
  }
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    return `${label} ist eine ganze Zahl von ${range.min} bis ${range.max}.`;
  }
  return null;
}
