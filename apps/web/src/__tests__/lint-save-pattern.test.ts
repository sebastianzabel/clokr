// Phase 109 (Issue #35), Plan 08, Task 1 — fixture proof for the D-02/AK-02 lint gate
// (`apps/web/scripts/lint-save-pattern.mjs`).
//
// T-109-29 (this plan's own threat model): a gate whose regex silently matches nothing is
// worse than no gate — it reports OK forever and licenses the exact drift it was built to
// stop. Passing on a clean tree is explicitly NOT accepted as evidence here: this file
// asserts the detector returns a violation for three distinct broken shapes and `[]` for
// four legitimate ones, plus one integration case reading the real `admin/system` source.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { findSavePatternViolations } from "../../scripts/lint-save-pattern.mjs";

// fileURLToPath decodes the %28/%29 that the "(app)" route group produces in import.meta.url.
function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

describe("findSavePatternViolations (D-02/AK-02 gate, Phase 109 Plan 08)", () => {
  it("returns [] for a clean admin page (no matching input shapes at all)", () => {
    const clean = `
      <div class="form-group">
        <label class="form-label" for="x">Bezeichnung</label>
        <input id="x" type="text" bind:value={x} class="form-input" />
        <input type="checkbox" checked={enabled} onchange={toggleThing} />
      </div>
    `;
    expect(findSavePatternViolations(clean, "fixture.svelte")).toEqual([]);
  });

  it('returns one entry for <input type="number" onblur={saveThing} />', () => {
    const broken = `<input type="number" min="1" onblur={saveThing} class="form-input" />`;
    const violations = findSavePatternViolations(broken, "fixture.svelte");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: "fixture.svelte", type: "number", rule: "a" });
  });

  it('returns one entry for <input type="text" onchange={saveThing} />', () => {
    const broken = `<input type="text" onchange={saveThing} class="form-input" />`;
    const violations = findSavePatternViolations(broken, "fixture.svelte");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: "fixture.svelte", type: "text", rule: "b" });
  });

  it('returns one entry for <input type="number" onchange={() => api.put("/x", {})} />', () => {
    const broken = `<input type="number" onchange={() => api.put("/x", {})} class="form-input" />`;
    const violations = findSavePatternViolations(broken, "fixture.svelte");
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("b");
    expect(violations[0].handler).toContain("api.put");
  });

  it('returns [] for <input type="number" oninput={(ev) => { local = ev.target.value; }} />', () => {
    const clean = `<input type="number" oninput={(ev) => { local = ev.target.value; }} class="form-input" />`;
    expect(findSavePatternViolations(clean, "fixture.svelte")).toEqual([]);
  });

  it('returns [] for <input type="checkbox" onchange={toggleThing} /> — checkboxes are out of scope', () => {
    const clean = `<input type="checkbox" checked={enabled} onchange={toggleThing} />`;
    expect(findSavePatternViolations(clean, "fixture.svelte")).toEqual([]);
  });

  it('returns [] for <input type="time" onchange={saveDefaultBreakStart} /> — D-03 leaves this instant on purpose', () => {
    const clean = `<input type="time" bind:value={defaultBreakStart} onchange={saveDefaultBreakStart} class="form-input" />`;
    expect(findSavePatternViolations(clean, "fixture.svelte")).toEqual([]);
  });

  it("catches a deliberately broken source (the gate is proven, not assumed)", () => {
    const broken = `<input type="number" min="1" onblur={saveWindowDays} class="form-input" />`;
    expect(findSavePatternViolations(broken, "fixture.svelte")).toHaveLength(1);
  });

  it("returns [] against the real admin/system/+page.svelte source (T-109-29 integration proof)", () => {
    const page = readRouteFile(
      "../routes/(app)/admin/system/+page.svelte",
      "src/routes/(app)/admin/system/+page.svelte",
    );
    expect(findSavePatternViolations(page, "admin/system/+page.svelte")).toEqual([]);
  });

  it("returns [] against the real admin/employees/[id]/+page.svelte source", () => {
    const page = readRouteFile(
      "../routes/(app)/admin/employees/[id]/+page.svelte",
      "src/routes/(app)/admin/employees/[id]/+page.svelte",
    );
    expect(findSavePatternViolations(page, "admin/employees/[id]/+page.svelte")).toEqual([]);
  });
});
