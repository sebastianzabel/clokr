// Issue #558 D-11 — source pins of the salon filter on the admin employee list.
//
// Why source-read and not mounted: the page imports `$app/*` and fires several requests on mount
// (the same wall `team-salon-view-85.test.ts` documents). The rendering contract of the label is
// mounted in `lib/components/team/__tests__/SalonScopeLabel.test.ts`, the pure decisions in
// `lib/salons/__tests__/page-scope.test.ts`; this file only proves the page uses them the way the
// decisions require.

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

/** The body of `function <name>(` up to the next top-level function. */
function functionBody(name: string): string {
  const start = PAGE.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const next = PAGE.slice(start + 1).search(/\n {2}(?:async )?function /);
  expect(next, `end of ${name} not found`).toBeGreaterThan(-1);
  return PAGE.slice(start, start + 1 + next);
}

describe("Issue #558 — the admin employee list follows the header salon", () => {
  it("[vacuity gate] the page source is loaded and still carries the person directory", () => {
    expect(PAGE.length).toBeGreaterThan(30_000);
    expect(PAGE).toContain("Personenverzeichnis");
  });

  it("[filter] the list request is built by withSalonId from the page filter", () => {
    expect(functionBody("loadEmployees")).toContain(
      'withSalonId("/employees?includeAnonymized=true", pageSalonId)',
    );
    expect(PAGE).toContain("salonPageFilter($salonContext)");
  });

  it("[single-salon] the page never names the store's raw selection", () => {
    expect(PAGE).not.toContain("selectedSalonId(");
    expect(PAGE).not.toContain(".selection");
  });

  it("[reload] an effect reads the loaded context and the salon and calls the loader via untrack", () => {
    const at = PAGE.indexOf("$effect(() => {\n    if (!contextLoaded) return;");
    expect(at, "salon reload effect not found").toBeGreaterThan(-1);
    const effect = PAGE.slice(at, PAGE.indexOf("\n  });", at));
    expect(effect).toContain("pageSalonId");
    expect(effect).toContain("untrack(");
    expect(effect).toContain("loadEmployees()");
    expect(PAGE).toContain("const contextLoaded = $derived($salonContext.loaded)");
  });

  it("[404] a rejected salon shows the calm text: no toast, no error banner", () => {
    const body = functionBody("loadEmployees");
    const catchAt = body.indexOf("catch (e: unknown)");
    expect(catchAt).toBeGreaterThan(-1);
    const rejected = body.indexOf("isSalonFilterRejected(e)", catchAt);
    expect(rejected).toBeGreaterThan(catchAt);
    const branch = body.slice(rejected, body.indexOf("} else {", rejected));
    expect(branch).toContain("salonRejected = true");
    expect(branch).toContain("employees = []");
    expect(branch).not.toContain("toasts.error");
    expect(branch).not.toContain("error =");
  });

  it("[stale response] the loader carries a generation counter", () => {
    const body = functionBody("loadEmployees");
    expect(PAGE).toContain("let listGeneration = 0;");
    expect(body).toContain("++listGeneration");
    expect(body).toContain("generation !== listGeneration");
  });

  it("[label] the shared label is rendered exactly once", () => {
    expect(PAGE.split("<SalonScopeLabel").length - 1).toBe(1);
    expect(PAGE).toContain("<SalonScopeLabel label={scopeLabel} rejected={salonRejected} />");
  });
});
