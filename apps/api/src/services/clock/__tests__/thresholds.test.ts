// Phase 307 Plan 01, Task 3 (D-06 confirmed) — two named constants for two different concepts
// that happen to share the same floor value. `resolver.ts` measures `gapMs`: elapsed time on the
// entry CURRENTLY being closed, evaluated BEFORE any write (prevention). `consolidate.ts` measures
// `prevDurationMs`: total duration of a DIFFERENT, ALREADY-CLOSED predecessor row, evaluated in a
// later consolidation pass (post-hoc artifact detection). Collapsing them into one name would
// merge two concepts — see thresholds.ts's own docblock. No database access needed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { DOUBLE_TAP_DEBOUNCE_MS, MIN_MERGE_PREDECESSOR_DURATION_MS } from "../thresholds";

// __dirname is apps/api/src/services/clock/__tests__ — one level up is apps/api/src/services/clock.
const CLOCK_DIR = join(__dirname, "..");
const RESOLVER_PATH = join(CLOCK_DIR, "resolver.ts");
const CONSOLIDATE_PATH = join(CLOCK_DIR, "consolidate.ts");
const THRESHOLDS_PATH = join(CLOCK_DIR, "thresholds.ts");

const resolverSource = readFileSync(RESOLVER_PATH, "utf-8");
const consolidateSource = readFileSync(CONSOLIDATE_PATH, "utf-8");
const thresholdsSource = readFileSync(THRESHOLDS_PATH, "utf-8");

/** Strips block comments and line comments so a text sweep for a bare literal cannot be fooled
 *  by an explanatory comment that legitimately still mentions it (this file's own header above,
 *  for instance, if it were the file under test). Not a general-purpose comment stripper — good
 *  enough for these two hand-written, non-templated source files. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("services/clock/thresholds — D-06 confirmed: two names for two concepts", () => {
  // Anti-vacuity gate FIRST: if this fails, the negation checks in block 3 below would pass
  // vacuously (an empty or moved file "contains" no forbidden literal either).
  it("G0 (anti-vacuity gate): all three source files are loaded, non-trivial, and name their identifier", () => {
    expect(resolverSource.length).toBeGreaterThan(1000);
    expect(consolidateSource.length).toBeGreaterThan(1000);
    expect(thresholdsSource.length).toBeGreaterThan(1000);
    expect(resolverSource).toContain("gapMs");
    expect(consolidateSource).toContain("prevDurationMs");
  });

  it("G1: both constants are 60_000ms and are two independent export const declarations, not an alias of one another", () => {
    expect(DOUBLE_TAP_DEBOUNCE_MS).toBe(60_000);
    expect(MIN_MERGE_PREDECESSOR_DURATION_MS).toBe(60_000);

    // Static proof, over the module's own source, that these are two separately-declared
    // literals — not `export const B = A` (same runtime value, but ONE concept wearing two
    // names, which is exactly what D-06 warns against).
    const doubleTapDecl = thresholdsSource.match(
      /export const DOUBLE_TAP_DEBOUNCE_MS\s*=\s*([^;]+);/,
    );
    const mergeDecl = thresholdsSource.match(
      /export const MIN_MERGE_PREDECESSOR_DURATION_MS\s*=\s*([^;]+);/,
    );
    expect(doubleTapDecl).not.toBeNull();
    expect(mergeDecl).not.toBeNull();
    // Each declaration's right-hand side is the literal itself, not a reference to the sibling
    // constant's name.
    expect(doubleTapDecl![1]).not.toContain("MIN_MERGE_PREDECESSOR_DURATION_MS");
    expect(mergeDecl![1]).not.toContain("DOUBLE_TAP_DEBOUNCE_MS");
    expect(doubleTapDecl![1].trim()).toBe("60_000");
    expect(mergeDecl![1].trim()).toBe("60_000");
  });

  it("G2: the bare 60_000 literal is gone from resolver.ts and consolidate.ts (comments stripped first, so an explanatory comment cannot hide a leftover literal or fake a removed one)", () => {
    const resolverCode = stripComments(resolverSource);
    const consolidateCode = stripComments(consolidateSource);

    expect(resolverCode).not.toContain("60_000");
    expect(consolidateCode).not.toContain("60_000");
    expect(resolverCode).toContain("DOUBLE_TAP_DEBOUNCE_MS");
    expect(consolidateCode).toContain("MIN_MERGE_PREDECESSOR_DURATION_MS");

    // The unrelated ms→minute converter (calcBreakMinutesLocal, consolidate.ts:12, no
    // underscore) and the ms→hour converter (gapHours, consolidate.ts:81) are a DIFFERENT
    // concept and must survive this edit untouched — the sweep above only searches for the
    // underscore spelling for exactly this reason (RESEARCH.md / CONTEXT.md D-06 measurement).
    expect(consolidateCode).toContain("/ 60000");
    expect(consolidateCode).toContain("/ 3600000");
  });
});
