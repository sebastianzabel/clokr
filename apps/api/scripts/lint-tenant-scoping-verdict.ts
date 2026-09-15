/**
 * Phase 204 Plan 03 — D-13's three-way scoping recognition for the `lint:tenant-scoping` gate
 * (GitHub Issue #204).
 *
 * ── What this replaces, and why (D-04 -> D-13) ────────────────────────────────────────────────
 * D-04, as literally written, names two checks: "where contains tenantId" and "where carries a
 * constraining relation filter". Measured on `main` @ `708ffbfa`, restricted to the 211 D-14
 * candidates (see lint-tenant-scoping-candidates.ts): only 62 of those 211 satisfy D-04 directly.
 * The remaining 149 are NOT unscoped — 93 pass by a same-scope comparison against `req.user`
 * before any write ("fetch-then-compare", the dominant idiom of this codebase, named in a real
 * code comment at apps/api/src/routes/time-entries.ts:687: "fetch-then-compare per D-02"), and 26
 * pass by a guard-fetch (a tenant-scoped `findFirst` of the SAME id, a not-found return, THEN an
 * unscoped write on that same id — apps/api/src/routes/shifts.ts:704-737 is the canonical
 * example). A gate that only implements D-04's two checks flags 149 of 211 candidates on a tree
 * the ticket calls clean — a gate that flags this codebase's dominant idiom would be switched off
 * or buried under an exception list, and either outcome makes it worthless.
 *
 * `inline-principal-field` (D-13 way 1's sub-form for a principal field other than `tenantId`,
 * e.g. `where: { id, userId: req.user.sub }` at apps/api/src/routes/notifications.ts:28) is NOT a
 * fourth way — it is D-13 way (1) applied to a STRICTLY TIGHTER constraint than a tenant filter:
 * an Employee belongs to exactly one Tenant, and a User to exactly one Employee, so scoping to
 * `employeeId` or `sub` can only narrow the result set further than scoping to `tenantId` would,
 * never widen it across a tenant boundary. This mirrors `PRINCIPAL_FIELDS`'s own reasoning in
 * lint-tenant-scoping-types.ts.
 *
 * ── What is KNOWINGLY not recognised (D-16) ───────────────────────────────────────────────────
 * Shape 7 — chained validation ACROSS model boundaries — is deliberately NOT one of the three
 * ways below. Example: `apps/api/src/routes/time-entries.ts:1811` and `:2243`,
 * `break.deleteMany({ where: { timeEntryId: id } })`, where `id` was already validated against
 * `TimeEntry` (a DIFFERENT model, via fetch-then-compare) earlier in the same function. `Break`
 * has no own `tenantId` and is two relation-hops from a tenant-bearing model
 * (`Break.timeEntry.employee.tenantId`). Recognising this would require data-flow reasoning
 * across model boundaries, which D-16 explicitly declines in favour of named exceptions with a
 * reason pointing at the earlier validating call — cheaper to build, and more auditable than a
 * heuristic whose correctness a reader has to take on faith. `reachVerdict`'s NOT-scoped detail
 * names D-16 explicitly so whoever writes that exception knows the miss is expected, not a bug in
 * this gate (see the final branch of `reachVerdict` below).
 *
 * This module performs no file walking and no reporting (that is plan 04's CLI entry point). It
 * is a pure decision function: given one candidate call, its enclosing handler, the model graph
 * and the request bindings, decide whether the call is tenant-scoped and by which of the three
 * D-13 ways.
 */
import * as ts from "typescript";
import type { ModelGraph, RequestBindings, Verdict, PrismaCall } from "./lint-tenant-scoping-types";
import { PRINCIPAL_FIELDS } from "./lint-tenant-scoping-types";
import { isPrincipalExpression } from "./lint-tenant-scoping-request-bindings";
import { findPrismaCalls } from "./lint-tenant-scoping-candidates";

type ScopedVerdict = Extract<Verdict, { scoped: true }>;

// ── Shared node-shape helpers ──────────────────────────────────────────────────────────────

/**
 * Property keys accepted as candidates for D-13 way (1)/(1'). Restricted to these names —
 * rather than accepting ANY property whose value resolves through `isPrincipalExpression` —
 * so an incidental match (e.g. a `note` field that happens to hold a principal value) can never
 * be mistaken for an intentional tenant constraint. `userId` maps to the `sub` principal field:
 * confirmed via `grep -n 'userId: req.user.sub' apps/api/src/routes/*.ts`
 * (apps/api/src/routes/employees.ts:459 and 20+ further occurrences).
 */
