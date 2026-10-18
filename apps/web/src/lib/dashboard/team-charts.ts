// Issue #591 (D-591-1, D-591-2, D-591-4): the builders of every chart of the web app. Each chart is
// described once (kind + unit + subject) and the SAME descriptor yields the chart.js type, the value
// axis and the canvas aria-label, so a label never names another chart type or unit than the one
// drawn. Data arrays are passed through unchanged - a builder invents no figure. Colours, axis
// recipes, the unit titles and the no-smoothing rule come from `$lib/utils/chart-theme` and
// nowhere else; `chart-style-591.test.ts` enforces it.
import type { ActiveElement, ChartConfiguration, ChartEvent } from "chart.js";
import {
  categoryAxis,
  chartJsType,
  getChartDefaults,
  valueAxis,
  type ChartDescriptor,
  type ChartTheme,
} from "$lib/utils/chart-theme";
import type { TeamTrendView } from "./team-view";

/** The click handler of a month chart: receives the index of the clicked month. */
export type MonthHandler = (index: number) => void;

/**
 * The options every month chart shares: the whole month column answers (index mode, so a month with
 * a zero still opens) and, when a handler is given, a click on it calls the handler.
 */
function monthInteraction(onMonth: MonthHandler | null) {
  const base = {
    interaction: { mode: "index" as const, intersect: false },
  };
  if (onMonth === null) return base;
  return {
    ...base,
    onClick: (_event: ChartEvent, elements: ActiveElement[]) => {
      const first = elements[0];
      if (first !== undefined) onMonth(first.index);
    },
    onHover: (event: ChartEvent, elements: ActiveElement[]) => {
      const target = event.native?.target as HTMLElement | null | undefined;
      if (target === undefined || target === null) return;
      target.style.cursor = elements[0] !== undefined ? "pointer" : "default";
    },
  };
}

// ── Krankheitstage ──────────────────────────────────────────────────────────

/** Krankheitstage: a count of calendar days per month, so columns (AC-591-1). */
export const TEAM_SICK_DAYS_CHART: ChartDescriptor = {
  kind: "column",
  unit: "calendar-days",
  subject: "Krankheitstage des Teams, letzte 6 Monate",
};

export function teamSickDaysChartConfig(
  view: TeamTrendView,
  theme: ChartTheme,
  onMonth: MonthHandler | null,
): ChartConfiguration<"bar"> {
  const defaults = getChartDefaults(theme);
  return {
    type: chartJsType(TEAM_SICK_DAYS_CHART.kind) as "bar",
    data: {
      labels: view.months.map((m) => m.label),
      datasets: [
        {
          label: "Krankheitstage",
          data: view.sickDays,
          backgroundColor: theme.sick,
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: defaults.responsive,
      maintainAspectRatio: defaults.maintainAspectRatio,
      locale: defaults.locale,
      plugins: {
        legend: { display: false },
        tooltip: defaults.plugins.tooltip,
      },
      scales: {
        x: categoryAxis(theme),
        y: {
          ...valueAxis(theme, TEAM_SICK_DAYS_CHART.unit, { signed: false }),
          // Whole days only: a count has no fractions.
          ticks: {
            color: theme.textMuted,
            font: { family: theme.fontFamily, size: 11 },
            stepSize: 1,
          },
        },
      },
      ...monthInteraction(onMonth),
    },
  };
}
