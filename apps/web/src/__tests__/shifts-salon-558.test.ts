// Issue #558 D-02/D-03/D-10/D-13 — source pins of the salon filter on the shift planner (/shifts).
//
// Why source-read and not mounted: the page imports `$app/navigation`, drag-and-drop and fires its
// requests on mount (the same wall `shifts-closed-days-563.test.ts` documents). The rendering contract of
// the label is mounted in `lib/components/team/__tests__/SalonScopeLabel.test.ts` and the pure
// decisions in `lib/salons/__tests__/page-scope.test.ts`; this file proves the page uses them the
// way the decisions require. Server proof: `apps/api/src/__tests__/shifts-week-salon-filter-558.test.ts`.
//
// Mutation proof (Phase 558, 2026-10-16) — recorded here, not re-run by CI
//   M1 sollRowByEmp ignoring the response code → red: "[soll] the Soll row is hidden by the response code, never by the filter state"
//   M2 the salon spread removed from the modal create body → red: "[create] both create bodies carry the selected salon; the edit body never does"
//   M3 the D-10 paragraph rendered unconditionally → red: "[bulk] both bulk dialogs state their whole-reach scope only while a salon is selected"

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
  "../routes/(app)/shifts/+page.svelte",
  "src/routes/(app)/shifts/+page.svelte",
);

/** The body of `function <name>(` up to its closing brace at the script's two-space indent. */
function functionBody(name: string): string {
  const start = PAGE.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const next = PAGE.slice(start + 1).search(/\n {2}\}\n/);
  expect(next, `end of ${name} not found`).toBeGreaterThan(-1);
  return PAGE.slice(start, start + 1 + next);
}

/** The text of a `$effect(() => { ... });` block that contains the given marker line. */
function effectContaining(marker: string): string {
  const markerAt = PAGE.indexOf(marker);
  expect(markerAt, `marker "${marker}" not found`).toBeGreaterThan(-1);
  const at = PAGE.lastIndexOf("$effect(() => {", markerAt);
  expect(at, `no effect before "${marker}"`).toBeGreaterThan(-1);
  return PAGE.slice(at, PAGE.indexOf("\n  });", at));
}

const SPREAD = "...(pageSalonId !== null ? { salonId: pageSalonId } : {})";
const BULK_NOTE =
  "Diese Aktion gilt für alle Salons Ihrer Reichweite, nicht nur für den gewählten Salon.";

