/**
 * Phase 88 Plan 04 - the nullish-tenant rule of the `lint:tenant-scoping` gate (GitHub Issue #88,
 * D-08 c, D-08a).
 *
 * ── Why this rule exists ──────────────────────────────────────────────────────────────────────
 * Prisma DROPS a filter whose value is `undefined`: `findMany({ where: { tenantId: undefined } })`
 * is `findMany({ where: {} })` and returns every tenant's rows. With an operator account above the
 * tenant (Issue #88) a missing tenant context is a normal, reachable state instead of an
 * impossible one, so "an optional tenant id reaches a query" has to fail CI rather than rely on
 * review. The precedent is `contexts/absence/api/leave.ts` (around :1786-1789), where an undefined
 * filter made a read return all tenants.
 *
 * This module EXTENDS the existing gate (D-08a): `lint-tenant-scoping.ts` `runLint` calls it,
 * merges the findings into its result and its exit code, and consults the same exceptions file. It
 * is not a parallel gate, and it does not change the original client-supplied-identifier rule.
 *
 * ── Scope ─────────────────────────────────────────────────────────────────────────────────────
 * Every `.ts` file under `apps/api/src` except `__tests__` directories and `*.test.ts` - NOT only
 * `SCOPED_DIRS`, because plugins, middleware and jobs build tenant filters too. Every Prisma model
 * call counts, all methods, and every `tenantId` property is checked at any depth of the call's
 * argument (a `where`, a relation filter, a `data` payload). A call is recognised by its SHAPE -
 * `<base>.<model>.<method>(...)` with a Prisma model method and EITHER a delegate name from the
 * schema (DMMF, any base) OR a client base by name (`db`, `prisma`, `tx`, `<x>.prisma`, any model).
 * An object literal bound to a local `const` and passed as `where`/`data` is followed.
 *
 * ── The four rules ────────────────────────────────────────────────────────────────────────────
 * The value of a `tenantId` property is flagged when it can be undefined:
 *   R1  the literal `undefined` or `void 0` (also on the right of `??` / `||`).
 *   R2  an optional chain (`a?.b.tenantId`, `a?.[k]`) without a non-nullish `??` fallback.
 *   R3  a conditional or short-circuit expression with a nullish branch (`c ? id : undefined`,
 *       `c && id`).
 *   R4  an identifier or shorthand bound to a parameter declared optional (`tenantId?: string`) or
 *       annotated with `undefined` (`string | undefined`) in an enclosing function, including a
 *       destructured parameter whose inline type (or a same-file interface/type alias) makes the
 *       property optional; and, one step further, a local `const` whose initializer is itself
 *       flagged by R1-R3 or whose annotation includes `undefined`.
 *
 * ── What is legal, and why ────────────────────────────────────────────────────────────────────
 *   - `x?.tenantId ?? ""` : the fail-closed idiom. The empty string matches no tenant, so a missing
 *     value returns nothing instead of everything (25+ occurrences in the tree).
 *   - `req.user.tenantId`, a required `string` parameter, a non-nullish literal, a non-null
 *     assertion (`x!`).
 *   - A flagged identifier that is NARROWED before the call: inside `if (tenantId) { ... }`, inside
 *     the true branch of `tenantId ? ... : ...` or after `tenantId && ...`, or after an earlier
 *     `if (!tenantId) return/throw/continue/break`. This is a syntactic approximation of control
 *     flow, deliberately conservative toward "narrowed".
 *   - `tenantId: null` : left to the TypeScript compiler. A required column rejects null at compile
 *     time and `AccessRole.tenantId` is nullable on purpose (platform-wide roles), where filtering
 *     on null is the meaning.
 *
 * ── The honest limit ──────────────────────────────────────────────────────────────────────────
 * This is a SYNTACTIC check. A variable whose `string | undefined` type is only INFERRED - the
 * return value of a call, a property of an unannotated object, a destructured field of an
 * interface declared in another file - is invisible to it. That class is covered at runtime by the
 * interceptor sweep of Plan 88-13, not here. A green run of this rule means "no nullish tenant id
 * is visible in the source text", not "none can happen".
 *
 * ── Exceptions ────────────────────────────────────────────────────────────────────────────────
 * Same exceptions file as the original rule, but an entry only silences nullish findings when it
 * says `"rule": "nullish-tenant"` explicitly (see `lint-tenant-scoping-exceptions.ts`). A hit on a
 * clean tree is a finding to fix at its source (use a required tenant id or the `?? ""` idiom),
 * not an exception to add.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { buildModelGraph } from "./lint-tenant-scoping-model-graph";
import { EXCLUDED_DIR_SEGMENT } from "./lint-tenant-scoping-types";

// ── Public types ───────────────────────────────────────────────────────────────────────────────

export type NullishRule = "R1" | "R2" | "R3" | "R4";

export type NullishTenantFinding = {
  /** Repo-relative path, forward slashes. */
  file: string;
  /** 1-based line of the offending `tenantId` value. */
  line: number;
  /** Prisma delegate name, e.g. "employee". */
  model: string;
  /** Prisma method name, e.g. "findMany". */
  method: string;
  rule: NullishRule;
  detail: string;
};

