// Issue #853 (D-853-14) - the pure model of Team › Personen.
import { describe, expect, it } from "vitest";
import {
  activeCount,
  activeCountSentence,
  filterPersonen,
  personenRows,
  personStatus,
  sortPersonen,
  type PersonenEmployee,
  type PersonenRow,
} from "../personen-model";
import { parseUrlState } from "$lib/table/url-state";
import { personenUrlSchema } from "../personen-url-state";
import { scheduleModelLabel } from "$lib/employees/contract-history";

const TODAY = "2026-11-12";

function employee(over: Partial<PersonenEmployee> & { id: string }): PersonenEmployee {
  return {
    employeeNumber: "P-001",
    firstName: "Mia",
    lastName: "Friseurin",
    exitDate: null,
    user: { isActive: true },
    invitationStatus: "ACCEPTED",
    workSchedule: { type: "FIXED_SCHEDULE", weeklyHours: "32.00" },
    overtimeAccount: { balanceHours: "1.50" },
    ...over,
  };
}

const ROSTER: PersonenEmployee[] = [
  employee({ id: "a", firstName: "Anton", lastName: "Sauber", employeeNumber: "UAT-A01" }),
  employee({
    id: "b",
    firstName: "Berta",
    lastName: "Abschluss",
    employeeNumber: "UAT-B01",
    user: { isActive: false },
    invitationStatus: "PENDING",
    workSchedule: { type: "SHIFT_BASED", weeklyHours: "40" },
    overtimeAccount: { balanceHours: "-2" },
  }),
  employee({
    id: "c",
    firstName: "Cem",
    lastName: "Konflikt",
    employeeNumber: "UAT-C01",
    workSchedule: { type: "MONTHLY_HOURS", weeklyHours: null },
    overtimeAccount: { balanceHours: null },
  }),
  employee({
    id: "d",
    firstName: "Dora",
    lastName: "Gegangen",
    employeeNumber: "P-009",
    exitDate: "2026-06-30",
    workSchedule: null,
    overtimeAccount: null,
  }),
];

function rows(): PersonenRow[] {
  return personenRows(ROSTER, TODAY);
}
const ids = (list: PersonenRow[]) => list.map((r) => r.id);

describe("personenRows", () => {
  it("maps a GET /employees row to the table row", () => {
    const row = rows()[0];
    expect(row).toMatchObject({
      id: "a",
      name: "Anton Sauber",
      sortName: "Sauber, Anton",
      number: "UAT-A01",
      model: "FIXED_SCHEDULE",
      modelLabel: "Feste Arbeitszeit",
      weeklyHours: 32,
      balanceMinutes: 90,
      status: "ACTIVE",
      statusLabel: "Aktiv",
      statusTone: "ok",
      searchText: "Sauber, Anton · UAT-A01",
    });
  });

  it("keeps a masked saldo and a missing contract as null / dash, never as zero", () => {
    const [, , c, d] = rows();
    expect(c.balanceMinutes).toBeNull();
    expect(c.weeklyHours).toBeNull();
    expect(d.balanceMinutes).toBeNull();
    expect(d.model).toBe("");
    expect(d.modelLabel).toBe("–");
  });

  it("never lists an anonymised person", () => {
    const list = personenRows(
      [...ROSTER, employee({ id: "x", firstName: "Gelöscht", lastName: "GELÖSCHT-P-007" })],
      TODAY,
    );
    expect(ids(list)).not.toContain("x");
    expect(list).toHaveLength(ROSTER.length);
  });

  it("reads the model label from the contract-history table", () => {
    expect(scheduleModelLabel("SHIFT_BASED")).toBe("Nach Schichtplan");
    expect(scheduleModelLabel("toString")).toBe("–");
    expect(scheduleModelLabel(null)).toBe("–");
  });
});

describe("personStatus", () => {
  const base = employee({ id: "s" });
  it("Aktiv for a signed-in, employed person", () => {
    expect(personStatus(base, TODAY)).toEqual({ kind: "ACTIVE", label: "Aktiv", tone: "ok" });
  });
  it("Einladung offen / abgelaufen while the login is not active", () => {
    const off = { ...base, user: { isActive: false } };
    expect(personStatus({ ...off, invitationStatus: "PENDING" }, TODAY)).toMatchObject({
      kind: "INVITED",
      label: "Einladung offen",
      tone: "warn",
    });
    expect(personStatus({ ...off, invitationStatus: "EXPIRED" }, TODAY)).toMatchObject({
      kind: "INVITE_EXPIRED",
      label: "Einladung abgelaufen",
      tone: "warn",
    });
  });
  it("Deaktiviert for an inactive login without a pending invitation", () => {
    expect(
      personStatus({ ...base, user: { isActive: false }, invitationStatus: "NONE" }, TODAY),
    ).toMatchObject({ kind: "DEACTIVATED", label: "Deaktiviert", tone: "neutral" });
  });
  it("Austritt geplant for today or a future exit day", () => {
    expect(personStatus({ ...base, exitDate: "2026-11-12" }, TODAY)).toMatchObject({
      kind: "EXIT_PLANNED",
      tone: "info",
    });
    expect(personStatus({ ...base, exitDate: "2027-01-31T00:00:00.000Z" }, TODAY).kind).toBe(
      "EXIT_PLANNED",
    );
  });
  it("Ausgeschieden once the exit day is past, whatever the login says", () => {
    expect(personStatus({ ...base, exitDate: "2026-11-11" }, TODAY)).toMatchObject({
      kind: "ENDED",
      label: "Ausgeschieden",
      tone: "neutral",
    });
    expect(
      personStatus({ ...base, exitDate: "2026-01-01", user: { isActive: false } }, TODAY).kind,
    ).toBe("ENDED");
  });
});

