/**
 * Issue #713 (D-03, D-10) - the pure decisions of the table "Abwesenheiten je Person": the columns
 * by leave-type CODE, which columns the whole answer shows, sorting, the one-line summary of the
 * narrow list and the entries of the drill-down. The figures are the server's `rows[].absence`
 * (Pattern 3); nothing here adds, averages or recomputes them - values are only compared and
 * formatted.
 *
 * Pure: no Svelte, no store, no fetch, no `Date`. Every comparator is explicit. Kinds are found by
 * code; the `label` values are display text only, never a control value.
 */
import { fmtDaysDe } from "./period-format";
import type { PeriodPersonAbsenceCode, PeriodRow } from "./period-report";
import type { SortDir } from "./period-table";

export type AbsenceUnit = "Kalendertage" | "Tage" | "Arbeitstage";

export interface AbsenceColumn {
  code: PeriodPersonAbsenceCode;
  /** The column header: the kind and its unit, e.g. „Krank (Kalendertage)“. */
  header: string;
  /** The short kind name for list lines, hints and the drill-down. */
  label: string;
  unit: AbsenceUnit;
}

/**
 * The ten columns in the server's canonical order (the order of `rows[].absence` and of the CSV).
 * Sick days are calendar days, Berufsschule days are school days, every other kind counts
 * Arbeitstage (P-713-02). Each `label:` stands on its own line (leave-type identity guard).
 */
export const ABSENCE_COLUMNS: readonly AbsenceColumn[] = [
  {
    code: "SICK",
    header: "Krank (Kalendertage)",
    label: "Krank",
    unit: "Kalendertage",
  },
  {
    code: "SICK_CHILD",
    header: "Kinderkrank (Kalendertage)",
    label: "Kinderkrank",
    unit: "Kalendertage",
  },
  {
    code: "VACATION",
    header: "Urlaub (Arbeitstage)",
    label: "Urlaub",
    unit: "Arbeitstage",
  },
  {
    code: "OVERTIME_COMP",
    header: "Überstundenausgleich (Arbeitstage)",
    label: "Überstundenausgleich",
    unit: "Arbeitstage",
  },
  {
    code: "SPECIAL",
    header: "Sonderurlaub (Arbeitstage)",
    label: "Sonderurlaub",
    unit: "Arbeitstage",
  },
  {
    code: "VOCATIONAL_SCHOOL",
    header: "Berufsschule (Tage)",
    label: "Berufsschule",
    unit: "Tage",
  },
  {
    code: "EDUCATION",
    header: "Bildungsurlaub (Arbeitstage)",
    label: "Bildungsurlaub",
    unit: "Arbeitstage",
  },
  {
    code: "UNPAID",
    header: "Unbezahlt (Arbeitstage)",
    label: "Unbezahlt",
    unit: "Arbeitstage",
  },
  {
    code: "MATERNITY",
    header: "Mutterschutz (Arbeitstage)",
    label: "Mutterschutz",
    unit: "Arbeitstage",
  },
  {
    code: "PARENTAL",
    header: "Elternzeit (Arbeitstage)",
    label: "Elternzeit",
    unit: "Arbeitstage",
  },
];

/**
 * One text for the unit difference (D-03): the report counts sick days as calendar days, while the
 * Kinderkrankengeld (§ 45 SGB V) and DATEV count Arbeitstage.
 */
export const ABSENCE_UNIT_HINT =
  "Krank und Kinderkrank in Kalendertagen (mit Wochenende), Berufsschule in Schultagen, alle anderen Arten in Arbeitstagen. Das Kinderkrankengeld der Krankenkasse zählt Arbeitstage – Monatsexport und DATEV zeigen deshalb Arbeitstage.";

/**
 * The columns with a value above 0 in at least one row. Callers pass the WHOLE answer, never a page
 * or a search result, so a column neither appears nor disappears while paging or searching.
 */
export function visibleAbsenceColumns(rows: readonly PeriodRow[]): AbsenceColumn[] {
  return ABSENCE_COLUMNS.filter((c) => rows.some((r) => r.absence[c.code] > 0));
}

/** The complement of `visibleAbsenceColumns`, in canonical order. */
export function hiddenAbsenceColumns(rows: readonly PeriodRow[]): AbsenceColumn[] {
  return ABSENCE_COLUMNS.filter((c) => !rows.some((r) => r.absence[c.code] > 0));
}

export type AbsenceSortKey = "name" | PeriodPersonAbsenceCode;

/** A column's first click: a person ascending, a figure descending. */
export function firstAbsenceDirection(key: AbsenceSortKey): SortDir {
  return key === "name" ? "asc" : "desc";
}

/** The next sort after a click on `key`: the same column flips, a new column starts. */
export function nextAbsenceSort(
  current: { key: AbsenceSortKey; dir: SortDir },
  key: AbsenceSortKey,
): { key: AbsenceSortKey; dir: SortDir } {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: firstAbsenceDirection(key) };
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "de");
}

/**
 * A copy of `rows` ordered by `key`: the name by German collation, a code by its value. Ties are
 * broken by name and then id, so the order is stable and total.
 */
export function sortAbsenceRows(
  rows: readonly PeriodRow[],
  key: AbsenceSortKey,
  dir: SortDir,
): PeriodRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "name") {
      const byName = compareText(a.employeeName, b.employeeName);
      if (byName !== 0) return sign * byName;
    } else if (a.absence[key] !== b.absence[key]) {
      return sign * (a.absence[key] - b.absence[key]);
    }
    return compareText(a.employeeName, b.employeeName) || compareText(a.employeeId, b.employeeId);
  });
}

/**
 * The one-line summary of a person in the narrow list: the visible kinds with a value above 0, in
 * canonical order („Krank 2 · Kinderkrank 1“).
 */
export function absenceListLine(row: PeriodRow, columns: readonly AbsenceColumn[]): string {
  const parts = columns
    .filter((c) => row.absence[c.code] > 0)
    .map((c) => `${c.label} ${fmtDaysDe(row.absence[c.code])}`);
  return parts.length === 0 ? "Keine Abwesenheiten" : parts.join(" · ");
}

export interface AbsenceEntry {
  label: string;
  value: number;
  unit: AbsenceUnit;
}

/** The person's non-zero kinds in canonical order with their unit (the drill-down section). */
export function personAbsenceEntries(row: PeriodRow): AbsenceEntry[] {
  return ABSENCE_COLUMNS.filter((c) => row.absence[c.code] > 0).map((c) => ({
    label: c.label,
    value: row.absence[c.code],
    unit: c.unit,
  }));
}

const SINGULAR: Record<AbsenceUnit, string> = {
  Kalendertage: "Kalendertag",
  Tage: "Tag",
  Arbeitstage: "Arbeitstag",
};

/** „Krank: 2 Kalendertage“, „Kinderkrank: 1 Kalendertag“: a count and its unit, never a date. */
export function absenceEntryText(entry: AbsenceEntry): string {
  const unit = entry.value === 1 ? SINGULAR[entry.unit] : entry.unit;
  return `${entry.label}: ${fmtDaysDe(entry.value)} ${unit}`;
}
