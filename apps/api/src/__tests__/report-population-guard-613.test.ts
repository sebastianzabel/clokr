/**
 * Issue #613 (AC-613-4) - no login state as a person filter in a report, overview or
 * Monatsabschluss query, and every registered reader keeps reading the one population rule.
 *
 * Why: `user.isActive` is a LOGIN state (deactivation, lockout, DSGVO anonymisation flip it); it
 * says nothing about whether a person was employed in a period. The reports used to filter by it
 * and withheld an employee on Elternzeit whose login was off (the #256 case). Since #613 the
 * period population lives once in `contexts/platform/employed-in-period.ts`
 * (`reportPopulationWhere`, DATEV: `employedInPeriodWhere`). This guard keeps a second rule from
 * coming back.
 *
 * What it scans (check A): every non-test `.ts` file under `apps/api/src/composition/` and
 * `apps/api/src/contexts/working-time-account/` (recursive, `__tests__` excluded) plus
 * `apps/api/src/contexts/absence/facade/entitlements.ts`. It flags an `isActive` property nested at
 * any depth under a `user` property inside the object literal that is the value of a `where`
 * property (arrays such as `AND: [...]` included). A `select`/`include` of `user.isActive`, a
 * `salon.isActive` filter, comments and strings are never hits.
 *
 * What it registers (check B): the readers switched by Phase 613. Each entry names a route
 * (`app.<method>(<path literal>, ...)` in a file) or an exported function, the identifiers it must
 * call, and - unless it is the one deliberate exception (the BUrlG carry-over list keeps
 * `exitDate: null` by owner decision) - it must not contain an `exitDate: null` property of its
 * own. A registered reader that moved or stopped calling the rule turns the test red; re-register
 * it deliberately.
 *
 * Exceptions (check A): the auto-close cron and the deferred close select by login state on
 * purpose (owner decision 16.10.2026, D-03: a switch changes WHOM payroll months are closed for
 * and needs its own decision; follow-up #668), and two recipient lookups decide who is TOLD by
 * login state - not a person population of a report. Every exception is dated, reasoned and must
 * match exactly one finding; a finding without an exception, or an exception without a finding,
 * fails.
 *
 * Why the TypeScript AST and not a regex: a comment or a string mentioning the text is trivia or a
 * token to the parser, never a property. Stated blind spots: a filter assembled from a variable or
 * a spread (for example `...compatRoleUserWhere(...)`) is not a literal and is not seen; a `where`
 * held in a variable is not seen. Review, not this test, has to catch a creative workaround.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";

// __dirname is apps/api/src/__tests__ - four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SCOPE_ROOTS = [
  "apps/api/src/composition",
  "apps/api/src/contexts/working-time-account",
] as const;
const SCOPE_FILES = ["apps/api/src/contexts/absence/facade/entitlements.ts"] as const;
// Floor for the walked file count (measured at the end of Phase 613: 42 files).
const MIN_WALKED_FILES = 30;

// ── Check A: login state as a person filter ─────────────────────────────────────────────────────

interface LoginFilterFinding {
  file: string;
  line: number;
}

function propertyName(p: ts.ObjectLiteralElementLike): string | undefined {
  if (!p.name) return undefined;
  return ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
}

function unwrapExpr(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** Every `isActive` under a `user` property inside the value of a `where` property. */
function findLoginStateFilters(source: string, fileName: string): LoginFilterFinding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const scan = (node: ts.Expression, underUser: boolean): void => {
    const n = unwrapExpr(node);
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        if (ts.isShorthandPropertyAssignment(p)) {
          if (underUser && p.name.text === "isActive") lines.add(lineOf(p));
          continue;
        }
        if (!ts.isPropertyAssignment(p)) continue; // spreads and methods: stated blind spot
        const name = propertyName(p);
        if (underUser && name === "isActive") lines.add(lineOf(p));
        scan(p.initializer, underUser || name === "user");
      }
    } else if (ts.isArrayLiteralExpression(n)) {
      for (const el of n.elements) scan(el, underUser);
    }
  };

  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && propertyName(n) === "where") scan(n.initializer, false);
    ts.forEachChild(n, visit);
  };
  visit(sf);

  return [...lines].sort((a, b) => a - b).map((line) => ({ file: fileName, line }));
}

