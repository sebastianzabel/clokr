#!/usr/bin/env -S pnpm exec tsx
/**
 * Phase 100B Plan 03 (D-07/D-10, GitHub issue #100) — `lint:facade-signatures`.
 *
 * This is R1's only automated defence (100B-CONTEXT.md D-07): 125 call sites in this tree run on
 * a `$transaction` client (`tx.<model>.<op>(`). A facade function that takes `app: FastifyInstance`
 * and reaches for `app.prisma` internally moves a write OUT of its caller's transaction with no
 * error — the write survives a rollback. In an audit-proof system that is the worst class of
 * defect. `contexts/working-time-account/confirmed-saldo.ts:43,71` is the existing precedent for
 * the wrong shape; `contexts/absence/leave-check.ts:9` is the existing precedent for the right one.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────────────────────────
 * Every `.ts` file under `apps/api/src/contexts/*\/facade/` (skip `__tests__/`, skip `*.test.ts`),
 * PLUS the two already-public de-facto facades named explicitly in `KNOWN_FACADE_FILES`. Today the
 * glob matches nothing at all — `KNOWN_FACADE_FILES` is what keeps this linter from walking zero
 * files and reporting OK, the exact shape of #229 (see the zero-file guard in `run()` below). Each
 * conversion plan (100B-05 onward) adds its own new `facade/` files, which the glob then covers
 * automatically without a code change here.
 *
 * ── Rules, checked per EXPORTED function declaration (AST via `typescript`, not a source regex —
 *    the same approach `check-import-targets.ts` and `lint-tenant-scoping-candidates.ts` use) ────
 *
 * F1 (D-07, first parameter). The first parameter must be named EXACTLY `db` and its type
 * annotation must be EXACTLY `Prisma.TransactionClient`. Both the name and the type are checked —
 * a correctly-typed parameter under the wrong name (e.g. `prisma: Prisma.TransactionClient`) is
 * still an F1 finding, because the point of the rule is a mechanically recognisable convention,
 * not merely "any client the call happens to run on".
 *
 * F2 (R1, no Fastify anywhere in the signature). No parameter of an exported facade function may
 * be annotated `FastifyInstance`, `FastifyRequest` or `FastifyReply`. The message says WHY, not
 * just WHAT: a write through `app.prisma` leaves the caller's `$transaction` silently and survives
 * a rollback.
 *
 * F3 (G4, tenant boundary follows the identifier). An exported facade function declaring a
 * parameter matching `/^[a-zA-Z]*Ids?$/` (e.g. `employeeId`, `employeeIds`, `leaveTypeId`) must
 * ALSO declare a parameter literally named `tenantId`, or carry a named exception. `tenantId`
 * itself never triggers the rule (it IS the tenant parameter). A bare `id` is exempted from the
 * trigger set explicitly (not merely because the regex's required capital-`I` "Id"/"Ids" suffix
 * happens not to match lowercase "id") — see `F3_EXEMPT_NAMES` below.
 *
 * ── Known deviation from the plan's own worked example (recorded, not silently absorbed) ────────
 * Plan 100B-03's Task 1 illustrative summary line reads "2 exported facade function(s) checked, 2
 * exception(s) applied, 0 finding(s)." and Task 1's text names ONLY `confirmed-saldo.ts`'s two
 * functions as needing an exception. Measured against the REAL current file contents this does
 * not hold: `KNOWN_FACADE_FILES` covers 2 files but 3 exported functions total (`leave-check.ts`'s
 * `hasApprovedLeaveOnDate` plus `confirmed-saldo.ts`'s two), and `hasApprovedLeaveOnDate`'s own
 * signature — `(prisma: Prisma.TransactionClient, employeeId: string, dateStr: string)` — fails F1
 * (named `prisma`, not `db`) and F3 (`employeeId` with no `tenantId`) under the rules exactly as
 * this plan's own Task 1 <behavior> and fixture list specify them ("a prisma: Prisma.TransactionClient
 * first parameter with the wrong NAME" is explicitly listed as a fixture VIOLATION case, which
 * fixes F1's name check as literal). There is no reading of the stated rules under which
 * `hasApprovedLeaveOnDate` passes cleanly without either a third exception or a production-code
 * rename outside this plan's declared `files_modified`. This module therefore seeds THREE
 * exception entries, not two — see `lint-facade-signatures-exceptions.json` and the 100B-03-SUMMARY
 * for the full accounting. This is a measured correction of the plan's own worked example, not a
 * relaxed assertion: the RULES are implemented exactly as specified; only the SEED COUNT is
 * calibrated to what the real tree requires.
 *
 * ── Exceptions ────────────────────────────────────────────────────────────────────────────────
 * Live in `lint-facade-signatures-exceptions.json`, one entry per `{ file, function, rules,
 * reason }` — `rules` is an array because a single grandfathered function commonly violates more
 * than one rule at once (both `confirmed-saldo.ts` functions violate all three). Mandatory
 * non-trivial `reason` (`MIN_REASON_LENGTH`, mirrors `lint-tenant-scoping-exceptions.ts`). A stale
 * entry — naming a function that no longer exists, or naming a rule it no longer violates — is a
 * HARD ERROR, same as the tenant-scoping gate's.
 *
 * ── Flags ─────────────────────────────────────────────────────────────────────────────────────
 *   (none) — print the one-line summary; exit 0 if 0 unexcepted findings, else 1 (findings listed).
 *
 * This module has no side effects on import — `main()`/`run()` only executes when this file is
 * the process entry point (GitHub #203: an unguarded `main()` runs on import).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";

// ── Constants ─────────────────────────────────────────────────────────────────────────────────

export const EXCEPTIONS_FILE = "apps/api/scripts/lint-facade-signatures-exceptions.json";

/** The two already-public de-facto facades (100B-CONTEXT.md D-07 <interfaces>), named explicitly
 * so this linter has real work from day one even though `contexts/*\/facade/` matches nothing yet
 * (see the module header and the zero-file guard in `run()`). Repo-relative paths. */
