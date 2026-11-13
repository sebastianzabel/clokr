/**
 * Issue #835 (AC-3; D-01, D-835-19) — a leave plan wish counts nowhere until the takeover turns it
 * into a real leave request. No saldo, report, DATEV, roster, pricing, month-close, composition,
 * leave-limit-kernel or leave-core file may name the plan model, its module or its routes. Sibling
 * of `travel-saldo-isolation-92.test.ts` (same AST scan, same controls; never imported or edited).
 *
 * THE RULE (D-01): a wish is a non-binding plan entry. It is not a request, so it reserves no
 * leave days, reduces no Soll, appears in no report and no DATEV export, blocks no roster, and is
 * not a "load" of the parallel-leave limits. Only the takeover (`contexts/absence/leave-plan/`
 * `takeover.ts`) creates a request, through the one create core, and that request is an ordinary one.
 * A figure that read a wish would let an unapproved wish weigh differently from the request it may
 * become, and closed months (never recalculated) could drift.
 *
 * THE PROTECTED SET and why each part is in it:
 *  - `contexts/working-time-account/`: the saldo, the Monatsabschluss, the month figures;
 *  - `composition/`: reports, DATEV, the Monatsexport, dashboards and PDFs read figures only;
 *  - `contexts/scheduling/`: the roster; a wish must not make a shift conflict or a coverage count;
 *  - `services/`: the clock and the Phorest sync;
 *  - `contexts/time-tracking/`: recorded time, the day kernels;
 *  - `contexts/absence/leave-limits/`: the parallel-leave kernel; it receives a wish only as a
 *    passed-in CANDIDATE range from the takeover, never by reading the model;
 *  - the leave cores that must stay plan-agnostic: `leave-days`, `vacation-calc`, `leave-correction`,
 *    `closed-month-guard`, `employment-exit`, `later-request-reprice`, `shift-leave-recalc-resolver`,
 *    `sick-leave-days`, `bs-leave-days`, `leave-request-create`, `leave-decision` and the facade
 *    readers `vacation-balance` and `entitlements` (the create and decision cores take a plan only as
 *    an opaque audit extra and an in-transaction hook that the takeover supplies);
 *
 * ALLOWED READERS (not scanned): `contexts/absence/leave-plan/**`, `contexts/absence/api/leave-plans.ts`,
 * the absence facade's hard-delete function (`facade/leave-requests.ts`), the platform hard-delete
 * call (`platform/api/employees.ts`), `app.ts` (route registration), the schema, seeds, scripts and
 * test files.
 *
 * Named blind spot: an alias (`const m = prisma["leave" + "PlanWish"]`), a destructured delegate, or a
 * re-implementation that never names these identifiers, and a figure file outside the protected set,
 * are not seen here.
 *
 * The scan parses each file with the TypeScript compiler. A forbidden NAME counts as an identifier
 * (member access, import name, object key, type name) or as a string literal / bracket access; a
 * module specifier counts when an import, export or dynamic import contains `leave-plan` (this also
 * covers `leave-plans`). Comments are not scanned; `leavePlanDeadlineLocksWishes` is a different
 * identifier and is not a hit.
 *
 * Walk count MEASURED 2026-11-06: 167 non-test files (35 working-time-account + 16 composition + 21
 * scheduling + 12 services + 56 time-tracking + 14 leave-limits + 11 absence cores + 2 facade
 * readers). The floor below is 150.
 *
 * Mutation proof (Phase 835-05, 2026-11-06) — recorded here, not re-run by CI: a scratch file
 * `composition/zz-scratch-835.ts` containing `export const w = prisma.leavePlanWish;` was added and the
 * suite run -> red: "no protected file references the leave plan" names the file and `leavePlanWish`
 * (1 failed | 3 passed). A second scratch file in `contexts/working-time-account/` importing
 * `"../absence/leave-plan"` was red in the same case (names the specifier). Both files were removed
 * with `rm` afterwards; `git status` showed no residue and the suite was green again (4 passed).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { describe, it, expect } from "vitest";
import * as ts from "typescript";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SRC = "apps/api/src";

/** Directories whose every non-test `.ts` file is protected. */
const PROTECTED_DIRS = [
  `${SRC}/contexts/working-time-account`,
  `${SRC}/composition`,
  `${SRC}/contexts/scheduling`,
  `${SRC}/services`,
  `${SRC}/contexts/time-tracking`,
  `${SRC}/contexts/absence/leave-limits`,
];

