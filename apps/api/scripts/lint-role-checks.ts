#!/usr/bin/env -S pnpm exec tsx
/**
 * lint:role-checks — Phase 75b Plan 12 (Issue #75, D-19, AC-75-2).
 *
 * Since #75 every access decision in the API asks for a catalog permission
 * (`requirePermission` / `requireAnyPermission` / `hasPermission` / `permissionReach` /
 * `userIdsHoldingPermission`, all from `contexts/platform`). The legacy role value (`User.role`,
 * the JWT claim `role`) survives only as a compat field until #83. This gate keeps it that way: a
 * role check that comes back — in a guard, in a handler, or in a Prisma predicate — fails CI and
 * `.husky/pre-commit`, not just review.
 *
 * ── What is flagged (in every non-test `.ts` file under `apps/api/src`) ─────────────────────────
 * A "role literal" is a string literal `"ADMIN"`, `"MANAGER"` or `"EMPLOYEE"`. A "role-valued"
 * expression is
 *   - a property access named `role` on any receiver (`req.user.role`, `e.user.role`, `x["role"]`);
 *   - an identifier whose declaration is initialised from a role-valued expression
 *     (`const role = req.user.role`, also through `as`, `!`, parentheses and further aliases), or
 *     is annotated with the type `Role`;
 *   - an identifier bound by destructuring `role` out of an expression whose text is `user` or
 *     ends with `.user` (`const { role } = req.user`, `const { role: r } = user`), or out of a
 *     parameter typed `JwtPayload`.
 * Identifiers are resolved lexically (the nearest enclosing declaration of that name), so a
 * `role` destructured from `req.query` in one handler is never confused with a `role`
 * destructured from `req.user` in another.
 * The shapes:
 *   - `removed-role-guard-call` — any call of `requireRole(…)` (deleted in 75b-12, D-18);
 *   - `role-comparison`        — `===`, `!==`, `==`, `!=` between a role-valued expression and a
 *                                role literal, either side;
 *   - `role-switch`            — `switch (<role-valued>)` with a `case <role literal>`;
 *   - `role-membership`        — `.includes/.indexOf/.lastIndexOf/.has(<role-valued>)` on any
 *                                receiver, or `.includes/.indexOf/.lastIndexOf/.has(…)` on an array
 *                                literal (or `new Set([...])`) that contains a role literal;
 *   - `role-where-predicate`   — a property `role` whose value is a role literal or a Prisma
 *                                operator object (`in`, `notIn`, `equals`, `not`) holding one, but
 *                                only under a Prisma filter: an ancestor property named `where`,
 *                                or a variable named `…where` / typed `…WhereInput`.
 *
 * ── What is tolerated, and why none of it is an access decision ─────────────────────────────────
 *   - `data: { role: "ADMIN" }` — a creation payload (test-bootstrap), no `where` ancestor;
 *   - `z.enum(["ADMIN", "MANAGER", "EMPLOYEE"])` — input validation, no comparison;
 *   - type literals (`role: "ADMIN" | "MANAGER" | "EMPLOYEE"` in report data types) — types are
 *     not expressions, the AST walk never sees them as values;
 *   - `data.roleFilter === "EMPLOYEE"` — a property named `roleFilter`, the PDF's label switch;
 *   - `const { role } = req.query …; role === "MANAGER"` — a query parameter, not a user;
 *   - `role: emp.user.role`, `actorRole: req.user.role` — report data and audit values: the role
 *     is copied, not compared;
 *   - `role: isAdmin ? "ADMIN" : "MANAGER"` — the API-key compat assignment in
 *     `middleware/auth.ts` (D-11): it sets the compat field, it decides nothing;
 *   - everything in `__tests__/` and `*.test.ts` (fixtures create users with legacy roles).
 *
 * ── The single allowlist, and why there is no exceptions file ────────────────────────────────────
 * Exactly one file may compare role values: `contexts/platform/compat-role.ts` (D-14), the ONE
 * place where legacy values are derived from assignments and mapped back onto system roles. It is
 * a constant here, not an entry in a JSON register: a second allowlisted file would be a second
 * derivation, which is precisely what D-14 forbids. A finding on a clean tree is a role check to
 * convert to a permission (or a role-literal read to move behind a `compat-role.ts` helper, like
 * the report's role filter `compatRoleUserWhere`), never a reason to widen this list. If the
 * allowlisted file disappears, the gate fails instead of silently allowlisting nothing.
 *
 * ── AST, not regex ───────────────────────────────────────────────────────────────────────────────
 * The file is parsed with `ts.createSourceFile`, so comments are trivia the walk never visits and a
 * string that merely CONTAINS `req.user.role === "ADMIN"` is one string literal token, never a
 * comparison. Same approach as `lint-facade-signatures.ts` and `lint-guard-vacuity-detect.ts`.
 *
 * ── What this gate structurally cannot see (stated, not hidden) ──────────────────────────────────
 *   - a role value that reaches a comparison through a function call or a return value
 *     (`getRole(req) === "ADMIN"`), a reassignment (`let r; r = req.user.role`), a conditional
 *     initialiser (`const r = a ? x.role : y.role`), nested destructuring
 *     (`const { user: { role } } = req` — caught only as the property path ends in `.user`), or a
 *     spread/rest binding;
 *   - a lookup table indexed by the role (`LEVEL[req.user.role] > 1`) and comparisons against a
 *     role literal that is itself stored in a variable or a constant (`r === ADMIN_ROLE`);
 *   - a Prisma predicate on the role built outside a `where` property or a `…where` /
 *     `…WhereInput` variable (e.g. passed through a helper's return value);
 *   - raw SQL (`$queryRaw` with `role = 'ADMIN'`) — SQL text is a string, not an expression.
 * `permission-site-mapping.test.ts`'s broad handler detector (`user.role` / `role ===`) is the
 * second net for the first group: every such line must be classified in `docs/permissions.md`.
 *
 * ── House form ───────────────────────────────────────────────────────────────────────────────────
 * Pure exports (`findRoleChecks`, `isGatedFile`) are unit-tested against fixture text in
 * `__tests__/lint-role-checks.test.ts`. The walk sits in a named function that calls `readdirSync`
 * itself and the empty walk exits 1, so `lint-guard-vacuity` classifies this file as a proved
 * guard (`empty-abort`). `main()` runs only when this file is the process entry point (Issue #203).
 *
 * Exit codes:
 *   0 — the walk found files and none of them has a finding;
 *   1 — the walk found no file, the allowlisted file is missing, or at least one finding (listed as
 *       `path:line: shape — source text`, sorted).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";

export const SRC_DIR = "apps/api/src";
export const ALLOWLISTED_FILE = "apps/api/src/contexts/platform/compat-role.ts";

const ROLE_LITERALS: ReadonlySet<string> = new Set(["ADMIN", "MANAGER", "EMPLOYEE"]);
const EQUALITY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const MEMBERSHIP_METHODS: ReadonlySet<string> = new Set([
  "includes",
  "indexOf",
  "lastIndexOf",
  "has",
]);
const PRISMA_OPERATORS: ReadonlySet<string> = new Set(["in", "notIn", "equals", "not"]);
const REMOVED_GUARD = "requireRole";

export type RoleCheckShape =
  | "removed-role-guard-call"
  | "role-comparison"
  | "role-switch"
  | "role-membership"
  | "role-where-predicate";

export interface RoleCheckFinding {
  line: number;
  shape: RoleCheckShape;
  text: string;
}

// ── Expression helpers ──────────────────────────────────────────────────────────────────────────

/** Strips parentheses, `as`/`satisfies`/`<T>` casts, `!` and `await` — none changes the value. */
function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e)) e = e.expression;
    else if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    else if (ts.isTypeAssertionExpression(e)) e = e.expression;
    else if (ts.isNonNullExpression(e)) e = e.expression;
    else if (ts.isAwaitExpression(e)) e = e.expression;
    else return e;
  }
}

