/**
 * Issue #563 (AC-563-3, D-09), tightened by Issue #638 — the tenant-level opening-hours column is
 * gone, and no source tree may name it again.
 *
 * Opening hours live only on the salon (`Salon.openingHours`). #563 stopped every read and write of
 * `TenantConfig.storeHours`; #638 dropped the column. This guard keeps the name from creeping back:
 *
 * - `apps/api/src` (non-test `.ts`): zero Identifier occurrences (AST; comments and strings are
 *   trivia to the parser and never visited). The one entry that #563 allowed, the omit entry of
 *   `RETIRED_TENANT_CONFIG_COLUMNS`, is gone with the column.
 * - `packages/db/src` (`.ts`): zero, same scan.
 * - `apps/web/src` (non-test `.ts` and `.svelte`): the word nowhere, comments included (text scan;
 *   `.svelte` cannot be parsed with the TypeScript compiler). `shiftStoreHoursMode`, the tenant's
 *   shift-check mode, is a different field and does not match the word-boundary pattern.
 *
 * Excluded: tests, `packages/db/prisma` (the migrations keep the history) and docs.
 *
 * Anti-vacuity: each walked set is proven non-empty against a floor set a little below the count
 * measured on 2026-10-15 (Phase 563 Plan 03): apps/api/src 245 files (floor 200), packages/db/src 5
 * files (floor 4), apps/web/src 239 files (floor 200). The floors are literals in the assertions on
 * purpose — the vacuity gate recognises a numeric literal, never a named constant. A moved or
 * emptied directory turns the test red instead of letting it report success having checked nothing.
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

/** Number of Identifier nodes named `storeHours` in `text`. Comments and strings are never visited. */
function identifierCount(text: string): number {
  const source = ts.createSourceFile("scanned.ts", text, ts.ScriptTarget.Latest, true);
  let count = 0;
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === RETIRED_COLUMN) count++;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return count;
}

/** Files (relative to `root`) that contain at least one identifier occurrence. */
function filesWithIdentifier(files: string[], root: string): string[] {
  return files
    .filter((abs) => identifierCount(readFileSync(abs, "utf8")) > 0)
    .map((abs) => relative(root, abs))
    .sort();
}

describe("store-hours-readers — the dropped storeHours column is named nowhere (AC-563-3, #638)", () => {
  it("apps/api/src: walks the API sources and finds no identifier occurrence", () => {
    const files = collectSourceFiles(API_SRC, [".ts"]);
    expect(
      files.length,
      "walked too few files under apps/api/src — the scan root moved or emptied",
    ).toBeGreaterThan(200);

    expect(
      filesWithIdentifier(files, API_ROOT),
      "the dropped storeHours column is referenced again — opening hours are per salon only",
    ).toEqual([]);
  });

  it("packages/db/src: walks the seed sources and finds no identifier occurrence", () => {
    const files = collectSourceFiles(DB_SRC, [".ts"]);
    expect(
      files.length,
      "walked too few files under packages/db/src — the scan root moved or emptied",
    ).toBeGreaterThanOrEqual(4);

    expect(
      filesWithIdentifier(files, REPO_ROOT),
      "a db seed source references the dropped storeHours column",
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
      "the web names the dropped storeHours column — opening hours are per salon only (Issue #563)",
    ).toEqual([]);
  });
});
