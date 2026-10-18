/**
 * Issue #81 (D-12, AK-2) — the activity dimension never reaches the saldo or a figure file.
 *
 * The activity kind of a time entry and its minute shares are an evaluation dimension only:
 * Rüst-/Reinigungszeit is full working time (§ 2 Abs. 1 ArbZG), so the working-time account, the
 * report/dashboard/PDF composition, the saldo's entry read (T1) and the § 3/§ 4 day kernel must never
 * read them. If any of those files started to, a classification could move a saldo or a closed month's
 * figures — which are never recalculated (CLAUDE.md § Saldo, Revisionssicherheit).
 *
 * Mirrors `cross-salon-saldo-isolation-80.test.ts` (never imported or edited — its constants are
 * module-private and it runs `describe` on import). Differences: the forbidden set below, NO gate-file
 * allowlist (nothing in the account may reference the dimension), an extra list of protected figure
 * files outside the account, and a control run proving the forbidden names exist in the codebase.
 *
 * The scan parses each file with the TypeScript compiler. A forbidden NAME counts as an identifier
 * (member access, import name, object key, type name) or as a string literal / bracket access; a module
 * specifier counts when an import/export names one of the four activity modules. Comments are not
 * scanned: prose may explain why a file does not read the dimension.
 *
 * Named blind spot: a figure file that reaches the share rows through a NEW helper with an unrelated
 * name in a module outside the walked tree and the protected list is not seen here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { describe, it, expect } from "vitest";
import * as ts from "typescript";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
// Same walk root and saldo files as cross-salon-saldo-isolation-80.test.ts (restated, not imported).
const WTA_ROOT = "apps/api/src/contexts/working-time-account";
const TT_ROOT = "apps/api/src/contexts/time-tracking";

/** Identifiers (and string literals) no saldo or figure file may carry. */
const FORBIDDEN_NAMES = new Set([
  "activityKind",
  "ActivityKind",
  "TimeEntryActivityShare",
  "timeEntryActivityShare",
  "activityShares",
  "activityMinutes",
  "ActivityMinutes",
  "ActivityShareInput",
  "ActivityRow",
  "ACTIVITY_KIND_LABEL",
  "ACTIVITY_SHARE_KINDS",
  "validateActivityState",
  "mergeActivityWrite",
  "activitySharesCreate",
  "activitySharesReplace",
  "isActivityOnlyPut",
  "loadActivityRowsForEntries",
  "materializeRemainder",
]);

/** Module specifiers of the four activity modules. */
const FORBIDDEN_SPECIFIER =
  /(?:^|\/)(?:activity-kind|activity-minutes|activity-shares|activity-store)$/;

/** The saldo files: they must be walked AND clean (same list as test 80). */
const SALDO_FILES = [
  `${WTA_ROOT}/close-employee-month.ts`,
  `${WTA_ROOT}/month-saldo.ts`,
  `${WTA_ROOT}/overtime-balance.ts`,
  `${WTA_ROOT}/timezone.ts`,
];

/** Figure files outside the account: the saldo's entry read, the formula, the day kernel, reports. */
const PROTECTED_FILES = [
  `${TT_ROOT}/facade/time-entries.ts`,
  `${TT_ROOT}/entry-durations.ts`,
  `${TT_ROOT}/arbzg.ts`,
  `${TT_ROOT}/day-break-rule.ts`,
  `${TT_ROOT}/day-break-placement.ts`,
  `${TT_ROOT}/break-finding-days.ts`,
  "apps/api/src/composition/reports.ts",
  "apps/api/src/composition/reports-period.ts", // Issue #612 — the period report is a report figure surface
  "apps/api/src/composition/dashboard.ts",
  "apps/api/src/composition/pdf.ts",
];

/** The activity modules themselves — the control run must find the names there. */
const ACTIVITY_MODULES = [
  `${TT_ROOT}/activity-kind.ts`,
  `${TT_ROOT}/activity-minutes.ts`,
  `${TT_ROOT}/activity-shares.ts`,
  `${TT_ROOT}/activity-store.ts`,
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

function referencesOf(file: string): string[] {
  return forbiddenReferences(file, readFileSync(join(REPO_ROOT, file), "utf8"));
}

describe("Issue #81 (D-12) — the saldo and the figure files never see the activity dimension", () => {
  const walked = walkTs(join(REPO_ROOT, WTA_ROOT));
  const walkedRel = walked.map(repoRel);

  it("the walk sees the tree (a silently-empty walk would pass forever)", () => {
    expect(walked.length, "no file walked under working-time-account at all").toBeGreaterThan(0);
    // Measured 2026-10-11: 30 non-test files under working-time-account; the floor is 20.
    expect(
      walked.length,
      "fewer files walked than the measured floor — the scan root moved or emptied",
    ).toBeGreaterThan(20);
    for (const file of SALDO_FILES) {
      expect(walkedRel, `the walk did not reach ${file}`).toContain(file);
    }
  });

  it("positive control: the detector flags every forbidden shape", () => {
    expect(forbiddenReferences("x.ts", `const k = entry.activityKind;`), "identifier use").toEqual([
      "activityKind",
    ]);
    expect(forbiddenReferences("x.ts", `const f = "activityShares";`), "string literal").toEqual([
      "activityShares",
    ]);
    expect(
      forbiddenReferences("x.ts", `import { x } from "../time-tracking/activity-minutes";`),
      "module specifier",
    ).toEqual(["../time-tracking/activity-minutes"]);
    expect(
      forbiddenReferences("x.ts", `const r = await db["timeEntryActivityShare"].findMany({});`),
      "bracket access",
    ).toEqual(["timeEntryActivityShare"]);
    expect(
      forbiddenReferences("x.ts", `// activityKind and activityMinutes only in a comment`),
      "comments are deliberately not scanned",
    ).toEqual([]);
  });

  it("control run: the activity modules themselves carry the names (the guard watches live names)", () => {
    const seen = new Set<string>();
    for (const file of ACTIVITY_MODULES) {
      const refs = referencesOf(file);
      expect(refs, `${file} carries none of the forbidden names — the list went stale`).not.toEqual(
        [],
      );
      refs.forEach((r) => seen.add(r));
    }
    for (const core of [
      "activityKind",
      "activityMinutes",
      "validateActivityState",
      "ActivityKind",
    ]) {
      expect([...seen], `the core name ${core} no longer exists in the activity modules`).toContain(
        core,
      );
    }
  });

  it("no file of the working-time account references the activity dimension (no allowlist)", () => {
    const offenders = walked
      .map((abs) => [repoRel(abs), forbiddenReferences(abs, readFileSync(abs, "utf8"))] as const)
      .filter(([, refs]) => refs.length > 0)
      .map(([file, refs]) => `${file}: ${refs.join(", ")}`);
    expect(
      offenders,
      `the activity dimension leaked into the working-time account:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no protected figure file references the activity dimension", () => {
    for (const file of PROTECTED_FILES) {
      expect(referencesOf(file), `${file} references the activity dimension`).toEqual([]);
    }
  });
});
