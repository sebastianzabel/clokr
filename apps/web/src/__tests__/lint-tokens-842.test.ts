// Issue #842, plan 17 (D-842-23) — proof for `apps/web/scripts/lint-tokens.mjs`.
//
// The fixtures are in-memory strings, so no retired name lives in a scanned source file. Each
// failure class has a case that fails and a boundary case that passes; the anti-vacuity aborts
// (zero files, empty deny list) are proven through `runLint`, and one case runs the real tree
// with explicit floors so the tool cannot report success having checked nothing.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, it, expect } from "vitest";

import {
  collectSourceFiles,
  findTokenViolations,
  parseDenyList,
  runLint,
} from "../../scripts/lint-tokens.mjs";

const LINTRC = resolve(process.cwd(), ".lintrc-tokens.txt");
const SRC = resolve(process.cwd(), "src");

// Built from fragments so the skin/density guard (no-skin-density-842) does not match this file.
const SKIN_ATTR = ["data", "skin"].join("-");

const DENY = parseDenyList(
  [
    "# a comment line is ignored",
    "BANNED-TOKEN --text-muted",
    "BANNED-TOKEN --border",
    "BANNED-TOKEN --good",
    "BANNED-PREFIX --color-",
    `BANNED-LITERAL ${SKIN_ATTR}`,
    'BANNED-LITERAL [data-theme="wald"]',
    "BANNED-LITERAL Jost",
  ].join("\n"),
);

function check(text: string, extraFiles: string[] = []) {
  return findTokenViolations(
    [
      { path: "fixture.css", text },
      ...extraFiles.map((t, i) => ({ path: `extra-${i}.css`, text: t })),
    ],
    DENY,
  );
}

describe("parseDenyList", () => {
  it("reads the three machine line kinds and ignores comments and blank lines", () => {
    expect(DENY).toEqual([
      { kind: "token", value: "--text-muted" },
      { kind: "token", value: "--border" },
      { kind: "token", value: "--good" },
      { kind: "prefix", value: "--color-" },
      { kind: "literal", value: SKIN_ATTR },
      { kind: "literal", value: '[data-theme="wald"]' },
      { kind: "literal", value: "Jost" },
    ]);
  });

  it("the real .lintrc-tokens.txt yields a non-trivial deny list", () => {
    const real = parseDenyList(readFileSync(LINTRC, "utf8"));
    expect(real.length).toBeGreaterThan(40);
    expect(real.some((d) => d.kind === "token" && d.value === "--text-muted")).toBe(true);
    expect(real.some((d) => d.kind === "prefix" && d.value === "--color-")).toBe(true);
    expect(real.some((d) => d.kind === "literal" && d.value === SKIN_ATTR)).toBe(true);
  });
});

describe("deny check", () => {
  it("fails a retired token reference", () => {
    const v = check(".a { color: var(--text-muted); }");
    expect(v.map((x) => x.rule)).toContain("retired-token");
  });

  it("fails a retired token DECLARATION too", () => {
    const v = check(":root { --good: #0a0; }");
    expect(v.some((x) => x.rule === "retired-token" && x.match === "--good")).toBe(true);
  });

  it("fails a retired v1.2 prefix", () => {
    const v = check(".a { color: var(--color-brand); }");
    expect(v.some((x) => x.rule === "retired-prefix")).toBe(true);
  });

  it("fails a retired skin attribute", () => {
    const v = check(`[${SKIN_ATTR}="x"] .a { color: red; }`);
    expect(v.some((x) => x.rule === "retired-literal" && x.match === SKIN_ATTR)).toBe(true);
  });

  it("fails an old theme id in an attribute selector", () => {
    const v = check('[data-theme="wald"] { --brand: #123456; }');
    expect(v.some((x) => x.rule === "retired-literal")).toBe(true);
  });

  it("fails an old font family", () => {
    const v = check('.a { font-family: "Jost", sans-serif; }');
    expect(v.some((x) => x.rule === "retired-literal" && x.match === "Jost")).toBe(true);
  });

  it("reports the line of the hit", () => {
    const v = check("a {\n  b: 1;\n  color: var(--text-muted);\n}");
    expect(v[0].line).toBe(3);
  });

  it("respects identifier boundaries (a longer or embedded name passes)", () => {
    expect(check(".ksc-figure--good { color: red; }")).toEqual([]);
    expect(check(".a { color: var(--line-2); }", [":root { --line-2: #ccc; }"])).toEqual([]);
    // `--border-strong` is not `--border`; only a banned `--border-strong` line would fail it.
    expect(
      check(".a { color: var(--border-strong); }", [":root { --border-strong: #ccc; }"]),
    ).toEqual([]);
    expect(check(".plan-handle--start { left: 0; }")).toEqual([]);
  });

  it("does not let a word like Jostle trip the font literal", () => {
    expect(check(".a { content: 'Jostle'; }")).toEqual([]);
  });
});

