// Issue #853 (D-853-13, S-22) - the pure model of Dienstplan › Verfügbarkeit: the rows of the person
// table, the search and the sort. No request, no store: the page feeds it the answer of
// `GET /employees` (narrowed to the caller's reach by the server) and renders what comes out.
import { matchesSearch } from "$lib/table/search";
import { isAnonymizedPerson } from "$lib/team/personen-model";

/** What the model reads of a `GET /employees` row. */
export interface AvailabilityEmployee {
  id: string;
  firstName: string;
  lastName: string;
  employeeNumber?: string | null;
}

/** A type alias, not an interface: DataTable's row generic wants an index-signature-compatible type. */
export type AvailabilityRow = {
  id: string;
  /** „Vorname Nachname“ as shown. */
  name: string;
  /** „Nachname, Vorname“ - the sort key of the name column. */
  sortName: string;
  /** The Personalnummer; "" while the person has none. */
  number: string;
  /** „Nachname, Vorname · Nr.“ - what the search matches. */
  searchText: string;
};

export interface AvailabilitySort {
  /** The only sortable column is the name; the key stays explicit so a column can be added without a new signature. */
  key: "name";
  dir: "asc" | "desc";
}

/** Rows of the table; an anonymised person (DSGVO) never appears. */
export function availabilityRows(employees: readonly AvailabilityEmployee[]): AvailabilityRow[] {
  return employees
    .filter((person) => !isAnonymizedPerson(person))
    .map((person) => {
      const number = person.employeeNumber?.trim() ?? "";
      const sortName = `${person.lastName}, ${person.firstName}`;
      return {
        id: person.id,
        name: `${person.firstName} ${person.lastName}`,
        sortName,
        number,
        searchText: number === "" ? sortName : `${sortName} · ${number}`,
      };
    });
}

/** Search by name or Personalnummer; a blank search matches everyone. */
export function filterAvailability(rows: readonly AvailabilityRow[], q: string): AvailabilityRow[] {
  return rows.filter((row) => matchesSearch(row.searchText, q));
}

const collator = new Intl.Collator("de");

/** A new, sorted array: by „Nachname, Vorname“, ties by the id, so the order is total and stable. */
export function sortAvailability(
  rows: readonly AvailabilityRow[],
  sort: AvailabilitySort,
): AvailabilityRow[] {
  const sign = sort.dir === "desc" ? -1 : 1;
  return [...rows].sort(
    (a, b) =>
      sign * collator.compare(a.sortName, b.sortName) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
