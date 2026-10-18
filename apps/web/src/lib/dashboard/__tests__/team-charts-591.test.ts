// Issue #591 (AC-591-1, AC-591-2, D-591-2, D-591-4, P-591-02/03/04): the chart builders. Every
// builder draws from one descriptor, passes the server's arrays through unchanged, titles its value
// axis with the unit and never smooths a line.
/* eslint-disable @typescript-eslint/no-explicit-any -- chart.js option trees are asserted as recorded */
import { describe, expect, it, vi } from "vitest";
import { CHART_UNIT_TITLE, chartJsType, type ChartTheme } from "$lib/utils/chart-theme";
import {
  TEAM_SALDO_BARS_CHART,
  TEAM_SALDO_TREND_CHART,
  TEAM_SICK_DAYS_CHART,
  teamHoursChartConfig,
  teamHoursChartDescriptor,
  teamSaldoBarsChartConfig,
  teamSaldoTrendChartConfig,
  teamSickDaysChartConfig,
} from "../team-charts";
import type { TeamTrendView } from "../team-view";
import type { TeamSaldoBar } from "$lib/reports/team-saldo";

const THEME: ChartTheme = {
  brand: "T-brand",
  brandLight: "T-brandLight",
  brandTint: "T-brandTint",
  neutral: "T-neutral",
  sick: "T-sick",
  green: "T-green",
  red: "T-red",
  yellow: "T-yellow",
  text: "T-text",
  textMuted: "T-textMuted",
  border: "T-border",
  surface: "T-surface",
  gridColor: "T-grid",
  fontFamily: "T-font",
};

function view(over: Partial<TeamTrendView> = {}): TeamTrendView {
  return {
    months: [
      { month: "2026-05", label: "Mai 26" },
      { month: "2026-06", label: "Jun 26" },
      { month: "2026-07", label: "Jul 26" },
    ],
    workedHours: [120.5, 130, 99.5],
    shouldHours: [128, 128, 120],
    sickDays: [3, 0, 7],
    workedSeriesLabel: "Ist (h)",
    chartSub: "Letzte 6 Monate",
    sollNote: null,
    trendNote: null,
    ...over,
  };
}

/** Every `tension` value found anywhere in a config. */
function tensions(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) tensions(item, found);
  } else if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (key === "tension") found.push(inner);
      tensions(inner, found);
    }
  }
  return found;
}

describe("tracer: the Krankheitstage chart", () => {
  it("draws columns of the unchanged sick-day counts in the sick colour", () => {
    const v = view();
    const config = teamSickDaysChartConfig(v, THEME, null);
    expect(config.type).toBe("bar");
    expect(config.data.labels).toEqual(["Mai 26", "Jun 26", "Jul 26"]);
    expect(config.data.datasets).toHaveLength(1);
    expect(config.data.datasets[0].data).toEqual(v.sickDays);
    expect(config.data.datasets[0].backgroundColor).toBe("T-sick");
  });

  it("titles the value axis in calendar days and starts it at zero", () => {
    const config = teamSickDaysChartConfig(view(), THEME, null);
    const y = (config.options as any).scales.y;
    expect(y.title.display).toBe(true);
    expect(y.title.text).toBe(CHART_UNIT_TITLE["calendar-days"]);
    expect(y.title.text).toBe("Kalendertage");
    expect(y.beginAtZero).toBe(true);
    expect(y.ticks.stepSize).toBe(1);
    expect((config.options as any).locale).toBe("de-DE");
    expect((config.options as any).plugins.legend.display).toBe(false);
  });

  it("never smooths", () => {
    const found = tensions(teamSickDaysChartConfig(view(), THEME, null));
    expect(found.every((t) => t === 0)).toBe(true);
  });

  it("offers no click handler while the month handler is null", () => {
    const options = teamSickDaysChartConfig(view(), THEME, null).options as any;
    expect(options.onClick).toBeUndefined();
  });

  it("calls the month handler with the index of the clicked column", () => {
    const onMonth = vi.fn();
    const options = teamSickDaysChartConfig(view(), THEME, onMonth).options as any;
    options.onClick({}, [{ index: 2 }]);
    expect(onMonth).toHaveBeenCalledWith(2);
    options.onClick({}, []);
    expect(onMonth).toHaveBeenCalledTimes(1);
  });

  it("is described as columns in calendar days and drawn as that chart.js type", () => {
    expect(TEAM_SICK_DAYS_CHART.kind).toBe("column");
    expect(TEAM_SICK_DAYS_CHART.unit).toBe("calendar-days");
    expect(TEAM_SICK_DAYS_CHART.subject).toBe("Krankheitstage des Teams, letzte 6 Monate");
    expect(chartJsType(TEAM_SICK_DAYS_CHART.kind)).toBe(
      teamSickDaysChartConfig(view(), THEME, null).type,
    );
  });
});