function isRoleLiteral(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  return (
    (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && ROLE_LITERALS.has(e.text)
  );
}

function propertyNameText(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
    return name.text;
  return undefined;
}

function typeText(type: ts.TypeNode | undefined, sf: ts.SourceFile): string {
  return type ? type.getText(sf).trim() : "";
}

// ── A light lexical binder: name → declaration, per scope node ──────────────────────────────────

interface Binding {
  /** The declaring identifier's node (a VariableDeclaration name, a BindingElement name, a
   * Parameter name). */
  readonly nameNode: ts.Identifier;
}

function isScopeNode(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isFunctionLike(node)
  );
}

function enclosingScope(node: ts.Node): ts.Node {
  let n: ts.Node | undefined = node.parent;
  while (n && !isScopeNode(n)) n = n.parent;
  return n ?? node.getSourceFile();
}

function bindIdentifiers(name: ts.BindingName, into: (id: ts.Identifier) => void): void {
  if (ts.isIdentifier(name)) {
    into(name);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    bindIdentifiers(element.name, into);
  }
}

class Scopes {
  private readonly byScope = new Map<ts.Node, Map<string, Binding>>();

  constructor(sf: ts.SourceFile) {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) {
        const scope = enclosingScope(node.parent); // the VariableDeclarationList's scope
        bindIdentifiers(node.name, (id) => this.add(scope, id));
      } else if (ts.isParameter(node)) {
        const fn = node.parent; // parameters are bound in the function-like node itself
        bindIdentifiers(node.name, (id) => this.add(fn, id));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  private add(scope: ts.Node, id: ts.Identifier): void {
    let names = this.byScope.get(scope);
    if (!names) {
      names = new Map();
      this.byScope.set(scope, names);
    }
    if (!names.has(id.text)) names.set(id.text, { nameNode: id });
  }

  /** The nearest enclosing declaration of `id`'s name, or undefined (a global or an import). */
  resolve(id: ts.Identifier): Binding | undefined {
    for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
      const binding = this.byScope.get(n)?.get(id.text);
      if (binding) return binding;
    }
    return undefined;
  }
}

