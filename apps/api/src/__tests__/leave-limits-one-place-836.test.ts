/**
 * Issue #836 (AC-3, T-836-24) - parallel leave is counted in ONE place.
 *
 * `parallelLeaveLoad()` (`contexts/absence/leave-limits/parallel-leave-load.ts`) is the pure kernel that
 * folds person-days into a load per salon x group x day; `evaluateLeaveLimits()` (`check.ts`) and
 * `leaveLimitLoadView()` (`load-view.ts`) are its only two callers, and the request create, the approval
 * and the correction (`contexts/absence/api/leave.ts`) are the only callers of the checker. This guard
 * keeps a second count of "who is on leave in a salon on a day" from growing anywhere else - in the
 * dashboard, a report, the shift planning - where it would drift from the warning the approver sees.
 *
 * What it checks (AST, comments and strings excluded; every non-test `.ts` file under `apps/api/src`):
 *   1. `parallelLeaveLoad` is declared only in `parallel-leave-load.ts` and called only in `check.ts`
 *      and `load-view.ts` (both of them, so the load view cannot grow its own fold).
 *   2. `evaluateLeaveLimits` is called exactly at the three registered sites (`post /requests` and
 *      `patch /requests/:id/correct` in `api/leave.ts`, the approval in `decidePendingLeaveRequest` of
 *      `leave-decision.ts`); a register entry without a matching site is red too. Issue #835
 *      (D-835-28): the approval check moved out of `patch /requests/:id/review` into
 *      `leave-decision.ts`; the assertion is unchanged.
 *   3. The allow-list identifier `LEAVE_LIMIT_COUNTED_CODES` and any `.leaveLimitRule` property access
 *      (the rule delegate) occur only under `contexts/absence/leave-limits/` and in
 *      `contexts/absence/api/leave-limits.ts`.
 *   4. The `homeSalonsForDays` call sites outside `contexts/absence/leave-limits/` are exactly the
 *      MEASURED register below (file, region, reason): a new leave-count caller that combines the
 *      Stammsalon per day with leave rows turns red and has to be reported, not added.
 *   5. The walked set has a floor (`MIN_WALKED_FILES`) and contains the module files, so a moved or
 *      emptied directory turns the guard red instead of green over nothing.
 *   6. Positive control: the checker run over the real tree PLUS a synthetic source with a second
 *      `parallelLeaveLoad(` call, a stray `evaluateLeaveLimits(` and a `.leaveLimitRule` access reports
 *      all three, and the real tree alone reports none.
 *
 * Stated blind spot: an aliased import (`import { parallelLeaveLoad as plain }`), a call through a
 * variable or a destructured delegate (`const { leaveLimitRule } = prisma`) is not seen, and neither
 * is a re-implementation of the fold that never names these identifiers. Review has to catch a
 * creative workaround.
 *
 * Mutation proof (Phase 836, 2026-11-06) - recorded, not re-run by CI; the scratch file was removed afterwards:
 * M1 a scratch file `src/composition/scratch-836.ts` calling `parallelLeaveLoad([])` -> red: "declares
 *    parallelLeaveLoad in the kernel file and calls it only in check.ts and load-view.ts" and "the real
 *    tree has no violation" (2 failed | 5 passed).
 * M2 a scratch `evaluateLeaveLimits(` call in the same scratch file -> red: "evaluateLeaveLimits is
 *    called exactly at the three registered sites of api/leave.ts" and "the real tree has no violation".
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";

// __dirname is apps/api/src/__tests__.
const SRC_ROOT = join(__dirname, "..");
const MODULE_DIR = "contexts/absence/leave-limits/";
const ROUTE_FILE = "contexts/absence/api/leave-limits.ts";
const LEAVE_ROUTES = "contexts/absence/api/leave.ts";
const DECISION_FILE = "contexts/absence/leave-decision.ts";
const KERNEL_FILE = `${MODULE_DIR}parallel-leave-load.ts`;
const KERNEL_CALLERS = [`${MODULE_DIR}check.ts`, `${MODULE_DIR}load-view.ts`];
// Floor for the walked file count (measured 313 non-test files on 2026-11-06).
const MIN_WALKED_FILES = 200;

interface Facts {
  file: string;
  /** Calls of watched callees with the region they sit in. */
  calls: Array<{ callee: string; region: string }>;
  /** Names of function declarations. */
  declarations: string[];
  /** Occurrences of the watched identifiers. */
  identifiers: string[];
  /** Property accesses `.leaveLimitRule`. */
  delegateAccesses: number;
}

const WATCHED_CALLEES = new Set(["parallelLeaveLoad", "evaluateLeaveLimits", "homeSalonsForDays"]);

