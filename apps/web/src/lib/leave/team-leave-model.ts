/**
 * Issue #840 (E-01, E-02, E-06) - the pure decisions of the Team → Abwesenheiten host page that
 * are not a view: which persons the Übersicht draws, which list feeds the Anträge tab for a status
 * filter, and on which page of that list a request sits.
 *
 * Presentation only. Nothing here decides who may see what: the rows of the calendar answer are
 * already masked by the server, the roster is the list the API returned for the caller's reach.
 */
import type { LeaveStatusFilter } from "./area-tabs";
import type { TimelinePerson } from "./timeline-model";

/** A person of the reach list (`GET /employees`); names only. */
export interface RosterPerson {
  id: string;
  firstName: string;
  lastName: string;
}

/**
 * The Übersicht rows: the persons of the calendar answer plus every person of the roster that has
 * no row yet (a row even without a bar, E-06), optionally narrowed to one person, ordered by last
 * name, first name, id. A person that only appears in the answer (outside the roster) is sorted
 * by the last word of the name.
 */
export function overviewPersons(
  answer: readonly TimelinePerson[],
  roster: readonly RosterPerson[],
  options: { employeeId?: string; ownEmployeeId?: string | null } = {},
): TimelinePerson[] {
  const known = new Set(answer.map((row) => row.employeeId));
  const lastNameOf = new Map(roster.map((person) => [person.id, person.lastName]));
  const rows: TimelinePerson[] = [...answer];
  for (const person of roster) {
    if (known.has(person.id)) continue;
    rows.push({
      employeeId: person.id,
      name: `${person.firstName} ${person.lastName}`.trim(),
      isOwn: person.id === (options.ownEmployeeId ?? null),
      bars: [],
    });
  }
  const sortKey = (row: TimelinePerson): [string, string] => {
    const last = lastNameOf.get(row.employeeId) ?? row.name.split(/\s+/).slice(-1)[0] ?? "";
    return [last, row.name];
  };
  const wanted = options.employeeId;
  return rows
    .filter((row) => !wanted || row.employeeId === wanted)
    .sort((a, b) => {
      const [aLast, aName] = sortKey(a);
      const [bLast, bName] = sortKey(b);
      return (
        aLast.localeCompare(bLast, "de") ||
        aName.localeCompare(bName, "de") ||
        a.employeeId.localeCompare(b.employeeId)
      );
    });
}

interface HasIdAndCreation {
  id: string;
  createdAt: string;
}

/**
 * The list that feeds the Anträge tab for a status filter. An open request (`PENDING`, or a
 * requested cancellation) is never hidden by the year of the list: the open list of every year is
 * merged in, newest first. Every other filter - and „Alle“ - reads the year list.
 */
export function requestsForStatus<T extends HasIdAndCreation>(
  status: LeaveStatusFilter | null,
  yearList: readonly T[],
  openList: readonly T[],
): T[] {
  if (status !== "PENDING" && status !== "CANCELLATION_REQUESTED") return [...yearList];
  const byId = new Map<string, T>();
  for (const row of yearList) byId.set(row.id, row);
  for (const row of openList) byId.set(row.id, row);
  return [...byId.values()].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
}

/** The 1-based page of a list on which `id` sits, or `null` when it is not in the list. */
export function pageOfRequest(ids: readonly string[], id: string, pageSize: number): number | null {
  const index = ids.indexOf(id);
  if (index < 0 || pageSize < 1) return null;
  return Math.floor(index / pageSize) + 1;
}
