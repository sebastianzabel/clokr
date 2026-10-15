/**
 * Issue #563 (AC-563-3, D-09) — nothing reads or writes the retired `TenantConfig.storeHours`
 * column, in any of the three source trees.
 *
 * Opening hours live only on the salon (`Salon.openingHours`). The tenant-level column is retired:
 * the settings route strips it from a write and omits it from a read, seeds no longer write it, the
 * web no longer shows it. This guard makes "no code reads or writes it" MECHANICAL instead of a
 * promise nobody checks. It replaces the Phase 64b allowlist of "files that may reference the
 * column" (its one entry was the settings route, which kept writing the column and mirrored it into
 * the sole active salon) and closes that allowlist's own stated limit — it was per FILE, so a new
 * read inside the one allowed file was invisible. Here the occurrences are COUNTED and their
 * POSITION is checked.
 *
 * What is allowed, and where:
 * - `apps/api/src` (non-test `.ts`): exactly ONE Identifier named `storeHours` in the whole tree.
 *   It is the omit entry inside `RETIRED_TENANT_CONFIG_COLUMNS` of `contexts/platform/api/settings.ts`
 *   — the entry that keeps the column OUT of every settings read. A second occurrence anywhere
 *   (another file, or elsewhere in that file) fails.
 * - `packages/db/src` (`.ts`): none. The seeds do not write the column; its schema default fills it.
 * - `apps/web/src` (non-test `.ts` and `.svelte`): the word nowhere, comments included. That is
 *   deliberately stricter than the AST scan — the web has no reason to name the column at all, and
 *   `shiftStoreHoursMode` (the tenant's shift-check mode, a different field) does not match the
 *   word-boundary pattern.
 *
 * What is excluded and why: tests (the retirement tests read the column on purpose, to prove it is
 * stripped and omitted), `packages/db/prisma` (the schema and the migrations still name the column
 * until the follow-up release drops it) and docs — migrations and documentation are not code.
 *
 * AST via `ts.createSourceFile` for `.ts` (the `typescript` package, also used by
 * `apps/api/scripts/lint-facade-signatures.ts`): a comment or a string literal is trivia to the
 * parser and never visited by `ts.forEachChild`. The `.svelte` files cannot be parsed that way, so
 * the web tree is a text scan.
 *
 * Anti-vacuity: each walked set is proven non-empty against a floor set a little below the count
 * measured on 2026-10-15 (Phase 563 Plan 03): apps/api/src 245 files (floor 200), packages/db/src 5
 * files (floor 4), apps/web/src 239 files (floor 200). The floors are literals in the assertions on
 * purpose — the vacuity gate recognises a numeric literal, never a named constant. A moved or emptied directory turns the test red instead of letting it
 * report success having checked nothing.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { describe, it, expect } from "vitest";
import * as ts from "typescript";

// __dirname is apps/api/src/__tests__ — two levels up is apps/api, four levels up the repository root.
const API_ROOT = join(__dirname, "..", "..");
const REPO_ROOT = join(API_ROOT, "..", "..");
const API_SRC = join(API_ROOT, "src");
const DB_SRC = join(REPO_ROOT, "packages", "db", "src");
const WEB_SRC = join(REPO_ROOT, "apps", "web", "src");

const RETIRED_COLUMN = "storeHours";
const ALLOWED_FILE = join("src", "contexts", "platform", "api", "settings.ts");
const ALLOWED_CONSTANT = "RETIRED_TENANT_CONFIG_COLUMNS";

/** Recursively collects the non-test files under `dir` whose extension is in `extensions`. */
function collectSourceFiles(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...collectSourceFiles(abs, extensions));
    } else if (
      extensions.includes(extname(entry)) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".spec.ts")
    ) {
      out.push(abs);
    }
  }
  return out;
}

interface Occurrence {
  /** Path relative to `apps/api` (api tree) or the repository root (db tree). */
  file: string;
  /** True when the identifier sits inside the initializer of the allowed constant. */
  insideConstant: boolean;
}

/**
 * Every Identifier node named `storeHours`, with whether it lies inside the initializer of the
 * variable named `constantName`. Comments and string literals are never visited.
 */
function identifierOccurrences(text: string, constantName: string): boolean[] {
  const source = ts.createSourceFile("scanned.ts", text, ts.ScriptTarget.Latest, true);
  const found: boolean[] = [];
  function insideConstant(node: ts.Node): boolean {
    let child: ts.Node = node;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (
        ts.isVariableDeclaration(parent) &&
        ts.isIdentifier(parent.name) &&
        parent.name.text === constantName &&
        parent.initializer === child
      ) {
        return true;
      }
      child = parent;
    }
    return false;
  }
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === RETIRED_COLUMN) {
      found.push(insideConstant(node));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function occurrencesIn(files: string[], root: string, constantName: string): Occurrence[] {
  const out: Occurrence[] = [];
  for (const abs of files) {
    for (const insideConstant of identifierOccurrences(readFileSync(abs, "utf8"), constantName)) {
      out.push({ file: relative(root, abs), insideConstant });
    }
  }
  return out;
}

describe("store-hours-readers — the retired storeHours column is read and written nowhere (AC-563-3, D-09)", () => {
  it("apps/api/src: exactly one identifier occurrence, the omit entry of RETIRED_TENANT_CONFIG_COLUMNS", () => {
    const files = collectSourceFiles(API_SRC, [".ts"]);
    // Anti-vacuity input proof: the walked set must be real before anything filtered from it counts.
    expect(
      files.length,
      "walked too few files under apps/api/src — the scan root moved or emptied",
    ).toBeGreaterThan(200);

    const occurrences = occurrencesIn(files, API_ROOT, ALLOWED_CONSTANT);

    expect(
      occurrences.map((o) => o.file),
      "the retired storeHours column is referenced outside its one omit entry — nothing may read " +
        "or write it any more (Issue #563); a second occurrence is a regression, not an allowlist entry",
    ).toEqual([ALLOWED_FILE]);
    expect(
      occurrences[0].insideConstant,
      `the one allowed occurrence must sit inside the initializer of ${ALLOWED_CONSTANT}`,
    ).toBe(true);
  });

  it("packages/db/src: walks the seed sources and finds no identifier occurrence", () => {
    const files = collectSourceFiles(DB_SRC, [".ts"]);
    expect(
      files.length,
      "walked too few files under packages/db/src — the scan root moved or emptied",
    ).toBeGreaterThanOrEqual(4);

    const occurrences = occurrencesIn(files, REPO_ROOT, ALLOWED_CONSTANT);
    expect(
      occurrences,
      "a db seed source references the retired storeHours column — the seeds must not write it",
    ).toEqual([]);
  });

  it("apps/web/src: walks the web sources and the word storeHours appears in none, comments included", () => {
    const files = collectSourceFiles(WEB_SRC, [".ts", ".svelte"]);
    expect(
      files.length,
      "walked too few files under apps/web/src — the scan root moved or emptied",
    ).toBeGreaterThan(200);

    // Case-sensitive word match: `shiftStoreHoursMode` and `StoreHours` do not match.
    const word = new RegExp(`\\b${RETIRED_COLUMN}\\b`);
    const hits = files
      .filter((abs) => word.test(readFileSync(abs, "utf8")))
      .map((abs) => relative(REPO_ROOT, abs))
      .sort();
    expect(
      hits,
      "the web names the retired storeHours column — opening hours are per salon only (Issue #563)",
    ).toEqual([]);
  });
});
