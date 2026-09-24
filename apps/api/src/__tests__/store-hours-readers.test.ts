/**
 * Phase 64b Plan 04 (issue #64, D-15, AC-7) — the living allowlist of production files that may
 * reference `TenantConfig.storeHours` by identifier.
 *
 * `TenantConfig.storeHours` is DEPRECATED (`contexts/platform/facade/salons.ts`'s module
 * docblock, D-15/D-16) — this file is what makes "no new code reads it" MECHANICAL rather than a
 * promise nobody checks. Any THIRD non-test `.ts` file under `apps/api/src` whose AST contains an
 * Identifier named `storeHours` fails this test. A legitimate new reader needs an explicit owner
 * decision — AC-7 of GitHub issue #64 — which extends {@link ALLOWED_STORE_HOURS_READERS} below
 * with its own dated, reasoned comment; it is never a silent pass.
 *
 * `#325` removes `src/contexts/scheduling/api/shifts.ts` from this list when it switches the shift
 * check's reader from `TenantConfig.storeHours` to the shift's own `Salon.openingHours`.
 *
 * KNOWN LIMIT, stated rather than hidden: this guard is PER FILE — a new `storeHours` read added
 * INSIDE one of the two files already on the allowlist (`settings.ts`, `shifts.ts`) is invisible
 * to it. It only catches a NEW FILE gaining a reference, never new logic inside an existing one.
 *
 * AST via `ts.createSourceFile` (the `typescript` package, already used by
 * `apps/api/scripts/lint-facade-signatures.ts` and siblings — see that module's own docblock for
 * why AST, never a text/regex scan). A comment mentioning `storeHours` (this file's own docblock,
 * the facade's deprecation note, schema comments) is TRIVIA to the parser and is never visited by
 * `ts.forEachChild`, so it can never inflate this list — structurally, not by a stripping pass.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { describe, it, expect } from "vitest";
import * as ts from "typescript";

// __dirname is apps/api/src/__tests__ — two levels up is apps/api.
const API_ROOT = join(__dirname, "..", "..");
const SCAN_ROOT = join(API_ROOT, "src");

// AC-7: the ONLY files a caller may reference `storeHours` from today. Paths are relative to
// apps/api (i.e. "src/...", matching this module's own scan root), sorted for a stable diff.
const ALLOWED_STORE_HOURS_READERS = [
  // The reader kept ON PURPOSE until #325 switches the shift check to the shift's own
  // Salon.openingHours (D-15). #325 removes this entry.
  "src/contexts/scheduling/api/shifts.ts",
  // The tenant write path: PUT /api/v1/settings/work's Zod field (now salonOpeningHoursSchema),
  // its GET defaults, and the D-16 syncSoleActiveSalonOpeningHours mirror call (Phase 64b Plan 04).
  "src/contexts/platform/api/settings.ts",
].sort();

/** Recursively collects every non-test `.ts` file under `dir`, skipping `__tests__` directories. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...collectSourceFiles(abs));
    } else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts")) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * True if `text`'s AST contains an Identifier node whose text is exactly `storeHours`. Comments
 * and string literals are never visited — `ts.forEachChild` only descends into real syntax nodes,
 * so a mention inside a docblock or a `"storeHours"` string literal can never match.
 */
function referencesStoreHoursIdentifier(text: string): boolean {
  const source = ts.createSourceFile("scanned.ts", text, ts.ScriptTarget.Latest, true);
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === "storeHours") {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

describe("store-hours-readers — AC-7 living allowlist (D-15)", () => {
  it("walks more than 100 files, then finds storeHours referenced in EXACTLY the allowed two", () => {
    const files = collectSourceFiles(SCAN_ROOT);

    // Anti-vacuity input proof: prove the WALKED set is non-empty before trusting anything
    // filtered from it — an emptied or moved apps/api/src would otherwise leave `readers` at []
    // and the equality assertion below would pass having checked nothing.
    expect(
      files.length,
      "walked 0 (or too few) files under apps/api/src — the scan root moved or emptied",
    ).toBeGreaterThan(100);

    const readers = files
      .filter((abs) => referencesStoreHoursIdentifier(readFileSync(abs, "utf8")))
      .map((abs) => relative(API_ROOT, abs))
      .sort();

    expect(
      readers,
      "a file outside the AC-7 allowlist now references storeHours — that needs an owner " +
        "decision (extend ALLOWED_STORE_HOURS_READERS with a reason), not a silent pass",
    ).toEqual(ALLOWED_STORE_HOURS_READERS);
  });
});
