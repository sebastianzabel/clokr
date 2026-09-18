#!/usr/bin/env -S pnpm exec tsx
/**
 * `lint:saldo-lock-derivation` — Issue #241's real deliverable: a static gate against a SIXTH site
 * of the same defect, not just the fifth fix.
 *
 * ── The defect class, precisely ───────────────────────────────────────────────────────────────
 * `SaldoSnapshot.periodStart` (MONTHLY rows) is written by the monthly closer via
 * `monthRangeUtc(year, month, tenantTz)` (tenant-local midnight of day 1, converted to UTC — see
 * `contexts/working-time-account/timezone.ts`). For a tenant ahead of UTC (Europe/Berlin) that
 * real value falls on the LAST DAY OF THE PREVIOUS month, never on a naive
 * `new Date(Date.UTC(year, month, 1))`. Five sites (three routes in `8326859d`, the auto-generator
 * in `840d9976`, this shift-cleanup helper in the same commit as this gate) independently
 * re-derived that naive boundary instead of calling `monthRangeUtc()` — each found by a human
 * reading code, one at a time, over three separate sessions. This gate is what makes a SIXTH one
 * mechanical to catch instead.
 *
 * ── Scope: exactly the surface the defect lives on ────────────────────────────────────────────
 * `SaldoSnapshot.periodStart` is the ONLY model field named `periodStart` in the schema (verified:
 * `grep periodStart packages/db/prisma/schema.prisma`), so no type-level model resolution is
 * needed to know which model a `periodStart:` key belongs to. Two further restrictions narrow this
 * to the ACTUAL defect surface, not periodStart in general:
 *
 *   1. Only `where:` fragments — a `data:` fragment (the monthly closer's OWN
 *      `saldoSnapshot.create({ data: { periodStart: monthStart, ... } })`) is the AUTHORITATIVE
 *      WRITE this whole gate exists to defend the READ side against re-deriving independently; it
 *      is not itself a comparison and must never be flagged.
 *   2. Only `where:` fragments with a sibling `periodType: "MONTHLY"` — `YEARLY` snapshots are a
 *      deliberately DIFFERENT, self-consistent convention: `auto-close-month.ts` writes their
 *      `periodStart` as a plain UTC year boundary (`new Date(\`${year}-01-01T00:00:00Z\`)`), never
 *      through `monthRangeUtc()`, and every YEARLY comparison in this tree reads that same literal
 *      convention back. Flagging YEARLY comparisons would be flagging CORRECT code for using the
 *      convention it was written against — a false positive this gate must not produce. This is
 *      issue #241's own scope, too: every one of its five sites is a MONTHLY comparison.
 *
 * ── Mechanism: does the compared value trace back to `monthRangeUtc()`? ───────────────────────
 * For every `periodStart` (or its `gte`/`lte`/`lt`/`gt`/`equals`/`in`/`not` sub-keys) found this
 * way, a small AST interpreter (`isSafeExpr` below) asks: does this VALUE — not just "is it a
 * `Date`" — trace back, through local variable/destructuring bindings, `.start`/`.end` property
 * access, `Array.prototype.map`, `.toISOString()`, `new Set(...)`, and same-file helper function
 * bodies, to an actual CALL to `monthRangeUtc(...)`? A local helper that WRAPS `monthRangeUtc()`
 * (this commit's own `monthLockBoundUtc()`, `840d9976`'s helper of the same name) is recognised as
 * safe by analysing ITS OWN return expression, independent of what argument it was called with —
 * exactly the shape all four already-fixed sites and the fifth use. A helper that instead
 * constructs `new Date(Date.UTC(...))` — the naive fingerprint every one of the five real bugs
 * shared — is recognised as UNSAFE the same way, independent of its caller.
 *
 * Every finding is a THREE-WAY verdict, not two:
 *   - "safe"    — traced all the way to a `monthRangeUtc()` call (or a read of an already-stored
 *                 `foo.periodStart` off some other snapshot row — comparing a real row against
 *                 another real row is a different, unrelated correctness question).
 *   - "unsafe"  — traced to a literal `new Date(Date.UTC(...))`/hardcoded date, or a same-file
 *                 helper whose body does that — a FINDING.
 *   - "unknown" — the trace crosses a function-CALL boundary into a parameter this gate cannot
 *                 see the caller's argument for (e.g. `recalculateSnapshots(app, employeeId,
 *                 fromDate)`'s `fromDate`). NOT flagged (a real false-positive risk otherwise) and
 *                 NOT silently counted as a pass either — see the honesty section below.
 *
 * ── Honesty about blind spots (the actual instruction, not a caveat) ──────────────────────────
 * This gate is intentionally single-file and does NOT do cross-file interprocedural dataflow: a
 * `periodStart` value passed in as a function PARAMETER is "unknown", not verified — reported as
 * its own count in the summary line, every run, so a clean run can never be misread as "every
 * periodStart comparison in this codebase is proven safe". It is not. It proves the specific,
 * narrow claim: every MONTHLY `where`-comparison whose value is constructed LOCALLY, in the same
 * file, does or does not trace to `monthRangeUtc()`. A new sixth site built the same way the first
 * five were — a fresh helper function reinventing a month boundary inline — falls squarely inside
 * what this gate DOES see, which is the actual, demonstrated failure mode.
 *
 * The #229 stance: a gate that walks zero files, or finds zero candidates, and reports "0 findings"
 * is not "all clean" — it is a broken gate reporting success on work it never did. See the
 * zero-candidate guard in `run()` below.
 *
 * ── Facade parameter resolution (100B Plan 07) ────────────────────────────────────────────────
 * Phase 100B (issue #100) puts a facade layer between a route/composition caller and Prisma. That
 * moves a `periodStart` comparison's VALUE from a same-file local variable into a bare FACADE
 * FUNCTION PARAMETER — invisible to the single-file rule above by construction, which would
 * silently downgrade an already-verdicted "safe"/"unsafe" candidate to "unknown" for no reason but
 * the refactor itself. That is not acceptable: 100B-07-PLAN.md's own checkpoint says so explicitly
 * ("moving a lock query behind a facade must not turn a safe verdict into unknown... fix the
 * gate's tracing, do not add an exception").
 *
 * The fix is a BOUNDED, ONE-HOP extension, not a general interprocedural engine (the "single-file"
 * promise above still holds for every ordinary function): for a `periodStart` candidate inside an
 * exported function declaration in a `contexts/*\/facade/*.ts` file (`isFacadeFilePath`), when the
 * trace bottoms out on a bare identifier matching that function's OWN declared parameter name, the
 * gate looks up every real call site of that function anywhere in the scanned tree
 * (`buildFacadeParamResolver`), extracts the argument expression passed at the matching parameter
 * position, and evaluates THAT expression using the caller's own file bindings — exactly the same
 * `isSafeExpr` used everywhere else, just given a different file's local scope to start from. The
 * nested evaluation runs with facade-parameter resolution turned OFF (`enclosingFacadeFn`/
 * `resolveFacadeParam` both `null`), so an unresolved identifier at the CALLER is reported
 * "unknown", never chased through a second facade boundary — one hop, not arbitrary depth.
 *
 * This is deliberately restricted to BARE identifiers matching a TOP-LEVEL parameter name of an
 * EXPORTED function declaration in a facade file. A parameter reached only through property access
 * on a wrapping object (e.g. a discriminated-union query parameter's `query.monthStarts`) is NOT
 * resolved this way — which is exactly why `getClosedMonthsForDates`/`getClosedMonthsInRange` (W2a/
 * W2b) are two separately-named functions taking bare `monthStarts`/`from`/`to` parameters, rather
 * than one function over a `{monthStarts} | {from, to}` union: the union shape would have been
 * invisible to this exact resolution rule, silently losing `shift-cleanup.ts`'s and
 * `vocational-school-generator.ts`'s own pre-plan "safe" verdicts.
 *
 * ── Exceptions ────────────────────────────────────────────────────────────────────────────────
 * Live in `lint-saldo-lock-derivation-exceptions.json`, one entry per
 * `{ file, line, disposition, reason, trackedIssue? }`, mirroring
 * `lint-tenant-scoping-exceptions.json` / `lint-facade-signatures-exceptions.json`: mandatory
 * non-trivial `reason`, hard error on a STALE entry (the line it names no longer has an "unsafe"
 * finding — moved, fixed, or removed).
 *
 * `disposition` is deliberately a THIRD thing beyond "excepted or not" — this gate's own first
 * real run (Issue #241's fifth-site commit) found genuine findings that are NOT the same risk as
 * the five real #241 bugs, and one that IS the same bug, just not yet fixed:
 *   - `"safe"`     — verified, on inspection, to carry no locked-month/audit-gate consequence
 *                    (e.g. `dashboard.ts`'s `sixMonthsAgo`: a `gte`-only lower bound for a
 *                    rolling 6-month TREND chart, not an exact lock check — off by at most a day
 *                    at the edge shifts a display window by at most one month, nothing more).
 *   - `"deferred"` — a CONFIRMED instance of the same defect class, filed as its own tracked
 *                    issue (`trackedIssue`, mandatory for this disposition) and deliberately NOT
 *                    fixed in the commit that introduced this gate (GSD scope boundary: fix only
 *                    what the current task names, log the rest — see that commit's own SUMMARY).
 *                    This is NOT a safety claim, and `run()` prints deferred entries separately so
 *                    nobody mistakes "0 finding(s)" for "0 known bugs". Never add a `"deferred"`
 *                    entry without also filing the issue it names — silently deferring is exactly
 *                    the "except it to make the run go green" anti-pattern
 *                    `lint-tenant-scoping-exceptions.ts`'s own header warns against.
 *
 * ── Flags ─────────────────────────────────────────────────────────────────────────────────────
 *   (none) — print the one-line summary; exit 0 if 0 unexcepted "unsafe" findings AND at least one
 *   candidate was found at all, else 1.
 *
 * This module has no side effects on import (#203) — `main()`/`run()` only executes when this file
 * is the process entry point.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";

// ── Constants ─────────────────────────────────────────────────────────────────────────────────

export const EXCEPTIONS_FILE = "apps/api/scripts/lint-saldo-lock-derivation-exceptions.json";
export const MIN_REASON_LENGTH = 30;

/** Same-file helper CALLs whose safety is a pass-through of one of their OWN arguments, not their
 * own body — imported from `working-time-account/snapshot-period.ts`, so this gate cannot resolve
 * their body (single-file analysis, see the module header). `periodStartWindow(monthStart)`'s
 * safety is exactly `monthStart`'s; `isPeriodStartInMonth(periodStart, monthStart)` compares an
 * already-fetched row's own `periodStart` against `monthStart` — its second argument is the one
 * carrying "was this derived correctly". */
