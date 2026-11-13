// Issue #853 (D-853-14, AC-3) - source pins of the header salon rule on Team › Personen (/team/personen).
//
// Why source-read and not mounted: a route page imports `$app/*` and fires its request on mount (the same
// wall `team-leave-salon-558.test.ts` documents). The rendering contract of the label is mounted in
// `lib/components/team/__tests__/SalonScopeLabel.test.ts`, the pure decisions in
// `lib/salons/__tests__/page-scope.test.ts` and `lib/team/__tests__/personen-model.test.ts`; this file
// proves the page uses them the way the decisions require. Personen is a FILTERED page, so it must not
// join the exempt-pages table of `salon-filter-exempt-pages-558.test.ts`. Who is listed stays the
// server's decision (reach #547): the page only narrows by the header salon through the API.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function readFromHere(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readFromHere(
  "../routes/(app)/team/personen/+page.svelte",
  "src/routes/(app)/team/personen/+page.svelte",
);
const EXEMPT = readFromHere(
  "./salon-filter-exempt-pages-558.test.ts",
  "src/__tests__/salon-filter-exempt-pages-558.test.ts",
);

/** The body of `async function load(` up to its closing brace at the top level of the script. */
function loadBody(): string {
  const start = PAGE.indexOf("async function load(");
  expect(start, "async function load not found").toBeGreaterThan(-1);
  const end = PAGE.indexOf("\n  }\n", start);
  expect(end, "end of load not found").toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

describe("Issue #853 — Team › Personen follows the header salon", () => {
  it("[vacuity gate] the page source is loaded and still is the Personen page", () => {
    expect(PAGE.length).toBeGreaterThan(5_000);
    expect(PAGE).toContain('title={pageLabel("/team/personen")}');
    expect(EXEMPT.length).toBeGreaterThan(3_000);
  });

  it("[filter] the page decides through salonPageFilter and sends the salon on its one request", () => {
    expect(PAGE).toContain("salonPageFilter($salonContext)");
    expect(PAGE).toContain("const pageSalonId = $derived(salonPageFilter($salonContext))");
    // The directory fields (Stammsalon, Rollen) are opt-in on GET /employees (Issue #853).
    expect(loadBody()).toContain('withSalonId("/employees?include=directory", pageSalonId)');
  });

  it("[one request] exactly one /employees request path, no other API read or salon handling", () => {
    expect(PAGE.match(/api\.get</g) ?? []).toHaveLength(1);
    expect(PAGE.match(/"\/employees\?include=directory"/g) ?? []).toHaveLength(1);
    // The list is the server's reach-narrowed answer: no second source, no client-side salon comparison.
    expect(PAGE).not.toContain("selectedSalonId(");
    expect(PAGE).not.toContain(".selection");
    expect(PAGE).not.toMatch(/\.salonId\s*===/);
  });

  it("[label] the page renders SalonScopeLabel with the shared scope label and the rejection", () => {
    expect(PAGE).toContain("<SalonScopeLabel");
    expect(PAGE).toContain("const scopeLabel = $derived(salonScopeLabel($salonContext))");
    expect(PAGE).toMatch(/<SalonScopeLabel\s+label=\{scopeLabel\}\s+rejected=\{salonRejected\}/);
  });

  it("[404 calm] a rejected salon empties the list and shows the calm text: no error state", () => {
    const body = loadBody();
    const catchAt = body.indexOf("catch (e: unknown)");
    expect(catchAt).toBeGreaterThan(-1);
    const rejected = body.indexOf("isSalonFilterRejected(e)", catchAt);
    expect(rejected).toBeGreaterThan(catchAt);
    const branch = body.slice(rejected, body.indexOf("} else {", rejected));
    expect(branch).toContain("salonRejected = true");
    expect(branch).toContain("people = []");
    expect(branch).not.toContain("failed = true");
    // Any other failure keeps the error state with a retry.
    expect(body.slice(body.indexOf("} else {", rejected))).toContain("failed = true");
    expect(PAGE).toContain("<ErrorState");
  });

  it("[reload] one effect on the loaded context and the salon runs the loader via untrack", () => {
    const at = PAGE.indexOf("$effect(() => {\n    if (!contextLoaded) return;");
    expect(at, "salon reload effect not found").toBeGreaterThan(-1);
    const effect = PAGE.slice(at, PAGE.indexOf("\n  });", at));
    expect(effect).toContain("pageSalonId");
    expect(effect).toContain("untrack(");
    expect(effect).toContain("load()");
    expect(PAGE).toContain("const contextLoaded = $derived($salonContext.loaded)");
  });

  it("[order] an older response never overwrites a newer one: generation counter checked after the await", () => {
    const body = loadBody();
    expect(PAGE).toContain("let generation = 0;");
    expect(body).toContain("++generation");
    const awaitAt = body.indexOf("await api.get");
    expect(awaitAt).toBeGreaterThan(-1);
    const check = body.indexOf("current !== generation", awaitAt);
    expect(check).toBeGreaterThan(awaitAt);
    expect(body.indexOf("people = list", awaitAt)).toBeGreaterThan(check);
  });

  it("[sentence] the salon name of the count sentence comes from the salon context, presentation only", () => {
    expect(PAGE).toContain("$salonContext.salons.find((salon) => salon.id === pageSalonId)?.name");
    expect(PAGE).toContain("activeCountSentence(activeCount(allRows), pageSalonName)");
  });

  it("[read-only] the page performs no write call", () => {
    expect(PAGE).not.toMatch(/api\.(post|put|patch|delete)/);
    expect(PAGE).not.toContain("{@html");
  });

  it("[exempt] Personen is not in the exempt-pages table: it is a filtered page", () => {
    expect(EXEMPT).not.toContain("team/personen");
    expect(EXEMPT).not.toContain("/team/personen");
  });
});