export type NullishScanResult = { calls: number; findings: NullishTenantFinding[] };

/** The repo-relative root of the walk. */
export const NULLISH_SCAN_ROOT = "apps/api/src";

/** Every method of a Prisma model delegate. */
const MODEL_METHODS: ReadonlySet<string> = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);

let cachedDelegates: ReadonlySet<string> | null = null;

/** Delegate names (camelCase) of every schema model, from the live DMMF. */
function modelDelegates(): ReadonlySet<string> {
  if (!cachedDelegates) cachedDelegates = new Set(buildModelGraph().keys());
  return cachedDelegates;
}

// ── File walk ──────────────────────────────────────────────────────────────────────────────────

/**
 * Every non-test `.ts` file under `apps/api/src`. An empty or missing walk throws: a scan that
 * looked at nothing is indistinguishable from a clean tree (same rule as `listScopedFiles`).
 */
export function listNullishScanFiles(repoRoot: string): string[] {
  const rootAbs = path.join(repoRoot, NULLISH_SCAN_ROOT);
  if (!fs.existsSync(rootAbs)) {
    throw new Error(
      `lint-tenant-scoping nullish-tenant: scan root "${NULLISH_SCAN_ROOT}" does not exist on disk. ` +
        `A path pointing nowhere is a defect, not "all clean".`,
    );
  }
  const out: string[] = [];
  const walk = (absDir: string): void => {
    for (const entry of fs.readdirSync(absDir)) {
      const full = path.join(absDir, entry);
      if (fs.statSync(full).isDirectory()) {
        if (entry === EXCLUDED_DIR_SEGMENT) continue;
        walk(full);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  };
  walk(rootAbs);
  if (out.length === 0) {
    throw new Error(
      `lint-tenant-scoping nullish-tenant: the walk under "${NULLISH_SCAN_ROOT}" found no .ts ` +
        `files. A gate that finds nothing because it looked at nothing is not "all clean".`,
    );
  }
  return out.map((abs) => path.relative(repoRoot, abs).split(path.sep).join("/"));
}

// ── Syntax helpers ─────────────────────────────────────────────────────────────────────────────

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** Strips parentheses, `as`, `satisfies`, type assertions - they never change nullishness. */
function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current)) current = current.expression;
    else if (ts.isSatisfiesExpression(current)) current = current.expression;
    else if (ts.isTypeAssertionExpression(current)) current = current.expression;
    else return current;
  }
}

function isUndefinedLiteral(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr) && expr.text === "undefined") return true;
  return ts.isVoidExpression(expr);
}

