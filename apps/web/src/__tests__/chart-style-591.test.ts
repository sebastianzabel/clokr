// Issue #591 (D-591-5) - the source guard of the chart style module.
//
// `lib/utils/chart-theme.ts` is the ONE chart style source and `lib/dashboard/team-charts.ts` holds
// the builders of every chart. A chart that smooths a discrete series, lacks a unit on its value
// axis, builds its own style inline, carries a colour literal or labels its canvas with a text that
// can drift from what is drawn would let two charts of the same app disagree about how a number is
// shown. The rules scan non-test `.ts`/`.svelte` files under `apps/web/src` (comments are NOT
// excluded for G2/G6 on purpose - a commented-out copy is still a copy):
//   G1  every chart file (builds a chart.js chart or value-imports chart.js) and every builder file
//       (type-imports `ChartConfiguration` from chart.js) imports `$lib/utils/chart-theme`
//   G2  no walked file holds a `tension` with a value other than 0
//   G3  every `new Chart(` call passes as its second argument a call of a builder exported by a
//       builder file (never an inline object), and the set of builder names used equals exactly the
//       builders of the runtime table below
//   G4  (runtime) every builder, built with a stub theme, titles its value axis with the unit of its
//       descriptor, never smooths (deep walk), is drawn as the chart.js type of its descriptor and
//       draws a zero line when the series is signed
//   G5  every `<canvas` of a walked `.svelte` file carries `role="img"` and an
//       `aria-label={chartAriaLabel(...)}` - never a literal text
//   G6  no hex or rgb/hsl colour literal in `lib/utils/chart-theme.ts` or in a builder file
// Named blind spots: a chart built outside chart.js (an SVG sparkline, a hand-drawn canvas) is not
// seen - none exists; a builder file that forgets the `ChartConfiguration` type import is not in
// BUILDER_FILES, which G3 catches because its builder name is then not an export of a builder file.
// The walked set is asserted non-empty, the chart file set exactly (anti-vacuity). A hit is a
// finding, not an exception.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  CHART_UNIT_TITLE,
  chartAriaLabel,
  chartJsType,
  valueAxisKey,
  type ChartDescriptor,
  type ChartTheme,
} from "$lib/utils/chart-theme";
import {
  TEAM_SALDO_BARS_CHART,
  TEAM_SALDO_TREND_CHART,
  TEAM_SICK_DAYS_CHART,
  teamHoursChartConfig,
  teamHoursChartDescriptor,
  teamSaldoBarsChartConfig,
  teamSaldoTrendChartConfig,
  teamSickDaysChartConfig,
} from "$lib/dashboard/team-charts";
import type { TeamTrendView } from "$lib/dashboard/team-view";

const THEME_FILE = "lib/utils/chart-theme.ts";
const BUILDER_FILE = "lib/dashboard/team-charts.ts";
/** The files that draw a chart, measured 18.10.2026 on the tree of #591-01. */
const EXPECTED_CHART_FILES = [
  "lib/components/dashboard/TeamSaldoCard.svelte",
  "routes/(app)/dashboard/+page.svelte",
];
/**
 * Walk floor: 281 non-test `.ts`/`.svelte` files measured on 18.10.2026, minus about 5 %. The
 * literal is the floor (the vacuity gate only reads a numeric literal as proof).
 */
const WALK_FLOOR = 267;

function srcRoot(): string {
  try {
    const fromHere = fileURLToPath(new URL("..", import.meta.url));
    if (statSync(join(fromHere, THEME_FILE)).isFile()) return fromHere;
  } catch {
    // vitest may serve this file from a non-file URL: use the package root instead
  }
  return resolve(process.cwd(), "src");
}

function walkSources(absDir: string, out: string[] = []): string[] {
  for (const name of readdirSync(absDir)) {
    if (name === "__tests__" || name === "node_modules" || name === ".svelte-kit") continue;
    const abs = join(absDir, name);
    if (statSync(abs).isDirectory()) {
      walkSources(abs, out);
    } else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(abs);
    }
  }
  return out;
}

