/**
 * lint:api-terms — Issue #861. Fails on a forbidden term in a German text the API SHOWS: error
 * messages, notification texts, e-mail templates, PDF texts and every other German prose literal
 * under apps/api/src.
 *
 * The vocabulary and the address form („du“) live in `docs/glossar.md`; the term list is the one
 * of the web gate (`apps/web/scripts/lint-ui-terms.mjs`, `FORBIDDEN_TERMS`), imported, never
 * copied — only the area scoping of „Mandant“ and „Phorest“ is the API's own (API paths), plus one
 * API-only term: a permission key in a text.
 *
 * What counts as a shown German text: a string or template literal that looks like prose
 * (whitespace and a letter) and reads as German (an umlaut, ß, a German function word or ending),
 * or a one-word German label („Mandanteneinstellungen“). English
 * literals — Swagger `description`/`summary`, log lines — are never read: values of the properties
 * `description` and `summary` are skipped, as are the arguments of `console.*`, `*.log.<level>()`
 * and `logger.<level>()`. Never checked: comments, imports, type positions, test files.
 *
 * Scope: every .ts file under apps/api/src except tests.
 *
 * Exit codes: 0 — no finding · 1 — findings, or nothing was walked.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
// The one term list (#574). The web module is plain ESM; its own imports resolve from apps/web.
import {
  FORBIDDEN_TERMS as WEB_TERMS,
  type ForbiddenTerm,
} from "../../web/scripts/lint-ui-terms.mjs";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIR = "src";

/** Where „Mandant“ may be named: texts of the operator console (the operator is the reader). */
const MANDANT_ALLOWED = [
  "src/contexts/platform/api/operator/",
  "src/contexts/platform/operator-",
  "src/composition/operator-",
];
/** Where „Phorest“ may be named: the integration's own settings and sync (Verwaltung, Schichtplanung). */
const PHOREST_ALLOWED = [
  "src/contexts/platform/permission-labels.ts", // shown only in the role editor under Verwaltung
  "src/services/phorest/",
  "src/utils/duplicate-conflict.ts", // the Phorest mapping's duplicate message, raised in Verwaltung
  "src/contexts/scheduling/",
  "src/contexts/platform/api/operator/",
];
const outside = (areas: string[]) => (file: string) => !areas.some((p) => file.startsWith(p));

export type Term = ForbiddenTerm;

export const FORBIDDEN_TERMS: Term[] = [
  ...WEB_TERMS.map((t) =>
    t.id === "mandant"
      ? // DATEV's own field name „Mandantennummer“ stays (glossary row Unternehmen)
        { ...t, re: /mandant(?!ennummer)/i, where: outside(MANDANT_ALLOWED) }
      : t.id === "phorest"
        ? { ...t, where: outside(PHOREST_ALLOWED) }
        : { id: t.id, re: t.re, reason: t.reason },
  ),
  {
    id: "permission-key",
    re: /\b[a-z][a-z-]*:[a-z][a-z-]*(?::[A-Z]+)?\b/,
    reason: "no permission key in a text — name the permission in words",
  },
];

/** German markers: an umlaut or ß, or a German function word. */
const GERMAN =
  /[äöüÄÖÜß]|\b(der|die|das|den|dem|des|und|oder|nicht|ist|sind|wird|werden|wurde|kann|können|ein|eine|einen|einem|einer|für|mit|bitte|von|vom|zum|zur|auf|bei|noch|kein|keine|dein|deine|dich|dir|du|Sie|Ihr|Ihre|Ihnen)\b/i;
const looksLikeProse = (text: string) => /\s/.test(text.trim()) && /\p{L}/u.test(text);
/** German word endings that English words (practically) never carry — catches short labels such as
 *  „Mandanteneinstellungen lesen“ that have no function word. */
const GERMAN_ENDING = /\p{L}(ungen|ung|keit|heit|lich|isch|ieren|iert)\b/u;
/** English function words: an English sentence that happens to name a German noun
 *  („an operational Schichtplanung conflict“) is not read through the ending fallback. */
const ENGLISH = /\b(the|and|for|of|to|is|are|not|with|same|from|this|no)\b/i;
/** A one-word German label („Mandanteneinstellungen“, „Übersicht“): one capitalised word, no
 *  camel case, with an umlaut, ß or a German ending — never an identifier such as "Tenant". */
