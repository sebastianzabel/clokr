// Issue #713 (D-03, D-10) - the pure decisions of the table "Abwesenheiten je Person": the column
// list by code, which columns the whole answer shows, the sort, the list line and the drill-down
// entries. The figures are the server's (Pattern 3); nothing here adds them up.
import { describe, it, expect } from "vitest";
import absenceTableSource from "../absence-table.ts?raw";
import {
  ABSENCE_COLUMNS,
  ABSENCE_UNIT_HINT,
  absenceEntryText,
  absenceListLine,
  firstAbsenceDirection,
  hiddenAbsenceColumns,
  nextAbsenceSort,
  personAbsenceEntries,
  sortAbsenceRows,
  visibleAbsenceColumns,
} from "../absence-table";
import { PERIOD_PERSON_ABSENCE_CODES, type PeriodRow } from "../period-report";

function zeroAbsence(): PeriodRow["absence"] {
  return Object.fromEntries(
    PERIOD_PERSON_ABSENCE_CODES.map((code) => [code, 0]),
  ) as PeriodRow["absence"];
}

/** Only the fields the pure module reads; the rest of a PeriodRow is irrelevant here. */
function row(
  id: string,
  absence: Partial<PeriodRow["absence"]> = {},
  name = `Person ${id}`,
): PeriodRow {
  return {
    employeeId: id,
    employeeName: name,
    employeeNumber: `N-${id}`,
    absence: { ...zeroAbsence(), ...absence },
  } as PeriodRow;
}

describe("ABSENCE_COLUMNS", () => {
  it("names the ten codes in the server's canonical order", () => {
    expect(ABSENCE_COLUMNS.map((c) => c.code)).toEqual([...PERIOD_PERSON_ABSENCE_CODES]);
  });

  it("carries the header texts of the copy deck, every header with its unit (D-03)", () => {
    expect(ABSENCE_COLUMNS.map((c) => c.header)).toEqual([
      "Krank (Kalendertage)",
      "Kinderkrank (Kalendertage)",
      "Urlaub (Arbeitstage)",
      "Überstundenausgleich (Arbeitstage)",
      "Sonderurlaub (Arbeitstage)",
      "Berufsschule (Tage)",
      "Bildungsurlaub (Arbeitstage)",
      "Unbezahlt (Arbeitstage)",
      "Mutterschutz (Arbeitstage)",
      "Elternzeit (Arbeitstage)",
    ]);
    for (const c of ABSENCE_COLUMNS) expect(c.header).toBe(`${c.label} (${c.unit})`);
  });

  it("counts the two sick kinds in Kalendertage, Berufsschule in Tage, the rest in Arbeitstage", () => {
    const unitOf = (code: string) => ABSENCE_COLUMNS.find((c) => c.code === code)?.unit;
    expect(unitOf("SICK")).toBe("Kalendertage");
    expect(unitOf("SICK_CHILD")).toBe("Kalendertage");
    expect(unitOf("VOCATIONAL_SCHOOL")).toBe("Tage");
    expect(unitOf("VACATION")).toBe("Arbeitstage");
    expect(unitOf("PARENTAL")).toBe("Arbeitstage");
  });
});

describe("visible and hidden columns", () => {
  it("keeps a column iff some row of the WHOLE answer has a value above 0", () => {
    const rows = [row("A", { SICK: 2 }), row("B", { VACATION: 1.5 }), row("C")];
    expect(visibleAbsenceColumns(rows).map((c) => c.code)).toEqual(["SICK", "VACATION"]);
    expect(hiddenAbsenceColumns(rows).map((c) => c.code)).toEqual([
      "SICK_CHILD",
      "OVERTIME_COMP",
      "SPECIAL",
      "VOCATIONAL_SCHOOL",
      "EDUCATION",
      "UNPAID",
      "MATERNITY",
      "PARENTAL",
    ]);
  });

  it("visible and hidden are a partition of the ten columns", () => {
    const rows = [row("A", { MATERNITY: 3, SICK_CHILD: 1 })];
    const visible = visibleAbsenceColumns(rows).map((c) => c.code);
    const hidden = hiddenAbsenceColumns(rows).map((c) => c.code);
    expect([...visible, ...hidden].sort((a, b) => a.localeCompare(b))).toEqual(
      [...PERIOD_PERSON_ABSENCE_CODES].sort((a, b) => a.localeCompare(b)),
    );
    expect(visible).toEqual(["SICK_CHILD", "MATERNITY"]);
  });

  it("shows nothing and hides everything when no row has an absence, also for no rows", () => {
    expect(visibleAbsenceColumns([row("A"), row("B")])).toEqual([]);
    expect(hiddenAbsenceColumns([row("A")])).toHaveLength(10);
    expect(visibleAbsenceColumns([])).toEqual([]);
  });
});

