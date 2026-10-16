// Issue #558 D-03/D-04/D-07 — source pins of the salon filter on /shifts/planning (Planungsbedarf).
//
// Why source-read and not mounted: the page fires its request on mount through `$api/client`. The
// rendering contract of the label is mounted in `lib/components/team/__tests__/SalonScopeLabel.test.ts`
// and the pure decisions in `lib/salons/__tests__/page-scope.test.ts`; this file proves the page uses
// them the way the decisions require. Server proof: the 404 cases of
// `apps/api/src/contexts/scheduling/api/__tests__/shifts-planning-overview.test.ts`.
//
// Mutation proof (Phase 558, 2026-10-16) — recorded here, not re-run by CI
//   M1 the 404 routed into loadError again (the calm branch removed) → red: "[404] a rejected salon is the calm text: rows emptied, flag set, no error"

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
  "../routes/(app)/shifts/planning/+page.svelte",
  "src/routes/(app)/shifts/planning/+page.svelte",
);

/** The body of `function <name>(` up to its closing brace at the script's two-space indent. */
function functionBody(name: string): string {
  const start = PAGE.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const next = PAGE.slice(start + 1).search(/\n {2}\}\n/);
  expect(next, `end of ${name} not found`).toBeGreaterThan(-1);
  return PAGE.slice(start, start + 1 + next);
}

describe("Issue #558 — Planungsbedarf follows the header salon", () => {
  it("[vacuity gate] the page source is loaded and still is the planning overview", () => {
    expect(PAGE.length).toBeGreaterThan(3_000);
    expect(PAGE).toContain("Planungsbedarf");
  });

  it("[filter] the overview read is built by withSalonId from the page filter; an older response is dropped", () => {
    const body = functionBody("load");
    expect(body).toContain(
      "withSalonId(`/shifts/planning-overview?weekStart=${weekStart}`, salonId)",
    );
    expect(body).toContain("++loadGeneration");
    expect(body).toContain("generation !== loadGeneration");
    expect(PAGE).toContain("const contextLoaded = $derived($salonContext.loaded)");
    expect(PAGE).toContain("const pageSalonId = $derived(salonPageFilter($salonContext))");
  });

  it("[single-salon] the page never names the store's raw selection", () => {
    expect(PAGE).not.toContain("selectedSalonId(");
    expect(PAGE).not.toContain(".selection");
  });

  it("[reload] one effect on two primitives owns the first load and every salon change; week paging still calls load()", () => {
    const at = PAGE.indexOf("$effect(() => {");
    expect(at).toBeGreaterThan(-1);
    const effect = PAGE.slice(at, PAGE.indexOf("\n  });", at));
    expect(effect).toContain("if (!contextLoaded) return;");
    expect(effect).toContain("pageSalonId");
    expect(effect).toContain("untrack(");
    expect(effect).toContain("load()");
    expect(PAGE.split("$effect(").length - 1).toBe(1);
    expect(PAGE).not.toContain("onMount");
    expect(functionBody("shiftWeek")).toContain("load()");
  });

  it("[404] a rejected salon is the calm text: rows emptied, flag set, no error", () => {
    const body = functionBody("load");
    const catchBody = body.slice(body.indexOf("catch (err)"));
    expect(catchBody.slice(0, catchBody.indexOf("isSalonFilterRejected(err)"))).toContain(
      "employees = []",
    );
    const branch = catchBody.slice(catchBody.indexOf("isSalonFilterRejected(err)"));
    const calm = branch.slice(0, branch.indexOf("return;"));
    expect(calm).toContain("salonRejected = true");
    expect(calm).not.toContain("loadError =");
    // any other failure keeps the red callout
    expect(branch).toContain("loadError =");
    expect(PAGE).toContain('<div class="callout error">{loadError}</div>');
  });

  it("[label] the scope label sits once, directly after the page head", () => {
    expect(PAGE.split("<SalonScopeLabel").length - 1).toBe(1);
    const head = PAGE.indexOf("<PageHead");
    expect(head).toBeGreaterThan(-1);
    const after = PAGE.slice(head, head + 400);
    expect(after).toContain("<SalonScopeLabel label={scopeLabel} rejected={salonRejected} />");
  });
});
