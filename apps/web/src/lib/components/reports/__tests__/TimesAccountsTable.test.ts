// Issue #612 (D-612-4, AC-612-3, P-08, P-12, P-21, amendments 7 and 14) - the tab „Zeiten & Konten“,
// mounted. lib/components/reports/ is outside the lint:ui-classes gate (CLAUDE.md), so the
// columns, the sort, the search, the status chips, the median line and the mobile list are
// proven here. Pattern 3: the component formats the server's rows; no figure is derived.

import { describe, it, expect, vi, afterEach } from "vitest";

// The page-scope module reaches the api client and its auth store (localStorage bootstrap); a
// stand-in keeps this mounted test free of it (as in page-scope.test.ts).
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
import {
  HOME_SALON_CHANGE_NOTE,
  PERSON_SALDO_BY_HOME_SALON_LABEL,
  SALON_PERIOD_END_PERSONS_NOTE,
} from "$lib/salons/page-scope";
import { forecastLabel } from "$lib/saldo/forecast-label";
import type { PeriodRow } from "$lib/reports/period-report";
import TimesAccountsTable from "../TimesAccountsTable.svelte";
import source from "../TimesAccountsTable.svelte?raw";

function row(id: string, extra: Partial<PeriodRow> = {}): PeriodRow {
  return {
    employeeId: id,
    employeeName: `Person ${id}`,
    employeeNumber: `N-${id}`,
    hasRecordedTime: true,
    exitDay: null,
    workedMinutes: 9600, // 160:00
    expectedMinutes: 9600,
    balanceMinutes: 0,
    openingBalanceMinutes: 60,
    closingBalanceMinutes: 60,
    closingConfirmedMinutes: null,
    closingOpenMinutes: null,
    unconfirmedMonths: null,
    monthCount: 1,
    confirmedMonthCount: 1,
    labelled: true,
    sickDays: 0,
    months: [],
    ...extra,
  };
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
  const listeners: Array<(e: { matches: boolean }) => void> = [];
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: narrow && query.includes("960"),
      media: query,
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => listeners.push(cb),
      removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
    })),
  );
  return listeners;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const bodyRows = () => within(screen.getAllByRole("rowgroup")[1]).getAllByRole("row");
const names = () => bodyRows().map((r) => within(r).getByRole("link").textContent?.trim());