const ROOT = srcRoot();
const WALKED = walkSources(ROOT);
const FILES: Array<{ rel: string; text: string }> = WALKED.map((f) => ({
  rel: relative(ROOT, f).split("\\").join("/"),
  text: readFileSync(f, "utf8"),
}));

function fileText(rel: string): string {
  const file = FILES.find((f) => f.rel === rel);
  expect(file, `${rel} is not in the walked set`).toBeDefined();
  return file!.text;
}

// ── Matchers (each has positive controls below) ────────────────────────────────────────────────

/** True when the source builds a chart.js chart or imports a value (not only types) from it. */
const NEW_CHART = /new\s+Chart\s*\(/;
const CHART_JS_VALUE_IMPORT = /import\s+(?!type\s)[^;]*?from\s*["']chart\.js["']/;
function isChartFile(text: string): boolean {
  return NEW_CHART.test(text) || CHART_JS_VALUE_IMPORT.test(text);
}

/** True when the source type-imports `ChartConfiguration` from chart.js: it holds builders. */
const CONFIGURATION_TYPE_IMPORT =
  /import\s+type\s*\{[^}]*\bChartConfiguration\b[^}]*\}\s*from\s*["']chart\.js["']/;
function isBuilderFile(text: string): boolean {
  return CONFIGURATION_TYPE_IMPORT.test(text);
}

const THEME_IMPORT = /from\s*["']\$lib\/utils\/chart-theme["']/;

/** The tension values written in the source (`tension: 0.3`, `tension:0.4`, `tension = x`). */
function tensionValues(text: string): string[] {
  const values: string[] = [];
  const re = /\btension\b\s*[:=]\s*(-?[0-9.]+|[A-Za-z_$][\w$.]*)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) values.push(m[1]);
  return values;
}

/** The second argument of every `new Chart(` call, whitespace-trimmed ("" when missing). */
function secondArguments(text: string): string[] {
  const out: string[] = [];
  const re = /new\s+Chart\s*\(/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const args: string[] = [];
    let start = i;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") {
        depth--;
        if (depth === 0) args.push(text.slice(start, i));
      } else if (c === "," && depth === 1) {
        args.push(text.slice(start, i));
        start = i + 1;
      }
    }
    out.push((args[1] ?? "").trim());
  }
  return out;
}

/** The name of the call a `new Chart(` argument is, or null for anything else (an inline object). */
function calledBuilder(argument: string): string | null {
  const m = /^(\w+)\s*\(/.exec(argument);
  return m === null ? null : m[1];
}

/** The `export function <name>ChartConfig` builders of a builder file. */
function exportedBuilders(text: string): string[] {
  const names: string[] = [];
  const re = /export\s+function\s+(\w+ChartConfig)\s*\(/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) names.push(m[1]);
  return names;
}

/** The opening tag of every `<canvas`, up to its closing `>` outside a `{...}` expression. */
function canvasTags(text: string): string[] {
  const tags: string[] = [];
  const re = /<canvas\b/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let depth = 0;
    let i = m.index;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    tags.push(text.slice(m.index, i + 1));
  }
  return tags;
}

