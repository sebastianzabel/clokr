/**
 * Phase 204 Plan 01 — per-function-scope resolution of request-derived names and `req.user`
 * principal aliases for the `lint:tenant-scoping` gate.
 *
 * Consumes an AST built by the CALLER (the TypeScript source-file parser lives in the CLI entry
 * point that plan 04 adds) — this module never parses source text itself, only walks nodes it is
 * handed (D-03: real AST, not regex; the "structurally harder than comment/string disambiguation"
 * problem 204-RESEARCH.md's §Don't Hand-Roll describes).
 *
 * Parameter naming: this codebase's route handlers and helpers use `req` exclusively — measured
 * via `grep -rln 'request\.user\|request\.params\|request\.body\|request\.query'
 * apps/api/src/routes apps/api/src/services` on main @ 708ffbfa, which returns zero matches.
 * `request` is still accepted below (Fastify's own default parameter name, and cheap to support)
 * so this module does not silently regress if that convention is ever adopted.
 *
 * ── enclosingHandler ───────────────────────────────────────────────────────────────────────
 * Climbs from a node through its ancestor chain, tracking the OUTERMOST function-like ancestor
 * that itself declares a `req`/`request` parameter. Nested callback arrows passed to `.map()`,
 * `.filter()`, etc. do not declare their own `req` parameter — they close over the enclosing
 * handler's — so this rule naturally lands on the handler, not the callback. Measured driver:
 * `apps/api/src/routes/time-entries.ts:875` binds `const user = req.user` in the route handler
 * and compares `entry.employee.tenantId !== user.tenantId` at `:884`; a resolver that stopped at
 * the innermost enclosing arrow would lose that binding for any call nested one callback deeper,
 * producing a false positive. When NO ancestor declares `req`/`request` (a pure helper with some
 * other signature), this falls back to the outermost function-like ancestor found at all —
 * `apps/api/src/services/clock/audit-actor.ts:17`'s `resolveActor(req: FastifyRequest | ...)` is
 * the module-scope-helper case this is built for, and it DOES declare `req`, so it resolves via
 * the primary rule; the fallback exists for the rarer helper that takes an already-fetched entity
 * instead of `req` directly.
 *
 * ── collectRequestBindings ─────────────────────────────────────────────────────────────────
 * Walks the given function's own body ONLY — it does not descend into further-nested function
 * bodies, so a name declared inside a callback does not leak into the outer scope's bindings, and
 * it does not ascend past `fn`, so outer-scope bindings are exactly what `enclosingHandler`
 * decided belong to this call. Recognizes, in one linear pass over the body in source order (so
 * that the one-hop propagation rule can see an already-classified name from an earlier
 * statement):
 *   - `req.params` / `req.query` / `req.body`, optionally `as {...}`, optionally wrapped in
 *     `<schema>.parse(...)` — apps/api/src/routes/time-entries.ts:677 (cast) and :1524
 *     (`idParamSchema.parse`), apps/api/src/routes/employees.ts:1367 (`deviceIdParamSchema.parse`).
 *   - `req.user` / `req.user.<field>` — apps/api/src/routes/time-entries.ts:875 (`const user =
 *     req.user`) and apps/api/src/routes/shifts.ts:786 (`const tenantId = req.user.tenantId`).
 *   - One-hop propagation: `const x = <alreadyClientSupplied>.<prop>` or
 *     `const x = <alreadyClientSupplied>`. No deeper data-flow — one hop is what
 *     204-RESEARCH.md's §Client-Supplied Identifier Idiom measured; more would be speculation.
 */
import * as ts from "typescript";
import type { RequestBindings, PrincipalField } from "./lint-tenant-scoping-types";
import { PRINCIPAL_FIELDS } from "./lint-tenant-scoping-types";

const REQUEST_PARAM_NAMES = new Set(["req", "request"]);

function isRequestIdentifier(node: ts.Node): node is ts.Identifier {
  return ts.isIdentifier(node) && REQUEST_PARAM_NAMES.has(node.text);
}

function isPrincipalFieldName(name: string): name is PrincipalField {
  return (PRINCIPAL_FIELDS as readonly string[]).includes(name);
}

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

function isFunctionLikeNode(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function declaresRequestParam(fn: FunctionLike): boolean {
  return fn.parameters.some((p) => ts.isIdentifier(p.name) && REQUEST_PARAM_NAMES.has(p.name.text));
}

/**
 * Walks UP from `node` to the nearest enclosing function that is a request handler or a
 * module-scope function — deliberately SKIPPING nested callback arrows. See the module header
 * for the full rule and its measured driver.
 */
export function enclosingHandler(node: ts.Node, _sourceFile: ts.SourceFile): ts.Node {
  let current: ts.Node | undefined = node;
  let lastWithRequestParam: FunctionLike | undefined;
  let outermost: FunctionLike | undefined;

  while (current) {
    if (isFunctionLikeNode(current)) {
      outermost = current;
      if (declaresRequestParam(current)) {
        lastWithRequestParam = current;
      }
    }
    current = current.parent;
  }

  return lastWithRequestParam ?? outermost ?? node;
}

// ── Recognizing request-derived expression shapes ─────────────────────────────────────────────

/** Unwraps `X as T` and `<schema>.parse(X)` (in either order) down to the underlying expression. */
function unwrapToSource(expr: ts.Expression): ts.Expression {
  let current: ts.Expression = expr;

  if (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    current.expression.name.text === "parse" &&
    current.arguments.length === 1
  ) {
    current = current.arguments[0];
  }

  if (ts.isAsExpression(current)) {
    current = current.expression;
  }

  return current;
}

const REQUEST_PART_NAMES = new Set(["params", "query", "body"]);

/** `req.params` / `req.query` / `req.body` -> "params" | "query" | "body"; otherwise null. */
function matchRequestPart(expr: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expr) && isRequestIdentifier(expr.expression)) {
    if (REQUEST_PART_NAMES.has(expr.name.text)) return expr.name.text;
  }
  return null;
}