describe("hours: Soll and Ist as grouped columns (P-591-04)", () => {
  it("describes grouped columns with a Soll and plain columns without", () => {
    expect(teamHoursChartDescriptor(view())).toEqual({
      kind: "grouped-column",
      unit: "hours",
      subject: "Soll und Ist der Arbeitsstunden, letzte 6 Monate",
    });
    expect(teamHoursChartDescriptor(view({ shouldHours: null }))).toEqual({
      kind: "column",
      unit: "hours",
      subject: "Ist der Arbeitsstunden, letzte 6 Monate",
    });
  });

  it("draws Soll then Ist side by side with the unchanged arrays and no stacking", () => {
    const v = view();
    const config = teamHoursChartConfig(v, THEME, null);
    expect(config.type).toBe("bar");
    expect(config.data.labels).toEqual(["Mai 26", "Jun 26", "Jul 26"]);
    const [soll, ist] = config.data.datasets as any[];
    expect(config.data.datasets).toHaveLength(2);
    expect(soll.label).toBe("Soll (h)");
    expect(soll.data).toEqual(v.shouldHours);
    expect(soll.backgroundColor).toBe("T-neutral");
    expect(ist.label).toBe("Ist (h)");
    expect(ist.data).toEqual(v.workedHours);
    expect(ist.backgroundColor).toBe("T-brand");
    for (const dataset of config.data.datasets as any[]) {
      expect(dataset).not.toHaveProperty("stack");
      expect(dataset).not.toHaveProperty("grouped");
    }
    const options = config.options as any;
    expect(options.scales.y.title.text).toBe("Stunden (h)");
    expect(options.scales.y.beginAtZero).toBe(true);
    expect(options.plugins.legend.display).not.toBe(false);
    expect(options.plugins.legend.position).toBe("bottom");
    expect(tensions(config).every((t) => t === 0)).toBe(true);
  });

  it("draws one Ist series when the server delivered no Soll", () => {
    const v = view({ shouldHours: null, workedSeriesLabel: "Erfasste Arbeitszeit (h)" });
    const config = teamHoursChartConfig(v, THEME, null);
    expect(config.data.datasets).toHaveLength(1);
    expect((config.data.datasets[0] as any).label).toBe("Erfasste Arbeitszeit (h)");
    expect(config.data.datasets[0].data).toEqual(v.workedHours);
  });

  it("is drawn as the chart.js type of its descriptor", () => {
    expect(chartJsType(teamHoursChartDescriptor(view()).kind)).toBe(
      teamHoursChartConfig(view(), THEME, null).type,
    );
  });
});

describe("saldo trend: a line without smoothing and a zero line (AC-591-1, P-591-04)", () => {
  const hours = [-2.5, 0, 4.5];

  it("is a line described in hours", () => {
    expect(TEAM_SALDO_TREND_CHART).toEqual({
      kind: "line",
      unit: "hours",
      subject: "Überstunden-Saldo des Teams am Monatsende, letzte 6 Monate",
    });
  });

  it("draws the unchanged values with tension 0, no fill and the zero inside the range", () => {
    const config = teamSaldoTrendChartConfig(["Mai 26", "Jun 26", "Jul 26"], hours, THEME, null);
    expect(config.type).toBe("line");
    const dataset = config.data.datasets[0] as any;
    expect(dataset.data).toEqual(hours);
    expect(dataset.tension).toBe(0);
    expect(dataset.fill).toBe(false);
    expect(dataset.borderColor).toBe("T-brand");
    const y = (config.options as any).scales.y;
    expect(y.beginAtZero).toBe(true);
    expect(y.title.text).toBe("Stunden (h)");
    expect(y.grid.color({ tick: { value: 0 } })).not.toBe(y.grid.color({ tick: { value: 1 } }));
    expect(tensions(config).every((t) => t === 0)).toBe(true);
    expect(chartJsType(TEAM_SALDO_TREND_CHART.kind)).toBe(config.type);
  });
});

describe("saldo bars: the Salden card (P-591-08)", () => {
  const bars: TeamSaldoBar[] = [
    { id: "a", name: "Person A", totalMinutes: 120, label: "+2:00" },
    { id: "b", name: "Person B", totalMinutes: -60, label: "−1:00" },
  ];

  it("is horizontal bars described in hours", () => {
    expect(TEAM_SALDO_BARS_CHART).toEqual({
      kind: "horizontal-bar",
      unit: "hours",
      subject: "höchste Plus- und Minus-Salden im Team",
    });
  });

  it("draws hours by sign with a titled value axis on x and a +-H:MM tooltip", () => {
    const config = teamSaldoBarsChartConfig(bars, THEME, {
      onBar: vi.fn(),
      isClickable: () => true,
    });
    const options = config.options as any;
    expect(config.type).toBe("bar");
    expect(options.indexAxis).toBe("y");
    expect(config.data.labels).toEqual(["Person A", "Person B"]);
    expect(config.data.datasets[0].data).toEqual([2, -1]);
    expect((config.data.datasets[0] as any).backgroundColor).toEqual(["T-green", "T-red"]);
    expect(options.scales.x.title.text).toBe("Stunden (h)");
    expect(options.scales.x.grid.color({ tick: { value: 0 } })).not.toBe(
      options.scales.x.grid.color({ tick: { value: 1 } }),
    );
    expect(options.scales.y.ticks.autoSkip).toBe(false);
    expect(options.animation).toBe(false);
    expect(options.plugins.legend.display).toBe(false);
    expect(options.plugins.tooltip.callbacks.label({ dataIndex: 1 })).toBe("−1:00");
    expect(chartJsType(TEAM_SALDO_BARS_CHART.kind)).toBe(config.type);
  });

  it("opens a bar only for an element and sets the cursor from isClickable", () => {
    const onBar = vi.fn();
    const config = teamSaldoBarsChartConfig(bars, THEME, {
      onBar,
      isClickable: (index) => index === 0,
    });
    const options = config.options as any;
    options.onClick({}, [{ index: 1 }]);
    expect(onBar).toHaveBeenCalledWith(1);
    options.onClick({}, []);
    expect(onBar).toHaveBeenCalledTimes(1);
    const target = { style: { cursor: "" } };
    options.onHover({ native: { target } }, [{ index: 0 }]);
    expect(target.style.cursor).toBe("pointer");
    options.onHover({ native: { target } }, [{ index: 1 }]);
    expect(target.style.cursor).toBe("default");
    options.onHover({ native: { target } }, []);
    expect(target.style.cursor).toBe("default");
  });
});
