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
 *   542-03 (recorded in dashboard-salon-filter-542 and monthly-export-salon-filter-542): an account
 *      read before the overview validation -> "get /overtime-overview: ..." red; an employee read
 *      before the export's validation -> "function selectMonthlyExportPersons: ..." red; the
 *      narrowing handed to the DATEV loader -> "reports.ts: DATEV is never narrowed ..." red.
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
  /** The route path, or - with `kind: "function"` - the name of a function declaration. */
  path: string;
  /** Default "route": the argument span of `app.<method>(path, ...)`. */
  kind?: "route" | "function";
  /** The validator that must run first. */
  validator: string;
  /** The membership function the region must call. */
  membership: string;
  /**
   * How often the validator must be called before the first read (default 1). The Saldenübersicht
   * lists only persons inside two reaches, so it validates against both (P-04).
   */
  validatorCalls?: number;
}

// 542-02 added the attendance and team-week regions; 542-03 adds the overview and the export
// (the export's membership is `salonPersonsAtStichtag`, the Stammsalon rule of the export).
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
  {
    file: `${COMPOSITION}/dashboard.ts`,
    method: "get",
    path: "/team-week",
    validator: "resolveSalonInReach",
    membership: "salonViewMemberIds",
  },
  // 542-03: the persons of the Saldenübersicht follow the Stammsalon (salon-only reach), each row
  // stays whole; the salon is validated against the team-overview AND the overtime reach.
  {
    file: `${COMPOSITION}/dashboard.ts`,
    method: "get",
    path: "/overtime-overview",
    validator: "resolveSalonInReach",
    membership: "salonOnlyReach",
    validatorCalls: 2,
  },
  // 542-03: the Monatsexport narrows WHO is listed inside its one person selection, after the
  // salon was validated against the report:export reach and before the DATEV loader reads a person.
  {
    file: `${COMPOSITION}/reports.ts`,
    method: "get",
    path: "selectMonthlyExportPersons",
    kind: "function",
    validator: "resolveSalonInReach",
    membership: "salonPersonsAtStichtag",
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
  /^salonPersonsAtStichtag$/,
  /^findSalon$/,
  /^app\.prisma\.employee\./,
];

function calleeText(call: ts.CallExpression, sf: ts.SourceFile): string {
  return call.expression.getText(sf);
}

function routeRegion(sf: ts.SourceFile, entry: RegionEntry): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (entry.kind === "function") {
      if (ts.isFunctionDeclaration(n) && n.name?.text === entry.path) {
        found = n;
        return;
      }
      ts.forEachChild(n, visit);
      return;
    }
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
  const label =
    entry.kind === "function" ? `function ${entry.path}` : `${entry.method} ${entry.path}`;
  const region = routeRegion(sf, entry);
  if (!region) return [`${entry.file}: region "${label}" not found - re-register it deliberately`];

  let firstValidator = Number.POSITIVE_INFINITY;
  const validatorPositions: number[] = [];
  let firstRead = Number.POSITIVE_INFINITY;
  let firstReadText = "";
  let callsMembership = false;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const text = calleeText(n, sf);
      const last = text.split(".").pop() ?? text;
      const pos = n.getStart(sf);
      if (last === entry.validator) validatorPositions.push(pos);
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
  } else {
    // The N-th validator call is the one that completes the validation.
    const needed = entry.validatorCalls ?? 1;
    if (validatorPositions.length < needed) {
      problems.push(
        `${entry.file}: "${label}" calls ${entry.validator} ${validatorPositions.length} time(s), needs ${needed}`,
      );
    } else {
      const validated = [...validatorPositions].sort((x, y) => x - y)[needed - 1];
      if (firstRead < validated) {
        problems.push(
          `${entry.file}: "${label}" reads (${firstReadText}) before ${entry.validator} validates the salon`,
        );
      }
    }
  }
  if (!callsMembership)
    problems.push(`${entry.file}: "${label}" does not call ${entry.membership}`);
  return problems;
}

/**
 * Issue #542 (OD-2, CTX-1, T-542-15): DATEV is never narrowed. The `/datev` route region names no
 * `salonId` and its `loadDatevMonth` call passes no option (no `onlyEmployeeIds`, no `reach`, no
 * third argument beyond request, year and month). Problems of the region; empty = untouched.
 */
