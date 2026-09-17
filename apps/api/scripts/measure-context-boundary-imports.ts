#!/usr/bin/env -S pnpm exec tsx
/**
 * Phase 101B Plan 01 (AC-1/AC-6, D-06/D-07) — the instrument the whole phase's later waves are
 * measured against. GitHub issue #101 (T6, "ESLint-Boundaries — fremde Kontext-Interna
 * maschinell verbieten").
 *
 * ── WHAT THIS MEASURES ──────────────────────────────────────────────────────────────────────────
 * Every relative module specifier in `apps/api/src/**\/*.ts` PRODUCTION code (any path segment
 * `__tests__` and any `*.test.ts` file are skipped — Owner decision #246: tests stay out of scope
 * for this rule) that RESOLVES into `src/contexts/<x>/**` for a context `<x>` that is not the
 * importing file's own area. A specifier resolving to `src/contexts/<x>/index.ts` is a LEGAL
 * import through the context's public surface (Phase 100b) and is not counted. Everything else
 * that resolves deeper is a DEEP import — the thing ADR 0001 rule 3 forbids and this phase's
 * ESLint rule (plan 02) will start rejecting. WORKLOAD is DEEP minus whatever
 * `context-boundary-import-exceptions.json` names as an exception (today: only `src/app.ts`, the
 * composition root, D-01/Form C).
 *
 * ── WHY `services/clock` / `services/phorest` ARE NOT A FOURTH AREA (ADR 0001 entry F) ────────────
 * Entry F states Zeiterfassung is `contexts/time-tracking/` AND `services/clock/`, and
 * Schichtplanung is `contexts/scheduling/` AND `services/phorest/` — two physical trees, one
 * context each. `classifyArea()` below encodes exactly that. Getting this wrong would invent two
 * false violations — `services/clock/resolver.ts` and `services/phorest/sync-shifts.ts` reading
 * their OWN context's internals, merely because the path happens to spell a different context's
 * name nowhere near it.
 *
 * ── WHY THIS DOES NOT RE-IMPLEMENT SPECIFIER EXTRACTION (AC-6, blind-spot inventory) ───────────────
 * `extractSpecifiers`/`resolveSpecifier` are imported from `./check-import-targets.ts`, not
 * rebuilt. That is what makes all four specifier forms (`from`, dynamic `import()`, `vi.mock()`,
 * `typeof import()`) and the NodeNext `.js` -> `.ts` resolution free instead of four separate blind
 * spots. The single most consequential blind spot in this tree (CONTEXT.md `<specifics>`,
 * RESEARCH.md "Blind-spot inventory" #2): most cross-context specifiers written FROM INSIDE
 * `contexts/` never repeat the literal segment `contexts/` — a file in `contexts/scheduling/`
 * importing `contexts/absence/` writes `from "../../absence"`, not `from "../../contexts/absence"`.
 * This tool classifies by the RESOLVED path, never by a substring match on the specifier text, so
 * that distinction is structurally impossible to get wrong here the way a naive `contexts/<name>`
 * glob would (RESEARCH.md "Anti-Patterns to Avoid").
 *
 * The five context names are a literal array (`BOUNDARY_CONTEXTS`), never a lowercase-letter-only
 * character class — `time-tracking` and `working-time-account` both carry a hyphen, and this repo
 * has made exactly this hyphen-blind mistake four times in one night (CONTEXT.md `<specifics>`).
 *
 * ── HOUSE-FORM NOTES ─────────────────────────────────────────────────────────────────────────────
 * Structured after `measure-foreign-context-access.ts`: Part A is exported pure-ish helpers (file
 * I/O confined to a handful of named `scan*`/`load*` functions so `__tests__/` can drive everything
 * else against a fixture directory); Part B is a `main()` guarded by the
 * `import.meta.url === pathToFileURL(process.argv[1]).href` check (Issue #203 — an unguarded
 * `main()` once dropped a suite's own worker databases; this script only reads, but the guard is
 * the house rule, not a database-specific precaution).
 *
 * The exceptions file mirrors `foreign-context-access-exceptions.json`'s validation shape
 * (mandatory `reason` >= `MIN_REASON_LENGTH` characters, staleness detection) but supports TWO
 * exception kinds (D-04): a `wholeFile` entry (matched by file, its count checked by EQUALITY
 * against `expectedCount` — today only `src/app.ts`, the composition root) and a per-site entry
 * (matched by file + exact specifier text — added by plan 04 onward, for E-1..E-5/E-7/E-8).
 *
 * ── Flags ────────────────────────────────────────────────────────────────────────────────────────
 *   (none)               Print the one-line summary and exit 0.
 *   --check <n>          Exit 0 iff WORKLOAD equals <n> EXACTLY (equality, not a floor — a
 *                         DECREASE is exactly as much a mismatch as an increase); otherwise print
 *                         the delta and the workload file list and exit 1.
 *   --rows               `file:line | form | fromArea -> target/targetModule | {symbols}` for every
 *                         workload row, sorted by target then file then line.
 *   --by-target          Workload count and importer-file count per target context, descending —
 *                         the unit each later wave (plans 05-09) converts.
 *   --forms               Workload count per import form. `no-restricted-imports` (plan 02) cannot
 *                         see the `dynamic-import` form (RESEARCH.md, live-probed) — the count on
 *                         that line is the exact size of the gap only THIS tool covers.
 *   --predict <context>  Before the named context's wave runs, print
 *                         `deep=<n> files=<m> files-already-importing-index=<k>
 *                         predicted-import-targets-delta=-(n-(m-k))` — the expected change to
 *                         `lint:import-targets`'s specifier count under the wave's merge rule (one
 *                         import statement per (file, target) pair, merged into an existing index
 *                         import when the file already has one).
 *   --cycles             Import-cycle check (Plan 03, D-08). Over the REAL graph by default; add
 *                         `--project <ctx>[,<ctx>...]` (or `all`) to run it over the PROJECTED
 *                         graph instead — the graph as it would look after the named contexts
 *                         convert (every workload deep import into that context becomes an
 *                         `A -> index.ts` + `index.ts -> deepFile` pair; an EXCEPTED deep import
 *                         stays deep and gets no re-export edge at all — see the module docblock's
 *                         "correction you must not repeat"). Add `--extract-sim <name>` (one of
 *                         `none`, `option-d-tt`, `option-d-wta`, `option-d-tt+anon`,
 *                         `option-d-wta+anon`) to additionally simulate lifting the eight
 *                         cross-context-consumed symbols out of the two route files into leaf
 *                         modules (Option D). Prints
 *                         `cycles: <k> component(s), <m> module(s) in cycles`, each component's
 *                         members, and which `contexts/*\/index.ts` files sit inside it. Combine
 *                         with `--check <n>` to gate by EQUALITY on `<m>` (never "exit 1 on any
 *                         cycle" — a PREDICTED cycle count must be able to pass). Combine with
 *                         `--paths` to print the shortest `index -> ... -> index` path for every
 *                         still-mutually-reachable ordered context pair — this is what turns "a
 *                         cycle remains" into "this module carries it".
 *
 * Exit codes:
 *   0 — summary/--rows/--by-target/--forms/--predict/--cycles printed, or --check matched
 *   1 — the exceptions file is invalid (bad shape, short/missing reason, stale entry, count
 *       mismatch on a wholeFile entry), an unknown target was passed to --predict, an unknown
 *       context was passed to --project, an unknown scenario was passed to --extract-sim, or
 *       --check did not match
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";
import {
  extractSpecifiers,
  resolveSpecifier,
  type SpecifierOccurrence,
} from "./check-import-targets";

// ── Part A: exported pure-ish helpers (file I/O confined to scan*/load*) ───────────────────────

