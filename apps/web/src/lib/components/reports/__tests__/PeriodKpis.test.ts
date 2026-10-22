// Issue #612 (D-612-3, AC-612-3, P-05, UI-SPEC "KPI card") - the eight period figures, mounted.
// lib/components/reports/ is outside the lint:ui-classes gate (CLAUDE.md), so order, formats,
// withheld states and notes are proven here. Pattern 3: the component formats server figures and
// adds nothing - the tiles are checked against hand-computed German strings, never against a sum.

import { describe, it, expect, vi } from "vitest";

// The shared salon texts come from page-scope, which pulls in the api client and the auth store; a
// stand-in (as in SalonScopeLabel.test.ts) keeps this file free of that bootstrap.
vi.mock("$api/client", () => ({
  api: { get: vi.fn() },
  ApiError: class ApiError extends Error {},
}));
vi.mock("$lib/utils/logger", () => ({ clientLogger: { warn: vi.fn(), error: vi.fn() } }));

import { screen, within } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import {
  HOME_SALON_CHANGE_NOTE,
  PERSON_SALDO_BY_HOME_SALON_LABEL,
  SALON_WORKED_DELTA_NOTE,
  SALON_WORKED_LABEL,
  withoutHomeSalonNote,
} from "$lib/salons/page-scope";
import type { PeriodKpis as Kpis } from "$lib/reports/period-report";
import PeriodKpis from "../PeriodKpis.svelte";
import source from "../PeriodKpis.svelte?raw";

function kpis(overrides: Partial<Kpis> = {}): Kpis {
  return {
    personCount: 24,
    saldoPersonCount: 24,
    workedMinutes: 230535, // 3.842:15
    expectedMinutes: 228000, // 3.800:00
    balanceMinutes: 765, // +12:45
    closingBalanceMinutes: 72270, // +1.204:30
    closingAsOf: "2026-09-30",
    closingConfirmed: true,
    allMonthsConfirmed: true,
    sickDays: 12.5,
    vacationYear: 2026,
    vacationAsOf: "2026-10-16",
    vacationTakenDays: 240,
    vacationApprovedDays: 35.5,
    vacationEntitlementDays: 720,
    ...overrides,
  };
}

const LABELS = [
  "Saldo im Zeitraum",
  "Gesamtsaldo am Ende",
  "Ist",
  "Soll",
  "Urlaub genommen",
  "Urlaub genehmigt",
  "Urlaubsanspruch",
  "Krankheitstage",
];

/**
 * The tile whose label is `label`: the figure and its unit joined by one space (the unit is its
 * own flex item, the visible gap comes from CSS), and the delta line as rendered text.
 */
function tile(label: string): { value: string; delta: string | null } {
  const article = screen.getByText(label, { selector: ".kpi-label" }).closest("article")!;
  const valueEl = article.querySelector(".kpi-value")!;
  const unit = valueEl.querySelector(".kpi-unit")?.textContent?.trim() ?? "";
  const figure = [...valueEl.childNodes]
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent)
    .join("")
    .trim();
  const delta = article.querySelector(".kpi-delta")?.textContent?.trim() ?? null;
  return { value: unit === "" ? figure : `${figure} ${unit}`, delta };
}

