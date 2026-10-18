/**
 * The ONE chart style source of the web app (Issue #591, D-591-1).
 *
 * What lives here and nowhere else:
 *  - colours, read from the token variables (`getChartTheme()`), never a hex or rgb literal;
 *  - the defaults (`getChartDefaults()`): no smoothing (`tension: 0`) and the German locale;
 *  - the unit titles of a value axis (`CHART_UNIT_TITLE`) and the axis recipes that carry them
 *    (`valueAxis`, `categoryAxis`, `zeroLineGrid`);
 *  - the chart kinds with their German names and `chartAriaLabel()`, so a canvas label is derived
 *    from the same descriptor the chart is drawn from and can never name another type or unit.
 *
 * A chart builder (`lib/dashboard/team-charts.ts`) takes everything of this from here, and the
 * source guard `apps/web/src/__tests__/chart-style-591.test.ts` fails on a chart that does not.
 * Call `getChartTheme()` after the DOM is available (onMount / an effect).
 */

/** Chart.js-compatible colours derived from the current CSS theme variables. */
export function getChartTheme() {
  const style = getComputedStyle(document.documentElement);

  const get = (prop: string) => style.getPropertyValue(prop).trim();

  return {
    brand: get("--brand"),
    brandLight: get("--brand-light"),
    brandTint: get("--brand-soft"),
    // Planned values: the faint text token keeps a 3:1 contrast against the card (WCAG 1.4.11).
    neutral: get("--text-faint"),
    sick: get("--leave-type-sick"),
    green: get("--good"),
    red: get("--bad"),
    yellow: get("--warn"),
    text: get("--text"),
    textMuted: get("--text-muted"),
    border: get("--border"),
    surface: get("--bg-card"),
    gridColor: get("--border"),
    fontFamily: get("--font-sans"),
  };
}

export type ChartTheme = ReturnType<typeof getChartTheme>;

/** Common Chart.js defaults for consistent theming. */
export function getChartDefaults(theme: ChartTheme = getChartTheme()) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    locale: "de-DE",
    plugins: {
      legend: {
        labels: {
          color: theme.textMuted,
          font: { family: theme.fontFamily, size: 12 },
          usePointStyle: true,
          pointStyle: "circle",
          padding: 16,
        },
      },
      tooltip: {
        backgroundColor: theme.surface,
        titleColor: theme.text,
        bodyColor: theme.textMuted,
        borderColor: theme.border,
        borderWidth: 1,
        cornerRadius: 8,
        padding: { x: 12, y: 8 },
        titleFont: { family: theme.fontFamily, weight: 600, size: 13 },
        bodyFont: { family: theme.fontFamily, size: 12 },
        boxPadding: 4,
        usePointStyle: true,
      },
    },
    scales: {
      x: {
        ticks: { color: theme.textMuted, font: { family: theme.fontFamily, size: 11 } },
        grid: { color: theme.gridColor, lineWidth: 0.5 },
        border: { display: false },
      },
      y: {
        ticks: { color: theme.textMuted, font: { family: theme.fontFamily, size: 11 } },
        grid: { color: theme.gridColor, lineWidth: 0.5 },
        border: { display: false },
      },
    },
    elements: {
      bar: { borderRadius: 6 },
      // Discrete monthly values are never smoothed (AC-591-1).
      line: { tension: 0, borderWidth: 2.5 },
      point: { radius: 3, hoverRadius: 5 },
    },
  };
}

// ── Units ───────────────────────────────────────────────────────────────────

/** The unit a value axis is measured in. */
export type ChartUnit = "hours" | "calendar-days";

/** The axis title of each unit (AC-591-2, P-591-01). */
export const CHART_UNIT_TITLE: Record<ChartUnit, string> = {
  hours: "Stunden (h)",
  "calendar-days": "Kalendertage",
};

/** The unit as a screen reader says it ("in Stunden"). */
const CHART_UNIT_SPOKEN: Record<ChartUnit, string> = {
  hours: "Stunden",
  "calendar-days": "Kalendertagen",
};

// ── Kinds and the descriptor ────────────────────────────────────────────────

/** What is drawn: vertical columns, side-by-side columns, a line or horizontal bars. */
export type ChartKind = "column" | "grouped-column" | "line" | "horizontal-bar";

/** One chart: its kind, its unit and its subject. Drives the chart.js type AND the aria-label. */
export interface ChartDescriptor {
  kind: ChartKind;
  unit: ChartUnit;
  subject: string;
}

const CHART_KIND_NAME: Record<ChartKind, string> = {
  column: "Säulendiagramm",
  "grouped-column": "Gruppiertes Säulendiagramm",
  line: "Liniendiagramm",
  "horizontal-bar": "Balkendiagramm",
};

/** The canvas aria-label: `<kind name>: <subject>, in <unit>` (D-591-2, P-591-02). */
export function chartAriaLabel(descriptor: ChartDescriptor): string {
  return `${CHART_KIND_NAME[descriptor.kind]}: ${descriptor.subject}, in ${CHART_UNIT_SPOKEN[descriptor.unit]}`;
}

/** The chart.js `type` a kind is drawn with. */
export function chartJsType(kind: ChartKind): "bar" | "line" {
  return kind === "line" ? "line" : "bar";
}

/** The scale that carries the value: x for horizontal bars, y for everything else. */
export function valueAxisKey(kind: ChartKind): "x" | "y" {
  return kind === "horizontal-bar" ? "x" : "y";
}

// ── Axis recipes ────────────────────────────────────────────────────────────

interface TickContext {
  tick?: { value: number };
}

/** A grid whose zero line is drawn stronger than the rest (signed series). */
export function zeroLineGrid(theme: ChartTheme) {
  return {
    color: (ctx: TickContext) => (ctx.tick?.value === 0 ? theme.textMuted : theme.gridColor),
    lineWidth: (ctx: TickContext) => (ctx.tick?.value === 0 ? 2 : 0.5),
  };
}

/** The value axis: titled with its unit, starting at zero, zero line emphasised when signed. */
export function valueAxis(theme: ChartTheme, unit: ChartUnit, options: { signed: boolean }) {
  const grid = options.signed ? zeroLineGrid(theme) : { color: theme.gridColor, lineWidth: 0.5 };
  return {
    beginAtZero: true,
    title: {
      display: true,
      text: CHART_UNIT_TITLE[unit],
      color: theme.textMuted,
      font: { family: theme.fontFamily, size: 11 },
    },
    ticks: { color: theme.textMuted, font: { family: theme.fontFamily, size: 11 } },
    grid,
    border: { display: false },
  };
}

/** The category axis (months, persons): ticks, no grid. */
export function categoryAxis(theme: ChartTheme) {
  return {
    ticks: { color: theme.textMuted, font: { family: theme.fontFamily, size: 11 } },
    grid: { display: false },
    border: { display: false },
  };
}
