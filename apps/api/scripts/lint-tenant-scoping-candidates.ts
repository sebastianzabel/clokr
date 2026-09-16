/**
 * Phase 204 Plan 02 — the D-12/D-14 client-supplied-identifier filter for the
 * `lint:tenant-scoping` gate (GitHub Issue #204).
 *
 * This module decides, for every relevant Prisma call in `apps/api/src/routes/` and
 * `apps/api/src/services/`, whether its `where` argument is reachable to a
 * client-supplied identifier at all. It reaches NO verdict on whether a candidate is
 * actually tenant-scoped — that is plan 03's job (`Verdict` / `ScopedVia` in
 * lint-tenant-scoping-types.ts). This module only decides candidacy.
 *
 * ── Why the filter runs first (D-14) ──────────────────────────────────────────────────────
 * Measured on `main` at `708ffbfa` with a throwaway probe (production code, `__tests__`
 * excluded): 475 raw calls on the 8 `RELEVANT_METHODS` collapse to roughly 211 candidates
 * once this filter is applied. A large fraction of the raw set never touches a value that
 * came from the current request at all (for example `user.update({ where: { id:
 * employee.userId } })`, where `employee` was already fetched and tenant-checked earlier in
 * the same function). Running the D-14 filter FIRST is what keeps the candidate set small
 * enough to be judged by plan 03 and, later, by a human reading exception entries. Getting
 * this filter wrong toward permissive would explode the exception list past D-17's hard
 * stop of 25 entries; getting it wrong toward restrictive would silently hide the exact IDOR
 * this gate exists to catch (see the threat register in the plan for T-204-06).
 *
 * ── The `<unresolved>` fail-loud policy (D-12, T-204-07) ─────────────────────────────────
 * A `where` argument this module cannot trace to a concrete expression in the same function
 * scope is NEVER silently dropped. It is reported as a candidate with `via: ["<unresolved>"]`,
 * which forces it into either a real finding or a named, reasoned exception at the next
 * stage. This costs at most one exception entry for a truly opaque `where` — silence would
 * cost an invisible gap in the gate's own coverage, which is the more dangerous failure.
 *
 * ── Accepted Prisma delegate bases (measured, not guessed) ────────────────────────────────
 * Run against `main`:
 *   grep -rhoE '\b[A-Za-z_.]+\.(timeEntry|leaveRequest|employee)\.(findFirst|update)' \
 *     apps/api/src/routes apps/api/src/services --include='*.ts' | grep -v __tests__ | \
 *     sed 's/\.[a-zA-Z]*\.[a-zA-Z]*$//' | sort -u
 * returns exactly: `app.prisma`, `db`, `prisma`, `tx`. `db`/`prisma`/`tx` are local bindings
 * for the injected Prisma client or a `$transaction` callback parameter, both used directly
 * inside route/service files (not only inside `utils/`, which stays out of scope per D-11).
 * `app.prisma` is itself a two-segment property access, so the accepted-base check below
 * recognizes both a bare identifier base and the `app.prisma` compound form explicitly —
 * it does not attempt to resolve arbitrary aliasing beyond that.
 *
 * ── `where` resolution order ───────────────────────────────────────────────────────────────
 * (a) an object literal directly on the `where` property — the dominant case;
 * (b) a shorthand property `{ where }` resolved to a `const where = ...` declared earlier in
 *     the SAME function scope (the walker does not descend into nested closures, mirroring
 *     `collectRequestBindings`'s own scope discipline);
 * (c) an identifier `where: someVar` resolved the same way as (b);
 * (d) anything the walker cannot trace back to a local declaration resolves to `null`, which
 *     `classifyProvenance` turns into the loud `<unresolved>` candidate described above.
 *
 * ── What counts as client-supplied during the provenance walk ────────────────────────────
 * A bare `Identifier` whose text is in `bindings.clientSupplied` counts. A
 * `PropertyAccessExpression` whose ROOT identifier is in `bindings.clientSupplied` counts
 * (`body.employeeId`). A `PropertyAccessExpression` rooted at `req`/`request` with an
 * immediate `.params`/`.query`/`.body` segment counts even without an intermediate local
 * variable (`req.body.employeeId` inline). Nothing else counts.
 *
 * A principal expression (`req.user.tenantId`, or a local alias of it) is deliberately NOT
 * client-supplied: it is server-supplied and constrains correctly by construction. Treating
 * `where: { tenantId: req.user.tenantId }` as a candidate would be exactly the difference
 * between the measured 211 candidates and several hundred false positives, and it is why
 * `isPrincipalExpression` from `lint-tenant-scoping-request-bindings.ts` is consulted before
 * any other check on a property access or bare identifier.
 *
 * This module has no `main()`, no CLI, and no side effects on import — the CLI entry point
 * belongs to plan 04.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { SCOPED_DIRS, EXCLUDED_DIR_SEGMENT, RELEVANT_METHODS } from "./lint-tenant-scoping-types";
import type {
  PrismaCall,
  RequestBindings,
  Provenance,
  RelevantMethod,
} from "./lint-tenant-scoping-types";
import {
  enclosingHandler,
  collectRequestBindings,
  isPrincipalExpression,
} from "./lint-tenant-scoping-request-bindings";

// ── Accepted Prisma delegate call bases (measured — see header) ──────────────────────────

const ACCEPTED_BASE_IDENTIFIERS = new Set(["db", "prisma", "tx"]);

function isAcceptedBase(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return ACCEPTED_BASE_IDENTIFIERS.has(expr.text);
  if (ts.isPropertyAccessExpression(expr)) {
    return (
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "app" &&
      expr.name.text === "prisma"
    );
  }
  return false;
}

const RELEVANT_METHOD_SET = new Set<string>(RELEVANT_METHODS);

function isRelevantMethod(name: string): name is RelevantMethod {
  return RELEVANT_METHOD_SET.has(name);
}

// ── File walking (D-11, D-15) ──────────────────────────────────────────────────────────────

/**
 * GitHub #229: a `SCOPED_DIRS` entry that points nowhere used to be walked as zero files, and the
 * gate then reported "OK — no findings" with exit 0. A gate that finds nothing because it looks at
 * nothing is indistinguishable from a clean tree. Phase 99b moves `src/routes/` away, which is
 * exactly the trigger, so this is a hard error and never a warning.
 */