const RELAY_FUNCTIONS: Record<string, number> = {
  periodStartWindow: 0,
  isPeriodStartInMonth: 1,
};

// ── Verdicts ──────────────────────────────────────────────────────────────────────────────────

export type Verdict = "safe" | "unsafe" | "unknown";

function combine(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.length === 0) return "unknown";
  if (verdicts.some((v) => v === "unsafe")) return "unsafe";
  if (verdicts.some((v) => v === "unknown")) return "unknown";
  return "safe";
}

// ── Discovery ─────────────────────────────────────────────────────────────────────────────────

/** Every `.ts` file under `apps/api/src/**`, excluding `__tests__/` directories and `*.test.ts` /
 * `*.d.ts` files. No further scoping by directory (unlike `lint-tenant-scoping`'s `SCOPED_DIRS`):
 * `SaldoSnapshot.periodStart` comparisons live in route files, facades, plain context modules
 * (`shift-cleanup.ts` is none of route/facade/service) and composition modules alike — the whole
 * defect class this gate exists for was found in exactly that variety of file shapes. */
export function discoverSourceFiles(repoRoot: string): string[] {
  const apiSrcRoot = join(repoRoot, "apps/api/src");
  const out: string[] = [];

  function walk(absDir: string): void {
    for (const entry of readdirSync(absDir)) {
      const full = join(absDir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (entry === "__tests__") continue;
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
      const repoRelative = join("apps/api/src", relative(apiSrcRoot, full)).split(sep).join("/");
      out.push(repoRelative);
    }
  }

  if (existsSync(apiSrcRoot)) walk(apiSrcRoot);
  return out.sort();
}

// ── AST analysis (pure — no file I/O beyond `analyzeFile`'s own read) ────────────────────────────

export type Candidate = {
  file: string; // repo-relative
  line: number; // 1-based, of the `periodStart` property key
  snippet: string; // `periodStart: <value text>` (single line, truncated)
  verdict: Verdict;
};

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** Every same-file candidate function/arrow the resolver may need to step into, keyed by name.
 * Built once per file; a name bound more than once (unlikely in these procedural route/module
 * files) keeps the LAST declaration, which is an accepted approximation — see the module header's
 * "single-file, no real scope resolution" honesty note. */
function collectLocalFunctions(sourceFile: ts.SourceFile): Map<string, FunctionLike> {
  const map = new Map<string, FunctionLike>();
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      map.set(node.name.text, node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      map.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return map;
}

/** Every same-file `const X = <init>` / `let X = <init>` binding (including one level of object
 * destructuring, e.g. `const { start: monthStart } = monthRangeUtc(...)`), keyed by the bound
 * identifier's own name — NOT the destructured property name, since (as the module header
 * explains) once we know `<init>` is a `monthRangeUtc()` call, every field it destructures is
 * equally safe; there is no unsafe field on that return shape. */
function collectLocalBindings(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const map = new Map<string, ts.Expression>();
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        map.set(node.name.text, node.initializer);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          if (ts.isIdentifier(el.name)) map.set(el.name.text, node.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return map;
}

/** Top-level `return <expr>;` expressions of a function-like node — an arrow's own expression
 * body counts as its one implicit return. Does NOT descend into a NESTED function-like node (a
 * callback declared inside the helper is a different scope entirely). */
function returnExpressions(fn: FunctionLike): ts.Expression[] {
  const body: ts.ConciseBody | ts.Block | undefined = fn.body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body]; // arrow with an expression body (its one implicit return)
  const out: ts.Expression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionLike(node)) return; // do not descend into a nested function
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
    ts.forEachChild(node, visit);
  }
  visit(body);
  return out;
}

