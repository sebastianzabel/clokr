// Phase 257 (GitHub issue #257, D-12) — the absence-bar label must be readable.
//
// D-07 makes the LABEL the compensating mechanism for "colour alone is not enough" (WCAG 1.4.1;
// Krank #d97706 and Kinderkrank #ea580c sit close together). A label that fails contrast
// compensates for nothing, so this assertion is load-bearing for the phase's own decision.
//
// It recomputes every ratio from tokens.css with the WCAG 2.x relative-luminance formula — no
// number is copied from the plan. jsdom resolves no custom properties and computes no contrast,
// so the source is parsed directly; that is the same approach Phase 258 used for
// --good-text/--bad-text, including its parser trap (see extractBlock below).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function readRepoFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const TOKENS_CSS = readRepoFile("../tokens.css", "src/tokens.css");
const PAGE = readRepoFile(
  "../routes/(app)/team/leave/+page.svelte",
  "src/routes/(app)/team/leave/+page.svelte",
);

// ── WCAG 2.x relative-luminance / contrast-ratio formula ────────────────────
function srgb(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a 6-digit hex colour: ${hex}`);
  const int = parseInt(m[1], 16);
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}

function contrastRatio(hexA: string, hexB: string): number {
  const lA = luminance(hexA);
  const lB = luminance(hexB);
  const lMax = Math.max(lA, lB);
  const lMin = Math.min(lA, lB);
  return (lMax + 0.05) / (lMin + 0.05);
}

// ── Block extraction — the Phase 258 parser trap, closed ────────────────────
// `[data-mode="dark"] {` is a SUBSTRING of `html[data-mode="dark"] {` (tokens.css:56), which
// holds only `color-scheme: dark`. Phase 258's first draft matched that one, extracted zero
// tokens, and passed every assertion having checked nothing. Reject a match preceded by an
// identifier character.
function extractBlock(css: string, selector: string): string {
  const idChar = /[A-Za-z0-9_-]/;
  let searchFrom = 0;
  while (true) {
    const idx = css.indexOf(selector, searchFrom);
    if (idx === -1) {
      throw new Error(`Selector not found in tokens.css: ${selector}`);
    }
    const before = idx > 0 ? css[idx - 1] : "";
    if (idChar.test(before)) {
      // This match is a suffix of a longer selector (e.g. html[data-mode="dark"]) — reject it.
      searchFrom = idx + selector.length;
      continue;
    }
    const braceOpen = css.indexOf("{", idx);
    if (braceOpen === -1) throw new Error(`No opening brace found for selector: ${selector}`);
    const braceClose = css.indexOf("}", braceOpen);
    if (braceClose === -1) throw new Error(`No closing brace found for selector: ${selector}`);
    return css.slice(braceOpen + 1, braceClose);
  }
}

function tokensIn(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(--leave-type-[a-z-]+):\s*(#[0-9a-fA-F]{6})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

const LIGHT = tokensIn(extractBlock(TOKENS_CSS, ":root"));
const DARK = tokensIn(extractBlock(TOKENS_CSS, '[data-mode="dark"]'));

describe("leave-chip-contrast — WCAG AA for every --leave-type-* fill/text pair (Phase 257, D-12)", () => {
  it("Test 0: both token blocks parsed and are non-empty", () => {
    expect(Object.keys(LIGHT).length).toBeGreaterThanOrEqual(13);
    expect(Object.keys(DARK).length).toBeGreaterThanOrEqual(13);
    expect(LIGHT["--leave-type-vacation"]).toBe("#4caf6f"); // proves :root, not another block
    expect(DARK["--leave-type-vacation"]).toBe("#5ec78a"); // proves the REAL dark block
  });

  it("Test 1: every fill token has a -text partner, in both modes", () => {
    const fills = (t: Record<string, string>) =>
      Object.keys(t)
        .filter((k) => !k.endsWith("-text"))
        .sort();
    const texts = (t: Record<string, string>) =>
      Object.keys(t)
        .filter((k) => k.endsWith("-text"))
        .map((k) => k.replace(/-text$/, ""))
        .sort();
    expect(texts(LIGHT)).toEqual(fills(LIGHT));
    expect(texts(DARK)).toEqual(fills(DARK));
    expect(fills(LIGHT)).toEqual(fills(DARK)); // the two modes declare the same token set
  });

  it("Test 2: every fill/text pair reaches WCAG AA (>= 4.5:1), in both modes — generated", () => {
    const fills = (t: Record<string, string>) =>
      Object.keys(t)
        .filter((k) => !k.endsWith("-text"))
        .sort();

    const modes: Array<[string, Record<string, string>]> = [
      ["light", LIGHT],
      ["dark", DARK],
    ];

    let caseCount = 0;
    for (const [modeName, tokens] of modes) {
      for (const fill of fills(tokens)) {
        const textKey = `${fill}-text`;
        caseCount++;
        const fillHex = tokens[fill];
        const textHex = tokens[textKey];
        expect(textHex, `${fill} in ${modeName}: no -text partner declared`).toBeDefined();
        const ratio = contrastRatio(textHex, fillHex);
        expect(ratio, `${fill} in ${modeName}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(caseCount).toBeGreaterThanOrEqual(26);
  });

  it("Test 3: -text tokens are foreground only — never a background", () => {
    let srcRoot: string;
    try {
      srcRoot = fileURLToPath(new URL("../", import.meta.url));
    } catch {
      srcRoot = resolve(process.cwd(), "src");
    }
    const files: string[] = [];
    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          if (entry === "node_modules") continue;
          walk(full);
        } else if ([".svelte", ".css", ".ts"].includes(extname(full))) {
          files.push(full);
        }
      }
    }
    walk(srcRoot);

    // Anti-vacuity: a walk that found nothing must fail, not pass silently. The plain
    // `> 0` form is the shape apps/api/scripts/lint-guard-vacuity.ts recognises as a proof
    // that the walked (input) set is non-empty; the `> 50` assertion below is the stronger,
    // substantive floor this plan actually wants.
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThan(50);

    const offenders = files.filter((f) => {
      const content = readFileSync(f, "utf8");
      return /(background|background-color|border-color|fill)\s*:[^;]*--leave-type-[a-z-]+-text/.test(
        content,
      );
    });
    expect(offenders).toEqual([]);
  });

  it("Test 4: the chip renders the token and nothing dilutes it", () => {
    expect(PAGE).toContain("style:color={_vis.textColor}");
    const chipStart = PAGE.indexOf("  .cal-chip {");
    const legendeIdx = PAGE.indexOf("  /* Legende */");
    expect(chipStart).toBeGreaterThan(-1);
    expect(legendeIdx).toBeGreaterThan(chipStart);
    const CHIP_CSS = PAGE.slice(chipStart, legendeIdx);
    expect(CHIP_CSS).toContain("outline: 1.5px dashed currentColor;");
    expect(CHIP_CSS).not.toContain("opacity: 0.85");
    expect(CHIP_CSS).not.toContain("opacity: 0.9");
    expect(CHIP_CSS).not.toContain("rgba(255, 255, 255, 0.7)");
    expect(CHIP_CSS.length).toBeGreaterThan(200); // the slice actually found the block
  });

  it("Test 5: no existing fill token changed value", () => {
    // Pins the plan's own recomputed table as literals. This is the one place hardcoding is
    // right: it is the assertion that the plan did NOT redefine a shared token, and it must fail
    // loudly if someone "fixes" contrast the forbidden way.
    const EXPECTED_LIGHT: Record<string, string> = {
      "--leave-type-vacation": "#4caf6f",
      "--leave-type-sick": "#d97706",
      "--leave-type-sick-child": "#ea580c",
      "--leave-type-special": "#4f46e5",
      "--leave-type-overtime": "#0891b2",
      "--leave-type-education": "#2563eb",
      "--leave-type-unpaid": "#6b7280",
      "--leave-type-holiday": "#7c3aed",
      "--leave-type-maternity": "#db2777",
      "--leave-type-parental": "#be185d",
      "--leave-type-absent": "#475569",
      "--leave-type-absent-muted": "#94a3b8",
      "--leave-type-default": "#6b7280",
    };
    const EXPECTED_DARK: Record<string, string> = {
      "--leave-type-vacation": "#5ec78a",
      "--leave-type-sick": "#fbbf24",
      "--leave-type-sick-child": "#fb923c",
      "--leave-type-special": "#818cf8",
      "--leave-type-overtime": "#22d3ee",
      "--leave-type-education": "#60a5fa",
      "--leave-type-unpaid": "#9ca3af",
      "--leave-type-holiday": "#a78bfa",
      "--leave-type-maternity": "#f472b6",
      "--leave-type-parental": "#f9a8d4",
      "--leave-type-absent": "#cbd5e1",
      "--leave-type-absent-muted": "#64748b",
      "--leave-type-default": "#9ca3af",
    };
    for (const [key, hex] of Object.entries(EXPECTED_LIGHT)) {
      expect(LIGHT[key], `light ${key}`).toBe(hex);
    }
    for (const [key, hex] of Object.entries(EXPECTED_DARK)) {
      expect(DARK[key], `dark ${key}`).toBe(hex);
    }
  });
});