describe("sortAbsenceRows", () => {
  const rows = [
    row("1", { SICK: 2 }, "Zora"),
    row("2", { SICK: 5 }, "Änne"),
    row("3", { SICK: 2 }, "Anna"),
    row("4", {}, "Anna"),
  ];

  it("sorts by name with German collation and breaks ties by id", () => {
    expect(sortAbsenceRows(rows, "name", "asc").map((r) => r.employeeId)).toEqual([
      "3",
      "4",
      "2",
      "1",
    ]);
    // the id tie-break is ascending in either direction, like the Zeiten & Konten sort
    expect(sortAbsenceRows(rows, "name", "desc").map((r) => r.employeeId)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
  });

  it("sorts by a code's value, ties by name then id, in either direction", () => {
    expect(sortAbsenceRows(rows, "SICK", "desc").map((r) => r.employeeId)).toEqual([
      "2",
      "3",
      "1",
      "4",
    ]);
    expect(sortAbsenceRows(rows, "SICK", "asc").map((r) => r.employeeId)).toEqual([
      "4",
      "3",
      "1",
      "2",
    ]);
  });

  it("returns a copy and leaves its input alone", () => {
    const input = [...rows];
    const out = sortAbsenceRows(input, "SICK", "desc");
    expect(out).not.toBe(input);
    expect(input.map((r) => r.employeeId)).toEqual(["1", "2", "3", "4"]);
  });

  it("flips the same column and starts a figure descending, the name ascending", () => {
    expect(firstAbsenceDirection("name")).toBe("asc");
    expect(firstAbsenceDirection("VACATION")).toBe("desc");
    expect(nextAbsenceSort({ key: "name", dir: "asc" }, "name")).toEqual({
      key: "name",
      dir: "desc",
    });
    expect(nextAbsenceSort({ key: "name", dir: "asc" }, "SICK")).toEqual({
      key: "SICK",
      dir: "desc",
    });
    expect(nextAbsenceSort({ key: "SICK", dir: "desc" }, "SICK")).toEqual({
      key: "SICK",
      dir: "asc",
    });
    expect(nextAbsenceSort({ key: "SICK", dir: "asc" }, "name")).toEqual({
      key: "name",
      dir: "asc",
    });
  });
});

describe("absenceListLine", () => {
  const columns = visibleAbsenceColumns([row("X", { SICK: 1, SICK_CHILD: 1, VACATION: 1 })]);

  it("lists the visible kinds with a value above 0 in canonical order", () => {
    expect(absenceListLine(row("A", { SICK: 2, SICK_CHILD: 1 }), columns)).toBe(
      "Krank 2 · Kinderkrank 1",
    );
    expect(absenceListLine(row("A", { VACATION: 1.5, SICK: 3 }), columns)).toBe(
      "Krank 3 · Urlaub 1,5",
    );
  });

  it("says so when the person has none of the visible kinds", () => {
    expect(absenceListLine(row("A"), columns)).toBe("Keine Abwesenheiten");
    expect(absenceListLine(row("A", { MATERNITY: 4 }), columns)).toBe("Keine Abwesenheiten");
  });
});

describe("personAbsenceEntries and absenceEntryText", () => {
  it("returns the non-zero kinds with label, value and unit in canonical order", () => {
    expect(
      personAbsenceEntries(row("A", { VACATION: 1.5, SICK: 2, VOCATIONAL_SCHOOL: 1 })),
    ).toEqual([
      { label: "Krank", value: 2, unit: "Kalendertage" },
      { label: "Urlaub", value: 1.5, unit: "Arbeitstage" },
      { label: "Berufsschule", value: 1, unit: "Tage" },
    ]);
    expect(personAbsenceEntries(row("A"))).toEqual([]);
  });

  it("words an entry with the singular for exactly 1 and never with a date", () => {
    const text = (code: keyof PeriodRow["absence"], value: number) =>
      absenceEntryText(personAbsenceEntries(row("A", { [code]: value }))[0]);
    expect(text("SICK", 2)).toBe("Krank: 2 Kalendertage");
    expect(text("SICK_CHILD", 1)).toBe("Kinderkrank: 1 Kalendertag");
    expect(text("VOCATIONAL_SCHOOL", 1)).toBe("Berufsschule: 1 Tag");
    expect(text("VACATION", 1.5)).toBe("Urlaub: 1,5 Arbeitstage");
    expect(text("VACATION", 1)).toBe("Urlaub: 1 Arbeitstag");
  });
});

describe("ABSENCE_UNIT_HINT and the module's rules", () => {
  it("names the units and the § 45 SGB V / DATEV difference (D-03)", () => {
    expect(ABSENCE_UNIT_HINT).toBe(
      "Krank und Kinderkrank in Kalendertagen (mit Wochenende), Berufsschule in Schultagen, alle anderen Arten in Arbeitstagen. Das Kinderkrankengeld der Krankenkasse zählt Arbeitstage – Monatsexport und DATEV zeigen deshalb Arbeitstage.",
    );
  });

  it("is a pure module: no summing, no Svelte, no fetch, no store, no date", () => {
    expect(absenceTableSource.length).toBeGreaterThan(500);
    expect(absenceTableSource).not.toMatch(/\.reduce\(/);
    expect(absenceTableSource).not.toMatch(/from "svelte|\$app|\$api|\$stores|fetch\(|new Date\(/);
  });
});