function calleeParts(expr: ts.CallExpression): {
  name: string | null;
  object: ts.Expression | null;
} {
  if (ts.isIdentifier(expr.expression)) return { name: expr.expression.text, object: null };
  if (ts.isPropertyAccessExpression(expr.expression)) {
    return { name: expr.expression.name.text, object: expr.expression.expression };
  }
  return { name: null, object: null };
}

/**
 * The heart of the gate: does `expr` trace back to a `monthRangeUtc()` call?
 *
 * `paramOverride`, when set, shadows file-wide identifier resolution for exactly one name — used
 * while stepping into an `Array.prototype.map` callback body, where the callback's own parameter
 * must resolve to the SAFETY OF THE ARRAY BEING MAPPED, not to some unrelated same-named file
 * binding. `visiting`, a set of function names currently being analysed, breaks a cycle (mutual
 * or self recursion) by returning "unknown" rather than looping forever — a same-file helper that
 * genuinely recurses is already unusual enough that "unknown" (not verified, not flagged) is the
 * honest answer, not a crash.
 *
 * `enclosingFacadeFn`/`resolveFacadeParam` (100B Plan 07) — see "Facade parameter resolution"
 * in the module header: when set, an identifier that resolves to NEITHER `paramOverride` NOR a
 * same-file `localBindings` entry is checked against the CURRENT facade function's OWN declared
 * parameter list before giving up as "unknown". `resolveFacadeParam` is null for every ordinary
 * (non-facade-file) analysis — this is a strictly ADDITIVE resolution path, never a replacement of
 * the single-file rule for anything else.
 */