const ACCEPTED_KEY_NAMES = new Set<string>([...PRINCIPAL_FIELDS, "userId"]);

function getRootIdentifier(expr: ts.Expression): ts.Identifier | null {
  let current: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current : null;
}

/** Extracts `{ model, method }` off a Prisma delegate call, mirroring `findPrismaCalls`'s own shape check. */
function getCallModelAndMethod(node: ts.CallExpression): { model: string; method: string } | null {
  const methodAccess = node.expression;
  if (!ts.isPropertyAccessExpression(methodAccess)) return null;
  const modelAccess = methodAccess.expression;
  if (!ts.isPropertyAccessExpression(modelAccess)) return null;
  return { model: modelAccess.name.text, method: methodAccess.name.text };
}

// ── D-13 way (1) and (2): inline scoping ──────────────────────────────────────────────────────

/**
 * D-13 ways (1) and (2): does the `where` clause itself constrain to the caller's tenant?
 * Returns null when it does not — NOT `false`, so the caller can try the other ways.
 *
 * Walks the `where` object literal's property tree through plain nested
 * `ObjectLiteralExpression`s and through `AND: [...]` array elements ONLY. `NOT:` and `OR:` are
 * deliberately NOT descended into: a `tenantId` key nested inside either does not necessarily
 * constrain every result the query can return (T-204-16) — e.g. `OR: [{ tenantId: x }, { id: y }]`
 * does not require `tenantId` to match at all. Implementing full boolean reasoning over
 * arbitrary `where` trees is disproportionate to what this codebase's measured idiom needs
 * (204-RESEARCH.md §Architecture Patterns Shapes 1/2/2b are all plain nested objects or `AND`).
 */
export function findInlineScoping(
  whereArg: ts.Expression | null,
  model: string,
  graph: ModelGraph,
  bindings: RequestBindings,
  sourceFile: ts.SourceFile,
): ScopedVerdict | null {
  // A model with no tenant relevance at all (kind: "none") needs no scoping. On `main`,
  // `Tenant` itself is the only such model (see lint-tenant-scoping-model-graph.ts's header for
  // why it is excluded from the BFS rather than falling out of it) — stated here so this branch
  // is not mistaken for a loophole that could silently swallow a mis-classified model.
  const tenancy = graph.get(model);
  if (tenancy && tenancy.kind === "none") {
    return {
      scoped: true,
      via: "inline-tenant-id",
      detail: `model '${model}' has no tenant relevance (ModelTenancy: none) — no scoping required`,
    };
  }

  if (!whereArg || !ts.isObjectLiteralExpression(whereArg)) return null;

  type Acceptance = { field: string; depth: number; path: readonly string[] };

  function walk(
    objLit: ts.ObjectLiteralExpression,
    depth: number,
    path: readonly string[],
  ): Acceptance | null {
    for (const prop of objLit.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        const name = prop.name.text;

        if (name === "NOT" || name === "OR") continue; // T-204-16: never descend

        if (name === "AND" && ts.isArrayLiteralExpression(prop.initializer)) {
          for (const element of prop.initializer.elements) {
            if (ts.isObjectLiteralExpression(element)) {
              const nested = walk(element, depth, path); // AND does not add a depth hop
              if (nested) return nested;
            }
          }
          continue;
        }

        if (ACCEPTED_KEY_NAMES.has(name)) {
          const field = isPrincipalExpression(prop.initializer, bindings, sourceFile);
          if (field) return { field, depth, path };
          continue;
        }

        if (ts.isObjectLiteralExpression(prop.initializer)) {
          const nested = walk(prop.initializer, depth + 1, [...path, name]);
          if (nested) return nested;
        }
        continue;
      }

      if (ts.isShorthandPropertyAssignment(prop)) {
        const name = prop.name.text;
        if (ACCEPTED_KEY_NAMES.has(name)) {
          const field = isPrincipalExpression(prop.name, bindings, sourceFile);
          if (field) return { field, depth, path };
        }
      }
    }
    return null;
  }

  const accepted = walk(whereArg, 0, []);
  if (!accepted) return null;

  if (accepted.depth === 0 && accepted.field === "tenantId") {
    return {
      scoped: true,
      via: "inline-tenant-id",
      detail: `where.tenantId constrained to req.user.tenantId`,
    };
  }

  if (accepted.depth === 0) {
    return {
      scoped: true,
      via: "inline-principal-field",
      detail: `where constrained on principal field '${accepted.field}' (strictly tighter than tenantId)`,
    };
  }

  // depth >= 1: reached through one or more relation properties. Cross-check the traversed path
  // against the model's own ModelTenancy.path for auditability — a mismatch is NOT an automatic
  // rejection (a model may have more than one valid path to a tenant-bearing model), but the
  // traversed path is always recorded in `detail` so the report stays reviewable.
  const graphPath = tenancy && tenancy.kind === "relation" ? tenancy.path.join(".") : "<none>";
  return {
    scoped: true,
    via: "inline-relation-filter",
    detail: `where constrained via relation path [${accepted.path.join(".")}] on principal field '${accepted.field}' (model graph path: [${graphPath}])`,
  };
}

