// Issue #713 (D-03, D-08, D-10) - the section „Abwesenheiten je Person“, mounted. Since Issue #854 it
// is a DataTable under a TableToolbar; the columns, the hidden empty columns, the hints, the sort,
// the search and the states are proven here. Pattern 3: the component formats the server's
// `rows[].absence`; no figure is derived.

import { describe, it, expect, vi } from "vitest";

// The page-scope module reaches the api client and its auth store (localStorage bootstrap); a
// stand-in keeps this mounted test free of it (as in TimesAccountsTable.test.ts).
vi.mock("$api/client", () => ({
  api: { get: vi.fn() },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message = "err",
    ) {
      super(message);
    }
  },
}));
vi.mock("$lib/utils/logger", () => ({ clientLogger: { warn: vi.fn(), error: vi.fn() } }));
import { screen, fireEvent, within } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { ABSENCE_UNIT_HINT } from "$lib/reports/absence-table";
import { PERIOD_PERSON_ABSENCE_CODES, type PeriodRow } from "$lib/reports/period-report";
import {
  PERSON_VALUES_NOT_SPLIT_LABEL,
  SALON_PERIOD_END_PERSONS_NOTE,
} from "$lib/salons/page-scope";
import AbsencesByPersonTable from "../AbsencesByPersonTable.svelte";
import source from "../AbsencesByPersonTable.svelte?raw";

function zeroAbsence(): PeriodRow["absence"] {
  return Object.fromEntries(
    PERIOD_PERSON_ABSENCE_CODES.map((code) => [code, 0]),
  ) as PeriodRow["absence"];
}

/** A row with only the fields the table reads; the rest of a PeriodRow is irrelevant here. */
function row(
  id: string,
  absence: Partial<PeriodRow["absence"]> = {},
  extra: Partial<PeriodRow> = {},
): PeriodRow {
  return {
    employeeId: id,
    employeeName: `Person ${id}`,
    employeeNumber: `N-${id}`,
    absence: { ...zeroAbsence(), ...absence },
    ...extra,
  } as PeriodRow;
}

function props(rows: PeriodRow[] | null, overrides: Record<string, unknown> = {}) {
  return {
    rows,
    loading: false,
    periodLabel: "Jul – Sep 2026",
    filterActive: false,
    personHref: (r: PeriodRow) => `/reports?person=${r.employeeId}`,
    onOpenPerson: vi.fn(),
    ...overrides,
  };
}

const headers = () =>
  screen.getAllByRole("columnheader").map((h) => h.textContent?.replace(/[▲▼]/g, "").trim());
const bodyRows = () => within(screen.getAllByRole("rowgroup")[1]).getAllByRole("row");
const names = () => bodyRows().map((r) => within(r).getByRole("link").textContent?.trim());

const MIXED = [
  row("A", { SICK: 2, SICK_CHILD: 1, VACATION: 1.5 }, { employeeName: "Anna" }),
  row("B", { SICK: 5, VOCATIONAL_SCHOOL: 4 }, { employeeName: "Bernd" }),
  row("C", {}, { employeeName: "Carla" }),
];

describe("AbsencesByPersonTable - columns and cells (wide)", () => {
  it("shows the heading with the period and one row per person", () => {
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    expect(screen.getByText("Abwesenheiten je Person")).toBeInTheDocument();
    expect(screen.getByText("Jul – Sep 2026")).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(3);
    expect(screen.getByRole("table")).toHaveAccessibleName(
      "Abwesenheiten je Person, Jul – Sep 2026",
    );
  });

  it("renders only the columns with a value in the whole answer, each header with its unit", () => {
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    expect(headers()).toEqual([
      "Person",
      "Krank (Kalendertage)",
      "Kinderkrank (Kalendertage)",
      "Urlaub (Arbeitstage)",
      "Berufsschule (Tage)",
    ]);
  });

  it("formats the server's values with the day format, a zero as 0, nothing summed", () => {
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    const cells = (r: HTMLElement) =>
      within(r)
        .getAllByRole("cell")
        .slice(1)
        .map((c) => c.textContent?.trim());
    expect(cells(bodyRows()[0])).toEqual(["2", "1", "1,5", "0"]);
    expect(cells(bodyRows()[1])).toEqual(["5", "0", "0", "4"]);
    expect(cells(bodyRows()[2])).toEqual(["0", "0", "0", "0"]);
  });

  it("the person cell holds the name link and the personnel number", () => {
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    const cell = within(bodyRows()[0]).getAllByRole("cell")[0];
    expect(within(cell).getByRole("link", { name: "Anna" })).toHaveAttribute(
      "href",
      "/reports?person=A",
    );
    expect(cell).toHaveTextContent("N-A");
  });

  it("a column that is 0 for every row of the answer stays hidden, however the page or the search narrows", async () => {
    // 30 people: the only Kinderkrank value sits on page 2, so a decision per page would drop it
    const rows = Array.from({ length: 30 }, (_, i) =>
      row(String(i).padStart(2, "0"), i === 29 ? { SICK_CHILD: 3 } : { SICK: 1 }),
    );
    renderWithTheme(AbsencesByPersonTable, props(rows));
    expect(headers()).toContain("Kinderkrank (Kalendertage)");
    expect(bodyRows()).toHaveLength(25);
    // a search that leaves only people without Kinderkrank keeps the column as well
    await fireEvent.input(screen.getByLabelText("Name oder Personalnummer suchen"), {
      target: { value: "Person 00" },
    });
    expect(bodyRows()).toHaveLength(1);
    expect(headers()).toContain("Kinderkrank (Kalendertage)");
  });

  it("names the hidden kinds in a hint, and has none when every kind has a value", () => {
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    const hint = screen.getByTestId("absence-hidden-hint");
    expect(hint).toHaveTextContent(
      "Ohne Einträge im Zeitraum: Überstundenausgleich, Sonderurlaub, Bildungsurlaub, Unbezahlt, Mutterschutz, Elternzeit",
    );
  });

  it("shows no hidden-kinds hint when no kind is hidden", () => {
    const all = Object.fromEntries(PERIOD_PERSON_ABSENCE_CODES.map((c) => [c, 1]));
    renderWithTheme(AbsencesByPersonTable, props([row("A", all)]));
    expect(screen.queryByTestId("absence-hidden-hint")).toBeNull();
    expect(headers()).toHaveLength(11);
  });

  it("carries the unit hint near the table (the Kinderkrankengeld counts Arbeitstage)", () => {
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    expect(screen.getByTestId("absence-unit-hint")).toHaveTextContent(ABSENCE_UNIT_HINT);
    expect(screen.getByTestId("absence-unit-hint")).toHaveTextContent("Kinderkrankengeld");
  });
});

