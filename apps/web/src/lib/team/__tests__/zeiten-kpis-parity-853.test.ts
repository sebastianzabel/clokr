// Issue #853 (D-853-18) - parity: the strip cells of Team › Zeiten say exactly what the two
// legacy cards said for the same inputs. The UNCHANGED MonatSaldoCard and KontoSaldoCard are
// mounted next to a KpiStrip built from `monthKpiItems()` / `kontoKpiItem()`, and every visible
// string of the card is compared with the cell field that must carry it. A drift on either side
// (card or model) turns this red; the cards are shared with Ich › Zeiten (#851) and are not edited.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import KpiStrip from "$components/ui/KpiStrip.svelte";
import MonatSaldoCard from "$components/saldo/MonatSaldoCard.svelte";
import KontoSaldoCard from "$components/saldo/KontoSaldoCard.svelte";
import {
  kontoKpiItem,
  monthKpiItems,
  type KontoKpiInput,
  type MonthKpiInput,
} from "../zeiten-kpis";

afterEach(() => cleanup());

/** Visible text with non-breaking spaces and runs of whitespace folded to single spaces. */
function text(el: Element | null | undefined): string {
  expect(el, "expected element is missing").toBeTruthy();
  return (el!.textContent ?? "").replace(/[\s\xA0]+/g, " ").trim();
}

function cells(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("article.kpi")];
}

function cell(container: HTMLElement, testId: string): HTMLElement {
  const hit = container.querySelector<HTMLElement>(`article.kpi[data-testid="${testId}"]`);
  expect(hit, `strip cell ${testId}`).toBeTruthy();
  return hit!;
}

/** The figure of a cell without its unit. */
function valueOf(c: HTMLElement): string {
  const unit = c.querySelector(".kpi-unit");
  const full = text(c.querySelector(".kpi-value"));
  return unit ? full.slice(0, full.length - text(unit).length).trim() : full;
}
const label = (c: HTMLElement) => text(c.querySelector(".kpi-label"));
const value = (c: HTMLElement) => text(c.querySelector(".kpi-value"));
const explanation = (c: HTMLElement) => c.querySelector(".kpi-explanation");
const delta = (c: HTMLElement) => c.querySelector(".kpi-delta");

function monthProps(overrides: Partial<MonthKpiInput> = {}): MonthKpiInput {
  return {
    sollToDateMin: 0,
    istMin: 0,
    saldoMin: 0,
    noSollTarget: false,
    sollLabel: "Soll (bisher)",
    workdaysSoFar: 0,
    runningCount: 0,
    isLocked: false,
    ...overrides,
  };
}

const MONTH_FIXTURES: Array<[string, MonthKpiInput]> = [
  [
    "normal open month, entry running",
    monthProps({
      sollToDateMin: 3360,
      istMin: 3500,
      saldoMin: 140,
      workdaysSoFar: 7,
      runningCount: 1,
    }),
  ],
  [
    "negative saldo",
    monthProps({ sollToDateMin: 3360, istMin: 2880, saldoMin: -480, workdaysSoFar: 6 }),
  ],
  [
    "refused saldo read (Ist only)",
    monthProps({
      sollToDateMin: 0,
      istMin: 2745,
      saldoMin: null,
      noSollTarget: true,
      sollLabel: "Soll",
      workdaysSoFar: 5,
    }),
  ],
  [
    "track-only contract, no workday count, entry running",
    monthProps({
      sollToDateMin: 0,
      istMin: 600,
      saldoMin: null,
      noSollTarget: true,
      sollLabel: "Soll",
      workdaysSoFar: null,
      runningCount: 2,
    }),
  ],
  [
    "closed month",
    monthProps({
      sollToDateMin: 9600,
      istMin: 9720,
      saldoMin: 120,
      isLocked: true,
      workdaysSoFar: null,
    }),
  ],
  [
    "monthly budget, saldo exactly zero",
    monthProps({
      sollToDateMin: 4800,
      istMin: 4800,
      saldoMin: 0,
      sollLabel: "Soll",
      workdaysSoFar: 10,
    }),
  ],
  ["no schedule: dash instead of a saldo", monthProps({ saldoMin: null, workdaysSoFar: null })],
];

