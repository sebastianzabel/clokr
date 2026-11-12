// Issue #94, human-verify follow-up — AC-FE-04 requires a disabled `.form-input` (e.g.
// `#e-fixed-workdays` under `FIXED_SCHEDULE`) to read "visibly disabled / noticeably quieter"
// than an editable sibling. It measured as visually IDENTICAL in a running browser: same
// `color`, same `background-color`, only `cursor: not-allowed` differed (invisible until hover).
//
// Root cause: `apps/web/src/app.css` already defines the shared `.form-input:disabled` recipe
// (`--sunk` / `--text-2` / `not-allowed`), but this route file has its own SCOPED
// `.input, .select, .form-input { ... }` rule that unconditionally sets `background`/`color`.
// Svelte's compiled scoped selector (`.form-input.svelte-xxxxx`) ties the CSS specificity of
// app.css's `.form-input:disabled` (both are exactly one class + one pseudo-class / one class),
// and the component's own stylesheet wins that tie for every declaration it also makes — so
// `background`/`color` from the base (non-disabled) rule leak into the disabled state, and only
// `cursor` (which the scoped rule never sets) survives from the shared recipe.
//
// This is a source-read PIN, not a rendered-DOM assertion: `apps/web/vitest.config.ts` has no
// `$app` alias, so this route page cannot be mounted (see `layout-boundaries.test.ts` and
// `admin-system-save-wiring.test.ts` for the established precedent of reading route source with
// `readFileSync` instead). A jsdom mount, even if it were possible, would not meaningfully
// resolve the real cross-stylesheet cascade tie either — jsdom has no layout engine and does not
// reliably arbitrate specificity ties across separately-injected `<style>` sources the way a
// real browser's paint pipeline does. The actual visual fix (disabled field reads visibly
// quieter, in both a light and a dark theme) was verified live in a running browser by the
// orchestrator, not by this test. What this test pins is the source-level cause and fix: the
// component's scoped stylesheet must carry its OWN `:disabled` override using the same shared
// tokens app.css uses, so it no longer matters who wins the specificity tie on the base rule.
//
// Issue #854 (plan 854-22): the page is a shell now and the tabs are components with their own
// scoped CSS. A page-scoped `.form-input` rule never reached a child component's inputs anyway,
// and no component of the person detail restyles `.form-input` any more, so the shared recipe of
// app.css decides the disabled look everywhere. This test pins exactly that: no scoped
// `.form-input` / `.input` / `.select` rule on the page or in a detail component (the leak that
// made issue #94), and the shared recipe still resolves disabled and editable to different tokens.

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
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
  "../routes/(app)/admin/employees/[id]/+page.svelte",
  "src/routes/(app)/admin/employees/[id]/+page.svelte",
);
const APP_CSS = readRouteFile("../app.css", "src/app.css");

// The tests run with the cwd `apps/web` (`pnpm --filter @clokr/web test`).
const DETAIL_DIR = resolve(process.cwd(), "src/lib/components/employees/detail");
const DETAIL_COMPONENTS = readdirSync(DETAIL_DIR)
  .filter((name) => name.endsWith(".svelte"))
  .map((name) => ({ name, text: readFileSync(join(DETAIL_DIR, name), "utf8") }));

/** The text of every `<style>` block of a Svelte source. */
function styleOf(source: string): string {
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
}

/** A scoped rule that restyles the shared input classes (the leak of issue #94). */
const INPUT_RULE = /(^|[\s,}])\.(?:form-input|input|select)\b[^{]*\{/m;

describe("admin employee detail — disabled .form-input visibility (issue #94)", () => {
  it("[vacuity gate] the page and the detail components are loaded", () => {
    expect(PAGE).toContain("<style>");
    expect(DETAIL_COMPONENTS.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "PersonTab.svelte",
        "VertragTab.svelte",
        "VertragOverrides.svelte",
        "BerufsschuleSection.svelte",
        "UrlaubTab.svelte",
        "ZugangTab.svelte",
      ]),
    );
    // the detail components do use the shared input class, so the check below is not vacuous
    const users = DETAIL_COMPONENTS.filter((c) => c.text.includes('class="form-input'));
    expect(users.length).toBeGreaterThanOrEqual(3);
  });

  it("the page's scoped styles carry no .form-input / .input / .select rule", () => {
    expect(styleOf(PAGE)).not.toMatch(INPUT_RULE);
  });

  it("no detail component restyles .form-input / .input / .select in its scoped CSS", () => {
    for (const component of DETAIL_COMPONENTS) {
      expect(styleOf(component.text), component.name).not.toMatch(INPUT_RULE);
    }
  });

  it("control: the detector flags a scoped base rule that would leak into the disabled state", () => {
    expect(".form-input { background: var(--card); }").toMatch(INPUT_RULE);
    expect(".a, .select:focus { color: red; }").toMatch(INPUT_RULE);
    expect(".vo-number { max-width: 12rem; }").not.toMatch(INPUT_RULE);
  });

  it("the shared recipe resolves disabled and editable to DIFFERENT tokens", () => {
    // #842 D-842-11: --sunk !== --card and --text-2 !== --text hold by construction in every theme
    // and mode of tokens.css; pinning that the disabled rule references --sunk and --text-2 is what
    // guarantees a real value delta in every theme (AC-FE-04).
    const base = APP_CSS.match(/\n\.form-input\s*\{([^}]*)\}/)?.[1] ?? "";
    const disabled = APP_CSS.match(/\n\.form-input:disabled\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(base, "base .form-input recipe not found in app.css").not.toBe("");
    expect(disabled, ".form-input:disabled recipe not found in app.css").not.toBe("");

    const baseBg = base.match(/background-color:\s*var\((--[\w-]+)\)/)?.[1];
    const disabledBg = disabled.match(/background-color:\s*var\((--[\w-]+)\)/)?.[1];
    const baseColor = base.match(/(?:^|[\s;])color:\s*var\((--[\w-]+)\)/)?.[1];
    const disabledColor = disabled.match(/(?:^|[\s;])color:\s*var\((--[\w-]+)\)/)?.[1];

    expect(baseBg).toBe("--card");
    expect(disabledBg).toBe("--sunk");
    expect(baseColor).toBe("--text");
    expect(disabledColor).toBe("--text-2");
    expect(disabled).toMatch(/cursor:\s*not-allowed/);
  });
});