/** The five contexts this rule protects (ADR 0001 §3). A literal array, never a regex character
 * class — see the module docblock's hyphen warning. */
export const BOUNDARY_CONTEXTS = [
  "platform",
  "time-tracking",
  "absence",
  "scheduling",
  "working-time-account",
] as const;
export type BoundaryContext = (typeof BOUNDARY_CONTEXTS)[number];

const BOUNDARY_CONTEXT_SET: ReadonlySet<string> = new Set(BOUNDARY_CONTEXTS);

export function isBoundaryContext(value: string): value is BoundaryContext {
  return BOUNDARY_CONTEXT_SET.has(value);
}

/** Where an importing FILE sits: one of the five contexts, the cross-context `composition/`
 * layer, or `"other"` (`app.ts`, `middleware/`, `utils/`, `index.ts`, `config.ts`, …). */
export type FileArea = BoundaryContext | "composition" | "other";

/**
 * Classifies a file by where it sits, given a path relative to `apps/api` (POSIX, WITH the
 * leading `src/` — this is the same convention `SpecifierOccurrence.file` already uses in
 * `check-import-targets.ts`). Encodes ADR 0001 entry F exhaustively:
 * `src/contexts/<x>/**` -> `<x>` (only for `<x>` in `BOUNDARY_CONTEXTS`, else `"other"`);
 * `src/services/clock/**` -> `"time-tracking"`; `src/services/phorest/**` -> `"scheduling"`;
 * `src/composition/**` -> `"composition"`; anything else (`src/app.ts`, `src/middleware/**`,
 * `src/utils/**`, `src/index.ts`, `src/config.ts`, `src/services/**` outside clock/phorest) ->
 * `"other"`.
 */
export function classifyArea(repoRelToApiRoot: string): FileArea {
  if (repoRelToApiRoot.startsWith("src/contexts/")) {
    const seg = repoRelToApiRoot.split("/")[2];
    return isBoundaryContext(seg) ? seg : "other";
  }
  if (repoRelToApiRoot.startsWith("src/services/clock/")) return "time-tracking";
  if (repoRelToApiRoot.startsWith("src/services/phorest/")) return "scheduling";
  if (repoRelToApiRoot.startsWith("src/composition/")) return "composition";
  return "other";
}

// ── File discovery: production code only (D-06's own scope, distinct from check-import-targets's
// broader src+scripts+vitest* walk, which deliberately DOES include tests for ITS purpose) ─────

const SKIP_DIR_NAMES = new Set(["__tests__", "node_modules", "dist", ".git"]);

function walkProductionTsFiles(absDir: string, apiRoot: string, out: string[]): void {
  for (const entry of readdirSync(absDir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const full = join(absDir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkProductionTsFiles(full, apiRoot, out);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    out.push(relative(apiRoot, full).split(sep).join("/"));
  }
}

/** Every production `.ts` file under `apps/api/src` (Owner decision #246: `__tests__/` and
 * `*.test.ts` are out of scope), as paths relative to `apiRoot` WITH the leading `src/`. */
export function discoverProductionFiles(apiRoot: string): string[] {
  const out: string[] = [];
  const srcRoot = join(apiRoot, "src");
  walkProductionTsFiles(srcRoot, apiRoot, out);
  return out.sort();
}

// ── Symbol extraction (D-06's row shape) ────────────────────────────────────────────────────────

/** `propertyName ?? name`, prefixed `"type "` when the element or the whole clause is type-only. */
function bindingLabel(
  element: { propertyName?: ts.Identifier; name: ts.Identifier; isTypeOnly?: boolean },
  clauseIsTypeOnly: boolean,
): string {
  const base = (element.propertyName ?? element.name).text;
  return clauseIsTypeOnly || element.isTypeOnly ? `type ${base}` : base;
}

/**
 * Maps `${line}::${specifier}` (of a "from"-form ImportDeclaration/ExportDeclaration) to the
 * named bindings it pulls, exactly as D-06 specifies: `NamedImports`/`NamedExports` elements via
 * `propertyName ?? name`, prefixed `"type "` for a type-only element or a type-only whole clause.
 * `["*"]` for a bare `export * from` (no `exportClause` at all — D-09 says this SHOULD never
 * happen in a context's own `index.ts`, but a caller's `export * from` elsewhere must not crash
 * this tool). Only forms that are actual import/export declarations are keyed — dynamic imports,
 * `vi.mock()` and `typeof import()` never have named bindings and are handled by the caller.
 */
function buildSymbolsMap(sourceFile: ts.SourceFile): Map<string, string[]> {
  const map = new Map<string, string[]>();

  function lineOf(node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  }

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      // Keyed by the SPECIFIER's own line, not the declaration's start line — a multi-line
      // `import {\n  a,\n  b,\n} from "../x"` has its moduleSpecifier several lines below
      // `node.getStart()`, and extractSpecifiers() (check-import-targets.ts) keys its own
      // occurrences by the specifier's line too. Using the declaration's start line here would
      // silently miss every multi-line import — found live against contexts/scheduling/api/
      // shifts.ts:39, which resolved with an empty `symbols` array before this fix.
      const key = `${lineOf(node.moduleSpecifier)}::${node.moduleSpecifier.text}`;
      const symbols: string[] = [];
      const clause = node.importClause;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          symbols.push(bindingLabel(el, clause.isTypeOnly ?? false));
        }
      }
      map.set(key, symbols);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const key = `${lineOf(node.moduleSpecifier)}::${node.moduleSpecifier.text}`;
      let symbols: string[];
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        symbols = node.exportClause.elements.map((el) =>
          bindingLabel(el, node.isTypeOnly ?? false),
        );
      } else {
        symbols = ["*"]; // bare `export * from "..."` — no named bindings to enumerate
      }
      map.set(key, symbols);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return map;
}

/**
 * Maps `${specifierLine}::${specifier}` (of a "from"-form ImportDeclaration only — this is what
 * `no-restricted-imports` actually reports against) to the ImportDeclaration's own START line.
 * For a single-line `import { a } from "../x"` this equals the specifier's line; for a multi-line
 * `import {\n  a,\n} from "../x"` it does NOT — ESLint's `no-restricted-imports` reports at the
 * declaration's start, several lines ABOVE the specifier text (Plan 05's own `<interfaces>`,
 * verified live against `platform/api/imports.ts`'s E-2a site). Plan 05 (Task 2, AC-5) needs this
 * distinct line to know exactly where an `eslint-disable-next-line` must sit — one line above THIS
 * one, never above the specifier's own line.
 */
function buildImportDeclarationStartLineMap(sourceFile: ts.SourceFile): Map<string, number> {
  const map = new Map<string, number>();

  function lineOf(node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  }

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const key = `${lineOf(node.moduleSpecifier)}::${node.moduleSpecifier.text}`;
      map.set(key, lineOf(node));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return map;
}

