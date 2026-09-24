/**
 * Phase 77b (Issue #77, D-09) — route files never build an `EmployeeScope` by hand.
 *
 * Why: after Phase 77b there is exactly one place a route's `EmployeeScope` comes from —
 * `employeeScopeFor(accessContextFromRequest(req), …)` in `contexts/platform/access-context.ts`.
 * That factory is the single hook where Issue #91 will narrow a scope to salons or persons; a
 * hand-built literal in a route file would silently bypass that narrowing and keep answering for
 * the whole tenant. This gate keeps such literals from coming back.
 *
 * What it scans: every `.ts` file under each `apps/api/src/contexts/<ctx>/api/` directory (nested
 * directories included, e.g. `platform/api/admin/`; `__tests__` directories and `*.test.ts` files
 * excluded), plus `apps/api/src/composition/dashboard.ts` and `apps/api/src/composition/reports.ts`.
 *
 * What it flags: an object literal with a `kind` property whose value — after unwrapping
 * parentheses, `as`, `satisfies` and angle-bracket type assertions — is the string literal (or a
 * substitution-free template literal) `"tenant"`, `"employee"` or `"employees"`: the three
 * `EmployeeScope` variants.
 *
 * Why the TypeScript AST and not a regex: a comment or a string that merely mentions the scope
 * text is trivia or a token to the parser, never an object literal, so neither is ever a hit. The
 * access context's own reach discriminator is `"wholeTenant"` precisely so it can never be
 * confused with a scope literal here.
 *
 * Blind spot, stated so nobody over-trusts it: a scope object assembled from a variable, a
 * computed value or a spread is not a literal and is not flagged. `employeeScopeFor` is the only
 * sanctioned constructor; review, not this test, has to catch a creative workaround.
 *
 * Out of scope on purpose: the `EmployeeScope` literals in calculation and background modules
 * (e.g. `working-time-account/overtime-balance.ts`) stay by owner decision — Issue #77 "Nicht Teil
 * davon".
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const CONTEXTS_ROOT = "apps/api/src/contexts";
const COMPOSITION_FILES = [
  "apps/api/src/composition/dashboard.ts",
  "apps/api/src/composition/reports.ts",
];
const ANCHOR_FILES = [
  "apps/api/src/composition/dashboard.ts",
  "apps/api/src/composition/reports.ts",
  "apps/api/src/contexts/scheduling/api/shifts.ts",
];
// Floor for the walked file count. Measured on 28009b3f: 33 route files under contexts/*/api
// plus the two composition files.
const MIN_WALKED_FILES = 30;

/** The three `EmployeeScope` discriminator values (contexts/platform/facade/employee-scope.ts). */
const SCOPE_KINDS = new Set(["tenant", "employee", "employees"]);

function collectFiles(): string[] {
  const out: string[] = [];
  function walk(absDir: string) {
    for (const entry of readdirSync(absDir)) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      const abs = join(absDir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts")) out.push(abs);
    }
  }
  const contextsAbs = join(REPO_ROOT, CONTEXTS_ROOT);
  for (const ctx of readdirSync(contextsAbs)) {
    const apiDir = join(contextsAbs, ctx, "api");
    if (existsSync(apiDir) && statSync(apiDir).isDirectory()) walk(apiDir);
  }
  for (const rel of COMPOSITION_FILES) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) throw new Error(`composition file missing: ${rel}`);
    out.push(abs);
  }
  return out;
}

function repoRel(absPath: string): string {
  return relative(REPO_ROOT, absPath).split("\\").join("/");
}

function unwrap(expr: ts.Expression): ts.Expression {
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

interface ScopeLiteralHit {
  file: string;
  line: number;
}

/** Every object literal in `text` whose `kind` property is one of {@link SCOPE_KINDS}. */
function findScopeLiterals(fileName: string, text: string): ScopeLiteralHit[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const hits: ScopeLiteralHit[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const name =
          ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
        if (name !== "kind") continue;
        const v = unwrap(p.initializer);
        if (
          (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) &&
          SCOPE_KINDS.has(v.text)
        ) {
          hits.push({
            file: fileName,
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

describe("Phase 77b (Issue #77, D-09) — no EmployeeScope literal in route files", () => {
  it("walk sees the route files (a silently-empty walk would pass forever)", () => {
    const files = collectFiles();
    expect(
      files.length,
      `walked ${files.length} file(s) — fewer than the measured floor of ${MIN_WALKED_FILES}; ` +
        "the contexts/*/api directories moved or emptied",
    ).toBeGreaterThanOrEqual(MIN_WALKED_FILES);
    const relFiles = files.map(repoRel);
    for (const anchor of ANCHOR_FILES) expect(relFiles).toContain(anchor);
    for (const rel of relFiles) {
      expect(rel.split("/")).not.toContain("__tests__");
      expect(rel.endsWith(".test.ts")).toBe(false);
    }
  });

  it("detector: flags the three scope kinds in every literal shape", () => {
    expect(findScopeLiterals("a.ts", `f({ kind: "tenant", tenantId });`)).toHaveLength(1);
    expect(
      findScopeLiterals("b.ts", `f({ kind: "employee" as const, employeeId, tenantId });`),
    ).toHaveLength(1);
    expect(
      findScopeLiterals(
        "c.ts",
        `f({ kind: "employees", employeeIds, tenantId } satisfies EmployeeScope);`,
      ),
    ).toHaveLength(1);
    expect(findScopeLiterals("d.ts", `f({ "kind": \`tenant\`, tenantId });`)).toHaveLength(1);
  });

  it("detector: ignores other kinds, comments and strings", () => {
    expect(findScopeLiterals("e.ts", `f({ kind: "leave", id });`)).toEqual([]);
    expect(findScopeLiterals("f.ts", `const r = { kind: "wholeTenant" };`)).toEqual([]);
    expect(findScopeLiterals("g.ts", `// f({ kind: "tenant", tenantId });\nf(x);`)).toEqual([]);
    expect(findScopeLiterals("h.ts", `const s = '{ kind: "tenant", tenantId }';`)).toEqual([]);
  });

  it("real tree: every route-file scope comes from employeeScopeFor", () => {
    const hits = collectFiles().flatMap((abs) =>
      findScopeLiterals(repoRel(abs), readFileSync(abs, "utf8")),
    );
    expect(
      hits,
      "EmployeeScope object literal(s) in route files — build them with " +
        "employeeScopeFor(accessContextFromRequest(req), …) instead:\n" +
        hits.map((h) => `  ${h.file}:${h.line}`).join("\n"),
    ).toEqual([]);
  });
});
