// Issue #612 (D-612-5, ADD-2, P-06, P-07, P-15) - the tab „Urlaub & Abwesenheit“, mounted. Since
// Issue #854 both tables are DataTables; the vacation table, the Verfall column with „Hinweis
// senden“, the year switch, the card layout and the absence statistics are proven here. Pattern 3:
// the component formats the server's rows; no figure is derived.

import { describe, it, expect, vi } from "vitest";

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

import { screen, fireEvent, within, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { VACATION_YEAR_COLUMNS } from "$lib/reports/vacation-columns";
import {
  SALON_PERIOD_END_PERSONS_NOTE,
  PERSON_VALUES_NOT_SPLIT_LABEL,
} from "$lib/salons/page-scope";
import type {
  PeriodAbsence,
  PeriodVacationRow,
  PeriodVacationYear,
} from "$lib/reports/period-report";
import VacationAbsenceTab from "../VacationAbsenceTab.svelte";
import source from "../VacationAbsenceTab.svelte?raw";

function vrow(id: string, extra: Partial<PeriodVacationRow> = {}): PeriodVacationRow {
  return {
    employeeId: id,
    employeeName: `Person ${id}`,
    employeeNumber: `N-${id}`,
    year: 2026,
    entitlementId: `ent-${id}`,
    entitlementDays: 30,
    carriedOverDays: 5,
    carriedOverEffectiveDays: 4,
    carriedOverExpiredDays: 1,
    exitReductionDays: 0,
    availableDays: 34,
    takenDays: 12,
    approvedUpcomingDays: 5,
    pendingDays: 2,
    remainingDays: 17,
    atRiskDays: 0,
    carryOverDeadline: null,
    lastWarningSentAt: null,
    missingEntitlement: false,
    entitlementWarning: null,
    ...extra,
  };
}

function missing(id: string): PeriodVacationRow {
  return vrow(id, {
    entitlementId: null,
    entitlementDays: null,
    carriedOverDays: null,
    carriedOverEffectiveDays: null,
    carriedOverExpiredDays: null,
    exitReductionDays: null,
    availableDays: null,
    takenDays: null,
    approvedUpcomingDays: null,
    pendingDays: null,
    remainingDays: null,
    atRiskDays: null,
    missingEntitlement: true,
  });
}

function year(y: number, rows: PeriodVacationRow[]): PeriodVacationYear {
  return { year: y, asOf: `${y}-09-30`, rows };
}

function vacation(years: PeriodVacationYear[]) {
  return { year: years[years.length - 1].year, asOf: years[years.length - 1].asOf, years };
}

const ABSENCES: PeriodAbsence[] = [
  { code: "VACATION", unit: "WORKDAYS", personCount: 4, totalDays: 12.5 },
  { code: "SICK", unit: "CALENDAR_DAYS", personCount: 2, totalDays: 6 },
];

function props(overrides: Record<string, unknown> = {}) {
  return {
    vacation: vacation([year(2026, [vrow("A"), vrow("B")])]),
    absences: ABSENCES,
    filterActive: false,
    loading: false,
    today: "2026-10-15",
    canNotify: true,
    periodLabel: "Jul – Sep 2026",
    personHref: (id: string): string | null => `/reports?person=${id}`,
    onOpenPerson: vi.fn(),
    onNotify: vi.fn().mockResolvedValue({ warned: 1, skippedDedup: 0 }),
    ...overrides,
  };
}

const vacTable = () => screen.getByRole("table", { name: /Urlaub je Person/ });

describe("VacationAbsenceTab - the Urlaubsübersicht table (wide)", () => {
  it("titles the card and names the vacation year of the answer", () => {
    renderWithTheme(VacationAbsenceTab, props());
    expect(screen.getByText("Urlaubsübersicht")).toBeTruthy();
    expect(screen.getByText("Urlaubsjahr 2026")).toBeTruthy();
  });

  it("has Person, the seven VACATION_YEAR_COLUMNS in their order and Verfall", () => {
    renderWithTheme(VacationAbsenceTab, props());
    const headers = within(vacTable())
      .getAllByRole("columnheader")
      .map((h) => h.textContent?.replace(/\s+/g, " ").trim());
    expect(headers).toEqual(["Person", ...VACATION_YEAR_COLUMNS, "Verfall"]);
  });

  it("shows day values without a unit, one decimal at most, German comma", () => {
    const row = vrow("A", { takenDays: 12.5 });
    renderWithTheme(VacationAbsenceTab, props({ vacation: vacation([year(2026, [row])]) }));
    const cells = within(within(vacTable()).getAllByRole("row")[1])
      .getAllByRole("cell")
      .map((c) => c.textContent?.trim());
    // Person, then Anspruch, Übertrag (wirksam), Verfügbar, Genommen, Genehmigt, Beantragt, Resturlaub
    expect(cells.slice(1, 8)).toEqual(["30", "4", "34", "12,5", "5", "2", "17"]);
  });

  it("[#451] Übertrag is the effective carry-over and falls back to the raw carry-over when absent", () => {
    const rows = [
      vrow("A", { carriedOverEffectiveDays: 4, carriedOverDays: 5 }),
      vrow("B", { carriedOverEffectiveDays: null, carriedOverDays: 5, availableDays: null }),
    ];
    renderWithTheme(VacationAbsenceTab, props({ vacation: vacation([year(2026, rows)]) }));
    const body = within(vacTable()).getAllByRole("row").slice(1);
    const carry = (r: HTMLElement) => within(r).getAllByRole("cell")[2].textContent?.trim();
    expect(carry(body[0])).toBe("4");
    expect(carry(body[1])).toBe("5");
    // Verfügbar falls back to Anspruch + the carry-over shown
    expect(within(body[1]).getAllByRole("cell")[3].textContent?.trim()).toBe("35");
  });

  it("carries the caption of the copy deck under the table", () => {
    renderWithTheme(VacationAbsenceTab, props());
    expect(
      screen.getByText(
        "Alle Werte in Arbeitstagen. Verfügbar = Anspruch + wirksamer Übertrag. Resturlaub = Verfügbar − Genommen − Genehmigt. Beantragte Tage werden nicht abgezogen.",
      ),
    ).toBeTruthy();
  });

  it("renders a placeholder person as the chip in the first figure cell and dashes after it", () => {
    renderWithTheme(
      VacationAbsenceTab,
      props({ vacation: vacation([year(2026, [vrow("A"), missing("M")])]) }),
    );
    const badge = screen.getByText("kein Anspruch hinterlegt");
    expect(badge.className).toContain("chip-warn");
    const cells = within(badge.closest("tr") as HTMLElement).getAllByRole("cell");
    expect(cells[1]).toContainElement(badge);
    expect(cells.slice(2, 8).map((c) => c.textContent?.trim())).toEqual(Array(6).fill("—"));
  });

  it("shows the Skeleton while loading and no table before the first answer", () => {
    renderWithTheme(VacationAbsenceTab, props({ vacation: null, absences: null, loading: true }));
    // #843 D-843-07: scoped to the vacation region; the absences card renders its own Skeleton.
    expect(
      within(screen.getByTestId("vacation-skeleton")).getByRole("status", { name: "Wird geladen" }),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("searches name and personnel number", async () => {
    renderWithTheme(
      VacationAbsenceTab,
      props({ vacation: vacation([year(2026, [vrow("A"), vrow("B")])]) }),
    );
    await fireEvent.input(
      screen.getByRole("searchbox", { name: "Name oder Personalnummer suchen" }),
      {
        target: { value: "n-b" },
      },
    );
    expect(within(vacTable()).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("Person B")).toBeTruthy();
  });

  it("opens a person from the name link only, never from a row click or the notice button", async () => {
    const onOpenPerson = vi.fn();
    const at = vrow("A", { atRiskDays: 3, carryOverDeadline: "2027-03-31" });
    renderWithTheme(
      VacationAbsenceTab,
      props({ vacation: vacation([year(2026, [at])]), onOpenPerson }),
    );
    await fireEvent.click(screen.getByRole("link", { name: "Person A" }));
    expect(onOpenPerson).toHaveBeenCalledTimes(1);
    expect(onOpenPerson.mock.calls[0][1]).toBe("A");
    onOpenPerson.mockClear();
    await fireEvent.click(within(vacTable()).getAllByRole("row")[1]);
    expect(onOpenPerson).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Hinweis senden an Person A" }));
    expect(onOpenPerson).not.toHaveBeenCalled();
  });
});

describe("VacationAbsenceTab - a person the drill-down cannot show", () => {
  it("has a plain name without a link and a row click that opens nothing", async () => {
    const onOpenPerson = vi.fn();
    renderWithTheme(
      VacationAbsenceTab,
      props({
        personHref: (id: string) => (id === "A" ? "/reports?person=A" : null),
        onOpenPerson,
      }),
    );
    expect(screen.getByRole("link", { name: "Person A" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Person B" })).toBeNull();
    await fireEvent.click(screen.getByText("Person B"));
    expect(onOpenPerson).not.toHaveBeenCalled();
  });
});

describe("VacationAbsenceTab - the year switch", () => {
  const TWO_YEARS = vacation([
    year(2025, [vrow("A", { year: 2025, takenDays: 20 })]),
    year(2026, [vrow("A", { takenDays: 3 })]),
  ]);

  it("has no switch for one year", () => {
    renderWithTheme(VacationAbsenceTab, props());
    expect(screen.queryByRole("radiogroup", { name: "Urlaubsjahr" })).toBeNull();
  });

  it("offers both years for a period across two years, defaulting to the year of the end", async () => {
    renderWithTheme(VacationAbsenceTab, props({ vacation: TWO_YEARS }));
    const group = screen.getByRole("radiogroup", { name: "Urlaubsjahr" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((r) => r.textContent?.trim()),
    ).toEqual(["2025", "2026"]);
    expect(screen.getByText("Urlaubsjahr 2026")).toBeTruthy();
    const takenOf = () =>
      within(within(vacTable()).getAllByRole("row")[1]).getAllByRole("cell")[4].textContent;
    expect(takenOf()?.trim()).toBe("3");
    await fireEvent.click(within(group).getByRole("radio", { name: "2025" }));
    expect(screen.getByText("Urlaubsjahr 2025")).toBeTruthy();
    expect(takenOf()?.trim()).toBe("20");
  });
});

describe("VacationAbsenceTab - the Verfall column", () => {
  const AT_RISK = vrow("A", {
    atRiskDays: 3,
    carryOverDeadline: "2027-03-31",
    lastWarningSentAt: null,
  });

  function verfallCell(index = 0): HTMLElement {
    const row = within(vacTable()).getAllByRole("row").slice(1)[index];
    const cells = within(row).getAllByRole("cell");
    return cells[cells.length - 1];
  }

  it("shows days and deadline of an at-risk row and „Noch kein Hinweis“", () => {
    renderWithTheme(VacationAbsenceTab, props({ vacation: vacation([year(2026, [AT_RISK])]) }));
    expect(verfallCell().textContent).toContain("3 T. bis 31.03.2027");
    expect(verfallCell().textContent).toContain("Noch kein Hinweis");
  });

  it("[#451] the Verfall days are the at-risk days and fall back to the raw carry-over when absent", () => {
    const noAtRisk = vrow("B", {
      atRiskDays: null,
      carriedOverDays: 5,
      carryOverDeadline: "2027-03-31",
    });
    renderWithTheme(VacationAbsenceTab, props({ vacation: vacation([year(2026, [noAtRisk])]) }));
    expect(verfallCell().textContent).toContain("5 T. bis 31.03.2027");
  });

  it("shows the date of the last notice", () => {
    const warned = { ...AT_RISK, lastWarningSentAt: "2026-10-12T09:30:00.000Z" };
    renderWithTheme(VacationAbsenceTab, props({ vacation: vacation([year(2026, [warned])]) }));
    expect(verfallCell().textContent).toContain("Hinweis am 12.10.2026");
  });

  it("shows a dash for a row without risk and no notice line", () => {
    renderWithTheme(VacationAbsenceTab, props());
    expect(verfallCell().textContent?.trim()).toBe("—");
  });

  it("offers „Hinweis senden“ only with report:notify, at-risk days and a deadline of today or later", () => {
    const rows = [
      vrow("A", { atRiskDays: 3, carryOverDeadline: "2026-10-15" }), // today: offered
      vrow("B", { atRiskDays: 3, carryOverDeadline: "2026-10-14" }), // yesterday
      vrow("C", { atRiskDays: 0, carryOverDeadline: "2027-03-31" }), // nothing at risk
      vrow("D", { atRiskDays: 3, carryOverDeadline: null }), // no deadline
      missing("M"),
    ];
    const { unmount } = renderWithTheme(
      VacationAbsenceTab,
      props({ vacation: vacation([year(2026, rows)]) }),
    );
    expect(screen.getAllByRole("button", { name: /^Hinweis senden an / })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Hinweis senden an Person A" })).toBeTruthy();
    unmount();
    renderWithTheme(
      VacationAbsenceTab,
      props({ vacation: vacation([year(2026, rows)]), canNotify: false }),
    );
    expect(screen.queryByRole("button", { name: /^Hinweis senden an / })).toBeNull();
  });

  it("sends the notice for the entitlement and reports it", async () => {
    const onNotify = vi.fn().mockResolvedValue({ warned: 1, skippedDedup: 0 });
    renderWithTheme(
      VacationAbsenceTab,
      props({ vacation: vacation([year(2026, [AT_RISK])]), onNotify }),
    );
    await fireEvent.click(screen.getByRole("button", { name: "Hinweis senden an Person A" }));
    expect(onNotify).toHaveBeenCalledWith("ent-A");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Hinweis gesendet"),
    );
    // the new notice is shown without re-reading anything
    expect(verfallCell().textContent).toContain("Hinweis am 15.10.2026");
  });

  it("says when the notice was already sent today", async () => {
    const onNotify = vi.fn().mockResolvedValue({ warned: 0, skippedDedup: 1 });
    renderWithTheme(
      VacationAbsenceTab,
      props({ vacation: vacation([year(2026, [AT_RISK])]), onNotify }),
    );
    await fireEvent.click(screen.getByRole("button", { name: "Hinweis senden an Person A" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Hinweis wurde heute schon gesendet",
      ),
    );
  });

  it("shows the error text when sending fails", async () => {
    const onNotify = vi.fn().mockRejectedValue(new Error("boom"));
    renderWithTheme(
      VacationAbsenceTab,
      props({ vacation: vacation([year(2026, [AT_RISK])]), onNotify }),
    );
    await fireEvent.click(screen.getByRole("button", { name: "Hinweis senden an Person A" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Hinweis konnte nicht gesendet werden.",
      ),
    );
  });

  // Issue #940: a passed deadline without a Hinweis keeps the carry-over; the cell says so.
  it("names a carry-over kept after its deadline (no Hinweis) instead of a dash, with the callout", () => {
    const kept = vrow("A", {
      atRiskDays: 0,
      carriedOverDays: 24,
      carriedOverEffectiveDays: 24,
      carryOverKeptWithoutNoticeDays: 24,
      carryOverDeadline: "2026-03-31",
    });
    renderWithTheme(VacationAbsenceTab, props({ vacation: vacation([year(2026, [kept])]) }));
    expect(verfallCell().textContent).toContain(
      "Frist 31.03.2026 vorbei, ohne Hinweis kein Verfall",
    );
    expect(screen.queryByTestId("vacation-eugh-callout")).not.toBeNull();
  });

  it("shows the EuGH callout when any row is at risk, and not otherwise", () => {
    const { unmount } = renderWithTheme(
      VacationAbsenceTab,
      props({ vacation: vacation([year(2026, [AT_RISK])]) }),
    );
    const callout = screen.queryByTestId("vacation-eugh-callout");
    expect(callout?.textContent).toContain(
      "Hinweispflicht: Mitarbeiter müssen gemäß EuGH C-684/16",
    );
    expect(callout?.querySelector("strong")?.textContent).toBe("nicht");
    unmount();
    renderWithTheme(VacationAbsenceTab, props());
    expect(screen.queryByTestId("vacation-eugh-callout")).toBeNull();
  });
});

describe("VacationAbsenceTab - narrow containers (cards)", () => {
  it("is one table DOM at every width: the cells carry their column label, the notice button is not nested in the link", async () => {
    const onNotify = vi.fn().mockResolvedValue({ warned: 1, skippedDedup: 0 });
    const at = vrow("A", { atRiskDays: 3, carryOverDeadline: "2027-03-31" });
    const { container } = renderWithTheme(
      VacationAbsenceTab,
      props({ vacation: vacation([year(2026, [at, vrow("B")])]), onNotify }),
    );
    const rows = within(vacTable()).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(
      Array.from(rows[0].querySelectorAll("td")).map((td) => td.getAttribute("data-label")),
    ).toEqual(["Person", ...VACATION_YEAR_COLUMNS, "Verfall"]);
    expect(rows[0].textContent).toContain("3 T. bis 31.03.2027");
    expect(rows[1].textContent).not.toContain("Hinweis senden");
    const link = within(rows[0]).getByRole("link", { name: "Person A" });
    const button = within(rows[0]).getByRole("button", { name: "Hinweis senden an Person A" });
    expect(link.contains(button)).toBe(false);
    expect(container.querySelectorAll("a button, button button, a a, button a")).toHaveLength(0);
    await fireEvent.click(button);
    expect(onNotify).toHaveBeenCalledWith("ent-A");
    await waitFor(() =>
      expect(within(rows[0]).getByRole("status").textContent).toContain("Hinweis gesendet"),
    );
  });
});

describe("VacationAbsenceTab - Abwesenheiten nach Art", () => {
  it("lists one row per kind with its unit, persons and days", () => {
    renderWithTheme(VacationAbsenceTab, props());
    expect(screen.getByText("Abwesenheiten nach Art")).toBeTruthy();
    const table = screen.getByRole("table", { name: /Abwesenheiten nach Art/ });
    const rows = within(table).getAllByRole("row");
    expect(
      within(rows[0])
        .getAllByRole("columnheader")
        .map((h) => h.textContent?.trim()),
    ).toEqual(["Art", "Personen", "Tage"]);
    const cells = (r: HTMLElement) =>
      within(r)
        .getAllByRole("cell")
        .map((c) => c.textContent?.replace(/\s+/g, " ").trim());
    expect(cells(rows[1])).toEqual(["Urlaub (Arbeitstage)", "4", "12,5"]);
    expect(cells(rows[2])).toEqual(["Krank (Kalendertage)", "2", "6"]);
  });

  it("lists Krank and Kinderkrank as two lines by kind, each with the server's persons and days (Issue #713)", () => {
    renderWithTheme(
      VacationAbsenceTab,
      props({
        absences: [
          { code: "VACATION", unit: "WORKDAYS", personCount: 4, totalDays: 12.5 },
          { code: "SICK", unit: "CALENDAR_DAYS", personCount: 2, totalDays: 6 },
          { code: "SICK_CHILD", unit: "CALENDAR_DAYS", personCount: 1, totalDays: 3.5 },
        ] satisfies PeriodAbsence[],
      }),
    );
    const table = screen.getByRole("table", { name: /Abwesenheiten nach Art/ });
    const rows = within(table).getAllByRole("row");
    const cells = (r: HTMLElement) =>
      within(r)
        .getAllByRole("cell")
        .map((c) => c.textContent?.replace(/\s+/g, " ").trim());
    expect(rows).toHaveLength(4);
    expect(cells(rows[2])).toEqual(["Krank (Kalendertage)", "2", "6"]);
    expect(cells(rows[3])).toEqual(["Kinderkrank (Kalendertage)", "1", "3,5"]);
    const dots = document.querySelectorAll<HTMLElement>("span.type-dot");
    expect(dots[2].getAttribute("style")).toContain("--type-color: var(--leave-type-sick-child)");
  });

  it("colours the kind dot through --type-color from the kind's token, looked up by code", () => {
    renderWithTheme(VacationAbsenceTab, props());
    const dots = document.querySelectorAll<HTMLElement>("span.type-dot");
    expect(dots).toHaveLength(2);
    expect(dots[0].getAttribute("style")).toContain("--type-color: var(--leave-type-vacation)");
    expect(dots[1].getAttribute("style")).toContain("--type-color: var(--leave-type-sick)");
  });

  it("says so when the period holds no absence", () => {
    renderWithTheme(VacationAbsenceTab, props({ absences: [] }));
    expect(screen.getByText("Keine Abwesenheiten im Zeitraum.")).toBeTruthy();
  });

  // Owner decision #714: under a salon filter the persons are the Stammsalon circle with whole
  // personal values, so every absence kind of the answer is shown, exactly as without a filter.
  it("lists every absence kind of the Stammsalon persons under a salon filter", () => {
    renderWithTheme(VacationAbsenceTab, props({ filterActive: true }));
    const table = screen.getByRole("table", { name: /Abwesenheiten nach Art/ });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText(/Urlaub \(Arbeitstage\)/)).toBeTruthy();
    expect(within(table).getByText(/Krank \(Kalendertage\)/)).toBeTruthy();
    expect(screen.queryByText(/je Salon nicht ausgewiesen/)).toBeNull();
  });
});

describe("VacationAbsenceTab - salon filter notes (P-06)", () => {
  it("names who is listed and that the values are whole personal values", () => {
    renderWithTheme(VacationAbsenceTab, props({ filterActive: true }));
    const note = screen.getByTestId("vacation-salon-note");
    expect(note.textContent).toContain(SALON_PERIOD_END_PERSONS_NOTE);
    expect(note.textContent).toContain(PERSON_VALUES_NOT_SPLIT_LABEL);
  });

  it("shows no salon note without a filter", () => {
    renderWithTheme(VacationAbsenceTab, props());
    expect(screen.queryByTestId("vacation-salon-note")).toBeNull();
    expect(screen.queryByText(/je Salon nicht ausgewiesen/)).toBeNull();
  });
});

describe("VacationAbsenceTab - source", () => {
  it("[vacuity gate] the source is loaded", () => {
    expect(source.length).toBeGreaterThan(2000);
  });

  it("takes the column labels from the shared list and imports no $app module", () => {
    expect(source).toContain('from "$lib/reports/vacation-columns"');
    expect(source).toContain("VACATION_YEAR_COLUMNS.map(");
    expect(source).not.toMatch(/from "\$app\//);
  });

  it("labels absence kinds through LEAVE_TYPES by code, never by a display name", () => {
    expect(source).toContain("LEAVE_TYPES");
    expect(source).not.toMatch(/===\s*"(Urlaub|Krankmeldung|Krankheit)"/);
  });

  it("derives no figure: no reduce over rows", () => {
    expect(source).not.toContain("reduce(");
  });
});
