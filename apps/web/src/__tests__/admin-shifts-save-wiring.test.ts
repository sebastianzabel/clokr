// Phase 109 (Issue #35), Plan 09, Task 2 — Wave-0 gap-closure regression net for
// `admin/shifts/+page.svelte` (906 lines, zero prior test coverage).
//
// This is a source-read PIN, not a behaviour test: `apps/web/vitest.config.ts` has no `$app`
// alias, so a route page cannot be mounted (see `nav-guard.test.ts` for the established
// precedent of reading route source with `readFileSync` instead). Unlike admin/vacation and
// admin/phorest, this page already carries its own baseline mechanism for the pattern
// matrix (`patternMatrixInitial`) — plan 109-12 reuses it rather than inventing a snapshot.

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

function fnBody(marker: string): string {
  const start = PAGE.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const end = PAGE.indexOf("\n  }", start);
  expect(end, `unterminated function: ${marker}`).toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

describe("D-01 — the pattern matrix saves only on its section button", () => {
  it.each(["saveBulkPatterns", "saveTemplate", "saveRule"])(
    "%s is onclick-only, never onchange",
    (name) => {
      expect(PAGE).toContain(`onclick={${name}}`);
      expect(PAGE).not.toContain(`onchange={${name}}`);
    },
  );

  // Modal drafts (Vorlage/Regel) are explicitly NOT part of the page-level save registry —
  // same reasoning 109-12/109-13 apply on admin/vacation's Sonderurlaub modals.
});

describe("the page already carries its own baseline — plan 109-12 reuses it", () => {
  it("declares patternMatrixInitial as page state", () => {
    expect(PAGE).toContain("let patternMatrixInitial");
  });

  it("loadAll seeds the baseline from the freshly loaded matrix", () => {
    expect(fnBody("async function loadAll")).toContain(
      "patternMatrixInitial = JSON.parse(JSON.stringify(matrix))",
    );
  });

  it("saveBulkPatterns re-takes the baseline on success", () => {
    expect(fnBody("async function saveBulkPatterns")).toContain(
      "patternMatrixInitial = JSON.parse(JSON.stringify(patternMatrix))",
    );
  });

  it("dirtyEmployeeCount is derived from the isRowDirty/isCellDirty comparison against the baseline", () => {
    expect(PAGE).toContain("const dirtyEmployeeCount = $derived(");
  });

  // T-109-24 (109-06): a reset in the error path would clear the "unsaved" marker after a
  // FAILED save. The re-take must sit strictly inside the `fail === 0` success branch.
  it("the re-take is on the success path, never in finally", () => {
    const body = fnBody("async function saveBulkPatterns");
    const ifStart = body.indexOf("if (fail === 0)");
    const elseStart = body.indexOf("} else if (ok === 0)");
    expect(ifStart).toBeGreaterThan(-1);
    expect(elseStart).toBeGreaterThan(ifStart);
    const successBranch = body.slice(ifStart, elseStart);
    expect(successBranch).toContain(
      "patternMatrixInitial = JSON.parse(JSON.stringify(patternMatrix))",
    );
  });
});

describe("the pattern Section has a footer — the marker belongs in it", () => {
  it("the Schicht-Muster Section's footer triggers saveBulkPatterns", () => {
    const titleIdx = PAGE.indexOf('title="Schicht-Muster (Wochenrhythmus)"');
    expect(titleIdx).toBeGreaterThan(-1);
    const sectionEnd = PAGE.indexOf("</Section>", titleIdx);
    expect(sectionEnd).toBeGreaterThan(titleIdx);
    const sectionBody = PAGE.slice(titleIdx, sectionEnd);
    expect(sectionBody).toContain("{#snippet footer()}");
    expect(sectionBody).toContain("onclick={saveBulkPatterns}");
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

  it("AK-02: no text/number input on admin/shifts carries an inline write handler", () => {
    expect(textOrNumberInputHandlers(PAGE)).toEqual([]);
  });
});

describe("D-11/D-12 — unsaved marker and guard registration on admin/shifts", () => {
  it("patternsDirty reuses the existing baseline, it does not add a second mechanism", () => {
    expect(PAGE).toContain("const patternsDirty = $derived(dirtyEmployeeCount > 0)");
    expect(PAGE).not.toContain("function snap(");
  });

  it("the registration is gated on snapshotsReady (WR-01)", () => {
    expect(PAGE).toContain('markUnsaved("admin-shifts", snapshotsReady && patternsDirty)');
    expect(PAGE).not.toContain('markUnsaved("admin-shifts", patternsDirty)');
  });

  it("snapshotsReady is set in loadAll's try, right after the baseline", () => {
    const body = fnBody("async function loadAll");
    const catchIdx = body.indexOf("} catch");
    const baselineIdx = body.indexOf("patternMatrixInitial = JSON.parse(");
    const readyIdx = body.indexOf("snapshotsReady = true");
    expect(catchIdx).toBeGreaterThan(-1);
    expect(baselineIdx).toBeGreaterThan(-1);
    expect(readyIdx).toBeGreaterThan(baselineIdx);
    expect(readyIdx).toBeLessThan(catchIdx);
    expect(PAGE).not.toMatch(/finally\s*\{[^}]*snapshotsReady/s);
  });

  it("exactly one Section carries a dirty prop, and it is the pattern Section", () => {
    expect((PAGE.match(/dirty=\{patternsDirty\}/g) ?? []).length).toBe(1);
    const titleIdx = PAGE.indexOf('title="Schicht-Muster (Wochenrhythmus)"');
    const sectionEnd = PAGE.indexOf("</Section>", titleIdx);
    const dirtyIdx = PAGE.indexOf("dirty={patternsDirty}");
    expect(titleIdx).toBeGreaterThan(-1);
    expect(dirtyIdx).toBeGreaterThan(-1);
    expect(dirtyIdx).toBeLessThan(sectionEnd);
    expect(PAGE).not.toContain('class="unsaved-hint"');
  });

  it("the baseline re-take stays on the fully-successful path", () => {
    const body = fnBody("async function saveBulkPatterns");
    const ifStart = body.indexOf("if (fail === 0)");
    const elseStart = body.indexOf("} else if (ok === 0)");
    expect(ifStart).toBeGreaterThan(-1);
    expect(elseStart).toBeGreaterThan(ifStart);
    const successBranch = body.slice(ifStart, elseStart);
    expect(successBranch).toContain(
      "patternMatrixInitial = JSON.parse(JSON.stringify(patternMatrix))",
    );
  });

  it("modal drafts are not registered", () => {
    expect(PAGE).not.toContain('markUnsaved("admin-shifts", tpl');
    const registrationIdx = PAGE.indexOf('markUnsaved("admin-shifts",');
    const registrationLine = PAGE.slice(registrationIdx, PAGE.indexOf(")", registrationIdx));
    expect(registrationLine).not.toContain("tplName");
    expect(registrationLine).not.toContain("ruleMinStaff");
  });

  it("the effect de-registers on unmount", () => {
    expect(PAGE).toContain('return () => markUnsaved("admin-shifts", false)');
  });
});