describe("PeriodKpis - the eight tiles", () => {
  it("renders eight tiles in the UI-SPEC order with the copy-deck labels", () => {
    const { container } = renderWithTheme(PeriodKpis, {
      kpis: kpis(),
      filterActive: false,
      loading: false,
    });
    const labels = [...container.querySelectorAll(".kpi-label")].map((e) => e.textContent);
    expect(labels).toEqual(LABELS);
  });

  it("formats hours from minutes (signed for the two saldo tiles) and days with one decimal comma", () => {
    renderWithTheme(PeriodKpis, { kpis: kpis(), filterActive: false, loading: false });
    expect(tile("Saldo im Zeitraum").value).toBe("+12:45 h");
    expect(tile("Gesamtsaldo am Ende").value).toBe("+1.204:30 h");
    expect(tile("Ist").value).toBe("3.842:15 h");
    expect(tile("Soll").value).toBe("3.800:00 h");
    expect(tile("Urlaub genommen").value).toBe("240 Tage");
    expect(tile("Urlaub genehmigt").value).toBe("35,5 Tage");
    expect(tile("Urlaubsanspruch").value).toBe("720 Tage");
    expect(tile("Krankheitstage").value).toBe("12,5 Tage");
  });

  it("a negative saldo carries U+2212 and a zero saldo the plus-minus sign", () => {
    renderWithTheme(PeriodKpis, {
      kpis: kpis({ balanceMinutes: -45, closingBalanceMinutes: 0 }),
      filterActive: false,
      loading: false,
    });
    expect(tile("Saldo im Zeitraum").value).toBe("−0:45 h");
    expect(tile("Gesamtsaldo am Ende").value).toBe("±0:00 h");
  });

  it("deltas of a fully confirmed period: bestätigt, Stand + bestätigt, vacation per P-05, Kalendertage", () => {
    renderWithTheme(PeriodKpis, { kpis: kpis(), filterActive: false, loading: false });
    expect(tile("Saldo im Zeitraum").delta).toBe("bestätigt");
    expect(tile("Gesamtsaldo am Ende").delta).toBe("Stand 30.09.2026 · bestätigt");
    expect(tile("Ist").delta).toBeNull();
    expect(tile("Soll").delta).toBeNull();
    expect(tile("Urlaub genommen").delta).toBe("bis 16.10.2026");
    expect(tile("Urlaub genehmigt").delta).toBe("nach 16.10.2026, Urlaubsjahr 2026");
    expect(tile("Urlaubsanspruch").delta).toBe("Urlaubsjahr 2026");
    expect(tile("Krankheitstage").delta).toBe("Kalendertage");
  });

  it("a period with an open month says Prognose in both saldo deltas and shows the forecast note", () => {
    renderWithTheme(PeriodKpis, {
      kpis: kpis({
        allMonthsConfirmed: false,
        closingConfirmed: false,
        closingAsOf: "2026-10-15",
      }),
      filterActive: false,
      loading: false,
    });
    expect(tile("Saldo im Zeitraum").delta).toBe("enthält Prognose");
    expect(tile("Gesamtsaldo am Ende").delta).toBe("Stand 15.10.2026 · Prognose");
    expect(screen.getByTestId("period-kpis-forecast-note")).toHaveTextContent(
      "Offene Monate sind eine Prognose und ändern sich bis zum Monatsabschluss.",
    );
  });

  it("a fully confirmed period shows no forecast note", () => {
    renderWithTheme(PeriodKpis, { kpis: kpis(), filterActive: false, loading: false });
    expect(screen.queryByTestId("period-kpis-forecast-note")).toBeNull();
  });
});