/** `req.user` (the whole principal object). */
function isRequestUserExpr(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    isRequestIdentifier(expr.expression) &&
    expr.name.text === "user"
  );
}

/** `req.user.<field>` -> "<field>"; otherwise null. */
function matchRequestUserField(expr: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expr) && isRequestUserExpr(expr.expression)) {
    return expr.name.text;
  }
  return null;
}

function addBindingNamesAsClientSupplied(nameNode: ts.BindingName, target: Set<string>): void {
  if (ts.isIdentifier(nameNode)) {
    target.add(nameNode.text);
    return;
  }
  if (ts.isObjectBindingPattern(nameNode)) {
    for (const element of nameNode.elements) {
      if (ts.isIdentifier(element.name)) target.add(element.name.text);
    }
  }
  // Array destructuring of req.params/query/body is not an idiom measured in this repo (D-12
  // research) — deliberately not handled, matching the "no deeper data-flow" scope of this module.
}

function collectPrincipalFieldsFromDestructure(
  nameNode: ts.ObjectBindingPattern,
  target: Map<string, PrincipalField>,
): void {
  for (const element of nameNode.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const localName = element.name.text;
    const sourceField =
      element.propertyName && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : localName;
    if (isPrincipalFieldName(sourceField)) {
      target.set(localName, sourceField);
    }
  }
}

function getFunctionBody(fn: ts.Node): ts.Node | undefined {
  if (isFunctionLikeNode(fn)) return fn.body;
  return undefined;
}

/** Collects, for ONE function scope, every name that came from the request. */
export function collectRequestBindings(fn: ts.Node, _sourceFile: ts.SourceFile): RequestBindings {
  const clientSupplied = new Set<string>();
  const principalObjects = new Set<string>();
  const principalFields = new Map<string, PrincipalField>();

  function isClientSuppliedExpr(expr: ts.Expression): boolean {
    if (ts.isIdentifier(expr)) return clientSupplied.has(expr.text);
    if (ts.isPropertyAccessExpression(expr)) return isClientSuppliedExpr(expr.expression);
    return false;
  }

  function handleDeclaration(decl: ts.VariableDeclaration): void {
    if (!decl.initializer) return;
    const source = unwrapToSource(decl.initializer);

    const requestPart = matchRequestPart(source);
    if (requestPart) {
      addBindingNamesAsClientSupplied(decl.name, clientSupplied);
      return;
    }

    if (isRequestUserExpr(source)) {
      if (ts.isIdentifier(decl.name)) {
        principalObjects.add(decl.name.text);
      } else if (ts.isObjectBindingPattern(decl.name)) {
        collectPrincipalFieldsFromDestructure(decl.name, principalFields);
      }
      return;
    }

    const userField = matchRequestUserField(source);
    if (userField && isPrincipalFieldName(userField) && ts.isIdentifier(decl.name)) {
      principalFields.set(decl.name.text, userField);
      return;
    }

    if (ts.isIdentifier(decl.name) && isClientSuppliedExpr(source)) {
      clientSupplied.add(decl.name.text);
    }
  }

  function visit(node: ts.Node, isRoot: boolean): void {
    if (!isRoot && isFunctionLikeNode(node)) return; // do not descend into nested closures
    if (ts.isVariableDeclaration(node)) handleDeclaration(node);
    ts.forEachChild(node, (child) => visit(child, false));
  }

  const body = getFunctionBody(fn);
  if (body) visit(body, true);

  return { clientSupplied, principalObjects, principalFields };
}

/** Resolves an expression to the principal field it reads, or null. */
export function isPrincipalExpression(
  expr: ts.Expression,
  bindings: RequestBindings,
  _sourceFile: ts.SourceFile,
): PrincipalField | null {
  if (ts.isPropertyAccessExpression(expr)) {
    const field = expr.name.text;
    if (!isPrincipalFieldName(field)) return null;

    // req.user.<field>
    if (isRequestUserExpr(expr.expression)) return field;

    // <principalObjectAlias>.<field>, e.g. `user.tenantId` after `const user = req.user`.
    if (ts.isIdentifier(expr.expression) && bindings.principalObjects.has(expr.expression.text)) {
      return field;
    }
    return null;
  }

  // A bare name that was itself bound to a principal field, e.g. `tid` after
  // `const tid = req.user.tenantId`.
  if (ts.isIdentifier(expr)) {
    return bindings.principalFields.get(expr.text) ?? null;
  }

  return null;
}
