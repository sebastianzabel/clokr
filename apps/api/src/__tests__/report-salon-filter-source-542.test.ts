/**
 * Issue #542 (CTX-1, P-04) - a salon filter is validated before any read, decides membership in
 * one place, and answers with one 404 body.
 *
 * Why statically: a black-box test cannot see that a person or a figure was READ before the 404
 * was sent. The ordering is therefore pinned in the source: in every registered route region the
 * first `resolveSalonInReach(` call precedes the first read of a person, entry, overtime account or
 * DATEV month. The region is the argument span of the `app.<method>("<path>", ...)` call.
 * Plans 542-02 and 542-03 add their regions to `REGIONS`.
 *
 * Two more pins: every registered region calls `salonViewMemberIds` when it decides membership
 * (the one rule, #542 P-01), and no non-test file of the composition layer other than
 * `salon-view.ts` spells the 404 message as a string literal (comments are trivia to the parser).
 *
 * TypeScript AST on purpose (comments and strings are never calls). Stated blind spot: a read
 * hidden behind a local helper that is itself called before the validation is not seen - the
 * handlers inline their reads.
 *
 * Mutation proofs (each reverted with `cp`, `git diff --quiet` exit 0; red tests measured):
 *   M1 moved the validation after the employee read in `/monthly` -> this file, "validates before
 *      any read and decides membership through salonViewMemberIds" red.
 *   M2 dropped the `countsDay` argument of the sick-day call -> reports-salon-filter-542: "salon A
 *      lists ...", "salon B lists ...", "sums" and "section 9" red.
 *   M3 summed the Ist over every salon -> reports-salon-filter-542: "salon A lists ...", "salon B
 *      lists ..." and "sums" red.
 *   M4 evaluated the membership without the caller's scope (population widened to every tenant
 *      person) -> reports-salon-filter-542 "never widens": "a SALONS-scoped caller's filtered rows
 *      are a subset of its unfiltered rows" red.
 *   M5 counted today in the Ist -> reports-salon-filter-542 "running month": "today never counts
 *      toward the salon Ist" red.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";

// __dirname is apps/api/src/__tests__ - four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const COMPOSITION = "apps/api/src/composition";
const SALON_VIEW = `${COMPOSITION}/salon-view.ts`;
const NOT_FOUND_MESSAGE = "Salon nicht gefunden";

interface RegionEntry {
  file: string;
  method: "get" | "post";
  path: string;
  /** The validator that must run first. */
  validator: string;
  /** The membership function the region must call. */
  membership: string;
}

// 542-02 adds the attendance and team-week regions, 542-03 the overview and the export.
export const REGIONS: readonly RegionEntry[] = [
  {
    file: `${COMPOSITION}/reports.ts`,
    method: "get",
    path: "/monthly",
    validator: "resolveSalonInReach",
    membership: "salonViewMemberIds",
  },
  {
    file: `${COMPOSITION}/dashboard.ts`,
    method: "get",
    path: "/today-attendance",
    validator: "resolveSalonInReach",
    membership: "salonViewMemberIds",
  },
];

/** Reads that must not happen before the validation. */
const READ_CALLEES: ReadonlyArray<RegExp> = [
  /^resolveStammsalonScopedEmployeeIds$/,
  /^scopedTimeEntryIds$/,
  /^getRecordedWorkEntries/,
  /^listOvertimeAccountsForTenant$/,
  /^loadDatevMonth$/,
  /^selectMonthlyExportPersons$/,
  /^app\.prisma\.employee\./,
];

function calleeText(call: ts.CallExpression, sf: ts.SourceFile): string {
  return call.expression.getText(sf);
}

function routeRegion(sf: ts.SourceFile, entry: RegionEntry): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === entry.method &&
      n.arguments.length > 0 &&
      ts.isStringLiteralLike(n.arguments[0]) &&
      n.arguments[0].text === entry.path
    ) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Problems of one region; empty = validated first and decides membership through the one rule. */
