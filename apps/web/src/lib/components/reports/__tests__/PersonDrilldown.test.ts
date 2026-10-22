// Issue #612 (D-612-4, ADD-4, P-13, T-612-20, amendments 6 and 7) - the person drill-down, mounted.
// lib/components/reports/ is outside the lint:ui-classes gate (CLAUDE.md), so the month series, the
// day list by permission, the person documents by permission and the closing saldo are proven
// here. The component imports no API client: the day list is injected, which is also what lets the
// "no request without time-entry:read" rule be measured (the injected loader is never called).

import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, fireEvent, within, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import {
  PERIOD_PERSON_ABSENCE_CODES,
  type PeriodMonth,
  type PeriodRow,
  type PeriodVacationRow,
} from "$lib/reports/period-report";
import PersonDrilldown from "../PersonDrilldown.svelte";
import source from "../PersonDrilldown.svelte?raw";

function month(m: number, extra: Partial<PeriodMonth> = {}): PeriodMonth {
  return {
    year: 2026,
    month: m,
    workedMinutes: 9600, // 160:00
    expectedMinutes: 9600,
    balanceMinutes: 0,
    closingBalanceMinutes: 60,
    confirmed: false,
    labelled: true,
    sickDays: 0,
    ...extra,
  };
}

function zeroAbsence(): PeriodRow["absence"] {
  return Object.fromEntries(
    PERIOD_PERSON_ABSENCE_CODES.map((code) => [code, 0]),
  ) as PeriodRow["absence"];
}

function row(extra: Partial<PeriodRow> = {}): PeriodRow {
  return {
    employeeId: "emp-1",
    employeeName: "Person A",
    employeeNumber: "0042",
    hasRecordedTime: true,
    exitDay: null,
    workedMinutes: 28800, // 480:00
    expectedMinutes: 28500, // 475:00
    balanceMinutes: 300, // +5:00
    openingBalanceMinutes: 60,
    closingBalanceMinutes: 735, // +12:15
    closingConfirmedMinutes: 600,
    closingOpenMinutes: 135,
    unconfirmedMonths: 2,
    monthCount: 3,
    confirmedMonthCount: 1,
    labelled: true,
    sickDays: 0,
    // Issue #713: the server always sends the ten counts; the zero object keeps these fixtures neutral.
    absence: zeroAbsence(),
    months: [
      month(7, { confirmed: true, closingBalanceMinutes: 600 }),
      month(8),
      month(9, { balanceMinutes: 135, closingBalanceMinutes: 735 }),
    ],
    ...extra,
  };
}

const VACATION: PeriodVacationRow = {
  employeeId: "emp-1",
  employeeName: "Person A",
  employeeNumber: "0042",
  year: 2026,
  entitlementId: "ent-1",
  entitlementDays: 30,
  carriedOverDays: 0,
  carriedOverEffectiveDays: 0,
  carriedOverExpiredDays: 0,
  exitReductionDays: 0,
  availableDays: 30,
  takenDays: 12,
  approvedUpcomingDays: 5,
  pendingDays: 2,
  remainingDays: 13,
  atRiskDays: 0,
  carryOverDeadline: null,
  lastWarningSentAt: null,
  missingEntitlement: false,
  entitlementWarning: null,
};

/** A local-time ISO instant, so the expectations do not depend on the runner's time zone. */
const at = (d: number, h: number, min: number, m = 8) => new Date(2026, m, d, h, min).toISOString();

