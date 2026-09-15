/**
 * Phase 113b (AC1) — per-context-area coverage and per-file test-count aggregator.
 *
 * This is the DB-free half of D-01's "Skript + eingechecktes Artefakt" pair: it reads the two
 * JSON reports a full `pnpm --filter @clokr/api test:coverage` run already produces
 * (`coverage/coverage-summary.json` via the `json-summary` reporter added in 113B-01,
 * `vitest-report.json` via the `json` reporter configured in `vitest.config.ts`), buckets every
 * measured file into one of the seven `context-area-map.ts` buckets, and renders the generated
 * counterpart of `docs/characterization-baseline.md`.
 *
 * DELIBERATE DEVIATION from the `audit-*.ts` house shape: this script bootstraps no database
 * client at all. Its Part B only reads two files already on disk — there is nothing in a database
 * this measurement needs.
 *
 * Run:
 *   pnpm --filter @clokr/api run test:setup
 *   pnpm --filter @clokr/api test:coverage
 *   pnpm --filter @clokr/api exec tsx scripts/measure-context-coverage.ts --write ../../docs/context-coverage-baseline.md
 *
 * Exit codes:
 *   0 — the document was rendered (printed to stdout, or written with --write)
 *   1 — a required input file is missing/invalid, or coverage-summary.json contains a file
 *       context-area-map.ts does not know about
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import {
  type ContextArea,
  CONTEXT_AREAS,
  assignContextArea,
  UnmappedFileError,
} from "./context-area-map";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Part A: exported pure helpers (file-I/O only inside the two `read*` functions; everything
//    else is a pure transform over already-parsed data — DB-free, unit-testable) ──────────────

export interface CoverageMetricRaw {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

export interface FileCoverageRaw {
  lines: CoverageMetricRaw;
  statements: CoverageMetricRaw;
  functions: CoverageMetricRaw;
  branches: CoverageMetricRaw;
}

/** Keys are ABSOLUTE paths (as vitest's v8 `json-summary` reporter writes them), plus `"total"`. */
export type CoverageSummary = Record<string, FileCoverageRaw>;

export interface VitestAssertionResult {
  status?: string;
}

export interface VitestTestFileResult {
  name: string; // absolute path to the test file
  assertionResults: VitestAssertionResult[];
  status?: string;
}

/**
 * A structural subset of vitest's JSON reporter output. Deliberately omits the reporter's own
 * describe-block counter field — see check-test-completeness.mjs's header for why that field is
 * not a file count and must never be read for one.
 */
export interface VitestJsonReport {
  numTotalTests: number;
  testResults: VitestTestFileResult[];
}

export interface AggregateMetric {
  total: number;
  covered: number;
  pct: number;
}

export interface AreaRow {
  area: ContextArea;
  fileCount: number;
  lines: AggregateMetric;
  branches: AggregateMetric;
}

export interface PerFileRow {
  relPath: string;
  area: ContextArea;
  lines: { total: number; covered: number; pct: number };
  branches: { total: number; covered: number; pct: number };
}

export interface TestCounts {
  files: { relPath: string; tests: number }[];
  fileCount: number;
  testCount: number;
}

function pct(covered: number, total: number): number {
  return total > 0 ? (covered / total) * 100 : 0;
}

function toRelPosix(apiRoot: string, absPath: string): string {
  return relative(apiRoot, absPath).split(sep).join("/");
}

function readJsonFileOrThrow<T>(path: string, remedy: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    throw new Error(`measure-context-coverage: could not read ${path} (${code}).\n${remedy}`, {
      cause: err,
    });
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `measure-context-coverage: ${path} is not valid JSON (${(err as Error).message}).`,
      { cause: err },
    );
  }
}

/** Reads and parses `coverage/coverage-summary.json`. Throws with remedy text if absent/invalid. */
export function readCoverageSummary(path: string): CoverageSummary {
  return readJsonFileOrThrow<CoverageSummary>(
    path,
    "Run `pnpm --filter @clokr/api test:coverage` first (writes coverage/coverage-summary.json via the json-summary reporter).",
  );
}

/**
 * Test count per file, derived from `testResults[].assertionResults.length` (D-04) — the file
 * count is `testResults.length`, never the reporter's own describe-block counter field (see
 * `VitestJsonReport`'s header comment and check-test-completeness.mjs).
 */