describe("TimesAccountsTable - columns and cells (wide)", () => {
  it("has the seven columns of the copy deck and one row per person", () => {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props([row("A"), row("B")]));
    const headers = screen
      .getAllByRole("columnheader")
      .map((h) => h.textContent?.replace(/[▲▼]/g, "").trim());
    expect(headers).toEqual([
      "Person",
      "Soll (h)",
      "Ist (h)",
      "Saldo Beginn (h)",
      "Saldo Zeitraum (h)",
      "Saldo Ende (h)",
      "Status",
    ]);
    expect(bodyRows()).toHaveLength(2);
    expect(screen.getByRole("table")).toHaveAccessibleName(
      "Zeiten und Konten je Person, Jul – Sep 2026",
    );
  });

  it("the person cell is a row header with the name link, the personnel number and the exit day", () => {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props([row("A", { exitDay: "2026-08-31" }), row("B")]));
    const [a, b] = bodyRows();
    const cell = within(a).getByRole("rowheader");
    const link = within(cell).getByRole("link", { name: "Person A" });
    expect(link).toHaveAttribute("href", "/reports?person=A");
    expect(cell).toHaveTextContent("N-A");
    expect(cell).toHaveTextContent("ausgetreten am 31.08.2026");
    expect(within(b).getByRole("rowheader")).not.toHaveTextContent("ausgetreten");
  });

  it("formats Soll and Ist unsigned and the three saldo columns signed, from minutes", () => {
    viewport(false);
    renderWithTheme(
      TimesAccountsTable,
      props([
        row("A", {
          expectedMinutes: 230400, // 3.840:00
          workedMinutes: 230535, // 3.842:15
          openingBalanceMinutes: -45,
          balanceMinutes: 135,
          closingBalanceMinutes: 0,
        }),
      ]),
    );
    const cells = within(bodyRows()[0]).getAllByRole("cell");
    expect(cells.map((c) => c.textContent?.trim())).toEqual([
      "3.840:00",
      "3.842:15",
      "−0:45",
      "+2:15",
      "±0:00",
      expect.stringContaining("Bestätigt"),
    ]);
  });

  it("the three saldo columns are not rendered when no row carries a saldo figure", () => {
    viewport(false);
    const withheld = {
      expectedMinutes: null,
      balanceMinutes: null,
      openingBalanceMinutes: null,
      closingBalanceMinutes: null,
      sollUnavailableReason: "NO_PERMISSION" as const,
    };
    renderWithTheme(TimesAccountsTable, props([row("A", withheld), row("B", withheld)]));
    const headers = screen
      .getAllByRole("columnheader")
      .map((h) => h.textContent?.replace(/[▲▼]/g, "").trim());
    expect(headers).toEqual(["Person", "Soll (h)", "Ist (h)", "Status"]);
    // Soll is withheld with its reason; Ist stays.
    const cells = within(bodyRows()[0]).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("—");
    expect(cells[0].querySelector("[title='Keine Berechtigung']")).not.toBeNull();
    expect(cells[0].querySelector(".sr-only")).toHaveTextContent("Keine Berechtigung");
    expect(cells[1]).toHaveTextContent("160:00");
    // No saldo at all: no median line either.
    expect(screen.queryByTestId("period-median")).toBeNull();
  });

  it("one row without saldo among rows with saldo shows a dash with the reason as title", () => {
    viewport(false);
    renderWithTheme(
      TimesAccountsTable,
      props([
        row("A"),
        row("B", {
          expectedMinutes: null,
          balanceMinutes: null,
          openingBalanceMinutes: null,
          closingBalanceMinutes: null,
          sollUnavailableReason: "NO_PERMISSION",
        }),
      ]),
    );
    const cells = within(bodyRows()[1]).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("—");
    expect(cells[0].querySelector("[title='Keine Berechtigung']")).not.toBeNull();
    expect(cells[4]).toHaveTextContent("—");
  });

  it("a figure that is missing without a reason is a dash with a neutral title", () => {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props([row("A", { openingBalanceMinutes: null })]));
    const cell = within(bodyRows()[0]).getAllByRole("cell")[2];
    expect(cell).toHaveTextContent("—");
    expect(cell.querySelector("[title='Kein Wert vorhanden']")).not.toBeNull();
  });
});

