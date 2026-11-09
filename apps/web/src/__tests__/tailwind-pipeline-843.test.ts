// Issue #843, plan 03 (D-843-02, D-843-13, D-843-17) - pin test of the Tailwind token pipeline.
//
// Tailwind 4 runs as a token pipeline only: `src/tailwind-theme.css` maps the tokens.css roles to
// Tailwind's `--color-*` / `--radius-*` namespaces, and nothing else. This file proves the shape
// of that one file by reading it, compiles its real theme block with Tailwind's own engine, and
// pins the named `lint:tokens` carve-out. Every structural rule has a negative control: a mutated
// copy of the theme that must turn the validator red, so the test cannot pass by checking nothing.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { compile } from "tailwindcss";
import { describe, it, expect } from "vitest";

import {
  findTokenViolations,
  parseDenyList,
  TAILWIND_THEME_FILE,
} from "../../scripts/lint-tokens.mjs";
import { readTokensCss } from "./token-cascade";

const WEB = process.cwd();
const THEME_PATH = resolve(WEB, "src/tailwind-theme.css");
const theme = readFileSync(THEME_PATH, "utf8");
const tokensCss = readTokensCss();
const lintrc = readFileSync(resolve(WEB, ".lintrc-tokens.txt"), "utf8");

/** Removes block comments so braces and colons inside prose never reach the parsers. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The custom properties tokens.css declares (the only valid targets of a theme mapping). */
function declaredTokenNames(css: string): Set<string> {
  const names = new Set<string>();
  for (const m of stripComments(css).matchAll(/(?<![\w-])(--[\w-]+)\s*:/g)) names.add(m[1]);
  return names;
}

/** The text between the braces of the single `@theme inline { … }` block. */
function themeBlock(css: string): string {
  const m = /@theme\s+inline\s*\{([^}]*)\}/.exec(stripComments(css));
  if (!m) throw new Error("no `@theme inline { … }` block found");
  return m[1];
}

/** Every `--key: value` declaration of a block, in source order. */
function declarations(block: string): Array<{ key: string; value: string }> {
  return [...block.matchAll(/(--[\w*-]+)\s*:\s*([^;]+);/g)].map((m) => ({
    key: m[1],
    value: m[2].trim(),
  }));
}

