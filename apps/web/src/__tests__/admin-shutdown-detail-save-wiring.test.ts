// Phase 109 (Issue #35), Plan 10, Task 1 — Wave-0 (gap closure) regression net for
// `admin/shutdowns/[id]/+page.svelte` (528 lines, zero prior test coverage).
//
// This is a source-read PIN, not a behaviour test: `apps/web/vitest.config.ts` has no
// `$app` alias, so a route page cannot be mounted (see `nav-guard.test.ts` for the
// established `readRouteFile` shape this file follows).
//
// What this pins (T-109-41):
// - D-01: `saveShutdown` (the "Betriebsurlaub" section) writes only via its section button,
//   never on a field change — a half-typed date range must never reach the server.
// - The exact five-field `PATCH` payload, keyed to five named `$state` variables, is the
//   contract plan 109-13 must snapshot.
// - `onMount` can return early, twice, BEFORE any of the five fields are hydrated — plan 109-13
//   must arm its `snapshotsReady` gate only after the last field assignment, never earlier.
// - The exceptions `<Modal>` is out of navigation-guard scope (modal dismissal, not page nav).
// - AK-02: no text/number input on this page carries an inline write handler.

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
  "../routes/(app)/admin/shutdowns/[id]/+page.svelte",
  "src/routes/(app)/admin/shutdowns/[id]/+page.svelte",
);

/** Payload-key census extractor — copied from admin-vacation-save-wiring.test.ts (Plan 109-09).
 *  Accepts both `key: value` pairs and ES2015 shorthand object properties, per Plan 109-09's
 *  finding that a colon-only regex silently undercounts real payloads. */
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

/** Brace-depth object-literal slicer — copied from admin-vacation-save-wiring.test.ts. */
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

/** AK-02 census helper — same shape as admin-system-save-wiring.test.ts. */
function textOrNumberInputHandlers(source: string): string[] {
  const found: string[] = [];
  for (const tag of source.match(/<input\b[\s\S]*?>/g) ?? []) {
    const type = tag.match(/type="([a-z]+)"/)?.[1];
    if (type !== "number" && type !== "text") continue;
    for (const m of tag.matchAll(/on(?:blur|change|input)=\{(\w+)\}/g)) found.push(m[1]);
  }
  return found;
}

describe("D-01 — the Betriebsurlaub form saves only on its section button", () => {
  it("saveShutdown is wired via onclick=", () => {
    expect(PAGE).toContain("onclick={saveShutdown}");
  });

  it("saveShutdown is never wired via onchange=", () => {
    expect(PAGE).not.toContain("onchange={saveShutdown}");
  });
});

describe("saveShutdown payload census — the field list plan 109-13 must snapshot", () => {
  it("the PATCH body contains exactly the five contract fields", () => {
    const start = PAGE.indexOf("async function saveShutdown");
    expect(start).toBeGreaterThan(-1);
    // Anchor ends exactly at the object literal's opening brace, so the `${shutdown.id}`
    // template-literal interpolation (which itself contains `{`/`}`) cannot be mistaken for
    // the payload object's boundary.
    const anchor = "api.patch<CompanyShutdown>(`/company-shutdowns/${shutdown.id}`, {";
    const anchorStart = PAGE.indexOf(anchor, start);
    expect(anchorStart, "saveShutdown's api.patch call not found").toBeGreaterThan(-1);
    const objStart = anchorStart + anchor.length - 1;
    const keys = extractObjectKeys(sliceBalancedObject(PAGE, objStart));
    expect(keys.sort()).toEqual(
      ["deductsFromVacation", "endDate", "name", "notes", "startDate"].sort(),
    );
  });

  it("all five $state declarations exist", () => {
    expect(PAGE).toContain('let formName = $state("")');
    expect(PAGE).toContain('let formStart = $state("")');
    expect(PAGE).toContain('let formEnd = $state("")');
    expect(PAGE).toContain("let formDeducts = $state(false)");
    expect(PAGE).toContain('let formNotes = $state("")');
  });
});

describe("onMount can return before the fields are hydrated", () => {
  it("both early returns precede formName's hydration", () => {
    const start = PAGE.indexOf("onMount(async ()");
    expect(start).toBeGreaterThan(-1);
    const hydrationPoint = PAGE.indexOf("formName = found.name", start);
    expect(hydrationPoint).toBeGreaterThan(start);
    const slice = PAGE.slice(start, hydrationPoint);
    const returns = slice.match(/return;/g) ?? [];
    // plan 109-13 must set `snapshotsReady` immediately AFTER the last field assignment,
    // never in `finally` and never before these guards — a not-found shutdown must leave
    // the page unregistered, exactly the WR-01 shape 109-REVIEW-FIX.md already fixed once
    // on admin/system and admin/employees/[id].
    expect(returns.length).toBe(2);
  });
});

