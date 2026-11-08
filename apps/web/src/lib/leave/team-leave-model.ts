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

/**
 * One meaning of „Offen“ (Issue #840 G-1): every request that waits for a decision, `PENDING` and
 * a requested cancellation, the same meaning as the Inbox tab „Offen“. Every other filter is an
 * equality; `null` is „Alle“. The Anträge list filters through this, so the list shows exactly what
 * the open count counted.
 */
export function matchesStatusFilter(status: string, filter: LeaveStatusFilter | null): boolean {
  if (filter === null) return true;
  if (filter === "PENDING") return status === "PENDING" || status === "CANCELLATION_REQUESTED";
  return status === filter;
}

/**
 * The open count of the Anträge tab with its explanation (Issue #840 G-1), or `null` when nothing
 * waits for a decision. The label is display text only (title and screen-reader text of the count)
 * and is never compared.
 */
export function openRequestsSummary(
  rows: ReadonlyArray<{ status: string }>,
): { count: number; label: string } | null {
  let requests = 0;
  let cancellations = 0;
  for (const row of rows) {
    if (row.status === "PENDING") requests++;
    else if (row.status === "CANCELLATION_REQUESTED") cancellations++;
  }
  const count = requests + cancellations;
  if (count === 0) return null;
  const parts: string[] = [];
  if (requests > 0) parts.push(requests === 1 ? "1 Antrag" : `${requests} Anträge`);
  if (cancellations > 0) {
    parts.push(cancellations === 1 ? "1 Storno angefragt" : `${cancellations} Stornos angefragt`);
  }
  return { count, label: `${count} offen: ${parts.join(", ")}` };
}

/** The 1-based page of a list on which `id` sits, or `null` when it is not in the list. */
export function pageOfRequest(ids: readonly string[], id: string, pageSize: number): number | null {
  const index = ids.indexOf(id);
  if (index < 0 || pageSize < 1) return null;
  return Math.floor(index / pageSize) + 1;
}

/** Where a deep-linked request (`/team/leave?request=<id>`) sits among the lists the page has loaded. */
export type DeepLinkedRequest =
  { kind: "year" } | { kind: "open"; startDate: string } | { kind: "missing" };

/**
 * Finds the request of a `/team/leave?request=` link (review WR-05): in the year list the page shows,
 * else in the open list of every year (the all-years PENDING read), else not at all. The link carries
 * no year (the attendance reminders and the shift adjustments write it that way and are deduped by
 * the link string), so an open request filed in November for January is found by id, not by year.
 */
export function locateDeepLinkedRequest<T extends { id: string; startDate: string }>(
  id: string,
  yearList: readonly T[],
  openList: readonly T[],
): DeepLinkedRequest {
  if (yearList.some((row) => row.id === id)) return { kind: "year" };
  const open = openList.find((row) => row.id === id);
  if (open) return { kind: "open", startDate: open.startDate.slice(0, 10) };
  return { kind: "missing" };
}

/**
 * The empty state of the Anträge list (review IN-03). A filter that hides every row of a non-empty
 * list is named as such, and the open filters read all years, so they never name the list year.
 */
export function emptyRequestsText(
  status: LeaveStatusFilter | null,
  listYear: number,
  sourceCount: number,
): { title: string; hint: string } {
  if (sourceCount > 0) {
    return { title: "Keine Anträge für diese Auswahl.", hint: "Passe die Filter an." };
  }
  if (status === "PENDING") {
    return {
      title: "Keine offenen Anträge.",
      hint: "Es wartet gerade nichts auf eine Entscheidung.",
    };
  }
  if (status === "CANCELLATION_REQUESTED") {
    return {
      title: "Keine Stornoanfragen.",
      hint: "Es wartet gerade nichts auf eine Entscheidung.",
    };
  }
  return {
    title: `Keine Anträge in ${listYear}.`,
    hint: "Wähle ein anderes Jahr oder lege einen neuen Antrag an.",
  };
}