export function datevRegionProblems(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const entry: RegionEntry = {
    file: fileName,
    method: "get",
    path: "/datev",
    validator: "",
    membership: "",
  };
  const region = routeRegion(sf, entry);
  if (!region) return [`${fileName}: region "get /datev" not found - re-register it deliberately`];
  const problems: string[] = [];
  let loaderCalls = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && ["salonId", "onlyEmployeeIds", "reach"].includes(n.text)) {
      problems.push(`${fileName}: the /datev region names "${n.text}"`);
    }
    if (ts.isCallExpression(n) && calleeText(n, sf) === "loadDatevMonth") {
      loaderCalls += 1;
      if (n.arguments.length !== 4) {
        problems.push(
          `${fileName}: the /datev loadDatevMonth call has ${n.arguments.length} arguments, expected app, req, y, m`,
        );
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(region);
  if (loaderCalls !== 1)
    problems.push(`${fileName}: expected one loadDatevMonth call, found ${loaderCalls}`);
  return problems;
}

/**
 * The export route hands the chosen salon to the one person selection: its
 * `selectMonthlyExportPersons` call has a fifth argument that is the identifier `salonId`.
 */
export function exportRouteProblems(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const region = routeRegion(sf, {
    file: fileName,
    method: "get",
    path: "/monthly-export/pdf",
    validator: "",
    membership: "",
  });
  if (!region) return [`${fileName}: region "get /monthly-export/pdf" not found`];
  let passes = false;
  let calls = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && calleeText(n, sf) === "selectMonthlyExportPersons") {
      calls += 1;
      const fifth = n.arguments[4];
      if (fifth && ts.isIdentifier(fifth) && fifth.text === "salonId") passes = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(region);
  const problems: string[] = [];
  if (calls !== 1)
    problems.push(`${fileName}: expected one selectMonthlyExportPersons call, found ${calls}`);
  if (!passes)
    problems.push(
      `${fileName}: the export route does not pass salonId to selectMonthlyExportPersons`,
    );
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

  it("with validatorCalls 2 a read between the first and the second validation is reported", () => {
    const two: RegionEntry = { ...entry, validatorCalls: 2 };
    const ok =
      'app.get("/x", { handler: async () => { await resolveSalonInReach(a); await resolveSalonInReach(b); await app.prisma.employee.findMany(); salonViewMemberIds({}); } });';
    expect(regionProblems(ok, two)).toEqual([]);
    const between =
      'app.get("/x", { handler: async () => { await resolveSalonInReach(a); await app.prisma.employee.findMany(); await resolveSalonInReach(b); salonViewMemberIds({}); } });';
    expect(regionProblems(between, two)).toEqual([
      expect.stringContaining("reads (app.prisma.employee.findMany) before resolveSalonInReach"),
    ]);
    const once =
      'app.get("/x", { handler: async () => { await resolveSalonInReach(a); salonViewMemberIds({}); } });';
    expect(regionProblems(once, two)).toEqual([expect.stringContaining("needs 2")]);
  });

  it("finds a function region by name and checks the validation inside it", () => {
    const fn: RegionEntry = { ...entry, path: "pick", kind: "function", membership: "members" };
    const ok =
      "async function pick() { await resolveSalonInReach(db); await app.prisma.employee.findMany(); members(); }";
    expect(regionProblems(ok, fn)).toEqual([]);
    const late =
      "async function pick() { await app.prisma.employee.findMany(); await resolveSalonInReach(db); members(); }";
    expect(regionProblems(late, fn)).toEqual([expect.stringContaining("reads (app.prisma")]);
    expect(regionProblems("async function other() {}", fn)).toEqual([
      expect.stringContaining("not found"),
    ]);
  });

  it("flags a /datev region that names a salon or passes an option to the loader", () => {
    const clean =
      'app.get("/datev", { handler: async () => { await loadDatevMonth(app, req, y, m); } });';
    expect(datevRegionProblems(clean, "r.ts")).toEqual([]);
    const withSalon =
      'app.get("/datev", { handler: async () => { const { salonId } = q; await loadDatevMonth(app, req, y, m); } });';
    expect(datevRegionProblems(withSalon, "r.ts")).toEqual([expect.stringContaining('"salonId"')]);
    const withOption =
      'app.get("/datev", { handler: async () => { await loadDatevMonth(app, req, y, m, { onlyEmployeeIds: ids }); } });';
    expect(datevRegionProblems(withOption, "r.ts").length).toBeGreaterThan(0);
    expect(datevRegionProblems("const a = 1;", "r.ts")).toEqual([
      expect.stringContaining("not found"),
    ]);
  });

  it("flags an export route that does not hand the salon to the person selection", () => {
    const ok =
      'app.get("/monthly-export/pdf", { handler: async () => { await selectMonthlyExportPersons(app, req, y, m, salonId); } });';
    expect(exportRouteProblems(ok, "r.ts")).toEqual([]);
    const missing =
      'app.get("/monthly-export/pdf", { handler: async () => { await selectMonthlyExportPersons(app, req, y, m); } });';
    expect(exportRouteProblems(missing, "r.ts")).toEqual([
      expect.stringContaining("does not pass salonId"),
    ]);
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

  it("reports.ts: DATEV is never narrowed and the export route hands the salon to the selection", () => {
    const source = read(`${COMPOSITION}/reports.ts`);
    expect(datevRegionProblems(source, `${COMPOSITION}/reports.ts`)).toEqual([]);
    expect(exportRouteProblems(source, `${COMPOSITION}/reports.ts`)).toEqual([]);
  });

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