/** Does a type node mention `undefined` at its top level (union member or the keyword itself)? */
function typeIncludesUndefined(type: ts.TypeNode | undefined): boolean {
  if (!type) return false;
  if (type.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  if (ts.isParenthesizedTypeNode(type)) return typeIncludesUndefined(type.type);
  if (ts.isUnionTypeNode(type)) return type.types.some(typeIncludesUndefined);
  if (ts.isLiteralTypeNode(type)) return type.literal.kind === ts.SyntaxKind.UndefinedKeyword;
  return false;
}

function referencesName(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Does this statement unconditionally leave the enclosing block? */
function terminates(stmt: ts.Statement): boolean {
  if (
    ts.isReturnStatement(stmt) ||
    ts.isThrowStatement(stmt) ||
    ts.isContinueStatement(stmt) ||
    ts.isBreakStatement(stmt)
  ) {
    return true;
  }
  if (ts.isBlock(stmt)) {
    const last = stmt.statements[stmt.statements.length - 1];
    return last !== undefined && terminates(last);
  }
  return false;
}

/**
 * Is `ident` (a use of `name`) narrowed to non-nullish by a guard that dominates it? A syntactic
 * approximation, intentionally conservative toward "narrowed" - see the module header.
 */
function isNarrowed(ident: ts.Node, name: string): boolean {
  let child: ts.Node = ident;
  let parent: ts.Node | undefined = ident.parent;
  while (parent) {
    if (ts.isIfStatement(parent) && child === parent.thenStatement) {
      if (referencesName(parent.expression, name)) return true;
    }
    if (ts.isConditionalExpression(parent) && child === parent.whenTrue) {
      if (referencesName(parent.condition, name)) return true;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      child === parent.right
    ) {
      if (referencesName(parent.left, name)) return true;
    }
    // An earlier sibling `if (...name...) { ...return/throw }` in the same statement list.
    if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent)) {
      const stmts = parent.statements;
      const idx = stmts.findIndex((s) => s === child);
      for (let i = 0; i < idx; i += 1) {
        const s = stmts[i];
        if (
          ts.isIfStatement(s) &&
          !s.elseStatement &&
          terminates(s.thenStatement) &&
          referencesName(s.expression, name)
        ) {
          return true;
        }
      }
    }
    if (isFunctionLike(parent)) return false;
    child = parent;
    parent = parent.parent;
  }
  return false;
}

// ── Nullish evaluation ─────────────────────────────────────────────────────────────────────────

type Ctx = { sourceFile: ts.SourceFile; depth: number };

const MAX_DEPTH = 3;

function enclosingFunctions(node: ts.Node): FunctionLike[] {
  const out: FunctionLike[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionLike(current)) out.push(current);
    current = current.parent;
  }
  return out;
}

/** The `const`/`let` declaration of `name` directly in `body`, not descending into closures. */
function findLocalDeclaration(name: string, body: ts.Node): ts.VariableDeclaration | null {
  let found: ts.VariableDeclaration | null = null;
  const visit = (node: ts.Node, isRoot: boolean): void => {
    if (found) return;
    if (!isRoot && isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, (c) => visit(c, false));
  };
  visit(body, true);
  return found;
}

function findParameter(fn: FunctionLike, name: string): ts.ParameterDeclaration | null {
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name) && p.name.text === name) return p;
  }
  return null;
}

/** The parameter whose object binding pattern declares `name`, plus the binding element. */
function findBindingParameter(
  fn: FunctionLike,
  name: string,
): { param: ts.ParameterDeclaration; element: ts.BindingElement } | null {
  for (const p of fn.parameters) {
    if (!ts.isObjectBindingPattern(p.name)) continue;
    for (const el of p.name.elements) {
      if (ts.isIdentifier(el.name) && el.name.text === name) return { param: p, element: el };
    }
  }
  return null;
}