describe("AbsencesByPersonTable - states", () => {
  it("without an answer: the skeleton while loading, nothing otherwise", () => {
    const { unmount } = renderWithTheme(AbsencesByPersonTable, props(null, { loading: true }));
    expect(screen.getByTestId("absence-skeleton")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    unmount();
    renderWithTheme(AbsencesByPersonTable, props(null, { loading: false }));
    expect(screen.queryByTestId("absence-skeleton")).toBeNull();
  });

  it("no persons in the period: the empty state, no search bar", () => {
    renderWithTheme(AbsencesByPersonTable, props([]));
    expect(screen.getByText("Keine Personen im Zeitraum")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByLabelText("Name oder Personalnummer suchen")).toBeNull();
  });

  it("every column empty: the calm line and no table", () => {
    renderWithTheme(AbsencesByPersonTable, props([row("A"), row("B")]));
    expect(screen.getByText("Keine Abwesenheiten im Zeitraum.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByTestId("absence-hidden-hint")).toBeNull();
  });

  it("under a salon filter the card carries the note and keeps columns and values (D-08)", () => {
    const unfiltered = renderWithTheme(AbsencesByPersonTable, props(MIXED));
    const columnsBefore = headers();
    const valuesBefore = bodyRows().map((r) => r.textContent);
    expect(screen.queryByTestId("absence-salon-note")).toBeNull();
    unfiltered.unmount();
    renderWithTheme(AbsencesByPersonTable, props(MIXED, { filterActive: true }));
    expect(screen.getByTestId("absence-salon-note")).toHaveTextContent(
      `${SALON_PERIOD_END_PERSONS_NOTE} · ${PERSON_VALUES_NOT_SPLIT_LABEL}`,
    );
    expect(headers()).toEqual(columnsBefore);
    expect(bodyRows().map((r) => r.textContent)).toEqual(valuesBefore);
  });
});

describe("AbsencesByPersonTable - sort", () => {
  it("starts with Person ascending (German collation) and says so in aria-sort", () => {
    renderWithTheme(
      AbsencesByPersonTable,
      props([
        row("1", { SICK: 1 }, { employeeName: "Zoe" }),
        row("2", { SICK: 1 }, { employeeName: "Äpfel" }),
        row("3", { SICK: 1 }, { employeeName: "Anna" }),
      ]),
    );
    expect(names()).toEqual(["Anna", "Äpfel", "Zoe"]);
    expect(screen.getByRole("columnheader", { name: /Person/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(screen.getByRole("columnheader", { name: /Krank \(Kalendertage\)/ })).toHaveAttribute(
      "aria-sort",
      "none",
    );
  });

  it("a click on a kind sorts descending, again ascending; ties fall back to the name", async () => {
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    const header = () => screen.getByRole("columnheader", { name: /^Krank \(Kalendertage\)/ });
    await fireEvent.click(within(header()).getByRole("button"));
    expect(names()).toEqual(["Bernd", "Anna", "Carla"]);
    expect(header()).toHaveAttribute("aria-sort", "descending");
    await fireEvent.click(within(header()).getByRole("button"));
    expect(names()).toEqual(["Carla", "Anna", "Bernd"]);
    expect(header()).toHaveAttribute("aria-sort", "ascending");
  });

  it("a click on Person again flips to descending", async () => {
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    await fireEvent.click(
      within(screen.getByRole("columnheader", { name: /Person/ })).getByRole("button"),
    );
    expect(names()).toEqual(["Carla", "Bernd", "Anna"]);
  });
});

describe("AbsencesByPersonTable - search, count, paging", () => {
  it("filters on name and personnel number, case-insensitively, and counts persons", async () => {
    renderWithTheme(
      AbsencesByPersonTable,
      props([
        row("1", { SICK: 1 }, { employeeName: "Anna Berg", employeeNumber: "0042" }),
        row("2", { SICK: 1 }, { employeeName: "Bert Anders", employeeNumber: "0100" }),
        row("3", { SICK: 1 }, { employeeName: "Carla", employeeNumber: "0200" }),
      ]),
    );
    expect(screen.getByText("3 von 3")).toBeInTheDocument();
    const search = screen.getByLabelText("Name oder Personalnummer suchen");
    await fireEvent.input(search, { target: { value: "ANNA" } });
    expect(names()).toEqual(["Anna Berg"]);
    expect(screen.getByText("1 von 3")).toBeInTheDocument();
    await fireEvent.input(search, { target: { value: "0100" } });
    expect(names()).toEqual(["Bert Anders"]);
  });

  it("no hit: the empty state with a reset action", async () => {
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    await fireEvent.input(screen.getByLabelText("Name oder Personalnummer suchen"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("Keine Treffer")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    // The toolbar and the empty state each offer the reset; both run the same one.
    const resets = screen.getAllByRole("button", { name: "Filter zurücksetzen" });
    expect(resets).toHaveLength(2);
    await fireEvent.click(resets[1]);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("pages in steps of 25 over the searched and sorted rows; a new search returns to page 1", async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row(
        String(i).padStart(2, "0"),
        { SICK: 1 },
        { employeeName: `P ${String(i).padStart(2, "0")}` },
      ),
    );
    renderWithTheme(AbsencesByPersonTable, props(rows));
    expect(bodyRows()).toHaveLength(25);
    await fireEvent.click(screen.getByRole("button", { name: /nächste/i }));
    expect(names()[0]).toBe("P 25");
    await fireEvent.input(screen.getByLabelText("Name oder Personalnummer suchen"), {
      target: { value: "P 0" },
    });
    expect(names()[0]).toBe("P 00");
  });
});

describe("AbsencesByPersonTable - opening a person", () => {
  it("hands a click on the name link to onOpenPerson with the event and the row, once", async () => {
    const onOpenPerson = vi.fn<(e: MouseEvent, r: PeriodRow) => void>((e) => e.preventDefault());
    renderWithTheme(AbsencesByPersonTable, props(MIXED, { onOpenPerson }));
    await fireEvent.click(screen.getByRole("link", { name: "Anna" }));
    expect(onOpenPerson).toHaveBeenCalledTimes(1);
    expect(onOpenPerson.mock.calls[0][0]).toBeInstanceOf(MouseEvent);
    expect(onOpenPerson.mock.calls[0][1]).toMatchObject({ employeeId: "A" });
  });

  it("only the name link opens a person: a click on a figure cell does not", async () => {
    const onOpenPerson = vi.fn((e: MouseEvent) => e.preventDefault());
    renderWithTheme(AbsencesByPersonTable, props(MIXED, { onOpenPerson }));
    await fireEvent.click(within(bodyRows()[0]).getAllByRole("cell")[1]);
    expect(onOpenPerson).not.toHaveBeenCalled();
  });
});

describe("AbsencesByPersonTable - narrow containers", () => {
  it("is one table DOM at every width: the cells carry their column label for the card layout", () => {
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    expect(screen.getAllByRole("table")).toHaveLength(1);
    const labels = Array.from(bodyRows()[0].querySelectorAll("td")).map((td) =>
      td.getAttribute("data-label"),
    );
    expect(labels).toEqual([
      "Person",
      "Krank (Kalendertage)",
      "Kinderkrank (Kalendertage)",
      "Urlaub (Arbeitstage)",
      "Berufsschule (Tage)",
    ]);
  });

  it("the name link is the only link of a row and nests no control", () => {
    const { container } = renderWithTheme(AbsencesByPersonTable, props(MIXED));
    expect(within(bodyRows()[0]).getAllByRole("link")).toHaveLength(1);
    expect(container.querySelectorAll("a button, button button, a a, button a")).toHaveLength(0);
  });
});

describe("AbsencesByPersonTable - source rules (T-713-15)", () => {
  it("sums nothing and reaches no API, route or store", () => {
    expect(source.length).toBeGreaterThan(1000);
    expect(source).not.toMatch(/\.reduce\(/);
    expect(source).not.toMatch(/\$app\//);
    expect(source).not.toMatch(/\$api\/|\$stores\/|fetch\(/);
    // values are compared and formatted only: no arithmetic on a per-code figure
    expect(source).not.toMatch(/absence\[[^\]]+\]\s*[-+*/]/);
  });
});