describe("Issue #558 — the shift planner follows the header salon", () => {
  it("[vacuity gate] the page source is loaded and still is the shift planner", () => {
    expect(PAGE.length).toBeGreaterThan(60_000);
    expect(PAGE).toContain("Woche generieren");
  });

  it("[filter] the week read is built by withSalonId from the page filter; an older response is dropped", () => {
    const body = functionBody("load");
    expect(body).toContain("withSalonId(`/shifts/week?date=${date}`, salonId)");
    expect(body).toContain("++weekGeneration");
    expect(body).toContain("generation !== weekGeneration");
    expect(PAGE).toContain("salonPageFilter($salonContext)");
    expect(PAGE).toContain("const contextLoaded = $derived($salonContext.loaded)");
    expect(PAGE).toContain("const pageSalonId = $derived(salonPageFilter($salonContext))");
  });

  it("[single-salon] the page never names the store's raw selection", () => {
    expect(PAGE).not.toContain("selectedSalonId(");
    expect(PAGE).not.toContain(".selection");
  });

  it("[reload] one salon effect on primitives and plain lets; onMount loads only if the context is ready", () => {
    const effect = effectContaining("pageSalonId !== lastLoadedSalonKey");
    expect(effect).toContain("contextLoaded");
    expect(effect).toContain("mounted");
    expect(effect).toContain("gated");
    expect(effect).toContain("untrack(");
    expect(effect).toContain("load()");
    expect(PAGE).toMatch(/let lastLoadedSalonKey: string \| null \| undefined = undefined;/);
    expect(PAGE).toMatch(/let weekGeneration = 0;/);
    // the key is recorded inside load(), synchronously, so the effect cannot double-load
    expect(functionBody("load")).toContain("lastLoadedSalonKey = salonId");

    const at = PAGE.indexOf("onMount(() => {");
    expect(at).toBeGreaterThan(-1);
    const onMountBody = PAGE.slice(at, PAGE.indexOf("\n  });", at));
    expect(onMountBody).toMatch(/if \(contextLoaded\) void load\(\)/);
    expect(onMountBody).not.toContain("pageSalonId");

    // the week-navigation effect keeps its plain-let guard and never tracks the salon
    expect(PAGE).toContain("let prevCursorMondayTime: number | null = null;");
    const nav = effectContaining("const current = cursorMonday.getTime();");
    expect(nav).not.toContain("pageSalonId");
    expect(nav).toContain("untrack(");
  });

  it("[soll] the Soll row is hidden by the response code, never by the filter state", () => {
    expect(PAGE).toMatch(/contractSollMinutesByEmp\?: Record<string, number> \| null;/);
    expect(PAGE).toMatch(/sollUnavailableReason\?: "SALON_FILTER";/);
    const at = PAGE.indexOf("const sollRowByEmp = $derived.by(");
    expect(at).toBeGreaterThan(-1);
    const derived = PAGE.slice(at, PAGE.indexOf("for (const emp of week.employees)", at));
    expect(derived).toContain('week.sollUnavailableReason === "SALON_FILTER"');
    expect(derived).not.toContain("pageSalonId");
    expect(derived).not.toContain("$salonContext");
    // the note is shown exactly when the code is present
    expect(PAGE).toContain("SALON_SOLL_NOT_ATTRIBUTABLE_NOTE");
    expect(PAGE).toMatch(
      /\{#if week\.sollUnavailableReason === "SALON_FILTER"\}[\s\S]{0,400}SALON_SOLL_NOT_ATTRIBUTABLE_NOTE/,
    );
  });

  it("[create] both create bodies carry the selected salon; the edit body never does", () => {
    const drop = PAGE.slice(
      PAGE.indexOf('await api.post<Shift>("/shifts", {'),
      PAGE.indexOf("toasts.success(`Schicht zugewiesen: ${tpl.name}`)"),
    );
    expect(drop).toContain(SPREAD);
    const modalStart = PAGE.indexOf("await api.post<Shift>(`/shifts${qs}`, {");
    expect(modalStart).toBeGreaterThan(-1);
    expect(PAGE.slice(modalStart, PAGE.indexOf("toasts.success(force", modalStart))).toContain(
      SPREAD,
    );
    const putStart = PAGE.indexOf("await api.put<Shift>(`/shifts/${editingShiftId}${qs}`, {");
    expect(putStart).toBeGreaterThan(-1);
    expect(PAGE.slice(putStart, PAGE.indexOf("toasts.success(force", putStart))).not.toContain(
      "salonId",
    );
    expect(PAGE.split(SPREAD).length - 1).toBe(2);
  });

  it("[bulk] both bulk dialogs state their whole-reach scope only while a salon is selected", () => {
    const gen = PAGE.slice(
      PAGE.indexOf('title="Woche generieren"'),
      PAGE.indexOf('title="Woche kopieren"'),
    );
    const copy = PAGE.slice(PAGE.indexOf('title="Woche kopieren"'));
    for (const dialog of [gen, copy]) {
      expect(dialog).toMatch(
        new RegExp(
          `\\{#if pageSalonId !== null\\}[\\s\\S]{0,300}${BULK_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      );
    }
    expect(PAGE.split(BULK_NOTE).length - 1).toBe(2);
    // the bulk requests are unchanged: no salon in generate/copy bodies
    const generatePost = PAGE.slice(
      PAGE.indexOf("function openGenerate"),
      PAGE.indexOf("function openCopy"),
    );
    expect(generatePost).not.toContain("salonId");
  });

  it("[label][404] the scope label sits once after the page head; a rejected salon is calm, no error, no toast", () => {
    expect(PAGE.split("<SalonScopeLabel").length - 1).toBe(1);
    const head = PAGE.indexOf("</PageHead>");
    expect(head).toBeGreaterThan(-1);
    expect(PAGE.slice(head, head + 400)).toContain(
      "<SalonScopeLabel label={scopeLabel} rejected={weekRejected} />",
    );
    const body = functionBody("load");
    const branch = body.slice(body.indexOf("isSalonFilterRejected(e)"));
    expect(branch).toContain("week = null");
    expect(branch).toContain("weekRejected = true");
    expect(branch.slice(0, branch.indexOf("return;"))).not.toContain("error =");
    expect(branch.slice(0, branch.indexOf("return;"))).not.toContain("toasts");
    // closedView stays presentation only
    expect(PAGE).toMatch(/closedDaysFor\(\s*week\?\.salonOpeningHours,\s*\$salonContext\s*\)/);
  });
});
