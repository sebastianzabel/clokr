/**
 * Issue #539, AC-539-3 (Release A) — the legacy role column is read only by its documented readers.
 *
 * After Release A the compat role (`User.role`) decides nothing: permissions come only from stored
 * role assignments, no token carries a `role` claim and the request principal has no role. The column
 * is still WRITTEN (from the stored assignments, `contexts/platform/compat-role.ts`) until Release B
 * drops it. This guard keeps the READ side closed: it walks every non-test `.ts` file of
 * `apps/api/src` and `apps/api/scripts` and fails on
 *
 *   1. `deleted-identifier`  — a declaration or reference named after one of the three deleted
 *                              functions (the private fallback loader, the materialization function,
 *                              the compat role-for-user function);
 *   2. `select-role`         — an object-literal property `role: true` inside a `select` object, i.e.
 *                              a Prisma read of the column (`User.role` is the only `role` column of
 *                              the schema);
 *   3. `where-role`          — a property `role` inside an object literal that is the value of a
 *                              `where` property, at any nesting (a filter on the column);
 *   4. `principal-role`      — a read of `role` from the request principal: `req.user.role`,
 *                              `request.user["role"]`, or `const { role } = req.user`;
 *   5. `jwt-payload-role`    — a `role` member in the `JwtPayload` interface of `middleware/auth.ts`.
 *
 * Exactly the readers in `ALLOWED_READERS` stay: the write-back comparison in `compat-role.ts` (D-06,
 * kind 2) and the takeover script `backfill-539-role-assignments.ts` (D-01, kind 2: it reads the legacy
 * role once to store the assignment the old fallback used to grant). Each entry must match at least one
 * occurrence — a stale entry turns the guard red, like an unlisted finding does. The company-PDF role
 * filter (D-12) is NOT a finding: `compatRoleUserWhere()` returns `{ role }` outside any `where`
 * literal, and the route spreads that return value; a case below pins this.
 *
 * Non-vacuity: the scan asserts it walked more than 270 files (an inline literal, 318 measured) and found each allowlisted
 * reader (the floor is an inline literal, measured when the guard was written).
 *
 * What the guard cannot see (stated, not hidden — same limits as `scripts/lint-role-checks.ts`): a read
 * through a renamed alias, a dynamic property name, a `select` object built outside an object literal,
 * raw SQL, and a `where` predicate that reaches Prisma through a helper's return value (which is how
 * the D-12 filter legitimately travels). The role-comparison shapes are the job of `lint:role-checks`.
 * Release B removes the column and with it the allowlist and kinds 2 and 3.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

// __dirname is apps/api/src/__tests__ — two levels up is apps/api.
const API_ROOT = join(__dirname, "..", "..");

// The three deleted functions, held as string constants because this test file is outside its own scan.
const DELETED_IDENTIFIERS: readonly string[] = [
  "loadLegacyFallbackRole",
  "materializeLegacyRoleAssignment",
  "compatRoleForUser",
];

type FindingKind =
  "deleted-identifier" | "select-role" | "where-role" | "principal-role" | "jwt-payload-role";

interface Finding {
  file: string;
  line: number;
  kind: FindingKind;
  text: string;
}

const PRINCIPAL_RECEIVER = /^(req|request)\.user$/;

function receiverText(node: ts.Expression, sf: ts.SourceFile): string {
  let e: ts.Expression = node;
  while (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) {
    e = e.expression;
  }
  return e.getText(sf).replace(/[?!]/g, "");
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** True when `node` sits (at any depth) inside the object literal that is the value of a `where` property. */
function insideWhereValue(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (
      ts.isPropertyAssignment(p) &&
      propertyNameText(p.name) === "where" &&
      ts.isObjectLiteralExpression(p.initializer)
    ) {
      return true;
    }
  }
  return false;
}

