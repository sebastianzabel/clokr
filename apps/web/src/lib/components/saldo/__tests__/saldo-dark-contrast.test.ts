// Phase 258 (Issue #258), Plan 02, D-05c — dark-mode contrast for SaldoAnzeige's confirmed
// saldo value and error text.
//
// Why a source-read test, not a mount (declared deviation from CONTEXT.md D-07): jsdom does not
// resolve CSS custom properties across a stylesheet. A mounted component's
// `getComputedStyle(el).color` answers with the UNRESOLVED `var(--good-text)` string (or an empty
// string), never the actual colour a browser paints — the mounted suite structurally cannot
// assert a contrast ratio. Docking this there would produce an assertion that passes regardless
// of the token's value, i.e. the exact vacuous test this project's gates exist to catch. This file
// parses `tokens.css` and `SaldoAnzeige.svelte` directly instead, following the idiom already
// established by `apps/web/src/__tests__/layout-boundaries.test.ts` and
// `version-line.test.ts` (source reads, no new runner, no new dependency, same `__tests__`
// directory as the existing 63-test `SaldoAnzeige.test.ts`).
//
// Why `lib/components/saldo/` needs this at all: `pnpm --filter @clokr/web lint:ui-classes` only
// scans `lib/components/ui/` and `lib/components/layout/` (CLAUDE.md § UI Consistency Rules) — it
// does NOT cover this directory, so this test is the only regression net for the token/consumer
// link it checks.
//
// What this test is NOT: this fixes a measured WCAG contrast defect (D-05c). It is explicitly
// NOT a fix for, or a claim about, Befund 2 (the reported empty overtime-account tile, Issue
// #258), which was not reproduced (D-05/D-05b) and remains open.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

function readSrc(relFromHere: string, relFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relFromHere, import.meta.url)), "utf8");
  } catch {
    // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    return readFileSync(resolve(process.cwd(), relFromCwd), "utf8");
  }
}

/**
 * Extracts the declaration body of a selector block, or null if the selector is absent.
 *
 * Rule 1 auto-fix (bug found while running this test RED for the first time): a plain
 * `indexOf(selector + " {")` also matches `[data-mode="dark"] {` as a SUBSTRING of
 * `html[data-mode="dark"] {` (tokens.css:56, the color-scheme block) — that block's body is
 * just `color-scheme: dark;`, so the real token block at tokens.css:183 was never reached.
 * Fixed by requiring the character immediately before the match not be an identifier
 * character (letter/digit/hyphen/underscore), which `html` ends in but the real selector's
 * preceding newline does not; on a false match the search continues past it.
 */
function block(css: string, selector: string): string | null {
  const needle = selector + " {";
  let from = 0;
  for (;;) {
    const start = css.indexOf(needle, from);
    if (start === -1) return null;
    const prev = start > 0 ? css[start - 1] : "";
    if (!/[A-Za-z0-9_-]/.test(prev)) {
      const open = css.indexOf("{", start);
      const close = css.indexOf("}", open);
      return close === -1 ? null : css.slice(open + 1, close);
    }
    from = start + 1;
  }
}

function hexVar(cssBlock: string, name: string): string | null {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(cssBlock);
  return m ? m[1] : null;
}

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const TOKENS_CSS = readSrc("../../../../tokens.css", "src/tokens.css");
const SALDO_ANZEIGE = readSrc(
  "../SaldoAnzeige.svelte",
  "src/lib/components/saldo/SaldoAnzeige.svelte",
);