describe("the exception modal is out of scope", () => {
  it("the page has a <Modal> for adding exceptions", () => {
    expect(PAGE).toContain("<Modal");
  });

  it("addException is wired via onclick=", () => {
    expect(PAGE).toContain("onclick={addException}");
  });

  // A <Modal> draft is dismissible by ESC and backdrop (Modal.svelte:26,33), which is a
  // modal-dismissal concern, not a navigation one — Section.dirty cannot render for it and
  // beforeNavigate never fires for it.
});

describe("AK-02", () => {
  it("no text/number input in admin/shutdowns/[id] carries an inline write handler", () => {
    expect(textOrNumberInputHandlers(PAGE)).toEqual([]);
  });
});

describe("D-11/D-12 — unsaved marker and guard registration on admin/shutdowns/[id]", () => {
  it("shutdownDirty is $derived(snap(...)) and not hand-set", () => {
    expect(PAGE).toMatch(/let shutdownDirty = \$derived\(\s*snap\(/);
  });

  it("the snap(...) argument block contains all five form* variables", () => {
    const start = PAGE.indexOf("let shutdownDirty = $derived(");
    expect(start).toBeGreaterThan(-1);
    const end = PAGE.indexOf(");", start);
    const slice = PAGE.slice(start, end);
    // PATCH keys (from the 109-10 pin) mapped to their backing $state variables:
    // name<->formName, startDate<->formStart, endDate<->formEnd,
    // deductsFromVacation<->formDeducts, notes<->formNotes.
    for (const v of ["formName", "formStart", "formEnd", "formDeducts", "formNotes"]) {
      expect(slice).toContain(v);
    }
  });

  it("the registration is gated on snapshotsReady (WR-01)", () => {
    expect(PAGE).toContain('markUnsaved("admin-shutdown-detail", snapshotsReady && shutdownDirty)');
    expect(PAGE).not.toContain('markUnsaved("admin-shutdown-detail", shutdownDirty)');
  });

  it("snapshotsReady is set after formNotes hydration, never in a finally", () => {
    const start = PAGE.indexOf("onMount(async ()");
    const hydrationPoint = PAGE.indexOf("formNotes = found.notes", start);
    const catchPoint = PAGE.indexOf("} catch", hydrationPoint);
    const readyPoint = PAGE.indexOf("snapshotsReady = true", hydrationPoint);
    expect(readyPoint).toBeGreaterThan(hydrationPoint);
    expect(readyPoint).toBeLessThan(catchPoint);
    expect(PAGE).not.toMatch(/finally\s*\{[^}]*snapshotsReady/s);
  });

  it("the pre-flight validation returns do not clear the marker", () => {
    const body = PAGE.slice(
      PAGE.indexOf("async function saveShutdown"),
      PAGE.indexOf("async function confirmDelete"),
    );
    const patchPoint = body.indexOf("const updated = await api.patch");
    expect(patchPoint).toBeGreaterThan(-1);
    const snapPoint = body.indexOf("shutdownSnapshot = snap(");
    expect(snapPoint).toBeGreaterThan(patchPoint);
    // exactly one reset in saveShutdown
    expect(body.match(/shutdownSnapshot = snap\(/g)).toHaveLength(1);
  });

  it("T-109-24 — no shutdownSnapshot = snap( assignment is inside a finally block", () => {
    for (const m of PAGE.matchAll(/shutdownSnapshot = snap\(/g)) {
      const idx = m.index ?? -1;
      const before = PAGE.slice(Math.max(0, idx - 120), idx);
      expect(before).not.toMatch(/finally\s*\{/);
    }
  });

  it("exactly one dirty={ prop, on the Betriebsurlaub section", () => {
    const matches = PAGE.match(/dirty=\{/g) ?? [];
    expect(matches).toHaveLength(1);
    const sectionStart = PAGE.indexOf('<Section title="Betriebsurlaub"');
    expect(sectionStart).toBeGreaterThan(-1);
    const sectionEnd = PAGE.indexOf("</Section>", sectionStart);
    const dirtyIdx = PAGE.indexOf("dirty={");
    expect(dirtyIdx).toBeGreaterThan(sectionStart);
    expect(dirtyIdx).toBeLessThan(sectionEnd);
  });

  it("the effect de-registers on unmount", () => {
    expect(PAGE).toContain('return () => markUnsaved("admin-shutdown-detail", false);');
  });
});