/** What is wrong with a canvas tag, or null when it is labelled from its descriptor. */
function canvasProblem(tag: string): string | null {
  if (!/\baria-label=\{chartAriaLabel\(/.test(tag)) return "aria-label is not chartAriaLabel(...)";
  if (!/\brole="img"/.test(tag)) return 'role="img" is missing';
  return null;
}

/** True when the source holds a hex or rgb/hsl colour literal. */
const COLOUR_LITERAL =
  /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-zA-Z])|["'`]#(?:[0-9a-fA-F]{3,4})["'`]|\b(?:rgb|rgba|hsl|hsla)\s*\(/;
function hasColourLiteral(text: string): boolean {
  return COLOUR_LITERAL.test(text);
}

// ── Runtime table (G4) ─────────────────────────────────────────────────────────────────────────

const STUB_THEME: ChartTheme = {
  brand: "S-brand",
  brandLight: "S-brandLight",
  brandTint: "S-brandTint",
  neutral: "S-neutral",
  sick: "S-sick",
  green: "S-green",
  red: "S-red",
  yellow: "S-yellow",
  text: "S-text",
  textMuted: "S-textMuted",
  border: "S-border",
  surface: "S-surface",
  gridColor: "S-grid",
  fontFamily: "S-font",
};

function stubView(over: Partial<TeamTrendView> = {}): TeamTrendView {
  return {
    months: [
      { month: "2026-05", label: "Mai 26" },
      { month: "2026-06", label: "Jun 26" },
    ],
    workedHours: [100, 110],
    shouldHours: [120, 120],
    sickDays: [2, 0],
    workedSeriesLabel: "Ist (h)",
    chartSub: "Letzte 6 Monate",
    sollNote: null,
    trendNote: null,
    ...over,
  };
}

interface BuiltChart {
  descriptor: ChartDescriptor;
  config: { type?: string; data: { datasets: unknown[] }; options?: unknown };
  /** A signed series needs an emphasised zero line. */
  signed: boolean;
}

/** One entry per builder name used by a `new Chart(`; a builder with two shapes lists both. */
const RUNTIME_TABLE: Record<string, () => BuiltChart[]> = {
  teamSickDaysChartConfig: () => [
    {
      descriptor: TEAM_SICK_DAYS_CHART,
      config: teamSickDaysChartConfig(stubView(), STUB_THEME, null),
      signed: false,
    },
  ],
  teamHoursChartConfig: () => [
    {
      descriptor: teamHoursChartDescriptor(stubView()),
      config: teamHoursChartConfig(stubView(), STUB_THEME, null),
      signed: false,
    },
    {
      descriptor: teamHoursChartDescriptor(stubView({ shouldHours: null })),
      config: teamHoursChartConfig(stubView({ shouldHours: null }), STUB_THEME, null),
      signed: false,
    },
  ],
  teamSaldoTrendChartConfig: () => [
    {
      descriptor: TEAM_SALDO_TREND_CHART,
      config: teamSaldoTrendChartConfig(["Mai 26", "Jun 26"], [-1, 2], STUB_THEME, null),
      signed: true,
    },
  ],
  teamSaldoBarsChartConfig: () => [
    {
      descriptor: TEAM_SALDO_BARS_CHART,
      config: teamSaldoBarsChartConfig(
        [{ id: "a", name: "A", totalMinutes: 60, label: "+1:00" }],
        STUB_THEME,
        { onBar: () => undefined, isClickable: () => true },
      ),
      signed: true,
    },
  ],
};

/** Every `tension` value anywhere in a config. */
function deepTensions(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) deepTensions(item, found);
  } else if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (key === "tension") found.push(inner);
      deepTensions(inner, found);
    }
  }
  return found;
}

// ── Anti-vacuity and positive controls ─────────────────────────────────────────────────────────