describe("TimesAccountsTable - status chips (P-08, amendments 7 and 14)", () => {
  function statusCell(r: PeriodRow, overrides: Record<string, unknown> = {}) {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props([r], overrides));
    const cells = within(bodyRows()[0]).getAllByRole("cell");
    return cells[cells.length - 1];
  }

  it("every month closed: the good chip „Bestätigt“ with an aria-hidden lock", () => {
    const cell = statusCell(row("A", { monthCount: 3, confirmedMonthCount: 3 }));
    const chip = cell.querySelector(".chip")!;
    expect(chip).toHaveClass("chip-good");
    expect(chip).toHaveTextContent("Bestätigt");
    expect(chip.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(cell).not.toHaveTextContent("von");
  });

  it("an open month: the forecast wording of the one rule and „k von m Monaten bestätigt“", () => {
    const cell = statusCell(row("A", { monthCount: 3, confirmedMonthCount: 2 }));
    const chip = cell.querySelector(".chip")!;
    expect(chip).not.toHaveClass("chip-good");
    // One unconfirmed month after closed ones: the helper words it as the running month.
    expect(chip).toHaveTextContent(forecastLabel(1, true));
    expect(cell).toHaveTextContent("2 von 3 Monaten bestätigt");
  });

  it("several open months after a closed one: „seit Monatsabschluss“, not the running month", () => {
    const cell = statusCell(row("A", { monthCount: 4, confirmedMonthCount: 1 }));
    expect(cell.querySelector(".chip")).toHaveTextContent(forecastLabel(3, true));
    expect(cell).toHaveTextContent("1 von 4 Monaten bestätigt");
  });

  it("nothing closed: the wording does not claim a Monatsabschluss, and there is no second line", () => {
    const cell = statusCell(
      row("A", { monthCount: 2, confirmedMonthCount: 0, closingConfirmedMinutes: null }),
    );
    expect(cell.querySelector(".chip")).toHaveTextContent(forecastLabel(2, false));
    expect(cell).not.toHaveTextContent(" von ");
  });

  it("the server's exact unconfirmed count and the split after a closed month before the period win", () => {
    const cell = statusCell(
      row("A", {
        monthCount: 1,
        confirmedMonthCount: 0,
        unconfirmedMonths: 1,
        closingConfirmedMinutes: 600,
        closingOpenMinutes: 60,
      }),
    );
    expect(cell.querySelector(".chip")).toHaveTextContent(forecastLabel(1, true));
  });

  it("no labelled month: the neutral chip „ohne Soll“", () => {
    const cell = statusCell(row("A", { labelled: false, confirmedMonthCount: 0 }));
    expect(cell.querySelector(".chip")).toHaveTextContent("ohne Soll");
  });

  // Issue #714 (owner decision #714): the circle under a salon filter is whole persons, so the
  // status is the real one; the old „Nicht je Salon“ dash is gone.
  it("under a salon filter an all-closed row shows the Bestätigt chip, no dash (#714)", () => {
    const cell = statusCell(row("A"), { filterActive: true });
    expect(cell.querySelector(".chip")).toHaveTextContent("Bestätigt");
    expect(cell).not.toHaveTextContent("—");
    expect(cell.querySelector("[title='Nicht je Salon']")).toBeNull();
  });

  it("under a salon filter a forecast row shows the forecast chip with its detail (#714)", () => {
    const cell = statusCell(
      row("B", { monthCount: 3, confirmedMonthCount: 1, unconfirmedMonths: 2 }),
      { filterActive: true },
    );
    expect(cell.querySelector(".chip")).toHaveTextContent(forecastLabel(2, true));
    expect(cell).toHaveTextContent("1 von 3 Monaten bestätigt");
  });

  it("under a salon filter a row without a labelled month shows „ohne Soll“ (#714)", () => {
    const cell = statusCell(row("C", { labelled: false, confirmedMonthCount: 0 }), {
      filterActive: true,
    });
    expect(cell.querySelector(".chip")).toHaveTextContent("ohne Soll");
  });
});

