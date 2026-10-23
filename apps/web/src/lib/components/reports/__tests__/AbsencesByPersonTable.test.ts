// Issue #713 (D-03, D-08, D-10) - the card „Abwesenheiten je Person“, mounted. lib/components/reports/
// is outside the lint:ui-classes gate (CLAUDE.md), so the columns, the hidden empty columns, the
// hints, the sort, the search, the states and the narrow list are proven here. Pattern 3: the
// component formats the server's `rows[].absence`; no figure is derived.

import { describe, it, expect, vi, afterEach } from "vitest";

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

/** Stub `matchMedia` so the component sees a narrow (≤ 960 px) or a wide viewport. */
function viewport(narrow: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: narrow && query.includes("960"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    viewport(false);
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    expect(screen.getByText("Abwesenheiten je Person")).toBeInTheDocument();
    expect(screen.getByText("Jul – Sep 2026")).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(3);
    expect(screen.getByRole("table")).toHaveAccessibleName(
      "Abwesenheiten je Person, Jul – Sep 2026",
    );
  });

  it("renders only the columns with a value in the whole answer, each header with its unit", () => {
    viewport(false);
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
    viewport(false);
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    const cells = (r: HTMLElement) =>
      within(r)
        .getAllByRole("cell")
        .map((c) => c.textContent?.trim());
    expect(cells(bodyRows()[0])).toEqual(["2", "1", "1,5", "0"]);
    expect(cells(bodyRows()[1])).toEqual(["5", "0", "0", "4"]);
    expect(cells(bodyRows()[2])).toEqual(["0", "0", "0", "0"]);
  });

  it("the person cell is a row header with the name link and the personnel number", () => {
    viewport(false);
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    const cell = within(bodyRows()[0]).getByRole("rowheader");
    expect(within(cell).getByRole("link", { name: "Anna" })).toHaveAttribute(
      "href",
      "/reports?person=A",
    );
    expect(cell).toHaveTextContent("N-A");
  });

  it("a column that is 0 for every row of the answer stays hidden, however the page or the search narrows", async () => {
    viewport(false);
    // 30 people: the only Kinderkrank value sits on page 2, so a decision per page would drop it
    const rows = Array.from({ length: 30 }, (_, i) =>
      row(String(i).padStart(2, "0"), i === 29 ? { SICK_CHILD: 3 } : { SICK: 1 }),
    );
    renderWithTheme(AbsencesByPersonTable, props(rows));
    expect(headers()).toContain("Kinderkrank (Kalendertage)");
    expect(bodyRows()).toHaveLength(25);
    // a search that leaves only people without Kinderkrank keeps the column as well
    await fireEvent.input(screen.getByLabelText("Person suchen"), {
      target: { value: "Person 00" },
    });
    expect(bodyRows()).toHaveLength(1);
    expect(headers()).toContain("Kinderkrank (Kalendertage)");
  });

  it("names the hidden kinds in a hint, and has none when every kind has a value", () => {
    viewport(false);
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    const hint = screen.getByTestId("absence-hidden-hint");
    expect(hint).toHaveTextContent(
      "Ohne Einträge im Zeitraum: Überstundenausgleich, Sonderurlaub, Bildungsurlaub, Unbezahlt, Mutterschutz, Elternzeit",
    );
  });

  it("shows no hidden-kinds hint when no kind is hidden", () => {
    viewport(false);
    const all = Object.fromEntries(PERIOD_PERSON_ABSENCE_CODES.map((c) => [c, 1]));
    renderWithTheme(AbsencesByPersonTable, props([row("A", all)]));
    expect(screen.queryByTestId("absence-hidden-hint")).toBeNull();
    expect(headers()).toHaveLength(11);
  });

  it("carries the unit hint near the table (the Kinderkrankengeld counts Arbeitstage)", () => {
    viewport(false);
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    expect(screen.getByTestId("absence-unit-hint")).toHaveTextContent(ABSENCE_UNIT_HINT);
    expect(screen.getByTestId("absence-unit-hint")).toHaveTextContent("Kinderkrankengeld");
  });
});

