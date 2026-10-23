// Issue #714 (D-06, D-07, G7, G10) - the section „Im Salon gearbeitet“, mounted: the Stammsalon
// persons with salon hours, the Aushilfen of other salons, the server's total - and nothing that
// could be read as a saldo. lib/components/reports/ is outside the lint:ui-classes gate, so the
// structure is proven here. Synthetic names only.

import { describe, it, expect, vi, afterEach } from "vitest";

// page-scope reaches the api client and its auth store; a stand-in keeps this mounted test free of it.
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
import { screen, within } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import {
  SALON_HELPERS_HEADING,
  SALON_HELPERS_REACH_NOTE,
  SALON_WORKED_LABEL,
} from "$lib/salons/page-scope";
import {
  PERIOD_PERSON_ABSENCE_CODES,
  type PeriodHelper,
  type PeriodRow,
} from "$lib/reports/period-report";
import SalonWorkedSection from "../SalonWorkedSection.svelte";
import source from "../SalonWorkedSection.svelte?raw";
import pageSource from "../../../../routes/(app)/reports/+page.svelte?raw";

function zeroAbsence(): PeriodRow["absence"] {
  return Object.fromEntries(
    PERIOD_PERSON_ABSENCE_CODES.map((code) => [code, 0]),
  ) as PeriodRow["absence"];
}

function row(id: string, salonWorkedMinutes: number | undefined): PeriodRow {
  return {
    employeeId: id,
    employeeName: `Person ${id}`,
    employeeNumber: `N-${id}`,
    hasRecordedTime: true,
    exitDay: null,
    workedMinutes: 9600,
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
    // Issue #713: the server always sends the ten counts; the zero object keeps these fixtures neutral.
    absence: zeroAbsence(),
    months: [],
    ...(salonWorkedMinutes === undefined ? {} : { salonWorkedMinutes }),
  };
}

function helper(id: string, salonWorkedMinutes: number): PeriodHelper {
  return {
    employeeId: id,
    employeeName: `Aushilfe ${id}`,
    employeeNumber: `H-${id}`,
    salonWorkedMinutes,
  };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    rows: [row("A", 4800), row("B", 0), row("C", 600)],
    helpers: [helper("X", 1200), helper("Y", 90)],
    totalMinutes: 6690,
    helpersReach: "WHOLE_TENANT" as const,
    periodLabel: "Jul – Sep 2026",
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("SalonWorkedSection - groups and total", () => {
  it("heads the section with the salon-hours label and the period", () => {
    renderWithTheme(SalonWorkedSection, props());
    expect(screen.getByText(SALON_WORKED_LABEL)).toBeTruthy();
    expect(screen.getByText("Jul – Sep 2026")).toBeTruthy();
  });

  it("lists only the Stammsalon persons with salon hours above zero, name, number and hours", () => {
    renderWithTheme(SalonWorkedSection, props());
    const own = screen.getByTestId("salon-worked-own");
    const rows = within(own).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Person A");
    expect(rows[0]).toHaveTextContent("N-A");
    expect(rows[0]).toHaveTextContent("80:00");
    expect(rows[1]).toHaveTextContent("Person C");
    expect(rows[1]).toHaveTextContent("10:00");
    expect(own).not.toHaveTextContent("Person B");
  });

  it("lists every helper under the Aushilfen heading with name, number and hours", () => {
    renderWithTheme(SalonWorkedSection, props());
    expect(screen.getByRole("heading", { name: SALON_HELPERS_HEADING })).toBeTruthy();
    const rows = within(screen.getByTestId("salon-worked-helpers")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Aushilfe X");
    expect(rows[0]).toHaveTextContent("20:00");
    expect(rows[1]).toHaveTextContent("Aushilfe Y");
    expect(rows[1]).toHaveTextContent("1:30");
  });

  it("shows the server's total as is - not the sum of the listed rows (T-714-15)", () => {
    // 80:00 + 10:00 + 20:00 + 1:30 = 111:30, the prop says 111:30 + 0:07 on purpose.
    renderWithTheme(SalonWorkedSection, props({ totalMinutes: 6697 }));
    expect(screen.getByTestId("salon-worked-total")).toHaveTextContent("Summe");
    expect(screen.getByTestId("salon-worked-total")).toHaveTextContent("111:37 h");
  });
});

describe("SalonWorkedSection - nothing a saldo can be read from (D-06, G10, T-714-14)", () => {
  it("renders no link, no Soll, no saldo and no status", () => {
    const { container } = renderWithTheme(SalonWorkedSection, props());
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector(".chip")).toBeNull();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/Saldo/);
    expect(text).not.toMatch(/Soll/);
    expect(text).not.toMatch(/Bestätigt|Prognose/);
  });

  it("only two columns: person and hours, in a table-wrap", () => {
    renderWithTheme(SalonWorkedSection, props());
    for (const id of ["salon-worked-own", "salon-worked-helpers"]) {
      const table = screen.getByTestId(id);
      expect(within(table).getAllByRole("columnheader")).toHaveLength(2);
      expect(table.closest(".table-wrap")).not.toBeNull();
    }
  });
});