function isSafeExpr(
  expr: ts.Expression,
  ctx: {
    localFunctions: Map<string, FunctionLike>;
    localBindings: Map<string, ts.Expression>;
    paramOverride: { name: string; verdict: Verdict } | null;
    visiting: Set<string>;
    enclosingFacadeFn: { name: string; params: string[] } | null;
    resolveFacadeParam: FacadeParamResolver | null;
  },
): Verdict {
  const {
    localFunctions,
    localBindings,
    paramOverride,
    visiting,
    enclosingFacadeFn,
    resolveFacadeParam,
  } = ctx;

  if (ts.isParenthesizedExpression(expr)) {
    return isSafeExpr(expr.expression, ctx);
  }

  if (ts.isAwaitExpression(expr)) {
    return isSafeExpr(expr.expression, ctx);
  }

  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isNonNullExpression(expr)) {
    return isSafeExpr(expr.expression, ctx);
  }

  if (ts.isConditionalExpression(expr)) {
    return combine([isSafeExpr(expr.whenTrue, ctx), isSafeExpr(expr.whenFalse, ctx)]);
  }

  if (ts.isObjectLiteralExpression(expr)) {
    const verdicts: Verdict[] = [];
    for (const prop of expr.properties) {
      if (!ts.isPropertyAssignment(prop)) continue; // spreads/methods: out of scope, not our shape here
      verdicts.push(isSafeExpr(prop.initializer, ctx));
    }
    return combine(verdicts);
  }

  if (ts.isArrayLiteralExpression(expr)) {
    const verdicts: Verdict[] = [];
    for (const el of expr.elements) {
      if (ts.isSpreadElement(el)) {
        verdicts.push(isSafeExpr(el.expression, ctx));
      } else if (ts.isExpression(el)) {
        verdicts.push(isSafeExpr(el, ctx));
      }
    }
    return combine(verdicts);
  }

  if (ts.isPropertyAccessExpression(expr)) {
    const name = expr.name.text;
    if (name === "start" || name === "end" || name === "periodStart") {
      // `.start`/`.end` of a monthRangeUtc()-shaped return; `.periodStart` reads an
      // already-stored value off some OTHER fetched row — a different, unrelated question.
      if (name === "periodStart") return "safe";
      return isSafeExpr(expr.expression, ctx);
    }
    return "unknown"; // some other property we don't recognise — honestly unresolved
  }

  if (ts.isNewExpression(expr)) {
    const calleeName = ts.isIdentifier(expr.expression) ? expr.expression.text : null;
    const args = expr.arguments ?? [];
    if (calleeName === "Date") {
      // `new Date(x)` is safe IFF `x` itself is (e.g. `new Date(iso)` round-tripping an
      // already-safe `.toISOString()` string) — NOT unconditionally unsafe. The naive
      // fingerprint is `Date.UTC(...)` itself (see the CallExpression branch below), or a
      // hardcoded literal, both of which `x`'s own recursive verdict already resolves.
      if (args.length === 0) return "unsafe"; // new Date() = "now" — never a month boundary
      return isSafeExpr(args[0], ctx);
    }
    if (calleeName === "Set") {
      // new Set(iterable) — a dedup wrapper; pass through to what it dedups.
      if (args.length === 0) return "unknown";
      return isSafeExpr(args[0], ctx);
    }
    return "unknown";
  }

  if (
    ts.isStringLiteral(expr) ||
    ts.isNumericLiteral(expr) ||
    ts.isTemplateExpression(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr)
  ) {
    // A raw literal used directly as a MONTHLY periodStart comparison value IS the naive-hardcode
    // failure mode (the YEARLY convention that legitimately does this is out of scope — see the
    // module header's periodType:"MONTHLY" sibling filter, applied before we ever get here).
    return "unsafe";
  }

  if (ts.isCallExpression(expr)) {
    const { name: calleeName, object } = calleeParts(expr);
    if (calleeName === "monthRangeUtc") return "safe";
    if (calleeName === "UTC" && object && ts.isIdentifier(object) && object.text === "Date") {
      return "unsafe"; // Date.UTC(...) — the exact naive fingerprint of all five real bugs
    }
    if (calleeName && calleeName in RELAY_FUNCTIONS) {
      const argIndex = RELAY_FUNCTIONS[calleeName];
      const arg = expr.arguments[argIndex];
      return arg ? isSafeExpr(arg, ctx) : "unknown";
    }
    if (calleeName === "toISOString" && object) {
      return isSafeExpr(object, ctx);
    }
    if (calleeName === "map" && object && expr.arguments.length > 0) {
      const callback = expr.arguments[0];
      if (
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        callback.parameters.length === 1 &&
        ts.isIdentifier(callback.parameters[0].name)
      ) {
        const srcVerdict = isSafeExpr(object, ctx);
        const paramName = (callback.parameters[0].name as ts.Identifier).text;
        const nestedCtx = { ...ctx, paramOverride: { name: paramName, verdict: srcVerdict } };
        const rets = returnExpressions(callback);
        if (rets.length === 0) return "unknown";
        return combine(rets.map((r) => isSafeExpr(r, nestedCtx)));
      }
      return "unknown";
    }
    // A bare call to a same-file helper (e.g. `monthLockBoundUtc(d, tz)`,
    // `monthStartUtc(d)`) — its safety is entirely about what ITS OWN body does, independent
    // of the arguments passed here (that is exactly what makes a local wrapper function
    // reusable/dangerous the same way for every caller — see the module header).
    if (calleeName && localFunctions.has(calleeName)) {
      if (visiting.has(calleeName)) return "unknown"; // cycle guard
      const fn = localFunctions.get(calleeName)!;
      const rets = returnExpressions(fn);
      if (rets.length === 0) return "unknown";
      const nextVisiting = new Set(visiting);
      nextVisiting.add(calleeName);
      const nestedCtx = { ...ctx, paramOverride: null, visiting: nextVisiting };
      return combine(rets.map((r) => isSafeExpr(r, nestedCtx)));
    }
    return "unknown";
  }

  if (ts.isIdentifier(expr)) {
    if (paramOverride && expr.text === paramOverride.name) return paramOverride.verdict;
    const binding = localBindings.get(expr.text);
    if (binding) return isSafeExpr(binding, ctx);
    if (resolveFacadeParam && enclosingFacadeFn) {
      const paramIndex = enclosingFacadeFn.params.indexOf(expr.text);
      if (paramIndex !== -1) {
        return resolveFacadeParam(enclosingFacadeFn.name, paramIndex, visiting);
      }
    }
    return "unknown"; // function parameter, import binding, or truly unresolved
  }

  return "unknown";
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** Climbs from `node` to the nearest enclosing `export function foo(...)` declaration (a named,
 * exported function DECLARATION only — not an arrow/expression, matching `lint-facade-signatures.ts`'s
 * own `hasExportModifier` node shape for exactly the same reason: that is what a facade file
 * actually contains). Returns its name and parameter names in declared order, or `null` if `node`
 * is not inside one. */
