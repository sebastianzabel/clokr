/**
 * Phase 235 Plan 01 (AC-1/AC-2/AC-6, D-02/D-03) — the AST classifier every later wave of this
 * phase is measured against. GitHub issue #235 ("Lehre aus Phase 99b…"), issue #240 (the third
 * recurrence), issue #245 (the fourth).
 *
 * ── WHAT THIS CLASSIFIES ────────────────────────────────────────────────────────────────────────
 * For ONE source file, three questions D-02 makes mechanical:
 *   1. `walks`      — does the file call a real fs/child_process tree-walk PRIMITIVE
 *                      (`readdirSync`, `opendirSync`, `globSync`, `readdir`, `glob`, `execSync`/
 *                      `spawnSync` with a find/grep/ls/rg command, or `import.meta.glob`)?
 *   2. `asserts`     — does the file make an assertion on the result (`expect(...)`, `throw`,
 *                      `process.exit(...)`, or a non-zero `process.exitCode = ...` assignment)?
 *   3. `inputProof`  — does an assertion PROVE the WALKED (input) set was non-empty, as opposed
 *                      to merely asserting something about the OUTPUT (violations/findings) set?
 * No CLI, no repo scan, no gate here — those are plan 235-02. This module only classifies text
 * already in hand.
 *
 * ── WHY AST, NEVER A NAME PATTERN OR A TEXT SCAN (D-03, the phase's own two founding mistakes) ──
 * The phase's own first scan used a name pattern matching any identifier that merely contains the
 * word "walk" followed by a call — and it matched a pure in-memory-array function over already-
 * loaded DB rows, 3 confirmed false positives (RESEARCH.md §1). This module instead resolves every
 * candidate call's CALLEE through the file's own `import` bindings (named, namespaced, and dynamic
 * `await import(...)` assigned to a variable — the exact shape
 * `apps/api/src/__tests__/section9-credit.test.ts` uses): a call only counts as a walk if its
 * callee is bound to one of the tracked fs/child_process exports. A locally declared function of
 * the same name (`shadowed-readdir-binding.ts`) is never bound to that import and therefore never
 * matches — this is binding resolution, not name matching.
 *
 * The same first scan also flagged a file on a COMMENT describing the anti-pattern, not on code
 * (D-03 direction 1). This module parses with `ts.createSourceFile`, so every comment is TRIVIA —
 * it is never visited by the AST walk, structurally, not because a stripping pass removed it.
 * The mirror case (D-03 direction 2) is a string literal containing "//" on the line BEFORE a real
 * walk call: a naive `//`-stripping pass blanks the rest of that line and risks corrupting the
 * next; a string-literal TOKEN is never comment trivia to the parser, so the real call on the next
 * line is unaffected. Both directions are pinned by fixtures, never by a regex over source text —
 * the only place this module uses a regex at all is matching a `find`/`grep`/`ls`/`rg` COMMAND
 * inside an already AST-located `execSync`/`spawnSync` string-literal argument (item 3 below),
 * which is a value comparison, not a source-text scan for the primitive itself.
 *
 * ── WHY THE OUTPUT SET IS NOT A PROOF (the load-bearing distinction, RESEARCH.md §2) ────────────
 * Every guard has two candidate "found sets": the INPUT set (files walked, specifiers extracted)
 * and the OUTPUT set (violations/findings). D-02's "the found set is non-empty" can only ever mean
 * the INPUT set — nearly every standing gate in this repo WANTS its output empty in the success
 * case (`--check 0`, "0 finding(s)"). A classifier that accepts an assertion on the OUTPUT set as
 * proof would report every correctly-passing guard as vacuity-proved and never flag the real
 * defect; a gate nobody believes is worth as little as one that checks nothing. This is why
 * `inputProof` only ever looks at assertions whose SUBJECT is a WALK-DERIVED binding (see
 * `collectWalkDerivedBindings` below) — an assertion on a `violations`/`unresolved` array that was
 * merely FILTERED from a walked set is not automatically excluded (a filtered subset propagates
 * the walk-derived tag, since a non-empty filtered subset does imply a non-empty superset), but an
 * assertion using a matcher this module does not recognise as a non-empty proof (`toEqual([])`,
 * `toContain(...)`, `toBeDefined()`, …) never counts regardless of whose set it is about.
 * `apps/api/scripts/check-import-targets.ts`'s real success path
 * (`if (unresolved.length === 0) { ...; process.exitCode = 0; }`) is the concrete counter-example
 * this module is tested against directly (not only via a fixture): its `unresolved.length === 0`
 * condition never ABORTS (the then-branch is the SUCCESS path), so it can never match the
 * `"empty-abort"` shape, and the file contains no `expect(...)` call at all — so it classifies as
 * `inputProof: "none"`, correctly, without special-casing that file by name anywhere in this
 * module.
 *
 * ── HOUSE-FORM NOTES ─────────────────────────────────────────────────────────────────────────────
 * Structured after `apps/api/scripts/measure-context-boundary-imports.ts`: every export below is a
 * pure function of `(filePath, text)` — no file I/O in this module at all, so a caller (this
 * plan's own test file, or a later sweep plan) drives it from fixture reads or from the real tree
 * alike. `extractSpecifiers`'s AST-visitor shape in `./check-import-targets.ts` is the pattern
 * mirrored here (a single recursive `ts.forEachChild` visitor per concern), not reinvented.
 *
 * KNOWN SCOPE LIMIT, stated rather than hidden: walk-derived bindings are tracked as a FLAT set of
 * identifier NAMES across the whole parsed file, not per lexical scope. Two unrelated variables
 * that happen to share a name (one walk-derived, one not, in different functions) are not
 * distinguished. This repo's own guard files do not do that (the fixtures and the two real files
 * this module is tested against do not either), and getting scope-accurate would require a full
 * binder pass this module does not need for its actual job — noted so a future reader does not
 * mistake the simplification for an oversight.
 *
 * ── PLAN 235-02 EXTENSIONS (baseline verification against the REAL tree, not a fixture) ─────────
 * Two gaps in this module surfaced only once its CLI (plan 235-02) ran over every real file and
 * the RESULT was checked by hand against 2-3 files the tool reported vacuous — exactly the
 * "an idiom used once is a blind spot, not a rule" risk RESEARCH.md's own §2 flags for the
 * `scannedAtLeastOne` precedent:
 *   1. `"contains"` input-proof shape — `expect([...walkDerivedSet]).toContain(knownMember)`
 *      (`absence-vocabulary-guard.test.ts`'s real idiom). A set containing a specific known member
 *      cannot be empty; this is at least as strong a proof as `.length > 0`, and was previously
 *      unrecognised — the file classified `inputProof: "none"` despite genuinely proving its walk
 *      non-empty.
 *   2. `isWalkDerivedExpr`'s chain-method branch (`.filter`/`.map`/…) now also recurses into a
 *      receiver that is a DIRECT CALL to a walk-CONTAINING function (`walk(dir).filter(...)`,
 *      `section9-model.test.ts`'s real idiom) — previously it only recognised a receiver that was
 *      itself a raw walk-primitive call or another chain link, so `walk(dir).filter(...)` fell
 *      through to `return false` and the genuine `.length > 0` proof one line later was
 *      misclassified as absent. Both fixtures reproduce the real file's exact shape, not a
 *      hypothetical (`guarded-contains-assert.ts`, `chained-call-on-walk-containing-fn.ts`).
 *
 * ── Flags ────────────────────────────────────────────────────────────────────────────────────────
 *   (none — this module exports pure classification only. The CLI, the repo-wide scan and the
 *   `--check <n>` gate are plan 235-02's job, built ON TOP of `classifyGuardFile`.)
 *
 * Exit codes:
 *   (none — no `main()`, no CLI entry point, no side effect on import.)
 */
