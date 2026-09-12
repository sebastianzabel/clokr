// Phase 109 (Issue #35), Plan 10, Task 1 — Wave-0 (gap closure) regression net for
// `admin/audit/+page.svelte` (521 lines, zero prior test coverage).
//
// This is a source-read PIN, not a behaviour test: `apps/web/vitest.config.ts` has no
// `$app` alias, so a route page cannot be mounted (see `nav-guard.test.ts` for the
// established `readRouteFile` shape this file follows).
//
// What this pins (T-109-39):
// - D-01: `saveRetention` (the "Aufbewahrung" section) writes only via its section button —
//   the retention period controls the annual deletion (§ 147 AO / § 41 EStG); an
//   accidentally-instant select would write on every scroll-through of a dropdown.
// - The single-field `PUT /settings/work` payload is the contract plan 109-13 must snapshot
//   (`snap(retentionYears)`).
// - `filterAction`/`filterEntity` are read-state (a query filter), never form state — they must
//   never arm the unsaved-navigation guard.
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
  "../routes/(app)/admin/audit/+page.svelte",
  "src/routes/(app)/admin/audit/+page.svelte",
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

describe("D-01 — the retention setting saves only on its section button", () => {
  it("saveRetention is wired via onclick=", () => {
    expect(PAGE).toContain("onclick={saveRetention}");
  });

  it("saveRetention is never wired via onchange=", () => {
    expect(PAGE).not.toContain("onchange={saveRetention}");
  });
});

describe("saveRetention payload census", () => {
  it("writes exactly { dataRetentionYears: retentionYears } and no other api call", () => {
    const body = fnBody("async function saveRetention");
    expect(body).toContain('api.put("/settings/work", { dataRetentionYears: retentionYears })');
    const apiCalls = body.match(/api\.\w+\(/g) ?? [];
    expect(apiCalls).toHaveLength(1);
  });

  // exactly one persisted field — plan 109-13's snapshot is `snap(retentionYears)`.
});

describe("the log filters are not form state", () => {
  it("filterAction never appears in a write body", () => {
    for (const m of PAGE.matchAll(/api\.(put|post|patch)\(/g)) {
      const start = m.index ?? -1;
      const end = PAGE.indexOf("});", start);
      expect(end).toBeGreaterThan(start);
      expect(PAGE.slice(start, end)).not.toContain("filterAction");
    }
  });

  it("filterEntity never appears in a write body", () => {
    for (const m of PAGE.matchAll(/api\.(put|post|patch)\(/g)) {
      const start = m.index ?? -1;
      const end = PAGE.indexOf("});", start);
      expect(end).toBeGreaterThan(start);
      expect(PAGE.slice(start, end)).not.toContain("filterEntity");
    }
  });

  it("applyFilter reloads the log list, it does not persist anything", () => {
    expect(fnBody("async function applyFilter")).toContain("loadLogs()");
  });

  // changing a filter is a read, not an unsaved edit — it must never arm the guard.
});

describe("AK-02", () => {
  it("no text/number input in admin/audit carries an inline write handler", () => {
    expect(textOrNumberInputHandlers(PAGE)).toEqual([]);
  });
});

describe("D-11/D-12 — unsaved marker and guard registration on admin/audit", () => {
  it("retentionDirty is $derived(snap(retentionYears) !== retentionSnapshot)", () => {
    expect(PAGE).toContain(
      "let retentionDirty = $derived(snap(retentionYears) !== retentionSnapshot);",
    );
  });

  it("the log filters are not part of the dirty state", () => {
    const start = PAGE.indexOf("let retentionDirty = $derived(");
    const end = PAGE.indexOf(";", start);
    const slice = PAGE.slice(start, end);
    expect(slice).not.toContain("filterAction");
    expect(slice).not.toContain("filterEntity");

    const markUnsavedLine = PAGE.slice(
      PAGE.indexOf('markUnsaved("admin-audit"'),
      PAGE.indexOf(")", PAGE.indexOf('markUnsaved("admin-audit"')) + 1,
    );
    expect(markUnsavedLine).not.toContain("filterAction");
    expect(markUnsavedLine).not.toContain("filterEntity");
  });

  it("the registration is gated on snapshotsReady (WR-01)", () => {
    expect(PAGE).toContain('markUnsaved("admin-audit", snapshotsReady && retentionDirty)');
    expect(PAGE).not.toContain('markUnsaved("admin-audit", retentionDirty)');
  });

  it("snapshotsReady = true sits inside loadRetention's try, after retentionYears is set, never in finally", () => {
    const body = fnBody("async function loadRetention");
    const hydrationPoint = body.indexOf("retentionYears = cfg.dataRetentionYears");
    const readyPoint = body.indexOf("snapshotsReady = true");
    expect(readyPoint).toBeGreaterThan(hydrationPoint);
    expect(PAGE).not.toMatch(/finally\s*\{[^}]*snapshotsReady/s);
  });

  it("T-109-24 — no retentionSnapshot = snap( assignment is inside a finally block, and the saveRetention reset precedes its catch", () => {
    for (const m of PAGE.matchAll(/retentionSnapshot = snap\(/g)) {
      const idx = m.index ?? -1;
      const before = PAGE.slice(Math.max(0, idx - 120), idx);
      expect(before).not.toMatch(/finally\s*\{/);
    }
    const saveBody = fnBody("async function saveRetention");
    const snapPoint = saveBody.indexOf("retentionSnapshot = snap(");
    const catchPoint = saveBody.indexOf("} catch");
    expect(snapPoint).toBeGreaterThan(-1);
    expect(snapPoint).toBeLessThan(catchPoint);
  });

  it("exactly one dirty={ prop, on the Aufbewahrung section", () => {
    const matches = PAGE.match(/dirty=\{/g) ?? [];
    expect(matches).toHaveLength(1);
    const sectionStart = PAGE.indexOf('<Section\n        title="Aufbewahrung"');
    expect(sectionStart).toBeGreaterThan(-1);
    const sectionEnd = PAGE.indexOf("</Section>", sectionStart);
    const dirtyIdx = PAGE.indexOf("dirty={");
    expect(dirtyIdx).toBeGreaterThan(sectionStart);
    expect(dirtyIdx).toBeLessThan(sectionEnd);
  });

  it("the effect de-registers on unmount", () => {
    expect(PAGE).toContain('return () => markUnsaved("admin-audit", false);');
  });
});