/** Pure scan of one source text; `file` is the repo-relative path used for reporting and the JwtPayload rule. */
function findLegacyRoleReads(text: string, file: string): Finding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Finding[] = [];
  const add = (node: ts.Node, kind: FindingKind) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ file, line: line + 1, kind, text: node.getText(sf).split("\n")[0].slice(0, 100) });
  };

  const visit = (node: ts.Node) => {
    // 1. deleted identifiers (declaration or reference)
    if (ts.isIdentifier(node) && DELETED_IDENTIFIERS.includes(node.text)) {
      add(node, "deleted-identifier");
    }

    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const name = ts.isPropertyAssignment(node) ? propertyNameText(node.name) : node.name.text;
      if (name === "role") {
        // 2. `select: { role: true }`
        if (
          ts.isPropertyAssignment(node) &&
          node.initializer.kind === ts.SyntaxKind.TrueKeyword &&
          ts.isObjectLiteralExpression(node.parent) &&
          ts.isPropertyAssignment(node.parent.parent) &&
          propertyNameText(node.parent.parent.name) === "select"
        ) {
          add(node, "select-role");
        }
        // 3. a `role` property anywhere under the value of a `where` property
        if (insideWhereValue(node)) add(node, "where-role");
      }
    }

    // 4. req.user.role / request.user["role"]
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "role" &&
      PRINCIPAL_RECEIVER.test(receiverText(node.expression, sf))
    ) {
      add(node, "principal-role");
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "role" &&
      PRINCIPAL_RECEIVER.test(receiverText(node.expression, sf))
    ) {
      add(node, "principal-role");
    }
    // 4b. const { role } = req.user
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      PRINCIPAL_RECEIVER.test(receiverText(node.initializer, sf)) &&
      node.name.elements.some(
        (el) =>
          (el.propertyName ? propertyNameText(el.propertyName as ts.PropertyName) : null) ===
            "role" ||
          (!el.propertyName && ts.isIdentifier(el.name) && el.name.text === "role"),
      )
    ) {
      add(node, "principal-role");
    }

    // 5. `role` member of the JwtPayload interface of middleware/auth.ts
    if (
      file.endsWith("src/middleware/auth.ts") &&
      ts.isInterfaceDeclaration(node) &&
      node.name.text === "JwtPayload"
    ) {
      for (const member of node.members) {
        if (member.name && propertyNameText(member.name as ts.PropertyName) === "role") {
          add(member, "jwt-payload-role");
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out.sort((a, b) => a.line - b.line);
}

interface AllowedReader {
  file: string;
  kind: FindingKind;
  reason: string;
}

// The documented readers. Every entry must match at least one occurrence.
const ALLOWED_READERS: readonly AllowedReader[] = [
  {
    file: "src/contexts/platform/compat-role.ts",
    kind: "select-role",
    reason:
      "D-06: the write-back compares the derived role with the stored column value before updating it",
  },
  {
    file: "scripts/backfill-539-role-assignments.ts",
    kind: "select-role",
    reason:
      "D-01: the takeover script reads the legacy role once to store the assignment the old fallback granted",
  },
];

function walkSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue; // also covers scripts/__tests__/fixtures
        walk(abs);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(abs);
      }
    }
  };
  walk(join(API_ROOT, "src"));
  walk(join(API_ROOT, "scripts"));
  return out;
}

function rel(abs: string): string {
  return abs
    .slice(API_ROOT.length + 1)
    .split("\\")
    .join("/");
}