function findEnclosingExportedFunction(node: ts.Node): { name: string; params: string[] } | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name && hasExportModifier(current)) {
      return {
        name: current.name.text,
        params: current.parameters
          .map((p) => (ts.isIdentifier(p.name) ? p.name.text : null))
          .filter((n): n is string => n !== null),
      };
    }
    current = current.parent;
  }
  return null;
}

/** 100B Plan 07 — see "Facade parameter resolution" in the module header. Resolves whether the
 * argument passed for `functionName`'s `paramIndex`-th parameter, at every real call site found
 * anywhere in the scanned tree, traces back to `monthRangeUtc()`. `visiting` is threaded through
 * (as `"functionName#paramIndex"` keys, a different string shape than the same-file helper guard's
 * bare function names, so the two never collide) to break a cycle. Bounded to exactly ONE hop:
 * the nested `isSafeExpr` call this makes runs with `enclosingFacadeFn`/`resolveFacadeParam` both
 * `null` — an unresolved identifier at the CALLER is reported "unknown", not chased through a
 * second hop. This is a deliberate scope limit (module header), not an oversight. */
export type FacadeParamResolver = (
  functionName: string,
  paramIndex: number,
  visiting: Set<string>,
) => Verdict;

/** Every `where:`-scoped `periodStart` candidate (with a `periodType: "MONTHLY"` sibling) in
 * `sourceText`, with its computed verdict. Pure function of the text — `__tests__` drives this
 * directly against fixture strings, exactly like `lint-facade-signatures.ts`'s `analyzeSource`.
 *
 * `resolveFacadeParam` (100B Plan 07) is optional and defaults to `null` — every existing/fixture
 * call site keeps its exact prior behaviour. `run()` supplies a real resolver, built once, only
 * for facade-directory files (see `isFacadeFilePath` / `buildFacadeParamResolver` below). */