// ── The row shape and the scan itself ───────────────────────────────────────────────────────────

export interface BoundaryImport {
  /** Repo-relative to `apps/api`, e.g. "src/contexts/absence/api/leave.ts". */
  file: string;
  line: number;
  /** Raw specifier text, as written. */
  specifier: string;
  form: SpecifierOccurrence["form"];
  fromArea: FileArea;
  target: BoundaryContext;
  /** Path inside the target context, e.g. "timezone.ts", "api/leave.ts". */
  targetModule: string;
  /** Named bindings pulled by this import; `[]` for a dynamic import / vi.mock / typeof-import. */
  symbols: string[];
  /**
   * The line `eslint-disable-next-line no-restricted-imports` must sit ONE ABOVE, to actually
   * suppress this row (Plan 05, AC-5 parity). Equals `line` for a single-line "from" import and
   * for every non-"from" form (dynamic-import/vi.mock/typeof-import have no separate declaration
   * line to speak of); differs from `line` for a multi-line "from" import, where the specifier
   * sits several lines below the ImportDeclaration's own start.
   */
  declarationLine: number;
}

export interface BoundaryScan {
  /** Every DEEP cross-context import in production code — before any exception is applied. */
  deepImports: BoundaryImport[];
  /** For every file that has AT LEAST ONE specifier resolving to a context's own `index.ts`, the
   * set of contexts it already imports that way. Used by `--predict` (D-07's merge-rule delta). */
  indexImportsByFile: Map<string, ReadonlySet<BoundaryContext>>;
}

/**
 * Walks every production file under `apiRoot/src`, extracts every relative specifier (all four
 * forms, via `./check-import-targets.ts`), resolves it, and classifies it. A resolved specifier
 * that lands outside `src/contexts/<x>/**` for a `BOUNDARY_CONTEXTS` member is ignored entirely
 * (it is not a context-boundary crossing at all). One that lands on `<x>/index.ts` is recorded in
 * `indexImportsByFile` and is NOT a deep import. One that lands deeper, for an `<x>` that is not
 * the importing file's OWN area, is a deep import.
 */
export function scanApiRoot(apiRoot: string): BoundaryScan {
  const deepImports: BoundaryImport[] = [];
  const indexImportsByFile = new Map<string, Set<BoundaryContext>>();

  for (const relFile of discoverProductionFiles(apiRoot)) {
    const absFile = join(apiRoot, relFile);
    const fromArea = classifyArea(relFile);
    const text = readFileSync(absFile, "utf8");
    const sourceFile = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, true);
    const symbolsMap = buildSymbolsMap(sourceFile);
    const declarationLineMap = buildImportDeclarationStartLineMap(sourceFile);
    const occurrences = extractSpecifiers(sourceFile, relFile);

    for (const occ of occurrences) {
      const resolved = resolveSpecifier(absFile, occ.specifier);
      if (!resolved) continue; // unresolvable specifiers are `lint:import-targets`'s problem
      const resolvedRel = relative(apiRoot, resolved).split(sep).join("/");
      if (!resolvedRel.startsWith("src/contexts/")) continue;

      const parts = resolvedRel.split("/"); // ["src", "contexts", "<x>", ...]
      const targetSeg = parts[2];
      if (!isBoundaryContext(targetSeg)) continue;

      const targetModule = parts.slice(3).join("/");
      if (targetModule === "index.ts") {
        const set = indexImportsByFile.get(relFile) ?? new Set<BoundaryContext>();
        set.add(targetSeg);
        indexImportsByFile.set(relFile, set);
        continue; // legal — through the public surface
      }

      if (targetSeg === fromArea) continue; // own context, not a crossing

      const key = `${occ.line}::${occ.specifier}`;
      const symbols = occ.form === "from" ? (symbolsMap.get(key) ?? []) : [];
      const declarationLine =
        occ.form === "from" ? (declarationLineMap.get(key) ?? occ.line) : occ.line;
      deepImports.push({
        file: relFile,
        line: occ.line,
        specifier: occ.specifier,
        form: occ.form,
        fromArea,
        target: targetSeg,
        targetModule,
        symbols,
        declarationLine,
      });
    }
  }

  return { deepImports, indexImportsByFile };
}

// ── Disable-comment scan (Plan 05, Task 2 — the parity check's other half) ──────────────────────
//
// `no-restricted-imports` reports at the ImportDeclaration's START line (see `BoundaryImport
// .declarationLine`'s own docblock), so the `eslint-disable-next-line` that suppresses it sits ONE
// LINE ABOVE that — i.e. at `declarationLine - 1`. This scan finds every such comment (matched on
// TEXT, not AST — a disable directive is a comment, not a syntax node ts-morph would see) and
// records the line it SUPPRESSES (`declarationLine`, not the comment's own line), so it can be
// compared directly against `BoundaryImport.declarationLine` without an off-by-one at every call
// site. The trailing `-- E-N:` id is captured too (D-04's shape); a disable comment written WITHOUT
// one still counts as "found" (empty-string id), so it fails parity as a genuine mismatch rather
// than silently vanishing from the scan.

/** file -> (line the comment SUPPRESSES -> the `E-N` id found in its `-- E-N:` trailer, or `""`
 * if the comment has no such trailer at all). */
export type DisableCommentMap = Map<string, Map<number, string>>;

// The `//.*?` prefix (rather than `//\s*`) is deliberate: it also matches a test fixture's
// `// FIXTURE-MARKER eslint-disable-next-line …` comments (scripts/__tests__/fixtures/
// boundary-imports/…/disable-parity.ts), which prefix the real directive keyword on purpose so
// real ESLint does NOT recognize them as an actual directive and therefore never strips them as
// "unused" via `eslint --fix` — this fixture path sits outside the boundary rule's own `files`
// glob (apps/api/src/**), so an UNPREFIXED disable-next-line comment there would always be
// "unused" and get silently deleted by lint-staged's autofix (found live: the first version of
// this fixture lost both its comments AND its multi-line import layout to exactly that autofix).
// A real production comment (always unprefixed, immediately after `//`) matches either way.
const DISABLE_COMMENT_PATTERN =
  /\/\/.*?\beslint-disable-next-line\s+no-restricted-imports\b(?:.*?--\s*(E-[A-Za-z0-9]+):)?/;

/**
 * Scans every production file (same `discoverProductionFiles` scope as `scanApiRoot` — `__tests__`
 * and `*.test.ts` excluded, Owner decision #246) for `eslint-disable-next-line
 * no-restricted-imports` comments, keyed by the line each one SUPPRESSES (its own line + 1).
 */
export function scanDisableComments(apiRoot: string): DisableCommentMap {
  const result: DisableCommentMap = new Map();
  for (const relFile of discoverProductionFiles(apiRoot)) {
    const absFile = join(apiRoot, relFile);
    const lines = readFileSync(absFile, "utf8").split("\n");
    let byLine: Map<number, string> | undefined;
    lines.forEach((lineText, idx) => {
      const match = DISABLE_COMMENT_PATTERN.exec(lineText);
      if (!match) return;
      if (!byLine) {
        byLine = new Map();
        result.set(relFile, byLine);
      }
      const suppressedLine = idx + 2; // idx is 0-based (comment's own 1-based line = idx+1)
      byLine.set(suppressedLine, match[1] ?? "");
    });
  }
  return result;
}