describe("TimesAccountsTable - sort", () => {
  const many = [
    row("A", { employeeName: "Zoe", closingBalanceMinutes: 300 }),
    row("B", { employeeName: "Anna", closingBalanceMinutes: -60 }),
    row("C", { employeeName: "Äpfel", closingBalanceMinutes: 900 }),
    row("D", {
      employeeName: "Bernd",
      closingBalanceMinutes: null,
      expectedMinutes: null,
      balanceMinutes: null,
      openingBalanceMinutes: null,
      sollUnavailableReason: "NO_PERMISSION",
    }),
  ];

  it("starts with Person ascending (German collation) and says so in aria-sort", () => {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props(many));
    expect(names()).toEqual(["Anna", "Äpfel", "Bernd", "Zoe"]);
    expect(screen.getByRole("columnheader", { name: /Person/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(screen.getByRole("columnheader", { name: /Saldo Ende/ })).toHaveAttribute(
      "aria-sort",
      "none",
    );
  });

  it("a click on „Saldo Ende (h)“ sorts descending, again ascending; a withheld figure stays last", async () => {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props(many));
    const header = () => screen.getByRole("columnheader", { name: /Saldo Ende/ });
    await fireEvent.click(within(header()).getByRole("button"));
    expect(names()).toEqual(["Äpfel", "Zoe", "Anna", "Bernd"]);
    expect(header()).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("columnheader", { name: /Person/ })).toHaveAttribute(
      "aria-sort",
      "none",
    );
    await fireEvent.click(within(header()).getByRole("button"));
    expect(names()).toEqual(["Anna", "Zoe", "Äpfel", "Bernd"]);
    expect(header()).toHaveAttribute("aria-sort", "ascending");
  });

  it("a click on Person again flips to descending", async () => {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props(many));
    await fireEvent.click(
      within(screen.getByRole("columnheader", { name: /Person/ })).getByRole("button"),
    );
    expect(names()).toEqual(["Zoe", "Bernd", "Äpfel", "Anna"]);
  });

  it("Status sorts the confirmed rows first", async () => {
    viewport(false);
    renderWithTheme(
      TimesAccountsTable,
      props([
        row("A", { employeeName: "A", monthCount: 2, confirmedMonthCount: 1 }),
        row("B", { employeeName: "B" }),
        row("C", { employeeName: "C", labelled: false }),
      ]),
    );
    const status = screen.getByRole("columnheader", { name: /Status/ });
    await fireEvent.click(within(status).getByRole("button")); // figures start descending
    await fireEvent.click(within(status).getByRole("button")); // ascending: confirmed first
    expect(names()).toEqual(["B", "A", "C"]);
  });
});

describe("TimesAccountsTable - search, count, paging", () => {
  it("filters on name and personnel number, case-insensitively, and counts persons", async () => {
    viewport(false);
    renderWithTheme(
      TimesAccountsTable,
      props([
        row("1", { employeeName: "Anna Berg", employeeNumber: "0042" }),
        row("2", { employeeName: "Bert Anders", employeeNumber: "0100" }),
        row("3", { employeeName: "Carla", employeeNumber: "0200" }),
      ]),
    );
    expect(screen.getByTestId("period-count")).toHaveTextContent("3 Personen");
    const search = screen.getByLabelText("Person suchen");
    expect(search).toHaveAttribute("placeholder", "Name oder Personalnummer");
    await fireEvent.input(search, { target: { value: "ANNA" } });
    expect(names()).toEqual(["Anna Berg"]);
    expect(screen.getByTestId("period-count")).toHaveTextContent(/^1 Person$/);
    await fireEvent.input(search, { target: { value: "0100" } });
    expect(names()).toEqual(["Bert Anders"]);
  });

  it("no hit: the empty state with a reset action", async () => {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props([row("1")]));
    await fireEvent.input(screen.getByLabelText("Person suchen"), { target: { value: "zzz" } });
    expect(screen.getByText("Keine Treffer")).toBeInTheDocument();
    expect(screen.getByText("Keine Person passt zu „zzz“.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Suche zurücksetzen" }));
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByLabelText("Person suchen")).toHaveValue("");
  });

  it("no persons in the period: the empty state, no search bar", () => {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props([]));
    expect(screen.getByText("Keine Personen im Zeitraum")).toBeInTheDocument();
    expect(
      screen.getByText(
        "In Ihrer Reichweite war im gewählten Zeitraum niemand beschäftigt. Wählen Sie oben einen anderen Zeitraum.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("pages in steps of 25 over the searched and sorted rows; a new search returns to page 1", async () => {
    viewport(false);
    const rows = Array.from({ length: 60 }, (_, i) =>
      row(String(i).padStart(2, "0"), { employeeName: `P ${String(i).padStart(2, "0")}` }),
    );
    renderWithTheme(TimesAccountsTable, props(rows));
    expect(bodyRows()).toHaveLength(25);
    await fireEvent.click(screen.getByRole("button", { name: /nächste/i }));
    expect(names()[0]).toBe("P 25");
    await fireEvent.input(screen.getByLabelText("Person suchen"), { target: { value: "P 0" } });
    expect(names()[0]).toBe("P 00");
  });
});