// ── D-13 way (3): same-scope recognition ──────────────────────────────────────────────────────

const MUTATING_METHODS = new Set(["update", "delete", "deleteMany", "updateMany"]);
const FETCH_METHODS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow"]);

/**
 * Collects every identifier this `where` argument touches that is NOT a principal read — used
 * to prove two Prisma calls constrain on the SAME client-supplied value (the "shared identifier"
 * requirement below), not merely that a tenant check exists somewhere in the function
 * (T-204-11's canonical false negative). Mirrors `classifyProvenance`'s walk in
 * lint-tenant-scoping-candidates.ts but collects identifiers rather than a client-supplied
 * verdict, and does not need the NOT/OR restriction `findInlineScoping` applies — identifier
 * co-occurrence is a correlation signal here, not itself a scoping proof.
 */
function collectWhereIdentifiers(
  whereArg: ts.Expression | null,
  bindings: RequestBindings,
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!whereArg) return ids;

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      if (isPrincipalExpression(node, bindings, sourceFile)) return;
      ids.add(node.text);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (isPrincipalExpression(node, bindings, sourceFile)) return;
      const root = getRootIdentifier(node);
      if (root) ids.add(root.text);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop)) visit(prop.initializer);
        else if (ts.isShorthandPropertyAssignment(prop)) visit(prop.name);
        else if (ts.isSpreadAssignment(prop)) visit(prop.expression);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) visit(element);
      return;
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
      visit(node.expression);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.whenTrue);
      visit(node.whenFalse);
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      visit(node.left);
      visit(node.right);
      return;
    }
    // Literals, call expressions, template expressions: no identifiable correlation signal.
  }

  visit(whereArg);
  return ids;
}

/** `const V = await <prismaCall>` (or without `await`) -> "V"; otherwise null. */
function getAssignedVariableName(node: ts.CallExpression): string | null {
  let current: ts.Node = node;
  let parent: ts.Node | undefined = current.parent;
  if (parent && ts.isAwaitExpression(parent)) {
    current = parent;
    parent = current.parent;
  }
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return null;
}

/** True when a binary comparison's non-principal side is a property-access chain rooted at `varName`. */
function comparesVariableAgainstPrincipal(
  binary: ts.BinaryExpression,
  varName: string,
  bindings: RequestBindings,
  sourceFile: ts.SourceFile,
): { path: string; field: string } | null {
  const isEqualityOp =
    binary.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    binary.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    binary.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
    binary.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken;
  if (!isEqualityOp) return null;

  function sideMatch(
    varSide: ts.Expression,
    principalSide: ts.Expression,
  ): { path: string; field: string } | null {
    const root = getRootIdentifier(varSide);
    if (!root || root.text !== varName) return null;
    const field = isPrincipalExpression(principalSide, bindings, sourceFile);
    if (!field) return null;
    return { path: varSide.getText(sourceFile), field };
  }

  return sideMatch(binary.left, binary.right) ?? sideMatch(binary.right, binary.left);
}

