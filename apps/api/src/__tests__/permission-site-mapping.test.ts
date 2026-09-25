/**
 * Completeness guard: every permission check in `apps/api/src` is mapped in `docs/permissions.md`
 * (issue #72, AK-72-6, phase 72b decisions D-09..D-11/D-16; final form: phase 75b, issue #75,
 * D-18, AC-75-1).
 *
 * Since #75 every access decision asks for a permission from the catalog in
 * `contexts/platform/permission-catalog.ts`. The removed role guard is no longer this file's job —
 * `apps/api/scripts/lint-role-checks.ts` (D-19) fails on any call of it and on any role comparison
 * outside `contexts/platform/compat-role.ts`. This test keeps the checked-in mapping true against
 * the source tree, in two ways.
 *
 * 1. Per-file COUNTS. Three detectors run over every non-test `.ts` file under `apps/api/src`
 *    (comment lines skipped; a line counts once):
 *    - `GUARD_DETECTOR` finds each call of the route guards `requirePermission(` /
 *      `requireAnyPermission(` (their own definitions excluded); each hit must have one row in
 *      the section named by `GUARD_HEADING`.
 *    - `HANDLER_DETECTOR` finds each handler check `hasPermission(` / `permissionReach(` and,
 *      deliberately broad, any line that reads `user.role` or compares `role`; each hit must have
 *      one row in either the `HANDLER_HEADING` section (an access decision) or the
 *      `EXCLUDED_HEADING` section (a hit that decides nothing, with a reason). A role read that
 *      comes back therefore has to be classified here even where `lint:role-checks` cannot see it.
 *    - `RECIPIENT_DETECTOR` finds each call of the notification-recipient facade
 *      `userIdsHoldingPermission(`; each hit must have one row in `RECIPIENT_HEADING` (D-16/D-17).
 *
 * 2. Per-file PERMISSION-KEY MULTISETS (D-18). Counts alone miss a check that moved to a different
 *    permission. The TypeScript AST of every file yields, per call of the five helpers, the
 *    `resource:action` it asks for (from its string-literal key: `requirePermission`,
 *    `hasPermission`, `userIdsHoldingPermission` — the full key; `permissionReach` — its
 *    `resource:action` argument; `requireAnyPermission` — the distinct `resource:action` of its
 *    keys, which must be exactly one, since one doc row maps one call). Per file and per section,
 *    that multiset must equal the multiset of the Permission column of the file's rows — so
 *    swapping `shift:read` for `shift:plan` turns this red even when every count still matches.
 *    A helper call whose key is not a string literal is only allowed in the module that DEFINES
 *    the helpers (the implementation, whose lines stand under "Nicht gezählte Treffer"); anywhere
 *    else it fails, because its permission could not be checked against the doc.
 *
 * Why counts and multisets, never line numbers: a fail-closed list pinned to line numbers goes
 * stale through unrelated edits in the same file (#309/#310 turned a branch red twice that way).
 * Line numbers in the doc are evidence against the commit named in its header, not an address.
 *
 * Known limits (accepted, see threat T-72b-09):
 * - Moving a check from one route to another inside the same file without changing its count or
 *   its permission is not detected.
 * - The reach part of a key (`EIGENE` / `ZUGEWIESEN`) is checked against the catalog, not against
 *   the individual call; which reach a site grants is the matrix's job
 *   (`permission-neutrality-matrix.test.ts`).
 * - A role read in a shape the handler detector does not match — e.g. a destructured role
 *   compared through `.includes(...)` — is invisible here; `lint:role-checks` covers most such
 *   shapes by AST and names its own blind spots.
 *
 * Two more guards hold the descriptive half of the doc to the catalog (AK-72-8, D-12, D-15):
 * - The section named by `PERMISSIONS_HEADING` has exactly one row per catalog permission — full key
 *   `resource:action:REACH` plus two non-trivial text cells (what it allows, what it explicitly does
 *   not) — and no row for a key the catalog lacks. Both directions: a permission added to the
 *   catalog without a description turns this red, and so does a description left behind for a
 *   permission that was removed.
 * - The section named by `RESOURCES_HEADING` lists every catalog resource exactly once, with the
 *   relation the catalog gives it.
 *
 * When this is red: update `docs/permissions.md` — add, remove or reclassify the row for the site
 * or permission the failure names, in the section it names. Never loosen a detector or a parser to
 * make it green.
 *
 * DB-free: no Prisma, no app build.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import * as ts from "typescript";
import { describe, it, expect } from "vitest";
import {
  PERMISSIONS,
  PERMISSION_REACHES,
  PERMISSION_RESOURCES,
  permissionKey,
} from "../contexts/platform";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SRC_ROOT = join(REPO_ROOT, "apps", "api", "src");
const DOC_PATH = join(REPO_ROOT, "docs", "permissions.md");
const DOC_NAME = "docs/permissions.md";
const EXCLUDE_DIRS = new Set(["__tests__", "node_modules", "dist"]);

/**
 * The route guards (D-18). The removed role guard is not matched any more: a call of it is
 * `lint:role-checks`' finding, not an unmapped site.
 */
