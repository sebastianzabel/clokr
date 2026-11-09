// Issue #843 (D-843-01 block 6, D-843-11, T-843-18) - the URL schema and the sort of the
// /admin/employees list. The search text and the sort live in the URL through `urlState()`; this
// file only names the allow-list (q, sort, dir) and the pure client-side sort. The list is loaded
// whole (`GET /employees`) and filtered and paged in the browser, so the sort needs no API change.
import { oneOf, text } from "$lib/table/url-state";

/** The sortable columns of the list: the display name and the hire date („Eintritt“). */
export const EMPLOYEE_SORT_KEYS = ["name", "hire"] as const;
export type EmployeeSortKey = (typeof EMPLOYEE_SORT_KEYS)[number];
export type EmployeeSortDir = "asc" | "desc";

/** The allow-list of the list's query keys. Every other key of the URL (e.g. `salonId`) is left alone. */
export const listUrlSchema = {
  q: text({ max: 80 }),
  sort: oneOf(EMPLOYEE_SORT_KEYS, "name"),
  dir: oneOf(["asc", "desc"] as const, "asc"),
};

/** What the sort reads of a row. */
export interface SortableEmployee {
  firstName: string;
  lastName: string;
  hireDate: string;
}

function displayName(row: SortableEmployee): string {
  // The list shows „Nachname, Vorname“, so that is the order the eye expects.
  return `${row.lastName}, ${row.firstName}`;
}

/** An unparsable date sorts last in ascending order (NaN never reaches the comparator). */
function hireTime(row: SortableEmployee): number {
  const time = Date.parse(row.hireDate);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/**
 * A new, stably sorted array: by display name (German collation) or by hire date. Equal rows keep
 * their incoming order in both directions.
 */
export function sortEmployees<T extends SortableEmployee>(
  rows: readonly T[],
  sort: EmployeeSortKey,
  dir: EmployeeSortDir,
): T[] {
  const sign = dir === "desc" ? -1 : 1;
  const compare =
    sort === "hire"
      ? (a: T, b: T) => {
          const x = hireTime(a);
          const y = hireTime(b);
          return x === y ? 0 : x < y ? -1 : 1;
        }
      : (a: T, b: T) => displayName(a).localeCompare(displayName(b), "de");
  return [...rows].sort((a, b) => sign * compare(a, b));
}