/** Individual protected files: the leave cores and the facade readers. */
const PROTECTED_FILES = [
  ...[
    "leave-days",
    "vacation-calc",
    "leave-correction",
    "closed-month-guard",
    "employment-exit",
    "later-request-reprice",
    "shift-leave-recalc-resolver",
    "sick-leave-days",
    "bs-leave-days",
    "leave-request-create",
    "leave-decision",
  ].map((name) => `${SRC}/contexts/absence/${name}.ts`),
  `${SRC}/contexts/absence/facade/vacation-balance.ts`,
  `${SRC}/contexts/absence/facade/entitlements.ts`,
];

/** Files the walk must reach, one per protected family (a moved directory turns this red). */
const MUST_REACH = [
  `${SRC}/composition/reports.ts`,
  `${SRC}/contexts/working-time-account/close-employee-month.ts`,
  `${SRC}/contexts/absence/leave-days.ts`,
  `${SRC}/contexts/absence/leave-request-create.ts`,
];

/** Measured 167 on 2026-11-06; the floor leaves room for removals but not for an emptied tree. */
const MIN_WALKED_FILES = 150;

/** The plan identifiers and string literals no protected file may carry. */
const FORBIDDEN_NAMES = new Set([
  "leavePlan",
  "leavePlanWish",
  "LeavePlan",
  "LeavePlanWish",
  "LeavePlanStatus",
  "takeOverLeavePlan",
  "readPlanner",
  "planPopulation",
  // The audit extra the takeover hands the create core: the core stays generic.
  "leavePlanId",
  "leavePlanWishId",
]);

/** A module specifier naming the plan module or its routes (`leave-plan`, `leave-plans`, `api/leave-plans`). */
const PLAN_SPECIFIER = /leave-plan/;

function repoRel(absPath: string): string {
  return relative(REPO_ROOT, absPath).split("\\").join("/");
}

function walkTs(absDir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(absDir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const abs = join(absDir, entry);
    if (statSync(abs).isDirectory()) walkTs(abs, out);
    else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      out.push(abs);
    }
  }
  return out;
}

/** The forbidden names and module specifiers a source text carries, by AST. Comments are not scanned. */
function planReferencesIn(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hits = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && FORBIDDEN_NAMES.has(node.text)) hits.add(node.text);
    if (ts.isStringLiteralLike(node)) {
      if (FORBIDDEN_NAMES.has(node.text)) hits.add(node.text);
      const parent = node.parent;
      const isSpecifier =
        parent !== undefined &&
        (ts.isImportDeclaration(parent) ||
          ts.isExportDeclaration(parent) ||
          (ts.isCallExpression(parent) &&
            (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(parent.expression) && parent.expression.text === "require"))));
      if (isSpecifier && PLAN_SPECIFIER.test(node.text)) hits.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...hits].sort();
}

function sourceOf(file: string): string {
  return readFileSync(join(REPO_ROOT, file), "utf8");
}

function protectedFiles(): string[] {
  const dirFiles = PROTECTED_DIRS.flatMap((dir) => walkTs(join(REPO_ROOT, dir)).map(repoRel));
  return [...new Set([...dirFiles, ...PROTECTED_FILES])].sort();
}