const isGermanWord = (text: string) =>
  /^\p{Lu}\p{Ll}+$/u.test(text.trim()) && /[äöüÄÖÜß]|(ungen|ung|keit|heit)$/.test(text.trim());
export const isGermanProse = (text: string) =>
  isGermanWord(text) ||
  (looksLikeProse(text) &&
    (GERMAN.test(text) || (GERMAN_ENDING.test(text) && !ENGLISH.test(text))));

const SKIPPED_PROPERTIES = new Set(["description", "summary"]);
const LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "child"]);

function isLogCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const target = callee.expression;
  if (ts.isIdentifier(target) && (target.text === "console" || target.text === "logger")) {
    return true;
  }
  // app.log.warn(…), req.log.info(…), this.log.error(…)
  return (
    LOG_LEVELS.has(callee.name.text) &&
    ts.isPropertyAccessExpression(target) &&
    target.name.text === "log"
  );
}

/** Raw SQL is never shown: `db.$queryRaw\`…\``, `Prisma.sql\`…\``, `$executeRawUnsafe("…")`. */
const RAW_SQL = /^\$(query|execute)Raw(Unsafe)?$|^sql$/;
function isRawSqlTag(tag: ts.Expression): boolean {
  const target = ts.isCallExpression(tag) ? tag.expression : tag; // $queryRaw<T>`…`
  const name = ts.isPropertyAccessExpression(target)
    ? target.name.text
    : ts.isIdentifier(target)
      ? target.text
      : "";
  return RAW_SQL.test(name);
}
function isRawSqlCall(node: ts.CallExpression): boolean {
  return isRawSqlTag(node.expression);
}

export interface Finding {
  file: string;
  line: number;
  term: string;
  text: string;
  reason: string;
}

/** The findings of one source; `file` is relative to apps/api with forward slashes. */
export function scanSource(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const push = (node: ts.Node, raw: string) => {
    // HTML tags of the e-mail templates are markup, not shown text (style="font-family:…")
    const text = raw.replace(/<[^>]*>/g, " ");
    if (!isGermanProse(text)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const clean = text.replace(/\s+/g, " ").trim();
    for (const term of FORBIDDEN_TERMS) {
      if (term.where && !term.where(file)) continue;
      if (term.re.test(text)) {
        findings.push({ file, line, term: term.id, text: clean, reason: term.reason });
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isLiteralTypeNode(node) || ts.isImportTypeNode(node)) return;
    if (ts.isCallExpression(node) && (isLogCall(node) || isRawSqlCall(node))) return;
    if (ts.isTaggedTemplateExpression(node) && isRawSqlTag(node.tag)) return;
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      SKIPPED_PROPERTIES.has(node.name.text)
    ) {
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      push(node, node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      // literal parts read together; "…" marks a spliced expression
      push(node, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join("…"));
      node.templateSpans.forEach((s) => visit(s.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walkFiles(full, out);
    } else if (
      entry.endsWith(".ts") &&
      !/\.(test|spec)\.ts$/.test(entry) &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Every file the gate reads (absolute paths). The CLI aborts when this is empty. */
export function listScannedFiles(): string[] {
  return walkFiles(join(API_ROOT, SCAN_DIR));
}

export function scan(files: string[] = listScannedFiles()): Finding[] {
  return files.flatMap((full) =>
    scanSource(relative(API_ROOT, full).split("\\").join("/"), readFileSync(full, "utf8")),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = listScannedFiles();
  if (files.length === 0) {
    console.error(
      `[lint:api-terms] scanned 0 file(s) under ${SCAN_DIR} — the scan root moved. This is a failure, not a clean result.`,
    );
    process.exit(1);
  }
  const findings = scan(files);
  if (findings.length === 0) {
    console.warn(
      `[lint:api-terms] OK — ${files.length} file(s) walked, no forbidden term in a German API text (docs/glossar.md).`,
    );
    process.exit(0);
  }
  for (const f of findings) {
    console.error(`${f.file}:${f.line}  [${f.term}]  "${f.text.slice(0, 140)}"  → ${f.reason}`);
  }
  console.error(
    `\n[lint:api-terms] ${findings.length} finding(s) across ${files.length} walked file(s). Vocabulary: docs/glossar.md`,
  );
  process.exit(1);
}