export const KNOWN_FACADE_FILES: readonly string[] = [
  "apps/api/src/contexts/absence/leave-check.ts",
  "apps/api/src/contexts/working-time-account/confirmed-saldo.ts",
];

export type FacadeRule = "F1" | "F2" | "F3";

const TRANSACTION_CLIENT_TYPE = "Prisma.TransactionClient";
const REQUIRED_FIRST_PARAM_NAME = "db";
const FASTIFY_TYPE_RE = /\bFastify(Instance|Request|Reply)\b/;
/** F3 trigger pattern (D-07/G4's own wording). Requires a capital-`I` "Id"/"Ids" suffix — matches
 * `employeeId`, `employeeIds`, `leaveTypeId`, `tenantId`; does NOT match lowercase `id`. */
const ID_PARAM_RE = /^[a-zA-Z]*Ids?$/;
/** Never triggers F3, even though only `tenantId` would match `ID_PARAM_RE` anyway — `id` is
 * listed explicitly per the plan's own wording ("a bare id ... include it") so a future
 * case-insensitive tweak to `ID_PARAM_RE` cannot silently start flagging it. */
const F3_EXEMPT_NAMES = new Set(["tenantId", "id"]);

export const MIN_REASON_LENGTH = 30;

// ── Discovery ─────────────────────────────────────────────────────────────────────────────────

function walkFacadeDir(absDir: string, apiSrcRoot: string, out: Set<string>): void {
  for (const entry of readdirSync(absDir)) {
    const full = join(absDir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "__tests__") continue;
      walkFacadeDir(full, apiSrcRoot, out);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    const repoRelative = join("apps/api/src", relative(apiSrcRoot, full)).split(sep).join("/");
    out.add(repoRelative);
  }
}

