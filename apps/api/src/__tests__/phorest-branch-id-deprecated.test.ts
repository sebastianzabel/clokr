/**
 * Phase 65b (issue #65), D-22, AC-6 — the living deprecation guard for `TenantConfig.phorestBranchId`.
 *
 * `TenantConfig.phorestBranchId` is deprecated (`/// @deprecated` in `packages/db/prisma/schema.prisma`)
 * and replaced by `SalonCoupling` (one Phorest branch id per salon, Phase 65b Plan 01). This file makes
 * "no production code reads or writes it" MECHANICAL rather than a promise nobody checks.
 *
 * SCOPE — four roots, not one. Before this phase the identifier lived not only in `apps/api/src`
 * (`services/phorest/sync-shifts.ts`, `sync-appointments.ts`, `contexts/scheduling/api/integrations.ts`)
 * but also in the web admin page (`apps/web/src/routes/(app)/admin/phorest/+page.svelte`) and in the
 * seed script (`packages/db/src/seed-demo.ts`). A guard scoped to `apps/api/src` alone would have missed
 * two of those five original readers — hence four roots: `apps/api/src`, `apps/api/scripts`,
 * `apps/web/src`, `packages/db/src`.
 *
 * OUT OF SCOPE BY DESIGN: the Prisma schema itself (the declaration and its `@deprecated` doc comment),
 * migrations (`packages/db/prisma/migrations/**`, which legitimately reference the column by name in raw
 * SQL), and every test file (`__tests__` directories and `*.test.ts`/`*.spec.ts`/`*.test.js`/
 * `*.test.mjs` files) — a test fixture that still sets the deprecated column to exercise a legacy code
 * path is not a production reader.
 *
 * DETECTION — AST, not text search, for `.ts`/`.mts`/`.mjs`/`.js` sources: `ts.createSourceFile` plus a
 * visitor that matches an `Identifier` node whose text is exactly the constant (property access, object-
 * literal key, destructuring binding, …) or a `StringLiteral`/`NoSubstitutionTemplateLiteral` node whose
 * text is exactly the constant (an element-access read like `config["phorestBranchId"]`). Comments are
 * trivia to the TypeScript parser and are never visited by `ts.forEachChild`, so a comment mentioning the
 * name — including this file's own docblock — can never be flagged.
 *
 * For `.svelte` sources (which TypeScript cannot parse whole): every `<script …>…</script>` block's body
 * runs through the SAME AST detector above. The remaining markup — with script blocks, style blocks and
 * `<!-- … -->` HTML comments stripped — is checked with ONE plain word-boundary regex scan, because a
 * Svelte template expression (`{config.phorestBranchId}`) is not a parseable TypeScript file on its own.
 * This is the one text-based check in this guard, and it is confined to Svelte markup for exactly that
 * reason.
 *
 * KNOWN LIMIT, stated rather than hidden: a raw-SQL string that names the column inside a longer SQL
 * statement (e.g. a hand-written query string embedding `"phorestBranchId"` as one identifier among
 * others) is not itself an `Identifier` or an exact-match string literal in the surrounding TypeScript,
 * so it is not caught by the AST check — only an exact standalone string literal matching the constant is.
 * No such string exists in the codebase at authoring time; this is a structural limit of the tool, not an
 * exception granted to a known file.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, sep } from "node:path";
import { describe, it, expect } from "vitest";
import * as ts from "typescript";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root, same resolution as
// shift-salon-migration.test.ts / t100-09-oracle-probe.test.ts.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

const DEPRECATED_IDENTIFIER = "phorestBranchId";

// Directories skipped by NAME, at any depth under a root.
const SKIP_DIR_BASENAMES = new Set([
  "__tests__",
  "node_modules",
  "generated",
  "dist",
  "build",
  ".svelte-kit",
  "coverage",
]);

const TRACKED_EXTENSIONS = new Set([".ts", ".mts", ".mjs", ".js", ".svelte"]);

function isTestFileName(name: string): boolean {
  return (
    name.endsWith(".test.ts") ||
    name.endsWith(".spec.ts") ||
    name.endsWith(".test.js") ||
    name.endsWith(".test.mjs")
  );
}

/** Recursively collects every tracked file under `absDir`, skipping test files and skip-dirs. */
function collectFiles(absDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(absDir)) {
    if (SKIP_DIR_BASENAMES.has(entry)) continue;
    const abs = join(absDir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...collectFiles(abs));
    } else if (TRACKED_EXTENSIONS.has(extname(entry)) && !isTestFileName(entry)) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * True if `text`'s AST (parsed as `scriptKind`) contains an Identifier node whose text is exactly
 * `DEPRECATED_IDENTIFIER`, or a StringLiteral/NoSubstitutionTemplateLiteral node whose text is exactly
 * `DEPRECATED_IDENTIFIER` (catches `x["phorestBranchId"]`). Comments and substrings inside longer string
 * literals never match — the parser's trivia is never visited, and the string check is exact equality,
 * never `includes`.
 */
