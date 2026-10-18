// Issue #591 (AC-591-1, AC-591-2, D-591-2, D-591-4, P-591-02/03/04): the chart builders. Every
// builder draws from one descriptor, passes the server's arrays through unchanged, titles its value
// axis with the unit and never smooths a line.
/* eslint-disable @typescript-eslint/no-explicit-any -- chart.js option trees are asserted as recorded */
import { describe, expect, it, vi } from "vitest";
import { CHART_UNIT_TITLE, chartJsType, type ChartTheme } from "$lib/utils/chart-theme";
import { TEAM_SICK_DAYS_CHART, teamSickDaysChartConfig } from "../team-charts";
import type { TeamTrendView } from "../team-view";

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