/**
 * `apps/api/src/contexts/*\/facade/**\/*.ts` (skip `__tests__`, skip `*.test.ts`) UNION
 * `knownFiles`. Sorted, deduplicated. `knownFiles` defaults to `KNOWN_FACADE_FILES`; the CLI never
 * overrides it — the parameter exists solely so `__tests__` can exercise the zero-file guard
 * against a fixture tree without `KNOWN_FACADE_FILES` seeding it artificially.
 */
export function discoverFacadeFiles(
  repoRoot: string,
  knownFiles: readonly string[] = KNOWN_FACADE_FILES,
): string[] {
  const apiSrcRoot = join(repoRoot, "apps/api/src");
  const found = new Set<string>();

  const contextsRoot = join(apiSrcRoot, "contexts");
  if (existsSync(contextsRoot)) {
    for (const contextName of readdirSync(contextsRoot)) {
      const facadeDir = join(contextsRoot, contextName, "facade");
      if (existsSync(facadeDir) && statSync(facadeDir).isDirectory()) {
        walkFacadeDir(facadeDir, apiSrcRoot, found);
      }
    }
  }

  for (const known of knownFiles) {
    const abs = join(repoRoot, known);
    if (!existsSync(abs)) {
      throw new Error(
        `lint-facade-signatures: KNOWN_FACADE_FILES entry "${known}" does not exist on disk — fix ` +
          `it in apps/api/scripts/lint-facade-signatures.ts.`,
      );
    }
    found.add(known);
  }

  return [...found].sort();
}

// ── AST analysis (pure — no file I/O beyond `analyzeFile`'s own read) ────────────────────────────

export type FacadeViolation = { rule: FacadeRule; message: string };

export type ExportedFacadeFunction = {
  file: string; // repo-relative
  functionName: string;
  line: number; // 1-based, of the function's name
  violations: FacadeViolation[];
};

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function paramName(p: ts.ParameterDeclaration): string | null {
  return ts.isIdentifier(p.name) ? p.name.text : null;
}

function paramTypeText(p: ts.ParameterDeclaration, sourceFile: ts.SourceFile): string | null {
  return p.type ? p.type.getText(sourceFile) : null;
}

function checkF1(
  params: readonly ts.ParameterDeclaration[],
  sourceFile: ts.SourceFile,
): FacadeViolation | null {
  const first = params[0];
  if (!first) {
    return {
      rule: "F1",
      message:
        "Exported facade function declares no parameters — the first parameter must be " +
        "db: Prisma.TransactionClient (D-07).",
    };
  }
  const name = paramName(first);
  const typeText = paramTypeText(first, sourceFile);
  if (name !== REQUIRED_FIRST_PARAM_NAME || typeText !== TRANSACTION_CLIENT_TYPE) {
    const found = `${name ?? "<destructured>"}${typeText ? `: ${typeText}` : " (no type annotation)"}`;
    return {
      rule: "F1",
      message: `First parameter must be "db: Prisma.TransactionClient" (D-07); found "${found}".`,
    };
  }
  return null;
}

function checkF2(
  params: readonly ts.ParameterDeclaration[],
  sourceFile: ts.SourceFile,
): FacadeViolation[] {
  const violations: FacadeViolation[] = [];
  for (const p of params) {
    const typeText = paramTypeText(p, sourceFile);
    if (!typeText) continue;
    const match = FASTIFY_TYPE_RE.exec(typeText);
    if (match) {
      const typeName = `Fastify${match[1]}`;
      violations.push({
        rule: "F2",
        message:
          `Parameter "${paramName(p) ?? "<destructured>"}" takes ${typeName}; a write through ` +
          `app.prisma leaves the caller's $transaction silently and survives a rollback (R1).`,
      });
    }
  }
  return violations;
}

function checkF3(params: readonly ts.ParameterDeclaration[]): FacadeViolation | null {
  const names = params.map(paramName).filter((n): n is string => n !== null);
  const triggers = names.filter((n) => ID_PARAM_RE.test(n) && !F3_EXEMPT_NAMES.has(n));
  if (triggers.length === 0) return null;
  if (names.includes("tenantId")) return null;
  return {
    rule: "F3",
    message:
      `Parameter(s) "${triggers.join(", ")}" imply a client-supplied identifier but no ` +
      `"tenantId" parameter is declared (G4) — the tenant-scoping gate can no longer see this ` +
      `call once it moves behind a facade.`,
  };
}