describe("filterPersonen", () => {
  const none = { q: "", status: "aktiv" as const, vertrag: "" };
  it("defaults to everyone still employed (Aktiv, invited, exit planned)", () => {
    expect(ids(filterPersonen(rows(), none))).toEqual(["a", "b", "c"]);
  });
  it("status alle lists everyone, the ended person included", () => {
    expect(ids(filterPersonen(rows(), { ...none, status: "alle" }))).toEqual(["a", "b", "c", "d"]);
  });
  it("searches the name case-insensitively", () => {
    expect(ids(filterPersonen(rows(), { ...none, q: "KONFLIKT" }))).toEqual(["c"]);
    expect(ids(filterPersonen(rows(), { ...none, q: "anton" }))).toEqual(["a"]);
  });
  it("searches the Personalnummer", () => {
    expect(ids(filterPersonen(rows(), { ...none, q: "uat-b01" }))).toEqual(["b"]);
    expect(ids(filterPersonen(rows(), { ...none, status: "alle", q: "P-009" }))).toEqual(["d"]);
  });
  it("filters by Vertrag", () => {
    expect(ids(filterPersonen(rows(), { ...none, vertrag: "SHIFT_BASED" }))).toEqual(["b"]);
    expect(ids(filterPersonen(rows(), { ...none, status: "alle", vertrag: "" }))).toHaveLength(4);
  });
  it("combines search, status and Vertrag", () => {
    expect(
      ids(filterPersonen(rows(), { q: "uat", status: "aktiv", vertrag: "FIXED_SCHEDULE" })),
    ).toEqual(["a"]);
  });
});

describe("sortPersonen", () => {
  const sorted = (key: Parameters<typeof sortPersonen>[1]["key"], dir: "asc" | "desc") =>
    ids(sortPersonen(rows(), { key, dir }));
  it("name: German collation by „Nachname, Vorname“, both directions", () => {
    // Abschluss, Gegangen, Konflikt, Sauber
    expect(sorted("name", "asc")).toEqual(["b", "d", "c", "a"]);
    expect(sorted("name", "desc")).toEqual(["a", "c", "d", "b"]);
  });
  it("vertrag: by label, no contract last in both directions", () => {
    expect(sorted("vertrag", "asc")).toEqual(["a", "c", "b", "d"]);
    expect(sorted("vertrag", "desc")).toEqual(["b", "c", "a", "d"]);
  });
  it("stunden: missing hours last in both directions", () => {
    expect(sorted("stunden", "asc")).toEqual(["a", "b", "d", "c"]);
    expect(sorted("stunden", "desc")).toEqual(["b", "a", "d", "c"]);
  });
  it("saldo: unreadable saldo last in both directions", () => {
    expect(sorted("saldo", "asc")).toEqual(["b", "a", "d", "c"]);
    expect(sorted("saldo", "desc")).toEqual(["a", "b", "d", "c"]);
  });
  it("status: working first, then waiting, then gone, both directions", () => {
    expect(sorted("status", "asc")).toEqual(["c", "a", "b", "d"]);
    expect(sorted("status", "desc")).toEqual(["d", "b", "c", "a"]);
  });
  it("breaks a tie by name and then by id, and does not mutate its input", () => {
    const twins = personenRows(
      [
        employee({ id: "z2", firstName: "Eva", lastName: "Gleich" }),
        employee({ id: "z1", firstName: "Eva", lastName: "Gleich" }),
      ],
      TODAY,
    );
    const copy = [...twins];
    expect(ids(sortPersonen(twins, { key: "name", dir: "asc" }))).toEqual(["z1", "z2"]);
    expect(ids(sortPersonen(twins, { key: "saldo", dir: "desc" }))).toEqual(["z1", "z2"]);
    expect(twins).toEqual(copy);
  });
});

describe("activeCountSentence", () => {
  it("counts the persons still employed", () => {
    expect(activeCount(rows())).toBe(3);
  });
  it("words the count with and without a salon", () => {
    expect(activeCountSentence(8)).toBe("8 aktive Personen");
    expect(activeCountSentence(1)).toBe("1 aktive Person");
    expect(activeCountSentence(0)).toBe("0 aktive Personen");
    expect(activeCountSentence(8, "Clokr Demo Nord")).toBe("8 aktive Personen in Clokr Demo Nord");
    expect(activeCountSentence(8, null)).toBe("8 aktive Personen");
  });
});

describe("personenUrlSchema", () => {
  const parse = (query: string) => parseUrlState(personenUrlSchema, new URLSearchParams(query));
  it("defaults when the URL is empty", () => {
    expect(parse("")).toEqual({ q: "", status: "aktiv", vertrag: "", sort: "name", dir: "asc" });
  });
  it("reads allowed values", () => {
    expect(parse("q=Anton&status=alle&vertrag=FLEXTIME&sort=saldo&dir=desc")).toEqual({
      q: "Anton",
      status: "alle",
      vertrag: "FLEXTIME",
      sort: "saldo",
      dir: "desc",
    });
  });
  it("falls back to the default for an unknown value", () => {
    expect(parse("status=x&vertrag=ADMIN&sort=email&dir=up")).toEqual({
      q: "",
      status: "aktiv",
      vertrag: "",
      sort: "name",
      dir: "asc",
    });
  });
  it("cuts the search text at 80 characters", () => {
    expect(parse(`q=${"a".repeat(200)}`).q).toHaveLength(80);
  });
});