import * as ts from "typescript";

// ── Part A: tracked primitives and modules ────────────────────────────────────────────────────

export const WALK_PRIMITIVES = [
  "readdirSync",
  "opendirSync",
  "globSync",
  "readdir",
  "glob",
  "execSync",
  "spawnSync",
  "import.meta.glob",
] as const;

type ModuleGroup = "fs-sync" | "fs-promise" | "cp";

const FS_MODULES = new Set(["node:fs", "fs"]);
const FS_PROMISES_MODULES = new Set(["node:fs/promises", "fs/promises"]);
const CP_MODULES = new Set(["node:child_process", "child_process"]);

const ALLOWED_NAMES: Record<ModuleGroup, ReadonlySet<string>> = {
  "fs-sync": new Set(["readdirSync", "opendirSync", "globSync"]),
  "fs-promise": new Set(["readdir", "glob"]),
  cp: new Set(["execSync", "spawnSync"]),
};

/** A shell command counts as a tree walk only when it invokes one of these — `execSync("git
 * rev-parse HEAD")` is a shell-out, not a walk. */
const CP_COMMAND_RE = /(^|[\s|(])(find|grep|ls|rg)\s/;

/** WR-02 (235-REVIEW.md): `spawnSync`'s idiomatic — and shell-injection-safe — calling form
 * passes the command and its arguments SEPARATELY: `spawnSync("find", [scope, "-type", "f"])`.
 * `CP_COMMAND_RE` requires a trailing `\s` after the matched command word, so a bare command
 * string with nothing else in it (no embedded arguments, unlike `execSync`'s single-string form)
 * never matches. This is that bare-command check, used only alongside a second, separate
 * arguments array (see `isCpCommandWalk` below) — never used standalone, since a lone command
 * word with no args array present is not itself proof of anything. */
const BARE_CP_COMMAND_RE = /^(find|grep|ls|rg)$/;

/** 235-08 addition: `toString` — `execSync(...).toString()` is the standard way to turn its
 * Buffer result into text before splitting it (both `lint-ui.mjs` and `lint-ui-classes.mjs` do
 * exactly this, found while closing Finding 0 above — the TemplateExpression fix alone was not
 * enough to make either file's own empty-abort classifier-visible, because the `.toString()` link
 * in `execSync(...).toString().split("\n").filter(...).map(...)` broke the chain one step before
 * reaching the recognised walk call). Preserves the same "derived-ness" as every other entry here
 * — the string IS the walked result, merely in its text form, not a new, independent value.
 *
 * WR-03 (235-REVIEW.md) addition: `trim` — this list has already been extended once this phase
 * by hitting a real file (`toString`, above), not by being exhaustive by construction; `trim` is
 * the closest-adjacent, most-plausible next miss given that precedent (very commonly chained
 * right after `.toString()` and before `.split("\n")`, to drop a trailing empty line). Every
 * entry here preserves the same "derived-ness" property: the result is still the SAME walked
 * value, merely trimmed/split/mapped, never a new, independent one. Not exhaustive by design —
 * this list is extended when a real file's chain breaks derivation one link short, same as
 * `toString` was, not widened speculatively ahead of a real shape. */
const CHAIN_METHODS = new Set([
  "filter",
  "map",
  "flatMap",
  "sort",
  "concat",
  "split",
  "toString",
  "trim",
]);

/** WR-02 adjacent gap (235-REVIEW.md), found while closing WR-02: unlike `execSync`, which
 * returns the process output directly, `spawnSync`'s return value is a RESULT OBJECT — its
 * `.stdout`/`.stderr` properties hold the actual output, exactly the shape the review's own
 * reproduction transcript uses (`res.stdout.toString().split(...)`, `res` being `spawnSync(...)`'s
 * own return value). Property access is not a method call, so `CHAIN_METHODS` (which only ever
 * recurses through a CALL's receiver) cannot cover it — this needed its own case in
 * `isWalkDerivedExpr` below, or the spawnSync call-site fix alone would leave every idiomatic
 * `spawnSync` guard permanently unable to prove its own non-emptiness. */
const SPAWN_RESULT_PROPERTIES = new Set(["stdout", "stderr"]);

function moduleGroupOf(specifierText: string): ModuleGroup | null {
  if (FS_MODULES.has(specifierText)) return "fs-sync";
  if (FS_PROMISES_MODULES.has(specifierText)) return "fs-promise";
  if (CP_MODULES.has(specifierText)) return "cp";
  return null;
}

// ── Part B: resolving the file's own import bindings ──────────────────────────────────────────

interface Binding {
  kind: "named" | "namespace";
  group: ModuleGroup;
  sourceName?: string; // set for "named" only
  label: string; // human-readable provenance for WalkSite.binding
}

function unwrapAwait(expr: ts.Expression): ts.Expression {
  return ts.isAwaitExpression(expr) ? unwrapAwait(expr.expression) : expr;
}

function isDynamicImportCall(node: ts.CallExpression): boolean {
  return node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

/** Collects every local identifier bound to a tracked fs/child_process export: `import { x }`,
 * `import * as x`, and `const x = await import("node:fs")` (the shape
 * `section9-credit.test.ts` uses) all resolve to the same binding table. */
function collectBindings(sourceFile: ts.SourceFile): Map<string, Binding> {
  const bindings = new Map<string, Binding>();

  function registerNamedImport(importClause: ts.ImportClause | undefined, moduleText: string) {
    const group = moduleGroupOf(moduleText);
    if (!group || !importClause) return;
    if (importClause.name) {
      // WR-01 (235-REVIEW.md): `import fs from "node:fs"` (a default import) has no
      // `namedBindings` at all — `importClause.namedBindings` is `undefined` for this shape, so
      // the old early-return before this check never even registered `fs`. Node's CJS interop
      // (this repo's tsconfig sets `esModuleInterop`) makes a default import of `node:fs`/
      // `node:child_process` behave identically to a namespace import for property-access
      // purposes, so it is tracked the same way.
      bindings.set(importClause.name.text, {
        kind: "namespace",
        group,
        label: `${moduleText} default import`,
      });
    }
    if (!importClause.namedBindings) return;
    if (ts.isNamedImports(importClause.namedBindings)) {
      for (const el of importClause.namedBindings.elements) {
        const importedName = (el.propertyName ?? el.name).text;
        if (ALLOWED_NAMES[group].has(importedName)) {
          bindings.set(el.name.text, {
            kind: "named",
            group,
            sourceName: importedName,
            label: `${moduleText} named import`,
          });
        }
      }
    } else if (ts.isNamespaceImport(importClause.namedBindings)) {
      bindings.set(importClause.namedBindings.name.text, {
        kind: "namespace",
        group,
        label: `${moduleText} namespace import`,
      });
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      registerNamedImport(node.importClause, node.moduleSpecifier.text);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrapAwait(node.initializer);
      if (
        ts.isCallExpression(init) &&
        isDynamicImportCall(init) &&
        init.arguments[0] &&
        ts.isStringLiteral(init.arguments[0])
      ) {
        const group = moduleGroupOf(init.arguments[0].text);
        if (group) {
          bindings.set(node.name.text, {
            kind: "namespace",
            group,
            label: `dynamic import("${init.arguments[0].text}") binding`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return bindings;
}

// ── Part C: locating walk-primitive call sites ────────────────────────────────────────────────

export interface WalkSite {
  line: number;
  primitive: string;
  binding: string;
}

interface WalkCallInfo extends WalkSite {
  node: ts.CallExpression;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * 235-08 (owner-approved addition, `235-BEFUND-E.md` "Finding 0"): `ts.isStringLiteralLike`
 * recognises a plain `StringLiteral` and a `NoSubstitutionTemplateLiteral`, but NOT a
 * `TemplateExpression` — a template literal that contains at least one `${…}` substitution, which
 * has no `.text` property at all. `apps/web/scripts/lint-ui.mjs`/`lint-ui-classes.mjs` both shell
 * out via `` execSync(`find '${scope}' ...`) `` — exactly that shape — and were therefore
 * architecturally invisible to this classifier (`walks: false`) despite a real, live `find` call.
 * Matched against the template's own HEAD (the literal text before the first substitution, e.g.
 * `"find '"` for `` `find '${scope}' -type f -name '*${ext}'` ``) — the command name always sits
 * there in every real shape this repo uses (`find '<path>' ...`), never inside a substitution
 * itself, so the head alone is the right (and only) place to look; nothing about the trailing
 * dynamic segments is a command name to match against.
 *
 * WR-02 (235-REVIEW.md) addition: `spawnSync("find", [scope, "-type", "f"])` — the command and
 * its arguments passed as two SEPARATE call arguments, `spawnSync`'s idiomatic, shell-injection-
 * safe form. `arg` here is only ever `args[0]`; the second, separate arguments array is checked
 * by the caller (`args[1]` must be present) before this bare-word match is trusted, so a lone
 * `spawnSync("find")` with no second argument is not treated as a walk on this string alone.
 */
function isCpCommandWalk(
  arg: ts.Expression | undefined,
  primitiveName?: string,
  hasArgsArray?: boolean,
): boolean {
  if (!arg) return false;
  if (ts.isStringLiteralLike(arg)) {
    if (CP_COMMAND_RE.test(arg.text)) return true;
    return primitiveName === "spawnSync" && !!hasArgsArray && BARE_CP_COMMAND_RE.test(arg.text);
  }
  if (ts.isTemplateExpression(arg)) return CP_COMMAND_RE.test(arg.head.text);
  return false;
}

/** `import.meta.glob(...)` — not found in this repo today (RESEARCH.md §1), but the one shape
 * that would silently sidestep every binding-based rule above if it ever appeared. */
function isImportMetaGlob(callee: ts.LeftHandSideExpression): boolean {
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "glob" &&
    ts.isMetaProperty(callee.expression) &&
    callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

function findWalkSites(sourceFile: ts.SourceFile, bindings: Map<string, Binding>): WalkCallInfo[] {
  const sites: WalkCallInfo[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (isImportMetaGlob(node.expression)) {
        sites.push({
          node,
          primitive: "import.meta.glob",
          binding: "import.meta.glob",
          line: lineOf(sourceFile, node),
        });
      } else if (ts.isIdentifier(node.expression)) {
        const binding = bindings.get(node.expression.text);
        if (binding?.kind === "named" && binding.sourceName) {
          const isCandidate = ALLOWED_NAMES[binding.group].has(binding.sourceName);
          const isWalk =
            isCandidate &&
            (binding.group !== "cp" ||
              isCpCommandWalk(node.arguments[0], binding.sourceName, !!node.arguments[1]));
          if (isWalk) {
            sites.push({
              node,
              primitive: binding.sourceName,
              binding: binding.label,
              line: lineOf(sourceFile, node),
            });
          }
        }
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression;
        const prop = node.expression.name.text;
        if (ts.isIdentifier(receiver)) {
          const binding = bindings.get(receiver.text);
          if (binding?.kind === "namespace" && ALLOWED_NAMES[binding.group].has(prop)) {
            const isWalk =
              binding.group !== "cp" ||
              isCpCommandWalk(node.arguments[0], prop, !!node.arguments[1]);
            if (isWalk) {
              sites.push({
                node,
                primitive: prop,
                binding: binding.label,
                line: lineOf(sourceFile, node),
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return sites;
}

// ── Part D: walk-derived bindings (D-05 propagation: direct, chained, recursive-helper, transitive)

/** `expr` resolves — directly or through an allowed chain (`.filter/.map/.flatMap/.sort/.concat/
 * .split`, `Array.from(...)`, `new Set(...)`), or through a call to a walk-CONTAINING same-file
 * function (Plan 235-02, baseline-verification finding: `new Set(scannedFiles().map(...))` in
 * `absence-vocabulary-guard.test.ts` — a walk-containing function's result wrapped in a chain
 * BEFORE being handed to `new Set(...)`, one level deeper than the outer fixed-point loop's own
 * "direct call as the whole initializer" check alone can see) — to a walk-primitive call or an
 * already-derived identifier. */
function isWalkDerivedExpr(
  expr: ts.Expression,
  walkCalls: ReadonlySet<ts.CallExpression>,
  derived: ReadonlySet<string>,
  walkContainingFns: ReadonlySet<string>,
): boolean {
  if (ts.isParenthesizedExpression(expr)) {
    return isWalkDerivedExpr(expr.expression, walkCalls, derived, walkContainingFns);
  }
  if (ts.isCallExpression(expr)) {
    if (walkCalls.has(expr)) return true;
    if (ts.isIdentifier(expr.expression) && walkContainingFns.has(expr.expression.text)) {
      return true;
    }
    if (ts.isPropertyAccessExpression(expr.expression)) {
      const name = expr.expression.name.text;
      const receiver = expr.expression.expression;
      if (CHAIN_METHODS.has(name)) {
        return isWalkDerivedExpr(receiver, walkCalls, derived, walkContainingFns);
      }
      if (name === "from" && ts.isIdentifier(receiver) && receiver.text === "Array") {
        const arg = expr.arguments[0];
        return !!arg && isWalkDerivedExpr(arg, walkCalls, derived, walkContainingFns);
      }
    }
    return false;
  }
  if (
    ts.isNewExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Set"
  ) {
    const arg = expr.arguments?.[0];
    return !!arg && isWalkDerivedExpr(arg, walkCalls, derived, walkContainingFns);
  }
  if (ts.isIdentifier(expr)) {
    return derived.has(expr.text);
  }
  if (ts.isPropertyAccessExpression(expr) && SPAWN_RESULT_PROPERTIES.has(expr.name.text)) {
    return isWalkDerivedExpr(expr.expression, walkCalls, derived, walkContainingFns);
  }
  return false;
}

function functionContainsWalkCall(
  body: ts.Node,
  walkCalls: ReadonlySet<ts.CallExpression>,
): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(node) && walkCalls.has(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(body);
  return found;
}

function functionCallsAnyOf(body: ts.Node, names: ReadonlySet<string>): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      names.has(node.expression.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(body);
  return found;
}

function collectNamedFunctions(sourceFile: ts.SourceFile): Map<string, ts.FunctionDeclaration> {
  const fns = new Map<string, ts.FunctionDeclaration>();
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      fns.set(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return fns;
}

/** A function is "walk-containing" if its own body directly contains a walk-primitive call, or
 * (transitively, fixed-point) if it calls another walk-containing function declared in the same
 * file — mirrors how `check-import-targets.ts`'s `collectAllOccurrences` calls
 * `discoverCheckedFiles`, which calls `walkTsFiles`. */
function computeWalkContainingFunctions(
  namedFunctions: Map<string, ts.FunctionDeclaration>,
  walkCalls: ReadonlySet<ts.CallExpression>,
): Set<string> {
  const result = new Set<string>();
  for (const [name, fn] of namedFunctions) {
    if (fn.body && functionContainsWalkCall(fn.body, walkCalls)) result.add(name);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, fn] of namedFunctions) {
      if (result.has(name) || !fn.body) continue;
      if (functionCallsAnyOf(fn.body, result)) {
        result.add(name);
        changed = true;
      }
    }
  }
  return result;
}

function computeWalkDerivedNames(
  sourceFile: ts.SourceFile,
  walkCalls: ReadonlySet<ts.CallExpression>,
): { derived: Set<string>; walkContainingFns: Set<string> } {
  const derived = new Set<string>();
  const namedFunctions = collectNamedFunctions(sourceFile);
  const walkContainingFns = computeWalkContainingFunctions(namedFunctions, walkCalls);

  // Rule (b): `<name>.push(...)` / `<name>.add(...)` inside a walk-containing function's body —
  // the recursive `walk(dir)` / `walkTsFiles(dir, out)` helper shape.
  for (const name of walkContainingFns) {
    const fn = namedFunctions.get(name);
    if (!fn?.body) continue;
    (function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === "push" || node.expression.name.text === "add") &&
        ts.isIdentifier(node.expression.expression)
      ) {
        derived.add(node.expression.expression.text);
      }
      ts.forEachChild(node, visit);
    })(fn.body);
  }

  // Rule (a)/(c): direct/chained init from a walk call, or init from calling a walk-containing
  // same-file function — fixed point so chained variable-to-variable derivation converges.
  let changed = true;
  while (changed) {
    changed = false;
    (function visit(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (!derived.has(node.name.text)) {
          const init = node.initializer;
          // `isWalkDerivedExpr` itself now recognises a direct call to a walk-containing function
          // ANYWHERE in the expression tree (including nested inside a chain, e.g.
          // `new Set(scannedFiles().map(...))`), so the "whole initializer IS a direct call"
          // check below is a subset of what `isWalkDerivedExpr` already covers — kept anyway as
          // the minimal, easy-to-verify base case a reader can check without following the
          // recursion.
          const viaExpr = isWalkDerivedExpr(init, walkCalls, derived, walkContainingFns);
          const viaCall =
            !viaExpr &&
            ts.isCallExpression(init) &&
            ts.isIdentifier(init.expression) &&
            walkContainingFns.has(init.expression.text);
          if (viaExpr || viaCall) {
            derived.add(node.name.text);
            changed = true;
          }
        }
      }
      ts.forEachChild(node, visit);
    })(sourceFile);
  }

  return { derived, walkContainingFns };
}

/** Every local identifier that resolves — directly, through an allowed method chain, through a
 * `push`/`add` inside a walk-containing recursive helper, or transitively through a same-file
 * function call — to a walk-primitive result. Exported so plan 235-02's sweep and this plan's own
 * test suite can assert on it directly, independent of the higher-level `classifyGuardFile`. */
export function collectWalkDerivedBindings(sourceFile: ts.SourceFile): Set<string> {
  const bindings = collectBindings(sourceFile);
  const walkCalls = new Set(findWalkSites(sourceFile, bindings).map((s) => s.node));
  return computeWalkDerivedNames(sourceFile, walkCalls).derived;
}

// ── Part E: assertion sites ────────────────────────────────────────────────────────────────────

export type AssertKind = "expect" | "throw" | "process.exit" | "exitCode";

interface AssertSiteInternal {
  line: number;
  kind: AssertKind;
  node: ts.CallExpression | ts.ThrowStatement | ts.BinaryExpression;
}

function isProcessExitCall(node: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "process" &&
    node.expression.name.text === "exit"
  );
}

function isProcessExitCodeAccess(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "process" &&
    expr.name.text === "exitCode"
  );
}

function isNonZeroNumericLiteral(expr: ts.Expression): boolean {
  if (ts.isNumericLiteral(expr)) return expr.text !== "0";
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return expr.operand.text !== "0";
  }
  return false;
}

function isZeroNumericLiteral(expr: ts.Expression): boolean {
  return ts.isNumericLiteral(expr) && expr.text === "0";
}

/** Issue #263: the signed numeric value of a literal bound, or `null` if `expr` is not a numeric
 * literal (a variable, a binary expression, anything else). Underscore separators are stripped
 * defensively so a bound written `20_000` is read as a number, not silently dropped by
 * `Number(...)`. Mirrors the `PrefixUnaryExpression` shape `isNonZeroNumericLiteral` already
 * uses, so `-1` resolves to `-1`, not `null`. */
function numericLiteralValue(expr: ts.Expression): number | null {
  if (ts.isNumericLiteral(expr)) {
    const value = Number(expr.text.replace(/_/g, ""));
    return Number.isFinite(value) ? value : null;
  }
  if (ts.isPrefixUnaryExpression(expr) && ts.isNumericLiteral(expr.operand)) {
    const value = Number(expr.operand.text.replace(/_/g, ""));
    if (!Number.isFinite(value)) return null;
    if (expr.operator === ts.SyntaxKind.MinusToken) return -value;
    if (expr.operator === ts.SyntaxKind.PlusToken) return value;
  }
  return null;
}

function findAssertSites(sourceFile: ts.SourceFile): AssertSiteInternal[] {
  const sites: AssertSiteInternal[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "expect") {
        sites.push({ line: lineOf(sourceFile, node), kind: "expect", node });
      } else if (isProcessExitCall(node)) {
        sites.push({ line: lineOf(sourceFile, node), kind: "process.exit", node });
      }
    } else if (ts.isThrowStatement(node)) {
      sites.push({ line: lineOf(sourceFile, node), kind: "throw", node });
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isProcessExitCodeAccess(node.left) &&
      isNonZeroNumericLiteral(node.right)
    ) {
      sites.push({ line: lineOf(sourceFile, node), kind: "exitCode", node });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return sites;
}

/** Whether `stmt`'s subtree contains an explicit abort: a `throw`, a `process.exit(<non-zero>)`
 * call, or a `process.exitCode = <non-zero>` assignment. Used by the `"empty-abort"` shape. */
function branchAborts(stmt: ts.Statement): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isThrowStatement(node)) {
      found = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      isProcessExitCall(node) &&
      node.arguments[0] &&
      isNonZeroNumericLiteral(node.arguments[0])
    ) {
      found = true;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isProcessExitCodeAccess(node.left) &&
      isNonZeroNumericLiteral(node.right)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(stmt);
  return found;
}

// ── Part F: the expect(...) chain, and the four accepted input-proof shapes ───────────────────

interface ExpectChain {
  properties: string[]; // in encounter order, innermost first — e.g. ["not", "toBe"]
  finalCall: ts.CallExpression | undefined;
}

/** `expect(x).not.toBe(0)` — walks UP from the innermost `expect(x)` call through the chained
 * `.prop` accesses to the outermost call, collecting method names in order. */
function getExpectChain(expectCall: ts.CallExpression): ExpectChain {
  const properties: string[] = [];
  let current: ts.Node = expectCall;
  while (ts.isPropertyAccessExpression(current.parent)) {
    properties.push(current.parent.name.text);
    current = current.parent;
  }
  const finalCall =
    ts.isCallExpression(current.parent) && current.parent.expression === current
      ? current.parent
      : undefined;
  return { properties, finalCall };
}

function walkDerivedLengthSubject(
  expr: ts.Expression,
  derived: ReadonlySet<string>,
): { name: string; property: "length" | "size" } | null {
  if (
    ts.isPropertyAccessExpression(expr) &&
    (expr.name.text === "length" || expr.name.text === "size") &&
    ts.isIdentifier(expr.expression) &&
    derived.has(expr.expression.text)
  ) {
    return { name: expr.expression.text, property: expr.name.text };
  }
  return null;
}

interface ProofSite {
  line: number;
  subject: string;
}

/** Issue #263: a bound proves the walked set non-empty exactly when it EXCLUDES the value 0 —
 * never merely because the number is non-negative. `toBeGreaterThanOrEqual(0)` is rejected
 * because it holds for length 0 itself (a tautology over any length); `toBeGreaterThan(-1)` is
 * rejected for the same reason (length 0 satisfies `0 > -1`). A non-literal bound (`numericLiteralValue`
 * returns `null`) or any matcher other than these two is never a proof. */
function boundExcludesEmpty(method: string, arg0: ts.Expression): boolean {
  const value = numericLiteralValue(arg0);
  if (value === null) return false;
  if (method === "toBeGreaterThan") return value >= 0;
  if (method === "toBeGreaterThanOrEqual") return value > 0;
  return false;
}

/** The `"length"` shape: `expect(x.length).toBeGreaterThan(0)`, `expect(x).not.toHaveLength(0)`,
 * `expect(x.size).toBeGreaterThan(0)`, `expect(x.length).not.toBe(0)` — subject always a
 * walk-derived binding. */
function matchLengthProof(
  sourceFile: ts.SourceFile,
  expectSites: { node: ts.CallExpression }[],
  derived: ReadonlySet<string>,
): ProofSite[] {
  const hits: ProofSite[] = [];
  for (const { node } of expectSites) {
    const subjectExpr = node.arguments[0];
    if (!subjectExpr) continue;
    const { properties, finalCall } = getExpectChain(node);
    if (!finalCall) continue;
    const hasNot = properties.includes("not");
    const method = properties[properties.length - 1];
    const arg0 = finalCall.arguments[0];
    if (!arg0) continue;

    const lengthSubject = walkDerivedLengthSubject(subjectExpr, derived);
    if (lengthSubject && !hasNot && boundExcludesEmpty(method, arg0)) {
      hits.push({ line: lineOf(sourceFile, node), subject: lengthSubject.name });
      continue;
    }
    if (
      lengthSubject?.property === "length" &&
      hasNot &&
      method === "toBe" &&
      isZeroNumericLiteral(arg0)
    ) {
      hits.push({ line: lineOf(sourceFile, node), subject: lengthSubject.name });
      continue;
    }
    if (
      ts.isIdentifier(subjectExpr) &&
      derived.has(subjectExpr.text) &&
      hasNot &&
      method === "toHaveLength" &&
      isZeroNumericLiteral(arg0)
    ) {
      hits.push({ line: lineOf(sourceFile, node), subject: subjectExpr.text });
    }
  }
  return hits;
}

/** `expr` resolves to a walk-derived binding for `.toContain(...)` purposes: either a bare
 * identifier in `derived`, or the single-spread array literal `[...x]` with `x` in `derived` — the
 * shape a `Set<string>` walk-derived accumulator takes when spread into an array so `toContain`
 * can be called on it (`Set` itself has no `.toContain` matcher in this repo's assertion library).
 * Found live (Plan 235-02, baseline verification against the real tree, not a fixture): a walk
 * that proves reaching specific, individually-named members is at least as strong a non-emptiness
 * proof as `length > 0` — a set that CONTAINS a known member cannot be empty. */
function walkDerivedContainsSubject(
  expr: ts.Expression,
  derived: ReadonlySet<string>,
): string | null {
  if (ts.isIdentifier(expr)) return derived.has(expr.text) ? expr.text : null;
  if (ts.isArrayLiteralExpression(expr) && expr.elements.length === 1) {
    const el = expr.elements[0];
    if (
      ts.isSpreadElement(el) &&
      ts.isIdentifier(el.expression) &&
      derived.has(el.expression.text)
    ) {
      return el.expression.text;
    }
  }
  return null;
}

/** The `"contains"` shape: `expect(<walkDerived>).toContain(<anything>)` (never `.not.toContain`,
 * which proves nothing about non-emptiness — it could hold on an empty set too). */
function matchContainsProof(
  sourceFile: ts.SourceFile,
  expectSites: { node: ts.CallExpression }[],
  derived: ReadonlySet<string>,
): ProofSite[] {
  const hits: ProofSite[] = [];
  for (const { node } of expectSites) {
    const subjectExpr = node.arguments[0];
    if (!subjectExpr) continue;
    const { properties, finalCall } = getExpectChain(node);
    if (!finalCall) continue;
    if (properties.includes("not") || properties[properties.length - 1] !== "toContain") continue;
    const subject = walkDerivedContainsSubject(subjectExpr, derived);
    if (subject) hits.push({ line: lineOf(sourceFile, node), subject });
  }
  return hits;
}

/** The `"empty-abort"` shape: `if (<walkDerived>.length/.size === 0 | < 1 | !<...>.length) { throw
 * | process.exit(<non-zero>) | process.exitCode = <non-zero> }`. */
function matchEmptyAbortProof(
  sourceFile: ts.SourceFile,
  derived: ReadonlySet<string>,
): ProofSite[] {
  const hits: ProofSite[] = [];

  function matchCondition(cond: ts.Expression): string | null {
    if (ts.isBinaryExpression(cond)) {
      const { left, operatorToken, right } = cond;
      const isEqZero =
        operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken;
      const isLtOne = operatorToken.kind === ts.SyntaxKind.LessThanToken;
      if (isEqZero) {
        const leftSubject = walkDerivedLengthSubject(left, derived);
        if (leftSubject && isZeroNumericLiteral(right)) return leftSubject.name;
        const rightSubject = walkDerivedLengthSubject(right, derived);
        if (rightSubject && isZeroNumericLiteral(left)) return rightSubject.name;
      }
      if (isLtOne) {
        const leftSubject = walkDerivedLengthSubject(left, derived);
        if (leftSubject && ts.isNumericLiteral(right) && right.text === "1")
          return leftSubject.name;
      }
      return null;
    }
    if (ts.isPrefixUnaryExpression(cond) && cond.operator === ts.SyntaxKind.ExclamationToken) {
      const subject = walkDerivedLengthSubject(cond.operand, derived);
      return subject?.name ?? null;
    }
    return null;
  }

  function visit(node: ts.Node): void {
    if (ts.isIfStatement(node)) {
      const subject = matchCondition(node.expression);
      if (subject && branchAborts(node.thenStatement)) {
        hits.push({ line: lineOf(sourceFile, node), subject });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return hits;
}

/** An identifier declared `let <name> = false;` (candidate flag). */
function collectFalseFlags(sourceFile: ts.SourceFile): Set<string> {
  const flags = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer?.kind === ts.SyntaxKind.FalseKeyword
    ) {
      flags.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return flags;
}

type LoopNode = ts.ForOfStatement | ts.ForInStatement;

function isLoopNode(node: ts.Node): node is LoopNode {
  return ts.isForOfStatement(node) || ts.isForInStatement(node);
}

function isWithin(sourceFile: ts.SourceFile, inner: ts.Node, outer: ts.Node): boolean {
  return (
    inner.getStart(sourceFile) >= outer.getStart(sourceFile) && inner.getEnd() <= outer.getEnd()
  );
}

/** Whether `<flagName>` is confirmed later: `expect(<flagName>).toBe(true)`, or
 * `if (!<flagName>) { <abort> }`. */
function flagIsConfirmed(sourceFile: ts.SourceFile, flagName: string): boolean {
  let confirmed = false;
  function visit(node: ts.Node): void {
    if (confirmed) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "expect" &&
      node.arguments[0] &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === flagName
    ) {
      const { properties, finalCall } = getExpectChain(node);
      if (
        !properties.includes("not") &&
        properties[properties.length - 1] === "toBe" &&
        finalCall?.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword
      ) {
        confirmed = true;
        return;
      }
    }
    if (
      ts.isIfStatement(node) &&
      ts.isPrefixUnaryExpression(node.expression) &&
      node.expression.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isIdentifier(node.expression.operand) &&
      node.expression.operand.text === flagName &&
      branchAborts(node.thenStatement)
    ) {
      confirmed = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return confirmed;
}

/** The `"flag-inner"`/`"flag-outer"` shapes: a boolean flag declared `false`, set `true` inside a
 * walk-derived loop, later confirmed. `"flag-inner"` when the assignment's nearest enclosing
 * walk-derived loop has no OTHER walk-derived loop nested inside it; `"flag-outer"` when one does
 * (the outer-loop-ran-while-inner-set-was-empty shape D-05(e) flags for later review). */
function matchFlagProof(
  sourceFile: ts.SourceFile,
  walkCalls: ReadonlySet<ts.CallExpression>,
  derived: ReadonlySet<string>,
  walkContainingFns: ReadonlySet<string>,
): { hits: ProofSite[]; kind: "flag-inner" | "flag-outer" | null } {
  const flags = collectFalseFlags(sourceFile);
  const allLoops: LoopNode[] = [];
  (function collect(node: ts.Node): void {
    if (
      isLoopNode(node) &&
      isWalkDerivedExpr(node.expression, walkCalls, derived, walkContainingFns)
    ) {
      allLoops.push(node);
    }
    ts.forEachChild(node, collect);
  })(sourceFile);

  const hits: ProofSite[] = [];
  let kind: "flag-inner" | "flag-outer" | null = null;

  function visit(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      flags.has(node.left.text) &&
      node.right.kind === ts.SyntaxKind.TrueKeyword
    ) {
      const flagName = node.left.text;
      const enclosing = allLoops.filter((loop) => isWithin(sourceFile, node, loop));
      if (enclosing.length > 0 && flagIsConfirmed(sourceFile, flagName)) {
        // innermost = smallest span
        const hostLoop = enclosing.reduce((a, b) =>
          b.getEnd() - b.getStart() < a.getEnd() - a.getStart() ? b : a,
        );
        const hasNestedWalkLoop = allLoops.some(
          (loop) => loop !== hostLoop && isWithin(sourceFile, loop, hostLoop.statement),
        );
        kind = hasNestedWalkLoop ? "flag-outer" : "flag-inner";
        hits.push({ line: lineOf(sourceFile, node), subject: flagName });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { hits, kind };
}

// ── Part G: the public classifier ─────────────────────────────────────────────────────────────

export type InputProofKind =
  | "none"
  | "length"
  | "contains"
  | "flag-inner"
  | "flag-outer"
  | "empty-abort";

export interface GuardClassification {
  file: string;
  walks: boolean;
  walkSites: WalkSite[];
  asserts: boolean;
  assertSites: { line: number; kind: AssertKind }[];
  inputProof: InputProofKind;
  inputProofSites: { line: number; subject: string }[];
}

/** Parses `text` as `filePath` (`ScriptKind.JS` for `.mjs`/`.js`, `.TS` otherwise) and classifies
 * it. Pure: no file I/O, so callers drive it from strings and from fixture reads alike. */
export function classifyGuardFile(filePath: string, text: string): GuardClassification {
  const scriptKind = /\.(mjs|js)$/.test(filePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);

  const bindings = collectBindings(sourceFile);
  const walkCallInfos = findWalkSites(sourceFile, bindings);
  const walkCalls = new Set(walkCallInfos.map((w) => w.node));
  const { derived, walkContainingFns } = computeWalkDerivedNames(sourceFile, walkCalls);
  const assertSitesInternal = findAssertSites(sourceFile);
  const expectSites = assertSitesInternal
    .filter((s): s is AssertSiteInternal & { node: ts.CallExpression } => s.kind === "expect")
    .map((s) => ({ node: s.node as ts.CallExpression }));

  let inputProof: InputProofKind = "none";
  let inputProofSites: ProofSite[] = [];

  const lengthHits = matchLengthProof(sourceFile, expectSites, derived);
  if (lengthHits.length > 0) {
    inputProof = "length";
    inputProofSites = lengthHits;
  } else {
    const containsHits = matchContainsProof(sourceFile, expectSites, derived);
    if (containsHits.length > 0) {
      inputProof = "contains";
      inputProofSites = containsHits;
    } else {
      const abortHits = matchEmptyAbortProof(sourceFile, derived);
      if (abortHits.length > 0) {
        inputProof = "empty-abort";
        inputProofSites = abortHits;
      } else {
        const flagResult = matchFlagProof(sourceFile, walkCalls, derived, walkContainingFns);
        if (flagResult.kind) {
          inputProof = flagResult.kind;
          inputProofSites = flagResult.hits;
        }
      }
    }
  }

  return {
    file: filePath,
    walks: walkCallInfos.length > 0,
    walkSites: walkCallInfos.map((w) => ({
      line: w.line,
      primitive: w.primitive,
      binding: w.binding,
    })),
    asserts: assertSitesInternal.length > 0,
    assertSites: assertSitesInternal.map((s) => ({ line: s.line, kind: s.kind })),
    inputProof,
    inputProofSites,
  };
}
