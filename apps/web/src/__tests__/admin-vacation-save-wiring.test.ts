// Phase 109 (Issue #35), Plan 09, Task 1 — Wave-0 gap-closure regression net for
// `admin/vacation/+page.svelte` (1632 lines, zero prior test coverage).
//
// This is a source-read PIN, not a behaviour test: `apps/web/vitest.config.ts` has no `$app`
// alias, so a route page cannot be mounted (see `nav-guard.test.ts` for the established
// precedent of reading route source with `readFileSync` instead). The `saveGlobal` payload
// key census below is the CONTRACT that plan 109-11 must snapshot field-for-field: an
// incomplete snapshot tuple would produce neither a marker nor a guard, and would fail
// silently because nothing else knows the field set — this file is that knowledge.

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
  "../routes/(app)/admin/vacation/+page.svelte",
  "src/routes/(app)/admin/vacation/+page.svelte",
);

function fnBody(marker: string): string {
  const start = PAGE.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const end = PAGE.indexOf("\n  }", start);
  expect(end, `unterminated function: ${marker}`).toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

// Extracts the top-level object-literal keys of the `api.put("/settings/work", { ... })` call
// body inside `saveGlobal`. Object literals on this page mix `key: value` pairs with ES2015
// shorthand properties (`christmasEveRule,` — same-named local variable, no colon) — the
// extractor must accept both forms or it silently undercounts by exactly the shorthand keys.
function extractObjectKeys(objectLiteralBody: string): string[] {
  const keys: string[] = [];
  for (const rawLine of objectLiteralBody.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("//")) continue;
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9]*)[:,]/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

function sliceBalancedObject(source: string, openBraceIndex: number): string {
  let depth = 0;
  let i = openBraceIndex;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(openBraceIndex + 1, i);
}

describe("D-01 — the global settings form saves only on its button", () => {
  it.each(["saveGlobal", "saveSLCreate", "saveSLEdit"])(
    "%s is onclick-only, never onchange",
    (name) => {
      expect(PAGE).toContain(`onclick={${name}}`);
      expect(PAGE).not.toContain(`onchange={${name}}`);
    },
  );
});

describe("saveGlobal payload census — the field list plan 109-11 must snapshot", () => {
  // Measured against apps/web/src/routes/(app)/admin/vacation/+page.svelte on 2026-08-30.
  // Every key below is backed by a `$state` variable that plan 109-11's `globalSnapshot` must
  // include — with one deliberate exception: `defaultWeeklyHours` is `$derived` from
  // `gMon..gSun` (see the `defaultWeeklyHours` guard below) and therefore needs no snapshot
  // entry of its own.
  const WORK_KEYS = [
    "allowOvertimePayout",
    "applyToExisting",
    "arbzgEnabled",
    "autoCalcPartTimeVacation",
    "autoDeleteOpenHours",
    "carryOverDeadlineDay",
    "carryOverDeadlineMonth",
    "carryOverRequiresReason",
    "carryoverWarningEnabled",
    "carryoverWarningThresholds",
    "christmasEveRule",
    "clockOutReminderHours",
    "defaultFridayHours",
    "defaultMondayHours",
    "defaultSaturdayHours",
    "defaultSundayHours",
    "defaultThursdayHours",
    "defaultTuesdayHours",
    "defaultVacationDays",
    "defaultWednesdayHours",
    "defaultWeeklyHours",
    "enforceMinVacation",
    "fullTimeWorkDaysPerWeek",
    "halfDayAllowed",
    "holidayRulesValidFromYear",
    "missingEntriesDays",
    "newYearsEveRule",
    "overtimeThreshold",
    "reminderPendingLeaveEnabled",
    "reminderPendingLeaveHours",
    "reminderUpcomingAbsenceDays",
    "reminderUpcomingAbsenceEnabled",
    "sickNoteRequiredAfterDays",
    "sickSelfReport",
    "vacationLeadTimeDays",
    "vacationMaxAdvanceMonths",
    "vacationReminderStartMonth",
  ] as const;

  it("PUT /settings/work carries exactly the 37 known keys, no more, no fewer", () => {
    const saveGlobalBody = fnBody("async function saveGlobal");
    const bodyStart = saveGlobalBody.indexOf('api.put("/settings/work", {');
    expect(bodyStart, 'api.put("/settings/work", {...}) call not found').toBeGreaterThan(-1);
    const objStart = saveGlobalBody.indexOf("{", bodyStart);
    const keys = extractObjectKeys(sliceBalancedObject(saveGlobalBody, objStart)).sort();
    expect(keys).toEqual([...WORK_KEYS].sort());
  });

  it("PUT /settings/security carries exactly one key, maxNegativeBalanceMinutes", () => {
    const saveGlobalBody = fnBody("async function saveGlobal");
    const bodyStart = saveGlobalBody.indexOf('api.put("/settings/security", {');
    expect(bodyStart, 'api.put("/settings/security", {...}) call not found').toBeGreaterThan(-1);
    const objStart = saveGlobalBody.indexOf("{", bodyStart);
    const keys = extractObjectKeys(sliceBalancedObject(saveGlobalBody, objStart));
    expect(keys).toEqual(["maxNegativeBalanceMinutes"]);
  });

  it("defaultWeeklyHours is sent from the $derived gWeekly, not its own $state", () => {
    expect(PAGE).toContain(
      "let gWeekly = $derived(gMon + gTue + gWed + gThu + gFri + gSat + gSun);",
    );
    expect(fnBody("async function saveGlobal")).toContain("defaultWeeklyHours: gWeekly,");
  });
});

