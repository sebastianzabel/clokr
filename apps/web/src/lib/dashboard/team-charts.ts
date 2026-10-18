// Issue #591 (D-591-1, D-591-2, D-591-4): the builders of every chart of the web app. Each chart is
// described once (kind + unit + subject) and the SAME descriptor yields the chart.js type, the value
// axis and the canvas aria-label, so a label never names another chart type or unit than the one
// drawn. Data arrays are passed through unchanged - a builder invents no figure. Colours, axis
// recipes, the unit titles and the no-smoothing rule come from `$lib/utils/chart-theme` and
// nowhere else; `chart-style-591.test.ts` enforces it.
import type { ActiveElement, ChartConfiguration, ChartDataset, ChartEvent } from "chart.js";
import {
  categoryAxis,
  chartJsType,
  getChartDefaults,
  valueAxis,
  type ChartDescriptor,
  type ChartTheme,
} from "$lib/utils/chart-theme";
import type { TeamSaldoBar } from "$lib/reports/team-saldo";
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

// ── Arbeitsstunden: Soll and Ist ────────────────────────────────────────────

/**
 * Soll and Ist as two columns per month side by side (no stacking, no overlap); without a Soll
 * (salon filter, partial scope) one Ist series and plain columns.
 */
export function teamHoursChartDescriptor(
  view: Pick<TeamTrendView, "shouldHours"> | null,
): ChartDescriptor {
  // No view yet (nothing is drawn): the weaker claim, the Ist alone.
  return view !== null && view.shouldHours !== null
    ? {
        kind: "grouped-column",
        unit: "hours",
        subject: "Soll und Ist der Arbeitsstunden, letzte 6 Monate",
      }
    : { kind: "column", unit: "hours", subject: "Ist der Arbeitsstunden, letzte 6 Monate" };
}

export function teamHoursChartConfig(
  view: TeamTrendView,
  theme: ChartTheme,
  onMonth: MonthHandler | null,
): ChartConfiguration<"bar"> {
  const defaults = getChartDefaults(theme);
  const descriptor = teamHoursChartDescriptor(view);
  const datasets: ChartDataset<"bar">[] = [
    // D-05: the Soll is drawn only when the server delivers one (never under a salon filter).
    ...(view.shouldHours !== null
      ? [
          {
            label: "Soll (h)",
            data: view.shouldHours,
            backgroundColor: theme.neutral,
            borderRadius: 4,
          },
        ]
      : []),
    {
      label: view.workedSeriesLabel,
      data: view.workedHours,
      backgroundColor: theme.brand,
      borderRadius: 4,
    },
  ];
  return {
    type: chartJsType(descriptor.kind) as "bar",
    data: { labels: view.months.map((m) => m.label), datasets },
    options: {
      responsive: defaults.responsive,
      maintainAspectRatio: defaults.maintainAspectRatio,
      locale: defaults.locale,
      plugins: {
        legend: { position: "bottom", labels: defaults.plugins.legend.labels },
        tooltip: defaults.plugins.tooltip,
      },
      scales: {
        x: categoryAxis(theme),
        y: valueAxis(theme, descriptor.unit, { signed: false }),
      },
      ...monthInteraction(onMonth),
    },
  };
}

// ── Überstunden-Trend ───────────────────────────────────────────────────────

/** The team saldo at each month end: a signed series, so a line with an emphasised zero line. */
export const TEAM_SALDO_TREND_CHART: ChartDescriptor = {
  kind: "line",
  unit: "hours",
  subject: "Überstunden-Saldo des Teams am Monatsende, letzte 6 Monate",
};

export function teamSaldoTrendChartConfig(
  labels: string[],
  hours: number[],
  theme: ChartTheme,
  onMonth: MonthHandler | null,
): ChartConfiguration<"line"> {
  const defaults = getChartDefaults(theme);
  return {
    type: chartJsType(TEAM_SALDO_TREND_CHART.kind) as "line",
    data: {
      labels,
      datasets: [
        {
          label: "Team-Überstunden (h)",
          data: hours,
          borderColor: theme.brand,
          backgroundColor: theme.brand,
          // Discrete month-end values: straight segments, no area (AC-591-1).
          fill: false,
          tension: 0,
          pointRadius: 4,
          pointBackgroundColor: theme.brand,
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
        y: valueAxis(theme, TEAM_SALDO_TREND_CHART.unit, { signed: true }),
      },
      ...monthInteraction(onMonth),
    },
  };
}

// ── Salden (the 588 card) ───────────────────────────────────────────────────

/** The largest plus and minus saldi of the team: signed horizontal bars. */
export const TEAM_SALDO_BARS_CHART: ChartDescriptor = {
  kind: "horizontal-bar",
  unit: "hours",
  subject: "höchste Plus- und Minus-Salden im Team",
};

export interface TeamSaldoBarHandlers {
  /** Called with the index of a clicked bar. */
  onBar: (index: number) => void;
  /** Whether the bar at this index opens something (decides the pointer cursor). */
  isClickable: (index: number) => boolean;
}

export function teamSaldoBarsChartConfig(
  bars: TeamSaldoBar[],
  theme: ChartTheme,
  handlers: TeamSaldoBarHandlers,
): ChartConfiguration<"bar"> {
  const defaults = getChartDefaults(theme);
  const category = categoryAxis(theme);
  return {
    type: chartJsType(TEAM_SALDO_BARS_CHART.kind) as "bar",
    data: {
      labels: bars.map((b) => b.name),
      datasets: [
        {
          data: bars.map((b) => b.totalMinutes / 60),
          backgroundColor: bars.map((b) => (b.totalMinutes > 0 ? theme.green : theme.red)),
          borderRadius: 4,
          maxBarThickness: 18,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: defaults.responsive,
      maintainAspectRatio: defaults.maintainAspectRatio,
      locale: defaults.locale,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...defaults.plugins.tooltip,
          callbacks: {
            // The tooltip words a bar as +-H:MM, never as a decimal number.
            label: (ctx: { dataIndex: number }) => bars[ctx.dataIndex]?.label ?? "",
          },
        },
      },
      scales: {
        x: valueAxis(theme, TEAM_SALDO_BARS_CHART.unit, { signed: true }),
        y: { ...category, ticks: { ...category.ticks, color: theme.text, autoSkip: false } },
      },
      onClick: (_event: ChartEvent, elements: ActiveElement[]) => {
        const first = elements[0];
        if (first !== undefined) handlers.onBar(first.index);
      },
      onHover: (event: ChartEvent, elements: ActiveElement[]) => {
        const target = event.native?.target as HTMLElement | null | undefined;
        if (target === undefined || target === null) return;
        const first = elements[0];
        target.style.cursor =
          first !== undefined && handlers.isClickable(first.index) ? "pointer" : "default";
      },
    },
  };
}