export class MissingScopedDirError extends Error {
  constructor(missingDir: string) {
    super(
      `lint-tenant-scoping: SCOPED_DIRS entry "${missingDir}" does not exist on disk. A path ` +
        `pointing nowhere is a defect, not "all clean" (GitHub #229) — fix it in the single place ` +
        `SCOPED_DIRS is stated: apps/api/scripts/lint-tenant-scoping-types.ts.`,
    );
    this.name = "MissingScopedDirError";
  }
}

/** D-11 + D-15: walk SCOPED_DIRS for *.ts, skipping any directory named EXCLUDED_DIR_SEGMENT. */
export function listScopedFiles(repoRoot: string): string[] {
  const out: string[] = [];

  function walk(absDir: string): void {
    for (const entry of fs.readdirSync(absDir)) {
      const full = path.join(absDir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        if (entry === EXCLUDED_DIR_SEGMENT) continue;
        walk(full);
      } else if (entry.endsWith(".ts")) {
        out.push(full);
      }
    }
  }

  for (const dir of SCOPED_DIRS) {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) throw new MissingScopedDirError(dir);
    walk(abs);
  }

  return out.map((absPath) => path.relative(repoRoot, absPath).split(path.sep).join("/"));
}

// ── `where` extraction and resolution ──────────────────────────────────────────────────────

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

/** Nearest enclosing function BODY of `node`, or `undefined` for module-level code. */
function findEnclosingFunctionBody(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionLikeNode(current)) return current.body;
    current = current.parent;
  }
  return undefined;
}

/**
 * Finds a `const <name> = <initializer>` declared directly in `scopeBody`, never descending
 * into a nested closure — the same scope discipline `collectRequestBindings` uses, so a
 * `where` bound inside an unrelated nested callback is never mistaken for this call's `where`.
 */