// ── Role-valued expressions ─────────────────────────────────────────────────────────────────────

class RoleAnalysis {
  private readonly scopes: Scopes;
  private readonly memo = new Map<ts.Identifier, boolean>();

  constructor(private readonly sf: ts.SourceFile) {
    this.scopes = new Scopes(sf);
  }

  isRoleValued(expr: ts.Expression): boolean {
    const e = unwrap(expr);
    if (ts.isPropertyAccessExpression(e)) return e.name.text === "role";
    if (ts.isElementAccessExpression(e)) {
      const arg = unwrap(e.argumentExpression);
      return (
        (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && arg.text === "role"
      );
    }
    if (ts.isIdentifier(e)) {
      const binding = this.scopes.resolve(e);
      return binding ? this.isRoleBinding(binding.nameNode) : false;
    }
    return false;
  }

  private isRoleBinding(nameNode: ts.Identifier): boolean {
    const cached = this.memo.get(nameNode);
    if (cached !== undefined) return cached;
    this.memo.set(nameNode, false); // cycle guard (`const a = b, b = a` cannot recurse forever)
    const result = this.computeRoleBinding(nameNode);
    this.memo.set(nameNode, result);
    return result;
  }

  private computeRoleBinding(nameNode: ts.Identifier): boolean {
    const decl = nameNode.parent;
    if (ts.isVariableDeclaration(decl) && decl.name === nameNode) {
      if (typeText(decl.type, this.sf) === "Role") return true;
      return decl.initializer ? this.isRoleValued(decl.initializer) : false;
    }
    if (ts.isParameter(decl) && decl.name === nameNode) {
      return typeText(decl.type, this.sf) === "Role";
    }
    if (ts.isBindingElement(decl) && decl.name === nameNode) {
      const property = decl.propertyName ? propertyNameText(decl.propertyName) : nameNode.text;
      if (property !== "role") return false;
      return this.isUserPattern(decl.parent);
    }
    return false;
  }

  /** Whether the object being destructured by `pattern` is a user (`user`, `….user`, or a
   * parameter typed `JwtPayload`). */
  private isUserPattern(pattern: ts.BindingPattern): boolean {
    const owner = pattern.parent;
    if (ts.isVariableDeclaration(owner)) {
      if (!owner.initializer) return false;
      const text = unwrap(owner.initializer).getText(this.sf).replace(/\s+/g, "");
      return text === "user" || text.endsWith(".user");
    }
    if (ts.isBindingElement(owner)) {
      const property = owner.propertyName
        ? propertyNameText(owner.propertyName)
        : ts.isIdentifier(owner.name)
          ? owner.name.text
          : undefined;
      return property === "user";
    }
    if (ts.isParameter(owner)) {
      return typeText(owner.type, this.sf) === "JwtPayload";
    }
    return false;
  }
}

// ── Where-context and Prisma operator objects ───────────────────────────────────────────────────

function isWhereContext(node: ts.Node, sf: ts.SourceFile): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isPropertyAssignment(n) && propertyNameText(n.name) === "where") return true;
    if (ts.isVariableDeclaration(n)) {
      const name = ts.isIdentifier(n.name) ? n.name.text : "";
      if (/where$/i.test(name) || /WhereInput\b/.test(typeText(n.type, sf))) return true;
    }
  }
  return false;
}

