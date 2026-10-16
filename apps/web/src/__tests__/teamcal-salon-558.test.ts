// Issue #558 D-03/D-04/D-08 — source pins of the salon filter on the team calendar (/teamcal).
//
// Why source-read and not mounted: the page imports `$app/navigation` and fires its requests on
// mount (the same wall `teamcal-effective-statuses.test.ts` documents). The rendering contract of
// the label is mounted in `lib/components/team/__tests__/SalonScopeLabel.test.ts` and the pure
// decisions in `lib/salons/__tests__/page-scope.test.ts`; this file proves the page uses them the
// way the decisions require.
//
// Mutation proof (Phase 558, 2026-10-16) — recorded here, not re-run by CI
//   M1 the leave request URL built without withSalonId → red: "[filter] the people list and every leave request are built by withSalonId from the page filter"
//   M2 the generation check after the await removed → red: "[order] a response of an older load never overwrites a newer one"

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
  "../routes/(app)/teamcal/+page.svelte",
  "src/routes/(app)/teamcal/+page.svelte",
);

/** The body of `function <name>(` up to the next top-level function or comment block. */
function functionBody(name: string): string {
  const start = PAGE.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const next = PAGE.slice(start + 1).search(/\n {2}(?:async )?function |\n {2}\/\/ Note:/);
  expect(next, `end of ${name} not found`).toBeGreaterThan(-1);
  return PAGE.slice(start, start + 1 + next);
}

/** The text of a `$effect(() => { ... });` block that starts with the given first line. */
function effectBody(firstLine: string): string {
  const at = PAGE.indexOf(`$effect(() => {\n    ${firstLine}`);
  expect(at, `effect starting with "${firstLine}" not found`).toBeGreaterThan(-1);
  return PAGE.slice(at, PAGE.indexOf("\n  });", at));
}

describe("Issue #558 — the team calendar follows the header salon", () => {
  it("[vacuity gate] the page source is loaded and still is the team calendar", () => {
    expect(PAGE.length).toBeGreaterThan(8_000);
    expect(PAGE).toContain("Team-Kalender");
  });

  it("[filter] the people list and every leave request are built by withSalonId from the page filter", () => {
    const body = functionBody("load");
    expect(body).toContain('withSalonId("/employees", salonId)');
    expect(body).toContain("withSalonId(`/leave/requests?status=${status}`, salonId)");
    expect(body).toContain("EFFECTIVE_LEAVE_STATUSES.map(");
    expect(PAGE).toContain("salonPageFilter($salonContext)");
  });

  it("[single-salon] the page never names the store's raw selection", () => {
    expect(PAGE).not.toContain("selectedSalonId(");
    expect(PAGE).not.toContain(".selection");
  });

  it("[reload] one effect on two primitives owns every load; onMount starts none", () => {
    const effect = effectBody("if (!permitted || !contextLoaded) return;");
    expect(effect).toContain("pageSalonId");
    expect(effect).toContain("untrack(");
    expect(effect).toContain("load(salonId)");
    expect(PAGE).toContain("const contextLoaded = $derived($salonContext.loaded)");
    expect(PAGE).toContain("const pageSalonId = $derived(salonPageFilter($salonContext))");

    const at = PAGE.indexOf("onMount(() => {");
    expect(at).toBeGreaterThan(-1);
    const onMountBody = PAGE.slice(at, PAGE.indexOf("\n  });", at));
    expect(onMountBody).toContain("permitted = true");
    expect(onMountBody).not.toContain("load(");
  });

  it("[order] a response of an older load never overwrites a newer one", () => {
    const body = functionBody("load");
    expect(PAGE).toContain("let loadGeneration = 0;");
    expect(body).toContain("++loadGeneration");
    const awaitAt = body.indexOf("await Promise.all");
    expect(awaitAt).toBeGreaterThan(-1);
    const check = body.indexOf("generation !== loadGeneration", awaitAt);
    expect(check, "generation check after the await").toBeGreaterThan(awaitAt);
    expect(body.indexOf("employees = ", awaitAt)).toBeGreaterThan(check);
  });

  it("[404 calm] a rejected salon empties the grid and shows the calm text: no error alert", () => {
    const body = functionBody("load");
    const catchAt = body.indexOf("catch (e: unknown)");
    expect(catchAt).toBeGreaterThan(-1);
    const rejected = body.indexOf("isSalonFilterRejected(e)", catchAt);
    expect(rejected).toBeGreaterThan(catchAt);
    const branch = body.slice(rejected, body.indexOf("} else {", rejected));
    expect(branch).toContain("salonRejected = true");
    expect(branch).toContain("employees = []");
    expect(branch).toContain("requests = []");
    expect(branch).not.toContain("error =");
    // Any other failure keeps today's handling.
    expect(body).toContain('error = e instanceof Error ? e.message : "Fehler beim Laden"');
  });

  it("[label once] the shared label is rendered exactly once, directly after the page head", () => {
    expect(PAGE.split("<SalonScopeLabel").length - 1).toBe(1);
    const label = "<SalonScopeLabel label={scopeLabel} rejected={salonRejected} />";
    const headEnd = PAGE.indexOf("/>", PAGE.indexOf("<PageHead"));
    expect(headEnd).toBeGreaterThan(-1);
    expect(
      PAGE.slice(headEnd + 2)
        .trimStart()
        .startsWith(label),
    ).toBe(true);
  });

  it("[rejected empty state] a rejected salon does not also say that no team members exist", () => {
    expect(PAGE).toContain("{#if !salonRejected || loading}");
  });
});