describe("PeriodKpis - withheld figures", () => {
  it("no overtime:read: the two saldo tiles and Soll read a dash with no unit and the reason as delta", () => {
    renderWithTheme(PeriodKpis, {
      kpis: kpis({
        expectedMinutes: null,
        balanceMinutes: null,
        closingBalanceMinutes: null,
        saldoPersonCount: 0,
      }),
      filterActive: false,
      loading: false,
    });
    for (const label of ["Saldo im Zeitraum", "Gesamtsaldo am Ende", "Soll"]) {
      expect(tile(label), label).toEqual({ value: "—", delta: "Keine Berechtigung" });
    }
    // The grid does not jump: still eight tiles, Ist and the vacation tiles keep their values.
    expect(tile("Ist").value).toBe("3.842:15 h");
    expect(document.querySelectorAll(".kpi-label")).toHaveLength(8);
    // Nobody is covered: the partial-coverage line does not appear.
    expect(screen.getByTestId("period-kpis-persons")).toHaveTextContent(/^Summe über 24 Personen$/);
  });

  it("under a salon filter without overtime:read the same tiles read the dash with Keine Berechtigung, never a salon reason", () => {
    renderWithTheme(PeriodKpis, {
      kpis: kpis({
        expectedMinutes: null,
        balanceMinutes: null,
        closingBalanceMinutes: null,
        saldoPersonCount: 0,
        salonWorkedMinutes: 4800,
      }),
      filterActive: true,
      withoutHomeSalonCount: 0,
      loading: false,
    });
    for (const label of ["Saldo im Zeitraum", "Gesamtsaldo am Ende", "Soll"]) {
      expect(tile(label), label).toEqual({ value: "—", delta: "Keine Berechtigung" });
    }
    expect(screen.queryByText("Nicht je Salon")).toBeNull();
  });
  it("no salon note and no salon-hours tile without a filter", () => {
    renderWithTheme(PeriodKpis, { kpis: kpis(), filterActive: false, loading: false });
    expect(screen.queryByTestId("period-kpis-salon-note")).toBeNull();
    expect(screen.queryByText(SALON_WORKED_LABEL, { selector: ".kpi-label" })).toBeNull();
    expect(document.querySelectorAll(".kpi-label")).toHaveLength(8);
  });
});

// Issue #714 (owner decision 19.10.2026): under a salon filter the card shows the whole sums of the
// persons by Stammsalon, with the hint; the hours worked in the salon are a separate tile with no
// saldo delta. The component formats server figures and sums nothing.
describe("PeriodKpis - under a salon filter (#714)", () => {
  const filtered = (overrides: Partial<Kpis> = {}, withoutHomeSalonCount = 2) =>
    renderWithTheme(PeriodKpis, {
      kpis: kpis({ salonWorkedMinutes: 4800, ...overrides }),
      filterActive: true,
      withoutHomeSalonCount,
      loading: false,
    });

  it("shows the server's whole-person Soll and saldo with the normal deltas", () => {
    filtered();
    expect(tile("Saldo im Zeitraum")).toEqual({ value: "+12:45 h", delta: "bestätigt" });
    expect(tile("Gesamtsaldo am Ende")).toEqual({
      value: "+1.204:30 h",
      delta: "Stand 30.09.2026 · bestätigt",
    });
    expect(tile("Soll")).toEqual({ value: "3.800:00 h", delta: null });
  });

  it("the callout names the circle, the mover rule and the persons without a Stammsalon", () => {
    filtered();
    const note = screen.getByTestId("period-kpis-salon-note");
    expect(note).toHaveClass("callout", "brand");
    expect(note).toHaveTextContent(PERSON_SALDO_BY_HOME_SALON_LABEL);
    expect(note).toHaveTextContent(HOME_SALON_CHANGE_NOTE);
    expect(note).toHaveTextContent(withoutHomeSalonNote(2));
  });

  it("leaves the remainder sentence out when nobody is without a Stammsalon", () => {
    filtered({}, 0);
    const note = screen.getByTestId("period-kpis-salon-note");
    expect(note).toHaveTextContent(PERSON_SALDO_BY_HOME_SALON_LABEL);
    expect(note).not.toHaveTextContent("ohne Stammsalon");
  });

  it("adds the salon hours as a ninth tile in its own grid row, with no saldo delta", () => {
    filtered();
    expect(document.querySelectorAll(".kpi-label")).toHaveLength(9);
    expect(tile(SALON_WORKED_LABEL)).toEqual({ value: "80:00 h", delta: SALON_WORKED_DELTA_NOTE });
    const article = screen
      .getByText(SALON_WORKED_LABEL, { selector: ".kpi-label" })
      .closest("article")!;
    const grid = article.parentElement!;
    expect(grid).toHaveClass("kpi-grid");
    expect(grid.querySelectorAll("article")).toHaveLength(1);
    expect(grid.previousElementSibling?.tagName).toBe("HR");
  });

  it("shows no salon-hours tile while the answer carries no salon hours", () => {
    filtered({ salonWorkedMinutes: undefined });
    expect(document.querySelectorAll(".kpi-label")).toHaveLength(8);
  });

  it("the skeleton keeps eight lines under a filter", () => {
    renderWithTheme(PeriodKpis, {
      kpis: null,
      filterActive: true,
      withoutHomeSalonCount: null,
      loading: true,
    });
    expect(screen.getByTestId("period-kpis-skeleton").querySelectorAll(".skeleton")).toHaveLength(
      8,
    );
  });
});