describe("Issue #591 - the chart style guard looks at a real source tree", () => {
  it("walks a real source tree (vacuity)", () => {
    expect(WALKED.length).toBeGreaterThan(WALK_FLOOR);
    const rels = FILES.map((f) => f.rel);
    expect(rels).toContain(THEME_FILE);
    expect(rels).toContain(BUILDER_FILE);
    expect(rels.some((r) => r.includes("__tests__"))).toBe(false);
  });

  it("finds exactly the chart files and the builder file", () => {
    const chartFiles = FILES.filter((f) => isChartFile(f.text)).map((f) => f.rel);
    expect(chartFiles.sort()).toEqual([...EXPECTED_CHART_FILES].sort());
    const builderFiles = FILES.filter((f) => isBuilderFile(f.text)).map((f) => f.rel);
    expect(builderFiles).toContain(BUILDER_FILE);
  });

  it("the matchers fire on a violation and stay quiet on the conforming form", () => {
    expect(tensionValues("tension: 0.3,")).toEqual(["0.3"]);
    expect(tensionValues("tension:0.4")).toEqual(["0.4"]);
    expect(tensionValues("line: { tension: 0, borderWidth: 2 }")).toEqual(["0"]);
    expect(tensionValues("(`tension: 0`) and no tension at all")).toEqual(["0"]);

    expect(secondArguments("new Chart(el, {\n type: 'bar' })").map(calledBuilder)).toEqual([null]);
    expect(
      secondArguments("new Chart(el, teamSickDaysChartConfig(view, getChartTheme(), null))").map(
        calledBuilder,
      ),
    ).toEqual(["teamSickDaysChartConfig"]);
    expect(
      secondArguments("new Chart(\n  el,\n  teamSaldoBarsChartConfig(bars, t, { a: 1 }),\n)").map(
        calledBuilder,
      ),
    ).toEqual(["teamSaldoBarsChartConfig"]);

    expect(canvasProblem('<canvas role="img" aria-label="Säulendiagramm: x"></canvas>')).not.toBe(
      null,
    );
    expect(
      canvasProblem('<canvas role="img" aria-label={chartAriaLabel(X_CHART)}></canvas>'),
    ).toBeNull();
    expect(canvasProblem("<canvas aria-label={chartAriaLabel(X_CHART)}></canvas>")).not.toBe(null);
    expect(canvasTags('<canvas aria-label={fn(a > b)} role="img"></canvas>')[0]).toBe(
      '<canvas aria-label={fn(a > b)} role="img">',
    );

    expect(hasColourLiteral('color: "#ef4444"')).toBe(true);
    expect(hasColourLiteral("backgroundColor: 'rgba(239, 68, 68, 0.1)'")).toBe(true);
    expect(hasColourLiteral('fill: "#fff"')).toBe(true);
    expect(hasColourLiteral("// Issue #591 uses tokens only")).toBe(false);
    expect(hasColourLiteral("color: theme.brand")).toBe(false);

    expect(isChartFile("const c = new Chart(el, x);")).toBe(true);
    expect(isChartFile('import { Chart } from "chart.js";')).toBe(true);
    expect(isChartFile('import type { ChartConfiguration } from "chart.js";')).toBe(false);
    expect(
      isBuilderFile('import type { ActiveElement, ChartConfiguration } from "chart.js";'),
    ).toBe(true);
    expect(exportedBuilders("export function fooChartConfig(a) {}\nfunction bar() {}")).toEqual([
      "fooChartConfig",
    ]);
  });
});

// ── The rules ──────────────────────────────────────────────────────────────────────────────────