describe("#539 AC-539-3 — the compat role column is read only by its documented readers", () => {
  const files = walkSources();
  const all: Finding[] = [];
  for (const abs of files) {
    all.push(...findLegacyRoleReads(readFileSync(abs, "utf8"), rel(abs)));
  }

  it("walks a non-trivial set of source files (non-vacuity)", () => {
    // Inline literal floor (anti-vacuity gate): 318 files measured, ~15% tolerance.
    expect(files.length).toBeGreaterThan(270);
    expect(files.some((f) => rel(f) === "src/app.ts")).toBe(true);
    expect(files.some((f) => rel(f) === "scripts/lint-role-checks.ts")).toBe(true);
    expect(files.some((f) => rel(f).includes("__tests__"))).toBe(false);
  });

  it("every allowlisted reader matches at least one occurrence (no stale entry)", () => {
    for (const entry of ALLOWED_READERS) {
      const hits = all.filter((f) => f.file === entry.file && f.kind === entry.kind);
      expect(hits.length, `${entry.file} ${entry.kind}: ${entry.reason}`).toBeGreaterThan(0);
    }
  });

  it("has no finding outside the allowlist", () => {
    const unlisted = all.filter(
      (f) => !ALLOWED_READERS.some((a) => a.file === f.file && a.kind === f.kind),
    );
    expect(unlisted.map((f) => `${f.file}:${f.line} ${f.kind} — ${f.text}`)).toEqual([]);
  });
});

describe("#539 AC-539-3 — the scanner flags each kind and tolerates the documented shapes", () => {
  const kinds = (src: string, file = "src/x.ts") =>
    findLegacyRoleReads(src, file).map((f) => f.kind);

  it("kind 1: a deleted identifier, as declaration and as reference", () => {
    expect(kinds("async function loadLegacyFallbackRole() {}")).toEqual(["deleted-identifier"]);
    expect(kinds("const r = await compatRoleForUser(db, id);")).toEqual(["deleted-identifier"]);
    expect(kinds("import { materializeLegacyRoleAssignment } from './x';")).toEqual([
      "deleted-identifier",
    ]);
  });

  it("kind 2: a Prisma select of the column", () => {
    expect(kinds("db.user.findUnique({ where: { id }, select: { role: true } });")).toEqual([
      "select-role",
    ]);
    expect(kinds("db.user.findUnique({ select: { id: true, isActive: true } });")).toEqual([]);
  });

  it("kind 3: a role filter under a where value, at any nesting", () => {
    expect(kinds('db.employee.findMany({ where: { user: { role: "ADMIN" } } });')).toEqual([
      "where-role",
    ]);
    expect(kinds("db.user.findMany({ where: { role: { in: roles } } });")).toEqual(["where-role"]);
    // a write payload is not a filter
    expect(kinds("db.user.update({ where: { id }, data: { role: derived } });")).toEqual([]);
  });

  it("kind 4: a role read from the request principal", () => {
    expect(kinds("const r = req.user.role;")).toEqual(["principal-role"]);
    expect(kinds('const r = request.user["role"];')).toEqual(["principal-role"]);
    expect(kinds("const { role } = req.user;")).toEqual(["principal-role"]);
    expect(kinds("const { role: r } = req.user;")).toEqual(["principal-role"]);
    expect(kinds("const { sub, tenantId } = req.user;")).toEqual([]);
  });

  it("kind 5: a role member of JwtPayload in middleware/auth.ts only", () => {
    const src = "export interface JwtPayload { sub: string; role: string; }";
    expect(kinds(src, "src/middleware/auth.ts")).toEqual(["jwt-payload-role"]);
    expect(kinds(src, "src/other.ts")).toEqual([]);
    expect(
      kinds(
        "export interface JwtPayload { sub: string; tenantId: string; }",
        "src/middleware/auth.ts",
      ),
    ).toEqual([]);
  });

  it("does not flag the D-12 company-PDF filter (compatRoleUserWhere returns { role } outside a where literal)", () => {
    const helper =
      "export function compatRoleUserWhere(filter?: string) { return filter ? { role: filter } : {}; }";
    expect(kinds(helper)).toEqual([]);
    expect(
      kinds(
        "db.employee.findMany({ where: { user: { isActive: true, ...compatRoleUserWhere(f) } } });",
      ),
    ).toEqual([]);
  });
});
