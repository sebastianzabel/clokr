// Issue #853 (D-853-14, D-853-18) - the pure model of Team › Personen: the rows of the read-only table,
// the one status decision, the filter, the sort and the count sentence. No request, no store: the page
// feeds it the answer of `GET /employees` (already narrowed to the caller's reach by the server, #547)
// and renders what comes out. Since the owner review the table shows no saldo (it stays in the person
// view and the reports); Stammsalon and the names of the stored roles come from the server.
import { employmentState } from "$lib/employees/employment-state";
import { scheduleModelLabel } from "$lib/employees/contract-history";
import { matchesSearch } from "$lib/table/search";
import type { ChipTone } from "$components/ui/chip-tone";

export type InvitationStatus = "ACCEPTED" | "PENDING" | "EXPIRED" | "NONE";

/** What the model reads of a `GET /employees` row. */
export interface PersonenEmployee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  exitDate?: string | null;
  user: { isActive: boolean };
  invitationStatus?: InvitationStatus;
  workSchedule?: { type: string; weeklyHours?: number | string | null } | null;
  /** The Stammsalon of today (#853, additive on `GET /employees`); null without one. */
  homeSalonId?: string | null;
  /** The names of the person's stored roles (#853, additive on `GET /employees`). */
  roleNames?: string[];
}

export type PersonStatusKind =
  "ACTIVE" | "EXIT_PLANNED" | "INVITED" | "INVITE_EXPIRED" | "DEACTIVATED" | "ENDED";

export interface PersonStatus {
  kind: PersonStatusKind;
  label: string;
  tone: ChipTone;
}

/** A type alias, not an interface: DataTable's row generic wants an index-signature-compatible type. */
export type PersonenRow = {
  id: string;
  name: string;
  /** „Nachname, Vorname“ - the sort key of the name column. */
  sortName: string;
  number: string;
  /** The schedule type code, "" without a contract. */
  model: string;
  modelLabel: string;
  /** Contractual hours per week; null when the contract carries none (e.g. monthly hours). */
  weeklyHours: number | null;
  /** The Stammsalon's id ("" without one) and its shown name ("–" when unknown). */
  salonId: string;
  salonName: string;
  /** The stored roles' names, „, “-joined; "–" without any. */
  roles: string;
  status: PersonStatusKind;
  statusLabel: string;
  statusTone: ChipTone;
  /** „Nachname, Vorname · Nr.“ - what the search matches. */
  searchText: string;
};

export interface PersonenFilter {
  q: string;
  status: "aktiv" | "alle";
  vertrag: string;
  /** A Stammsalon id; "" = every salon. */
  salon?: string;
}

export type PersonenSortKey = "name" | "salon" | "vertrag" | "stunden" | "status";

export interface PersonenSort {
  key: PersonenSortKey;
  dir: "asc" | "desc";
}

/** Sentinel set by the DSGVO anonymisation (CLAUDE.md): such a row is never listed. */
export function isAnonymizedPerson(person: { firstName: string; lastName: string }): boolean {
  return person.firstName === "Gelöscht" && person.lastName.startsWith("GELÖSCHT-");
}

/** The ONE decision of a person's status chip. `today` is a `YYYY-MM-DD` calendar day. */
export function personStatus(person: PersonenEmployee, today: string): PersonStatus {
  const employment = employmentState(person.exitDate, today);
  if (employment.kind === "ENDED")
    return { kind: "ENDED", label: "Ausgeschieden", tone: "neutral" };
  if (!person.user.isActive) {
    if (person.invitationStatus === "PENDING")
      return { kind: "INVITED", label: "Einladung offen", tone: "warn" };
    if (person.invitationStatus === "EXPIRED")
      return { kind: "INVITE_EXPIRED", label: "Einladung abgelaufen", tone: "warn" };
    return { kind: "DEACTIVATED", label: "Deaktiviert", tone: "neutral" };
  }
  if (employment.kind === "EXIT_PLANNED")
    return { kind: "EXIT_PLANNED", label: "Austritt geplant", tone: "info" };
  return { kind: "ACTIVE", label: "Aktiv", tone: "ok" };
}

/** The statuses the default filter „Aktiv“ lists: everyone still employed. */
const ACTIVE_KINDS: readonly PersonStatusKind[] = [
  "ACTIVE",
  "EXIT_PLANNED",
  "INVITED",
  "INVITE_EXPIRED",
];