describe("Issue #591 - one chart style (D-591-5)", () => {
  const chartFiles = FILES.filter((f) => isChartFile(f.text));
  const builderFiles = FILES.filter((f) => isBuilderFile(f.text));

  it("G1: every chart file and builder file imports the chart-theme module", () => {
    const offenders = [...chartFiles, ...builderFiles]
      .filter((f) => !THEME_IMPORT.test(f.text))
      .map((f) => f.rel);
    expect(offenders, `files without the $lib/utils/chart-theme import: ${offenders}`).toEqual([]);
  });

  it("G2: no file holds a tension other than 0", () => {
    const offenders = FILES.flatMap((f) =>
      tensionValues(f.text)
        .filter((v) => v !== "0")
        .map((v) => `${f.rel}: tension ${v}`),
    );
    expect(offenders, `a discrete series is never smoothed: ${offenders}`).toEqual([]);
  });

  it("G3: every new Chart(...) is built by a builder, and the runtime table covers exactly those", () => {
    const exported = builderFiles.flatMap((f) => exportedBuilders(f.text));
    expect(exported.length).toBeGreaterThan(0);
    const used = new Set<string>();
    const offenders: string[] = [];
    for (const file of chartFiles) {
      for (const argument of secondArguments(file.text)) {
        const name = calledBuilder(argument);
        if (name === null || !exported.includes(name)) {
          offenders.push(`${file.rel}: ${argument.slice(0, 60)}`);
        } else {
          used.add(name);
        }
      }
    }
    expect(offenders, `a chart is built inline or by an unknown function: ${offenders}`).toEqual(
      [],
    );
    expect([...used].sort()).toEqual(Object.keys(RUNTIME_TABLE).sort());
    expect([...exported].sort()).toEqual(Object.keys(RUNTIME_TABLE).sort());
  });

  it("G4: every builder titles its value axis, never smooths and draws what its descriptor says", () => {
    for (const [name, build] of Object.entries(RUNTIME_TABLE)) {
      const cases = build();
      expect(cases.length, name).toBeGreaterThan(0);
      for (const { descriptor, config, signed } of cases) {
        const options = config.options as {
          indexAxis?: string;
          scales?: Record<
            string,
            {
              title?: { display?: boolean; text?: string };
              grid?: { color?: unknown };
            }
          >;
        };
        const key = options.indexAxis === "y" ? "x" : "y";
        expect(key, `${name}: the value axis of a ${descriptor.kind}`).toBe(
          valueAxisKey(descriptor.kind),
        );
        const axis = options.scales?.[key];
        expect(axis?.title?.display, `${name}: the ${key} axis has a visible title`).toBe(true);
        expect(Object.values(CHART_UNIT_TITLE), name).toContain(axis?.title?.text);
        expect(axis?.title?.text, `${name}: the title is the unit of the descriptor`).toBe(
          CHART_UNIT_TITLE[descriptor.unit],
        );
        expect(
          deepTensions(config).every((t) => t === 0),
          `${name}: a tension other than 0`,
        ).toBe(true);
        for (const dataset of config.data.datasets as Array<{ tension?: number }>) {
          if (config.type === "line") expect(dataset.tension, `${name}: line tension`).toBe(0);
        }
        expect(config.type, `${name}: chart.js type of ${descriptor.kind}`).toBe(
          chartJsType(descriptor.kind),
        );
        expect(chartAriaLabel(descriptor), name).toMatch(/, in (Stunden|Kalendertagen)$/);
        if (signed) {
          const color = axis?.grid?.color;
          expect(typeof color, `${name}: a signed series draws a zero line`).toBe("function");
          const at = color as (ctx: { tick: { value: number } }) => string;
          expect(at({ tick: { value: 0 } })).not.toBe(at({ tick: { value: 1 } }));
        }
      }
    }
  });

  it("G5: every canvas is labelled from its descriptor and carries role=img", () => {
    const svelteFiles = FILES.filter((f) => f.rel.endsWith(".svelte"));
    const tags = svelteFiles.flatMap((f) => canvasTags(f.text).map((tag) => ({ rel: f.rel, tag })));
    expect(tags.length).toBeGreaterThanOrEqual(4);
    const offenders = tags.flatMap(({ rel, tag }) => {
      const problem = canvasProblem(tag);
      return problem === null ? [] : [`${rel}: ${problem}`];
    });
    expect(
      offenders,
      `canvases that can name another chart than the one drawn: ${offenders}`,
    ).toEqual([]);
    // Every chart file that builds a chart owns a canvas, so no chart is drawn into an unlabelled one.
    for (const file of chartFiles.filter((f) => f.rel.endsWith(".svelte"))) {
      expect(canvasTags(file.text).length, file.rel).toBeGreaterThan(0);
    }
  });

  it("G6: no hex or rgb colour literal in the style module or a builder file", () => {
    const offenders = [fileText(THEME_FILE), ...builderFiles.map((f) => f.text)]
      .map((text, i) => ({ text, rel: i === 0 ? THEME_FILE : builderFiles[i - 1].rel }))
      .filter(({ text }) => hasColourLiteral(text))
      .map(({ rel }) => rel);
    expect(offenders, `colours come from the tokens only: ${offenders}`).toEqual([]);
  });
});