describe("SaldoAnzeige dark-mode contrast (D-05c)", () => {
  // Note on block(): the [data-mode="dark"] block in tokens.css contains no nested braces, but it
  // DOES contain /* … */ comments with no braces — indexOf("}") is therefore safe here. That
  // assumption is proven below rather than trusted silently: each extracted block is asserted to
  // contain an anchor string BEFORE any numeric assertion runs on it. A renamed selector or a
  // restructured file makes this test fail loudly instead of silently passing on an empty string.
  const rootBlock = block(TOKENS_CSS, ":root");
  const darkBlock = block(TOKENS_CSS, '[data-mode="dark"]');

  it('finds the :root block and the [data-mode="dark"] block in tokens.css', () => {
    expect(rootBlock).not.toBeNull();
    expect(darkBlock).not.toBeNull();
    // Non-vacuity anchors: prove we captured the RIGHT block, not an empty slice.
    expect(rootBlock).toContain("--good:");
    expect(darkBlock).toContain("--bg-card");
  });

  it("reads --bg-card from the dark block and confirms it is #1f1827", () => {
    const darkBgCard = hexVar(darkBlock!, "bg-card");
    expect(darkBgCard).not.toBeNull();
    expect(darkBgCard).toBe("#1f1827");
  });

  it("dark --good-text reaches >= 4.5:1 against dark --bg-card", () => {
    const darkGoodText = hexVar(darkBlock!, "good-text");
    const darkBgCard = hexVar(darkBlock!, "bg-card");
    expect(darkGoodText).not.toBeNull();
    expect(darkBgCard).not.toBeNull();
    expect(contrast(darkGoodText!, darkBgCard!)).toBeGreaterThanOrEqual(4.5);
  });

  it("dark --bad-text reaches >= 4.5:1 against dark --bg-card", () => {
    const darkBadText = hexVar(darkBlock!, "bad-text");
    const darkBgCard = hexVar(darkBlock!, "bg-card");
    expect(darkBadText).not.toBeNull();
    expect(darkBgCard).not.toBeNull();
    expect(contrast(darkBadText!, darkBgCard!)).toBeGreaterThanOrEqual(4.5);
  });

  it("light mode is unchanged by construction: :root --good-text === --good, --bad-text === --bad", () => {
    const rootGood = hexVar(rootBlock!, "good");
    const rootBad = hexVar(rootBlock!, "bad");
    const rootGoodText = hexVar(rootBlock!, "good-text");
    const rootBadText = hexVar(rootBlock!, "bad-text");
    expect(rootGood).not.toBeNull();
    expect(rootBad).not.toBeNull();
    expect(rootGoodText).not.toBeNull();
    expect(rootBadText).not.toBeNull();
    expect(rootGoodText).toBe(rootGood);
    expect(rootBadText).toBe(rootBad);
  });

  it("light :root --good-text/--bad-text still reach >= 4.5:1 against light --bg-card", () => {
    const rootGoodText = hexVar(rootBlock!, "good-text");
    const rootBadText = hexVar(rootBlock!, "bad-text");
    const rootBgCard = hexVar(rootBlock!, "bg-card");
    expect(rootGoodText).not.toBeNull();
    expect(rootBadText).not.toBeNull();
    expect(rootBgCard).not.toBeNull();
    expect(contrast(rootGoodText!, rootBgCard!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rootBadText!, rootBgCard!)).toBeGreaterThanOrEqual(4.5);
  });

  it('background safety pin: --good/--bad are NOT redeclared under [data-mode="dark"]', () => {
    // --bad is a background under white text in .btn-danger (apps/web/src/app.css:400) and
    // .tab-badge (app.css:999). Redeclaring it (brightening it) in dark mode would drop
    // white-on-red from 6.57:1 to 2.77:1 — trading one contrast failure for three.
    expect(hexVar(darkBlock!, "good")).toBeNull();
    expect(hexVar(darkBlock!, "bad")).toBeNull();
  });

  it("SaldoAnzeige.svelte's confirmed-value and error rules use --good-text/--bad-text, not --good/--bad", () => {
    expect(SALDO_ANZEIGE.length).toBeGreaterThan(0);
    // Anchor: prove the relevant rule exists before asserting on its contents.
    expect(SALDO_ANZEIGE).toContain(".saldo__confirmed-value {");
    expect(SALDO_ANZEIGE).toContain("color: var(--good-text)");
    expect(SALDO_ANZEIGE).toContain("color: var(--bad-text)");
    expect(SALDO_ANZEIGE).not.toContain("color: var(--good);");
    expect(SALDO_ANZEIGE).not.toContain("color: var(--bad);");
  });
});