/** `get /path` inside `app.get("/path", ...)`, else the enclosing function declaration. */
function regionOf(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ["get", "post", "put", "patch", "delete"].includes(n.expression.name.text) &&
      n.arguments.length > 0 &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      return `${n.expression.name.text} ${n.arguments[0].text}`;
    }
    if (ts.isFunctionDeclaration(n) && n.name) return `function ${n.name.text}`;
  }
  return "<module>";
}

function scan(source: string, file: string): Facts {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const facts: Facts = { file, calls: [], declarations: [], identifiers: [], delegateAccesses: 0 };
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name) facts.declarations.push(n.name.text);
    if (ts.isIdentifier(n) && n.text === "LEAVE_LIMIT_COUNTED_CODES") {
      facts.identifiers.push(n.text);
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === "leaveLimitRule") {
      facts.delegateAccesses += 1;
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name !== null && WATCHED_CALLEES.has(name)) {
        facts.calls.push({ callee: name, region: regionOf(n) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return facts;
}

function walk(absDir: string, out: string[]): void {
  for (const entry of readdirSync(absDir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const abs = join(absDir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      out.push(abs);
    }
  }
}

function measure(): Facts[] {
  const abs: string[] = [];
  walk(SRC_ROOT, abs);
  return abs.map((a) => scan(readFileSync(a, "utf8"), relative(SRC_ROOT, a).split("\\").join("/")));
}

// The three places a limit is checked (D-836-09/19): the request create, the approval, the correction.
const CHECK_SITES = [
  `${LEAVE_ROUTES} | post /requests | evaluateLeaveLimits`,
  `${DECISION_FILE} | function decidePendingLeaveRequest | evaluateLeaveLimits`,
  `${LEAVE_ROUTES} | patch /requests/:id/correct | evaluateLeaveLimits`,
];

interface HomeSalonCaller {
  file: string;
  region: string;
  reason: string;
}

// MEASURED on 2026-11-06 (Issue #836): every call of `homeSalonsForDays` outside the leave-limits
// module. None of them counts parallel leave per salon and day; each attributes a person, a leave row
// or a presence to the Stammsalon of a day for its own purpose. A new entry is a finding to report.
const HOME_SALON_REGISTER: readonly HomeSalonCaller[] = [
  {
    file: "composition/dashboard.ts",
    region: "get /team-trend",
    reason: "attributes the team trend's persons and absences to a salon filter (Issue #84, D-13)",
  },
  {
    file: "composition/dashboard.ts",
    region: "get /team-week",
    reason: "attributes the team week's rows to a salon filter (Issue #84, #558)",
  },
  {
    file: "composition/dashboard.ts",
    region: "get /today-attendance",
    reason: "the Stammsalon population of today's attendance list (Issue #542)",
  },
  {
    file: "composition/operator-support-ports.ts",
    region: "function listEmployees",
    reason:
      "names each employee's Stammsalon in the curated support-access employee list (Issue #93)",
  },
  {
    file: "composition/reports-period.ts",
    region: "function assemblePeriodReport",
    reason: "the period report's Stammsalon reach on a calendar day (Issue #612, #679)",
  },
  {
    file: "composition/reports.ts",
    region: "get /monthly",
    reason: "attributes the monthly report's sick and § 9 days to a salon filter (Issue #542)",
  },
  {
    file: "contexts/absence/leave-plan/admission.ts",
    region: "function isOwnStammsalonPlan",
    reason:
      "attributes a plan reader to the plan salon by the Stammsalon per day; counts nobody (Issue #835, D-05)",
  },
  {
    file: "contexts/absence/leave-plan/wish-write.ts",
    region: "function createWish",
    reason:
      "attributes a wish to the plan salon by the Stammsalon per day; counts nobody (Issue #835, D-05)",
  },
  {
    file: "contexts/absence/salon-leave-attribution.ts",
    region: "function filterLeaveRowsToHomeSalon",
    reason: "filters leave ROWS to a salon by the Stammsalon of a day; counts nobody (Issue #558)",
  },
];

/** The rule violations of a set of files; empty when the tree is conforming. */
function violationsOf(all: readonly Facts[]): string[] {
  const out: string[] = [];
  for (const f of all) {
    if (f.declarations.includes("parallelLeaveLoad") && f.file !== KERNEL_FILE) {
      out.push(`${f.file}: declares parallelLeaveLoad outside the kernel file`);
    }
    for (const c of f.calls) {
      if (c.callee === "parallelLeaveLoad" && !KERNEL_CALLERS.includes(f.file)) {
        out.push(
          `${f.file}: calls parallelLeaveLoad (${c.region}); only check.ts and load-view.ts may`,
        );
      }
    }
    const insideModule = f.file.startsWith(MODULE_DIR) || f.file === ROUTE_FILE;
    if (!insideModule && f.identifiers.length > 0) {
      out.push(`${f.file}: names LEAVE_LIMIT_COUNTED_CODES outside the leave-limits module`);
    }
    if (!insideModule && f.delegateAccesses > 0) {
      out.push(`${f.file}: accesses the leaveLimitRule delegate outside the leave-limits module`);
    }
  }
  const checkSites = all.flatMap((f) =>
    f.calls
      .filter((c) => c.callee === "evaluateLeaveLimits")
      .map((c) => `${f.file} | ${c.region} | ${c.callee}`),
  );
  const expected = [...CHECK_SITES].sort();
  const actual = [...new Set(checkSites)].sort();
  if (actual.join("\n") !== expected.join("\n") || checkSites.length !== CHECK_SITES.length) {
    out.push(
      `evaluateLeaveLimits sites differ from the register: found [${checkSites.join("; ")}]`,
    );
  }
  return out;
}

describe("Issue #836 - parallel leave is counted in one place", () => {
  const facts = measure();

  it("walks a non-empty set that contains the module", () => {
    expect(facts.length).toBeGreaterThanOrEqual(MIN_WALKED_FILES);
    const files = facts.map((f) => f.file);
    for (const expected of [
      KERNEL_FILE,
      ...KERNEL_CALLERS,
      ROUTE_FILE,
      LEAVE_ROUTES,
      DECISION_FILE,
    ]) {
      expect(files, expected).toContain(expected);
    }
  });

  it("declares parallelLeaveLoad in the kernel file and calls it only in check.ts and load-view.ts", () => {
    const callers = facts
      .filter((f) => f.calls.some((c) => c.callee === "parallelLeaveLoad"))
      .map((f) => f.file)
      .sort();
    expect(callers).toEqual([...KERNEL_CALLERS].sort());
    const declaredIn = facts.filter((f) => f.declarations.includes("parallelLeaveLoad"));
    expect(declaredIn.map((f) => f.file)).toEqual([KERNEL_FILE]);
  });

  it("evaluateLeaveLimits is called exactly at the three registered sites of api/leave.ts", () => {
    const sites = facts.flatMap((f) =>
      f.calls
        .filter((c) => c.callee === "evaluateLeaveLimits")
        .map((c) => `${f.file} | ${c.region} | ${c.callee}`),
    );
    expect([...sites].sort()).toEqual([...CHECK_SITES].sort());
  });

  it("the allow-list and the rule delegate stay inside the module and its route file", () => {
    const named = facts.filter((f) => f.identifiers.length > 0 || f.delegateAccesses > 0);
    expect(named.length).toBeGreaterThan(0); // the module itself uses them, so a zero is a blind guard
    expect(named.filter((f) => !f.file.startsWith(MODULE_DIR) && f.file !== ROUTE_FILE)).toEqual(
      [],
    );
  });

  it("homeSalonsForDays outside the module is exactly the measured register", () => {
    const outside = facts.flatMap((f) =>
      f.file.startsWith(MODULE_DIR)
        ? []
        : f.calls
            .filter((c) => c.callee === "homeSalonsForDays")
            .map((c) => `${f.file} | ${c.region}`),
    );
    expect([...new Set(outside)].sort()).toEqual(
      HOME_SALON_REGISTER.map((e) => `${e.file} | ${e.region}`).sort(),
    );
    for (const entry of HOME_SALON_REGISTER) {
      expect(entry.reason.length, entry.file).toBeGreaterThan(30);
    }
  });

  it("the real tree has no violation", () => {
    expect(violationsOf(facts)).toEqual([]);
  });

  it("positive control: a second count, a stray check and a rule read are reported", () => {
    const stray = scan(
      [
        "export async function strayLoad(db: unknown) {",
        "  parallelLeaveLoad([]);",
        "  await evaluateLeaveLimits(db, 't', { candidates: [], excludeRequestIds: [] });",
        "  return (db as { leaveLimitRule: { findMany(): unknown } }).leaveLimitRule.findMany();",
        "}",
      ].join("\n"),
      "composition/stray.ts",
    );
    const found = violationsOf([...facts, stray]);
    expect(found.some((v) => v.startsWith("composition/stray.ts: calls parallelLeaveLoad"))).toBe(
      true,
    );
    expect(found.some((v) => v.startsWith("evaluateLeaveLimits sites differ"))).toBe(true);
    expect(found.some((v) => v.includes("composition/stray.ts: accesses the leaveLimitRule"))).toBe(
      true,
    );
  });
});