// ── Exceptions file (D-04: two kinds), validated like foreign-context-access-exceptions.json ────

export const EXCEPTIONS_FILE = "apps/api/scripts/context-boundary-import-exceptions.json";

export const MIN_REASON_LENGTH = 30;

export interface WholeFileException {
  id: string;
  file: string;
  wholeFile: true;
  expectedCount: number;
  reason: string;
  disappearsIn: string;
}

export interface PerSiteException {
  id: string;
  file: string;
  specifier: string;
  /** The symbols this site pulls — documentation only, not mechanically checked against the
   * matched deep import's own `symbols` (a name can be renamed at the import site without
   * changing what makes the exception necessary). */
  symbols?: string[];
  reason: string;
  disappearsIn: string;
  /** Where this exception is transcribed for a human reader, e.g. "docs/adr/0001-abweichungen.md
   * Eintrag H" — documentation only, not mechanically checked. */
  register?: string;
}

export type BoundaryException = WholeFileException | PerSiteException;

export interface ExceptionsDocument {
  registerSource: string;
  exceptions: BoundaryException[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const WHOLE_FILE_KEYS = new Set([
  "id",
  "file",
  "wholeFile",
  "expectedCount",
  "reason",
  "disappearsIn",
]);
const PER_SITE_KEYS = new Set([
  "id",
  "file",
  "specifier",
  "symbols",
  "reason",
  "disappearsIn",
  "register",
]);

/**
 * Validates a raw (untyped) exceptions document against the CURRENT deep-import set — structural
 * shape, mandatory `reason` (>= `MIN_REASON_LENGTH` characters), no unknown keys, and staleness:
 * a `wholeFile` entry's `expectedCount` is checked against the ACTUAL count of deep imports in
 * that file BY EQUALITY (a 46th deep import in `app.ts` is a finding, not a silently absorbed
 * one — this equality check IS the staleness check for this kind); a per-site entry is stale if
 * no current deep import matches its `file` + `specifier` exactly (the call may have moved or
 * been fixed).
 *
 * `disableComments` (Plan 05, Task 2, AC-5) is OPTIONAL and extends the checks above with the
 * bidirectional register-parity lock, when supplied:
 *   (A) every per-site entry must have a matching `eslint-disable-next-line no-restricted-imports
 *       -- <id>:` comment at its matched deep import's `declarationLine - 1`, carrying THAT SAME
 *       id — an entry with no comment, or a comment with a different id, is a finding;
 *   (B) every such comment found anywhere under `apps/api/src/**` (`__tests__`/`*.test.ts`
 *       excluded, Owner decision #246) must be claimed by exactly one per-site entry from (A) —
 *       an unclaimed comment is an UNDOCUMENTED exception, the exact rot AC-5 exists to catch;
 *   (C) a `wholeFile` entry's own file must carry NO such comment at all — that exception lives in
 *       the flat config (`eslint.boundaries.mjs`), never inline.
 * Omitted (as most of this file's own pre-existing tests still call it), only the ORIGINAL shape
 * and staleness checks run — this keeps every caller that predates Plan 05 unchanged, per the
 * plan's own "extend, do not fork" instruction.
 */
export function validateExceptionsDocument(
  raw: unknown,
  deepImports: readonly BoundaryImport[],
  disableComments?: DisableCommentMap,
): { ok: true; doc: ExceptionsDocument } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: [`${EXCEPTIONS_FILE} must contain a JSON object`] };
  }
  const { registerSource, exceptions } = raw;
  if (typeof registerSource !== "string" || registerSource.trim().length === 0) {
    errors.push(`'registerSource' must be a non-empty string`);
  }
  if (!Array.isArray(exceptions)) {
    errors.push(`'exceptions' must be an array`);
    return { ok: false, errors };
  }

  const countByFile = new Map<string, number>();
  for (const d of deepImports) {
    countByFile.set(d.file, (countByFile.get(d.file) ?? 0) + 1);
  }
  const deepByFileAndSpecifier = new Set<string>();
  const deepRowByFileAndSpecifier = new Map<string, BoundaryImport>();
  for (const d of deepImports) {
    deepByFileAndSpecifier.add(`${d.file}::${d.specifier}`);
    deepRowByFileAndSpecifier.set(`${d.file}::${d.specifier}`, d);
  }

  /** `${file}::${declarationLine}` pairs claimed by a valid per-site entry — direction (B)'s job is
   * to flag every disable comment NOT in this set once every entry has been processed. */
  const claimedDisableLines = new Set<string>();

  const validEntries: BoundaryException[] = [];

  (exceptions as unknown[]).forEach((entry, index) => {
    const label = isRecord(entry) && typeof entry.id === "string" ? entry.id : `entry #${index}`;

    if (!isRecord(entry)) {
      errors.push(`${label}: entry is not an object`);
      return;
    }
    const { id, file, reason, disappearsIn } = entry;
    if (typeof id !== "string" || id.length === 0) {
      errors.push(`${label}: missing or invalid 'id'`);
      return;
    }
    if (typeof file !== "string" || file.length === 0) {
      errors.push(`${label}: missing or invalid 'file'`);
      return;
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      errors.push(`${label}: missing 'reason' — every exception MUST name WHY it exists`);
      return;
    }
    if (reason.trim().length < MIN_REASON_LENGTH) {
      errors.push(
        `${label}: 'reason' is only ${reason.trim().length} character(s) — must read as a ` +
          `sentence, not a label (minimum ${MIN_REASON_LENGTH})`,
      );
      return;
    }
    if (typeof disappearsIn !== "string" || disappearsIn.trim().length === 0) {
      errors.push(`${label}: missing 'disappearsIn' — every exception MUST name its exit point`);
      return;
    }

    const isWholeFile = entry.wholeFile === true;
    if (isWholeFile) {
      const unknownKeys = Object.keys(entry).filter((k) => !WHOLE_FILE_KEYS.has(k));
      if (unknownKeys.length > 0) {
        errors.push(`${label}: unknown key(s) on a wholeFile entry: ${unknownKeys.join(", ")}`);
        return;
      }
      const { expectedCount } = entry;
      if (
        typeof expectedCount !== "number" ||
        !Number.isInteger(expectedCount) ||
        expectedCount < 0
      ) {
        errors.push(`${label}: 'expectedCount' must be a non-negative integer`);
        return;
      }
      const actual = countByFile.get(file) ?? 0;
      if (actual !== expectedCount) {
        errors.push(
          `${label}: STALE — ${file} has ${actual} deep import(s) today, expectedCount says ` +
            `${expectedCount}. A count that moved without this file being updated is a finding, ` +
            `not something to silently re-baseline.`,
        );
        return;
      }
      if (disableComments) {
        const byLine = disableComments.get(file);
        if (byLine && byLine.size > 0) {
          errors.push(
            `${label}: a wholeFile entry's exception lives in the flat config ` +
              `(eslint.boundaries.mjs), never inline — but ${file} carries ${byLine.size} ` +
              `eslint-disable-next-line no-restricted-imports comment(s) at line(s) ` +
              `${[...byLine.keys()].sort((a, b) => a - b).join(", ")}`,
          );
          return;
        }
      }
      validEntries.push({
        id,
        file,
        wholeFile: true,
        expectedCount,
        reason: reason.trim(),
        disappearsIn: disappearsIn.trim(),
      });
      return;
    }

    if (typeof entry.specifier !== "string" || entry.specifier.length === 0) {
      errors.push(`${label}: entry must have either 'wholeFile: true' or a 'specifier' string`);
      return;
    }
    const unknownKeys = Object.keys(entry).filter((k) => !PER_SITE_KEYS.has(k));
    if (unknownKeys.length > 0) {
      errors.push(`${label}: unknown key(s) on a per-site entry: ${unknownKeys.join(", ")}`);
      return;
    }
    if (
      entry.symbols !== undefined &&
      (!Array.isArray(entry.symbols) ||
        entry.symbols.some((s) => typeof s !== "string" || s.length === 0))
    ) {
      errors.push(`${label}: 'symbols', if present, must be an array of non-empty strings`);
      return;
    }
    if (
      entry.register !== undefined &&
      (typeof entry.register !== "string" || entry.register.trim().length === 0)
    ) {
      errors.push(`${label}: 'register', if present, must be a non-empty string`);
      return;
    }
    const specifier = entry.specifier;
    const matchedRow = deepRowByFileAndSpecifier.get(`${file}::${specifier}`);
    if (!matchedRow) {
      errors.push(
        `${label}: STALE — no current deep import in ${file} matches specifier "${specifier}"; ` +
          `it may have moved or been fixed — update or remove it`,
      );
      return;
    }
    if (disableComments) {
      const declarationLine = matchedRow.declarationLine;
      const foundId = disableComments.get(file)?.get(declarationLine);
      if (foundId === undefined) {
        errors.push(
          `${label}: registered exception ${id} has no eslint-disable at ${file}:${declarationLine} ` +
            `— every register entry must be backed by an inline ` +
            `'eslint-disable-next-line no-restricted-imports -- ${id}: …' comment`,
        );
        return;
      }
      if (foundId !== id) {
        errors.push(
          `${label}: the eslint-disable-next-line at ${file}:${declarationLine} carries id ` +
            `"${foundId || "(none)"}", but the registered entry's id is "${id}" — the disable ` +
            `comment's E-N id must equal the entry's id`,
        );
        return;
      }
      claimedDisableLines.add(`${file}::${declarationLine}`);
    }
    validEntries.push({
      id,
      file,
      specifier,
      ...(entry.symbols !== undefined ? { symbols: entry.symbols as string[] } : {}),
      reason: reason.trim(),
      disappearsIn: disappearsIn.trim(),
      ...(entry.register !== undefined ? { register: (entry.register as string).trim() } : {}),
    });
  });

  if (disableComments) {
    for (const [file, byLine] of disableComments) {
      for (const [line, foundId] of byLine) {
        if (!claimedDisableLines.has(`${file}::${line}`)) {
          errors.push(
            `undocumented exception at ${file}:${line} — an eslint-disable-next-line ` +
              `no-restricted-imports comment (id "${foundId || "(none)"}") with no matching entry ` +
              `in ${EXCEPTIONS_FILE}`,
          );
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    doc: { registerSource: (registerSource as string).trim(), exceptions: validEntries },
  };
}

export function loadExceptionsRaw(repoRoot: string): unknown {
  const abs = join(repoRoot, EXCEPTIONS_FILE);
  return JSON.parse(readFileSync(abs, "utf8"));
}

/** Is `row` covered by any exception in `doc`? A `wholeFile` exception covers EVERY row in that
 * file, regardless of specifier; a per-site exception covers only its exact file + specifier. */
export function isExcepted(row: BoundaryImport, doc: ExceptionsDocument): boolean {
  return doc.exceptions.some(
    (e) => e.file === row.file && ("wholeFile" in e ? e.wholeFile : e.specifier === row.specifier),
  );
}

export interface WorkloadResult {
  workload: BoundaryImport[];
  excepted: BoundaryImport[];
}

export function computeWorkload(
  deepImports: readonly BoundaryImport[],
  doc: ExceptionsDocument,
): WorkloadResult {
  const excepted = deepImports.filter((d) => isExcepted(d, doc));
  const workload = deepImports.filter((d) => !isExcepted(d, doc));
  return { workload, excepted };
}

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────

export function summaryLine(deepTotal: number, result: WorkloadResult): string {
  return (
    `[measure:boundary-imports] ${deepTotal} deep import(s) total, workload ${result.workload.length} ` +
    `(${result.excepted.length} excepted).`
  );
}

export function renderRows(result: WorkloadResult): string {
  return result.workload
    .slice()
    .sort(
      (a, b) => a.target.localeCompare(b.target) || a.file.localeCompare(b.file) || a.line - b.line,
    )
    .map(
      (r) =>
        `${r.file}:${r.line} | ${r.form} | ${r.fromArea} -> ${r.target}/${r.targetModule} | ` +
        `{${r.symbols.join(", ")}}`,
    )
    .join("\n");
}

export function renderByTarget(result: WorkloadResult): string {
  const counts = new Map<BoundaryContext, { total: number; files: Set<string> }>();
  for (const r of result.workload) {
    const c = counts.get(r.target) ?? { total: 0, files: new Set<string>() };
    c.total++;
    c.files.add(r.file);
    counts.set(r.target, c);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .map(([target, c]) => `${target} ${c.total} (${c.files.size} file(s))`)
    .join("\n");
}

export function renderForms(result: WorkloadResult): string {
  const counts = new Map<string, number>();
  for (const r of result.workload) counts.set(r.form, (counts.get(r.form) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([form, n]) => `${form} ${n}`)
    .join("\n");
}

export interface PredictResult {
  deep: number;
  files: number;
  filesAlreadyImportingIndex: number;
  predictedImportTargetsDelta: number;
}

/**
 * D-07's per-wave predicted `lint:import-targets` delta. `n` = workload deep imports into
 * `context`; `m` = distinct importer files among those; `k` = how many of those `m` files ALREADY
 * import `context`'s index (any symbol) today. Under the wave's merge rule (one import statement
 * per (file, target), merged into an existing index import when present), each of the `k` files'
 * deep specifiers disappear into an already-counted statement (net `-n_i` each); each of the
 * `m - k` files' deep specifiers collapse into exactly ONE new statement (net `-(n_j - 1)` each).
 * Summed: `-(n - (m - k))`.
 */
export function predict(
  scan: BoundaryScan,
  workload: readonly BoundaryImport[],
  context: BoundaryContext,
): PredictResult {
  const rows = workload.filter((r) => r.target === context);
  const files = new Set(rows.map((r) => r.file));
  const filesAlreadyImportingIndex = [...files].filter((f) =>
    scan.indexImportsByFile.get(f)?.has(context),
  ).length;
  const deep = rows.length;
  const m = files.size;
  const k = filesAlreadyImportingIndex;
  return {
    deep,
    files: m,
    filesAlreadyImportingIndex: k,
    predictedImportTargetsDelta: -(deep - (m - k)),
  };
}

// ── Cycle detection (Plan 03, D-08) ─────────────────────────────────────────────────────────────

/**
 * `src/contexts/<ctx>/index.ts`, repo-relative-to-`apps/api` — the graph-node convention every
 * function below shares with `BoundaryImport.file`/`.target`.
 */
function contextIndexPath(ctx: BoundaryContext): string {
  return `src/contexts/${ctx}/index.ts`;
}

/**
 * The REAL production import graph today: every production `.ts` file under `apiRoot/src`
 * (`__tests__`/`*.test.ts` excluded, same scope as `scanApiRoot`) as a node, with an edge to every
 * OTHER file it resolves a relative specifier to — any of the four forms, via the same
 * `extractSpecifiers`/`resolveSpecifier` primitives `scanApiRoot` uses, but UNFILTERED by context:
 * this graph includes same-context edges and already-legal index-import edges too, because a
 * cycle can be completed by either kind (a foreign index re-exporting a file that itself imports
 * something — legally — back into the first context). `apps/api/scripts/**` is out of scope
 * (D-06's own scope) — only `apiRoot/src` is walked.
 */
export function buildModuleGraph(apiRoot: string): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const relFile of discoverProductionFiles(apiRoot)) {
    const absFile = join(apiRoot, relFile);
    const text = readFileSync(absFile, "utf8");
    const sourceFile = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, true);
    const edges = graph.get(relFile) ?? new Set<string>();
    for (const occ of extractSpecifiers(sourceFile, relFile)) {
      const resolved = resolveSpecifier(absFile, occ.specifier);
      if (!resolved) continue; // unresolvable specifiers are lint:import-targets's problem
      const resolvedRel = relative(apiRoot, resolved).split(sep).join("/");
      if (!resolvedRel.startsWith("src/")) continue; // outside production src — not a graph node
      if (resolvedRel === relFile) continue; // no self-loop from resolving to one's own file
      edges.add(resolvedRel);
    }
    graph.set(relFile, edges);
  }
  return graph;
}

/**
 * One simulated code move: `from` (a real file) stops being an `index.ts`'s re-export source for
 * the named `symbols` (or ALL of `from`'s deep-imported symbols, if `symbols` is omitted); `leaf`
 * (a synthetic path — need not exist on disk) takes its place. `leaf`'s OWN context — the path
 * segment right after `src/contexts/` — is that leaf's placement, which may differ from `from`'s
 * owning context (this is how the overtime leaf's placement, time-tracking vs
 * working-time-account, is expressed: same `from`, same `symbols`, different `leaf` path).
 * `crossContextTargets` are the FOREIGN contexts the extracted body still reaches — turned into
 * `leaf -> <ctx>/index.ts` edges, never edges to a deep file (new code follows AC-2 too).
 */
export interface ExtractionSpec {
  from: string;
  leaf: string;
  crossContextTargets: readonly BoundaryContext[];
  /** Restrict this spec to a subset of `from`'s deep-imported symbols. Omit to claim all of them.
   * Needed because a single import statement can pull a symbol destined for ONE leaf and a symbol
   * destined for ANOTHER (`working-time-account/api/overtime.ts` imports both a schedule symbol
   * and an overtime symbol from the same `time-entries.ts` line under Option D). */
  symbols?: readonly string[];
}

export interface ProjectOptions {
  extract?: readonly ExtractionSpec[];
  /** Pre-validated exceptions document to honour. Defaults to loading + validating the real
   * `context-boundary-import-exceptions.json` (CLI use) — a fixture-tree caller supplies a
   * synthetic document instead, since a fixture tree has no matching exceptions file on disk. */
  exceptionsDoc?: ExceptionsDocument;
}

/**
 * The graph as it will look after `contexts` are CONVERTED. For every workload deep-import row
 * whose TARGET is one of `contexts`: the importer's edge to the deep file is replaced by an edge
 * to the target context's `index.ts`, and `index.ts` gets a re-export edge to the deep file — UNLESS
 * the row is EXCEPTED (per `exceptionsDoc`), in which case it is skipped entirely: the importer's
 * original edge is left untouched and NO re-export edge is created. Getting this wrong — routing
 * an excepted deep import through the index anyway — is the exact mistake the first hand-simulation
 * made: it forced `app.ts`'s 45 exempt deep imports into the re-export set and reported 49 modules
 * in cycles where the correct figure is 29 (see the module docblock).
 *
 * `opts.extract` additionally replaces a named "from" file's re-export edge with one or more leaf
 * edges (Option D) — see `ExtractionSpec`'s own docblock.
 */
export function buildProjectedGraph(
  apiRoot: string,
  contexts: readonly BoundaryContext[],
  opts: ProjectOptions = {},
): Map<string, Set<string>> {
  const graph = buildModuleGraph(apiRoot);
  const scan = scanApiRoot(apiRoot);

  let doc = opts.exceptionsDoc;
  if (!doc) {
    const repoRoot = join(apiRoot, "..", "..");
    const validated = validateExceptionsDocument(
      loadExceptionsRaw(repoRoot),
      scan.deepImports,
      scanDisableComments(apiRoot),
    );
    if (!validated.ok) {
      throw new Error(
        `buildProjectedGraph: ${EXCEPTIONS_FILE} is invalid: ${validated.errors.join("; ")}`,
      );
    }
    doc = validated.doc;
  }

  const contextSet = new Set(contexts);

  const specsByFrom = new Map<string, ExtractionSpec[]>();
  for (const spec of opts.extract ?? []) {
    const list = specsByFrom.get(spec.from) ?? [];
    list.push(spec);
    specsByFrom.set(spec.from, list);
  }

  function addEdge(from: string, to: string): void {
    const set = graph.get(from) ?? new Set<string>();
    set.add(to);
    graph.set(from, set);
  }

  for (const row of scan.deepImports) {
    if (!contextSet.has(row.target)) continue;
    if (isExcepted(row, doc)) continue; // stays deep — the regression test's whole point

    const targetFile = `src/contexts/${row.target}/${row.targetModule}`;
    graph.get(row.file)?.delete(targetFile);

    const specs = specsByFrom.get(targetFile);
    if (!specs || specs.length === 0) {
      const targetIndex = contextIndexPath(row.target);
      addEdge(row.file, targetIndex);
      addEdge(targetIndex, targetFile);
      continue;
    }

    // Split the row's symbols across whichever spec(s) claim them. A spec's LEAF may live in a
    // DIFFERENT context than `row.target` (Option D's placement move) — the IMPORTER routes
    // straight to the LEAF's OWN context index, never to the symbol's original owning context,
    // because that is what a real caller does once the function has physically moved (see the
    // module docblock's `platform/api/imports.ts` example). Anything left unclaimed falls back
    // to a direct re-export of the original file, so an uncovered symbol stays VISIBLE in the
    // graph rather than silently vanishing.
    const claimed = new Set<string>();
    let coveredEverything = false; // a claims-everything spec matched — no fallback, ever,
    // regardless of row.symbols content (a dynamic import / vi.mock / typeof-import row always
    // has symbols === [], which must NOT be mistaken for "nothing claimed" when the whole FILE
    // moved into the leaf)
    for (const spec of specs) {
      const claimsEverything = !spec.symbols;
      const matches = claimsEverything || row.symbols.some((s) => spec.symbols!.includes(s));
      if (!matches) continue;
      if (claimsEverything) coveredEverything = true;
      for (const s of spec.symbols ?? row.symbols) claimed.add(s);
      const leafContext = spec.leaf.split("/")[2] as BoundaryContext;
      const leafIndex = contextIndexPath(leafContext);
      addEdge(row.file, leafIndex);
      addEdge(leafIndex, spec.leaf);
      for (const foreign of spec.crossContextTargets) addEdge(spec.leaf, contextIndexPath(foreign));
    }
    const uncovered = row.symbols.filter((s) => !claimed.has(s));
    if (!coveredEverything && (uncovered.length > 0 || row.symbols.length === 0)) {
      const targetIndex = contextIndexPath(row.target);
      addEdge(row.file, targetIndex);
      addEdge(targetIndex, targetFile);
    }
  }

  return graph;
}

/** Tarjan's algorithm. Returns only components of size > 1 (an acyclic graph returns `[]`),
 * largest first, each component's own members sorted for stable output. */
export function findImportCycles(graph: Map<string, Set<string>>): string[][] {
  let counter = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  function strongConnect(v: string): void {
    indices.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of graph.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) components.push(component.sort());
    }
  }

  for (const node of graph.keys()) {
    if (!indices.has(node)) strongConnect(node);
  }

  return components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

