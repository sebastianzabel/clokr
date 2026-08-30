// Phase 109 (Issue #35), Plan 10, Task 2 — Wave-0 (gap closure) regression net for
// `admin/availability/[employeeId]/+page.svelte` (313 lines, zero prior test coverage).
//
// This is a source-read PIN, not a behaviour test: `apps/web/vitest.config.ts` has no
// `$app` alias, so a route page cannot be mounted (see `nav-guard.test.ts` for the
// established `readRouteFile` shape this file follows).
//
// What this pins (T-109-40, WR-01):
// - The page independently invented its own snapshot mechanism (`lastSnapshot`/
//   `currentSnapshot`/`dirty`) before Phase 109 existed — plan 109-14 must reuse it, not
//   build a second one.
// - `lastSnapshot` is assigned in exactly one place: the last statement of `applyEntries()`.
// - WR-01 (109-REVIEW-FIX.md), reproduced HERE independently of the unsaved registry: `onMount`
//   can return early — before the employee load even resolves — before `applyEntries` ever
//   runs. `lastSnapshot` then stays `""` while `currentSnapshot` is `{"r":[],"o":[]}`, so
//   `dirty` is `true` and the Speichern button on a page showing nothing but an error is
//   ENABLED. This describe block documents the IST-Zustand; plan 109-14 must flip the two
//   `not.toContain` assertions to their positive counterparts.
// - `save()` re-takes the baseline only on its success path, never in a `finally`.
// - AK-02: no text/number input on this page carries an inline write handler (this page has no
//   inline `<input>` at all — the grid/list are separate child components).

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
  "../routes/(app)/admin/availability/[employeeId]/+page.svelte",
  "src/routes/(app)/admin/availability/[employeeId]/+page.svelte",
);

/** Brace/paren-depth fnBody() slicer — copied from admin-system-save-wiring.test.ts (Plan
 *  109-01's correction), robust against functions whose own parameter types contain braces. */
function fnBody(marker: string): string {
  const start = PAGE.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);

  let i = start;
  let parenDepth = 0;
  let bodyStart = -1;
  while (i < PAGE.length) {
    const ch = PAGE[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (ch === "{" && parenDepth === 0) {
      bodyStart = i;
      break;
    }
    i++;
  }
  expect(bodyStart, `function body opening brace not found for: ${marker}`).toBeGreaterThan(-1);

  let depth = 0;
  let j = bodyStart;
  for (; j < PAGE.length; j++) {
    if (PAGE[j] === "{") depth++;
    else if (PAGE[j] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  expect(j, `unterminated function: ${marker}`).toBeLessThan(PAGE.length);
  return PAGE.slice(bodyStart, j + 1);
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

describe("the page already carries the snapshot idiom — plan 109-14 reuses it", () => {
  it("declares lastSnapshot as an empty-string $state", () => {
    expect(PAGE).toContain('let lastSnapshot = $state("")');
  });

  it("derives currentSnapshot from a JSON.stringify of both entry arrays", () => {
    expect(PAGE).toMatch(
      /const currentSnapshot = \$derived\(\s*JSON\.stringify\(\{ r: recurringEntries, o: oneOffEntries \}\)/,
    );
  });

  it("derives dirty from loading/featureDisabled and the snapshot comparison", () => {
    expect(PAGE).toMatch(
      /const dirty = \$derived\(\s*!loading && !featureDisabled && currentSnapshot !== lastSnapshot/,
    );
  });

  // this page independently invented the Phase-109 snapshot comparison. Plan 109-14 does NOT
  // introduce a second mechanism — it gates this one and registers it.
});

describe("lastSnapshot is assigned in exactly one place", () => {
  it("has exactly one reassignment, excluding its own $state declaration", () => {
    // The plan's literal /lastSnapshot = /g also matches the `let lastSnapshot = $state("")`
    // declaration line — a negative lookbehind for "let " excludes the declaration and counts
    // only the real reassignment.
    const assignments = PAGE.match(/(?<!let )lastSnapshot = /g) ?? [];
    expect(assignments).toHaveLength(1);
  });

  it("the single assignment site is the last statement of applyEntries()", () => {
    expect(fnBody("function applyEntries")).toContain("lastSnapshot = JSON.stringify(");
  });

  // the single assignment site is what makes the missing ready-gate provable — every code path
  // that does not reach applyEntries leaves the baseline at "".
});

describe("WR-01 — the baseline is reachable only on the happy path (today)", () => {
  // These assertions describe the IST-Zustand; plan 109-14 reverses them.
  const mountStart = PAGE.indexOf("onMount(() => {");
  const scriptEnd = PAGE.indexOf("</script>");
  const MOUNT = PAGE.slice(mountStart, scriptEnd);

  it("onMount contains a loadError assignment", () => {
    expect(mountStart).toBeGreaterThan(-1);
    expect(MOUNT).toContain("loadError =");
  });

  it("the loadError assignment precedes the applyEntries call", () => {
    expect(MOUNT.indexOf("loadError =")).toBeLessThan(MOUNT.indexOf("applyEntries("));
  });

  it("onMount has an early return before hydration", () => {
    expect(MOUNT).toContain("return;");
  });

  it("snapshotsReady does not exist yet (today's gap)", () => {
    expect(PAGE).not.toContain("snapshotsReady");
  });

  it("markUnsaved is not registered yet (today's gap)", () => {
    expect(PAGE).not.toContain("markUnsaved");
  });

  // With the employee request rejected, applyEntries never runs, lastSnapshot stays "" while
  // currentSnapshot is {"r":[],"o":[]}, so dirty is true and the Speichern button on a page
  // showing nothing but an error is ENABLED. This is WR-01 (109-REVIEW-FIX.md) reproduced
  // independently of the unsaved registry. Plan 109-14 replaces the two `not.toContain`
  // assertions above with their positive counterparts — a strengthening, never a relaxation.
});

describe("save() re-takes the baseline on the success path only", () => {
  it("save() calls applyEntries with the response entries", () => {
    expect(fnBody("async function save")).toContain("applyEntries(res.entries ?? [])");
  });

  it("the applyEntries call sits inside the try, before the catch", () => {
    const body = fnBody("async function save");
    const applyIdx = body.indexOf("applyEntries(res.entries ?? [])");
    const catchIdx = body.indexOf("} catch (err)");
    expect(applyIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeLessThan(catchIdx);
  });
});

describe("AK-02", () => {
  it("no text/number input in admin/availability/[employeeId] carries an inline write handler", () => {
    expect(textOrNumberInputHandlers(PAGE)).toEqual([]);
  });
});
