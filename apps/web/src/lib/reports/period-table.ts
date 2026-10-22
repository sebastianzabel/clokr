/**
 * Issue #612 (D-612-4, UI-SPEC "Tab Zeiten & Konten") - the pure decisions of the period table:
 * searching, sorting and the status of a row. The figures themselves are the server's minutes
 * (Pattern 3); nothing here adds, averages or recomputes them.
 *
 * Pure: no Svelte, no store, no fetch, no `Date`. Every comparator is explicit.
 */
import { forecastLabel } from "$lib/saldo/forecast-label";
import type { PeriodRow } from "./period-report";

export type PeriodSortKey = "name" | "soll" | "ist" | "opening" | "balance" | "closing" | "status";
export type SortDir = "asc" | "desc";

/** A column's first click: a person ascending, a figure descending (UI-SPEC). */
export function firstDirection(key: PeriodSortKey): SortDir {
  return key === "name" ? "asc" : "desc";
}

/** The next sort after a click on `key`: the same column flips, a new column starts. */
export function nextSort(
  current: { key: PeriodSortKey; dir: SortDir },
  key: PeriodSortKey,
): { key: PeriodSortKey; dir: SortDir } {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: firstDirection(key) };
}

/** Rows whose name or personnel number contains the query (case-insensitive, trimmed). */
export function filterPeriodRows(rows: readonly PeriodRow[], query: string): PeriodRow[] {
  const q = query.trim().toLocaleLowerCase("de");
  if (q === "") return [...rows];
  return rows.filter(
    (r) =>
      r.employeeName.toLocaleLowerCase("de").includes(q) ||
      r.employeeNumber.toLocaleLowerCase("de").includes(q),
  );
}

export type RowStatusKind = "confirmed" | "forecast" | "unlabelled";

export interface RowStatus {
  kind: RowStatusKind;
  /** The chip text: "Bestätigt", the data-driven forecast wording, or "ohne Soll". */
  label: string;
  /** „2 von 3 Monaten bestätigt“ - only for a forecast with at least one confirmed month. */
  detail: string | null;
}

/**
 * The status of a row (P-08): every listed month closed is „Bestätigt“; otherwise the forecast,
 * worded by the one forecast-label rule from the months that are not confirmed (orchestrator
 * amendment 7 - the wording follows the data); a person without a Soll in any listed month is
 * „ohne Soll“. A closed month exists when the period holds one or the closing saldo is split
 * after a closed month before it (P-13).
 */
export function rowStatus(row: PeriodRow): RowStatus {
  if (!row.labelled) return { kind: "unlabelled", label: "ohne Soll", detail: null };
  if (row.monthCount > 0 && row.confirmedMonthCount >= row.monthCount) {
    return { kind: "confirmed", label: "Bestätigt", detail: null };
  }
  const unconfirmed = row.unconfirmedMonths ?? row.monthCount - row.confirmedMonthCount;
  const hasClosedMonth = row.confirmedMonthCount > 0 || row.closingConfirmedMinutes !== null;
  return {
    kind: "forecast",
    label: forecastLabel(unconfirmed, hasClosedMonth),
    detail:
      row.confirmedMonthCount >= 1
        ? `${row.confirmedMonthCount} von ${row.monthCount} Monaten bestätigt`
        : null,
  };
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "de");
}

const STATUS_RANK: Record<RowStatusKind, number> = { confirmed: 0, forecast: 1, unlabelled: 2 };

function figureOf(row: PeriodRow, key: PeriodSortKey): number | null {
  switch (key) {
    case "soll":
      return row.expectedMinutes;
    case "ist":
      return row.workedMinutes;
    case "opening":
      return row.openingBalanceMinutes;
    case "balance":
      return row.balanceMinutes;
    case "closing":
      return row.closingBalanceMinutes;
    case "status":
      return STATUS_RANK[rowStatus(row).kind];
    default:
      return null;
  }
}

/**
 * A copy of `rows` ordered by `key`. A withheld figure (null) sorts last in either direction; ties
 * are broken by name (German collation) and then id, so the order is stable and total. „Status“
 * puts the confirmed rows first when ascending.
 */
export function sortPeriodRows(
  rows: readonly PeriodRow[],
  key: PeriodSortKey,
  dir: SortDir,
): PeriodRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key !== "name") {
      const x = figureOf(a, key);
      const y = figureOf(b, key);
      if (x === null && y !== null) return 1;
      if (x !== null && y === null) return -1;
      if (x !== null && y !== null && x !== y) return sign * (x - y);
    } else {
      const byName = compareText(a.employeeName, b.employeeName);
      if (byName !== 0) return sign * byName;
    }
    return compareText(a.employeeName, b.employeeName) || compareText(a.employeeId, b.employeeId);
  });
}

/** Whether any row carries a saldo figure (otherwise the three saldo columns are not rendered). */
export function hasSaldoFigures(rows: readonly PeriodRow[]): boolean {
  return rows.some(
    (r) =>
      r.balanceMinutes !== null ||
      r.closingBalanceMinutes !== null ||
      r.openingBalanceMinutes !== null,
  );
}

/** Why a figure is missing, as the cell's title and its screen-reader text. */
export function withheldReason(row: PeriodRow): string {
  if (row.sollUnavailableReason === "NO_PERMISSION") return "Keine Berechtigung";
  return "Kein Wert vorhanden";
}

/** Initials for the avatar of the mobile list: first letters of the first and last word. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0].charAt(0);
  const last = words.length > 1 ? words[words.length - 1].charAt(0) : "";
  return `${first}${last}`.toLocaleUpperCase("de");
}
