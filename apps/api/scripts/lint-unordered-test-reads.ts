#!/usr/bin/env -S pnpm exec tsx
/**
 * lint:unordered-test-reads — Issue #561 (flake class of #555).
 *
 * One action can write several `AuditLog` rows (or notify the same person twice) within the same
 * millisecond. A test that picks "the" row with an unordered `findFirst` gets whichever row
 * Postgres happens to return, so it passes alone and flakes in the full parallel run. This gate
 * refuses that shape in tests; the fix is `auditRowsFor()` / `auditRowChangingField()` from
 * `src/__tests__/setup.ts`, or an explicit `orderBy`.
 *
 * ── What is flagged (every test file under `apps/api/src`: `__tests__/` dirs and `*.test.ts`) ──
 * A call `<receiver>.auditLog.<m>(…)` or `<receiver>.notification.<m>(…)` (`prisma`, `app.prisma`,
 * `tx`, … — any receiver) where
 *   - `unordered-find-first` — `<m>` is `findFirst` / `findFirstOrThrow` and the first argument is
 *     not an object literal holding an `orderBy` property (a spread or a variable argument cannot
 *     be proven ordered and is flagged);
 *   - `unordered-find-many-indexed` — `<m>` is `findMany`, the arguments hold no `orderBy`, and the
 *     result is picked by position: the awaited call is indexed directly (`(await …)[0]`,
 *     `.at(0)`), or it is bound to a name / array destructuring that the same file indexes with
 *     `name[<n>]` or `name.at(<n>)`.
 * A `findMany` that is only counted, filtered or iterated is order-independent and not flagged.
 *
 * ── AST, not regex ─────────────────────────────────────────────────────────────────────────────
 * `ts.createSourceFile`; comments and strings are never visited. Structurally invisible: an
 * indexed `findMany` result handed through a function return, and a delegate reached through a
 * variable (`const d = prisma.auditLog; d.findFirst()`). Production code is out of scope (its
 * `findFirst` is existence/dedupe lookups, not row selection for an assertion).
 *
 * ── House form ─────────────────────────────────────────────────────────────────────────────────
 * Pure exports (`findUnorderedReads`, `isTestFile`) are unit-tested in
 * `scripts/__tests__/lint-unordered-test-reads.test.ts`. The walk sits in a named function that
 * calls `readdirSync` itself and the empty walk exits 1 (`empty-abort` for lint-guard-vacuity).
 * There is no exceptions file: every hit is converted, not excepted.
 *
 * Exit codes: 0 — files walked, no finding; 1 — empty walk or at least one finding.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";

export const SRC_DIR = "apps/api/src";

const DELEGATES: ReadonlySet<string> = new Set(["auditLog", "notification"]);
const FIND_FIRST: ReadonlySet<string> = new Set(["findFirst", "findFirstOrThrow"]);

export type UnorderedReadShape = "unordered-find-first" | "unordered-find-many-indexed";

export interface UnorderedReadFinding {
  line: number;
  shape: UnorderedReadShape;
  text: string;
}

export function isTestFile(repoRelativePath: string): boolean {
  const p = repoRelativePath.replace(/\\/g, "/");
  if (!p.startsWith(`${SRC_DIR}/`) || !p.endsWith(".ts")) return false;
  return p.endsWith(".test.ts") || p.split("/").includes("__tests__");
}

/** Strips parentheses, casts, `!` and `await` — none changes which rows come back. */
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

/** `<receiver>.auditLog.<method>(…)` → method name, else undefined. */
function delegateCallMethod(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const recv = callee.expression;
  if (!ts.isPropertyAccessExpression(recv) && !ts.isIdentifier(recv)) return undefined;
  const delegate = ts.isPropertyAccessExpression(recv) ? recv.name.text : recv.text;
  return DELEGATES.has(delegate) ? callee.name.text : undefined;
}

function hasOrderBy(call: ts.CallExpression): boolean {
  const arg = call.arguments[0];
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return false;
  return arg.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      ts.isIdentifier(p.name) &&
      p.name.text === "orderBy",
  );
}