const ENTRIES = [
  {
    id: "e1",
    date: "2026-09-07",
    startTime: at(7, 8, 0),
    endTime: at(7, 12, 0),
    breakMinutes: 0,
    isInvalid: false,
    invalidReason: null,
    salonName: "Nord",
    presenceMinutes: 240,
    workingMinutes: 240,
  },
  {
    id: "e2",
    date: "2026-09-07",
    startTime: at(7, 13, 0),
    endTime: at(7, 16, 30),
    breakMinutes: 30,
    isInvalid: false,
    invalidReason: null,
    salonName: "Nord",
    presenceMinutes: 210,
    workingMinutes: 180,
  },
  {
    id: "e3",
    date: "2026-09-08",
    startTime: at(8, 9, 0),
    endTime: null,
    breakMinutes: 0,
    salonName: "Süd",
    presenceMinutes: null,
    workingMinutes: null,
  },
  {
    id: "e4",
    date: "2026-09-09",
    startTime: at(9, 9, 0),
    endTime: at(9, 10, 0),
    breakMinutes: 0,
    isInvalid: true,
    invalidReason: "Urlaubsstornierung ausstehend",
    salonName: "Süd",
    presenceMinutes: 60,
    workingMinutes: 60,
  },
  {
    id: "e5",
    date: "2026-09-10",
    startTime: at(10, 10, 0),
    endTime: at(10, 10, 45),
    breakMinutes: 0,
    activityKind: "TRAVEL",
    salonName: "Nord",
    travelToSalonName: "Süd",
    presenceMinutes: 45,
    workingMinutes: 45,
  },
];

function props(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    row: row(),
    vacationRow: VACATION,
    periodLabel: "Jul – Sep 2026",
    canTimeEntryRead: true,
    canReportExport: true,
    showSalonColumn: true,
    loadDayEntries: vi.fn().mockResolvedValue(ENTRIES),
    onDownloadPdf: vi.fn().mockResolvedValue(undefined),
    onDownloadDatev: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...overrides,
  };
}