function findLocalConstDeclaration(name: string, scopeBody: ts.Node): ts.Expression | null {
  let found: ts.Expression | null = null;

  function visit(node: ts.Node, isRoot: boolean): void {
    if (!isRoot && isFunctionLikeNode(node)) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer;
    }
    ts.forEachChild(node, (child) => visit(child, false));
  }

  visit(scopeBody, true);
  return found;
}

/**
 * A synthetic, shared, empty object literal standing in for "this call has no `where` key at
 * all" — distinct from `null`, which means "a `where` key exists but its value could not be
 * traced to a local declaration" (the `<unresolved>` fail-loud case). An empty object literal
 * walks to zero provenance signals either way, so it classifies as `clientSupplied: false`
 * through the ordinary walk without a fourth `Provenance` shape.
 */
const NO_WHERE_ARGUMENT: ts.ObjectLiteralExpression = ts.factory.createObjectLiteralExpression(
  [],
  false,
);

/** Resolves a `where` identifier (shorthand or `where: someVar`) to its local declaration. */
function resolveWhereIdentifier(
  identifier: ts.Identifier,
  callNode: ts.CallExpression,
): ts.Expression | null {
  const scopeBody = findEnclosingFunctionBody(callNode);
  if (!scopeBody) return null;
  return findLocalConstDeclaration(identifier.text, scopeBody);
}

/** Extracts and resolves the `where` argument of a Prisma delegate call's options object. */
function extractWhereArgument(callNode: ts.CallExpression): ts.Expression | null {
  const optionsArg = callNode.arguments[0];
  if (!optionsArg || !ts.isObjectLiteralExpression(optionsArg)) return NO_WHERE_ARGUMENT;

  for (const prop of optionsArg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "where") {
      const value = prop.initializer;
      if (ts.isIdentifier(value)) return resolveWhereIdentifier(value, callNode);
      return value;
    }
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "where") {
      return resolveWhereIdentifier(prop.name, callNode);
    }
  }

  // The call has an options object but no `where` key at all (e.g. `findFirst({ include })`,
  // or a plain `findFirst()`). There is nothing here that could be client-supplied, so this is
  // NOT the same fact as "a `where` exists but its binding could not be traced" — that distinct
  // case is what the `<unresolved>` fail-loud policy exists for (see the module header). An
  // empty object literal walks to zero signals either way, so it classifies cleanly as
  // `clientSupplied: false` without needing a fourth Provenance shape.
  return NO_WHERE_ARGUMENT;
}

// ── Call discovery ─────────────────────────────────────────────────────────────────────────

export type DiscoveredCall = {
  call: PrismaCall;
  node: ts.CallExpression;
  whereArg: ts.Expression | null;
};

/** All in-scope Prisma delegate calls in one parsed file. */
export function findPrismaCalls(
  sourceFile: ts.SourceFile,
  repoRelativePath: string,
): DiscoveredCall[] {
  const results: DiscoveredCall[] = [];
  let counter = 0;

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const methodAccess = node.expression;
      if (
        ts.isPropertyAccessExpression(methodAccess) &&
        isRelevantMethod(methodAccess.name.text) &&
        ts.isPropertyAccessExpression(methodAccess.expression) &&
        isAcceptedBase(methodAccess.expression.expression)
      ) {
        const modelAccess = methodAccess.expression;
        const method = methodAccess.name.text as RelevantMethod;
        const model = modelAccess.name.text;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        counter += 1;
        const call: PrismaCall = {
          file: repoRelativePath,
          line,
          model,
          method,
          callId: `${repoRelativePath}:${model}.${method}:${line}#${counter}`,
        };
        results.push({ call, node, whereArg: extractWhereArgument(node) });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

// ── Provenance classification (D-12, D-14) ──────────────────────────────────────────────────

const REQUEST_IDENTIFIER_NAMES = new Set(["req", "request"]);
const REQUEST_PART_NAMES = new Set(["params", "query", "body"]);

/** `req.params`, `req.body.employeeId`, ... — an inline access rooted at req/request. */
function isDirectRequestDerivedAccess(expr: ts.Expression): boolean {
  const segments: string[] = [];
  let current: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(current)) {
    segments.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current) || !REQUEST_IDENTIFIER_NAMES.has(current.text)) return false;
  return segments.length > 0 && REQUEST_PART_NAMES.has(segments[0]);
}