describe("month cells equal MonatSaldoCard", () => {
  it.each(MONTH_FIXTURES)("%s", (_name, input) => {
    const card = renderWithTheme(MonatSaldoCard, {
      sollToDateMin: input.sollToDateMin,
      istMin: input.istMin,
      saldoMin: input.saldoMin,
      noSollTarget: input.noSollTarget,
      sollLabel: input.sollLabel,
      workdaysSoFar: input.workdaysSoFar,
      runningCount: input.runningCount,
      isLocked: input.isLocked,
    }).container;
    const strip = renderWithTheme(KpiStrip, { items: monthKpiItems(input) }).container;

    const main = cell(strip, "zeiten-kpi-monatssaldo");
    // The micro label and the big figure.
    expect(label(main)).toBe(text(card.querySelector(".msc-microlabel")));
    expect(value(main)).toBe(text(card.querySelector('[data-testid="monat-saldo-figure"]')));

    // The context lines next to the figure, in the card's order.
    const sollLine = [...card.querySelectorAll(".msc-context-line")]
      .map((el) => text(el))
      .filter((t) => t.includes("erfüllt"));
    const lineOf = (id: string) => card.querySelector(`[data-testid="${id}"]`);
    const workday = lineOf("monat-saldo-workdays") ?? lineOf("monat-saldo-running");
    if (workday) expect(text(explanation(main))).toBe(text(workday));
    else expect(explanation(main)).toBeNull();

    if (input.noSollTarget) {
      expect(sollLine).toEqual([]);
      expect(cells(strip).some((c) => label(c) === "Gearbeitet")).toBe(false);
      expect(text(delta(main))).toBe(text(lineOf("monat-saldo-nosoll-hint")));
    } else {
      expect(lineOf("monat-saldo-nosoll-hint")).toBeNull();
      expect(delta(main)).toBeNull();
      const gearbeitet = cell(strip, "zeiten-kpi-gearbeitet");
      // The Soll/Ist bar of the card: "Ist X h", the mid label and "Soll Y h", or its no-Soll text.
      const bar = [...card.querySelectorAll(".sib-labels span")].map((el) => text(el));
      const nosoll = card.querySelector('[data-testid="soll-ist-bar-nosoll"]');
      if (bar.length > 0) {
        expect(bar[0]).toBe(`Ist ${valueOf(gearbeitet)} h`);
        expect(text(gearbeitet.querySelector(".kpi-progress-label"))).toBe(bar[1]);
        expect(text(explanation(gearbeitet))).toBe(sollLine[0]);
        expect(sollLine[0]).toContain(bar[2].replace(/^Soll /, ""));
      } else {
        expect(text(nosoll)).toBe(text(explanation(gearbeitet)));
        expect(gearbeitet.querySelector(".kpi-progress-label")).toBeNull();
      }
    }

    // The status line and its right-hand note.
    const status = cell(strip, "zeiten-kpi-status");
    expect(text(explanation(status))).toBe(text(card.querySelector(".msc-status-left span")));
    const right = card.querySelector(".msc-status-right");
    if (right) expect(text(delta(status))).toBe(text(right));
    else expect(delta(status)).toBeNull();
  });

  it("covers at least five fixtures", () => {
    expect(MONTH_FIXTURES.length).toBeGreaterThanOrEqual(5);
  });
});

function kontoProps(overrides: Partial<KontoKpiInput> = {}): KontoKpiInput {
  return {
    totalHours: null,
    confirmedMinutes: 0,
    openMonthMinutes: 0,
    hasClosedMonth: true,
    ...overrides,
  };
}

const KONTO_FIXTURES: Array<[string, KontoKpiInput]> = [
  [
    "exactly one unclosed month",
    kontoProps({ confirmedMinutes: 600, openMonthMinutes: -90, unconfirmedMonths: 1 }),
  ],
  [
    "several unclosed months, a month was closed",
    kontoProps({ confirmedMinutes: 120, openMonthMinutes: 300, unconfirmedMonths: 3 }),
  ],
  [
    "several unclosed months, nothing ever closed",
    kontoProps({
      confirmedMinutes: 0,
      openMonthMinutes: 45,
      hasClosedMonth: false,
      unconfirmedMonths: 2,
    }),
  ],
  [
    "negative balance",
    kontoProps({ confirmedMinutes: -300, openMonthMinutes: -120, unconfirmedMonths: 1 }),
  ],
  [
    "nothing confirmed, account not empty",
    kontoProps({
      confirmedMinutes: 0,
      openMonthMinutes: -4212,
      hasClosedMonth: false,
      unconfirmedMonths: 4,
    }),
  ],
  [
    "new hire, everything zero",
    kontoProps({
      confirmedMinutes: 0,
      openMonthMinutes: 0,
      hasClosedMonth: false,
      unconfirmedMonths: 1,
    }),
  ],
  [
    "roster incomplete",
    kontoProps({
      confirmedMinutes: 60,
      openMonthMinutes: 60,
      unconfirmedMonths: 1,
      rosterIncomplete: true,
    }),
  ],
  ["unknown forecast window", kontoProps({ confirmedMinutes: 60, openMonthMinutes: 60 })],
  ["legacy: total hours only", { totalHours: 12.5 }],
  ["no data", { totalHours: null }],
];

describe("the account cell equals KontoSaldoCard", () => {
  it.each(KONTO_FIXTURES)("%s", (_name, input) => {
    const card = renderWithTheme(KontoSaldoCard, { ...input }).container;
    const strip = renderWithTheme(KpiStrip, { items: [kontoKpiItem(input)] }).container;
    const konto = cell(strip, "zeiten-kpi-konto");

    // The headline figure.
    expect(value(konto)).toBe(text(card.querySelector(".ksc-figure")));
    // The forecast caption (forecast-label.ts, qualifier included).
    const caption = card.querySelector(".ksc-caption");
    if (caption) expect(text(explanation(konto))).toBe(text(caption));
    else expect(explanation(konto)).toBeNull();

    // The confirmed row, or - when the "Monatsabschlüsse fehlen" marker leads - the marker.
    const marker = card.querySelector(".ksc-missing-close");
    const row = card.querySelector(".ksc-row");
    if (marker) {
      expect(text(delta(konto))).toBe(text(marker).replace("fehlen Saldo", "fehlen · Saldo"));
      expect(delta(konto)?.className).toContain("kpi-delta-warn");
    } else if (row) {
      expect(text(delta(konto))).toBe(text(row));
    } else {
      expect(delta(konto)).toBeNull();
    }
  });

  it("covers the open, several, none-closed, negative, marker and zero cases", () => {
    expect(KONTO_FIXTURES.length).toBeGreaterThanOrEqual(8);
  });
});
