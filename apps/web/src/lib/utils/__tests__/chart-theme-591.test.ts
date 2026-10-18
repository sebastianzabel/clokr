// Issue #591 (D-591-1, P-591-01/02/03): the one chart style module. The theme reads colours from
// CSS variables only, the defaults never smooth, a value axis always carries its unit title, and
// the canvas aria-label is derived from the same descriptor the chart is drawn from.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHART_UNIT_TITLE,
  categoryAxis,
  chartAriaLabel,
  chartJsType,
  getChartDefaults,
  getChartTheme,
  valueAxis,
  valueAxisKey,
  zeroLineGrid,
  type ChartDescriptor,
} from "../chart-theme";

const VARIABLES: Record<string, string> = {
  "--brand": "rgb(1, 1, 1)",
  "--brand-light": "rgb(2, 2, 2)",
  "--brand-soft": "rgb(3, 3, 3)",
  "--text-faint": "rgb(4, 4, 4)",
  "--leave-type-sick": "rgb(5, 5, 5)",
  "--good": "rgb(6, 6, 6)",
  "--bad": "rgb(7, 7, 7)",
  "--warn": "rgb(8, 8, 8)",
  "--text": "rgb(9, 9, 9)",
  "--text-muted": "rgb(10, 10, 10)",
  "--border": "rgb(11, 11, 11)",
  "--bg-card": "rgb(12, 12, 12)",
  "--font-sans": "Jost",
};

beforeEach(() => {
  for (const [name, value] of Object.entries(VARIABLES)) {
    document.documentElement.style.setProperty(name, value);
  }
});

afterEach(() => {
  for (const name of Object.keys(VARIABLES)) document.documentElement.style.removeProperty(name);
});

describe("getChartTheme (P-591-03)", () => {
  it("reads every colour from the token variables", () => {
    const theme = getChartTheme();
    expect(theme.brand).toBe("rgb(1, 1, 1)");
    expect(theme.brandLight).toBe("rgb(2, 2, 2)");
    // Soll reads --text-muted, not --text-faint (3:1 in every skin, verification of #591).
    expect(theme.neutral).toBe("rgb(10, 10, 10)");
    expect(theme.sick).toBe("rgb(5, 5, 5)");
    expect(theme.green).toBe("rgb(6, 6, 6)");
    expect(theme.red).toBe("rgb(7, 7, 7)");
    expect(theme.text).toBe("rgb(9, 9, 9)");
    expect(theme.textMuted).toBe("rgb(10, 10, 10)");
    expect(theme.gridColor).toBe("rgb(11, 11, 11)");
    expect(theme.fontFamily).toBe("Jost");
  });

  it("has no hard-coded blue any more", () => {
    expect(Object.keys(getChartTheme())).not.toContain("blue");
  });
});

describe("getChartDefaults (AC-591-1)", () => {
  it("never smooths a line and words numbers in German", () => {
    const defaults = getChartDefaults();
    expect(defaults.elements.line.tension).toBe(0);
    expect(defaults.locale).toBe("de-DE");
  });
});

describe("unit titles (AC-591-2, P-591-01)", () => {
  it("names hours and calendar days once", () => {
    expect(CHART_UNIT_TITLE).toEqual({ hours: "Stunden (h)", "calendar-days": "Kalendertage" });
  });
});

describe("chartAriaLabel (D-591-2, P-591-02)", () => {
  it("names the kind and the unit of what is drawn", () => {
    const sick: ChartDescriptor = {
      kind: "column",
      unit: "calendar-days",
      subject: "Krankheitstage des Teams, letzte 6 Monate",
    };
    expect(chartAriaLabel(sick)).toBe(
      "Säulendiagramm: Krankheitstage des Teams, letzte 6 Monate, in Kalendertagen",
    );
    expect(chartAriaLabel({ kind: "grouped-column", unit: "hours", subject: "Soll und Ist" })).toBe(
      "Gruppiertes Säulendiagramm: Soll und Ist, in Stunden",
    );
    expect(chartAriaLabel({ kind: "line", unit: "hours", subject: "Saldo" })).toBe(
      "Liniendiagramm: Saldo, in Stunden",
    );
    expect(chartAriaLabel({ kind: "horizontal-bar", unit: "hours", subject: "Salden" })).toBe(
      "Balkendiagramm: Salden, in Stunden",
    );
  });
});

describe("chart kinds", () => {
  it("maps a kind to the chart.js type", () => {
    expect(chartJsType("column")).toBe("bar");
    expect(chartJsType("grouped-column")).toBe("bar");
    expect(chartJsType("horizontal-bar")).toBe("bar");
    expect(chartJsType("line")).toBe("line");
  });

  it("puts the value on x for horizontal bars and on y otherwise", () => {
    expect(valueAxisKey("horizontal-bar")).toBe("x");
    expect(valueAxisKey("column")).toBe("y");
    expect(valueAxisKey("grouped-column")).toBe("y");
    expect(valueAxisKey("line")).toBe("y");
  });
});

describe("valueAxis", () => {
  it("titles the axis with its unit and starts at zero", () => {
    const axis = valueAxis(getChartTheme(), "hours", { signed: false });
    expect(axis.title.display).toBe(true);
    expect(axis.title.text).toBe("Stunden (h)");
    expect(axis.beginAtZero).toBe(true);
    expect(valueAxis(getChartTheme(), "calendar-days", { signed: false }).title.text).toBe(
      "Kalendertage",
    );
  });

  it("emphasises the zero line of a signed series only", () => {
    const theme = getChartTheme();
    const signed = valueAxis(theme, "hours", { signed: true });
    const color = signed.grid.color as (ctx: { tick?: { value: number } }) => string;
    const width = signed.grid.lineWidth as (ctx: { tick?: { value: number } }) => number;
    expect(color({ tick: { value: 0 } })).not.toBe(color({ tick: { value: 1 } }));
    expect(width({ tick: { value: 0 } })).toBeGreaterThan(width({ tick: { value: 1 } }));

    const plain = valueAxis(theme, "hours", { signed: false });
    expect(typeof plain.grid.color).toBe("string");
    expect(typeof plain.grid.lineWidth).toBe("number");
  });

  it("exposes the zero line grid on its own", () => {
    const grid = zeroLineGrid(getChartTheme());
    expect(grid.color({ tick: { value: 0 } })).toBe("rgb(10, 10, 10)");
    expect(grid.color({ tick: { value: 2 } })).toBe("rgb(11, 11, 11)");
    expect(grid.lineWidth({ tick: { value: 0 } })).toBe(2);
    expect(grid.lineWidth({ tick: { value: 2 } })).toBe(0.5);
  });
});

describe("categoryAxis", () => {
  it("draws ticks without a grid", () => {
    const axis = categoryAxis(getChartTheme());
    expect(axis.grid.display).toBe(false);
    expect(axis.ticks.color).toBe("rgb(10, 10, 10)");
  });
});