/** Resolves an inline type literal, or a same-file interface / type alias, to its members. */
function typeMembers(
  type: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
): readonly ts.TypeElement[] | null {
  if (!type) return null;
  if (ts.isTypeLiteralNode(type)) return type.members;
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    const refName = type.typeName.text;
    for (const stmt of sourceFile.statements) {
      if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === refName) return stmt.members;
      if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === refName) {
        return ts.isTypeLiteralNode(stmt.type) ? stmt.type.members : null;
      }
    }
  }
  return null;
}

function memberAllowsUndefined(members: readonly ts.TypeElement[], property: string): boolean {
  for (const m of members) {
    if (!ts.isPropertySignature(m)) continue;
    const key = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : null;
    if (key !== property) continue;
    return m.questionToken !== undefined || typeIncludesUndefined(m.type);
  }
  return false;
}

/** Rule found when an identifier use can be undefined, or null. */
function identifierNullish(ident: ts.Identifier, ctx: Ctx): NullishRule | null {
  const name = ident.text;
  if (name === "undefined") return "R1";
  if (ctx.depth > MAX_DEPTH) return null;
  for (const fn of enclosingFunctions(ident)) {
    const local = fn.body ? findLocalDeclaration(name, fn.body) : null;
    if (local) {
      const nullish =
        typeIncludesUndefined(local.type) ||
        (local.type === undefined &&
          local.initializer !== undefined &&
          expressionNullish(local.initializer, { ...ctx, depth: ctx.depth + 1 }) !== null);
      return nullish && !isNarrowed(ident, name) ? "R4" : null;
    }
    const param = findParameter(fn, name);
    if (param) {
      const nullish =
        param.initializer === undefined &&
        (param.questionToken !== undefined || typeIncludesUndefined(param.type));
      return nullish && !isNarrowed(ident, name) ? "R4" : null;
    }
    const binding = findBindingParameter(fn, name);
    if (binding) {
      if (binding.element.initializer !== undefined) return null;
      const members = typeMembers(binding.param.type, ctx.sourceFile);
      const prop =
        binding.element.propertyName &&
        (ts.isIdentifier(binding.element.propertyName) ||
          ts.isStringLiteral(binding.element.propertyName))
          ? binding.element.propertyName.text
          : name;
      const nullish = members !== null && memberAllowsUndefined(members, prop);
      return nullish && !isNarrowed(ident, name) ? "R4" : null;
    }
  }
  return null;
}

/** The rule that makes `expr` possibly undefined, or null when it cannot be (as far as we see). */
function expressionNullish(expr: ts.Expression, ctx: Ctx): NullishRule | null {
  const e = unwrap(expr);
  if (isUndefinedLiteral(e)) return "R1";
  if (ts.isNonNullExpression(e)) return null;
  if (ts.isOptionalChain(e)) return "R2";
  if (ts.isIdentifier(e)) return identifierNullish(e, ctx);
  if (ts.isConditionalExpression(e)) {
    const a = expressionNullish(e.whenTrue, ctx);
    const b = expressionNullish(e.whenFalse, ctx);
    return a || b ? "R3" : null;
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      // The result is nullish only when the fallback is.
      return expressionNullish(e.right, ctx);
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return "R3";
  }
  return null;
}

// ── Prisma call discovery and the scan ─────────────────────────────────────────────────────────

function propertyKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** An object literal bound to a local `const` of the enclosing functions, or null. */
function resolveLocalObjectLiteral(ident: ts.Identifier): ts.ObjectLiteralExpression | null {
  for (const fn of enclosingFunctions(ident)) {
    const decl = fn.body ? findLocalDeclaration(ident.text, fn.body) : null;
    if (decl) {
      if (!decl.initializer) return null;
      const init = unwrap(decl.initializer);
      return ts.isObjectLiteralExpression(init) ? init : null;
    }
  }
  return null;
}

const CLIENT_BASE_IDENTIFIERS = new Set(["db", "prisma", "tx"]);