function referencesDeprecatedIdentifierInScript(text: string, scriptKind: ts.ScriptKind): boolean {
  const source = ts.createSourceFile("scanned", text, ts.ScriptTarget.Latest, true, scriptKind);
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === DEPRECATED_IDENTIFIER) {
      found = true;
      return;
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === DEPRECATED_IDENTIFIER
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const STYLE_BLOCK_RE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const MARKUP_WORD_BOUNDARY_RE = new RegExp(`\\b${DEPRECATED_IDENTIFIER}\\b`);

/**
 * `.svelte` sources: every `<script>` block's body runs through the AST detector above; the remaining
 * markup (script blocks, style blocks and HTML comments stripped) is checked with a plain word-boundary
 * regex — the one text-based check in this guard (see module docblock).
 */
function referencesDeprecatedIdentifierInSvelte(text: string): boolean {
  SCRIPT_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCRIPT_BLOCK_RE.exec(text)) !== null) {
    if (referencesDeprecatedIdentifierInScript(match[1], ts.ScriptKind.TS)) return true;
  }
  const markup = text
    .replace(SCRIPT_BLOCK_RE, "")
    .replace(STYLE_BLOCK_RE, "")
    .replace(HTML_COMMENT_RE, "");
  return MARKUP_WORD_BOUNDARY_RE.test(markup);
}

function referencesDeprecatedIdentifier(absPath: string): boolean {
  const text = readFileSync(absPath, "utf8");
  const ext = extname(absPath);
  if (ext === ".svelte") {
    return referencesDeprecatedIdentifierInSvelte(text);
  }
  const scriptKind = ext === ".mjs" || ext === ".js" ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return referencesDeprecatedIdentifierInScript(text, scriptKind);
}

function toRepoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join("/");
}

// ── Roots (D-22) ───────────────────────────────────────────────────────────────────────────────
// Measured 2026-09-25 on this branch (post 65b-01/02/03); floors set well below the measured count
// so a moved or emptied root turns this guard red instead of silently walking nothing.
const ROOTS: Array<{ label: string; relDir: string; floor: number; knownFile: string }> = [
  {
    label: "apps/api/src",
    relDir: "apps/api/src",
    floor: 100, // measured 168
    knownFile: "apps/api/src/contexts/scheduling/api/integrations.ts",
  },
  {
    label: "apps/api/scripts",
    relDir: "apps/api/scripts",
    floor: 30, // measured 52
    knownFile: "apps/api/scripts/measure-foreign-context-access.ts",
  },
  {
    label: "apps/web/src",
    relDir: "apps/web/src",
    floor: 80, // measured 142 (.ts + .svelte)
    knownFile: "apps/web/src/routes/(app)/admin/phorest/+page.svelte",
  },
  {
    label: "packages/db/src",
    relDir: "packages/db/src",
    floor: 2, // measured 5
    knownFile: "packages/db/src/seed-demo.ts",
  },
];