export function findUnorderedReads(fileName: string, text: string): UnorderedReadFinding[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const findings: UnorderedReadFinding[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const snippet = (n: ts.Node) => n.getText(sf).split("\n")[0]!.slice(0, 100);

  // Names the file indexes by position: `name[0]`, `name.at(0)`.
  const indexedNames = new Set<string>();
  const collect = (n: ts.Node): void => {
    if (ts.isElementAccessExpression(n)) {
      const base = unwrap(n.expression);
      if (ts.isIdentifier(base)) indexedNames.add(base.text);
    } else if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "at"
    ) {
      const base = unwrap(n.expression.expression);
      if (ts.isIdentifier(base)) indexedNames.add(base.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  /** The findMany result is indexed directly, or bound to a name / array pattern indexed later. */
  const isPickedByPosition = (call: ts.CallExpression): boolean => {
    let node: ts.Node = call;
    while (
      node.parent &&
      (ts.isAwaitExpression(node.parent) ||
        ts.isParenthesizedExpression(node.parent) ||
        ts.isAsExpression(node.parent) ||
        ts.isNonNullExpression(node.parent))
    ) {
      node = node.parent;
    }
    const parent = node.parent;
    if (parent === undefined) return false;
    if (ts.isElementAccessExpression(parent) && parent.expression === node) return true;
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      parent.name.text === "at"
    ) {
      return true;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
      if (ts.isArrayBindingPattern(parent.name)) return true;
      return ts.isIdentifier(parent.name) && indexedNames.has(parent.name.text);
    }
    return false;
  };

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const method = delegateCallMethod(n);
      if (method !== undefined && FIND_FIRST.has(method) && !hasOrderBy(n)) {
        findings.push({ line: lineOf(n), shape: "unordered-find-first", text: snippet(n) });
      } else if (method === "findMany" && !hasOrderBy(n) && isPickedByPosition(n)) {
        findings.push({ line: lineOf(n), shape: "unordered-find-many-indexed", text: snippet(n) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return findings;
}

/**
 * Every test file under `apps/api/src`, repo-relative, sorted. A named function that calls
 * `readdirSync` itself — `lint-guard-vacuity-detect.ts` resolves walk-containing functions by
 * declaration.
 */
export function discoverTestFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (relDir: string): void => {
    for (const entry of readdirSync(join(repoRoot, relDir), { withFileTypes: true })) {
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(rel);
      } else if (isTestFile(rel)) {
        out.push(rel);
      }
    }
  };
  walk(SRC_DIR);
  return out.sort();
}

export function run(repoRoot: string): number {
  const files = discoverTestFiles(repoRoot);
  if (files.length === 0) {
    console.error(
      `lint-unordered-test-reads: no test file found under ${SRC_DIR}/ — the source root moved or the walk broke; check the path, not the count.`,
    );
    process.exit(1);
  }
  const findings = files.flatMap((file) =>
    findUnorderedReads(file, readFileSync(join(repoRoot, file), "utf8")).map((f) => ({
      file,
      ...f,
    })),
  );
  if (findings.length > 0) {
    console.error(
      `lint-unordered-test-reads: FAILED — ${findings.length} unordered audit/notification read(s) in tests (Issue #561):`,
    );
    for (const f of findings) console.error(`  ${f.file}:${f.line}: ${f.shape} — ${f.text}`);
    console.error(
      "Use auditRowsFor() / auditRowChangingField() from src/__tests__/setup.ts, or add an explicit " +
        "orderBy. There is no exceptions file.",
    );
    return 1;
  }
  console.log(
    `lint-unordered-test-reads: OK — 0 finding(s) in ${files.length} test file(s) under ${SRC_DIR}/`,
  );
  return 0;
}

function main(): void {
  const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
  process.exitCode = run(repoRoot);
}

// Run the scan only when this file is the process entry point (Issue #203).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
