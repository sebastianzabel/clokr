// Issue #843, plan 30 (D-843-05, D-843-18): fixture proof for the routes mode of
// `scripts/lint-ui-classes.mjs` — the detectors that find page-own patterns in routes and area
// components. A gate that matches nothing reports OK forever, so every rule has a positive
// control here and the walked scopes carry a non-empty floor (T-843-30).

import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import {
  PATTERN_RULES,
  detectPagePatterns,
  walkPatternScopes,
} from "../../scripts/lint-ui-classes.mjs";

const ZERO = {
  "own-filter-bar": 0,
  "own-period-control": 0,
  "own-kpi-card": 0,
  "own-data-table": 0,
  "raw-scrim-modal": 0,
};

describe("detectPagePatterns (routes mode detectors)", () => {
  it("returns a count for every rule, all zero for an empty page", () => {
    expect(detectPagePatterns("<p>Hallo</p>")).toEqual(ZERO);
    expect(Object.keys(detectPagePatterns("")).sort()).toEqual([...PATTERN_RULES].sort());
  });

  it("counts an own filter bar", () => {
    expect(detectPagePatterns(`<div class="filter-bar"><input /></div>`)).toEqual({
      ...ZERO,
      "own-filter-bar": 1,
    });
  });

  it("counts every element of a hand-built filter row once", () => {
    const source = `
      <div class="table-toolbar">
        <input class="filter-search" />
        <select class="filter-select"></select>
        <select class="filter-select"></select>
        <button class="filter-toggle filter-toggle--on">Nur aktive</button>
        <span class="filter-count">3</span>
      </div>`;
    expect(detectPagePatterns(source)["own-filter-bar"]).toBe(6);
  });

  it("matches the suffix forms of the filter rule", () => {
    expect(detectPagePatterns(`<div class="audit-filter-bar"></div>`)["own-filter-bar"]).toBe(1);
    expect(detectPagePatterns(`<div class="status-filters"></div>`)["own-filter-bar"]).toBe(1);
    expect(detectPagePatterns(`<div class="leave-toolbar"></div>`)["own-filter-bar"]).toBe(1);
  });

  it("counts an own period control by class and by its Vorheriger/Nächster label", () => {
    expect(detectPagePatterns(`<div class="month-bar"></div>`)["own-period-control"]).toBe(1);
    expect(
      detectPagePatterns(`<button class="nav-btn" aria-label="Nächster Monat">›</button>`),
    ).toEqual({ ...ZERO, "own-period-control": 1 });
    expect(detectPagePatterns(`<button title="Vorherige Woche">‹</button>`)).toEqual({
      ...ZERO,
      "own-period-control": 1,
    });
    expect(detectPagePatterns(`<button aria-label="Vormonat">‹</button>`)).toEqual({
      ...ZERO,
      "own-period-control": 1,
    });
  });

  it("counts an own KPI card", () => {
    expect(detectPagePatterns(`<div class="kpi-card"><b>12</b></div>`)).toEqual({
      ...ZERO,
      "own-kpi-card": 1,
    });
    expect(detectPagePatterns(`<div class="mini-stat-grid"></div>`)["own-kpi-card"]).toBe(1);
    expect(detectPagePatterns(`<div class="vac-stat"></div>`)["own-kpi-card"]).toBe(1);
  });

  it("counts an own data table, only on a raw table element", () => {
    expect(detectPagePatterns(`<table class="data-table"><tr></tr></table>`)).toEqual({
      ...ZERO,
      "own-data-table": 1,
    });
    expect(detectPagePatterns(`<table class="table table-wide"></table>`)["own-data-table"]).toBe(
      1,
    );
    expect(detectPagePatterns(`<div class="data-table"></div>`)["own-data-table"]).toBe(0);
    expect(detectPagePatterns(`<table class="calendar-grid"></table>`)["own-data-table"]).toBe(0);
  });

  it("flags raw scrim and modal markup", () => {
    expect(detectPagePatterns(`<div class="scrim"></div>`)).toEqual({
      ...ZERO,
      "raw-scrim-modal": 1,
    });
    expect(detectPagePatterns(`<div class="modal"><div class="modal-hd"></div></div>`)).toEqual({
      ...ZERO,
      "raw-scrim-modal": 2,
    });
  });

  it("finds the class in a Svelte expression and in a class directive", () => {
    expect(
      detectPagePatterns(`<div class={["filter-bar", open && "open"].join(" ")}></div>`)[
        "own-filter-bar"
      ],
    ).toBe(1);
    expect(detectPagePatterns(`<div class:kpi={highlight}></div>`)["own-kpi-card"]).toBe(1);
    expect(
      detectPagePatterns(`<div class="row {big ? 'kpi-card' : ''}"></div>`)["own-kpi-card"],
    ).toBe(1);
  });

  it("survives a > and quotes inside an attribute expression", () => {
    const source = `<button onclick={() => (a > b ? go("x") : stay())} class="nav-btn">›</button>`;
    expect(detectPagePatterns(source)["own-period-control"]).toBe(1);
  });

  it("counts a page built from the blocks as zero everywhere", () => {
    const source = `
      <script>
        const period = "filter-bar kpi-card month-bar";
      </script>
      <PageHeader title="Zeiten" />
      <PeriodPicker bind:value={period} />
      <KpiStrip items={items} />
      <TableToolbar />
      <DataTable rows={rows} columns={columns} />
      <Dialog open={open}><p>Text</p></Dialog>`;
    expect(detectPagePatterns(source)).toEqual(ZERO);
  });

  it("does not count a block tag that carries a pattern-looking class", () => {
    expect(detectPagePatterns(`<KpiStrip class="kpi-card" />`)).toEqual(ZERO);
  });

  it("ignores script, style and comments", () => {
    const source = `
      <script>const t = '<div class="filter-bar">';</script>
      <!-- <div class="kpi-card"></div> -->
      <style>.filter-bar { color: red; } table.data-table { margin: 0; }</style>
      <p>ok</p>`;
    expect(detectPagePatterns(source)).toEqual(ZERO);
  });

  it("does not take a less-than sign in text for a tag", () => {
    const source = `{#if a <b}<p>x</p>{/if}<div class="filter-bar"></div>`;
    expect(detectPagePatterns(source)["own-filter-bar"]).toBe(1);
  });
});

describe("walkPatternScopes (anti-vacuity floor)", () => {
  const { routes, components } = walkPatternScopes();

  it("walks a non-empty route scope and a non-empty area-component scope", () => {
    expect(routes.length).toBeGreaterThan(40);
    expect(components.length).toBeGreaterThan(40);
  });

  it("keeps ui/ and layout/ out of the component scope and routes in the route scope", () => {
    expect(components.some((f) => f.includes("/lib/components/ui/"))).toBe(false);
    expect(components.some((f) => f.includes("/lib/components/layout/"))).toBe(false);
    expect(components.some((f) => f.endsWith("/lib/components/leave/LeaveToolbar.svelte"))).toBe(
      true,
    );
    expect(routes.every((f) => f.includes("/src/routes/"))).toBe(true);
    expect(routes.some((f) => f.endsWith("/(app)/dashboard/+page.svelte"))).toBe(true);
  });

  it("finds real page-own markup in the walked files (the detectors are not blind)", () => {
    const toolbar = components.find((f) => f.endsWith("/lib/components/leave/LeaveToolbar.svelte"));
    expect(toolbar).toBeDefined();
    const counts = detectPagePatterns(readFileSync(toolbar as string, "utf8"));
    expect(counts["own-filter-bar"]).toBeGreaterThan(0);
  });
});