function holdsRoleLiteral(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (isRoleLiteral(e)) return true;
  if (ts.isArrayLiteralExpression(e)) return e.elements.some((el) => isRoleLiteral(el));
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.some(
      (p) =>
        ts.isPropertyAssignment(p) &&
        PRISMA_OPERATORS.has(propertyNameText(p.name) ?? "") &&
        holdsRoleLiteral(p.initializer),
    );
  }
  return false;
}

function isRoleLiteralCollection(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (ts.isArrayLiteralExpression(e)) return e.elements.some((el) => isRoleLiteral(el));
  if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "Set") {
    const [first] = e.arguments ?? [];
    return first !== undefined && isRoleLiteralCollection(first);
  }
  return false;
}

// ── The pure detector ───────────────────────────────────────────────────────────────────────────

/**
 * Every role check in `sourceText`, one finding per (line, shape), sorted by line. Pure: no file
 * I/O, no knowledge of the allowlist — `isGatedFile` decides which files are read at all.
 */
export function findRoleChecks(fileName: string, sourceText: string): RoleCheckFinding[] {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const analysis = new RoleAnalysis(sf);
  const found = new Map<string, RoleCheckFinding>();

  const report = (node: ts.Node, shape: RoleCheckShape): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const key = `${line}:${shape}`;
    if (found.has(key)) return;
    const text = node.getText(sf).replace(/\s+/g, " ").trim();
    found.set(key, { line, shape, text: text.length > 120 ? `${text.slice(0, 117)}...` : text });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (
        (ts.isIdentifier(callee) && callee.text === REMOVED_GUARD) ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === REMOVED_GUARD)
      ) {
        report(node, "removed-role-guard-call");
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        MEMBERSHIP_METHODS.has(callee.name.text) &&
        ((node.arguments[0] !== undefined && analysis.isRoleValued(node.arguments[0])) ||
          isRoleLiteralCollection(callee.expression))
      ) {
        report(node, "role-membership");
      }
    } else if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
      if (
        (analysis.isRoleValued(node.left) && isRoleLiteral(node.right)) ||
        (isRoleLiteral(node.left) && analysis.isRoleValued(node.right))
      ) {
        report(node, "role-comparison");
      }
    } else if (ts.isSwitchStatement(node)) {
      if (
        analysis.isRoleValued(node.expression) &&
        node.caseBlock.clauses.some((c) => ts.isCaseClause(c) && isRoleLiteral(c.expression))
      ) {
        report(node, "role-switch");
      }
    } else if (
      ts.isPropertyAssignment(node) &&
      propertyNameText(node.name) === "role" &&
      holdsRoleLiteral(node.initializer) &&
      isWhereContext(node, sf)
    ) {
      report(node, "role-where-predicate");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return [...found.values()].sort((a, b) => a.line - b.line || a.shape.localeCompare(b.shape));
}