/** Every EXPORTED function declaration in `sourceText`, with its F1/F2/F3 violations (possibly
 * empty). Non-exported functions are not returned at all — they are out of scope entirely, not
 * merely violation-free. Pure function of the text; no file I/O, so `__tests__` drives this
 * directly against fixture strings. */
export function analyzeSource(
  sourceText: string,
  repoRelativePath: string,
): ExportedFacadeFunction[] {
  const sourceFile = ts.createSourceFile(
    repoRelativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const results: ExportedFacadeFunction[] = [];

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name && hasExportModifier(node)) {
      const line =
        sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile)).line + 1;
      const violations: FacadeViolation[] = [];
      const f1 = checkF1(node.parameters, sourceFile);
      if (f1) violations.push(f1);
      violations.push(...checkF2(node.parameters, sourceFile));
      const f3 = checkF3(node.parameters);
      if (f3) violations.push(f3);
      results.push({ file: repoRelativePath, functionName: node.name.text, line, violations });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

export function analyzeFile(absPath: string, repoRelativePath: string): ExportedFacadeFunction[] {
  return analyzeSource(readFileSync(absPath, "utf8"), repoRelativePath);
}

// ── Exceptions ────────────────────────────────────────────────────────────────────────────────

export type FacadeSignatureException = {
  file: string;
  function: string;
  rules: FacadeRule[];
  reason: string;
};