describe("TimesAccountsTable - the team median (P-12, #588 rule)", () => {
  it("shows the median of the closing saldi with the module's sign format", () => {
    viewport(false);
    renderWithTheme(
      TimesAccountsTable,
      props([
        row("A", { closingBalanceMinutes: 60 }),
        row("B", { closingBalanceMinutes: 195 }),
        row("C", { closingBalanceMinutes: 900 }),
      ]),
    );
    expect(screen.getByTestId("period-median")).toHaveTextContent(
      /^Median Saldo am Ende \+3:15 h$/,
    );
  });

  it("names the persons without recording next to it and flags their rows", () => {
    viewport(false);
    renderWithTheme(
      TimesAccountsTable,
      props([
        row("A", { closingBalanceMinutes: 60 }),
        row("B", { closingBalanceMinutes: -2400, hasRecordedTime: false }),
        row("C", { closingBalanceMinutes: -2400, hasRecordedTime: false }),
      ]),
    );
    expect(screen.getByTestId("period-median")).toHaveTextContent(
      "Median Saldo am Ende +1:00 h – ohne 2 Personen ohne Erfassung",
    );
    const flagged = bodyRows().filter((r) => within(r).queryByText("ohne Erfassung") !== null);
    expect(flagged).toHaveLength(2);
  });

  it("a person with a withheld or missing saldo carries the module's reason chip", () => {
    viewport(false);
    renderWithTheme(
      TimesAccountsTable,
      props([
        row("A"),
        row("B", { closingBalanceMinutes: null, balanceMinutes: null }),
        row("C", { labelled: false, closingBalanceMinutes: null }),
      ]),
    );
    const [, b, c] = bodyRows();
    expect(within(b).getByText("Saldo nicht verfügbar")).toBeInTheDocument();
    expect(within(c).getByText("nur Zeiterfassung")).toBeInTheDocument();
  });

  it("nobody counts: a dash instead of a number", () => {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props([row("A", { closingBalanceMinutes: null })]));
    expect(screen.getByTestId("period-median")).toHaveTextContent(/^Median Saldo am Ende — h$/);
  });
});

describe("TimesAccountsTable - opening a person", () => {
  it("hands every click on the name link to onOpenPerson with the event and the row", async () => {
    viewport(false);
    const onOpenPerson = vi.fn<(e: MouseEvent, r: PeriodRow) => void>((e) => e.preventDefault());
    renderWithTheme(TimesAccountsTable, props([row("A")], { onOpenPerson }));
    await fireEvent.click(screen.getByRole("link", { name: "Person A" }));
    expect(onOpenPerson).toHaveBeenCalledTimes(1);
    expect(onOpenPerson.mock.calls[0][0]).toBeInstanceOf(MouseEvent);
    expect(onOpenPerson.mock.calls[0][1]).toMatchObject({ employeeId: "A" });
  });

  it("a click on a cell outside links and buttons opens the person as well, a click on the link only once", async () => {
    viewport(false);
    const onOpenPerson = vi.fn((e: MouseEvent) => e.preventDefault());
    renderWithTheme(TimesAccountsTable, props([row("A")], { onOpenPerson }));
    await fireEvent.click(within(bodyRows()[0]).getAllByRole("cell")[1]);
    expect(onOpenPerson).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole("link", { name: "Person A" }));
    expect(onOpenPerson).toHaveBeenCalledTimes(2); // the link's click does not bubble into a second open
  });

  it("the keyboard path is the name link; the row itself is not a tab stop", () => {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props([row("A")]));
    expect(bodyRows()[0]).not.toHaveAttribute("tabindex");
    expect(bodyRows()[0]).not.toHaveAttribute("role");
  });
});

