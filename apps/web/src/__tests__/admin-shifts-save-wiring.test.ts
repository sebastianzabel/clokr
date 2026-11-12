// Phase 109 (Issue #35), Plan 09, Task 2 — Wave-0 gap-closure regression net for the shift
// configuration page `admin/shifts/+page.svelte`.
//
// This is a source-read PIN, not a behaviour test: `apps/web/vitest.config.ts` has no `$app`
// alias, so a route page cannot be mounted (see `nav-guard.test.ts` for the established
// precedent of reading route source with `readFileSync` instead).
//
// Issue #854 (plan 09): the page is a shell now. The three editors moved into the components
// `ShiftTemplatesPanel`, `CoverageRulesPanel` and `WeekPatternsPanel` (`lib/components/admin/
// dienstplan/`); the pins follow them. The pattern matrix keeps its own baseline (now `baseline`
// in the panel) and the page keeps the ONE unsaved-changes registration of the route.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

// fileURLToPath decodes the %28/%29 that the "(app)" route group produces in import.meta.url.
function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readRouteFile(
  "../routes/(app)/admin/shifts/+page.svelte",
  "src/routes/(app)/admin/shifts/+page.svelte",
);
const TEMPLATES = readRouteFile(
  "../lib/components/admin/dienstplan/ShiftTemplatesPanel.svelte",
  "src/lib/components/admin/dienstplan/ShiftTemplatesPanel.svelte",
);
const COVERAGE = readRouteFile(
  "../lib/components/admin/dienstplan/CoverageRulesPanel.svelte",
  "src/lib/components/admin/dienstplan/CoverageRulesPanel.svelte",
);
const PATTERNS = readRouteFile(
  "../lib/components/admin/dienstplan/WeekPatternsPanel.svelte",
  "src/lib/components/admin/dienstplan/WeekPatternsPanel.svelte",
);

function fnBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  }", start);
  expect(end, `unterminated function: ${marker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("[vacuity gate] the four sources are read", () => {
  it("reads the page and the three panels", () => {
    for (const source of [PAGE, TEMPLATES, COVERAGE, PATTERNS]) {
      expect(source.length).toBeGreaterThan(1000);
    }
  });
});

describe("D-01 — the editors save only on a button or a form submit, never on change", () => {
  // The template and the rule editors are Dialog forms: the write runs on submit (button or
  // Enter), never on a field's change, blur or input.
  it.each([
    ["saveTemplate", TEMPLATES],
    ["saveRule", COVERAGE],
  ])("%s runs on the editor form's submit", (name, source) => {
    expect(source).toContain(`void ${name}()`);
    expect(source).toContain("onsubmit={(event) =>");
    expect(source).not.toMatch(new RegExp(`on(?:change|blur|input)=\\{[^}]*${name}`));
  });

  it("saveBulkPatterns is the SaveBar's onSave, never onchange", () => {
    expect(PATTERNS).toContain("onSave={saveBulkPatterns}");
    expect(PATTERNS).not.toMatch(/on(?:change|blur|input)=\{[^}]*saveBulkPatterns/);
  });

  // Modal drafts (Vorlage/Regel) are explicitly NOT part of the page-level save registry —
  // same reasoning 109-12/109-13 apply on admin/vacation's Sonderurlaub modals.
});

describe("the pattern panel carries its own baseline — plan 109-12 reuses it", () => {
  it("declares the baseline as component state, taken from the loaded matrix", () => {
    expect(PATTERNS).toContain("let baseline = $state<PatternMatrix>(");
    expect(PATTERNS).toContain("buildPatternMatrix(employees, patterns)");
  });

  it("the page seeds the panel from the freshly loaded rows", () => {
    // Issue #854 (plan 854-10): the shift lists load in loadShiftData, only for a person with a shift tab.
    const body = fnBody(PAGE, "async function loadShiftData");
    expect(body).toContain("shiftEmployees = shiftBasedEmployees(week.employees ?? [])");
    expect(body).toContain("patterns = tenantPatterns");
    expect(PAGE).toContain("{patterns}");
  });

  it("saveBulkPatterns re-takes the baseline on success", () => {
    expect(fnBody(PATTERNS, "async function saveBulkPatterns")).toContain(
      "baseline = nextBaseline",
    );
  });

  it("the dirty count is derived from the isRowDirty/isCellDirty comparison against the baseline", () => {
    expect(PATTERNS).toContain("const dirtyCount = $derived(");
    expect(PATTERNS).toContain("isRowDirty(employee.id)");
  });

  // T-109-24 (109-06): a reset in the error path would clear the "unsaved" marker after a
  // FAILED save. The baseline moves only for a person whose request was fulfilled.
  it("the re-take is bound to a fulfilled request, never to the finally block", () => {
    const body = fnBody(PATTERNS, "async function saveBulkPatterns");
    const fulfilled = body.indexOf('result.status === "fulfilled"');
    const retake = body.indexOf("nextBaseline[");
    const finallyIdx = body.indexOf("finally");
    expect(fulfilled).toBeGreaterThan(-1);
    expect(retake).toBeGreaterThan(fulfilled);
    expect(finallyIdx).toBeGreaterThan(retake);
    expect(body.slice(finallyIdx)).not.toContain("baseline");
  });
});

describe("the pattern group has a SaveBar — the marker belongs in it", () => {
  it("the Wochenmuster group's SaveBar triggers saveBulkPatterns", () => {
    const titleIdx = PATTERNS.indexOf('id="dienstplan-muster-title"');
    expect(titleIdx).toBeGreaterThan(-1);
    const sectionEnd = PATTERNS.indexOf("</section>", titleIdx);
    expect(sectionEnd).toBeGreaterThan(titleIdx);
    const sectionBody = PATTERNS.slice(titleIdx, sectionEnd);
    expect(sectionBody).toContain("<SaveBar");
    expect(sectionBody).toContain("onSave={saveBulkPatterns}");
  });

  function textOrNumberInputHandlers(source: string): string[] {
    const found: string[] = [];
    for (const tag of source.match(/<input\b[\s\S]*?>/g) ?? []) {
      const type = tag.match(/type="([a-z]+)"/)?.[1];
      if (type !== "number" && type !== "text") continue;
      for (const m of tag.matchAll(/on(?:blur|change|input)=\{(\w+)\}/g)) found.push(m[1]);
    }
    return found;
  }

  it("AK-02: no text/number input of the shift configuration carries an inline write handler", () => {
    for (const source of [PAGE, TEMPLATES, COVERAGE, PATTERNS]) {
      expect(textOrNumberInputHandlers(source)).toEqual([]);
    }
  });
});

describe("D-11/D-12 — unsaved marker and guard registration on admin/shifts", () => {
  it("the page derives its marker from the panel's count, it adds no second mechanism", () => {
    expect(PAGE).toContain("bind:changes={patternChanges}");
    expect(PAGE).not.toContain("function snap(");
  });

  it("the registration is gated on snapshotsReady (WR-01)", () => {
    // Plan 854-10 adds the unsaved count of the Einstellungen sections (one registration for the page).
    expect(PAGE).toContain("bind:changes={settingsChanges}");
    expect(PAGE).toContain(
      'markUnsaved("admin-shifts", snapshotsReady && patternChanges + settingsChanges > 0)',
    );
    expect(PAGE).not.toContain('markUnsaved("admin-shifts", patternChanges');
  });

  it("snapshotsReady is set in loadAll's try, right after the data", () => {
    const body = fnBody(PAGE, "async function loadAll");
    const catchIdx = body.indexOf("} catch");
    // The data of both halves (shift lists and settings) is awaited together before the flag is set.
    const dataIdx = body.indexOf("await Promise.all(");
    const readyIdx = body.indexOf("snapshotsReady = true");
    expect(catchIdx).toBeGreaterThan(-1);
    expect(dataIdx).toBeGreaterThan(-1);
    expect(body).toContain("loadShiftData()");
    expect(body).toContain('"/settings/work"');
    expect(readyIdx).toBeGreaterThan(dataIdx);
    expect(readyIdx).toBeLessThan(catchIdx);
    expect(PAGE).not.toMatch(/finally\s*\{[^}]*snapshotsReady/s);
  });

  it("exactly one SaveBar carries unsaved edits, and it is the pattern group's", () => {
    expect((PATTERNS.match(/<SaveBar\b/g) ?? []).length).toBe(1);
    for (const source of [PAGE, TEMPLATES, COVERAGE]) {
      expect(source).not.toContain("<SaveBar");
    }
    expect(PAGE).not.toContain('class="unsaved-hint"');
  });

  it("modal drafts are not registered", () => {
    expect(PAGE).not.toContain('markUnsaved("admin-shifts", tpl');
    const registrationIdx = PAGE.indexOf('markUnsaved("admin-shifts",');
    const registrationLine = PAGE.slice(registrationIdx, PAGE.indexOf(")", registrationIdx));
    expect(registrationLine).not.toContain("name");
    expect(registrationLine).not.toContain("minStaff");
    for (const source of [TEMPLATES, COVERAGE]) {
      expect(source).not.toContain("markUnsaved");
    }
  });

  it("the effect de-registers on unmount", () => {
    expect(PAGE).toContain('return () => markUnsaved("admin-shifts", false)');
  });
});

// Issue #854 (plan 854-10, T-854-26): the page merges sections of three old pages, so what it shows and loads
// follows the person's permissions; the rule itself is unit-tested in dienstplan-settings-854.test.ts.
describe("Regeln › Dienstplan offers and loads only what the person may open", () => {
  it("takes its tabs from visibleDienstplanTabs and lets the URL hash pick only among them", () => {
    expect(PAGE).toContain("visibleDienstplanTabs(user)");
    expect(PAGE).toContain("tabFromHash($page.url.hash, visibleTabIds)");
    expect(PAGE).toContain("tabs={visibleTabs.map(");
  });

  it("loads the shift lists only for a shift tab and the settings only for Einstellungen", () => {
    const body = fnBody(PAGE, "async function loadAll");
    expect(body).toContain("showShiftData ? loadShiftData()");
    expect(body).toContain("showSettings");
  });

  it("renders the Einstellungen panel inside its tab", () => {
    expect(PAGE).toContain('value === "einstellungen"');
    expect(PAGE).toContain("<DienstplanSettingsPanel");
  });
});