const GUARD_DETECTOR = /\brequirePermission\(|\brequireAnyPermission\(/;
/** The guards' own definition lines — never a call site. */
const GUARD_DEFINITION_MARKERS = [
  "export function requirePermission",
  "export function requireAnyPermission",
];
/**
 * The handler checks, plus — deliberately broad — every role read or comparison, so a role read
 * that comes back must be classified (as a check, or under "Nicht gezählte Treffer").
 */
const HANDLER_DETECTOR = /\buser\.role\b|\brole\s*[!=]==|\bhasPermission\(|\bpermissionReach\(/;
/** The checks' own definition lines — never a handler check. */
const HANDLER_DEFINITION_MARKERS = [
  "export async function hasPermission",
  "export async function permissionReach",
];
/** Phase 75b Plan 10 (#75), D-16: every call of the notification-recipient facade. */
const RECIPIENT_DETECTOR = /\buserIdsHoldingPermission\(/;
/** The facade's own definition line — never a call site. */
const RECIPIENT_DEFINITION_MARKERS = ["export async function userIdsHoldingPermission"];

type SiteSection = "guard" | "handler" | "recipient";

/**
 * Which doc section maps a call of each helper (key multisets, D-18). A Map, not an object
 * literal: a lookup by an arbitrary callee name must not hit `Object.prototype` (`toString`).
 */
const HELPER_SECTION: ReadonlyMap<string, SiteSection> = new Map([
  ["requirePermission", "guard"],
  ["requireAnyPermission", "guard"],
  ["hasPermission", "handler"],
  ["permissionReach", "handler"],
  ["userIdsHoldingPermission", "recipient"],
]);
/** A key literal: `resource:action`, optionally with `:REACH`. */
const KEY_LITERAL = /^([a-z0-9-]+:[a-z0-9-]+)(?::(?:EIGENE|ZUGEWIESEN))?$/;

const GUARD_HEADING = "## Aufrufstellen der Permission-Guards";
const HANDLER_HEADING = "## Handler-Prüfungen";
const RECIPIENT_HEADING = "## Empfängersuchen";
const EXCLUDED_HEADING = "## Nicht gezählte Treffer";
const RESOURCES_HEADING = "## Ressourcen";
const PERMISSIONS_HEADING = "## Permissions";

const STELLE_FORMAT = /^`([^`\s]+\.ts):(\d+)`$/;
const PERMISSION_FORMAT = /^`([a-z0-9-]+):([a-z0-9-]+)`$/;
const REACH_TOKEN = /[A-Z][A-Z_]+/g;
const MIN_REASON_LENGTH = 10;
const PERMISSION_KEY_FORMAT = /^`([a-z0-9-]+:[a-z0-9-]+:(?:EIGENE|ZUGEWIESEN))`$/;
const RESOURCE_KEY_FORMAT = /^`([a-z0-9-]+)`$/;
const MIN_DESCRIPTION_LENGTH = 10;
const PLACEHOLDER_TEXT = /\b(?:TODO|TBD|FIXME|XXX|Platzhalter)\b/i;
/** The doc's relation labels, mapped onto the catalog's `relation` values. */
const RELATION_LABELS: Record<string, string> = { Person: "PERSON", Mandant: "MANDANT" };

// ── Source side ──────────────────────────────────────────────────────────────

function collectSourceFiles(): string[] {
  const out: string[] = [];
  function walk(absDir: string) {
    for (const entry of readdirSync(absDir)) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      const abs = join(absDir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts")) out.push(abs);
    }
  }
  walk(SRC_ROOT);
  return out;
}

function srcRel(absPath: string): string {
  return relative(SRC_ROOT, absPath).split("\\").join("/");
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*");
}

function isGuardHit(line: string): boolean {
  return (
    GUARD_DETECTOR.test(line) && !GUARD_DEFINITION_MARKERS.some((marker) => line.includes(marker))
  );
}

function isHandlerHit(line: string): boolean {
  return (
    HANDLER_DETECTOR.test(line) &&
    !HANDLER_DEFINITION_MARKERS.some((marker) => line.includes(marker))
  );
}

function isRecipientHit(line: string): boolean {
  return (
    RECIPIENT_DETECTOR.test(line) &&
    !RECIPIENT_DEFINITION_MARKERS.some((marker) => line.includes(marker))
  );
}

/** Matching LINES per file (a line counts once even if the pattern occurs twice on it). */
function countPerFile(files: string[], isHit: (line: string) => boolean): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    let n = 0;
    for (const line of lines) {
      if (isCommentLine(line)) continue;
      if (isHit(line)) n++;
    }
    if (n > 0) counts.set(srcRel(file), n);
  }
  return counts;
}

function total(counts: Map<string, number>): number {
  let sum = 0;
  for (const n of counts.values()) sum += n;
  return sum;
}

// ── Source side: the permission each call asks for (AST, D-18) ───────────────

interface KeyedCall {
  file: string;
  line: number;
  helper: string;
  section: SiteSection;
  /** The `resource:action` this call asks for, or null when no key is a string literal. */
  permission: string | null;
  /** Set when the call's keys cannot be mapped to exactly one doc row. */
  problem?: string;
}

/** Whether the file DEFINES one of the helpers (the implementation module, not a call site). */
function definesHelper(text: string): boolean {
  return [
    ...GUARD_DEFINITION_MARKERS,
    ...HANDLER_DEFINITION_MARKERS,
    ...RECIPIENT_DEFINITION_MARKERS,
  ].some((marker) => text.includes(marker));
}

function literalText(node: ts.Expression): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

/** Every call of the five permission helpers in one file, with the permission it asks for. */
function keyedCalls(file: string, text: string): KeyedCall[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: KeyedCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const helper = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      const section = HELPER_SECTION.get(helper);
      if (section !== undefined) {
        const line = sf.getLineAndCharacterOfPosition(callee.getStart(sf)).line + 1;
        const literals = node.arguments.map(literalText).filter((t): t is string => t !== null);
        const permissions = [
          ...new Set(literals.map((t) => KEY_LITERAL.exec(t)?.[1]).filter((p): p is string => !!p)),
        ];
        const call: KeyedCall = { file, line, helper, section, permission: permissions[0] ?? null };
        if (permissions.length > 1) {
          call.problem = `${helper} asks for ${permissions.join(" and ")} — one doc row maps one permission; split the call`;
        } else if (literals.length > 0 && permissions.length === 0) {
          call.problem = `${helper} has a string key that is not a resource:action[:REACH] literal`;
        }
        calls.push(call);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

function collectKeyedCalls(files: string[]): { calls: KeyedCall[]; implementationFiles: string[] } {
  const calls: KeyedCall[] = [];
  const implementationFiles: string[] = [];
  for (const abs of files) {
    const text = readFileSync(abs, "utf8");
    const file = srcRel(abs);
    if (definesHelper(text)) implementationFiles.push(file);
    calls.push(...keyedCalls(file, text));
  }
  return { calls, implementationFiles };
}

/** `resource:action` → count, per file. */
function multisetPerFile(
  entries: { file: string; permission: string }[],
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const { file, permission } of entries) {
    let perFile = out.get(file);
    if (!perFile) {
      perFile = new Map();
      out.set(file, perFile);
    }
    perFile.set(permission, (perFile.get(permission) ?? 0) + 1);
  }
  return out;
}

function renderMultiset(m: Map<string, number> | undefined): string {
  if (!m || m.size === 0) return "{}";
  const parts = [...m.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, n]) => `${k} x${n}`);
  return `{ ${parts.join(", ")} }`;
}

function compareMultisets(
  source: Map<string, Map<string, number>>,
  doc: Map<string, Map<string, number>>,
  section: string,
): string[] {
  const files = [...new Set([...source.keys(), ...doc.keys()])].sort();
  const mismatches: string[] = [];
  for (const file of files) {
    const s = renderMultiset(source.get(file));
    const d = renderMultiset(doc.get(file));
    if (s !== d) {
      mismatches.push(`${file}: source asks for ${s}, ${DOC_NAME} § ${section} maps ${d}`);
    }
  }
  return mismatches;
}

// ── Doc side ─────────────────────────────────────────────────────────────────

interface DocRow {
  heading: string;
  raw: string;
  cells: string[];
}

interface SiteRow {
  heading: string;
  file: string;
  line: number;
  resource: string;
  action: string;
  reaches: string[];
}

interface ExcludedRow {
  heading: string;
  file: string;
  line: number;
}

function readDoc(): string {
  return readFileSync(DOC_PATH, "utf8");
}

function headingOccurrences(doc: string, heading: string): number {
  return doc.split("\n").filter((l) => l.trimEnd() === heading).length;
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function splitCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

/** Data rows of the table(s) in one level-2 section; separator rows and their header rows dropped. */
function readSectionRows(doc: string, heading: string): DocRow[] {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  if (start === -1) return [];
  const tableLines: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) break;
    if (lines[i].trim().startsWith("|")) tableLines.push(lines[i]);
  }
  const drop = new Set<number>();
  tableLines.forEach((line, idx) => {
    if (isSeparatorRow(splitCells(line))) {
      drop.add(idx);
      if (idx > 0) drop.add(idx - 1);
    }
  });
  return tableLines
    .filter((_, idx) => !drop.has(idx))
    .map((raw) => ({ heading, raw, cells: splitCells(raw) }));
}

function parseStelle(cell: string): { file: string; line: number } | null {
  const m = STELLE_FORMAT.exec(cell);
  return m ? { file: m[1], line: Number(m[2]) } : null;
}

function parseSiteRow(row: DocRow): SiteRow | string {
  const where = `${DOC_NAME} § ${row.heading}: ${row.raw}`;
  if (row.cells.length !== 5) return `${where} — expected 5 cells, got ${row.cells.length}`;
  const [stelle, route, heute, permission, reichweite] = row.cells;
  const site = parseStelle(stelle);
  if (!site) return `${where} — Stelle is not a backticked path.ts:LINE`;
  if (route === "") return `${where} — Route is empty`;
  if (heute === "") return `${where} — heute is empty`;
  const perm = PERMISSION_FORMAT.exec(permission);
  if (!perm) return `${where} — Permission is not a backticked resource:action`;
  const reaches = reichweite.match(REACH_TOKEN) ?? [];
  if (reaches.length === 0) return `${where} — Reichweite names no reach value`;
  return { heading: row.heading, ...site, resource: perm[1], action: perm[2], reaches };
}

function parseExcludedRow(row: DocRow): ExcludedRow | string {
  const where = `${DOC_NAME} § ${row.heading}: ${row.raw}`;
  if (row.cells.length !== 2) return `${where} — expected 2 cells, got ${row.cells.length}`;
  const [stelle, grund] = row.cells;
  const site = parseStelle(stelle);
  if (!site) return `${where} — Stelle is not a backticked path.ts:LINE`;
  if (grund.length < MIN_REASON_LENGTH) {
    return `${where} — Grund shorter than ${MIN_REASON_LENGTH} characters`;
  }
  return { heading: row.heading, ...site };
}

interface PermissionRow {
  key: string;
}

interface ResourceRow {
  key: string;
  relation: string;
}

function checkDescriptionCell(where: string, name: string, cell: string): string | null {
  if (cell.length < MIN_DESCRIPTION_LENGTH) {
    return `${where} — ${name} shorter than ${MIN_DESCRIPTION_LENGTH} characters`;
  }
  if (PLACEHOLDER_TEXT.test(cell)) return `${where} — ${name} is placeholder text`;
  return null;
}

function parsePermissionRow(row: DocRow): PermissionRow | string {
  const where = `${DOC_NAME} § ${row.heading}: ${row.raw}`;
  if (row.cells.length !== 3) return `${where} — expected 3 cells, got ${row.cells.length}`;
  const [permission, allowed, notAllowed] = row.cells;
  const key = PERMISSION_KEY_FORMAT.exec(permission);
  if (!key) return `${where} — Permission is not a backticked resource:action:REACH`;
  const error =
    checkDescriptionCell(where, "the allowed cell", allowed) ??
    checkDescriptionCell(where, "the explicitly-not-allowed cell", notAllowed);
  return error ?? { key: key[1] };
}

function parseResourceRow(row: DocRow): ResourceRow | string {
  const where = `${DOC_NAME} § ${row.heading}: ${row.raw}`;
  if (row.cells.length !== 4) return `${where} — expected 4 cells, got ${row.cells.length}`;
  const [resource, context, relation, content] = row.cells;
  const key = RESOURCE_KEY_FORMAT.exec(resource);
  if (!key) return `${where} — Ressource is not a backticked resource key`;
  if (context === "") return `${where} — Kontext is empty`;
  const mapped = RELATION_LABELS[relation];
  if (mapped === undefined) {
    return `${where} — Bezug is "${relation}", expected one of ${Object.keys(RELATION_LABELS).join(", ")}`;
  }
  if (content.length < MIN_DESCRIPTION_LENGTH) {
    return `${where} — Inhalt shorter than ${MIN_DESCRIPTION_LENGTH} characters`;
  }
  return { key: key[1], relation: mapped };
}

function parsedPermissionRows(doc: string): PermissionRow[] {
  return readSectionRows(doc, PERMISSIONS_HEADING)
    .map(parsePermissionRow)
    .filter((r): r is PermissionRow => typeof r !== "string");
}

function parsedResourceRows(doc: string): ResourceRow[] {
  return readSectionRows(doc, RESOURCES_HEADING)
    .map(parseResourceRow)
    .filter((r): r is ResourceRow => typeof r !== "string");
}

/** Keys missing from `rows`, keys occurring more than once, and keys not in `expected`. */
function compareKeySets(
  expected: readonly string[],
  rows: readonly string[],
): { missing: string[]; duplicate: string[]; extra: string[] } {
  const want = new Set(expected);
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const key of rows) {
    if (seen.has(key)) duplicate.add(key);
    seen.add(key);
  }
  return {
    missing: expected.filter((k) => !seen.has(k)),
    duplicate: [...duplicate].sort(),
    extra: [...seen].filter((k) => !want.has(k)).sort(),
  };
}

function parsedSiteRows(doc: string, heading: string): SiteRow[] {
  return readSectionRows(doc, heading)
    .map(parseSiteRow)
    .filter((r): r is SiteRow => typeof r !== "string");
}

function parsedExcludedRows(doc: string): ExcludedRow[] {
  return readSectionRows(doc, EXCLUDED_HEADING)
    .map(parseExcludedRow)
    .filter((r): r is ExcludedRow => typeof r !== "string");
}

function countRowsPerFile(rows: { file: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.file, (counts.get(r.file) ?? 0) + 1);
  return counts;
}

function compareCounts(
  source: Map<string, number>,
  doc: Map<string, number>,
  what: string,
  sections: string,
): string[] {
  const files = [...new Set([...source.keys(), ...doc.keys()])].sort();
  const mismatches: string[] = [];
  for (const file of files) {
    const s = source.get(file) ?? 0;
    const d = doc.get(file) ?? 0;
    if (s !== d) {
      mismatches.push(
        `${file}: ${s} ${what} hits in the source, ${d} rows in ${DOC_NAME} § ${sections}`,
      );
    }
  }
  return mismatches;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("permission site mapping — docs/permissions.md against apps/api/src (issues #72, #75)", () => {
  it("the source walk is non-empty and every detector finds hits (D-11)", () => {
    const files = collectSourceFiles();
    expect(
      files.length,
      "no .ts file found under apps/api/src — the source root moved or the walker is broken",
    ).toBeGreaterThan(0);
    expect(
      total(countPerFile(files, isGuardHit)),
      "GUARD_DETECTOR found nothing — the permission guards were renamed; update the detector",
    ).toBeGreaterThan(0);
    expect(
      total(countPerFile(files, isHandlerHit)),
      "HANDLER_DETECTOR found nothing — the handler checks were renamed; update the detector",
    ).toBeGreaterThan(0);
    expect(
      total(countPerFile(files, isRecipientHit)),
      "RECIPIENT_DETECTOR found nothing — userIdsHoldingPermission was renamed; update the detector",
    ).toBeGreaterThan(0);
  });

  it("every data row of the site, resource and permission sections parses (D-15, D-16)", () => {
    const doc = readDoc();
    const errors: string[] = [];
    const parsers: [string, (row: DocRow) => object | string][] = [
      [RESOURCES_HEADING, parseResourceRow],
      [PERMISSIONS_HEADING, parsePermissionRow],
      [GUARD_HEADING, parseSiteRow],
      [HANDLER_HEADING, parseSiteRow],
      [RECIPIENT_HEADING, parseSiteRow],
      [EXCLUDED_HEADING, parseExcludedRow],
    ];
    for (const [heading, parse] of parsers) {
      const n = headingOccurrences(doc, heading);
      if (n !== 1) errors.push(`${DOC_NAME}: heading "${heading}" occurs ${n} times, expected 1`);
      const rows = readSectionRows(doc, heading);
      if (rows.length === 0) errors.push(`${DOC_NAME} § ${heading}: no data rows`);
      for (const row of rows) {
        const parsed = parse(row);
        if (typeof parsed === "string") errors.push(parsed);
      }
    }
    expect(errors, `unparseable rows in ${DOC_NAME} — fix the row format`).toEqual([]);
  });

  it("guards: per-file source count equals the doc row count, both directions (D-10, D-18)", () => {
    const files = collectSourceFiles();
    expect(files.length, "no .ts file found under apps/api/src").toBeGreaterThan(0);
    const source = countPerFile(files, isGuardHit);
    const doc = countRowsPerFile(parsedSiteRows(readDoc(), GUARD_HEADING));
    expect(
      compareCounts(source, doc, "permission-guard", GUARD_HEADING.replace(/^## /, "")),
      `a permission guard call site was added or removed — update ${DOC_NAME}`,
    ).toEqual([]);
  });

  it("handler detector: per-file source count equals handler rows plus excluded rows, both directions (D-10)", () => {
    const files = collectSourceFiles();
    expect(files.length, "no .ts file found under apps/api/src").toBeGreaterThan(0);
    const source = countPerFile(files, isHandlerHit);
    const text = readDoc();
    const doc = countRowsPerFile([
      ...parsedSiteRows(text, HANDLER_HEADING),
      ...parsedExcludedRows(text),
    ]);
    const sections = `${HANDLER_HEADING.replace(/^## /, "")} + ${EXCLUDED_HEADING.replace(/^## /, "")}`;
    expect(
      compareCounts(source, doc, "role-check", sections),
      `a role check was added or removed — classify it in ${DOC_NAME}`,
    ).toEqual([]);
  });

  it("recipient: per-file source count equals the doc row count, both directions (D-16)", () => {
    const files = collectSourceFiles();
    expect(files.length, "no .ts file found under apps/api/src").toBeGreaterThan(0);
    const source = countPerFile(files, isRecipientHit);
    const doc = countRowsPerFile(parsedSiteRows(readDoc(), RECIPIENT_HEADING));
    expect(
      compareCounts(source, doc, "userIdsHoldingPermission", RECIPIENT_HEADING.replace(/^## /, "")),
      `a notification-recipient call site was added or removed — update ${DOC_NAME}`,
    ).toEqual([]);
  });

  it("every Datei:Zeile occurs at most once across the four site sections", () => {
    const text = readDoc();
    const all = [
      ...parsedSiteRows(text, GUARD_HEADING),
      ...parsedSiteRows(text, HANDLER_HEADING),
      ...parsedSiteRows(text, RECIPIENT_HEADING),
      ...parsedExcludedRows(text),
    ];
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const row of all) {
      const key = `${row.file}:${row.line}`;
      const first = seen.get(key);
      if (first !== undefined) {
        duplicates.push(
          `${key}: in § ${first.replace(/^## /, "")} and § ${row.heading.replace(/^## /, "")}`,
        );
      } else {
        seen.set(key, row.heading);
      }
    }
    expect(duplicates, `duplicate site rows in ${DOC_NAME}`).toEqual([]);
  });

  it("every site row names a catalog permission for each reach it lists (D-10, D-16)", () => {
    const text = readDoc();
    const known = new Set<string>(PERMISSIONS.map(permissionKey));
    const reaches = PERMISSION_REACHES as readonly string[];
    const violations: string[] = [];
    for (const row of [
      ...parsedSiteRows(text, GUARD_HEADING),
      ...parsedSiteRows(text, HANDLER_HEADING),
      ...parsedSiteRows(text, RECIPIENT_HEADING),
    ]) {
      for (const reach of row.reaches) {
        const key = `${row.resource}:${row.action}:${reach}`;
        if (!reaches.includes(reach)) {
          violations.push(`${row.file}:${row.line}: reach "${reach}" is not in PERMISSION_REACHES`);
        } else if (!known.has(key)) {
          violations.push(`${row.file}:${row.line}: ${key} is not in PERMISSIONS`);
        }
      }
    }
    expect(
      violations,
      `${DOC_NAME} names a permission the catalog does not have — fix the row or the catalog`,
    ).toEqual([]);
  });

  it("every permission-helper call outside the implementation names its permission as one resource:action literal (D-18)", () => {
    const files = collectSourceFiles();
    expect(files.length, "no .ts file found under apps/api/src").toBeGreaterThan(0);
    const { calls, implementationFiles } = collectKeyedCalls(files);
    expect(
      implementationFiles.length,
      "no file defines the permission helpers — the definition markers are stale; update them",
    ).toBeGreaterThan(0);
    expect(
      calls.filter((c) => c.permission !== null).length,
      "the AST found no permission-helper call with a literal key — the helper names changed; update HELPER_SECTION",
    ).toBeGreaterThan(0);
    const implementation = new Set(implementationFiles);
    const problems = calls
      .filter((c) => !implementation.has(c.file))
      .flatMap((c) =>
        c.problem !== undefined
          ? [`${c.file}:${c.line}: ${c.problem}`]
          : c.permission === null
            ? [
                `${c.file}:${c.line}: ${c.helper} without a string-literal key — the permission cannot be checked against ${DOC_NAME}`,
              ]
            : [],
      );
    expect(problems, "permission-helper calls that cannot be mapped to a doc row").toEqual([]);
  });

  it("per file and per section, the permissions the code asks for equal the doc's Permission column, as multisets (D-18, AC-75-1)", () => {
    const files = collectSourceFiles();
    expect(files.length, "no .ts file found under apps/api/src").toBeGreaterThan(0);
    const { calls, implementationFiles } = collectKeyedCalls(files);
    const implementation = new Set(implementationFiles);
    const text = readDoc();
    const sections: [SiteSection, string][] = [
      ["guard", GUARD_HEADING],
      ["handler", HANDLER_HEADING],
      ["recipient", RECIPIENT_HEADING],
    ];
    const mismatches: string[] = [];
    let compared = 0;
    for (const [section, heading] of sections) {
      const sourceEntries = calls
        .filter((c) => c.section === section && !implementation.has(c.file))
        .filter((c): c is KeyedCall & { permission: string } => c.permission !== null);
      const docEntries = parsedSiteRows(text, heading).map((r) => ({
        file: r.file,
        permission: `${r.resource}:${r.action}`,
      }));
      expect(
        sourceEntries.length,
        `no ${section} call with a literal key found — the AST extraction is broken`,
      ).toBeGreaterThan(0);
      compared += sourceEntries.length;
      mismatches.push(
        ...compareMultisets(
          multisetPerFile(sourceEntries),
          multisetPerFile(docEntries),
          heading.replace(/^## /, ""),
        ),
      );
    }
    expect(compared, "no call compared — the multiset check proved nothing").toBeGreaterThan(100);
    expect(
      mismatches,
      `a check asks for a different permission than ${DOC_NAME} maps — fix the row (or the check)`,
    ).toEqual([]);
  });

  it("every catalog permission has exactly one description row, and every row is a catalog permission (D-12, AK-72-8)", () => {
    expect(
      PERMISSIONS.length,
      "PERMISSIONS is empty — the catalog import is broken",
    ).toBeGreaterThan(0);
    const rows = parsedPermissionRows(readDoc()).map((r) => r.key);
    const result = compareKeySets(PERMISSIONS.map(permissionKey), rows);
    expect(
      result,
      `${DOC_NAME} § ${PERMISSIONS_HEADING.replace(/^## /, "")} is out of step with PERMISSIONS — add the missing description, drop the duplicate, remove the row for a key the catalog lacks`,
    ).toEqual({ missing: [], duplicate: [], extra: [] });
  });

  it("the resource table lists every catalog resource exactly once with the catalog's relation (D-15)", () => {
    const catalog = Object.keys(PERMISSION_RESOURCES);
    expect(
      catalog.length,
      "PERMISSION_RESOURCES is empty — the catalog import is broken",
    ).toBeGreaterThan(0);
    const rows = parsedResourceRows(readDoc());
    const result = compareKeySets(
      catalog,
      rows.map((r) => r.key),
    );
    const resources: Record<string, { relation: string }> = PERMISSION_RESOURCES;
    const wrongRelation = rows
      .filter((r) => resources[r.key] !== undefined && resources[r.key].relation !== r.relation)
      .map((r) => `${r.key}: doc says ${r.relation}, catalog says ${resources[r.key].relation}`);
    expect(
      { ...result, wrongRelation },
      `${DOC_NAME} § ${RESOURCES_HEADING.replace(/^## /, "")} is out of step with PERMISSION_RESOURCES`,
    ).toEqual({ missing: [], duplicate: [], extra: [], wrongRelation: [] });
  });
});