/**
 * Is this expression a Prisma client or transaction handle by name: `db`, `prisma`, `tx` or any
 * `<x>.prisma` (`app.prisma`, `scopeApp.prisma`, ...)? Together with the schema delegate names this
 * recognises a model call whichever way it is spelled, including a model the generated client does
 * not know (a stale fixture, a renamed model).
 */
function isPrismaClientBase(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return CLIENT_BASE_IDENTIFIERS.has(expr.text);
  return ts.isPropertyAccessExpression(expr) && expr.name.text === "prisma";
}

const RULE_TEXT: Record<NullishRule, string> = {
  R1: "the value is the literal undefined",
  R2: "optional chain without a non-nullish '??' fallback",
  R3: "conditional or short-circuit expression with a nullish branch",
  R4: "bound to an optional or undefined-typed parameter or local",
};

function scan(sourceFile: ts.SourceFile, relPath: string): NullishScanResult {
  const delegates = modelDelegates();
  const findings: NullishTenantFinding[] = [];
  let calls = 0;

  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const checkValue = (
    valueNode: ts.Expression,
    at: ts.Node,
    model: string,
    method: string,
  ): void => {
    const rule = expressionNullish(valueNode, { sourceFile, depth: 0 });
    if (!rule) return;
    findings.push({
      file: relPath,
      line: lineOf(at),
      model,
      method,
      rule,
      detail:
        `nullish-tenant ${rule}: \`tenantId\` can be undefined here (${RULE_TEXT[rule]}) - ` +
        `Prisma drops an undefined filter and the query would match every tenant. Use a ` +
        `required tenant id or the fail-closed \`?? ""\` idiom.`,
    });
  };

  const visitArgument = (root: ts.Node, model: string, method: string): void => {
    const seen = new Set<ts.Node>();
    const visit = (node: ts.Node): void => {
      if (seen.has(node)) return;
      seen.add(node);
      if (ts.isPropertyAssignment(node)) {
        if (propertyKey(node.name) === "tenantId")
          checkValue(node.initializer, node, model, method);
        // A property whose value is a local object literal: follow it.
        const init = unwrap(node.initializer);
        if (ts.isIdentifier(init)) {
          const lit = resolveLocalObjectLiteral(init);
          if (lit) visit(lit);
        }
      } else if (ts.isShorthandPropertyAssignment(node)) {
        if (node.name.text === "tenantId") checkValue(node.name, node, model, method);
        const lit = resolveLocalObjectLiteral(node.name);
        if (lit) visit(lit);
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    // `findMany(options)` with a local options object.
    if (ts.isIdentifier(root)) {
      const lit = resolveLocalObjectLiteral(root);
      if (lit) visit(lit);
    }
  };

  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodAccess = node.expression;
      const modelAccess = methodAccess.expression;
      if (
        MODEL_METHODS.has(methodAccess.name.text) &&
        ts.isPropertyAccessExpression(modelAccess) &&
        (delegates.has(modelAccess.name.text) || isPrismaClientBase(modelAccess.expression))
      ) {
        calls += 1;
        const first = node.arguments[0];
        if (first) visitArgument(first, modelAccess.name.text, methodAccess.name.text);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);

  return { calls, findings };
}

/** Scans one parsed file; also reports how many Prisma model calls it saw (anti-vacuity). */
export function scanNullishTenantSource(
  sourceFile: ts.SourceFile,
  repoRelativePath: string,
): NullishScanResult {
  return scan(sourceFile, repoRelativePath);
}

/**
 * The findings of one parsed file. When `stats` is given, the number of Prisma model calls the
 * scan saw is added to `stats.calls` - the anti-vacuity count `runLint` checks.
 */
export function findNullishTenantValues(
  sourceFile: ts.SourceFile,
  repoRelativePath: string,
  stats?: { calls: number },
): NullishTenantFinding[] {
  const result = scan(sourceFile, repoRelativePath);
  if (stats) stats.calls += result.calls;
  return result.findings;
}