describe("TimesAccountsTable - narrow viewport (≤ 960 px): a list, no table", () => {
  it("renders no table, a sort select with the five options, and one ApprovalRow per person", () => {
    viewport(true);
    renderWithTheme(TimesAccountsTable, props([row("A"), row("B")]));
    expect(screen.queryByRole("table")).toBeNull();
    const select = screen.getByLabelText("Sortieren nach");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Name (A–Z)",
      "Name (Z–A)",
      "Saldo am Ende (höchster zuerst)",
      "Saldo am Ende (niedrigster zuerst)",
      "Ist (höchster zuerst)",
    ]);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("each row is a stretched primary link named „<Name> – Personenansicht öffnen“ with no nested control", async () => {
    viewport(true);
    const onOpenPerson = vi.fn((e: MouseEvent) => e.preventDefault());
    const { container } = renderWithTheme(
      TimesAccountsTable,
      props([row("A", { closingBalanceMinutes: 735 })], { onOpenPerson }),
    );
    const link = screen.getByRole("link", { name: "Person A – Personenansicht öffnen" });
    expect(link).toHaveAttribute("href", "/reports?person=A");
    expect(container.querySelectorAll("a button, button button, a a, button a")).toHaveLength(0);
    // The row carries no action cluster in this list.
    expect(container.querySelector(".approval-actions")).toBeNull();
    const li = screen.getAllByRole("listitem")[0];
    expect(li).toHaveTextContent("Soll 160:00 · Ist 160:00 · Zeitraum ±0:00");
    expect(li).toHaveTextContent("Ende +12:15 h");
    expect(li).toHaveTextContent("Bestätigt");
    await fireEvent.click(link);
    expect(onOpenPerson).toHaveBeenCalledTimes(1);
  });

  it("a withheld saldo leaves Soll and Zeitraum out of the line and shows a dash for the end", () => {
    viewport(true);
    renderWithTheme(
      TimesAccountsTable,
      props([
        row("A", {
          expectedMinutes: null,
          balanceMinutes: null,
          openingBalanceMinutes: null,
          closingBalanceMinutes: null,
          sollUnavailableReason: "NO_PERMISSION",
        }),
      ]),
    );
    const li = screen.getAllByRole("listitem")[0];
    expect(li).toHaveTextContent("Ist 160:00");
    expect(li).not.toHaveTextContent("Soll");
    expect(li).toHaveTextContent("—");
  });

  it("the sort select reorders the list", async () => {
    viewport(true);
    renderWithTheme(
      TimesAccountsTable,
      props([
        row("A", { employeeName: "Anna", closingBalanceMinutes: 10 }),
        row("B", { employeeName: "Bert", closingBalanceMinutes: 900 }),
      ]),
    );
    const order = () => screen.getAllByRole("link").map((l) => l.textContent?.trim());
    expect(order()).toEqual(["Anna", "Bert"]);
    await fireEvent.change(screen.getByLabelText("Sortieren nach"), {
      target: { value: "closing:desc" },
    });
    expect(order()).toEqual(["Bert", "Anna"]);
  });

  it("reacts to the viewport changing while mounted and stops listening on unmount", async () => {
    const listeners = viewport(false);
    const { unmount } = renderWithTheme(TimesAccountsTable, props([row("A")]));
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(listeners).toHaveLength(1);
    listeners[0]({ matches: true });
    await Promise.resolve();
    expect(await screen.findByLabelText("Sortieren nach")).toBeInTheDocument();
    unmount();
    expect(listeners).toHaveLength(0);
  });
});

describe("TimesAccountsTable - loading and the exited slot", () => {
  it("first load: skeleton lines and aria-busy, no table", () => {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props(null, { loading: true }));
    expect(screen.getByTestId("period-table-skeleton").querySelectorAll(".skeleton")).toHaveLength(
      5,
    );
    expect(screen.getByTestId("period-section")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders nothing of the table when there are no rows and nothing is loading (error state of the page)", () => {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props(null));
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Keine Personen im Zeitraum")).toBeNull();
  });

  it("section head: h2, the period label as sub", () => {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props([row("A")]));
    expect(screen.getByRole("heading", { level: 2, name: "Zeiten & Konten" })).toBeInTheDocument();
    expect(screen.getByTestId("period-section")).toHaveTextContent("Jul – Sep 2026");
  });
});