/** Modules in components of size > 1 — `findImportCycles` already filters to those, so this is
 * their combined size. A separate function per D-08's own CLI shape (`--cycles` prints it). */
export function cycleModuleCount(components: readonly string[][]): number {
  return components.filter((c) => c.length > 1).reduce((sum, c) => sum + c.length, 0);
}

/** Breadth-first shortest path from `from` to `to` (inclusive of both ends), or `null` if `to` is
 * unreachable. Used by `--paths` to name the module CARRYING a residual cross-context edge. */
export function shortestPath(
  graph: Map<string, Set<string>>,
  from: string,
  to: string,
): string[] | null {
  if (from === to) return [from];
  const visited = new Set<string>([from]);
  const parent = new Map<string, string>();
  const queue: string[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of graph.get(cur) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      parent.set(next, cur);
      if (next === to) {
        const path: string[] = [to];
        let p = cur;
        while (p !== from) {
          path.unshift(p);
          p = parent.get(p)!;
        }
        path.unshift(from);
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

export function renderCycleComponents(components: readonly string[][]): string {
  return components
    .map((c, i) => {
      const indexFiles = c.filter((f) => f.endsWith("/index.ts"));
      const lines = [`  component ${i + 1} (${c.length} module(s)):`, ...c.map((f) => `    ${f}`)];
      lines.push(
        `    index.ts files inside: ${indexFiles.length > 0 ? indexFiles.join(", ") : "(none)"}`,
      );
      return lines.join("\n");
    })
    .join("\n");
}

/** For every ordered pair of `contexts`, the shortest `index -> ... -> index` path — one line per
 * still-mutually-reachable pair. This is `--paths`'s whole point: naming which module carries a
 * residual edge, not merely that one exists. */
export function renderReachablePaths(
  graph: Map<string, Set<string>>,
  contexts: readonly BoundaryContext[],
): string {
  const lines: string[] = [];
  for (const a of contexts) {
    for (const b of contexts) {
      if (a === b) continue;
      const path = shortestPath(graph, contextIndexPath(a), contextIndexPath(b));
      if (path) lines.push(`${a} -> ${b}: ${path.join(" -> ")}`);
    }
  }
  return lines.join("\n");
}

// ── Named extraction scenarios (Option D) — literal table, reproducible by `--extract-sim` ─────
//
// The two route files' full cross-context closure, verified against the source (101B-WORKLIST.md
// §4, cross-checked against apps/api/src/contexts/absence/api/leave.ts and
// apps/api/src/contexts/time-tracking/api/time-entries.ts directly). `time-tracking/api/
// time-entries.ts` is split into TWO leaves, not one — this is the owner's own explicit design
// (GitHub Issue #101, "Nachtrag zur Zyklenmessung", "Zwei Funde" #2: "`validateTimeEntryInvariants`
// braucht nur das Arbeitszeitkonto; `computeOvertimeBalanceBreakdown` erreicht vier fremde
// Kontexte. Ein gemeinsames Modul zöge die ganze Überstunden-Hülle in jeden Konsumenten der reinen
// Invariantenprüfung." — a single combined leaf would drag the whole overtime shell into every
// caller of the pure invariant check). A one-leaf simplification was tried first here and
// discarded: it reproduces the pinned 26/20 exactly, but only by NOT modelling this owner-mandated
// split — see 101B-ZYKLEN-BEFUND.md §2a for the full finding this produced (27/21, not 26/20).
//   absence/api/leave.ts:      resolveLeaveDays, getHolidayMap, deductVacationDays,
//                              reverseVacationDays  (need: platform, scheduling)
//   time-tracking/api/time-entries.ts, LEAF 1 (schedule helpers, never moves):
//                              getEffectiveSchedule (need: none), validateTimeEntryInvariants
//                              (need: working-time-account)
//   time-tracking/api/time-entries.ts, LEAF 2 (the overtime leaf, placement C vs D):
//                              updateOvertimeAccount (need: working-time-account),
//                              computeOvertimeBalanceBreakdown (need: absence, platform,
//                              scheduling, working-time-account, and time-tracking's own
//                              break-effective.ts if the leaf moves OUT of time-tracking)

const ABSENCE_LEAVE_DAYS_LEAF: ExtractionSpec = {
  from: "src/contexts/absence/api/leave.ts",
  leaf: "src/contexts/absence/leave-days.ts",
  symbols: ["resolveLeaveDays", "getHolidayMap", "deductVacationDays", "reverseVacationDays"],
  crossContextTargets: ["platform", "scheduling"],
};

/** LEAF 1: the schedule-helpers leaf. Never moves — the owner's "Zwei Funde" #2 only discusses
 * moving THE OVERTIME PAIR; this leaf stays in time-tracking under every scenario. */
const TIME_TRACKING_SCHEDULE_LEAF: ExtractionSpec = {
  from: "src/contexts/time-tracking/api/time-entries.ts",
  leaf: "src/contexts/time-tracking/schedule-helpers.ts",
  symbols: ["getEffectiveSchedule", "validateTimeEntryInvariants"],
  crossContextTargets: ["working-time-account"],
};

/** LEAF 2, placement C (§4): the overtime leaf stays in time-tracking. `type
 * OvertimeBalanceBreakdown` travels with `computeOvertimeBalanceBreakdown` (its return type,
 * re-exported alongside it at every one of its three call sites, 101B-WORKLIST.md §3
 * "time-tracking" rows); leaving it uncovered would fall back to a direct re-export of
 * `api/time-entries.ts`, silently un-doing the extraction it is supposed to simulate. */
const OVERTIME_LEAF_TT: ExtractionSpec = {
  from: "src/contexts/time-tracking/api/time-entries.ts",
  leaf: "src/contexts/time-tracking/overtime-leaf.ts",
  symbols: [
    "updateOvertimeAccount",
    "computeOvertimeBalanceBreakdown",
    "type OvertimeBalanceBreakdown",
  ],
  crossContextTargets: ["absence", "platform", "scheduling", "working-time-account"],
};

/** LEAF 2, placement D (recommended, §4): the overtime leaf moves to working-time-account —
 * time-tracking becomes a FOREIGN target now (`break-effective.ts`), working-time-account is the
 * leaf's own context (removed from its own cross-context-target list). */
const OVERTIME_LEAF_WTA: ExtractionSpec = {
  from: "src/contexts/time-tracking/api/time-entries.ts",
  leaf: "src/contexts/working-time-account/overtime-leaf.ts",
  symbols: [
    "updateOvertimeAccount",
    "computeOvertimeBalanceBreakdown",
    "type OvertimeBalanceBreakdown",
  ],
  crossContextTargets: ["absence", "platform", "scheduling", "time-tracking"],
};

/** The "+anon" leaf (variants E/F): NOT_ANONYMIZED_EMPLOYEE_WHERE is a bare constant — moving it
 * into its own leaf gives it ZERO outgoing edges, instead of dragging in anonymize.ts's own real
 * (and entirely legal) imports of `../time-tracking` and `../absence` — those two edges are
 * exactly what pulls `platform` into the cyclic component under variants C/D. */
const PLATFORM_ANONYMIZE_LEAF: ExtractionSpec = {
  from: "src/contexts/platform/anonymize.ts",
  leaf: "src/contexts/platform/anonymize-leaf.ts",
  symbols: ["NOT_ANONYMIZED_EMPLOYEE_WHERE"],
  crossContextTargets: [],
};

export const EXTRACT_SCENARIOS: Record<string, readonly ExtractionSpec[]> = {
  none: [],
  "option-d-tt": [ABSENCE_LEAVE_DAYS_LEAF, TIME_TRACKING_SCHEDULE_LEAF, OVERTIME_LEAF_TT],
  "option-d-wta": [ABSENCE_LEAVE_DAYS_LEAF, TIME_TRACKING_SCHEDULE_LEAF, OVERTIME_LEAF_WTA],
  "option-d-tt+anon": [
    ABSENCE_LEAVE_DAYS_LEAF,
    TIME_TRACKING_SCHEDULE_LEAF,
    OVERTIME_LEAF_TT,
    PLATFORM_ANONYMIZE_LEAF,
  ],
  "option-d-wta+anon": [
    ABSENCE_LEAVE_DAYS_LEAF,
    TIME_TRACKING_SCHEDULE_LEAF,
    OVERTIME_LEAF_WTA,
    PLATFORM_ANONYMIZE_LEAF,
  ],
};

// ── Part B: CLI entry point ──────────────────────────────────────────────────────────────────────

function run(repoRoot: string, argv: string[]): number {
  const apiRoot = join(repoRoot, "apps/api");
  const scan = scanApiRoot(apiRoot);

  const raw = loadExceptionsRaw(repoRoot);
  const validated = validateExceptionsDocument(raw, scan.deepImports, scanDisableComments(apiRoot));
  if (!validated.ok) {
    console.error(`measure-context-boundary-imports: ${EXCEPTIONS_FILE} is invalid:`);
    for (const e of validated.errors) console.error(`  - ${e}`);
    return 1;
  }
  const result = computeWorkload(scan.deepImports, validated.doc);

  if (argv.includes("--rows")) {
    console.log(renderRows(result));
    return 0;
  }
  if (argv.includes("--by-target")) {
    console.log(renderByTarget(result));
    return 0;
  }
  if (argv.includes("--forms")) {
    console.log(renderForms(result));
    return 0;
  }

  if (argv.includes("--cycles")) {
    let contextsForPaths: BoundaryContext[] = [...BOUNDARY_CONTEXTS];
    let graph: Map<string, Set<string>>;

    const projectIdx = argv.indexOf("--project");
    if (projectIdx !== -1) {
      const spec = argv[projectIdx + 1] ?? "";
      const requested = spec === "all" ? [...BOUNDARY_CONTEXTS] : spec.split(",").filter(Boolean);
      for (const c of requested) {
        if (!isBoundaryContext(c)) {
          console.error(`measure-context-boundary-imports: unknown --project context "${c}"`);
          return 1;
        }
      }
      contextsForPaths = requested as BoundaryContext[];

      const extractIdx = argv.indexOf("--extract-sim");
      const scenarioName = extractIdx !== -1 ? (argv[extractIdx + 1] ?? "") : "none";
      const extract = EXTRACT_SCENARIOS[scenarioName];
      if (!extract) {
        console.error(
          `measure-context-boundary-imports: unknown --extract-sim scenario "${scenarioName}" ` +
            `(known: ${Object.keys(EXTRACT_SCENARIOS).join(", ")})`,
        );
        return 1;
      }
      graph = buildProjectedGraph(apiRoot, contextsForPaths, { extract });
    } else {
      graph = buildModuleGraph(apiRoot);
    }

    const components = findImportCycles(graph);
    const moduleCount = cycleModuleCount(components);
    console.log(
      `[measure:boundary-imports] cycles: ${components.length} component(s), ${moduleCount} ` +
        `module(s) in cycles`,
    );
    if (components.length > 0) console.log(renderCycleComponents(components));

    if (argv.includes("--paths")) {
      const pathsOutput = renderReachablePaths(graph, contextsForPaths);
      console.log(pathsOutput.length > 0 ? pathsOutput : "(no ordered pair still reachable)");
    }

    const cyclesCheckIdx = argv.indexOf("--check");
    if (cyclesCheckIdx !== -1) {
      const expected = Number(argv[cyclesCheckIdx + 1]);
      if (!Number.isInteger(expected)) {
        console.error(`measure-context-boundary-imports: --check requires an integer argument`);
        return 1;
      }
      if (moduleCount === expected) return 0;
      console.error(
        `measure-context-boundary-imports: --cycles --check ${expected} FAILED — actual is ` +
          `${moduleCount} module(s) in cycles (${moduleCount > expected ? "+" : ""}` +
          `${moduleCount - expected}).`,
      );
      return 1;
    }
    return 0;
  }

  const predictIdx = argv.indexOf("--predict");
  if (predictIdx !== -1) {
    const context = argv[predictIdx + 1];
    if (!context || !isBoundaryContext(context)) {
      console.error(
        `measure-context-boundary-imports: --predict requires one of: ${BOUNDARY_CONTEXTS.join(", ")}`,
      );
      return 1;
    }
    const p = predict(scan, result.workload, context);
    console.log(
      `deep=${p.deep} files=${p.files} files-already-importing-index=${p.filesAlreadyImportingIndex} ` +
        `predicted-import-targets-delta=${p.predictedImportTargetsDelta}`,
    );
    return 0;
  }

  const checkIdx = argv.indexOf("--check");
  if (checkIdx !== -1) {
    const expected = Number(argv[checkIdx + 1]);
    if (!Number.isInteger(expected)) {
      console.error(`measure-context-boundary-imports: --check requires an integer argument`);
      return 1;
    }
    console.log(summaryLine(scan.deepImports.length, result));
    if (result.workload.length === expected) return 0;
    const delta = result.workload.length - expected;
    console.error(
      `measure-context-boundary-imports: --check ${expected} FAILED — actual workload is ` +
        `${result.workload.length} (${delta > 0 ? "+" : ""}${delta}). Files in the current ` +
        `workload:\n` +
        [...new Set(result.workload.map((r) => r.file))].sort().join("\n"),
    );
    return 1;
  }

  console.log(summaryLine(scan.deepImports.length, result));
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
  process.exit(run(repoRoot, process.argv.slice(2)));
}