export function regionProblems(source: string, entry: RegionEntry): string[] {
  const sf = ts.createSourceFile(entry.file, source, ts.ScriptTarget.Latest, true);
  const label = `${entry.method} ${entry.path}`;
  const region = routeRegion(sf, entry);
  if (!region) return [`${entry.file}: region "${label}" not found - re-register it deliberately`];

  let firstValidator = Number.POSITIVE_INFINITY;
  let firstRead = Number.POSITIVE_INFINITY;
  let firstReadText = "";
  let callsMembership = false;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const text = calleeText(n, sf);
      const last = text.split(".").pop() ?? text;
      const pos = n.getStart(sf);
      if (last === entry.validator && pos < firstValidator) firstValidator = pos;
      if (last === entry.membership) callsMembership = true;
      if (READ_CALLEES.some((re) => re.test(text)) && pos < firstRead) {
        firstRead = pos;
        firstReadText = text;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(region);

  const problems: string[] = [];
  if (firstValidator === Number.POSITIVE_INFINITY) {
    problems.push(`${entry.file}: "${label}" never calls ${entry.validator}`);
  } else if (firstRead < firstValidator) {
    problems.push(
      `${entry.file}: "${label}" reads (${firstReadText}) before ${entry.validator} validates the salon`,
    );
  }
  if (!callsMembership)
    problems.push(`${entry.file}: "${label}" does not call ${entry.membership}`);
  return problems;
}

/** String literals equal to the 404 message, outside comments. */
export function notFoundLiterals(source: string, fileName: string): number {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n) && n.text === NOT_FOUND_MESSAGE) count += 1;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return count;
}

function walk(absDir: string, out: string[]): void {
  for (const entry of readdirSync(absDir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const abs = join(absDir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts")) out.push(abs);
  }
}

/** Every non-test `.ts` file of the composition layer (repo-relative, POSIX separators). */
function compositionFiles(): string[] {
  const out: string[] = [];
  walk(join(REPO_ROOT, COMPOSITION), out);
  return out.map((f) => relative(REPO_ROOT, f).split("\\").join("/"));
}

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

describe("Issue #542 - the pure cores (inline fixtures)", () => {
  const entry: RegionEntry = {
    file: "r.ts",
    method: "get",
    path: "/x",
    validator: "resolveSalonInReach",
    membership: "salonViewMemberIds",
  };

  it("accepts a region that validates first and calls the membership rule", () => {
    const source =
      'app.get("/x", { handler: async () => { const f = await resolveSalonInReach(db); const e = await app.prisma.employee.findMany(); salonViewMemberIds({}); } });';
    expect(regionProblems(source, entry)).toEqual([]);
  });

  it("reports a read before the validation, a missing validator, a missing membership call and a missing region", () => {
    const late =
      'app.get("/x", { handler: async () => { const e = await app.prisma.employee.findMany(); await resolveSalonInReach(db); salonViewMemberIds({}); } });';
    expect(regionProblems(late, entry)).toEqual([
      expect.stringContaining("reads (app.prisma.employee.findMany) before resolveSalonInReach"),
    ]);
    const none = 'app.get("/x", { handler: async () => { salonViewMemberIds({}); } });';
    expect(regionProblems(none, entry)).toEqual([expect.stringContaining("never calls")]);
    const noMembership =
      'app.get("/x", { handler: async () => { await resolveSalonInReach(db); } });';
    expect(regionProblems(noMembership, entry)).toEqual([
      expect.stringContaining("does not call salonViewMemberIds"),
    ]);
    expect(regionProblems("const a = 1;", entry)).toEqual([expect.stringContaining("not found")]);
  });

  it("counts the 404 literal in code but not in a comment", () => {
    expect(notFoundLiterals(`const a = { error: "${NOT_FOUND_MESSAGE}" };`, "x.ts")).toBe(1);
    expect(notFoundLiterals(`// ${NOT_FOUND_MESSAGE}\nconst a = 1;`, "x.ts")).toBe(0);
  });
});

describe("Issue #542 - the composition's salon views", () => {
  for (const entry of REGIONS) {
    it(`${entry.file} ${entry.method} ${entry.path}: validates before any read and decides membership through ${entry.membership}`, () => {
      expect(regionProblems(read(entry.file), entry)).toEqual([]);
    });
  }

  it("walks a non-empty composition layer that contains the registered files", () => {
    const files = compositionFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain(`${COMPOSITION}/reports.ts`);
    expect(files).toContain(SALON_VIEW);
    for (const entry of REGIONS) expect(files).toContain(entry.file);
  });

  it("spells the 404 body once: only salon-view.ts holds the message literal", () => {
    const files = compositionFiles();
    expect(files.length).toBeGreaterThan(0);
    const holders = files.filter((rel) => notFoundLiterals(read(rel), rel) > 0);
    expect(holders).toEqual([SALON_VIEW]);
  });
});
