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

// WR-04 — shapes the detector used to miss. This file's stated purpose (T-109-29) is proving the
// gate catches broken shapes; these are the ones it did not. The first is not hypothetical:
// seven text inputs inside the linted scope carry no literal `type=` (admin/vacation's
// sl-cr-name / sl-cr-reason / sl-ed-name / sl-ed-reason and admin/export's advisorNumber /
// clientNumber / taxOffice). They are text inputs by HTML default, so adding an onblur save to
// any of them used to reintroduce the defect class while the gate still printed OK.
describe("findSavePatternViolations — WR-04 false-negative classes", () => {
  it("flags an <input> with NO type= attribute (text is the HTML default)", () => {
    const broken = `<input class="form-input" bind:value={advisorNumber} onblur={saveAdvisorNumber} />`;
    const v = findSavePatternViolations(broken, "fixture.svelte");
    expect(v).toHaveLength(1);
    expect(v[0].type).toBe("text");
    expect(v[0].rule).toBe("a");
  });

  it("flags a single-quoted type attribute", () => {
    const broken = `<input type='number' bind:value={x} onblur={saveX} />`;
    expect(findSavePatternViolations(broken, "fixture.svelte")).toHaveLength(1);
  });

  // A literal `>` inside an attribute value used to terminate the tag early, hiding every
  // attribute after it. admin/system carries exactly that shape:
  // sub="Pflicht-Pausen nach § 4 ArbZG (>6h: 30 Min., >9h: 45 Min.)".
  it("flags a write handler that sits AFTER a raw > inside an attribute value", () => {
    const broken = `<input type="number" aria-label="Pause >6h" onblur={saveBreakOver6h} />`;
    const v = findSavePatternViolations(broken, "fixture.svelte");
    expect(v).toHaveLength(1);
    expect(v[0].handler).toContain("saveBreakOver6h");
  });

  it("flags handleSave*-style names (WRITEISH has no leading word boundary on save)", () => {
    const broken = `<input type="text" onchange={handleSaveField} />`;
    expect(findSavePatternViolations(broken, "fixture.svelte")).toHaveLength(1);
  });

  it("flags persist*/commit* handler vocabulary", () => {
    expect(
      findSavePatternViolations(`<input type="text" oninput={() => persistNow()} />`, "f.svelte"),
    ).toHaveLength(1);
    expect(
      findSavePatternViolations(`<input type="text" onchange={() => commitDraft()} />`, "f.svelte"),
    ).toHaveLength(1);
  });

  // Widening the type filter must not turn every non-text control into a violation.
  it.each(["radio", "file", "color", "range", "month", "week", "hidden", "submit", "button"])(
    'still ignores type="%s" — excluded by construction',
    (type) => {
      const src = `<input type="${type}" onchange={saveThing} />`;
      expect(findSavePatternViolations(src, "fixture.svelte")).toEqual([]);
    },
  );

  it("still ignores a local-only inline arrow on a type-less input (rule (b) is filtered)", () => {
    const clean = `<input class="form-input" oninput={() => (touched = true)} />`;
    expect(findSavePatternViolations(clean, "fixture.svelte")).toEqual([]);
  });

  it("scans every input in a multi-tag source, not just up to the first stray >", () => {
    const src =
      `<input type="number" aria-label="ArbZG (>6h)" bind:value={a} />\n` +
      `<input class="form-input" bind:value={b} onblur={saveB} />`;
    expect(findSavePatternViolations(src, "fixture.svelte")).toHaveLength(1);
  });
});