function viewport(narrow640: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: narrow640 && query.includes("640"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// The phrase the HR e2e matches by regex (hr-view-86.spec.ts), spelled in two halves so that
// this directory holds the literal nowhere (the rendered text must not contain it either).
const HR_E2E_PHRASE = ["PDF", "herunterladen"].join(" ");

describe("PersonDrilldown - header and figures", () => {
  it("names the person, the number and the period; four figures in the copy-deck order", async () => {
    viewport(false);
    renderWithTheme(PersonDrilldown, props());
    expect(screen.getByRole("dialog", { name: "Person A" })).toBeInTheDocument();
    expect(screen.getByText("Personenansicht")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Person A" })).toBeInTheDocument();
    expect(screen.getByText("Personalnr. 0042 · Jul – Sep 2026")).toBeInTheDocument();
    const stats = [...document.querySelectorAll(".mini-stat")].map((el) => [
      el.querySelector(".label")?.textContent,
      el.querySelector(".value")?.textContent?.trim(),
    ]);
    expect(stats).toEqual([
      ["Soll", "475:00"],
      ["Ist", "480:00"],
      ["Saldo Zeitraum", "+5:00"],
      ["Saldo am Ende", "+12:15"],
    ]);
    await waitFor(() => expect(screen.queryByText("Wird geladen")).toBeNull());
  });

  it("a withheld saldo reads a dash in the figures and shows no SaldoAnzeige", () => {
    viewport(false);
    renderWithTheme(
      PersonDrilldown,
      props({
        row: row({
          expectedMinutes: null,
          balanceMinutes: null,
          openingBalanceMinutes: null,
          closingBalanceMinutes: null,
          closingConfirmedMinutes: null,
          closingOpenMinutes: null,
          unconfirmedMonths: null,
          sollUnavailableReason: "NO_PERMISSION",
          months: [
            month(9, {
              expectedMinutes: null,
              balanceMinutes: null,
              closingBalanceMinutes: null,
            }),
          ],
          monthCount: 1,
          confirmedMonthCount: 0,
        }),
      }),
    );
    const values = [...document.querySelectorAll(".mini-stat .value")].map((e) =>
      e.textContent?.trim(),
    );
    expect(values[0]).toContain("—");
    expect(values[1]).toContain("480:00");
    expect(values[2]).toContain("—");
    expect(values[3]).toContain("—");
    expect(screen.queryByTestId("saldo-anzeige")).toBeNull();
  });
});

describe("PersonDrilldown - the month series", () => {
  it("lists the months by their server names with Soll, Ist, Saldo and a status chip", () => {
    viewport(false);
    renderWithTheme(PersonDrilldown, props());
    const table = screen.getByRole("table", { name: /Monate/ });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByRole("button", { name: "Juli 2026" })).toBeInTheDocument();
    expect(within(rows[1]).getByRole("button", { name: "August 2026" })).toBeInTheDocument();
    expect(within(rows[2]).getByRole("button", { name: "September 2026" })).toBeInTheDocument();
    const cells = within(rows[2]).getAllByRole("cell");
    expect(cells.map((c) => c.textContent?.trim())).toEqual([
      expect.stringContaining("September 2026"),
      "160:00",
      "160:00",
      "+2:15",
      expect.stringContaining("Prognose"),
    ]);
    expect(within(rows[0]).getByText("Bestätigt")).toHaveClass("chip");
    expect(within(rows[1]).getByText("Prognose")).toHaveClass("chip");
  });

  it("selects the last month by default and moves the selection on a click", async () => {
    viewport(false);
    const p = props();
    renderWithTheme(PersonDrilldown, p);
    expect(screen.getByRole("button", { name: "September 2026" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Juli 2026" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await waitFor(() => expect(p.loadDayEntries).toHaveBeenCalledTimes(1));
    expect(p.loadDayEntries).toHaveBeenCalledWith("emp-1", "2026-09-01", "2026-09-30");
    await fireEvent.click(screen.getByRole("button", { name: "Juli 2026" }));
    expect(screen.getByRole("button", { name: "Juli 2026" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() => expect(p.loadDayEntries).toHaveBeenCalledTimes(2));
    expect(p.loadDayEntries).toHaveBeenLastCalledWith("emp-1", "2026-07-01", "2026-07-31");
    expect(screen.getByRole("heading", { name: "Tage im Juli 2026" })).toBeInTheDocument();
  });

  it("a month without a Soll reads ohne Soll, a withheld month figure a dash", () => {
    viewport(false);
    renderWithTheme(
      PersonDrilldown,
      props({
        row: row({
          months: [month(9, { labelled: false, expectedMinutes: null, balanceMinutes: null })],
          monthCount: 1,
        }),
      }),
    );
    const cells = within(screen.getByRole("table", { name: /Monate/ })).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("—");
    expect(cells[4]).toHaveTextContent("ohne Soll");
  });

  it("a new period (new row) resets the selection to its last month", async () => {
    viewport(false);
    const p = props();
    const view = renderWithTheme(PersonDrilldown, p);
    await fireEvent.click(screen.getByRole("button", { name: "Juli 2026" }));
    await view.rerender({
      ...p,
      row: row({ months: [month(10), month(11)], monthCount: 2 }),
    });
    expect(screen.getByRole("button", { name: "November 2026" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows the vacation line of the period-end year", () => {
    viewport(false);
    renderWithTheme(PersonDrilldown, props());
    expect(
      screen.getByText("Urlaubsjahr 2026: Anspruch 30 · Genommen 12 · Genehmigt 5 · Resturlaub 13"),
    ).toBeInTheDocument();
  });

  it("a missing entitlement is named instead of zeros, no vacation row hides the line", () => {
    viewport(false);
    const view = renderWithTheme(
      PersonDrilldown,
      props({
        vacationRow: { ...VACATION, missingEntitlement: true, entitlementDays: null },
      }),
    );
    expect(screen.getByText("Urlaubsjahr 2026: kein Anspruch hinterlegt")).toBeInTheDocument();
    view.unmount();
    renderWithTheme(PersonDrilldown, props({ vacationRow: null }));
    expect(screen.queryByText(/Urlaubsjahr 2026/)).toBeNull();
  });
});

describe("PersonDrilldown - the day list (only with time-entry:read)", () => {
  it("renders one row per entry; the date only on the first of a day; no totals row", async () => {
    viewport(false);
    renderWithTheme(PersonDrilldown, props());
    const table = await screen.findByRole("table", { name: /Tage im September 2026/ });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    const text = (r: HTMLElement) =>
      within(r)
        .getAllByRole("cell")
        .map((c) => c.textContent?.replace(/\s+/g, " ").trim());
    expect(text(rows[0])).toEqual(["Mo 07.09.", "08:00–12:00", "0:00", "4:00", "Nord"]);
    expect(text(rows[1])).toEqual(["", "13:00–16:30", "0:30", "3:00", "Nord"]);
    expect(within(table).queryByRole("row", { name: /Summe|Gesamt/i })).toBeNull();
    expect(table.textContent).not.toMatch(/Summe|Gesamt|Total/);
  });

  it("an open entry is „läuft“, an invalid one „zählt nicht“ with its reason, a trip names both salons", async () => {
    viewport(false);
    renderWithTheme(PersonDrilldown, props());
    const table = await screen.findByRole("table", { name: /Tage im September 2026/ });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[2]).getByText("läuft")).toHaveClass("chip");
    expect(within(rows[2]).getAllByRole("cell")[3]).toHaveTextContent("—");
    const invalid = within(rows[3]).getByText("zählt nicht");
    expect(invalid).toHaveClass("chip");
    expect(invalid).toHaveAttribute("title", "Urlaubsstornierung ausstehend");
    expect(within(rows[4]).getByText("Fahrt: Nord → Süd")).toBeInTheDocument();
  });

  it("the Salon column exists only when salon options are shown", async () => {
    viewport(false);
    renderWithTheme(PersonDrilldown, props({ showSalonColumn: false }));
    const table = await screen.findByRole("table", { name: /Tage im September 2026/ });
    expect(within(table).queryByRole("columnheader", { name: "Salon" })).toBeNull();
    expect(within(table).getAllByRole("row")[1].querySelectorAll("td")).toHaveLength(4);
  });

  it("links to Team-Zeiten at the first day of the selected month", async () => {
    viewport(false);
    renderWithTheme(PersonDrilldown, props());
    await screen.findByRole("table", { name: /Tage im September 2026/ });
    expect(screen.getByRole("link", { name: "In Team-Zeiten öffnen" })).toHaveAttribute(
      "href",
      "/team/time-entries?employeeId=emp-1&date=2026-09-01",
    );
  });

  it("at 640 px and below the days are a list of one line per entry, still without totals", async () => {
    viewport(true);
    renderWithTheme(PersonDrilldown, props());
    const list = await screen.findByRole("list", { name: /Tage im September 2026/ });
    expect(within(list).queryByRole("table")).toBeNull();
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent("Mo 07.09. · 08:00–12:00 · Pause 0:00 · 4:00 h");
    expect(items[0]).toHaveTextContent("Nord");
    expect(items[1]).toHaveTextContent("13:00–16:30 · Pause 0:30 · 3:00 h");
    expect(list.textContent).not.toMatch(/Summe|Gesamt/);
  });

  it("an empty month says so", async () => {
    viewport(false);
    renderWithTheme(PersonDrilldown, props({ loadDayEntries: vi.fn().mockResolvedValue([]) }));
    expect(await screen.findByText("Keine Einträge in diesem Monat.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: /Tage im/ })).toBeNull();
  });

  it("a failed read shows the error with Erneut laden, which asks again", async () => {
    viewport(false);
    const loadDayEntries = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(ENTRIES);
    renderWithTheme(PersonDrilldown, props({ loadDayEntries }));
    expect(
      await screen.findByText("Die Einträge konnten nicht geladen werden."),
    ).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Erneut laden" }));
    expect(
      await screen.findByRole("table", { name: /Tage im September 2026/ }),
    ).toBeInTheDocument();
    expect(loadDayEntries).toHaveBeenCalledTimes(2);
  });

  it("only the latest month's answer is shown when the selection changes while a read is open", async () => {
    viewport(false);
    let resolveSeptember: (v: unknown) => void = () => {};
    const loadDayEntries = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSeptember = resolve)))
      .mockResolvedValueOnce([
        { ...ENTRIES[2], id: "jul", date: "2026-07-01", salonName: "Juli-Salon" },
      ]);
    renderWithTheme(PersonDrilldown, props({ loadDayEntries }));
    await fireEvent.click(screen.getByRole("button", { name: "Juli 2026" }));
    await screen.findByText("Juli-Salon");
    resolveSeptember(ENTRIES); // the stale answer arrives late and must not replace July
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText("Juli-Salon")).toBeInTheDocument();
    expect(screen.queryByText("Fahrt: Nord → Süd")).toBeNull();
  });

  it("WITHOUT time-entry:read no request is made and one hint line replaces the list (T-612-20)", async () => {
    viewport(false);
    const p = props({ canTimeEntryRead: false });
    renderWithTheme(PersonDrilldown, p);
    expect(
      screen.getByText("Die Tagesliste ist nur mit Leserecht auf Zeiteinträge sichtbar."),
    ).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Juli 2026" }));
    await Promise.resolve();
    expect(p.loadDayEntries).not.toHaveBeenCalled();
    expect(screen.queryByRole("table", { name: /Tage im/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "In Team-Zeiten öffnen" })).toBeNull();
  });
});

describe("PersonDrilldown - the person documents (only with report:export)", () => {
  it("offers DATEV (Person) and Stundennachweis (PDF) for the selected month with the copy-deck names", async () => {
    viewport(false);
    const p = props();
    renderWithTheme(PersonDrilldown, p);
    const pdf = screen.getByRole("button", {
      name: "Stundennachweis September 2026 für Person A (PDF)",
    });
    const datev = screen.getByRole("button", { name: "DATEV-Datei September 2026 für Person A" });
    expect(pdf).toHaveTextContent("Stundennachweis (PDF)");
    expect(datev).toHaveTextContent("DATEV (Person)");
    await fireEvent.click(pdf);
    expect(p.onDownloadPdf).toHaveBeenCalledWith({ year: 2026, month: 9 });
    await fireEvent.click(datev);
    expect(p.onDownloadDatev).toHaveBeenCalledWith({ year: 2026, month: 9 });
    await fireEvent.click(screen.getByRole("button", { name: "Juli 2026" }));
    await fireEvent.click(
      screen.getByRole("button", { name: "Stundennachweis Juli 2026 für Person A (PDF)" }),
    );
    expect(p.onDownloadPdf).toHaveBeenLastCalledWith({ year: 2026, month: 7 });
  });

  it("the forbidden word sequence never occurs", () => {
    viewport(false);
    renderWithTheme(PersonDrilldown, props());
    expect(document.body.textContent).not.toContain(HR_E2E_PHRASE);
    expect(source).not.toContain(HR_E2E_PHRASE);
  });

  it("without report:export neither button renders", () => {
    viewport(false);
    renderWithTheme(PersonDrilldown, props({ canReportExport: false }));
    expect(screen.queryByText("Stundennachweis (PDF)")).toBeNull();
    expect(screen.queryByText("DATEV (Person)")).toBeNull();
    expect(screen.getByRole("button", { name: "Schließen" })).toBeInTheDocument();
  });

  it("a button keeps its label and shows a spinner while its download runs", async () => {
    viewport(false);
    let finish: () => void = () => {};
    const onDownloadPdf = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    renderWithTheme(PersonDrilldown, props({ onDownloadPdf }));
    const button = screen.getByRole("button", {
      name: "Stundennachweis September 2026 für Person A (PDF)",
    });
    await fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(within(button).getByRole("status")).toBeInTheDocument();
    expect(button).toHaveTextContent("Stundennachweis (PDF)");
    finish();
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});

describe("PersonDrilldown - the closing saldo (P-13, amendment 7)", () => {
  it("an open month after a closed one: split mode with the unconfirmed months passed on", () => {
    viewport(false);
    renderWithTheme(PersonDrilldown, props());
    const anzeige = screen.getByTestId("saldo-anzeige");
    expect(anzeige).toHaveClass("saldo--split");
    expect(anzeige).toHaveTextContent("+10:00"); // confirmed
    expect(anzeige).toHaveTextContent("+2:15"); // forecast part
    // 2 unconfirmed months after a closed one: wording of the one forecast rule.
    expect(anzeige).toHaveTextContent("Seit Monatsabschluss (Prognose)");
  });

  it("the server cannot split it: the single value, worded as a forecast", () => {
    viewport(false);
    renderWithTheme(
      PersonDrilldown,
      props({
        row: row({
          closingConfirmedMinutes: null,
          closingOpenMinutes: null,
          unconfirmedMonths: null,
        }),
      }),
    );
    const anzeige = screen.getByTestId("saldo-anzeige");
    expect(anzeige).not.toHaveClass("saldo--split");
    expect(anzeige).not.toHaveClass("saldo--locked");
    expect(anzeige).toHaveTextContent("+12:15");
    expect(anzeige).toHaveTextContent("(Prognose)");
  });

  it("the last month confirmed: the single value as confirmed (locked)", () => {
    viewport(false);
    renderWithTheme(
      PersonDrilldown,
      props({
        row: row({
          closingBalanceMinutes: 600,
          closingConfirmedMinutes: 600,
          closingOpenMinutes: 0,
          unconfirmedMonths: 0,
          monthCount: 3,
          confirmedMonthCount: 3,
          months: [
            month(7, { confirmed: true }),
            month(8, { confirmed: true }),
            month(9, { confirmed: true, closingBalanceMinutes: 600 }),
          ],
        }),
      }),
    );
    const anzeige = screen.getByTestId("saldo-anzeige");
    expect(anzeige).not.toHaveClass("saldo--split");
    expect(anzeige).toHaveClass("saldo--locked");
    expect(anzeige).toHaveTextContent("+10:00");
  });
});

describe("PersonDrilldown - the saldo tooltip stays inside the modal on a phone (e2e matrix finding)", () => {
  it("the saldo block is the anchor of its tooltip panel", () => {
    viewport(false);
    renderWithTheme(PersonDrilldown, props());
    const anzeige = screen.getByTestId("saldo-anzeige");
    expect(anzeige.closest(".drill-saldo")).not.toBeNull();
  });

  it("below 641 px the panel hangs from the block and spans its width", () => {
    const media = source.slice(source.indexOf("@media (max-width: 640px) {\n    .drill-saldo"));
    expect(media.indexOf(".drill-saldo {")).toBeGreaterThan(-1);
    const block = media.slice(0, media.indexOf("\n  }\n\n") + 4);
    expect(block).toMatch(/\.drill-saldo\s*\{\s*position:\s*relative/);
    expect(block).toMatch(/:global\(\.saldo-info-wrap\)\s*\{\s*position:\s*static/);
    expect(block).toMatch(/:global\(\.saldo-tooltip\)[^}]*left:\s*0[^}]*right:\s*0/);
  });
});

describe("PersonDrilldown - closing", () => {
  it("Schließen takes the initial focus and reports the close once", async () => {
    viewport(false);
    const p = props();
    renderWithTheme(PersonDrilldown, p);
    const close = screen.getByRole("button", { name: "Schließen" });
    expect(close).toHaveAttribute("data-autofocus");
    await fireEvent.click(close);
    await waitFor(() => expect(p.onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape closes it as well", async () => {
    viewport(false);
    const p = props();
    renderWithTheme(PersonDrilldown, p);
    await fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(p.onClose).toHaveBeenCalledTimes(1));
  });

  it("a drill-down that is not open renders nothing and asks for nothing", () => {
    viewport(false);
    const p = props({ open: false });
    renderWithTheme(PersonDrilldown, p);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(p.loadDayEntries).not.toHaveBeenCalled();
    expect(p.onClose).not.toHaveBeenCalled();
  });
});

describe("PersonDrilldown - source", () => {
  it("is non-empty and imports no $app module and no API client", () => {
    expect(source.length).toBeGreaterThan(3000);
    expect(source).not.toContain("$app/");
    expect(source).not.toContain("$api/");
  });

  it("passes the forecast data to the split SaldoAnzeige (#588 R8) and holds no forecast literal", () => {
    const tag = source.slice(source.indexOf("<SaldoAnzeige"));
    expect(tag.slice(0, tag.indexOf("/>"))).toMatch(/\bunconfirmedMonths\b/);
    expect(source).not.toContain("Laufender Monat (Prognose)");
    expect(source).not.toContain("Seit Monatsabschluss");
    expect(source).toMatch(/from "\$lib\/saldo\/forecast-label"/);
  });

  it("never reads a snapshot's periodStart and sums no figure", () => {
    expect(source).not.toContain("periodStart");
    expect(source).not.toMatch(/\.reduce\(/);
  });
});
