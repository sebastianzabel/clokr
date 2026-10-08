/**
 * Issue #80 (D-05, 80-AC5, RESEARCH V-2) — the day-break feature never reaches the saldo.
 *
 * The cross-salon § 4 detector and the DayBreak / DayBreakAck models feed exactly the Monatsabschluss
 * GATES (status listing and manual close in `api/overtime.ts`, the automatic close in
 * `plugins/auto-close-month.ts`, the deferred-close reporter). They must never be read by the saldo
 * itself: a day reduces Soll exactly once, and Ist comes from `entryDurations()` over the recorded
 * entries only. A saldo that looked at a day break or an acknowledgement would change a closed
 * month's figures — which are never recalculated (CLAUDE.md § Saldo, Revisionssicherheit).
 *
 * The scan walks every non-test `.ts` file under `contexts/working-time-account/` and parses it with
 * the TypeScript compiler. A forbidden NAME counts when it occurs as an identifier (member access,
 * import name, object key, type name), as a string-literal / bracket access, or as the module
 * specifier of an import of the detector or the day-break modules. Comments are not scanned: prose
 * may explain why the saldo does not read them.
 *
 * Named blind spots: a saldo file that reaches the models through a NEW helper with a different name
 * (a second function in another module that itself reads `dayBreak`) is seen only when that helper
 * lives in the walked tree or carries one of the forbidden names; `apps/api/src/composition/` and
 * `contexts/platform/` are out of scope here (the boundary lint covers cross-context imports).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { describe, it, expect } from "vitest";
import * as ts from "typescript";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const WTA_ROOT = "apps/api/src/contexts/working-time-account";

/** Identifiers (and string literals) the saldo side must never carry. */
const FORBIDDEN_NAMES = new Set([
  "findUnacknowledgedCrossSalonDays",
  "findUnacknowledgedCrossSalonDaysForEmployee",
  "crossSalonCandidateDays",
  "evaluateDayBreaks",
  "dayBreak",
  "dayBreakAck",
]);

/** Module specifiers that name the detector or the day-break modules. */
const FORBIDDEN_SPECIFIER = /(?:^|\/)(?:cross-salon-days|day-break-rule|day-break-store)$/;

/** The only walked files that may reference them — the Monatsabschluss gates. */
const GATE_FILES = [
  `${WTA_ROOT}/api/overtime.ts`,
  `${WTA_ROOT}/plugins/auto-close-month.ts`,
  `${WTA_ROOT}/deferred-month-close.ts`,
];

/** The saldo files: they must be walked AND clean. */
const SALDO_FILES = [
  `${WTA_ROOT}/close-employee-month.ts`,
  `${WTA_ROOT}/month-saldo.ts`,
  `${WTA_ROOT}/overtime-balance.ts`,
  `${WTA_ROOT}/timezone.ts`,
  "apps/api/src/contexts/time-tracking/entry-durations.ts",
];

function repoRel(absPath: string): string {
  return relative(REPO_ROOT, absPath).split("\\").join("/");
}

function walkTs(absDir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(absDir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const abs = join(absDir, entry);
    if (statSync(abs).isDirectory()) walkTs(abs, out);
    else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts")) out.push(abs);
  }
  return out;
}

/** The forbidden names / specifiers a source text carries, by AST. */
function forbiddenReferences(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hits = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && FORBIDDEN_NAMES.has(node.text)) hits.add(node.text);
    if (ts.isStringLiteralLike(node)) {
      if (FORBIDDEN_NAMES.has(node.text)) hits.add(node.text);
      const parent = node.parent;
      if (
        parent &&
        (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
        FORBIDDEN_SPECIFIER.test(node.text)
      ) {
        hits.add(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...hits].sort();
}

describe("Issue #80 (D-05, 80-AC5) — the saldo never sees the day-break feature", () => {
  const walked = walkTs(join(REPO_ROOT, WTA_ROOT));
  const walkedRel = walked.map(repoRel);
  const referencesByFile = new Map(
    walked.map((abs) => [repoRel(abs), forbiddenReferences(abs, readFileSync(abs, "utf8"))]),
  );

  it("the walk sees the tree (a silently-empty walk would pass forever)", () => {
    expect(walked.length, "no file walked under working-time-account at all").toBeGreaterThan(0);
    // Measured 2026-10-08: 30 non-test files under working-time-account; the floor is 20.
    expect(
      walked.length,
      "fewer files walked than the measured floor — the scan root moved or emptied",
    ).toBeGreaterThan(20);
    for (const file of [...GATE_FILES, ...SALDO_FILES.filter((f) => f.startsWith(WTA_ROOT))]) {
      expect(walkedRel, `the walk did not reach ${file}`).toContain(file);
    }
  });

  it("positive control: the detector flags every forbidden shape", () => {
    expect(
      forbiddenReferences(
        "x.ts",
        `import { findUnacknowledgedCrossSalonDays } from "../time-tracking";`,
      ),
    ).toEqual(["findUnacknowledgedCrossSalonDays"]);
    expect(forbiddenReferences("x.ts", `const r = await db.dayBreakAck.findMany({});`)).toEqual([
      "dayBreakAck",
    ]);
    expect(forbiddenReferences("x.ts", `const r = await db["dayBreak"].findMany({});`)).toEqual([
      "dayBreak",
    ]);
    expect(
      forbiddenReferences("x.ts", `import { x } from "../time-tracking/cross-salon-days";`),
    ).toEqual(["../time-tracking/cross-salon-days"]);
    expect(
      forbiddenReferences("x.ts", `// findUnacknowledgedCrossSalonDays and dayBreak in a comment`),
      "comments are deliberately not scanned",
    ).toEqual([]);
  });

  it("only the Monatsabschluss gates reference the detector or the day-break models", () => {
    const offenders = [...referencesByFile.entries()]
      .filter(([file, refs]) => refs.length > 0 && !GATE_FILES.includes(file))
      .map(([file, refs]) => `${file}: ${refs.join(", ")}`);
    expect(
      offenders,
      `the day-break feature leaked outside the month-close gates:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("each gate file really references the detector (the isolation is not an empty set)", () => {
    for (const file of GATE_FILES) {
      expect(
        referencesByFile.get(file) ?? [],
        `${file} no longer references the cross-salon detector — update the gate list`,
      ).not.toEqual([]);
    }
  });

  it("the saldo files contain none of the names", () => {
    for (const file of SALDO_FILES) {
      const refs = forbiddenReferences(file, readFileSync(join(REPO_ROOT, file), "utf8"));
      expect(refs, `${file} references the day-break feature: ${refs.join(", ")}`).toEqual([]);
    }
  });
});