/** The order of the status sort: working first, then waiting, then gone. */
const STATUS_RANK: Record<PersonStatusKind, number> = {
  ACTIVE: 0,
  EXIT_PLANNED: 1,
  INVITED: 2,
  INVITE_EXPIRED: 3,
  DEACTIVATED: 4,
  ENDED: 5,
};

function finiteNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Rows of the table; an anonymised person appears only when `includeAnonymized` is set (Verwalten ›
 * Personen, „Anonymisierte anzeigen“, #854 - the server returns such rows only to holders of
 * employee:anonymize). Team › Personen never sets it.
 */
export function personenRows(
  employees: readonly PersonenEmployee[],
  today: string,
  /** Display names of the salons the caller reaches, by id (the header's salon list). */
  salonNames: ReadonlyMap<string, string> = new Map(),
  options: { includeAnonymized?: boolean } = {},
): PersonenRow[] {
  return employees
    .filter((person) => options.includeAnonymized === true || !isAnonymizedPerson(person))
    .map((person) => {
      const status = personStatus(person, today);
      const salonId = person.homeSalonId ?? "";
      const roles = person.roleNames ?? [];
      const model = person.workSchedule?.type ?? "";
      const sortName = `${person.lastName}, ${person.firstName}`;
      return {
        id: person.id,
        name: `${person.firstName} ${person.lastName}`,
        sortName,
        number: person.employeeNumber,
        model,
        modelLabel: scheduleModelLabel(model),
        weeklyHours: finiteNumber(person.workSchedule?.weeklyHours),
        salonId,
        salonName: salonId === "" ? "–" : (salonNames.get(salonId) ?? "–"),
        roles: roles.length > 0 ? roles.join(", ") : "–",
        status: status.kind,
        statusLabel: status.label,
        statusTone: status.tone,
        searchText: `${sortName} · ${person.employeeNumber}`,
      };
    });
}

/** Search text, status (default: still employed) and Vertrag; a blank search matches everyone. */
export function filterPersonen(
  rows: readonly PersonenRow[],
  filter: PersonenFilter,
): PersonenRow[] {
  return rows.filter(
    (row) =>
      matchesSearch(row.searchText, filter.q) &&
      (filter.status === "alle" || ACTIVE_KINDS.includes(row.status)) &&
      (filter.vertrag === "" || row.model === filter.vertrag) &&
      (!filter.salon || row.salonId === filter.salon),
  );
}

const collator = new Intl.Collator("de");

function byName(a: PersonenRow, b: PersonenRow): number {
  return collator.compare(a.sortName, b.sortName) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * A new, sorted array. A missing value (no hours, no Stammsalon, no contract) sorts last in both
 * directions; ties fall back to the name and then the id, so the order is total and stable.
 */
export function sortPersonen(rows: readonly PersonenRow[], sort: PersonenSort): PersonenRow[] {
  const sign = sort.dir === "desc" ? -1 : 1;
  const numeric = (a: number | null, b: number | null): number => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return sign * (a - b);
  };
  const primary = (a: PersonenRow, b: PersonenRow): number => {
    switch (sort.key) {
      case "name":
        return sign * collator.compare(a.sortName, b.sortName);
      case "vertrag": {
        if (a.model === "" && b.model === "") return 0;
        if (a.model === "") return 1;
        if (b.model === "") return -1;
        return sign * collator.compare(a.modelLabel, b.modelLabel);
      }
      case "salon": {
        if (a.salonId === "" && b.salonId === "") return 0;
        if (a.salonId === "") return 1;
        if (b.salonId === "") return -1;
        return sign * collator.compare(a.salonName, b.salonName);
      }
      case "stunden":
        return numeric(a.weeklyHours, b.weeklyHours);
      case "status":
        return sign * (STATUS_RANK[a.status] - STATUS_RANK[b.status]);
    }
  };
  return [...rows].sort((a, b) => primary(a, b) || byName(a, b));
}

/** Persons who are still employed - what the head sentence counts, whatever the search says. */
export function activeCount(rows: readonly PersonenRow[]): number {
  return rows.filter((row) => ACTIVE_KINDS.includes(row.status)).length;
}

/** „8 aktive Personen“ / „1 aktive Person“, with „ in <Salon>“ while the header salon narrows. */
export function activeCountSentence(n: number, salonName?: string | null): string {
  const base = n === 1 ? "1 aktive Person" : `${n} aktive Personen`;
  return salonName ? `${base} in ${salonName}` : base;
}