interface LoginFilterException {
  file: string;
  /** Text that must occur on the finding's line; with `file` it identifies exactly one finding. */
  anchor: string;
  kind: "D-03" | "recipient lookup";
  since: string;
  /** The follow-up issue a D-03 exception is tied to. */
  issue?: string;
  reason: string;
}

/** Pairs findings with exceptions; both leftovers are failures. */
function matchExceptions(
  findings: Array<LoginFilterFinding & { text: string }>,
  exceptions: readonly LoginFilterException[],
): {
  unexcepted: Array<LoginFilterFinding & { text: string }>;
  unresolved: LoginFilterException[];
  ambiguous: LoginFilterException[];
} {
  const matched = new Set<LoginFilterFinding & { text: string }>();
  const unresolved: LoginFilterException[] = [];
  const ambiguous: LoginFilterException[] = [];
  for (const ex of exceptions) {
    const hits = findings.filter((f) => f.file === ex.file && f.text.includes(ex.anchor));
    if (hits.length === 0) unresolved.push(ex);
    else if (hits.length > 1) ambiguous.push(ex);
    else matched.add(hits[0]);
  }
  return { unexcepted: findings.filter((f) => !matched.has(f)), unresolved, ambiguous };
}

// The register. Dates are the day the owner decision / the guard was written.
const LOGIN_FILTER_EXCEPTIONS: readonly LoginFilterException[] = [
  {
    file: "apps/api/src/contexts/working-time-account/plugins/auto-close-month.ts",
    anchor: "user: { isActive: true },",
    kind: "D-03",
    since: "2026-10-16",
    issue: "#668",
    reason:
      "Owner decision 16.10.2026 (D-03): the auto-close cron keeps selecting by login state; whom " +
      "payroll months are closed for is a write-path behaviour change with its own decision. " +
      "Measured by scripts/audit-613-month-close-population.ts.",
  },
  {
    file: "apps/api/src/contexts/working-time-account/deferred-month-close.ts",
    anchor: "user: { isActive: true },",
    kind: "D-03",
    since: "2026-10-16",
    issue: "#668",
    reason:
      "Owner decision 16.10.2026 (D-03): the deferred close keeps the cron's population (parity " +
      "with auto-close-month.ts) until the follow-up switches both.",
  },
  {
    file: "apps/api/src/contexts/working-time-account/plugins/auto-close-month.ts",
    anchor: "user: { isActive: true, id: { in: scopedMonthCloseCloseHolderIds } },",
    kind: "recipient lookup",
    since: "2026-10-16",
    reason:
      "Who is told about a closed month is decided by login state: a person who cannot sign in " +
      "cannot read the notice. This is a recipient lookup, not a person population of a report.",
  },
  {
    file: "apps/api/src/contexts/working-time-account/plugins/deferred-month-close-reminder.ts",
    anchor: "user: { isActive: true, id: { in: scopedMonthCloseCloseHolderIds } },",
    kind: "recipient lookup",
    since: "2026-10-16",
    reason:
      "Recipients of the deferred-close reminder are limited to persons who can sign in; a " +
      "recipient lookup, not a person population of a report.",
  },
];

// ── Check B: registered readers read the rule ───────────────────────────────────────────────────

interface ReaderEntry {
  file: string;
  /** `route` = `app.<method>("<path>", ...)`; `function` = an exported function declaration. */
  kind: "route" | "function";
  method?: "get" | "post" | "put" | "patch" | "delete";
  name: string;
  /** Identifiers the reader must call (every one). */
  calls: string[];
  /** The one deliberate `exitDate: null` (BUrlG carry-over rule, orchestrator decision W2). */
  allowExitNull?: string;
}

function readerRegion(sf: ts.SourceFile, entry: ReaderEntry): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (entry.kind === "route") {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === entry.method &&
        n.arguments.length > 0 &&
        ts.isStringLiteralLike(n.arguments[0]) &&
        n.arguments[0].text === entry.name
      ) {
        found = n;
        return;
      }
    } else if (ts.isFunctionDeclaration(n) && n.name?.text === entry.name) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** The problems of one registered reader; empty = it reads the rule and nothing of its own. */