export function analyzeSource(
  sourceText: string,
  repoRelativePath: string,
  resolveFacadeParam: FacadeParamResolver | null = null,
): Candidate[] {
  const sourceFile = ts.createSourceFile(
    repoRelativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const localFunctions = collectLocalFunctions(sourceFile);
  const localBindings = collectLocalBindings(sourceFile);
  const candidates: Candidate[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "periodStart"
    ) {
      const parentObj = node.parent;
      if (
        ts.isObjectLiteralExpression(parentObj) &&
        parentObj.properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.name) &&
            p.name.text === "periodType" &&
            ts.isStringLiteral(p.initializer) &&
            p.initializer.text === "MONTHLY",
        )
      ) {
        const grandparent = parentObj.parent;
        const isWhereFragment =
          ts.isPropertyAssignment(grandparent) &&
          ts.isIdentifier(grandparent.name) &&
          grandparent.name.text === "where";
        if (isWhereFragment) {
          const verdict = isSafeExpr(node.initializer, {
            localFunctions,
            localBindings,
            paramOverride: null,
            visiting: new Set(),
            enclosingFacadeFn: resolveFacadeParam ? findEnclosingExportedFunction(node) : null,
            resolveFacadeParam,
          });
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          const snippetRaw = node.getText(sourceFile).replace(/\s+/g, " ").trim();
          const snippet = snippetRaw.length > 140 ? snippetRaw.slice(0, 137) + "..." : snippetRaw;
          candidates.push({ file: repoRelativePath, line, snippet, verdict });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return candidates;
}

export function analyzeFile(
  absPath: string,
  repoRelativePath: string,
  resolveFacadeParam: FacadeParamResolver | null = null,
): Candidate[] {
  return analyzeSource(readFileSync(absPath, "utf8"), repoRelativePath, resolveFacadeParam);
}

// ── Facade parameter resolution (100B Plan 07) ───────────────────────────────────────────────────
//
// Moving a locked-month query behind a facade (Phase 100B, GitHub issue #100) turns its
// `periodStart`-comparison value from a same-file local variable into a bare FACADE FUNCTION
// parameter — invisible to the single-file analysis above by construction, which would silently
// downgrade an already-verdicted "safe"/"unsafe" candidate to "unknown" for no reason but the
// refactor itself (100B-07-PLAN.md's own explicit warning: "if it does, that is the gate losing
// sight of the call — #229 one level up"). The fix is NOT to except the loss; it is to extend the
// trace exactly one call-site hop, bounded to facade functions only (never a general
// interprocedural engine — see `FacadeParamResolver`'s own docblock above).
//
// `isFacadeFilePath` mirrors `lint-tenant-scoping-types.ts`'s / `lint-facade-signatures.ts`'s own
// recognition of the same directory shape (`contexts/<x>/facade/*.ts`) — one predicate, matching
// an already-established pattern, not a fourth independent definition of "is this a facade".

const FACADE_PATH_RE = /\/contexts\/[^/]+\/facade\//;

export function isFacadeFilePath(repoRelativePath: string): boolean {
  return FACADE_PATH_RE.test(repoRelativePath);
}

type ParsedFile = {
  sourceFile: ts.SourceFile;
  localFunctions: Map<string, FunctionLike>;
  localBindings: Map<string, ts.Expression>;
};

/**
 * Builds the resolver `run()` passes into every facade file's `analyzeFile` call. Indexes every
 * bare-identifier call expression (`someFunction(...)`, never `obj.someFunction(...)` — facade
 * functions are always imported as named exports and called directly, never as a method) across
 * the WHOLE scanned tree, keyed by callee name, ONCE — so N candidates across M facade files never
 * re-scan the tree N×M times. Each caller file is parsed at most once (`fileCache`).
 */
export function buildFacadeParamResolver(
  repoRoot: string,
  files: readonly string[],
): FacadeParamResolver {
  const fileCache = new Map<string, ParsedFile>();
  function getParsedFile(relFile: string): ParsedFile {
    let entry = fileCache.get(relFile);
    if (!entry) {
      const text = readFileSync(join(repoRoot, relFile), "utf8");
      const sourceFile = ts.createSourceFile(relFile, text, ts.ScriptTarget.Latest, true);
      entry = {
        sourceFile,
        localFunctions: collectLocalFunctions(sourceFile),
        localBindings: collectLocalBindings(sourceFile),
      };
      fileCache.set(relFile, entry);
    }
    return entry;
  }

  const callSites = new Map<string, { file: string; args: ts.Expression[] }[]>();
  for (const relFile of files) {
    const { sourceFile } = getParsedFile(relFile);
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const list = callSites.get(name) ?? [];
        list.push({ file: relFile, args: [...node.arguments] });
        callSites.set(name, list);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  const resolve: FacadeParamResolver = (functionName, paramIndex, visiting) => {
    const key = `${functionName}#${paramIndex}`;
    if (visiting.has(key)) return "unknown"; // cycle guard
    const sites = callSites.get(functionName);
    if (!sites || sites.length === 0) {
      return "unknown"; // no call site found anywhere — honestly unresolved, not assumed safe
    }
    const nextVisiting = new Set(visiting);
    nextVisiting.add(key);
    const verdicts = sites.map(({ file, args }): Verdict => {
      const arg = args[paramIndex];
      if (!arg) return "unknown"; // this call site omitted an optional parameter entirely
      const { localFunctions, localBindings } = getParsedFile(file);
      // Exactly one hop (module header / FacadeParamResolver docblock): the nested evaluation
      // runs with NO facade-param resolution of its own, so an unresolved identifier at the
      // CALLER is "unknown", never chased through a second facade boundary.
      return isSafeExpr(arg, {
        localFunctions,
        localBindings,
        paramOverride: null,
        visiting: new Set(),
        enclosingFacadeFn: null,
        resolveFacadeParam: null,
      });
    });
    return combine(verdicts);
  };
  return resolve;
}

// ── Exceptions ────────────────────────────────────────────────────────────────────────────────

export type SaldoLockDisposition = "safe" | "deferred";

export type SaldoLockException = {
  file: string;
  line: number;
  disposition: SaldoLockDisposition;
  reason: string;
  /** Mandatory when disposition is "deferred" — the issue tracking the confirmed bug. */
  trackedIssue?: string;
};

const VALID_DISPOSITIONS: readonly SaldoLockDisposition[] = ["safe", "deferred"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structurally and semantically validates a raw (untyped) exceptions payload against the CURRENT
 * candidate set. An entry naming a `file:line` that no longer has an "unsafe" finding is a HARD
 * ERROR (mirrors `lint-tenant-scoping-exceptions.ts` / `lint-facade-signatures.ts` — a stale entry
 * is a blanket allow waiting to happen).
 */
export function validateExceptionsDocument(
  raw: unknown,
  candidates: readonly Candidate[],
): { ok: true; entries: SaldoLockException[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      errors: [`${EXCEPTIONS_FILE} must contain a JSON array of exception entries`],
    };
  }

  const errors: string[] = [];
  const valid: SaldoLockException[] = [];

  raw.forEach((entryRaw: unknown, index: number) => {
    const label = `entry #${index}`;
    if (!isRecord(entryRaw)) {
      errors.push(`${label}: entry is not an object`);
      return;
    }
    const { file, line, disposition, reason, trackedIssue } = entryRaw;

    if (typeof file !== "string" || file.length === 0) {
      errors.push(`${label}: missing or invalid 'file' (repo-relative path expected)`);
      return;
    }
    if (file.includes("__tests__")) {
      errors.push(`${label}: 'file' is under __tests__ — a test fixture needs no exception`);
      return;
    }
    if (typeof line !== "number" || !Number.isInteger(line) || line <= 0) {
      errors.push(`${label} (${file}): missing or invalid 'line' (positive integer expected)`);
      return;
    }
    if (
      typeof disposition !== "string" ||
      !VALID_DISPOSITIONS.includes(disposition as SaldoLockDisposition)
    ) {
      errors.push(
        `${label} (${file}:${line}): missing or invalid 'disposition' — must be one of ` +
          `${JSON.stringify(VALID_DISPOSITIONS)}`,
      );
      return;
    }
    if (
      disposition === "deferred" &&
      (typeof trackedIssue !== "string" || trackedIssue.trim().length === 0)
    ) {
      errors.push(
        `${label} (${file}:${line}): disposition "deferred" requires a non-empty 'trackedIssue' — ` +
          `a deferred, confirmed bug MUST be filed, not just noted here`,
      );
      return;
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      errors.push(`${label} (${file}:${line}): missing 'reason' — every exception MUST say WHY`);
      return;
    }
    if (reason.trim().length < MIN_REASON_LENGTH) {
      errors.push(
        `${label} (${file}:${line}): 'reason' is only ${reason.trim().length} character(s) — must ` +
          `read as a sentence, not a label (minimum ${MIN_REASON_LENGTH})`,
      );
      return;
    }

    const match = candidates.find((c) => c.file === file && c.line === line);
    if (!match) {
      errors.push(
        `${label} (${file}:${line}): STALE — no periodStart/periodType:"MONTHLY" where-candidate ` +
          `exists there any more (moved, fixed, or removed) — update or remove this entry`,
      );
      return;
    }
    if (match.verdict !== "unsafe") {
      errors.push(
        `${label} (${file}:${line}): STALE — this candidate's verdict is now "${match.verdict}", ` +
          `not "unsafe" — remove the now-unnecessary exception`,
      );
      return;
    }

    valid.push({
      file,
      line,
      disposition: disposition as SaldoLockDisposition,
      reason: reason.trim(),
      ...(typeof trackedIssue === "string" ? { trackedIssue: trackedIssue.trim() } : {}),
    });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entries: valid };
}

// ── Findings ──────────────────────────────────────────────────────────────────────────────────

export type Finding = { file: string; line: number; snippet: string };

/** Every "unsafe" candidate NOT covered by a named exception entry (file + line match). */
export function computeFindings(
  candidates: readonly Candidate[],
  exceptions: readonly SaldoLockException[],
): Finding[] {
  const findings: Finding[] = [];
  for (const c of candidates) {
    if (c.verdict !== "unsafe") continue;
    const excepted = exceptions.some((e) => e.file === c.file && e.line === c.line);
    if (excepted) continue;
    findings.push({ file: c.file, line: c.line, snippet: c.snippet });
  }
  return findings;
}

export function formatSummary(
  candidates: readonly Candidate[],
  exceptions: readonly SaldoLockException[],
  findingsCount: number,
): string {
  const safe = candidates.filter((c) => c.verdict === "safe").length;
  const unsafe = candidates.filter((c) => c.verdict === "unsafe").length;
  const unknown = candidates.filter((c) => c.verdict === "unknown").length;
  const safeExceptions = exceptions.filter((e) => e.disposition === "safe").length;
  const deferredExceptions = exceptions.filter((e) => e.disposition === "deferred").length;
  return (
    `[lint:saldo-lock-derivation] ${candidates.length} candidate(s) (periodType:"MONTHLY" ` +
    `where-comparisons on periodStart) — ${safe} safe / ${unsafe} unsafe / ${unknown} unknown ` +
    `(unresolved across a function-call boundary, NOT verified — see this gate's own module ` +
    `header); ${exceptions.length} exception(s) applied (${safeExceptions} verified-safe / ` +
    `${deferredExceptions} deferred-known-bug, tracked separately — NOT a safety claim), ` +
    `${findingsCount} finding(s).`
  );
}

// ── CLI entry point ───────────────────────────────────────────────────────────────────────────

export function run(repoRoot: string): number {
  const files = discoverSourceFiles(repoRoot);

  if (files.length === 0) {
    console.error(
      "lint-saldo-lock-derivation: 0 source file(s) found under apps/api/src — a linter that " +
        "walks zero files and reports OK is #229 verbatim.",
    );
    // `process.exitCode` set explicitly (235-08/A2, the SAME classifier-visibility fix
    // lint-facade-signatures.ts's structurally identical gap got in 235-05): this `return 1` is
    // already correctly wired via the CLI entry's `process.exit(run(repoRoot))` below, so the
    // REAL exit code was never wrong — only `lint-guard-vacuity`'s classifier, which recognises
    // `throw`/`process.exit(<n>)`/`process.exitCode = <n>` but not a plain `return <n>`, could not
    // see this proof existed. Zero behavior change; the file-set proof itself (`235-BASELINE.md`
    // § A2) was already correct before this line was added.
    process.exitCode = 1;
    return 1;
  }

  // Built once, reused for every facade file — see "Facade parameter resolution" above.
  const resolveFacadeParam = buildFacadeParamResolver(repoRoot, files);
  const candidates = files.flatMap((relFile) =>
    analyzeFile(
      join(repoRoot, relFile),
      relFile,
      isFacadeFilePath(relFile) ? resolveFacadeParam : null,
    ),
  );

  // The #229 stance, applied to CANDIDATES, not just files: SaldoSnapshot.periodStart is a real,
  // heavily-used field (19+ files reference it today) — zero MONTHLY where-candidates found across
  // the whole scan means this gate's own detection logic broke, not that the codebase got safer.
  if (candidates.length === 0) {
    console.error(
      'lint-saldo-lock-derivation: 0 periodStart/periodType:"MONTHLY" where-candidate(s) found ' +
        "across the whole scan. SaldoSnapshot.periodStart is compared in over a dozen files today " +
        "— finding none means this gate's own AST matching broke, not that the codebase is clean. " +
        "Refusing to report success on work it did not do (#229).",
    );
    return 1;
  }

  const exceptionsAbsPath = join(repoRoot, EXCEPTIONS_FILE);
  const rawExceptions: unknown = existsSync(exceptionsAbsPath)
    ? JSON.parse(readFileSync(exceptionsAbsPath, "utf8"))
    : [];
  const validated = validateExceptionsDocument(rawExceptions, candidates);
  if (!validated.ok) {
    console.error(`lint-saldo-lock-derivation: ${EXCEPTIONS_FILE} is invalid:`);
    for (const e of validated.errors) console.error(`  - ${e}`);
    return 1;
  }

  const findings = computeFindings(candidates, validated.entries);
  console.log(formatSummary(candidates, validated.entries, findings.length));

  const deferred = validated.entries.filter((e) => e.disposition === "deferred");
  if (deferred.length > 0) {
    console.log("");
    console.log(
      "  Deferred (confirmed unsafe, deliberately NOT fixed here — tracked separately, not a " +
        "safety claim):",
    );
    for (const e of deferred) {
      console.log(`  ${e.file}:${e.line}  ${e.trackedIssue}  ${e.reason}`);
    }
  }

  if (findings.length > 0) {
    console.error("");
    console.error(
      '  A periodStart comparison against a periodType:"MONTHLY" SaldoSnapshot that does not ' +
        "trace back to monthRangeUtc() is the exact defect class of Issue #241 (5 sites found by " +
        "hand). Either fix the derivation, or — ONLY once you have understood why it is actually " +
        `safe — add a reasoned entry to ${EXCEPTIONS_FILE}.`,
    );
    console.error("");
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}  ${f.snippet}`);
    }
    return 1;
  }
  return 0;
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
  process.exit(run(repoRoot));
}