export function readTestCounts(report: VitestJsonReport, apiRoot: string): TestCounts {
  const files = report.testResults
    .map((r) => ({
      relPath: toRelPosix(apiRoot, r.name),
      tests: r.assertionResults.length,
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { files, fileCount: report.testResults.length, testCount: report.numTotalTests };
}

/**
 * Sums `coverage-summary.json`'s per-file lines/branches into one row per context area — for ALL
 * seven areas from `CONTEXT_AREAS`, including any that sum to zero. A silently missing row would
 * understate a context, which is the one thing this baseline must not do.
 *
 * THROWS when `summary` contains a file `context-area-map.ts` does not know — collecting every
 * offending path first, so the thrown message lists all of them at once rather than one at a time.
 */
export function aggregateByArea(summary: CoverageSummary, apiRoot: string): AreaRow[] {
  const buckets = new Map<
    ContextArea,
    {
      fileCount: number;
      linesTotal: number;
      linesCovered: number;
      branchesTotal: number;
      branchesCovered: number;
    }
  >();
  for (const area of CONTEXT_AREAS) {
    buckets.set(area, {
      fileCount: 0,
      linesTotal: 0,
      linesCovered: 0,
      branchesTotal: 0,
      branchesCovered: 0,
    });
  }

  const unmapped: string[] = [];
  for (const [absPath, metrics] of Object.entries(summary)) {
    if (absPath === "total") continue;
    const relPath = toRelPosix(apiRoot, absPath);
    let area: ContextArea;
    try {
      area = assignContextArea(relPath);
    } catch (err) {
      if (err instanceof UnmappedFileError) {
        unmapped.push(relPath);
        continue;
      }
      throw err;
    }
    const bucket = buckets.get(area);
    if (!bucket) continue; // unreachable: assignContextArea only returns values from CONTEXT_AREAS
    bucket.fileCount += 1;
    bucket.linesTotal += metrics.lines.total;
    bucket.linesCovered += metrics.lines.covered;
    bucket.branchesTotal += metrics.branches.total;
    bucket.branchesCovered += metrics.branches.covered;
  }

  if (unmapped.length > 0) {
    const sorted = unmapped.sort();
    throw new Error(
      `measure-context-coverage: ${sorted.length} file(s) in coverage-summary.json are not ` +
        `assigned to a context area:\n${sorted.map((p) => `  - ${p}`).join("\n")}\n` +
        `Add them to CONTEXT_AREA_BY_FILE in apps/api/scripts/context-area-map.ts.`,
    );
  }

  return CONTEXT_AREAS.map((area) => {
    const b = buckets.get(area);
    if (!b) throw new Error(`measure-context-coverage: internal error, no bucket for ${area}`);
    return {
      area,
      fileCount: b.fileCount,
      lines: {
        total: b.linesTotal,
        covered: b.linesCovered,
        pct: pct(b.linesCovered, b.linesTotal),
      },
      branches: {
        total: b.branchesTotal,
        covered: b.branchesCovered,
        pct: pct(b.branchesCovered, b.branchesTotal),
      },
    };
  });
}

/**
 * Table 2's raw rows: every measured file with its area and coverage, sorted by area (in
 * `CONTEXT_AREAS` order) then by ascending line % — the thin end of each context first.
 *
 * Callers MUST call `aggregateByArea` on the same `summary` first; this function assumes every
 * file is already known to resolve via `assignContextArea` and does not re-collect an unmapped
 * list of its own.
 */
export function perFileCoverageRows(summary: CoverageSummary, apiRoot: string): PerFileRow[] {
  const rows: PerFileRow[] = [];
  for (const [absPath, metrics] of Object.entries(summary)) {
    if (absPath === "total") continue;
    const relPath = toRelPosix(apiRoot, absPath);
    const area = assignContextArea(relPath);
    rows.push({
      relPath,
      area,
      lines: {
        total: metrics.lines.total,
        covered: metrics.lines.covered,
        pct: pct(metrics.lines.covered, metrics.lines.total),
      },
      branches: {
        total: metrics.branches.total,
        covered: metrics.branches.covered,
        pct: pct(metrics.branches.covered, metrics.branches.total),
      },
    });
  }
  rows.sort((a, b) => {
    if (a.area !== b.area) return CONTEXT_AREAS.indexOf(a.area) - CONTEXT_AREAS.indexOf(b.area);
    return a.lines.pct - b.lines.pct;
  });
  return rows;
}

export interface RenderMeta {
  headCommit: string;
  branch: string;
  date: string;
  nodeVersion: string;
  vitestVersion: string;
  thresholds: { lines: number; functions: number; branches: number };
}

export interface RenderInput {
  areas: AreaRow[];
  perFile: PerFileRow[];
  testCounts: TestCounts;
  summaryTotal: {
    lines: { total: number; covered: number; pct: number };
    branches: { total: number; covered: number; pct: number };
  };
  meta: RenderMeta;
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

/** The whole generated document — the `docs/image-footprint.md` form applied to coverage. */
export function renderMarkdown(input: RenderInput): string {
  const lines: string[] = [];

  lines.push("# Context Coverage Baseline (AC1)");
  lines.push("");
  lines.push(
    "Purpose: this is the Phase 113b (`.planning/phases/113B-.../113B-CONTEXT.md` D-01/D-03) " +
      "measurement for GitHub issue #113 AC1 — coverage per context area, per file, and tests per " +
      "file, from `coverage/coverage-summary.json` and `vitest-report.json`. **This file is " +
      "GENERATED by `apps/api/scripts/measure-context-coverage.ts` and must be regenerated, never " +
      "hand-edited.** Every number below is measured, not asserted — see the reproduction commands " +
      "below.",
  );
  lines.push("");

  lines.push("## Reproduction");
  lines.push("");
  lines.push(
    "Data sources: `coverage/coverage-summary.json` (Table 1 & Table 2, `json-summary` v8 " +
      "reporter) and `vitest-report.json` (Table 3, `json` reporter). Regenerate with:",
  );
  lines.push("");
  lines.push("```bash");
  lines.push("pnpm --filter @clokr/api run test:setup");
  lines.push("pnpm --filter @clokr/api test:coverage");
  lines.push(
    "pnpm --filter @clokr/api exec tsx scripts/measure-context-coverage.ts --write ../../docs/context-coverage-baseline.md",
  );
  lines.push("```");
  lines.push("");

  lines.push("## Environment");
  lines.push("");
  lines.push(`- HEAD commit: \`${input.meta.headCommit}\``);
  lines.push(`- Branch: \`${input.meta.branch}\``);
  lines.push(`- Date: ${input.meta.date}`);
  lines.push(`- Node: ${input.meta.nodeVersion}`);
  lines.push(`- Vitest: ${input.meta.vitestVersion}`);
  lines.push(
    `- Coverage thresholds in force (\`apps/api/vitest.config.ts\`): lines >= ${input.meta.thresholds.lines}, ` +
      `functions >= ${input.meta.thresholds.functions}, branches >= ${input.meta.thresholds.branches}`,
  );
  lines.push("");

  lines.push("## Table 1 — Coverage per context area (AC1)");
  lines.push("");
  lines.push(
    "| Area | Files | Lines total | Lines covered | Lines % | Branches total | Branches covered | Branches % |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const row of input.areas) {
    lines.push(
      `| ${row.area} | ${row.fileCount} | ${row.lines.total} | ${row.lines.covered} | ` +
        `${fmtPct(row.lines.pct)} | ${row.branches.total} | ${row.branches.covered} | ${fmtPct(row.branches.pct)} |`,
    );
  }
  const summedFiles = input.areas.reduce((s, r) => s + r.fileCount, 0);
  const summedLinesTotal = input.areas.reduce((s, r) => s + r.lines.total, 0);
  const summedLinesCovered = input.areas.reduce((s, r) => s + r.lines.covered, 0);
  const summedBranchesTotal = input.areas.reduce((s, r) => s + r.branches.total, 0);
  const summedBranchesCovered = input.areas.reduce((s, r) => s + r.branches.covered, 0);
  const summedLinesPct = pct(summedLinesCovered, summedLinesTotal);
  const summedBranchesPct = pct(summedBranchesCovered, summedBranchesTotal);
  lines.push(
    `| **total (summed areas)** | ${summedFiles} | ${summedLinesTotal} | ${summedLinesCovered} | ` +
      `${fmtPct(summedLinesPct)} | ${summedBranchesTotal} | ${summedBranchesCovered} | ${fmtPct(summedBranchesPct)} |`,
  );
  lines.push(
    `| **total (coverage-summary.json)** | — | ${input.summaryTotal.lines.total} | ${input.summaryTotal.lines.covered} | ` +
      `${fmtPct(input.summaryTotal.lines.pct)} | ${input.summaryTotal.branches.total} | ${input.summaryTotal.branches.covered} | ` +
      `${fmtPct(input.summaryTotal.branches.pct)} |`,
  );
  lines.push("");
  const matches = Math.abs(summedLinesPct - input.summaryTotal.lines.pct) < 0.05;
  if (matches) {
    lines.push(
      `Cross-check: the summed area total (${fmtPct(summedLinesPct)}) matches coverage-summary.json's ` +
        `own \`total\` entry (${fmtPct(input.summaryTotal.lines.pct)}) — the seven-bucket mapping is exhaustive.`,
    );
  } else {
    lines.push(
      `**MISMATCH:** the summed area total (${fmtPct(summedLinesPct)}) does NOT equal coverage-summary.json's ` +
        `own \`total\` entry (${fmtPct(input.summaryTotal.lines.pct)}) — the mapping dropped or double-counted a ` +
        `file. Do not trust this table until this is investigated.`,
    );
  }
  lines.push("");

  lines.push("## Table 2 — Coverage per file, sorted by area then ascending line %");
  lines.push("");
  lines.push("| Area | File | Lines % | Branches % |");
  lines.push("|---|---|---|---|");
  for (const row of input.perFile) {
    lines.push(
      `| ${row.area} | \`${row.relPath}\` | ${fmtPct(row.lines.pct)} | ${fmtPct(row.branches.pct)} |`,
    );
  }
  lines.push("");

  lines.push("## Table 3 — Tests per file (D-04)");
  lines.push("");
  lines.push("| File | Tests |");
  lines.push("|---|---|");
  for (const f of input.testCounts.files) {
    lines.push(`| \`${f.relPath}\` | ${f.tests} |`);
  }
  lines.push("");
  lines.push(`files: ${input.testCounts.fileCount}, tests: ${input.testCounts.testCount}`);
  lines.push("");

  return lines.join("\n");
}

// ── Part B: read-only report runner (only executed when run as a script) ──────────────────────

/**
 * `vitest` is a pnpm workspace devDependency, hoisted to the WORKSPACE ROOT's `node_modules/`,
 * never to `apps/api/node_modules/` — so its version must be resolved by walking up from
 * `apiRoot`, exactly like Node's own module resolution would, rather than assumed to sit directly
 * under `apiRoot`.
 */
function resolveVitestVersion(apiRoot: string, repoRoot: string): string {
  for (const candidate of [
    join(apiRoot, "node_modules", "vitest", "package.json"),
    join(repoRoot, "node_modules", "vitest", "package.json"),
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version: string };
      return pkg.version;
    } catch {
      continue;
    }
  }
  throw new Error(
    `measure-context-coverage: could not resolve vitest/package.json under ${apiRoot} or ${repoRoot}.`,
  );
}

async function gatherMeta(apiRoot: string, repoRoot: string): Promise<RenderMeta> {
  const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: apiRoot }).toString().trim();
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: apiRoot })
    .toString()
    .trim();
  const date = new Date().toISOString();
  const nodeVersion = process.version;

  const vitestVersion = resolveVitestVersion(apiRoot, repoRoot);

  // Lazy, run()-only import — never at module load, per the import-safety requirement below.
  const configModule = (await import(pathToFileURL(join(apiRoot, "vitest.config.ts")).href)) as {
    default: {
      test: { coverage: { thresholds: { lines: number; functions: number; branches: number } } };
    };
  };
  const thresholds = configModule.default.test.coverage.thresholds;

  return { headCommit, branch, date, nodeVersion, vitestVersion, thresholds };
}

