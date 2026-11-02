/**
 * Issue #539, AC-539-3 (Release A), kept by #641 (Release B) as a regression guard — nothing reads
 * a `role` column or a principal role.
 *
 * After Release A the compat role decided nothing: permissions come only from stored role
 * assignments, no token carries a `role` claim and the request principal has no role. Release B
 * (#641) removed what was left: the column write-back, the creation/import/anonymization column
 * writes, the compat filter helpers, the takeover script (the last allowlisted reader) and the
 * column itself. This guard stays because a future `select` or `where` on `role` would be the
 * first sign of a reintroduced column. It walks every non-test `.ts` file of `apps/api/src` and
 * `apps/api/scripts` and fails on
 *
 *   1. `deleted-identifier`  — a declaration or reference named after one of the deleted
 *                              functions and constants (see `DELETED_IDENTIFIERS`);
 *   2. `select-role`         — an object-literal property `role: true` inside a `select` object, i.e.
 *                              a Prisma read of a `role` column;
 *   3. `where-role`          — a property `role` inside an object literal that is the value of a
 *                              `where` property, at any nesting (a filter on a `role` column);
 *   4. `principal-role`      — a read of `role` from the request principal: `req.user.role`,
 *                              `request.user["role"]`, or `const { role } = req.user`;
 *   5. `jwt-payload-role`    — a `role` member in the `JwtPayload` interface of `middleware/auth.ts`.
 *
 * The reader allowlist is EMPTY and asserted to be empty: a new reader is removed, never listed.
 * Non-vacuity: the scan asserts it walked more than 270 files (an inline literal, measured when
 * the guard was written and re-measured by #641).
 *
 * What the guard cannot see (stated, not hidden — same limits as `scripts/lint-role-checks.ts`): a read
 * through a renamed alias, a dynamic property name, a `select` object built outside an object literal,
 * raw SQL, and a `where` predicate that reaches Prisma through a helper's return value. The role-comparison shapes are the job of `lint:role-checks`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

// __dirname is apps/api/src/__tests__ — two levels up is apps/api.
const API_ROOT = join(__dirname, "..", "..");

// The deleted functions, held as string constants because this test file is outside its own scan.
const DELETED_IDENTIFIERS: readonly string[] = [
  "loadLegacyFallbackRole",
  "materializeLegacyRoleAssignment",
  "compatRoleForUser",
  // Deleted by #641 (Release B): the private column reader and the column write-back of the former compat-role.ts.
  "legacyRoleColumn",
  "syncCompatRoleColumn",
  // Deleted by #641 (Release B): the unused company-PDF role filter helpers (route removed by #617).
  "parseCompatRoleFilter",
  "compatRoleUserWhere",
  // Deleted by #641 (Release B): the takeover script's audit-entry builder and its reason constant.
  "materializedAssignmentAuditEntry",
  "LEGACY_ROLE_MATERIALIZATION_REASON",
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

// Release B (#641): the column is gone, so no reader is documented any more. The array stays so the
// "allowlist is empty" test below fails the moment someone lists one.
const ALLOWED_READERS: readonly AllowedReader[] = [];

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

  it("the reader allowlist is empty (Release B, #641)", () => {
    expect(ALLOWED_READERS).toHaveLength(0);
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
});