describe("phorest-branch-id-deprecated — D-22 living guard (four roots)", () => {
  describe("detector self-test", () => {
    it("finds a property access, an object-literal key, a destructuring binding, and an exact string-literal element access", () => {
      expect(
        referencesDeprecatedIdentifierInScript(
          "const branch = tenantConfig.phorestBranchId;",
          ts.ScriptKind.TS,
        ),
      ).toBe(true);
      expect(
        referencesDeprecatedIdentifierInScript(
          "const cfg = { phorestBranchId: value };",
          ts.ScriptKind.TS,
        ),
      ).toBe(true);
      expect(
        referencesDeprecatedIdentifierInScript(
          "const { phorestBranchId } = tenantConfig;",
          ts.ScriptKind.TS,
        ),
      ).toBe(true);
      expect(
        referencesDeprecatedIdentifierInScript(
          'const branch = tenantConfig["phorestBranchId"];',
          ts.ScriptKind.TS,
        ),
      ).toBe(true);
    });

    it("finds a .svelte source whose markup reads the key", () => {
      const source = [
        '<script lang="ts">',
        '  let config = { branchId: "" };',
        "</script>",
        "",
        "<p>{config.phorestBranchId}</p>",
        "",
      ].join("\n");
      expect(referencesDeprecatedIdentifierInSvelte(source)).toBe(true);
    });

    it("never fires on a // line comment, a /* */ block comment, or a <!-- --> HTML comment", () => {
      expect(
        referencesDeprecatedIdentifierInScript(
          "// phorestBranchId is deprecated, see ADR 0001 Eintrag M",
          ts.ScriptKind.TS,
        ),
      ).toBe(false);
      expect(
        referencesDeprecatedIdentifierInScript(
          "/* phorestBranchId is deprecated */\nconst x = 1;",
          ts.ScriptKind.TS,
        ),
      ).toBe(false);
      const svelteWithHtmlComment = [
        '<script lang="ts">',
        "  // nothing here",
        "</script>",
        "",
        "<!-- phorestBranchId lived here once -->",
        "<p>Hallo</p>",
        "",
      ].join("\n");
      expect(referencesDeprecatedIdentifierInSvelte(svelteWithHtmlComment)).toBe(false);
    });

    it("never fires on a longer identifier that merely starts with the name, or an unrelated string containing the name as a substring", () => {
      expect(
        referencesDeprecatedIdentifierInScript(
          "const phorestBranchIdLegacy = 1;",
          ts.ScriptKind.TS,
        ),
      ).toBe(false);
      expect(
        referencesDeprecatedIdentifierInScript(
          'const note = "see phorestBranchId in the old docs for context";',
          ts.ScriptKind.TS,
        ),
      ).toBe(false);
    });
  });

  describe.each(ROOTS)("root: $label", ({ relDir, floor, knownFile }) => {
    it(`walks more than ${floor} files and contains its known file`, () => {
      const files = collectFiles(join(REPO_ROOT, relDir));

      // Anti-vacuity input proof: prove the WALKED set is non-empty (well above a trivial minimum)
      // before trusting anything filtered from it — an emptied or moved root would otherwise leave
      // the reader list at [] and the final equality assertion would pass having checked nothing.
      expect(
        files.length,
        `${relDir} walked too few files (or none) — the root moved or emptied`,
      ).toBeGreaterThan(floor);

      const relFiles = files.map(toRepoRelative);
      expect(
        relFiles,
        `${relDir}'s known file ${knownFile} is missing from the walked set`,
      ).toContain(knownFile);
    });
  });

  it("finds ZERO production references to the deprecated identifier across all four roots", () => {
    const allFiles = ROOTS.flatMap(({ relDir }) => collectFiles(join(REPO_ROOT, relDir)));

    expect(
      allFiles.length,
      "walked 0 (or too few) files across all four roots combined — a root moved or emptied",
    ).toBeGreaterThan(ROOTS.reduce((sum, r) => sum + r.floor, 0));

    const readers = allFiles
      .filter((abs) => referencesDeprecatedIdentifier(abs))
      .map(toRepoRelative)
      .sort();

    expect(
      readers,
      "a production file now references the deprecated TenantConfig.phorestBranchId identifier — " +
        "this needs an explicit owner decision (the column is deprecated per ADR 0001 Eintrag M and " +
        "is removed in a later ticket), not a silent pass",
    ).toEqual([]);
  });
});