describe("PeriodKpis - person counts", () => {
  it("names the number of persons, singular for one", () => {
    renderWithTheme(PeriodKpis, {
      kpis: kpis({ personCount: 1, saldoPersonCount: 1 }),
      filterActive: false,
      loading: false,
    });
    expect(screen.getByTestId("period-kpis-persons")).toHaveTextContent("Summe über 1 Person");
    expect(screen.getByTestId("period-kpis-persons")).not.toHaveTextContent("Personen");
  });

  it("names the covered share when saldo is covered for fewer persons than listed", () => {
    renderWithTheme(PeriodKpis, {
      kpis: kpis({ personCount: 24, saldoPersonCount: 18 }),
      filterActive: false,
      loading: false,
    });
    const line = screen.getByTestId("period-kpis-persons");
    expect(line).toHaveTextContent("Summe über 24 Personen");
    expect(line).toHaveTextContent("Saldo: Summe über 18 von 24 Personen");
  });

  it("an empty period reads zeros, not dashes", () => {
    renderWithTheme(PeriodKpis, {
      kpis: kpis({
        personCount: 0,
        saldoPersonCount: 0,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        closingBalanceMinutes: 0,
        sickDays: 0,
        vacationTakenDays: 0,
        vacationApprovedDays: 0,
        vacationEntitlementDays: 0,
      }),
      filterActive: false,
      loading: false,
    });
    expect(tile("Ist").value).toBe("0:00 h");
    expect(tile("Krankheitstage").value).toBe("0 Tage");
    expect(screen.getByTestId("period-kpis-persons")).toHaveTextContent("Summe über 0 Personen");
  });
});

describe("PeriodKpis - loading", () => {
  it("first load: eight skeleton lines, aria-busy, no tiles", () => {
    renderWithTheme(PeriodKpis, { kpis: null, filterActive: false, loading: true });
    const root = screen.getByTestId("period-kpis");
    expect(root).toHaveAttribute("aria-busy", "true");
    expect(
      within(root).getByTestId("period-kpis-skeleton").querySelectorAll(".skeleton"),
    ).toHaveLength(8);
    expect(document.querySelectorAll(".kpi-label")).toHaveLength(0);
  });

  it("a later load keeps the old figures and marks the region busy", () => {
    renderWithTheme(PeriodKpis, { kpis: kpis(), filterActive: false, loading: true });
    expect(screen.getByTestId("period-kpis")).toHaveAttribute("aria-busy", "true");
    expect(document.querySelectorAll(".kpi-label")).toHaveLength(8);
    expect(screen.queryByTestId("period-kpis-skeleton")).toBeNull();
  });

  it("settled: not busy", () => {
    renderWithTheme(PeriodKpis, { kpis: kpis(), filterActive: false, loading: false });
    expect(screen.getByTestId("period-kpis")).toHaveAttribute("aria-busy", "false");
  });
});

describe("PeriodKpis - source", () => {
  it("is non-empty, imports no $app module and does not colour the figures by sign", () => {
    expect(source.length).toBeGreaterThan(1000);
    expect(source).not.toContain("$app/");
    expect(source).not.toMatch(/deltaTone="(good|bad|warn)"/);
    expect(source).toContain('deltaTone="neutral"');
  });

  it("sizes the value at 20 px below 1440 px and lets the unit wrap (UI-SPEC)", () => {
    expect(source).toMatch(/@media \(max-width: 1439px\)[\s\S]*\.kpi-value[\s\S]*font-size: 20px/);
    expect(source).toMatch(/flex-wrap: wrap/);
  });
});
