/**
 * Issue #86, D-02 - the month-close page renders the server's day lists as dates when the reader
 * may see them and as counts when the server withheld them (`dayDetailsWithheld: true`, a reader
 * without `time-entry:read` reach over the person, e.g. the Personalabteilung).
 *
 * The one rule this module protects: a withheld, emptied list is NOT "no gaps". The count comes
 * from the server's own count field (`missingDateCount`, `gapCount`, ...), never from the length
 * of an array that the redaction emptied. UX only - what a caller may read is decided by the API.
 */
import { breakFindingMonthCloseHint, type MonthCloseHint } from "$lib/breaks/day-break-violation";

/** Shown once on the page when any row was withheld. */
export const DAY_DETAILS_WITHHELD_HINT =
  "Tagesangaben sind nur mit Leserecht auf Zeiteinträge sichtbar; die Anzahl bleibt.";

/** The fields of a status row, a year-status `missing[]` entry or a deferred employee. */
export interface DayListRow {
  dayDetailsWithheld?: boolean;
  missingDates?: string[];
  missingDateCount?: number;
  /** Deferred employees carry their gap days as `gapDates` / `gapCount`. */
  gapDates?: string[];
  gapCount?: number;
  karenzOverrunDays?: string[];
  karenzOverrunDayCount?: number;
  breakFindingDays?: string[];
  breakFindingDayCount?: number;
}

/** "2026-09-05" -> "05.09."; the list is comma separated. */
export function formatMissingDates(dates: readonly string[]): string {
  return dates
    .map((d) => {
      const parts = d.split("-");
      return `${parts[2]}.${parts[1]}.`;
    })
    .join(", ");
}

/** At most three dates, the rest as "(+n)". */
export function formatMissingShort(dates: readonly string[]): string {
  if (dates.length <= 3) return formatMissingDates(dates);
  return `${formatMissingDates(dates.slice(0, 3))} (+${dates.length - 3})`;
}

function countField(...values: Array<number | undefined>): number | null {
  for (const v of values) if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/** „1 Tag ohne Eintrag“ / „N Tage ohne Eintrag“. */
export function daysWithoutEntryText(count: number): string {
  return count === 1 ? "1 Tag ohne Eintrag" : `${count} Tage ohne Eintrag`;
}

/**
 * Number of days without an entry. Reads the server's count field; the array length is used only
 * when the row carries no count field at all and was not withheld (an older server).
 */
export function gapCountOf(row: DayListRow): number {
  const fromServer = countField(row.missingDateCount, row.gapCount);
  if (fromServer !== null) return fromServer;
  if (row.dayDetailsWithheld) return 0;
  return (row.missingDates ?? row.gapDates ?? []).length;
}

function gapDatesOf(row: DayListRow): string[] {
  return row.missingDates ?? row.gapDates ?? [];
}

/**
 * The text for the days without an entry: the dates when present, the count text when the dates
 * were withheld, an empty string when there is nothing to show (count 0).
 */
export function missingDaysText(row: DayListRow, options: { short?: boolean } = {}): string {
  const dates = gapDatesOf(row);
  if (dates.length > 0) {
    return options.short ? formatMissingShort(dates) : formatMissingDates(dates);
  }
  const count = gapCountOf(row);
  return count > 0 ? daysWithoutEntryText(count) : "";
}

/** Break-finding day count (server count field first). */
export function breakFindingCountOf(row: DayListRow): number {
  const fromServer = countField(row.breakFindingDayCount);
  if (fromServer !== null) return fromServer;
  return row.dayDetailsWithheld ? 0 : (row.breakFindingDays ?? []).length;
}

/** Karenz-overrun day count (server count field first). */
export function karenzOverrunCountOf(row: DayListRow): number {
  const fromServer = countField(row.karenzOverrunDayCount);
  if (fromServer !== null) return fromServer;
  return row.dayDetailsWithheld ? 0 : (row.karenzOverrunDays ?? []).length;
}

/** Title of the „Attest fehlt“ chip: the dates when present, otherwise the count only. */
export function karenzOverrunTitle(row: DayListRow): string {
  const base = "Krankheitstage ohne Attest über die Karenzzeit hinaus (§ 5 EFZG)";
  const dates = row.karenzOverrunDays ?? [];
  if (dates.length > 0) return `${base}: ${formatMissingShort(dates)}`;
  return `${base}: ${karenzOverrunCountOf(row)}`;
}

/** The break-finding chip: dates through the existing hint, the bare count when withheld. */
export function breakFindingHintFor(row: DayListRow): MonthCloseHint | null {
  const withDates = breakFindingMonthCloseHint(row.breakFindingDays);
  if (withDates) return withDates;
  const count = breakFindingCountOf(row);
  if (count <= 0) return null;
  return {
    label: `Pausenverstoß offen (${count})`,
    title:
      "Offener Pausenverstoß (§ 4 ArbZG / § 11 JArbSchG); " +
      "vor dem Abschluss eine Pause erfassen oder den Tag quittieren.",
  };
}

/** True when the server withheld the day lists of at least one row. */
export function anyDayDetailsWithheld(rows: ReadonlyArray<DayListRow | null | undefined>): boolean {
  return rows.some((r) => r?.dayDetailsWithheld === true);
}