/** Finds the nearest enclosing statement-list body a node participates in, for linear body walks. */
function collectAllBinaryComparisons(root: ts.Node): ts.BinaryExpression[] {
  const found: ts.BinaryExpression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

/**
 * D-13 way (3), sub-form A: fetch-then-compare — a comparison of a fetched row (or the judged
 * call's OWN result, when the judged call is itself the fetch) against `req.user` occurring in
 * the same function scope, gating any subsequent write.
 */
export function findScopingComparison(
  judged: ts.CallExpression,
  handler: ts.Node,
  bindings: RequestBindings,
  sourceFile: ts.SourceFile,
): ScopedVerdict | null {
  const meta = getCallModelAndMethod(judged);
  if (!meta) return null;
  const isMutating = MUTATING_METHODS.has(meta.method);
  const isFetch = FETCH_METHODS.has(meta.method);

  const candidateVars = new Map<string, { fromLine: number } | null>();

  // (a) the judged call is itself a fetch, and its own result is later compared.
  if (isFetch) {
    const selfVar = getAssignedVariableName(judged);
    if (selfVar) candidateVars.set(selfVar, null);
  }

  // (b) an EARLIER fetch in this handler whose `where` shares a client-supplied identifier with
  // the judged call's `where`, AND targets the SAME model. The same-model requirement is what
  // keeps this from wrongly accepting Shape 7 (D-16, T-204-14): `break.deleteMany({ where: {
  // timeEntryId: id } })` shares the bare name "id" with an earlier `TimeEntry` fetch-then-compare
  // purely by local-variable-naming coincidence, but Break and TimeEntry are different models —
  // the earlier check proved TimeEntry-tenant-safety, not Break-tenant-safety, and D-16 requires
  // that distinction be preserved, not smoothed over by a heuristic that "looks close enough".
  const judgedIds = collectWhereIdentifiers(judgedWhereOf(judged), bindings, sourceFile);
  if (judgedIds.size > 0) {
    const allCalls = findPrismaCalls(sourceFile, "<internal>");
    for (const discovered of allCalls) {
      if (discovered.node === judged) continue;
      if (discovered.node.getStart(sourceFile) >= judged.getStart(sourceFile)) continue; // must precede
      if (!isNodeWithin(discovered.node, handler)) continue;
      if (discovered.call.model !== meta.model) continue;
      if (!FETCH_METHODS.has(discovered.call.method)) continue;
      const earlierIds = collectWhereIdentifiers(discovered.whereArg, bindings, sourceFile);
      const shared = [...judgedIds].some((id) => earlierIds.has(id));
      if (!shared) continue;
      const earlierVar = getAssignedVariableName(discovered.node);
      if (earlierVar) candidateVars.set(earlierVar, { fromLine: discovered.call.line });
    }
  }

  if (candidateVars.size === 0) return null;

  for (const comparison of collectAllBinaryComparisons(handler)) {
    // A write cannot be retroactively authorised by a check that runs after it (T-204-13): for a
    // mutating judged call, only comparisons that textually PRECEDE it qualify. A fetch judged
    // call has no such restriction — the comparison naturally follows the fetch it validates.
    if (isMutating && comparison.getStart(sourceFile) >= judged.getStart(sourceFile)) continue;

    for (const varName of candidateVars.keys()) {
      const match = comparesVariableAgainstPrincipal(comparison, varName, bindings, sourceFile);
      if (match) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(comparison.getStart(sourceFile)).line + 1;
        return {
          scoped: true,
          via: "fetch-then-compare",
          detail: `${match.path} compared against req.user.${match.field} at line ${line} (fetch-then-compare per D-02)`,
        };
      }
    }
  }

  return null;
}

/** Re-extracts the `where` argument straight off a call node (candidate module already resolved it once). */
function judgedWhereOf(node: ts.CallExpression): ts.Expression | null {
  const optionsArg = node.arguments[0];
  if (!optionsArg || !ts.isObjectLiteralExpression(optionsArg)) return null;
  for (const prop of optionsArg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "where") {
      return prop.initializer;
    }
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "where") {
      return prop.name;
    }
  }
  return null;
}

function isNodeWithin(node: ts.Node, ancestor: ts.Node): boolean {
  return node.getStart() >= ancestor.getStart() && node.getEnd() <= ancestor.getEnd();
}

