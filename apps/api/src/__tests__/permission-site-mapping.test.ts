/**
 * Completeness guard: every role check in `apps/api/src` is mapped in `docs/permissions.md`
 * (issue #72, AK-72-6; phase 72b decisions D-09..D-11, D-16).
 *
 * #75 will switch every role check to a permission from the catalog in
 * `contexts/platform/permission-catalog.ts`. That switch can only be rights-neutral if every
 * current check is mapped — so this test keeps the checked-in mapping true against the source tree.
 *
 * Two detectors run over every non-test `.ts` file under `apps/api/src` (comment lines skipped):
 * - `REQUIRE_ROLE_DETECTOR` finds each call of the role guard helper (its own definition excluded);
 *   each hit must have one row in the section named by `REQUIRE_ROLE_HEADING`.
 * - `HANDLER_DETECTOR` finds any line that reads `user.role` or compares `role`; each hit must have
 *   one row in either the `HANDLER_HEADING` section (an access decision) or the `EXCLUDED_HEADING`
 *   section (a hit that decides nothing, with a reason). The detector is deliberately broad: a NEW
 *   role check in any of these shapes turns this test red until someone classifies it.
 *
 * Why per-file COUNTS and not line numbers: a fail-closed list pinned to line numbers goes stale
 * through unrelated edits in the same file (#309/#310 turned a branch red twice that way). An added
 * or removed check changes the count and turns this red; a pure line shift does not. Line numbers
 * in the doc are evidence against the commit named in its header, not an address.
 *
 * Known limits (accepted, see threat T-72b-09):
 * - Moving a check from one route to another inside the same file without changing the count is
 *   not detected.
 * - A role check in a shape neither detector matches — e.g. a destructured role compared through
 *   `.includes(...)` — is invisible. That is why `HANDLER_DETECTOR` is kept broad.
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

const REQUIRE_ROLE_DETECTOR = /requireRole\(/;
const REQUIRE_ROLE_DEFINITION_MARKER = "export function requireRole";
const HANDLER_DETECTOR = /\buser\.role\b|\brole\s*[!=]==/;

const REQUIRE_ROLE_HEADING = "## Aufrufstellen von requireRole";
const HANDLER_HEADING = "## Handler-Prüfungen";
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

function isRequireRoleHit(line: string): boolean {
  return REQUIRE_ROLE_DETECTOR.test(line) && !line.includes(REQUIRE_ROLE_DEFINITION_MARKER);
}

function isHandlerHit(line: string): boolean {
  return HANDLER_DETECTOR.test(line);
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

describe("permission site mapping — docs/permissions.md against apps/api/src (issue #72)", () => {
  it("the source walk is non-empty and both detectors find hits (D-11)", () => {
    const files = collectSourceFiles();
    expect(
      files.length,
      "no .ts file found under apps/api/src — the source root moved or the walker is broken",
    ).toBeGreaterThan(0);
    expect(
      total(countPerFile(files, isRequireRoleHit)),
      "REQUIRE_ROLE_DETECTOR found nothing — the role guard helper was renamed; update the detector",
    ).toBeGreaterThan(0);
    expect(
      total(countPerFile(files, isHandlerHit)),
      "HANDLER_DETECTOR found nothing — the role property was renamed; update the detector",
    ).toBeGreaterThan(0);
  });

  it("every data row of the site, resource and permission sections parses (D-15, D-16)", () => {
    const doc = readDoc();
    const errors: string[] = [];
    const parsers: [string, (row: DocRow) => object | string][] = [
      [RESOURCES_HEADING, parseResourceRow],
      [PERMISSIONS_HEADING, parsePermissionRow],
      [REQUIRE_ROLE_HEADING, parseSiteRow],
      [HANDLER_HEADING, parseSiteRow],
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

  it("requireRole: per-file source count equals the doc row count, both directions (D-10)", () => {
    const files = collectSourceFiles();
    expect(files.length, "no .ts file found under apps/api/src").toBeGreaterThan(0);
    const source = countPerFile(files, isRequireRoleHit);
    const doc = countRowsPerFile(parsedSiteRows(readDoc(), REQUIRE_ROLE_HEADING));
    expect(
      compareCounts(source, doc, "requireRole", REQUIRE_ROLE_HEADING.replace(/^## /, "")),
      `a requireRole call site was added or removed — update ${DOC_NAME}`,
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

  it("every Datei:Zeile occurs at most once across the three site sections", () => {
    const text = readDoc();
    const all = [
      ...parsedSiteRows(text, REQUIRE_ROLE_HEADING),
      ...parsedSiteRows(text, HANDLER_HEADING),
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
      ...parsedSiteRows(text, REQUIRE_ROLE_HEADING),
      ...parsedSiteRows(text, HANDLER_HEADING),
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