describe("allow check", () => {
  it("fails a var() that nothing declares", () => {
    const v = check(".a { color: var(--undeclared-x); }");
    expect(v).toEqual([
      { path: "fixture.css", line: 1, rule: "undeclared-var", match: "--undeclared-x" },
    ]);
  });

  it("counts a var() with a fallback as a reference", () => {
    const v = check(".a { color: var(--undeclared-x, #fff); }");
    expect(v.some((x) => x.rule === "undeclared-var")).toBe(true);
  });

  it("passes a name declared by a CSS declaration", () => {
    expect(check(".a { color: var(--x); } :root { --x: red; }")).toEqual([]);
  });

  it("passes a name declared in another file", () => {
    expect(check(".a { color: var(--x); }", [":root { --x: red; }"])).toEqual([]);
  });

  it("passes names declared by a Svelte style: directive and an inline style attribute", () => {
    const svelte = [
      '<div style:--plan-col-w="10px" style="--lane-h: 4px"></div>',
      "<style>.a { width: var(--plan-col-w); height: var(--lane-h); }</style>",
    ].join("\n");
    expect(findTokenViolations([{ path: "x.svelte", text: svelte }], DENY)).toEqual([]);
  });

  it("passes a name declared through setProperty in TypeScript", () => {
    const ts = [
      'el.style.setProperty("--ts-declared", "1px");',
      "const css = 'width: var(--ts-declared)';",
    ].join("\n");
    expect(findTokenViolations([{ path: "x.ts", text: ts }], DENY)).toEqual([]);
  });

  it("passes a dynamic var(--prefix-${…}) when a declared name starts with the prefix", () => {
    const css = ":root { --leave-type-vacation: red; }";
    const ts = "const c = `var(--leave-type-${code})`;";
    expect(
      findTokenViolations(
        [
          { path: "a.css", text: css },
          { path: "b.ts", text: ts },
        ],
        DENY,
      ),
    ).toEqual([]);
  });

  it("fails a dynamic var(--prefix-${…}) when no declared name starts with the prefix", () => {
    const ts = "const c = `var(--nothing-here-${code})`;";
    const v = findTokenViolations([{ path: "b.ts", text: ts }], DENY);
    expect(v.some((x) => x.rule === "undeclared-var")).toBe(true);
  });
});

describe("anti-vacuity", () => {
  it("aborts (the CLI exits 1) on an empty deny list", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-tokens-842-"));
    writeFileSync(join(dir, "a.css"), ".a { color: red; }");
    expect(() => runLint({ srcDir: dir, denyText: "# only comments\n" })).toThrow(
      /deny list is empty/,
    );
  });

  it("aborts (the CLI exits 1) on zero scanned files", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-tokens-842-"));
    mkdirSync(join(dir, "__tests__"));
    writeFileSync(join(dir, "__tests__", "a.css"), ".a { color: red; }");
    expect(() => runLint({ srcDir: dir, denyText: "BANNED-TOKEN --good\n" })).toThrow(/zero files/);
  });

  it("exits 1 for a fixture tree with a retired name and 0 for a clean one", () => {
    const dirBad = mkdtempSync(join(tmpdir(), "lint-tokens-842-"));
    writeFileSync(join(dirBad, "a.css"), ".a { color: var(--good); }");
    expect(runLint({ srcDir: dirBad, denyText: "BANNED-TOKEN --good\n" }).code).toBe(1);
    const dirOk = mkdtempSync(join(tmpdir(), "lint-tokens-842-"));
    writeFileSync(join(dirOk, "a.css"), ":root { --ok: #0a0; } .a { color: var(--ok); }");
    expect(runLint({ srcDir: dirOk, denyText: "BANNED-TOKEN --good\n" }).code).toBe(0);
  });

  it("excludes tests and __tests__ directories from the walk", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-tokens-842-"));
    mkdirSync(join(dir, "__tests__"));
    writeFileSync(join(dir, "__tests__", "x.ts"), "x");
    writeFileSync(join(dir, "y.test.ts"), "y");
    writeFileSync(join(dir, "z.ts"), "z");
    expect(collectSourceFiles(dir).map((p) => p.slice(dir.length + 1))).toEqual(["z.ts"]);
  });
});

describe("the real tree", () => {
  it("is clean against the real deny list and walks a non-empty set", () => {
    const files = collectSourceFiles(SRC);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((p) => p.endsWith("tokens.css"))).toBe(true);
    const r = runLint({ srcDir: SRC, denyText: readFileSync(LINTRC, "utf8") });
    expect(r.messages.join("\n")).not.toMatch(/violation/);
    expect(r.code).toBe(0);
    expect(r.scanned).toBe(files.length);
  });
});