function getRootIdentifier(expr: ts.Expression): ts.Identifier | null {
  let current: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current : null;
}

type NonQualifyingRef = { text: string; isPropertyAccess: boolean };

function collectProvenanceSignals(
  root: ts.Node,
  bindings: RequestBindings,
  sourceFile: ts.SourceFile,
  via: string[],
  nonQualifying: NonQualifyingRef[],
): void {
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      if (isPrincipalExpression(node, bindings, sourceFile)) return;
      if (bindings.clientSupplied.has(node.text)) {
        via.push(node.text);
        return;
      }
      nonQualifying.push({ text: node.text, isPropertyAccess: false });
      return;
    }

    if (ts.isPropertyAccessExpression(node)) {
      if (isPrincipalExpression(node, bindings, sourceFile)) return;
      if (isDirectRequestDerivedAccess(node)) {
        via.push(node.getText(sourceFile));
        return;
      }
      const rootIdentifier = getRootIdentifier(node);
      if (rootIdentifier && bindings.clientSupplied.has(rootIdentifier.text)) {
        via.push(node.getText(sourceFile));
        return;
      }
      nonQualifying.push({ text: node.getText(sourceFile), isPropertyAccess: true });
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

    if (ts.isParenthesizedExpression(node)) {
      visit(node.expression);
      return;
    }

    if (ts.isAsExpression(node)) {
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

    // Anything else (call expressions, literals, template expressions, ...) carries no
    // identifiable client-supplied signal for this walk and is deliberately left opaque.
  }

  visit(root);
}

/** D-12/D-14: is this call's `where` reachable from the request? */
export function classifyProvenance(
  whereArg: ts.Expression | null,
  bindings: RequestBindings,
  sourceFile: ts.SourceFile,
): Provenance {
  if (whereArg === null) {
    return { clientSupplied: true, via: ["<unresolved>"] };
  }

  const via: string[] = [];
  const nonQualifying: NonQualifyingRef[] = [];
  collectProvenanceSignals(whereArg, bindings, sourceFile, via, nonQualifying);

  if (via.length > 0) {
    return { clientSupplied: true, via: [...new Set(via)] };
  }

  if (nonQualifying.length > 0) {
    const names = [...new Set(nonQualifying.map((ref) => ref.text))].join(", ");
    if (nonQualifying[0].isPropertyAccess) {
      return {
        clientSupplied: false,
        reason: `where only reads fields off an already-resolved local value (${names}) — treated as fetched-row provenance, not client input`,
      };
    }
    return {
      clientSupplied: false,
      reason: `where references a bare identifier (${names}) not bound from req.params/req.query/req.body in this scope — treated as helper-parameter provenance, not client input`,
    };
  }

  return {
    clientSupplied: false,
    reason:
      "where references no client-supplied identifier — only principal fields and/or constants",
  };
}

// ── Orchestration ───────────────────────────────────────────────────────────────────────────

export type Candidate = {
  call: PrismaCall;
  node: ts.CallExpression;
  whereArg: ts.Expression | null;
  sourceFile: ts.SourceFile;
  handler: ts.Node;
  bindings: RequestBindings;
  provenance: Extract<Provenance, { clientSupplied: true }>;
};

/** Orchestration: files -> parsed -> calls -> provenance. Returns only the candidates. */
export function selectCandidates(repoRoot: string): Candidate[] {
  const candidates: Candidate[] = [];

  for (const relPath of listScopedFiles(repoRoot)) {
    const absPath = path.join(repoRoot, relPath);
    const text = fs.readFileSync(absPath, "utf8");
    const sourceFile = ts.createSourceFile(
      absPath,
      text,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
    );

    for (const { call, node, whereArg } of findPrismaCalls(sourceFile, relPath)) {
      const handler = enclosingHandler(node, sourceFile);
      const bindings = collectRequestBindings(handler, sourceFile);
      const provenance = classifyProvenance(whereArg, bindings, sourceFile);
      if (provenance.clientSupplied) {
        candidates.push({ call, node, whereArg, sourceFile, handler, bindings, provenance });
      }
    }
  }

  return candidates;
}