describe("TimesAccountsTable - source", () => {
  it("is non-empty, imports no $app module, no navigation and no API client", () => {
    expect(source.length).toBeGreaterThan(2000);
    expect(source).not.toContain("$app/");
    expect(source).not.toContain("$api/");
    expect(source).not.toContain("goto(");
  });

  it("reads the team figures from the one module and renders no compact SaldoAnzeige (#588 R3/R5)", () => {
    expect(source).toMatch(/from "\$lib\/reports\/team-saldo"/);
    expect(source.includes("<SaldoAnzeige")).toBe(false);
  });

  it("holds no median or sum of its own and no forecast wording literal", () => {
    expect(source).not.toMatch(/\.reduce\(/);
    expect(source).not.toMatch(/function\s+\w*median\w*\s*\(/i);
    expect(source).not.toContain("Laufender Monat (Prognose)");
    expect(source).not.toContain("Seit Monatsabschluss");
  });

  it("scopes its sticky header offset to the bar and keeps action wrappers out of td display", () => {
    expect(source).toContain("var(--topbar-h) + var(--period-bar-h, 0px)");
    expect(source).toMatch(/\.period-table-wrap\s*\{[^}]*overflow:\s*visible/);
    expect(source).not.toMatch(/td\s*\{[^}]*display:\s*flex/);
  });
});

// Issue #714 (owner decision #714, replaces the #612 amendment-16 membership note): under a salon
// filter the table says who it lists - the Stammsalon circle - and where a mover counts; it says
// nothing without a filter.
describe("TimesAccountsTable - salon filter note", () => {
  it("names the Stammsalon circle, the whole-person saldo and the mover rule under a filter", () => {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props([row("A")], { filterActive: true }));
    const note = screen.getByTestId("times-salon-note").textContent ?? "";
    expect(note).toContain(SALON_PERIOD_END_PERSONS_NOTE);
    expect(note).toContain(PERSON_SALDO_BY_HOME_SALON_LABEL);
    expect(note).toContain(HOME_SALON_CHANGE_NOTE);
    expect(note).not.toContain("Eintrag in diesem Salon");
  });

  it("has the same columns with and without a filter (no salon column)", () => {
    viewport(false);
    const heads = () =>
      Array.from(document.querySelectorAll("thead th")).map((th) => th.textContent?.trim());
    const view = renderWithTheme(TimesAccountsTable, props([row("A")]));
    const plain = heads();
    view.unmount();
    renderWithTheme(TimesAccountsTable, props([row("A")], { filterActive: true }));
    expect(heads()).toEqual(plain);
    expect(plain.some((h) => h?.includes("Salon"))).toBe(false);
  });

  it("a NO_PERMISSION row keeps its dash with „Keine Berechtigung“ under a filter", () => {
    viewport(false);
    renderWithTheme(
      TimesAccountsTable,
      props(
        [
          row("A", {
            expectedMinutes: null,
            balanceMinutes: null,
            openingBalanceMinutes: null,
            closingBalanceMinutes: null,
            sollUnavailableReason: "NO_PERMISSION",
          }),
        ],
        { filterActive: true },
      ),
    );
    expect(screen.getAllByText("Keine Berechtigung").length).toBeGreaterThan(0);
  });

  it("shows no note without a filter", () => {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props([row("A")]));
    expect(screen.queryByTestId("times-salon-note")).toBeNull();
  });

  it("shows the note while the first answer is pending, too", () => {
    viewport(false);
    renderWithTheme(TimesAccountsTable, props(null, { filterActive: true, loading: true }));
    expect(screen.getByTestId("times-salon-note")).toBeTruthy();
  });
});