describe("D-11 — this page has no Section footer to carry the marker", () => {
  it("SectionStack contains exactly one footer snippet (the Sonderurlaub '+ Neue Regel' button)", () => {
    const stackStart = PAGE.indexOf("<SectionStack");
    const stackEnd = PAGE.indexOf("</SectionStack>", stackStart);
    expect(stackStart).toBeGreaterThan(-1);
    expect(stackEnd).toBeGreaterThan(stackStart);
    const stackBody = PAGE.slice(stackStart, stackEnd);
    const footerCount = (stackBody.match(/\{#snippet footer\(\)\}/g) ?? []).length;
    expect(footerCount).toBe(1);
  });

  it("global save uses a dedicated sticky save bar, not a Section footer", () => {
    expect(PAGE).toContain('class="vac-save-bar"');
    expect(PAGE).toContain('<span class="saved-hint">');
  });

  // Section.svelte only renders its `dirty` hint inside `{#if footer}` — on this page a
  // `dirty=` prop on any given `<Section>` would therefore be invisible to the user, because
  // the section that holds the global settings has no footer at all. Plan 109-11 must render
  // the global unsaved hint directly in `.vac-save-bar`, the same way `admin/system` does for
  // "Standard-Arbeitstage".
  it("the two Modal footers belong to the Sonderurlaub create/edit dialogs, not SectionStack", () => {
    const stackStart = PAGE.indexOf("<SectionStack");
    const stackEnd = PAGE.indexOf("</SectionStack>", stackStart);
    const afterStack = PAGE.slice(stackEnd);
    const modalFooterCount = (afterStack.match(/\{#snippet footer\(\)\}/g) ?? []).length;
    expect(modalFooterCount).toBe(2);
  });
});

describe("AK-02 — no text/number input writes inline on this page", () => {
  function textOrNumberInputHandlers(source: string): string[] {
    const found: string[] = [];
    for (const tag of source.match(/<input\b[\s\S]*?>/g) ?? []) {
      const type = tag.match(/type="([a-z]+)"/)?.[1];
      if (type !== "number" && type !== "text") continue;
      for (const m of tag.matchAll(/on(?:blur|change|input)=\{(\w+)\}/g)) found.push(m[1]);
    }
    return found;
  }

  it("no text/number input on admin/vacation carries an inline write handler", () => {
    expect(textOrNumberInputHandlers(PAGE)).toEqual([]);
  });
});