/** `if (!V) return ...;` / `if (V === null) return ...;` / `if (V == null) return ...;` guarding `varName`. */
function hasNotFoundGuard(
  handler: ts.Node,
  varName: string,
  afterPos: number,
  beforePos: number,
): boolean {
  let found = false;

  function conditionGuardsVar(condition: ts.Expression): boolean {
    if (
      ts.isPrefixUnaryExpression(condition) &&
      condition.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isIdentifier(condition.operand) &&
      condition.operand.text === varName
    ) {
      return true;
    }
    if (
      ts.isBinaryExpression(condition) &&
      (condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) &&
      ts.isIdentifier(condition.left) &&
      condition.left.text === varName &&
      condition.right.kind === ts.SyntaxKind.NullKeyword
    ) {
      return true;
    }
    return false;
  }

  function thenBranchReturns(statement: ts.Statement): boolean {
    if (ts.isReturnStatement(statement)) return true;
    if (ts.isBlock(statement)) return statement.statements.some((s) => ts.isReturnStatement(s));
    return false;
  }

  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isIfStatement(node)) {
      const pos = node.getStart();
      if (
        pos > afterPos &&
        pos < beforePos &&
        conditionGuardsVar(node.expression) &&
        thenBranchReturns(node.thenStatement)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(handler);
  return found;
}

/**
 * D-13 way (3), sub-form B: guard-fetch. An EARLIER Prisma call in the same scope whose `where`
 * is itself inline-scoped (Task 1) AND constrains on at least one identifier the judged call's
 * `where` also uses, followed by an early-return guard on the fetched variable.
 *
 * The shared-identifier requirement is non-negotiable (T-204-11): without it, ANY tenant check
 * anywhere in a handler would bless every other call in it, which is precisely the false
 * negative this gate exists to prevent — a real IDOR the gate reports as green.
 */
export function findGuardFetch(
  judged: ts.CallExpression,
  judgedWhere: ts.Expression | null,
  handler: ts.Node,
  graph: ModelGraph,
  bindings: RequestBindings,
  sourceFile: ts.SourceFile,
): ScopedVerdict | null {
  const meta = getCallModelAndMethod(judged);
  if (!meta) return null;

  const judgedIds = collectWhereIdentifiers(judgedWhere, bindings, sourceFile);
  if (judgedIds.size === 0) return null;

  const allCalls = findPrismaCalls(sourceFile, "<internal>");
  for (const discovered of allCalls) {
    if (discovered.node === judged) continue;
    if (discovered.node.getStart(sourceFile) >= judged.getStart(sourceFile)) continue; // must precede
    if (!isNodeWithin(discovered.node, handler)) continue;
    if (discovered.call.model !== meta.model) continue; // D-16/T-204-14: same model only
    if (!FETCH_METHODS.has(discovered.call.method)) continue;

    const earlierIds = collectWhereIdentifiers(discovered.whereArg, bindings, sourceFile);
    const sharedId = [...judgedIds].find((id) => earlierIds.has(id));
    if (!sharedId) continue;

    const earlierInline = findInlineScoping(
      discovered.whereArg,
      discovered.call.model,
      graph,
      bindings,
      sourceFile,
    );
    if (!earlierInline) continue; // the earlier fetch must itself be tenant-scoped, not just present

    const earlierVar = getAssignedVariableName(discovered.node);
    if (!earlierVar) continue;

    if (
      !hasNotFoundGuard(handler, earlierVar, discovered.node.getEnd(), judged.getStart(sourceFile))
    ) {
      continue;
    }

    return {
      scoped: true,
      via: "guard-fetch",
      detail: `guarded by tenant-scoped ${discovered.call.model}.${discovered.call.method} at line ${discovered.call.line} sharing identifier '${sharedId}', followed by a not-found return`,
    };
  }

  return null;
}

// ── Entry point ────────────────────────────────────────────────────────────────────────────

/** The one entry point: tries the ways in order and returns the first that accepts. */
export function reachVerdict(input: {
  call: PrismaCall;
  node: ts.CallExpression;
  whereArg: ts.Expression | null;
  handler: ts.Node;
  bindings: RequestBindings;
  graph: ModelGraph;
  sourceFile: ts.SourceFile;
}): Verdict {
  const { call, node, whereArg, handler, bindings, graph, sourceFile } = input;

  const inline = findInlineScoping(whereArg, call.model, graph, bindings, sourceFile);
  if (inline) return inline;

  const comparison = findScopingComparison(node, handler, bindings, sourceFile);
  if (comparison) return comparison;

  const guardFetch = findGuardFetch(node, whereArg, handler, graph, bindings, sourceFile);
  if (guardFetch) return guardFetch;

  return {
    scoped: false,
    detail:
      `no tenant scoping found for ${call.model}.${call.method} (${call.file}:${call.line}): ` +
      `where has no tenantId/principal-field/relation constraint (D-13 way 1), no fetch-then-compare ` +
      `against req.user in this function scope (D-13 way 3, sub-form A), and no earlier tenant-scoped ` +
      `fetch of a shared identifier followed by a not-found return (D-13 way 3, sub-form B, guard-fetch). ` +
      `If this is chained validation across model boundaries (Shape 7, D-16 — a child model reusing an ` +
      `identifier already validated against a DIFFERENT parent model earlier in the function), it needs ` +
      `a named exception carrying a reason that points at the earlier validating call, not a code fix.`,
  };
}
