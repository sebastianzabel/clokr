/**
 * Phase 113b (AC1) — unit tests for measure-context-coverage.ts.
 *
 * Fixtures are small and hand-built, not the real `coverage/coverage-summary.json` — that file is
 * gitignored and absent on a clean checkout, which would make this test environment-dependent
 * (see the file's own <read_first> in 113B-04-PLAN.md).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  aggregateByArea,
  perFileCoverageRows,
  readCoverageSummary,
  readTestCounts,
  renderMarkdown,
  type CoverageSummary,
  type VitestJsonReport,
} from "../measure-context-coverage";

const API_ROOT = "/repo/apps/api";

function metric(total: number, covered: number) {
  return { total, covered, skipped: 0, pct: total > 0 ? (covered / total) * 100 : 0 };
}

function fileEntry(lines: [number, number], branches: [number, number]) {
  return {
    lines: metric(...lines),
    statements: metric(...lines),
    functions: metric(...lines),
    branches: metric(...branches),
  };
}

function fixtureSummary(): CoverageSummary {
  return {
    total: fileEntry([100, 60], [40, 20]),
    [`${API_ROOT}/src/app.ts`]: fileEntry([10, 10], [4, 4]), // rahmen
    [`${API_ROOT}/src/composition/dashboard.ts`]: fileEntry([50, 30], [20, 10]), // komposition
    [`${API_ROOT}/src/contexts/zeiterfassung/api/time-entries.ts`]: fileEntry([40, 20], [16, 6]), // zeiterfassung
  };
}

describe("measure-context-coverage — aggregateByArea", () => {
  it("returns one row per CONTEXT_AREAS entry, including zero-file areas", () => {
    const rows = aggregateByArea(fixtureSummary(), API_ROOT);
    expect(rows).toHaveLength(7);
    const areas = rows.map((r) => r.area);
    expect(areas).toEqual([
      "unterbau",
      "zeiterfassung",
      "abwesenheiten",
      "schichtplanung",
      "arbeitszeitkonto",
      "rahmen",
      "komposition",
    ]);
    const abwesenheiten = rows.find((r) => r.area === "abwesenheiten")!;
    expect(abwesenheiten.fileCount).toBe(0);
    expect(abwesenheiten.lines).toEqual({ total: 0, covered: 0, pct: 0 });
  });

  it("sums lines/branches correctly for a populated area", () => {
    const rows = aggregateByArea(fixtureSummary(), API_ROOT);
    const rahmen = rows.find((r) => r.area === "rahmen")!;
    expect(rahmen.fileCount).toBe(1);
    expect(rahmen.lines).toEqual({ total: 10, covered: 10, pct: 100 });
    expect(rahmen.branches).toEqual({ total: 4, covered: 4, pct: 100 });

    const komposition = rows.find((r) => r.area === "komposition")!;
    expect(komposition.fileCount).toBe(1);
    expect(komposition.lines.pct).toBeCloseTo(60, 5);
  });

  it("skips the 'total' key from summary (never buckets it as a file)", () => {
    const rows = aggregateByArea(fixtureSummary(), API_ROOT);
    const totalFiles = rows.reduce((s, r) => s + r.fileCount, 0);
    expect(totalFiles).toBe(3); // app.ts, dashboard.ts, time-entries.ts — not "total"
  });

  it("throws once, collecting ALL unmapped paths, never bucketing one into a default", () => {
    const summary: CoverageSummary = {
      total: fileEntry([10, 10], [4, 4]),
      [`${API_ROOT}/src/routes/does-not-exist-a.ts`]: fileEntry([5, 5], [2, 2]),
      [`${API_ROOT}/src/routes/does-not-exist-b.ts`]: fileEntry([5, 5], [2, 2]),
    };
    expect(() => aggregateByArea(summary, API_ROOT)).toThrowError(
      /does-not-exist-a\.ts[\s\S]*does-not-exist-b\.ts/,
    );
  });
});

describe("measure-context-coverage — perFileCoverageRows", () => {
  it("sorts by area (CONTEXT_AREAS order) then ascending line %", () => {
    const summary: CoverageSummary = {
      total: fileEntry([10, 10], [4, 4]),
      [`${API_ROOT}/src/contexts/zeiterfassung/api/time-entries.ts`]: fileEntry([100, 80], [10, 8]), // zeiterfassung, 80%
      [`${API_ROOT}/src/contexts/zeiterfassung/arbzg.ts`]: fileEntry([100, 20], [10, 2]), // zeiterfassung, 20%
      [`${API_ROOT}/src/app.ts`]: fileEntry([100, 50], [10, 5]), // rahmen, 50%
    };
    const rows = perFileCoverageRows(summary, API_ROOT);
    expect(rows.map((r) => r.relPath)).toEqual([
      "src/contexts/zeiterfassung/arbzg.ts", // zeiterfassung, thinnest first
      "src/contexts/zeiterfassung/api/time-entries.ts", // zeiterfassung, then thicker
      "src/app.ts", // rahmen, sorts after zeiterfassung per CONTEXT_AREAS order
    ]);
  });
});

describe("measure-context-coverage — readTestCounts", () => {
  it("derives per-file test counts from assertionResults.length, sorted by path", () => {
    const report: VitestJsonReport = {
      numTotalTests: 5,
      testResults: [
        { name: `${API_ROOT}/scripts/__tests__/b.test.ts`, assertionResults: [{}, {}] },
        { name: `${API_ROOT}/scripts/__tests__/a.test.ts`, assertionResults: [{}, {}, {}] },
      ],
    };
    const result = readTestCounts(report, API_ROOT);
    expect(result.files).toEqual([
      { relPath: "scripts/__tests__/a.test.ts", tests: 3 },
      { relPath: "scripts/__tests__/b.test.ts", tests: 2 },
    ]);
    expect(result.fileCount).toBe(2); // testResults.length, NOT numTotalTestSuites
    expect(result.testCount).toBe(5); // numTotalTests
  });
});

describe("measure-context-coverage — readCoverageSummary", () => {
  it("throws an actionable error (remedy text) when the file is missing", () => {
    expect(() => readCoverageSummary("/nonexistent/coverage-summary.json")).toThrowError(
      /test:coverage/,
    );
  });
});

describe("measure-context-coverage — renderMarkdown", () => {
  const baseMeta = {
    headCommit: "a".repeat(40),
    branch: "chore/113b-charakterisierungs-baseline",
    date: "2026-09-15T00:00:00.000Z",
    nodeVersion: "v24.0.0",
    vitestVersion: "4.1.10",
    thresholds: { lines: 40, functions: 37, branches: 24 },
  };

  it("contains one row per area, the reproduction commands, and the files/tests total line", () => {
    const areas = aggregateByArea(fixtureSummary(), API_ROOT);
    const perFile = perFileCoverageRows(fixtureSummary(), API_ROOT);
    const md = renderMarkdown({
      areas,
      perFile,
      testCounts: {
        files: [{ relPath: "scripts/x.test.ts", tests: 3 }],
        fileCount: 1,
        testCount: 3,
      },
      summaryTotal: {
        lines: { total: 100, covered: 60, pct: 60 },
        branches: { total: 40, covered: 20, pct: 50 },
      },
      meta: baseMeta,
    });

    for (const area of [
      "unterbau",
      "zeiterfassung",
      "abwesenheiten",
      "schichtplanung",
      "arbeitszeitkonto",
      "rahmen",
      "komposition",
    ]) {
      expect(md.toLowerCase()).toContain(area);
    }
    expect(md).toContain("pnpm --filter @clokr/api test:coverage");
    expect(md).toContain("measure-context-coverage.ts");
    expect(md).toContain(baseMeta.headCommit);
    expect(md).toContain("files: 1, tests: 3");
    expect(md).not.toContain("/Users/");
  });

  it("flags a mismatch between the summed area total and coverage-summary.json's own total", () => {
    const areas = aggregateByArea(fixtureSummary(), API_ROOT);
    const perFile = perFileCoverageRows(fixtureSummary(), API_ROOT);
    const md = renderMarkdown({
      areas,
      perFile,
      testCounts: { files: [], fileCount: 0, testCount: 0 },
      // Deliberately wrong summaryTotal vs. what the areas actually sum to (60%).
      summaryTotal: {
        lines: { total: 100, covered: 99, pct: 99 },
        branches: { total: 40, covered: 20, pct: 50 },
      },
      meta: baseMeta,
    });
    expect(md).toContain("MISMATCH");
  });

  it("reports a matching cross-check when the summed area total agrees with coverage-summary.json's total", () => {
    const areas = aggregateByArea(fixtureSummary(), API_ROOT);
    const perFile = perFileCoverageRows(fixtureSummary(), API_ROOT);
    const md = renderMarkdown({
      areas,
      perFile,
      testCounts: { files: [], fileCount: 0, testCount: 0 },
      summaryTotal: {
        lines: { total: 100, covered: 60, pct: 60 },
        branches: { total: 40, covered: 20, pct: 50 },
      },
      meta: baseMeta,
    });
    expect(md).toContain("Cross-check");
    expect(md).not.toContain("MISMATCH");
  });
});

// ── #203 import-safety: importing the module for its exports must never call process.exit, and
//    (unlike reset-test-databases.ts / ensure-test-database.ts) must never even attempt file I/O
//    or a DB connection — Part B's `readCoverageSummary`/`run()` only run behind the run-guard. ──
describe("importing measure-context-coverage.ts for its exports (GH #203-style regression)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code}) during script import`);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("importing the module never calls process.exit and exposes the expected exports", async () => {
    vi.resetModules();
    const mod = await import("../measure-context-coverage");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(typeof mod.aggregateByArea).toBe("function");
    expect(typeof mod.readCoverageSummary).toBe("function");
    expect(typeof mod.readTestCounts).toBe("function");
    expect(typeof mod.renderMarkdown).toBe("function");
  });
});
