/**
 * Phase 101B Plan 01 (AC-6, D-07) — blind-spot coverage over the WHOLE set for
 * measure-context-boundary-imports.ts.
 *
 * D-07 names the exact mistake not to repeat: `context-area-map.test.ts`'s red-proof picked
 * `absence/…`, the ONE context without a hyphen, and thereby proved only the case that already
 * worked. This file drives every one of the five context names (both hyphenated ones included),
 * in both directions, over every import form `check-import-targets.ts` knows, and over every
 * specifier shape this tree actually contains — against a real fixture tree on disk under
 * `fixtures/boundary-imports/`, exercised through `scanApiRoot()` (real file I/O by design,
 * mirroring `measure-foreign-context-access.test.ts`'s own fixture-on-disk approach, unlike a
 * purely in-memory unit test).
 *
 * Every describe block below asserts at least one row's FULL shape (`target`, `fromArea`, `form`,
 * `symbols`), not merely `rows.length > 0` — a length-only assertion stays green when the
 * classifier puts a row in the wrong bucket (project memory: "Discriminator-Swap macht Tests
 * still wertlos").
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOUNDARY_CONTEXTS,
  computeWorkload,
  isBoundaryContext,
  scanApiRoot,
  validateExceptionsDocument,
  type BoundaryImport,
  type ExceptionsDocument,
} from "../measure-context-boundary-imports";

const FIXTURE_ROOT = join(__dirname, "fixtures", "boundary-imports");

// Computed once — every describe block below reads from this single real scan, matching the
// house form's own `scanApiRoot(apiSrcRoot)` pattern (measure-foreign-context-access.ts's
// `scanSrcTree`).
const scan = scanApiRoot(FIXTURE_ROOT);

function rowsFrom(fromArea: string, target: string): BoundaryImport[] {
  return scan.deepImports.filter((r) => r.fromArea === fromArea && r.target === target);
}

// ── BOUNDARY_CONTEXTS itself — the literal five, never a regex ─────────────────────────────────

describe("BOUNDARY_CONTEXTS", () => {
  it("lists exactly the five contexts, including both hyphenated ones", () => {
    expect([...BOUNDARY_CONTEXTS].sort()).toEqual(
      ["absence", "platform", "scheduling", "time-tracking", "working-time-account"].sort(),
    );
    expect(BOUNDARY_CONTEXTS).toContain("time-tracking");
    expect(BOUNDARY_CONTEXTS).toContain("working-time-account");
  });

  it("isBoundaryContext rejects a lookalike that is not one of the five", () => {
    expect(isBoundaryContext("scheduling")).toBe(true);
    expect(isBoundaryContext("timezone")).toBe(false);
  });
});

// ── Every context name, both directions (D-07's own framing) ───────────────────────────────────

describe("every context name, both directions", () => {
  it("platform -> absence (platform as importer, absence as target)", () => {
    // platform/forms.ts ALSO targets absence/deep.ts (all four import forms, tested separately
    // below) — scope this assertion to platform/deep.ts's own "from" row.
    const rows = rowsFrom("platform", "absence").filter(
      (r) => r.file === "src/contexts/platform/deep.ts",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fromArea: "platform",
      target: "absence",
      targetModule: "deep.ts",
      form: "from",
      symbols: ["absenceDeepThing"],
    });
  });

  it("absence -> platform (absence as importer, platform as target)", () => {
    const rows = rowsFrom("absence", "platform");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fromArea: "absence",
      target: "platform",
      targetModule: "deep.ts",
      form: "from",
      symbols: ["platformDeepThing"],
    });
  });

  it("platform -> working-time-account (hyphenated name as TARGET)", () => {
    const rows = rowsFrom("platform", "working-time-account");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fromArea: "platform",
      target: "working-time-account",
      targetModule: "deep.ts",
      form: "from",
      symbols: ["workingTimeAccountDeepThing"],
    });
  });

  it("working-time-account -> platform (hyphenated name as IMPORTER)", () => {
    const rows = rowsFrom("working-time-account", "platform");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fromArea: "working-time-account",
      target: "platform",
      targetModule: "deep.ts",
    });
  });

  it("scheduling -> time-tracking (hyphenated name as TARGET)", () => {
    const rows = rowsFrom("scheduling", "time-tracking");
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe("time-tracking");
  });

  it("time-tracking -> scheduling (hyphenated name as IMPORTER)", () => {
    const rows = rowsFrom("time-tracking", "scheduling");
    expect(rows).toHaveLength(1);
    expect(rows[0].fromArea).toBe("time-tracking");
  });

  it("absence -> scheduling", () => {
    expect(rowsFrom("absence", "scheduling")).toHaveLength(1);
  });

  it("scheduling -> absence", () => {
    expect(rowsFrom("scheduling", "absence")).toHaveLength(1);
  });

  it("time-tracking -> working-time-account (BOTH sides hyphenated)", () => {
    const rows = rowsFrom("time-tracking", "working-time-account");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fromArea: "time-tracking",
      target: "working-time-account",
    });
  });

  it("working-time-account -> time-tracking (BOTH sides hyphenated, reversed)", () => {
    const rows = rowsFrom("working-time-account", "time-tracking");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fromArea: "working-time-account",
      target: "time-tracking",
    });
  });

  it("every one of the five contexts appears as BOTH an importer (fromArea) and a target", () => {
    const areas = new Set(scan.deepImports.map((r) => r.fromArea));
    const targets = new Set(scan.deepImports.map((r) => r.target));
    for (const ctx of BOUNDARY_CONTEXTS) {
      expect(areas.has(ctx)).toBe(true);
      expect(targets.has(ctx)).toBe(true);
    }
  });
});

// ── Every import form check-import-targets.ts knows ─────────────────────────────────────────────

describe("every import form", () => {
  const formsRows = scan.deepImports.filter((r) => r.file === "src/contexts/platform/forms.ts");

  it("recognizes all four forms, all targeting the same module", () => {
    expect(formsRows.map((r) => r.form).sort()).toEqual(
      ["dynamic-import", "from", "typeof-import", "vi.mock"].sort(),
    );
    for (const row of formsRows) {
      expect(row).toMatchObject({
        fromArea: "platform",
        target: "absence",
        targetModule: "deep.ts",
      });
    }
  });

  it('"from" carries the named binding as its symbol', () => {
    const row = formsRows.find((r) => r.form === "from");
    expect(row?.symbols).toEqual(["absenceDeepThing"]);
  });

  it('"typeof-import" has no named bindings — symbols is empty', () => {
    const row = formsRows.find((r) => r.form === "typeof-import");
    expect(row?.symbols).toEqual([]);
  });

  it('"vi.mock" has no named bindings — symbols is empty (zero production hits today, tested anyway)', () => {
    const row = formsRows.find((r) => r.form === "vi.mock");
    expect(row?.symbols).toEqual([]);
  });

  it('"dynamic-import" has no named bindings — symbols is empty', () => {
    const row = formsRows.find((r) => r.form === "dynamic-import");
    expect(row?.symbols).toEqual([]);
  });
});

// ── Specifier shapes ─────────────────────────────────────────────────────────────────────────────

describe("specifier shapes", () => {
  it('WITH a literal "contexts/" segment (composition/, outside contexts/) is counted', () => {
    const row = scan.deepImports.find((r) => r.file === "src/composition/dashboard.ts");
    expect(row).toMatchObject({
      fromArea: "composition",
      target: "absence",
      targetModule: "deep.ts",
      specifier: "../contexts/absence/deep",
    });
  });

  it('WITHOUT a literal "contexts/" segment (the majority shape, written from inside contexts/) is counted', () => {
    const row = scan.deepImports.find((r) => r.file === "src/contexts/platform/deep.ts");
    expect(row?.specifier.includes("contexts/")).toBe(false);
  });

  it("an explicit .js suffix resolves and is counted (NodeNext-style)", () => {
    const row = scan.deepImports.find((r) => r.file === "src/contexts/absence/api/nested.ts");
    expect(row).toMatchObject({
      target: "working-time-account",
      targetModule: "deep.ts",
      specifier: "../../working-time-account/deep.js",
    });
  });

  it("pointing at the index IMPLICITLY is NOT counted", () => {
    const row = scan.deepImports.find(
      (r) => r.file === "src/contexts/absence/api/nested.ts" && r.specifier === "../../platform",
    );
    expect(row).toBeUndefined();
    expect(scan.indexImportsByFile.get("src/contexts/absence/api/nested.ts")?.has("platform")).toBe(
      true,
    );
  });

  it("pointing at the index EXPLICITLY (/index) is NOT counted", () => {
    const row = scan.deepImports.find(
      (r) =>
        r.file === "src/contexts/absence/api/nested.ts" && r.specifier === "../../platform/index",
    );
    expect(row).toBeUndefined();
  });

  it("own context via a name-bearing path from services/clock is NOT counted", () => {
    const row = scan.deepImports.find(
      (r) => r.file === "src/services/clock/resolver.ts" && r.target === "time-tracking",
    );
    expect(row).toBeUndefined();
  });

  it("own context via a name-bearing path from services/phorest is NOT counted", () => {
    const row = scan.deepImports.find(
      (r) => r.file === "src/services/phorest/sync.ts" && r.target === "scheduling",
    );
    expect(row).toBeUndefined();
  });
});

// ── __tests__ stays out of scope (Owner decision #246) ──────────────────────────────────────────

describe("__tests__ stays out of scope", () => {
  it("a *.test.ts file under __tests__/ that deep-imports a foreign context produces no row", () => {
    const rows = scan.deepImports.filter((r) => r.file.includes("__tests__"));
    expect(rows).toHaveLength(0);
  });
});

// ── services/clock and services/phorest belong to their context (ADR 0001 entry F) ─────────────

describe("services/clock and services/phorest belong to their context", () => {
  it("services/clock/** is classified as time-tracking, not a fourth area", () => {
    const crossRow = scan.deepImports.find((r) => r.file === "src/services/clock/resolver.ts");
    expect(crossRow?.fromArea).toBe("time-tracking");
  });

  it("services/phorest/** is classified as scheduling, not a fourth area", () => {
    const crossRow = scan.deepImports.find((r) => r.file === "src/services/phorest/sync.ts");
    expect(crossRow?.fromArea).toBe("scheduling");
  });
});

// ── Exceptions document ──────────────────────────────────────────────────────────────────────────

describe("exceptions document", () => {
  it("a wholeFile entry whose expectedCount disagrees with the measured count is invalid", () => {
    const raw = {
      registerSource: "test",
      exceptions: [
        {
          id: "bad-count",
          file: "src/contexts/platform/deep.ts",
          wholeFile: true,
          expectedCount: 999,
          reason: "This reason is deliberately long enough to pass the length check for the test.",
          disappearsIn: "Never — this is a deliberately wrong fixture.",
        },
      ],
    };
    const result = validateExceptionsDocument(raw, scan.deepImports);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("STALE"))).toBe(true);
    }
  });

  it("a per-site entry naming a file+specifier that no longer exists is stale", () => {
    const raw = {
      registerSource: "test",
      exceptions: [
        {
          id: "gone",
          file: "src/contexts/platform/deep.ts",
          specifier: "../does-not-exist/anywhere",
          reason: "This reason is deliberately long enough to pass the length check for the test.",
          disappearsIn: "Never — this is a deliberately stale fixture.",
        },
      ],
    };
    const result = validateExceptionsDocument(raw, scan.deepImports);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("STALE"))).toBe(true);
    }
  });

  it("a reason shorter than 30 characters is rejected", () => {
    const raw = {
      registerSource: "test",
      exceptions: [
        {
          id: "short-reason",
          file: "src/contexts/platform/deep.ts",
          wholeFile: true,
          expectedCount:
            rowsFrom("platform", "absence").length +
            rowsFrom("platform", "working-time-account").length,
          reason: "too short",
          disappearsIn: "Never.",
        },
      ],
    };
    const result = validateExceptionsDocument(raw, scan.deepImports);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("minimum"))).toBe(true);
    }
  });

  it("a valid wholeFile entry whose count matches is accepted and excepts every row in that file", () => {
    const fileCount = scan.deepImports.filter(
      (r) => r.file === "src/contexts/platform/deep.ts",
    ).length;
    const raw = {
      registerSource: "test",
      exceptions: [
        {
          id: "matches",
          file: "src/contexts/platform/deep.ts",
          wholeFile: true,
          expectedCount: fileCount,
          reason: "This reason is deliberately long enough to pass the length check for the test.",
          disappearsIn: "Never by design for this test fixture.",
        },
      ],
    };
    const result = validateExceptionsDocument(raw, scan.deepImports);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const workload = computeWorkload(scan.deepImports, result.doc);
      expect(workload.workload.some((r) => r.file === "src/contexts/platform/deep.ts")).toBe(false);
      expect(workload.excepted).toHaveLength(fileCount);
    }
  });
});

// ── --check is equality, not a floor ────────────────────────────────────────────────────────────

describe("--check is equality, not a floor", () => {
  it("the workload count matches neither n-1 nor n+1 of itself — equality, not a range", () => {
    const emptyDoc: ExceptionsDocument = { registerSource: "test", exceptions: [] };
    const { workload } = computeWorkload(scan.deepImports, emptyDoc);
    const n = workload.length;
    expect(workload.length).not.toBe(n - 1);
    expect(workload.length).not.toBe(n + 1);
    expect(workload.length).toBe(n);
  });
});