describe("AbsencesByPersonTable - states", () => {
  it("without an answer: the skeleton while loading, nothing otherwise", () => {
    viewport(false);
    const { unmount } = renderWithTheme(AbsencesByPersonTable, props(null, { loading: true }));
    expect(screen.getByTestId("absence-skeleton")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    unmount();
    renderWithTheme(AbsencesByPersonTable, props(null, { loading: false }));
    expect(screen.queryByTestId("absence-skeleton")).toBeNull();
  });

  it("no persons in the period: the empty state, no search bar", () => {
    viewport(false);
    renderWithTheme(AbsencesByPersonTable, props([]));
    expect(screen.getByText("Keine Personen im Zeitraum")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByLabelText("Person suchen")).toBeNull();
  });

  it("every column empty: the calm line and no table", () => {
    viewport(false);
    renderWithTheme(AbsencesByPersonTable, props([row("A"), row("B")]));
    expect(screen.getByText("Keine Abwesenheiten im Zeitraum.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByTestId("absence-hidden-hint")).toBeNull();
  });

  it("under a salon filter the card carries the note and keeps columns and values (D-08)", () => {
    viewport(false);
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
    viewport(false);
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
    viewport(false);
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
    viewport(false);
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    await fireEvent.click(
      within(screen.getByRole("columnheader", { name: /Person/ })).getByRole("button"),
    );
    expect(names()).toEqual(["Carla", "Bernd", "Anna"]);
  });
});

describe("AbsencesByPersonTable - search, count, paging", () => {
  it("filters on name and personnel number, case-insensitively, and counts persons", async () => {
    viewport(false);
    renderWithTheme(
      AbsencesByPersonTable,
      props([
        row("1", { SICK: 1 }, { employeeName: "Anna Berg", employeeNumber: "0042" }),
        row("2", { SICK: 1 }, { employeeName: "Bert Anders", employeeNumber: "0100" }),
        row("3", { SICK: 1 }, { employeeName: "Carla", employeeNumber: "0200" }),
      ]),
    );
    expect(screen.getByTestId("absence-count")).toHaveTextContent("3 Personen");
    const search = screen.getByLabelText("Person suchen");
    await fireEvent.input(search, { target: { value: "ANNA" } });
    expect(names()).toEqual(["Anna Berg"]);
    expect(screen.getByTestId("absence-count")).toHaveTextContent(/^1 Person$/);
    await fireEvent.input(search, { target: { value: "0100" } });
    expect(names()).toEqual(["Bert Anders"]);
  });

  it("no hit: the empty state with a reset action", async () => {
    viewport(false);
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    await fireEvent.input(screen.getByLabelText("Person suchen"), { target: { value: "zzz" } });
    expect(screen.getByText("Keine Treffer")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Suche zurücksetzen" }));
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("pages in steps of 25 over the searched and sorted rows; a new search returns to page 1", async () => {
    viewport(false);
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
    await fireEvent.input(screen.getByLabelText("Person suchen"), { target: { value: "P 0" } });
    expect(names()[0]).toBe("P 00");
  });
});

describe("AbsencesByPersonTable - opening a person", () => {
  it("hands a click on the name link to onOpenPerson with the event and the row, once", async () => {
    viewport(false);
    const onOpenPerson = vi.fn<(e: MouseEvent, r: PeriodRow) => void>((e) => e.preventDefault());
    renderWithTheme(AbsencesByPersonTable, props(MIXED, { onOpenPerson }));
    await fireEvent.click(screen.getByRole("link", { name: "Anna" }));
    expect(onOpenPerson).toHaveBeenCalledTimes(1);
    expect(onOpenPerson.mock.calls[0][0]).toBeInstanceOf(MouseEvent);
    expect(onOpenPerson.mock.calls[0][1]).toMatchObject({ employeeId: "A" });
  });

  it("a click on a figure cell opens the person as well", async () => {
    viewport(false);
    const onOpenPerson = vi.fn((e: MouseEvent) => e.preventDefault());
    renderWithTheme(AbsencesByPersonTable, props(MIXED, { onOpenPerson }));
    await fireEvent.click(within(bodyRows()[0]).getAllByRole("cell")[0]);
    expect(onOpenPerson).toHaveBeenCalledTimes(1);
  });
});

describe("AbsencesByPersonTable - narrow viewport (≤ 960 px): a list, no table", () => {
  it("renders no table, a sort select for the visible kinds only, and one list item per person", () => {
    viewport(true);
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    expect(screen.queryByRole("table")).toBeNull();
    const select = screen.getByLabelText("Sortieren nach");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Name (A–Z)",
      "Name (Z–A)",
      "Krank (meiste zuerst)",
      "Kinderkrank (meiste zuerst)",
      "Urlaub (meiste zuerst)",
      "Berufsschule (meiste zuerst)",
    ]);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("each item is a stretched primary link with the list line and no nested control", async () => {
    viewport(true);
    const onOpenPerson = vi.fn((e: MouseEvent) => e.preventDefault());
    const { container } = renderWithTheme(AbsencesByPersonTable, props(MIXED, { onOpenPerson }));
    const link = screen.getByRole("link", { name: "Anna – Personenansicht öffnen" });
    expect(link).toHaveAttribute("href", "/reports?person=A");
    expect(container.querySelectorAll("a button, button button, a a, button a")).toHaveLength(0);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Krank 2 · Kinderkrank 1 · Urlaub 1,5");
    expect(items[2]).toHaveTextContent("Keine Abwesenheiten");
    await fireEvent.click(link);
    expect(onOpenPerson).toHaveBeenCalledTimes(1);
  });

  it("the select sorts by a kind, most first", async () => {
    viewport(true);
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    await fireEvent.change(screen.getByLabelText("Sortieren nach"), {
      target: { value: "SICK:desc" },
    });
    const order = screen
      .getAllByRole("listitem")
      .map((li) =>
        li.textContent?.includes("Bernd")
          ? "Bernd"
          : li.textContent?.includes("Anna")
            ? "Anna"
            : "Carla",
      );
    expect(order).toEqual(["Bernd", "Anna", "Carla"]);
  });

  it("keeps the hints near the list", () => {
    viewport(true);
    renderWithTheme(AbsencesByPersonTable, props(MIXED));
    expect(screen.getByTestId("absence-unit-hint")).toHaveTextContent(ABSENCE_UNIT_HINT);
    expect(screen.getByTestId("absence-hidden-hint")).toBeInTheDocument();
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
