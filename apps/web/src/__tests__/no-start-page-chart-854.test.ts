// Issue #895 (AC-8, D-854-14) - no start page draws a chart. The team trends and the card „Salden“
// moved from the start page to Verwalten › Berichte (tab „Verläufe“); a chart creeping back onto Ich ›
// Mein Tag, Team › Heute im Salon or Verwalten › Übersicht would undo the owner decision of #846 (D-04).
//
// The guard resolves the three start pages through the route table (`file ?? href`), then follows
// their imports (the `$lib` / `$components` / `$stores` / `$api` aliases and relative paths, `.svelte`
// and `.ts` files) and fails when any reachable file holds a `<canvas`, a value import of chart.js or
// an import of the chart builders. A chart drawn by a component the start page mounts is therefore
// caught, not only one written into the page file.
//
// Named blind spot: a dynamic `import()` with a computed path is not followed; none exists.
// Anti-vacuity: the start pages must resolve, the walk must reach a floor of files, and the matcher
// is proven on a positive and a clean synthetic source.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { APP_ROUTES } from "$lib/nav/routes";

import { SRC_ROOT } from "./design-source-files";

const START_PAGES = ["/ich/tag", "/team/heute", "/verwalten"] as const;

/** Reachable files below this count mean the import walk silently stopped (12.11.2026: 32 for /verwalten, more for the dashboard; floor = measured minus about 20 %). */
const REACHABLE_FLOOR = 25;

const ALIASES: Record<string, string> = {
  $lib: "lib",
  $components: "lib/components",
  $stores: "lib/stores",
  $api: "lib/api",
};

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s*)?["']([^"']+)["']/g;

/** A source that draws or builds a chart: a canvas, a value import of chart.js or the builders. */
export function drawsChart(text: string): string | null {
  if (/<canvas[\s>]/.test(text)) return "<canvas";
  if (/import\s+(?!type\s)[^;]*?from\s*["']chart\.js["']/.test(text)) return "chart.js import";
  if (/from\s*["'][^"']*\/team-charts["']/.test(text)) return "team-charts import";
  return null;
}

function resolveImport(specifier: string, fromFile: string): string | null {
  let base: string | null = null;
  if (specifier.startsWith(".")) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    const alias = Object.keys(ALIASES).find(
      (a) => specifier === a || specifier.startsWith(`${a}/`),
    );
    if (alias !== undefined) base = join(SRC_ROOT, ALIASES[alias], specifier.slice(alias.length));
  }
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.svelte`, join(base, "index.ts")]) {
    if (existsSync(candidate) && /\.(ts|svelte)$/.test(candidate)) return candidate;
  }
  return null;
}

/** The start page file and every local file it reaches through imports. */
function reachableFrom(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const text = readFileSync(file, "utf8");
    seen.set(file, text);
    for (const m of text.matchAll(IMPORT_RE)) {
      const next = resolveImport(m[1], file);
      if (next !== null && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

function startPageFile(href: string): string {
  const route = APP_ROUTES.find((r) => r.href === href);
  expect(route, `${href} is in the route table`).toBeDefined();
  const key = route!.file ?? route!.href;
  const file = join(SRC_ROOT, "routes/(app)", key, "+page.svelte");
  expect(existsSync(file), `${file} exists`).toBe(true);
  return file;
}

describe("Issue #895 - no start page draws a chart", () => {
  it("resolves the three start pages to three distinct route files (floor 3)", () => {
    const files = START_PAGES.map(startPageFile);
    expect(new Set(files).size).toBe(START_PAGES.length);
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(START_PAGES)("%s reaches no canvas, no chart.js and no chart builder", (href) => {
    const reached = reachableFrom(startPageFile(href));
    expect(reached.size, `${href}: the import walk reached files`).toBeGreaterThan(REACHABLE_FLOOR);
    const offenders = [...reached.entries()]
      .map(([file, text]) => ({ file, hit: drawsChart(text) }))
      .filter((o) => o.hit !== null)
      .map((o) => `${o.file.slice(SRC_ROOT.length + 1)}: ${o.hit}`);
    expect(offenders, `a start page must not draw a chart: ${offenders}`).toEqual([]);
  });

  it("the walk reaches the real chart files from their own tab (positive control)", () => {
    const berichte = reachableFrom(join(SRC_ROOT, "routes/(app)/reports/+page.svelte"));
    const hits = [...berichte.keys()]
      .filter((file) => drawsChart(berichte.get(file)!) !== null)
      .map((file) => file.slice(SRC_ROOT.length + 1))
      .sort();
    expect(hits).toContain("lib/components/reports/TeamTrendsTab.svelte");
    expect(hits).toContain("lib/components/dashboard/TeamSaldoCard.svelte");
  });

  it("the matcher fires on each shape and stays quiet on a conforming source", () => {
    expect(drawsChart("<canvas bind:this={el}></canvas>")).toBe("<canvas");
    expect(drawsChart('import { Chart } from "chart.js";')).toBe("chart.js import");
    expect(drawsChart('import type { ChartConfiguration } from "chart.js";')).toBeNull();
    expect(drawsChart('import { teamHoursChartConfig } from "$lib/dashboard/team-charts";')).toBe(
      "team-charts import",
    );
    expect(drawsChart('<p>Kein Diagramm</p>\nimport Foo from "./Foo.svelte";')).toBeNull();
  });
});
