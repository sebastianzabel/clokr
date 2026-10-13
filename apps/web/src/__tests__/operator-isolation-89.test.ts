// Issue #89 (D-02, D-04, D-13; T-89-06) — source-level isolation of the operator console.
//
// The operator console must not be able to reach the tenant session, the tenant logger, the salon
// context or the release notes, must not render raw HTML, must not call itself "Superadmin" and
// must not branch on a displayed German string. Nothing in the tenant app may link to it either.
//
// Why source reads, not mounts: the routes are not mountable in this workspace (no `$app/*` alias
// in vitest.config.ts) - same reasoning as layout-boundaries.test.ts. Each walk proves it saw the
// files it is about before any negative assertion runs, so a moved or emptied directory turns
// the test red instead of green-and-blind.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function srcRoot(): string {
  try {
    return fileURLToPath(new URL("..", import.meta.url));
  } catch {
    return resolve(process.cwd(), "src");
  }
}

const SRC = srcRoot();

function walk(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "__tests__" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, accept, out);
    else if (accept(name)) out.push(full);
  }
  return out;
}

const isSource = (name: string) => name.endsWith(".svelte") || name.endsWith(".ts");

function operatorFiles(): string[] {
  return [
    ...walk(join(SRC, "routes", "(operator)"), isSource),
    ...walk(join(SRC, "lib", "operator"), isSource),
    ...walk(join(SRC, "lib", "components", "operator"), isSource),
    join(SRC, "lib", "stores", "operator-auth.ts"),
  ];
}

const FILES = operatorFiles();
const REL = FILES.map((f) => relative(SRC, f).split("\\").join("/"));

// Specifiers of static imports, side-effect imports, re-exports and dynamic imports.
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\1|(?:\bexport\s+[^;]*?\bfrom\s*)(["'])([^"'\n]+)\3/g;

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(SPECIFIER)) found.push(m[2] ?? m[4]);
  return found;
}

// A specifier counts as forbidden when it names one of these modules by alias or by relative path.
const FORBIDDEN_MODULES = [
  "api/client",
  "stores/auth",
  "stores/salon-context",
  "stores/release-notes",
  "utils/logger",
];

function forbiddenHit(specifier: string): string | null {
  const bare = specifier.replace(/\.(ts|js|svelte)$/, "");
  for (const mod of FORBIDDEN_MODULES) {
    if (new RegExp(`(^|[/$])${mod.replace("/", "\\/")}$`).test(bare)) return mod;
  }
  return null;
}

// D-13: control decisions use codes. A comparison against a string literal that contains a space
// or a German umlaut/sharp s is a comparison against display text.
const DISPLAY_STRING =
  "[\"'`][^\"'`\\n]*[ \u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df][^\"'`\\n]*[\"'`]";
const COMPARES_DISPLAY_STRING = [
  new RegExp(`(?:===|!==)\\s*${DISPLAY_STRING}`),
  new RegExp(`${DISPLAY_STRING}\\s*(?:===|!==)`),
  new RegExp(`\\bcase\\s+${DISPLAY_STRING}`),
];

describe("operator surface isolation (D-02, D-13)", () => {
  it("walked a plausible set of operator files (non-vacuity)", () => {
    expect(FILES.length, "operator source files walked").toBeGreaterThanOrEqual(6);
    expect(REL).toContain("lib/stores/operator-auth.ts");
    expect(REL).toContain("lib/operator/client.ts");
    for (const file of FILES) {
      expect(statSync(file).isFile(), `${file} is readable`).toBe(true);
    }
  });

  it("the specifier extractor sees imports (the scan below is not blind)", () => {
    const sample = [
      'import { a } from "$stores/auth";',
      "import b from '../x';",
      'import "side-effect";',
      'const c = await import("$lib/utils/logger");',
      'export { d } from "$api/client";',
    ].join("\n");
    expect(specifiersOf(sample)).toEqual([
      "$stores/auth",
      "../x",
      "side-effect",
      "$lib/utils/logger",
      "$api/client",
    ]);
    expect(forbiddenHit("../../stores/auth")).toBe("stores/auth");
    expect(forbiddenHit("$stores/operator-auth")).toBeNull();
    expect(forbiddenHit("$lib/operator/client")).toBeNull();
  });

  it.each(FILES.map((f, i) => [REL[i], f] as const))(
    "%s reaches no tenant session, logger or salon context",
    (_rel, file) => {
      const source = readFileSync(file, "utf8");
      for (const specifier of specifiersOf(source)) {
        expect(forbiddenHit(specifier), `forbidden import "${specifier}"`).toBeNull();
      }
    },
  );

  it.each(FILES.map((f, i) => [REL[i], f] as const))(
    "%s renders no raw HTML and never says Superadmin",
    (_rel, file) => {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("{@html");
      expect(source.toLowerCase()).not.toContain("superadmin");
    },
  );

  it.each(FILES.map((f, i) => [REL[i], f] as const))(
    "%s compares no display string (control values are codes)",
    (_rel, file) => {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        for (const pattern of COMPARES_DISPLAY_STRING) {
          expect(pattern.test(line), `line ${index + 1}: ${line.trim()}`).toBe(false);
        }
      }
    },
  );
});

describe("nothing in the tenant app links to the operator console (D-04)", () => {
  const TENANT_DIRS = [
    join(SRC, "routes", "(app)"),
    join(SRC, "routes", "(auth)"),
    join(SRC, "lib", "components", "layout"),
  ];
  const TENANT_FILES = TENANT_DIRS.flatMap((dir) => walk(dir, isSource));

  it("walked the tenant shell (non-vacuity)", () => {
    const names = TENANT_FILES.map((f) => f.split("/").pop());
    expect(TENANT_FILES.length).toBeGreaterThan(20);
    expect(names).toContain("Sidebar.svelte");
  });

  it("contains no /betreiber string", () => {
    for (const file of TENANT_FILES) {
      expect(readFileSync(file, "utf8"), relative(SRC, file)).not.toContain("/betreiber");
    }
  });
});