/**
 * Whether the gate reads `repoRelativePath` at all: a `.ts` file under `apps/api/src`, not in a
 * `__tests__` directory, not a `*.test.ts` file, and not the single allowlisted compat module.
 */
export function isGatedFile(repoRelativePath: string): boolean {
  const p = repoRelativePath.split("\\").join("/");
  if (!p.startsWith(`${SRC_DIR}/`)) return false;
  if (!p.endsWith(".ts") || p.endsWith(".test.ts")) return false;
  if (p.split("/").includes("__tests__")) return false;
  return p !== ALLOWLISTED_FILE;
}

// ── Walk ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every gated file under `apps/api/src`, repo-relative, sorted. A named function that calls
 * `readdirSync` itself (not through an arrow constant) — `lint-guard-vacuity-detect.ts` resolves
 * walk-containing functions by declaration.
 */
export function discoverGatedFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const pending: string[] = [SRC_DIR];
  while (pending.length > 0) {
    const relDir = pending.pop()!;
    for (const entry of readdirSync(join(repoRoot, relDir), { withFileTypes: true })) {
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        pending.push(rel);
      } else if (isGatedFile(rel)) {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

export interface ScanResult {
  files: string[];
  findings: (RoleCheckFinding & { file: string })[];
}

/** Scans the real tree. Pure apart from reading files; the empty-walk abort is `run()`'s job. */
export function scanRepository(repoRoot: string): ScanResult {
  const files = discoverGatedFiles(repoRoot);
  const findings = files.flatMap((file) =>
    findRoleChecks(file, readFileSync(join(repoRoot, file), "utf8")).map((f) => ({ file, ...f })),
  );
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return { files, findings };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

export function run(repoRoot: string): number {
  // Empty-abort: a gate that walked zero files and reported OK would be #229 verbatim. The proof is
  // on the WALKED set (`files`), never on the findings, which this gate wants empty.
  const files = discoverGatedFiles(repoRoot);
  if (files.length === 0) {
    console.error(
      `lint-role-checks: no .ts file found under ${SRC_DIR}/ — the source root moved or the walk broke; check the path, not the count.`,
    );
    process.exit(1);
  }

  if (!existsSync(join(repoRoot, ALLOWLISTED_FILE))) {
    console.error(
      `lint-role-checks: the allowlisted compat module ${ALLOWLISTED_FILE} does not exist. Moving or renaming it needs this gate's ALLOWLISTED_FILE updated in the same change — never a second allowlisted file.`,
    );
    return 1;
  }

  const findings = files.flatMap((file) =>
    findRoleChecks(file, readFileSync(join(repoRoot, file), "utf8")).map((f) => ({ file, ...f })),
  );
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));

  if (findings.length > 0) {
    console.error(
      `lint-role-checks: FAILED — ${findings.length} role check(s) outside ${ALLOWLISTED_FILE} (Issue #75, D-19):`,
    );
    for (const f of findings) console.error(`  ${f.file}:${f.line}: ${f.shape} — ${f.text}`);
    console.error(
      "Convert each access decision to a catalog permission (requirePermission / hasPermission / " +
        "permissionReach / userIdsHoldingPermission from contexts/platform) and map it in " +
        "docs/permissions.md; move a role-literal read that decides nothing behind a helper in " +
        "contexts/platform/compat-role.ts. There is no exceptions file.",
    );
    return 1;
  }

  console.log(
    `lint-role-checks: OK — 0 finding(s) in ${files.length} file(s) under ${SRC_DIR}/ (allowlisted: ${ALLOWLISTED_FILE})`,
  );
  return 0;
}

function main(): void {
  const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
  process.exitCode = run(repoRoot);
}

// Run the scan only when this file is the process entry point — importing it (the fixture test,
// the vacuity gate's classifier) never scans anything (Issue #203).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