async function run(): Promise<number> {
  const apiRoot = join(__dirname, "..");
  const repoRoot = join(apiRoot, "..", "..");

  const coveragePath = join(apiRoot, "coverage", "coverage-summary.json");
  const reportPath = join(apiRoot, "vitest-report.json");

  let summary: CoverageSummary;
  try {
    summary = readCoverageSummary(coveragePath);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  let report: VitestJsonReport;
  try {
    report = readJsonFileOrThrow<VitestJsonReport>(
      reportPath,
      "Run `pnpm --filter @clokr/api test:coverage` first (writes vitest-report.json via the json reporter).",
    );
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  let areas: AreaRow[];
  let perFile: PerFileRow[];
  try {
    areas = aggregateByArea(summary, apiRoot);
    perFile = perFileCoverageRows(summary, apiRoot);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const testCounts = readTestCounts(report, apiRoot);
  const meta = await gatherMeta(apiRoot, repoRoot);

  const totalEntry = summary.total;
  const summaryTotal = {
    lines: {
      total: totalEntry.lines.total,
      covered: totalEntry.lines.covered,
      pct: totalEntry.lines.pct,
    },
    branches: {
      total: totalEntry.branches.total,
      covered: totalEntry.branches.covered,
      pct: totalEntry.branches.pct,
    },
  };

  const markdown = renderMarkdown({ areas, perFile, testCounts, summaryTotal, meta });

  const writeIdx = process.argv.indexOf("--write");
  if (writeIdx === -1) {
    console.log(markdown);
    return 0;
  }

  const explicitArg = process.argv[writeIdx + 1];
  const targetPath =
    explicitArg && !explicitArg.startsWith("--")
      ? resolve(process.cwd(), explicitArg)
      : join(repoRoot, "docs", "context-coverage-baseline.md");

  writeFileSync(targetPath, markdown, "utf8");
  console.log(`measure-context-coverage: wrote ${targetPath}`);
  return 0;
}

// Run-guard (#203): importing this module for its exports must never read a file, hit the
// filesystem for a write, or call process.exit — only executing it as `tsx scripts/....ts` does.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run().then((code) => {
    process.exitCode = code;
  });
}
