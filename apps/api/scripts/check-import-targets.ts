#!/usr/bin/env -S pnpm exec tsx
/**
 * Phase 99b Plan 01 (Wave 1), Task 2a — `lint:import-targets` (D-12).
 *
 * `apps/api/tsconfig.json` has `include: ["src/**\/*"]`, so a broken relative import in any of the
 * 20 operator scripts under `apps/api/scripts/` is caught by NEITHER `pnpm --filter @clokr/api
 * typecheck` NOR the vitest suite (`vitest.config.ts`'s own `include` is `["src/**\/*.test.ts",
 * "scripts/**\/*.test.ts"]` — it collects tests, not arbitrary scripts). Those scripts are
 * backfills and repair tools for an audit-proof payroll system; a break discovered a year later,
 * during an incident, is the worst possible time. This is exactly the class D-12 calls "die
 * stillen sind die gefährlichen" (the silent ones are the dangerous ones).
 *
 * A SECOND, distinct hole this tool closes: a wrong relative `vi.mock()` specifier does NOT throw.
 * The mock simply stops applying and the test runs against the real implementation instead — green,
 * and meaningless. `typecheck` does not see `vi.mock()` string arguments as imports either, so that
 * hole survives typecheck too. This tool is the only thing in the repo that resolves a `vi.mock()`
 * specifier against the filesystem.
 *
 * ── What this checks — resolvability only, no AST heuristics beyond finding the specifier ───────
 * Walks `apps/api/src/**\/*.ts`, `apps/api/scripts/**\/*.ts` and `apps/api/vitest*.ts`, and collects
 * every RELATIVE module specifier in four syntactic forms (all four occur in this repo — measured
 * in plan 99B-01's own research):
 *
 *   1. `from "./x"` / `from "../x"`         — ImportDeclaration / ExportDeclaration
 *   2. `import("./x")`                       — dynamic import call expression
 *   3. `vi.mock("../x")`                     — the silent-failure case above
 *   4. `typeof import("../x")`               — ImportTypeNode (also covers plain `import("./x").Foo`
 *                                               type-only usage, which resolves the same way)
 *
 * Each specifier is resolved against the IMPORTING file's own directory, trying, in order: the
 * literal path with a `.ts` extension appended, `<path>/index.ts`, and the literal path itself.
 * Every specifier that resolves to nothing is reported as `file:line -> specifier` and the run exits
 * 1. Bare specifiers (`fastify`, `@clokr/db`) and `node:` builtins are ignored entirely — this tool
 * only ever looks at specifiers starting with `.`.
 *
 * This module has no side effects on import — `main()` is guarded exactly like
 * `scripts/lint-tenant-scoping.ts:337` (GitHub #203: an unguarded `main()` runs on import;
 * `apps/api/scripts/audit-workdays-vs-day-hours.ts:253-256` is the script that lacked this guard).
 *
 * ── Flags ──────────────────────────────────────────────────────────────────────────────────────
 *   --list   Print every checked specifier (resolved AND unresolved) instead of only failures — the
 *            way to confirm the tool actually SAW a given occurrence, independent of whether it
 *            happens to resolve today.
 *
 * Exit codes:
 *   0 — every relative specifier resolved
 *   1 — at least one relative specifier resolved to nothing
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { pathToFileURL } from "node:url";

// ── File discovery ─────────────────────────────────────────────────────────────────────────────

const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);

function walkTsFiles(absDir: string, out: string[]): void {
  for (const entry of fs.readdirSync(absDir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const full = path.join(absDir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
}

/** `apps/api/src/**\/*.ts`, `apps/api/scripts/**\/*.ts`, `apps/api/vitest*.ts` — every file this
 * tool checks, as absolute paths. */
export function discoverCheckedFiles(apiRoot: string): string[] {
  const out: string[] = [];
  walkTsFiles(path.join(apiRoot, "src"), out);
  walkTsFiles(path.join(apiRoot, "scripts"), out);
  for (const entry of fs.readdirSync(apiRoot)) {
    if (entry.startsWith("vitest") && entry.endsWith(".ts")) {
      out.push(path.join(apiRoot, entry));
    }
  }
  return out.sort();
}

// ── Specifier extraction (the four forms) ─────────────────────────────────────────────────────

export type SpecifierOccurrence = {
  file: string; // repo-relative, forward slashes
  line: number; // 1-based
  specifier: string;
  form: "from" | "dynamic-import" | "vi.mock" | "typeof-import";
  /** Character offsets of the specifier TEXT ONLY (quotes excluded) within the source file — used
   * by scripts/context-cut-move.ts (Wave 1, D-12) for precise in-place text splicing. Not used by
   * this file's own CLI, which only ever reports `line`. */
  start: number;
  end: number;
};

function isViMockCall(node: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "vi" &&
    node.expression.name.text === "mock"
  );
}