function readerProblems(source: string, entry: ReaderEntry): string[] {
  const sf = ts.createSourceFile(entry.file, source, ts.ScriptTarget.Latest, true);
  const label = entry.kind === "route" ? `${entry.method} ${entry.name}` : `function ${entry.name}`;
  const region = readerRegion(sf, entry);
  if (!region) return [`${entry.file}: reader "${label}" not found - re-register it deliberately`];

  const problems: string[] = [];
  const called = new Set<string>();
  let inlineExitNull = false;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee)) called.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) called.add(callee.name.text);
    }
    if (ts.isIdentifier(n)) called.add(n.text); // a spread such as ...NOT_ANONYMIZED_EMPLOYEE_WHERE
    if (
      ts.isPropertyAssignment(n) &&
      propertyName(n) === "exitDate" &&
      n.initializer.kind === ts.SyntaxKind.NullKeyword
    ) {
      inlineExitNull = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(region);

  for (const id of entry.calls) {
    if (!called.has(id)) problems.push(`${entry.file}: reader "${label}" does not use ${id}`);
  }
  if (inlineExitNull && entry.allowExitNull === undefined) {
    problems.push(`${entry.file}: reader "${label}" filters exitDate: null itself`);
  }
  return problems;
}

const REPORTS = "apps/api/src/composition/reports.ts";
const REPORTS_PERIOD = "apps/api/src/composition/reports-period.ts"; // Issue #612
const DASHBOARD = "apps/api/src/composition/dashboard.ts";
const OVERTIME = "apps/api/src/contexts/working-time-account/api/overtime.ts";
const route = (
  file: string,
  name: string,
  calls: string[],
  method: ReaderEntry["method"] = "get",
): ReaderEntry => ({ file, kind: "route", method, name, calls });

// The readers switched by Phase 613 (613-01 ... 613-05), measured on the branch.
const READERS: readonly ReaderEntry[] = [
  route(REPORTS, "/monthly", ["reportPopulationWhere"]),
  route(REPORTS, "/monthly/pdf", ["reportPopulationWhere"]),
  route(REPORTS, "/leave-overview", ["reportPopulationWhere", "listEntitlementsForYear"]),
  route(REPORTS, "/carryover-at-risk", ["getExpiringCarryOver"]),
  // Issue #617: DATEV and the Monatsexport read their persons through ONE module-private loader
  // (`loadDatevMonth`); the export reaches it only through its one selection function, so the
  // employment core is spelled once and the registered readers follow the call chain.
  route(REPORTS, "/datev", ["loadDatevMonth"]),
  route(REPORTS, "/monthly-export/pdf", ["selectMonthlyExportPersons"]),
  {
    file: REPORTS,
    kind: "function",
    name: "loadDatevMonth",
    calls: ["employedInPeriodWhere"],
  },
  {
    file: REPORTS,
    kind: "function",
    name: "selectMonthlyExportPersons",
    calls: ["loadDatevMonth"],
  },
  route(REPORTS, "/datev/employee", ["employedInPeriodWhere"]),
  // Issue #612: the period report reads the population of EVERY month it lists through its one
  // module-private assembly, which spells the rule once.
  route(REPORTS_PERIOD, "/period", ["assemblePeriodReport"]),
  {
    file: REPORTS_PERIOD,
    kind: "function",
    name: "assemblePeriodReport",
    calls: ["reportPopulationWhere"],
  },
  route(OVERTIME, "/close-month/status", ["reportPopulationWhere"]),
  route(OVERTIME, "/close-month/year-status", ["reportPopulationWhere"]),
  route(DASHBOARD, "/team-week", ["reportPopulationWhere"]),
  route(DASHBOARD, "/today-attendance", ["reportPopulationWhere"]),
  route(DASHBOARD, "/team-trend", ["reportPopulationWhere"]),
  route(DASHBOARD, "/overtime-trend", ["reportPopulationWhere"]),
  route(DASHBOARD, "/overtime-overview", ["listOvertimeAccountsForTenant", "isEmployedInPeriod"]),
  {
    file: "apps/api/src/contexts/working-time-account/facade/overtime-account.ts",
    kind: "function",
    name: "listOvertimeAccountsForTenant",
    calls: ["reportPopulationWhere"],
  },
  {
    file: "apps/api/src/contexts/absence/facade/entitlements.ts",
    kind: "function",
    name: "listEntitlementsForYear",
    calls: ["reportPopulationWhere"],
  },
  {
    file: "apps/api/src/contexts/absence/facade/entitlements.ts",
    kind: "function",
    name: "getExpiringCarryOver",
    calls: ["NOT_ANONYMIZED_EMPLOYEE_WHERE"],
    allowExitNull:
      "BUrlG carry-over rule (orchestrator decision W2): the warning list keeps exitDate: null " +
      "and only gains the DSGVO anonymisation sentinel; the open question is the follow-up #668.",
  },
];