describe("Issue #835 (D-01, D-835-19) — no figure path reads a leave plan wish", () => {
  const files = protectedFiles();

  it("the walk sees the tree (a silently-empty walk would pass forever)", () => {
    expect(files.length, "no protected file walked at all").toBeGreaterThan(0);
    expect(
      files.length,
      "fewer files walked than the measured floor — a scan root moved or emptied",
    ).toBeGreaterThanOrEqual(MIN_WALKED_FILES);
    for (const file of MUST_REACH) {
      expect(files, `the walk did not reach ${file}`).toContain(file);
    }
    for (const file of PROTECTED_FILES) {
      expect(sourceOf(file).length, `${file} is empty or missing`).toBeGreaterThan(0);
    }
    for (const dir of PROTECTED_DIRS) {
      const inDir = files.filter((f) => f.startsWith(`${dir}/`));
      expect(inDir.length, `the walk found no file under ${dir}`).toBeGreaterThan(0);
    }
  });

  it("positive control: the detector flags every forbidden shape", () => {
    expect(planReferencesIn("x.ts", `const n = leavePlan.id;`), "identifier").toEqual([
      "leavePlan",
    ]);
    expect(
      planReferencesIn("x.ts", `await db.leavePlanWish.findMany({});`),
      "property access on a delegate",
    ).toEqual(["leavePlanWish"]);
    expect(planReferencesIn("x.ts", `const t: LeavePlanStatus = "OPEN";`), "type name").toEqual([
      "LeavePlanStatus",
    ]);
    expect(
      planReferencesIn("x.ts", `await takeOverLeavePlan(app, input);`),
      "function name",
    ).toEqual(["takeOverLeavePlan"]);
    expect(planReferencesIn("x.ts", `const a = readPlanner; const b = planPopulation;`)).toEqual([
      "planPopulation",
      "readPlanner",
    ]);
    expect(
      planReferencesIn("x.ts", `app.dismissByRelated("LeavePlan", id, "X");`),
      "string literal",
    ).toEqual(["LeavePlan"]);
    expect(planReferencesIn("x.ts", `const m = "LeavePlanWish";`), "string literal 2").toEqual([
      "LeavePlanWish",
    ]);
    expect(planReferencesIn("x.ts", `const r = db["leavePlanWish"];`), "bracket access").toEqual([
      "leavePlanWish",
    ]);
    expect(
      planReferencesIn("x.ts", `const e = { leavePlanId: "p", leavePlanWishId: "w" };`),
      "the audit extra keys",
    ).toEqual(["leavePlanId", "leavePlanWishId"]);
    expect(
      planReferencesIn("x.ts", `import { x } from "../contexts/absence/leave-plan";`),
      "import specifier",
    ).toEqual(["../contexts/absence/leave-plan"]);
    expect(
      planReferencesIn("x.ts", `import { y } from "../absence/api/leave-plans";`),
      "routes import specifier",
    ).toEqual(["../absence/api/leave-plans"]);
    expect(
      planReferencesIn("x.ts", `export { z } from "./leave-plan/takeover";`),
      "export specifier",
    ).toEqual(["./leave-plan/takeover"]);
    expect(
      planReferencesIn("x.ts", `const m = await import("../absence/leave-plan");`),
      "dynamic import",
    ).toEqual(["../absence/leave-plan"]);
    // Not hits: comments, a different identifier, a module whose name only shares a prefix with a hit.
    expect(
      planReferencesIn("x.ts", `// leavePlanWish and "LeavePlan" only in a comment`),
      "comments are deliberately not scanned",
    ).toEqual([]);
    expect(
      planReferencesIn("x.ts", `const k = config.leavePlanDeadlineLocksWishes;`),
      "the tenant setting is a different identifier",
    ).toEqual([]);
    expect(
      planReferencesIn("x.ts", `import { a } from "../leave-limits";`),
      "an unrelated leave module",
    ).toEqual([]);
  });

  it("control run: the plan module and its route carry the names (the guard watches live names)", () => {
    const takeover = planReferencesIn(
      "takeover.ts",
      sourceOf(`${SRC}/contexts/absence/leave-plan/takeover.ts`),
    );
    for (const name of ["takeOverLeavePlan", "leavePlanWish", "leavePlan", "LeavePlan"]) {
      expect(takeover, `the name ${name} no longer exists in leave-plan/takeover.ts`).toContain(
        name,
      );
    }
    const routes = planReferencesIn(
      "leave-plans.ts",
      sourceOf(`${SRC}/contexts/absence/api/leave-plans.ts`),
    );
    for (const name of [
      "leavePlan",
      "leavePlanWish",
      "takeOverLeavePlan",
      "planPopulation",
      "readPlanner",
    ]) {
      expect(routes, `the name ${name} no longer exists in api/leave-plans.ts`).toContain(name);
    }
    const hardDelete = planReferencesIn(
      "leave-requests.ts",
      sourceOf(`${SRC}/contexts/absence/facade/leave-requests.ts`),
    );
    expect(hardDelete, "the facade's hard-delete no longer names the wish model").toContain(
      "leavePlanWish",
    );
    // The specifier rule is live too: the route imports the plan module.
    expect(routes.some((hit) => hit.endsWith("leave-plan"))).toBe(true);
  });

  it("no protected file references the leave plan (no allowlist)", () => {
    const offenders = files
      .map((file) => [file, planReferencesIn(file, sourceOf(file))] as const)
      .filter(([, refs]) => refs.length > 0)
      .map(([file, refs]) => `${file}: ${refs.join(", ")}`);
    expect(
      offenders,
      `a leave plan name reached a figure path (D-01: a wish counts nowhere):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