const VALID_RULES: readonly FacadeRule[] = ["F1", "F2", "F3"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structurally and semantically validates a raw (untyped) exceptions payload against the CURRENT
 * function/violation set. An entry naming a function that no longer exists, or a rule that
 * function no longer violates, is a HARD ERROR (mirrors `lint-tenant-scoping-exceptions.ts`'s
 * `validateExceptions` — a stale entry is a blanket allow waiting to happen, not a passive record).
 */
export function validateExceptionsDocument(
  raw: unknown,
  functions: readonly ExportedFacadeFunction[],
): { ok: true; entries: FacadeSignatureException[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      errors: [`${EXCEPTIONS_FILE} must contain a JSON array of exception entries`],
    };
  }

  const errors: string[] = [];
  const valid: FacadeSignatureException[] = [];

  raw.forEach((entryRaw: unknown, index: number) => {
    const label = `entry #${index}`;
    if (!isRecord(entryRaw)) {
      errors.push(`${label}: entry is not an object`);
      return;
    }
    const { file, function: fnName, rules, reason } = entryRaw;

    if (typeof file !== "string" || file.length === 0) {
      errors.push(`${label}: missing or invalid 'file' (repo-relative path expected)`);
      return;
    }
    if (file.includes("__tests__")) {
      errors.push(`${label}: 'file' is under __tests__ — a test fixture needs no exception`);
      return;
    }
    if (typeof fnName !== "string" || fnName.length === 0) {
      errors.push(`${label} (${file}): missing or invalid 'function'`);
      return;
    }
    if (
      !Array.isArray(rules) ||
      rules.length === 0 ||
      rules.some((r: unknown) => typeof r !== "string" || !VALID_RULES.includes(r as FacadeRule))
    ) {
      errors.push(
        `${label} (${file}#${fnName}): 'rules' must be a non-empty array drawn from ` +
          `${JSON.stringify(VALID_RULES)}`,
      );
      return;
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      errors.push(`${label} (${file}#${fnName}): missing 'reason' — every exception MUST say WHY`);
      return;
    }
    if (reason.trim().length < MIN_REASON_LENGTH) {
      errors.push(
        `${label} (${file}#${fnName}): 'reason' is only ${reason.trim().length} character(s) — ` +
          `must read as a sentence, not a label (minimum ${MIN_REASON_LENGTH})`,
      );
      return;
    }

    const match = functions.find((f) => f.file === file && f.functionName === fnName);
    if (!match) {
      errors.push(
        `${label} (${file}#${fnName}): STALE — no such exported facade function exists any more ` +
          `(moved, renamed, or removed) — update or remove this entry`,
      );
      return;
    }
    const currentRuleSet = new Set(match.violations.map((v) => v.rule));
    const staleRules = (rules as string[]).filter((r) => !currentRuleSet.has(r as FacadeRule));
    if (staleRules.length > 0) {
      errors.push(
        `${label} (${file}#${fnName}): STALE — no longer violates ${staleRules.join(", ")}; ` +
          `remove the stale rule(s) from 'rules' (or the whole entry if none remain) — a stale ` +
          `entry is a blanket allow waiting to happen`,
      );
      return;
    }

    valid.push({ file, function: fnName, rules: rules as FacadeRule[], reason: reason.trim() });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entries: valid };
}

// ── Findings ──────────────────────────────────────────────────────────────────────────────────

export type Finding = {
  file: string;
  line: number;
  functionName: string;
  rule: FacadeRule;
  message: string;
};

/** Every violation NOT covered by a named exception entry (file + function + rule match). */
export function computeFindings(
  functions: readonly ExportedFacadeFunction[],
  exceptions: readonly FacadeSignatureException[],
): Finding[] {
  const findings: Finding[] = [];
  for (const fn of functions) {
    const exception = exceptions.find((e) => e.file === fn.file && e.function === fn.functionName);
    for (const v of fn.violations) {
      if (exception && exception.rules.includes(v.rule)) continue;
      findings.push({
        file: fn.file,
        line: fn.line,
        functionName: fn.functionName,
        rule: v.rule,
        message: v.message,
      });
    }
  }
  return findings;
}

export function formatSummary(
  totalChecked: number,
  exceptionsApplied: number,
  findingsCount: number,
): string {
  return (
    `[lint:facade-signatures] ${totalChecked} exported facade function(s) checked, ` +
    `${exceptionsApplied} exception(s) applied, ${findingsCount} finding(s).`
  );
}

// ── CLI entry point ───────────────────────────────────────────────────────────────────────────

export function run(repoRoot: string): number {
  let files: string[];
  try {
    files = discoverFacadeFiles(repoRoot);
  } catch (err) {
    console.error(`lint-facade-signatures: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // Zero-file guard (#229): a linter that walks zero files and reports OK is not "all clean" — it
  // is a defect. KNOWN_FACADE_FILES keeps this from being true today; if it were ever emptied
  // without a real facade/ directory existing yet, this must fail loudly, not silently pass.
  if (files.length === 0) {
    console.error(
      "lint-facade-signatures: 0 facade file(s) found under apps/api/src/contexts/*/facade/ and " +
        "KNOWN_FACADE_FILES is empty. A linter that walks zero files and reports OK is #229 " +
        "verbatim — add a real facade/ file or restore a KNOWN_FACADE_FILES entry.",
    );
    return 1;
  }

  const functions = files.flatMap((relFile) => analyzeFile(join(repoRoot, relFile), relFile));

  const exceptionsAbsPath = join(repoRoot, EXCEPTIONS_FILE);
  const rawExceptions: unknown = existsSync(exceptionsAbsPath)
    ? JSON.parse(readFileSync(exceptionsAbsPath, "utf8"))
    : [];
  const validated = validateExceptionsDocument(rawExceptions, functions);
  if (!validated.ok) {
    console.error(`lint-facade-signatures: ${EXCEPTIONS_FILE} is invalid:`);
    for (const e of validated.errors) console.error(`  - ${e}`);
    return 1;
  }

  const findings = computeFindings(functions, validated.entries);
  console.log(formatSummary(functions.length, validated.entries.length, findings.length));

  if (findings.length > 0) {
    console.error("");
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line} ${f.functionName} [${f.rule}] ${f.message}`);
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