// ── Walk ────────────────────────────────────────────────────────────────────────────────────────

function repoRel(absPath: string): string {
  return relative(REPO_ROOT, absPath).split("\\").join("/");
}

function walkRoot(absDir: string, out: string[]): void {
  for (const entry of readdirSync(absDir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const abs = join(absDir, entry);
    if (statSync(abs).isDirectory()) walkRoot(abs, out);
    else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts")) out.push(abs);
  }
}

function collectFiles(): { all: string[]; perRoot: Record<string, number> } {
  const all: string[] = [];
  const perRoot: Record<string, number> = {};
  for (const root of SCOPE_ROOTS) {
    const out: string[] = [];
    walkRoot(join(REPO_ROOT, root), out);
    perRoot[root] = out.length;
    all.push(...out);
  }
  for (const rel of SCOPE_FILES) all.push(join(REPO_ROOT, rel));
  return { all, perRoot };
}

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

// ── Tests ───────────────────────────────────────────────────────────────────────────────────────

describe("Issue #613 (AC-613-4) - the pure cores (inline fixtures)", () => {
  it("flags isActive under a user property inside a where, at any depth and inside AND arrays", () => {
    const source = [
      "const a = await db.employee.findMany({ where: { tenantId, user: { isActive: true } } });",
      "const b = await db.employee.findMany({ where: { employee: { user: { isActive: true } } } });",
      "const c = await db.employee.findMany({ where: { AND: [{ tenantId }, { user: { is: { isActive } } }] } });",
    ].join("\n");
    expect(findLoginStateFilters(source, "x.ts").map((f) => f.line)).toEqual([1, 2, 3]);
  });

  it("does not flag a salon filter, a select/include, a comment or a string", () => {
    const source = [
      "const a = await db.x.findMany({ where: { salon: { isActive: true } } });",
      "const b = await db.employee.findMany({ select: { user: { select: { isActive: true } } } });",
      "const c = await db.employee.findMany({ include: { user: { select: { isActive: true } } } });",
      "// where: { user: { isActive: true } }",
      'const d = "where: { user: { isActive: true } }";',
      "const e = await db.employee.findMany({ where: { tenantId, hireDate: { lte: end } } });",
    ].join("\n");
    expect(findLoginStateFilters(source, "x.ts")).toEqual([]);
  });

  it("pairs findings with exceptions and reports both leftovers", () => {
    const finding = { file: "a.ts", line: 3, text: "user: { isActive: true }," };
    const ok: LoginFilterException = {
      file: "a.ts",
      anchor: "user: { isActive: true },",
      kind: "D-03",
      since: "2026-10-16",
      issue: "#668",
      reason: "r",
    };
    expect(matchExceptions([finding], [ok])).toEqual({
      unexcepted: [],
      unresolved: [],
      ambiguous: [],
    });
    const stale = { ...ok, anchor: "user: { isActive: false }," };
    const result = matchExceptions([finding], [stale]);
    expect(result.unresolved).toEqual([stale]);
    expect(result.unexcepted).toEqual([finding]);
    const twin = { ...finding, line: 9 };
    expect(matchExceptions([finding, twin], [ok]).ambiguous).toEqual([ok]);
  });

  const entry: ReaderEntry = {
    file: "r.ts",
    kind: "route",
    method: "get",
    name: "/x",
    calls: ["reportPopulationWhere"],
  };

  it("accepts a reader that calls the rule and nothing of its own", () => {
    const source =
      'app.get("/x", { handler: async () => { const w = reportPopulationWhere(a, b); } });';
    expect(readerProblems(source, entry)).toEqual([]);
  });

  it("reports a reader that does not call the rule, one that filters exitDate: null itself, and a missing reader", () => {
    const noRule = 'app.get("/x", { handler: async () => { const w = {}; } });';
    expect(readerProblems(noRule, entry)).toEqual([
      'r.ts: reader "get /x" does not use reportPopulationWhere',
    ]);
    const inline =
      'app.get("/x", { handler: async () => { reportPopulationWhere(a, b); const w = { exitDate: null }; } });';
    expect(readerProblems(inline, entry)).toEqual([
      'r.ts: reader "get /x" filters exitDate: null itself',
    ]);
    expect(readerProblems(inline, { ...entry, allowExitNull: "documented" })).toEqual([]);
    expect(readerProblems("const nothing = 1;", entry)[0]).toContain("not found");
    // A comment mentioning the identifiers is not a call.
    const commentOnly =
      'app.get("/x", { handler: async () => { /* reportPopulationWhere(a, b) */ } });';
    expect(readerProblems(commentOnly, entry)).toHaveLength(1);
  });
});

describe("Issue #613 (AC-613-4) - the real tree", () => {
  it("walk sees the scope (a silently-empty walk would pass forever)", () => {
    const { all, perRoot } = collectFiles();
    expect(
      all.length,
      `walked ${all.length} file(s) - fewer than the measured floor of ${MIN_WALKED_FILES}`,
    ).toBeGreaterThanOrEqual(MIN_WALKED_FILES);
    for (const root of SCOPE_ROOTS) {
      expect(perRoot[root], `scope root ${root} contributed no file`).toBeGreaterThan(0);
    }
    const rels = all.map(repoRel);
    for (const entry of READERS) expect(rels).toContain(entry.file);
    for (const rel of rels) expect(statSync(join(REPO_ROOT, rel)).size).toBeGreaterThan(0);
  });

  it("every exception is dated, reasoned and (D-03) tied to the follow-up issue", () => {
    expect(LOGIN_FILTER_EXCEPTIONS.length).toBeGreaterThan(0);
    for (const ex of LOGIN_FILTER_EXCEPTIONS) {
      expect(ex.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(ex.reason.length).toBeGreaterThanOrEqual(40);
      if (ex.kind === "D-03") expect(ex.issue).toMatch(/^#\d+$/);
    }
  });

  it("check A: no login state as a person filter outside the registered exceptions", () => {
    const { all } = collectFiles();
    const findings: Array<LoginFilterFinding & { text: string }> = [];
    for (const abs of all) {
      const rel = repoRel(abs);
      const source = readFileSync(abs, "utf8");
      const lines = source.split("\n");
      for (const f of findLoginStateFilters(source, rel)) {
        findings.push({ ...f, text: lines[f.line - 1].trim() });
      }
    }
    const { unexcepted, unresolved, ambiguous } = matchExceptions(
      findings,
      LOGIN_FILTER_EXCEPTIONS,
    );
    expect(
      unexcepted.map((f) => `${f.file}:${f.line} ${f.text}`),
      "user.isActive used as a person filter - select by employment (reportPopulationWhere)",
    ).toEqual([]);
    expect(
      unresolved.map((e) => `${e.file} ${e.anchor}`),
      "an exception no longer resolves to a finding - remove or re-anchor it",
    ).toEqual([]);
    expect(
      ambiguous.map((e) => `${e.file} ${e.anchor}`),
      "an exception matches more than one finding - make its anchor unique",
    ).toEqual([]);
    // The measured register: exactly the four owner-deferred / recipient sites.
    expect(findings).toHaveLength(LOGIN_FILTER_EXCEPTIONS.length);
  });

  it("check B: every registered reader reads the rule and filters nothing of its own", () => {
    expect(READERS.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const entry of READERS) problems.push(...readerProblems(read(entry.file), entry));
    expect(problems).toEqual([]);
  });
});