describe("SalonWorkedSection - reach note and empty states", () => {
  it("a SCOPED reach says that helpers from salons outside the reach do not appear", () => {
    renderWithTheme(SalonWorkedSection, props({ helpersReach: "SCOPED" }));
    expect(screen.getByTestId("salon-worked-reach-note").textContent).toBe(
      SALON_HELPERS_REACH_NOTE,
    );
  });

  it("a WHOLE_TENANT reach (or none) says nothing", () => {
    renderWithTheme(SalonWorkedSection, props());
    expect(screen.queryByTestId("salon-worked-reach-note")).toBeNull();
  });

  it("no helpers: a calm line under the sub-heading, the Stammsalon table stays", () => {
    renderWithTheme(SalonWorkedSection, props({ helpers: [], totalMinutes: 5400 }));
    expect(screen.getByText("Keine Aushilfen aus anderen Salons im Zeitraum.")).toBeTruthy();
    expect(screen.queryByTestId("salon-worked-helpers")).toBeNull();
    expect(screen.getByTestId("salon-worked-own")).toBeTruthy();
  });

  it("nobody with hours at all: the empty state, no tables, no total", () => {
    renderWithTheme(
      SalonWorkedSection,
      props({ rows: [row("A", 0), row("B", undefined)], helpers: [], totalMinutes: 0 }),
    );
    expect(screen.getByText("Im Zeitraum hat niemand in diesem Salon gearbeitet.")).toBeTruthy();
    expect(screen.queryByTestId("salon-worked-own")).toBeNull();
    expect(screen.queryByTestId("salon-worked-helpers")).toBeNull();
    expect(screen.queryByTestId("salon-worked-total")).toBeNull();
  });

  it("only helpers worked: the Stammsalon group says so calmly", () => {
    renderWithTheme(SalonWorkedSection, props({ rows: [row("A", 0)], totalMinutes: 1290 }));
    expect(
      screen.getByText("Niemand aus diesem Salon hat im Zeitraum Stunden im Salon."),
    ).toBeTruthy();
    expect(screen.getByTestId("salon-worked-helpers")).toBeTruthy();
  });
});

describe("SalonWorkedSection - source and page wiring", () => {
  it("[vacuity gate] the sources are non-empty", () => {
    expect(source.length).toBeGreaterThan(1500);
    expect(pageSource.length).toBeGreaterThan(5000);
  });

  it("the component imports no navigation or API client, sums nothing and has no link", () => {
    expect(source).not.toContain("$app/");
    expect(source).not.toContain("$api/");
    expect(source).not.toMatch(/\.reduce\(/);
    expect(source).not.toContain("<a ");
    expect(source).not.toContain("href");
  });

  it("the page renders the section only inside the zeiten tab, only when the answer carries helpers, with the server's total", () => {
    const start = pageSource.indexOf('{#if activeTab === "zeiten"}');
    const end = pageSource.indexOf('{:else if activeTab === "urlaub"}');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const zeiten = pageSource.slice(start, end);
    expect(zeiten).toContain("<SalonWorkedSection");
    expect(zeiten).toMatch(/\{#if period\?\.helpers !== undefined\}/);
    expect(zeiten).toContain("period.kpis.salonWorkedMinutes");
    expect(zeiten.indexOf("<TimesAccountsTable")).toBeLessThan(
      zeiten.indexOf("<SalonWorkedSection"),
    );
    expect(pageSource.match(/<SalonWorkedSection/g)).toHaveLength(1);
  });
});
