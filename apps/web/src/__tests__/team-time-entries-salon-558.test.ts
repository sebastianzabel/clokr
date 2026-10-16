// Issue #558 D-14 — source pins of the person selector of `/team/time-entries`.
//
// The header salon narrows ONLY who can be picked. The chosen person's month (entries, Soll, saldo,
// absences, shifts, day checks) is a contract figure and is never split by salon. The page cannot
// be mounted (`$app/*`, a dozen requests on mount; see team-salon-view-85.test.ts), so this file
// proves the wiring by reading the source. The rendering contract of the label is mounted in
// `lib/components/team/__tests__/SalonScopeLabel.test.ts`.
//
// Mutation proof (Phase 558, 2026-10-16) — recorded here, not re-run by CI; each change was
// reverted (cp restore, `git diff --quiet` clean) after confirming the observed failure:
// M1 `withSalonId(` added to one person-month URL (the `/day-breaks/checks` request of loadAll)
//    -> red: "[D-14 month unfiltered] the chosen person's month requests carry no salon".
// M2 the record fallback removed from `selectedEmployee` (`?? null` only)
//    -> red: "[D-14 kept selection] a chosen person stays selected when a salon change drops them
//    from the list".

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
  "../routes/(app)/team/time-entries/+page.svelte",
  "src/routes/(app)/team/time-entries/+page.svelte",
);

/** The body of `function <name>(` up to the next top-level function or section comment. */
function functionBody(name: string): string {
  const start = PAGE.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const next = PAGE.slice(start + 1).search(/\n {2}(?:async )?function |\n {2}\/\/ ──/);
  expect(next, `end of ${name} not found`).toBeGreaterThan(-1);
  return PAGE.slice(start, start + 1 + next);
}

describe("Issue #558 — the person selector of /team/time-entries follows the header salon", () => {
  it("[vacuity gate] the page source is loaded and still carries the person view", () => {
    expect(PAGE.length).toBeGreaterThan(50_000);
    expect(PAGE).toContain("Personenansicht");
    expect(PAGE).toContain("Salonansicht");
  });

  it('[filter] the employee list request is withSalonId("/employees", …) from the page filter', () => {
    expect(functionBody("loadEmployeeList")).toContain('withSalonId("/employees", salonId)');
    expect(PAGE).toContain("salonPageFilter($salonContext)");
    const at = PAGE.indexOf("$effect(() => {\n    if (!contextLoaded) return;");
    expect(at, "employee list effect not found").toBeGreaterThan(-1);
    const effect = PAGE.slice(at, PAGE.indexOf("\n  });", at));
    expect(effect).toContain("pageSalonId");
    expect(effect).toContain("untrack(");
    expect(effect).toContain("loadEmployeeList(salonId)");
    expect(PAGE).toContain("const contextLoaded = $derived($salonContext.loaded)");
  });

  it("[single-salon] only salonPageFilter($salonContext) decides; the raw selection never occurs", () => {
    expect(PAGE).not.toContain("selectedSalonId(");
    expect(PAGE).not.toContain(".selection");
  });

  it("[D-14 month unfiltered] the chosen person's month requests carry no salon", () => {
    const body = functionBody("loadAll");
    expect(body).toContain("/time-entries?from=");
    expect(body).toContain("/overtime/");
    expect(body).not.toContain("withSalonId(");
    expect(body).not.toContain("salonId=");
    // The single call site of withSalonId in the page is the employee list loader.
    const calls = PAGE.split("withSalonId(").length - 1;
    expect(calls).toBe(1);
  });

  it("[D-14 kept selection] a chosen person stays selected when a salon change drops them from the list", () => {
    expect(PAGE).toContain("selectedEmployeeRecord = emp;");
    const at = PAGE.indexOf("let selectedEmployee = $derived(");
    expect(at).toBeGreaterThan(-1);
    const derived = PAGE.slice(at, PAGE.indexOf(");", at));
    expect(derived).toContain("employees.find((e) => e.id === selectedEmployeeId)");
    expect(derived).toContain("selectedEmployeeRecord.id === selectedEmployeeId");
    // A salon change never clears the selection.
    expect(functionBody("loadEmployeeList")).not.toContain("selectedEmployeeId =");
  });

  it("[D-14 deep link] a linked person missing from the narrowed list is looked up once in the unfiltered list", () => {
    const at = PAGE.indexOf("normalizeEmployeeIdParam($page.url.searchParams.get");
    expect(at, "deep-link block not found").toBeGreaterThan(-1);
    const block = PAGE.slice(at, PAGE.indexOf("// Without a (valid) employee link", at));
    // The link waits for the first completed list load.
    expect(block).toContain("await firstListLoaded;");
    const missing = block.indexOf("if (!linked && pageSalonId !== null)");
    expect(missing).toBeGreaterThan(-1);
    const unfiltered = block.indexOf('api.get<Employee[]>("/employees")', missing);
    expect(unfiltered).toBeGreaterThan(missing);
    // The unfiltered request exists only inside the not-found branch, once in the whole page.
    expect(block.indexOf('api.get<Employee[]>("/employees")')).toBe(unfiltered);
    expect(PAGE.split('api.get<Employee[]>("/employees")').length - 1).toBe(1);
    // The #85 Salonansicht fallback is kept for a person that is still missing.
    expect(block.slice(unfiltered)).toContain('else teamMode = "salon";');
    // The first completed list load releases the link (success and failure alike).
    expect(functionBody("loadEmployeeList")).toContain("markFirstListLoaded();");
  });

  it("[404 calm] a rejected salon empties the selector and shows the calm text without a toast", () => {
    const body = functionBody("loadEmployeeList");
    expect(body).toContain("isSalonFilterRejected(err)");
    expect(body).toContain("employees = [];");
    expect(body).toContain("listRejected = isSalonFilterRejected(err)");
    expect(body).not.toContain("toasts.error");
    expect(body).not.toContain("console.error");
  });

  it("[stale response] the list loader carries a generation counter", () => {
    expect(PAGE).toContain("let employeeListGeneration = 0;");
    expect(functionBody("loadEmployeeList")).toContain("generation !== employeeListGeneration");
  });

  it("[label once] the shared label is rendered once, inside the person view before the selector", () => {
    expect(PAGE.split("<SalonScopeLabel").length - 1).toBe(1);
    const person = PAGE.indexOf('{#if teamMode === "person"}\n  <SalonScopeLabel');
    expect(person).toBeGreaterThan(-1);
    expect(PAGE.indexOf('<div class="employee-selector">', person)).toBeGreaterThan(person);
  });
});