/** All structural problems of a theme file; an empty list means the file is a valid pipeline. */
function themeProblems(css: string, declared: Set<string>): string[] {
  const problems: string[] = [];
  const plain = stripComments(css);
  if (!/source\(none\)/.test(plain)) problems.push("utilities import lacks source(none)");
  const sources = [...plain.matchAll(/@source\s+["']([^"']+)["']/g)].map((m) => m[1]);
  if (sources.length !== 1 || sources[0] !== "./lib/components/ui") {
    problems.push(`expected exactly one @source on ./lib/components/ui, got ${sources.join(",")}`);
  }
  if (/preflight/.test(plain)) problems.push("preflight is imported");
  if (/tailwindcss\/theme(\.css)?["']/.test(plain)) problems.push("the default theme is imported");

  const decls = declarations(themeBlock(css));
  if (decls.length === 0) problems.push("the theme block is empty");
  for (const { key, value } of decls) {
    if (/^--(color|radius)-\*$/.test(key)) {
      if (value !== "initial") problems.push(`${key} must be reset with initial, got ${value}`);
      continue;
    }
    if (!/^--(color|radius)-[\w-]+$/.test(key)) {
      problems.push(`${key} is outside the colour and radius namespaces`);
      continue;
    }
    if (key.startsWith("--font-") || key.startsWith("--shadow")) problems.push(`${key} is mapped`);
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (!ref) {
      problems.push(`${key} is not a plain var(--role): ${value}`);
      continue;
    }
    if (ref[1] === key) problems.push(`${key} references itself`);
    if (!declared.has(ref[1])) problems.push(`${key} maps onto ${ref[1]}, which tokens.css lacks`);
  }
  return problems;
}

const DECLARED = declaredTokenNames(tokensCss);

describe("tailwind-theme.css (D-843-13)", () => {
  it("is a valid token pipeline: utilities only, one @source, no preflight, only var(--role)", () => {
    // Floor: the roles of tokens.css and the block itself are really there.
    expect(DECLARED.has("--brand")).toBe(true);
    expect(declarations(themeBlock(theme)).length).toBeGreaterThanOrEqual(30);
    expect(themeProblems(theme, DECLARED)).toEqual([]);
  });

  it("maps the D-05 colour roles and the four radii, and nothing else", () => {
    const keys = declarations(themeBlock(theme)).map((d) => d.key);
    for (const role of ["bg", "card", "line", "text-2", "brand", "brand-ink", "ok-soft", "a6"]) {
      expect(keys).toContain(`--color-${role}`);
    }
    for (const r of ["card", "control", "stage", "pill"]) expect(keys).toContain(`--radius-${r}`);
    expect(keys.filter((k) => !/^--(color|radius)-/.test(k))).toEqual([]);
    // The font, shadow and spacing keys are never mapped (a same-name key destroys the token).
    expect(keys.some((k) => k.startsWith("--font-") || k.startsWith("--shadow"))).toBe(false);
    expect(keys).not.toContain("--spacing");
  });

  it("declares the layer order and the utilities import with source(none)", () => {
    const plain = stripComments(theme);
    expect(plain).toMatch(/@layer\s+theme\s*,\s*base\s*,\s*components\s*,\s*utilities\s*;/);
    expect(plain).toMatch(
      /@import\s+["']tailwindcss\/utilities\.css["']\s+layer\(utilities\)\s+source\(none\)\s*;/,
    );
  });

  it("negative controls: a mutated theme turns the validator red", () => {
    const withExtra = (line: string) =>
      theme.replace("@theme inline {", `@theme inline {\n  ${line}`);
    const cases: Array<[string, string, string]> = [
      ["self reference", withExtra("--color-bg: var(--color-bg);"), "references itself"],
      ["undeclared role", withExtra("--color-ghost: var(--no-such-role);"), "tokens.css lacks"],
      ["font key", withExtra("--font-ui: var(--font-ui);"), "outside the colour and radius"],
      ["literal value", withExtra("--color-ghost: #ff0000;"), "not a plain var(--role)"],
      ["spacing key", withExtra("--spacing: 4px;"), "outside the colour and radius"],
      ["preflight", `${theme}\n@import "tailwindcss/preflight.css";`, "preflight"],
      ["second @source", `${theme}\n@source "./routes";`, "exactly one @source"],
      [
        "no source(none)",
        theme.replace("layer(utilities) source(none)", "layer(utilities)"),
        "source(none)",
      ],
    ];
    for (const [name, mutated, expected] of cases) {
      const problems = themeProblems(mutated, DECLARED);
      expect(problems.join("\n"), name).toContain(expected);
    }
  });
});

describe("the compiled pipeline", () => {
  it("emits var(--role) values for the mapped utilities and nothing for unmapped ones", async () => {
    const compiler = await compile(`@tailwind utilities;\n@theme inline {${themeBlock(theme)}}`);
    const css = compiler.build([
      "bg-brand",
      "text-text-2",
      "border-line",
      "rounded-control",
      "bg-red-500",
    ]);
    expect(css).toMatch(/\.bg-brand\s*\{\s*background-color:\s*var\(--brand\)/);
    expect(css).toMatch(/\.text-text-2\s*\{\s*color:\s*var\(--text-2\)/);
    expect(css).toMatch(/\.border-line\s*\{\s*border-color:\s*var\(--line\)/);
    expect(css).toMatch(/\.rounded-control\s*\{\s*border-radius:\s*var\(--r-control\)/);
    // No default palette survives the reset.
    expect(css).not.toContain("red-500");
  });
});

describe("the lint:tokens carve-out (D-843-13)", () => {
  const deny = parseDenyList(lintrc);
  const carved = (text: string, path: string) =>
    findTokenViolations([{ path, text }], deny, { declared: DECLARED });

  it("names exactly the one theme file", () => {
    expect(TAILWIND_THEME_FILE).toBe("apps/web/src/tailwind-theme.css");
  });

  it("the machine lines still ban both Tailwind prefixes (the carve-out removes no rule)", () => {
    const prefixes = deny.filter((d) => d.kind === "prefix").map((d) => d.value);
    expect(prefixes).toContain("--color-");
    expect(prefixes).toContain("--radius-");
  });

  it("exempts the theme file from the two prefixes only", () => {
    const text = ":root { --color-x: var(--brand); --radius-y: var(--r-card); }";
    expect(carved(text, TAILWIND_THEME_FILE)).toEqual([]);
    // Positive control: the identical text in any other path is reported twice.
    const other = carved(text, "apps/web/src/lib/other.css");
    expect(other.filter((v) => v.rule === "retired-prefix").length).toBe(2);
    expect(carved(text, "apps/web/src/lib/nested/apps/web/src/tailwind-theme.css").length).toBe(2);
  });

  it("does not lift the undeclared-var rule or the other deny rules in the theme file", () => {
    const undeclared = carved(":root { --color-x: var(--no-such-token); }", TAILWIND_THEME_FILE);
    expect(undeclared.map((v) => v.rule)).toEqual(["undeclared-var"]);
    const retired = carved(":root { --color-x: var(--gray-500); }", TAILWIND_THEME_FILE);
    expect(retired.some((v) => v.rule === "retired-prefix" && v.match === "--gray-")).toBe(true);
  });
});

describe("wiring", () => {
  it("pins @tailwindcss/vite to an exact version, as a devDependency only", () => {
    const pkg = JSON.parse(readFileSync(resolve(WEB, "package.json"), "utf8"));
    expect(pkg.devDependencies["@tailwindcss/vite"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies?.["@tailwindcss/vite"]).toBeUndefined();
  });

  it("runs the Tailwind plugin before sveltekit() in vite.config.ts", () => {
    const vite = readFileSync(resolve(WEB, "vite.config.ts"), "utf8");
    expect(vite).toMatch(/import\s+tailwindcss\s+from\s+["']@tailwindcss\/vite["']/);
    const plugins = /plugins:\s*\[([^\]]*)\]/.exec(vite)?.[1] ?? "";
    expect(plugins.replace(/\s/g, "")).toBe("tailwindcss(),sveltekit()");
  });

  it("imports tokens.css, then app.css, then tailwind-theme.css in the root layout", () => {
    const layout = readFileSync(resolve(WEB, "src/routes/+layout.svelte"), "utf8");
    const at = (s: string) => layout.indexOf(`import "${s}"`);
    expect(at("../tokens.css")).toBeGreaterThanOrEqual(0);
    expect(at("../tokens.css")).toBeLessThan(at("../app.css"));
    expect(at("../app.css")).toBeLessThan(at("../tailwind-theme.css"));
  });
});
