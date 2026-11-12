// Issue #648 / #843 D-843-11 - source pin of the /admin/employees person table.
//
// The fix of #648 (second defect) is the block: the person table is a DataTable, whose rows become
// cards below a 760 px container width, so the e-mail value stays inside a 360 px viewport. The page
// must therefore own no <table> of its own and must keep its search text and sort in the URL through
// the list schema. The geometry (e-mail value inside the viewport at 360 px) is proven by the e2e of
// plan 843-26 (jsdom has no container queries); this file only keeps the page on the block. The page
// imports `$app/navigation` and fires requests on mount, so it is source-read, like
// `admin-employees-salon-558.test.ts`.
//
// Mutation proof (843-26) - recorded here, not re-run by CI:
//   M1 a `<table class="table">` put back into the page -> red: "[own table]"
//   M2 the `<DataTable …>` element removed from the page -> red: "[block]"
//   M3 the `urlState(listUrlSchema)` binding removed -> red: "[url state]"

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readRouteFile(
  "../routes/(app)/admin/employees/+page.svelte",
  "src/routes/(app)/admin/employees/+page.svelte",
);

/** What the pin forbids: a table element of the page's own. */
function ownTableMarkup(source: string): string[] {
  const found: string[] = [];
  if (/<table\b/.test(source)) found.push("<table");
  if (/\btable-wrap\b/.test(source)) found.push("table-wrap");
  return found;
}

describe("#648 /admin/employees person table is the DataTable block (#843 D-843-11)", () => {
  it("[floor] the walked source is the real page, not an empty read", () => {
    expect(PAGE.length).toBeGreaterThan(10_000);
  });

  it("[block] the page imports and renders DataTable with the row click and the Skeleton loading", () => {
    expect(PAGE).toContain('from "$components/ui/DataTable.svelte"');
    // The element ends at its caption prop; `=>` inside the handlers rules out a plain `>` search.
    const start = PAGE.indexOf("<DataTable\n");
    const end = PAGE.indexOf("caption=", start);
    expect(start, "no <DataTable> element on the page").toBeGreaterThan(-1);
    expect(end, "the <DataTable> element has no caption").toBeGreaterThan(start);
    const element = PAGE.slice(start, end);
    expect(element).toContain("onRowClick");
    expect(element).toContain("{loading}");
  });

  it("[own table] the page has no <table> and no table-wrap of its own", () => {
    expect(ownTableMarkup(PAGE)).toEqual([]);
  });

  it("[url state] search and sort go through urlState with the list schema", () => {
    expect(PAGE).toContain('from "$lib/employees/list-url-state"');
    expect(PAGE).toMatch(/urlState\(\s*listUrlSchema\s*\)/);
  });

  // #854 (plan 854-18): the filter bar and the KPI row of the list are blocks too.
  it("[toolbar] the filter bar is the TableToolbar block and the KPI row the KpiStrip", () => {
    expect(PAGE).toContain('from "$components/ui/TableToolbar.svelte"');
    expect(PAGE).toContain("<TableToolbar");
    expect(PAGE).toContain('from "$components/ui/KpiStrip.svelte"');
    expect(PAGE).toContain("<KpiStrip");
    expect(PAGE).toContain("<PageHead");
    // The former hand-built bar: a search input, selects and a „x von y“ count of its own.
    expect(PAGE).not.toMatch(
      /class="[^"]*\b(filter-search|filter-select|filter-toggle|filter-count)\b/,
    );
    expect(PAGE).not.toContain("<KPIStat");
  });

  it("[control] positive control: a raw table of the page's own is reported", () => {
    const fixture = '<div class="table-wrap"><table class="table"><thead></thead></table></div>';
    expect(ownTableMarkup(fixture)).toEqual(["<table", "table-wrap"]);
  });
});