function isDynamicImportCall(node: ts.CallExpression): boolean {
  return node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

/** All relative-specifier occurrences (any of the four forms) in one parsed file. */
export function extractSpecifiers(
  sourceFile: ts.SourceFile,
  repoRelativePath: string,
): SpecifierOccurrence[] {
  const results: SpecifierOccurrence[] = [];

  function record(node: ts.StringLiteral, form: SpecifierOccurrence["form"]): void {
    const specifier = node.text;
    if (!specifier.startsWith(".")) return; // bare specifiers / node: builtins — out of scope
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    // node.getStart()/getEnd() span the full string-literal token including its quotes; the
    // TEXT is one character in on each side.
    results.push({
      file: repoRelativePath,
      line,
      specifier,
      form,
      start: node.getStart(sourceFile) + 1,
      end: node.getEnd() - 1,
    });
  }

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier, "from");
    } else if (ts.isCallExpression(node) && isDynamicImportCall(node)) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) record(arg, "dynamic-import");
    } else if (ts.isCallExpression(node) && isViMockCall(node)) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) record(arg, "vi.mock");
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      record(node.argument.literal, "typeof-import");
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

// ── Resolution ─────────────────────────────────────────────────────────────────────────────────

/** Exported so scripts/context-cut-move.ts can detect the same NodeNext-style explicit-extension
 * specifiers when it recomputes a rewritten path (preserving the `.js` suffix, not just resolving
 * through it). */
export const EXPLICIT_JS_EXTENSION = /\.(js|mjs|cjs)$/;

/** Resolves `specifier` against the directory of `fromAbsFile`, trying `.ts`, `/index.ts`, then
 * the literal path, in that order. Returns the resolved absolute path, or `null`.
 *
 * A handful of files in this repo (e.g. `src/routes/test-bootstrap.ts`, `src/utils/jarbschg.ts`)
 * write NodeNext-style explicit `.js` specifiers (`"../config.js"`) that point at `.ts` source —
 * TypeScript's own resolver maps `.js` -> `.ts` for this style. That mapping is tried too, so this
 * tool does not report those as false positives. */
export function resolveSpecifier(fromAbsFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromAbsFile), specifier);
  const candidates = [`${base}.ts`, path.join(base, "index.ts"), base];
  const jsExtMatch = EXPLICIT_JS_EXTENSION.exec(base);
  if (jsExtMatch) {
    candidates.push(`${base.slice(0, -jsExtMatch[0].length)}.ts`);
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// ── Orchestration ──────────────────────────────────────────────────────────────────────────────

export type CheckedOccurrence = SpecifierOccurrence & { resolved: boolean };

/** Every relative-specifier occurrence under `apiRoot`, resolved or not — the input both
 * `checkImportTargets` and the CLI's `--list` mode are derived from. */
export function collectAllOccurrences(apiRoot: string): CheckedOccurrence[] {
  const results: CheckedOccurrence[] = [];
  for (const absFile of discoverCheckedFiles(apiRoot)) {
    const relPath = path.relative(apiRoot, absFile).split(path.sep).join("/");
    const text = fs.readFileSync(absFile, "utf8");
    const sourceFile = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, true);
    for (const occurrence of extractSpecifiers(sourceFile, relPath)) {
      const resolved = resolveSpecifier(absFile, occurrence.specifier) !== null;
      results.push({ ...occurrence, resolved });
    }
  }
  return results;
}

/** Every relative-specifier occurrence under `apiRoot` (src, scripts, vitest*.ts) that resolves to
 * nothing. Pure function of the tree on disk — performs no `process.exit`. */
export function checkImportTargets(
  apiRoot: string,
): { file: string; line: number; specifier: string }[] {
  return collectAllOccurrences(apiRoot)
    .filter((o) => !o.resolved)
    .map(({ file, line, specifier }) => ({ file, line, specifier }));
}

// ── CLI entry ──────────────────────────────────────────────────────────────────────────────────

function resolveApiRoot(): string {
  const scriptDir = import.meta.dirname ?? path.resolve(new URL(import.meta.url).pathname, "..");
  return path.resolve(scriptDir, "..");
}

function main(): void {
  const apiRoot = resolveApiRoot();
  const list = process.argv.includes("--list");

  if (list) {
    const all = collectAllOccurrences(apiRoot);
    for (const o of all) {
      console.log(
        `${o.file}:${o.line} -> ${o.specifier} (${o.form}) [${o.resolved ? "OK" : "UNRESOLVED"}]`,
      );
    }
    console.log(`\n[lint:import-targets] --list: ${all.length} specifier(s) total.`);
    return;
  }

  const all = collectAllOccurrences(apiRoot);
  const unresolved = all.filter((o) => !o.resolved);

  if (unresolved.length === 0) {
    console.log(
      `[lint:import-targets] OK — ${all.length} relative specifier(s) checked, all resolved.`,
    );
    process.exitCode = 0;
    return;
  }

  console.error(`\n[lint:import-targets] ${unresolved.length} unresolved specifier(s):\n`);
  for (const o of unresolved) {
    console.error(`  ${o.file}:${o.line} -> ${o.specifier}`);
  }
  console.error(
    `\n${all.length} specifier(s) checked total, ${unresolved.length} unresolved. A relative ` +
      `import/re-export, dynamic import(), vi.mock() or typeof import() that resolves to nothing ` +
      `under apps/api/src, apps/api/scripts or apps/api/vitest*.ts is a defect — fix the path, or ` +
      `if the target genuinely moved, the importer was missed by whatever moved it.\n`,
  );
  process.exitCode = 1;
}

// Run the scan only when this file is the process entry point — importing it (e.g. from a test)
// never scans anything (Issue #203).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
