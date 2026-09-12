// Issue #94, human-verify follow-up — AC-FE-04 requires a disabled `.form-input` (e.g.
// `#e-fixed-workdays` under `FIXED_SCHEDULE`) to read "visibly disabled / noticeably quieter"
// than an editable sibling. It measured as visually IDENTICAL in a running browser: same
// `color`, same `background-color`, only `cursor: not-allowed` differed (invisible until hover).
//
// Root cause: `apps/web/src/app.css` already defines the shared `.form-input:disabled` recipe
// (`--bg-subtle` / `--text-muted` / `not-allowed`), but this route file has its own SCOPED
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
// Before the fix, this test fails: no `.form-input:disabled` (or grouped `.input:disabled,
// .select:disabled, .form-input:disabled`) rule exists anywhere in this file's scoped `<style>`
// block, so REGEX below finds nothing and DISABLED_BLOCK is null.

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
  "../routes/(app)/admin/employees/[id]/+page.svelte",
  "src/routes/(app)/admin/employees/[id]/+page.svelte",
);

// Isolate the scoped `<style>` block so we never accidentally match something in markup/script.
const STYLE_MATCH = PAGE.match(/<style>([\s\S]*)<\/style>/);
expect(STYLE_MATCH, "no <style> block found in +page.svelte").not.toBeNull();
const STYLE = STYLE_MATCH![1];

// The base (non-disabled) rule this file defines for .input/.select/.form-input. This MUST
// keep using --bg-card / --text — those are the "editable" look the disabled state must differ
// from. If a future edit changes these, the test below re-derives its expectations from the
// actual tokens found here instead of hardcoding them, so it still pins the *distinction*.
const BASE_BLOCK_MATCH = STYLE.match(/\.input,\s*\n\s*\.select,\s*\n\s*\.form-input\s*\{([^}]*)\}/);

// The disabled override this fix adds. Written to tolerate minor formatting drift (selector
// grouping order, whitespace) while still requiring all three selectors and both declarations.
const DISABLED_BLOCK_MATCH = STYLE.match(
  /\.input:disabled,\s*\n\s*\.select:disabled,\s*\n\s*\.form-input:disabled\s*\{([^}]*)\}/,
);

describe("admin employee detail — disabled .form-input visibility (issue #94)", () => {
  it("defines a base (editable) .input/.select/.form-input rule using --bg-card and --text", () => {
    expect(
      BASE_BLOCK_MATCH,
      "base .form-input rule not found — page structure changed",
    ).not.toBeNull();
    const base = BASE_BLOCK_MATCH![1];
    expect(base).toMatch(/background:\s*var\(--bg-card\)/);
    expect(base).toMatch(/color:\s*var\(--text\)/);
  });

  it("defines a scoped :disabled override for .input/.select/.form-input (the actual fix)", () => {
    expect(
      DISABLED_BLOCK_MATCH,
      "no .form-input:disabled rule in this file's scoped <style> — the component's own " +
        "background/color declarations on the base rule will keep winning the specificity tie " +
        "against app.css's shared .form-input:disabled recipe, and a disabled field will be " +
        "visually indistinguishable from an editable one (issue #94 regression)",
    ).not.toBeNull();
  });

  it("the :disabled override reuses the SAME shared tokens app.css's recipe uses — no new class or token", () => {
    const disabled = DISABLED_BLOCK_MATCH![1];
    expect(disabled).toMatch(/background:\s*var\(--bg-subtle\)/);
    expect(disabled).toMatch(/color:\s*var\(--text-muted\)/);
    expect(disabled).toMatch(/cursor:\s*not-allowed/);
  });

  it("the disabled treatment resolves to DIFFERENT tokens than the editable base rule", () => {
    // --bg-subtle !== --bg-card and --text-muted !== --text are true by construction in every
    // theme/skin/mode combination defined in tokens.css (checked: pflaume/nacht/wald light+dark,
    // editorial+modern skins) — they are always distinct token DECLARATIONS, never aliases of
    // each other. Pinning that the disabled rule references the "-subtle"/"-muted" siblings
    // rather than re-declaring --bg-card/--text is what actually fixes AC-FE-04: it guarantees
    // a real value delta in every theme, not just the one theme this bug was measured in.
    const base = BASE_BLOCK_MATCH![1];
    const disabled = DISABLED_BLOCK_MATCH![1];

    const baseBg = base.match(/background:\s*var\((--[\w-]+)\)/)?.[1];
    const disabledBg = disabled.match(/background:\s*var\((--[\w-]+)\)/)?.[1];
    const baseColor = base.match(/color:\s*var\((--[\w-]+)\)/)?.[1];
    const disabledColor = disabled.match(/color:\s*var\((--[\w-]+)\)/)?.[1];

    expect(baseBg).toBe("--bg-card");
    expect(disabledBg).toBe("--bg-subtle");
    expect(baseColor).toBe("--text");
    expect(disabledColor).toBe("--text-muted");

    expect(disabledBg).not.toBe(baseBg);
    expect(disabledColor).not.toBe(baseColor);
  });
});
