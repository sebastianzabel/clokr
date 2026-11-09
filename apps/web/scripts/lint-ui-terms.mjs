#!/usr/bin/env node
/**
 * lint:ui-terms — Issue #574. Fails on a forbidden term in any text the web app SHOWS.
 *
 * The binding vocabulary and the address form ("du") live in `docs/glossar.md`. This gate is its
 * machine-checkable half: it extracts only what reaches the screen and checks it against
 * FORBIDDEN_TERMS below.
 *
 * What counts as shown text:
 *   - .svelte markup: text nodes, static attribute values (except the non-shown attributes in
 *     SKIP_ATTRS, data-* and event handlers), and string literals inside `{…}` tags and attribute
 *     expressions;
 *   - .svelte `<script>` blocks and .ts modules: string and template literals that look like
 *     prose (contain whitespace and a letter), plus a literal that is ONE capitalized word such as
 *     a nav label ("Inbox"). A control value such as "SHIFT_BASED" has no whitespace and is no
 *     capitalized word, so code may compare enum values freely.
 * Never checked: comments, import specifiers, `console.*` arguments, type positions, test files.
 *
 * Scope: apps/web/src/routes and apps/web/src/lib (every .svelte and .ts file, tests excluded),
 * so a term cannot escape the gate by moving into a component.
 *
 * CLI: `node scripts/lint-ui-terms.mjs [--only <prefix>]…` — the whole tree is always walked (an
 * empty walk aborts); `--only` reports and counts only findings of files starting with a prefix
 * (relative to apps/web, e.g. `src/routes/(auth)/`).
 *
 * Exit codes: 0 — no finding · 1 — findings, or nothing was walked.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { parse } from "svelte/compiler";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["src/routes", "src/lib"];

/** Areas where "Phorest" may be named: the integration is configured and planned there. */
const PHOREST_ALLOWED = [
  "src/routes/(app)/admin/", // Verwaltung: the integration's own settings page
  "src/routes/(app)/shifts/", // Schichtplanung: imported shifts are planned by managers
  "src/routes/(operator)/", // operator console: salon coupling
  "src/lib/components/admin/",
  "src/lib/components/schedule/", // contract fields edited in Verwaltung
  "src/lib/components/operator/",
  "src/lib/operator/",
  "src/lib/nav/page-labels.ts", // the admin page name, shown only in the Verwaltung section
];
/** Areas where "Mandant" may be named (D-574-04): the operator console speaks to the operator. */
const MANDANT_ALLOWED = [
  "src/routes/(operator)/",
  "src/lib/components/operator/",
  "src/lib/operator/",
  "src/routes/(app)/admin/export/", // DATEV's own field name „Mandantennummer“
];
/** @param {string[]} areas */
const inArea = (areas) => (/** @type {string} */ file) =>
  !areas.some((prefix) => file.startsWith(prefix));

/**
 * The forbidden terms. `where` narrows a term to part of the app (default: everywhere);
 * `reason` is printed with every finding and names the glossary term to use instead.
 */
export const FORBIDDEN_TERMS = [
  { id: "tenant", re: /tenant/i, reason: "use „Unternehmen“, never Tenant" },
  {
    id: "code-value",
    re: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/,
    reason: "no enum value, error code or environment-variable name in text — write it out",
  },
  { id: "danger-zone", re: /danger\s*zone/i, reason: "use „Kritische Aktionen“" },
  { id: "coverage", re: /\bcoverage\b/i, reason: "use „Besetzung“ / „Mindestbesetzung“" },
  { id: "sigma", re: /Σ|\bsigma\b/i, reason: "use „Summe“ / „gesamt“" },
  { id: "korrelation", re: /korrelation/i, reason: "say what is compared" },
  { id: "entitaet", re: /entität/i, reason: "name the thing (Eintrag, Antrag, Datensatz …)" },
  {
    id: "schedule",
    re: /\bschedules?\b|schedule-/i,
    reason: "use „Arbeitszeitmodell“ / „Vertrag“",
  },
  { id: "inbox", re: /\binbox\b/i, reason: "use „Aufgaben“" },
  { id: "ma", re: /\bMA\b/, reason: "write out „Mitarbeitende“" },
  {
    id: "mandant",
    re: /mandant/i,
    where: inArea(MANDANT_ALLOWED),
    reason: "use „Unternehmen“; „Mandant“ only in the operator console",
  },
  {
    id: "phorest",
    re: /phorest/i,
    where: inArea(PHOREST_ALLOWED),
    reason: "„Phorest“ only in Verwaltung, Schichtplanung and the operator console",
  },
  {
    id: "sie-form",
    re: /\b(Sie|Ihnen|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)\b/,
    reason: "address the reader with „du“",
  },
];

/** Exact (file, term, text) triples that are not a finding, each with its reason. Stays empty. */
/** @type {{ file: string; term: string; text: string }[]} */
export const ALLOWED = [];

const SKIP_ATTRS = new Set([
  "class",
  "style",
  "href",
  "src",
  "id",
  "name",
  "type",
  "for",
  "role",
  "lang",
  "rel",
  "target",
  "method",
  "action",
  "autocomplete",
  "inputmode",
  "pattern",
  "accept",
  "translate",
  "slot",
  "key",
  "this",
  "value", // a form control's value is a control value, not shown prose
  "icon", // icon names (EmptyState, nav)
  "aria-describedby",
  "aria-labelledby",
  "aria-controls",
]);

/**
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walkFiles(full, out);
    } else if (
      /\.(svelte|ts)$/.test(entry) &&
      !/\.(test|spec)\.ts$/.test(entry) &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Every file the gate reads (absolute paths). The CLI aborts when this is empty. */
export function listScannedFiles() {
  /** @type {string[]} */
  const files = [];
  for (const dir of SCAN_DIRS) walkFiles(join(WEB_ROOT, dir), files);
  return files;
}

const looksLikeProse = (/** @type {string} */ text) =>
  /\s/.test(text.trim()) && /\p{L}/u.test(text);
/** One capitalized word ("Inbox", "Team-Zeiten") — a label, even without whitespace. */
const isCapitalizedWord = (/** @type {string} */ text) =>
  /^\p{Lu}\p{Ll}[\p{L}-]*$/u.test(text.trim());
const isShownLiteral = (/** @type {string} */ text) =>
  looksLikeProse(text) || isCapitalizedWord(text);

/** Shown literals of a TypeScript source; `lineBase` is the 1-based line of the source's first line. */
/** @typedef {(line: number, text: string) => void} Push */

/**
 * @param {string} code
 * @param {number} lineBase
 * @param {Push} push
 */
function tsLiterals(code, lineBase, push) {
  const sf = ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console"
    ) {
      return;
    }
    if (ts.isLiteralTypeNode(node) || ts.isImportTypeNode(node)) return; // types are never shown
    const lineOfNode = (/** @type {import("typescript").Node} */ n) =>
      sf.getLineAndCharacterOfPosition(n.getStart()).line + lineBase;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (isShownLiteral(node.text)) push(lineOfNode(node), node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      // the literal parts read together; "…" (no whitespace) marks a spliced expression, so a URL
      // template such as `/tenants/${id}` stays a path and never becomes prose
      const text = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(
        "…",
      );
      if (looksLikeProse(text)) push(lineOfNode(node), text);
      node.templateSpans.forEach((span) => visit(span.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** String literals inside a template expression (ESTree). */
/**
 * @param {any} node an ESTree node (svelte/compiler's expression AST)
 * @param {Push} push
 * @param {(offset: number) => number} lineOf
 */
function estreeLiterals(node, push, lineOf) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((n) => estreeLiterals(n, push, lineOf));
    return;
  }
  if (node.type === "CallExpression" && node.callee?.object?.name === "console") return;
  if (node.type?.startsWith?.("TS")) return; // type annotations and casts in markup expressions
  if (node.type === "Literal" && typeof node.value === "string") {
    if (isShownLiteral(node.value)) push(lineOf(node.start), node.value);
    return;
  }
  if (node.type === "TemplateLiteral") {
    const text = node.quasis
      .map((/** @type {any} */ q) => q.value?.cooked ?? q.value?.raw ?? "")
      .join("…");
    if (looksLikeProse(text)) push(lineOf(node.start), text);
    estreeLiterals(node.expressions, push, lineOf);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "metadata") continue;
    if (value && typeof value === "object") estreeLiterals(value, push, lineOf);
  }
}

/** Every shown text of a .svelte file. */
/**
 * @param {string} source
 * @param {Push} push
 */
function svelteTexts(source, push) {
  const lineOf = (/** @type {number} */ offset) => source.slice(0, offset).split("\n").length;
  // scripts: scanned as TypeScript, line numbers offset to the script's position
  for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const start = match.index + match[0].indexOf(">") + 1;
    tsLiterals(match[1], lineOf(start), push); // the script's first line is the tag's line
  }
  // the whole file is parsed (a `lang="ts"` script makes TypeScript legal in markup expressions);
  // only the markup fragment is walked — the scripts were scanned above, styles are never shown
  let ast;
  try {
    ast = parse(source, { modern: true });
  } catch (err) {
    push(1, `__PARSE_ERROR__ ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  /** @param {any} node a svelte/compiler template node */
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    switch (node.type) {
      case "Text":
        if (node.data.trim() && /\p{L}/u.test(node.data))
          push(lineOf(node.start), node.data.trim());
        return;
      case "Comment":
        return;
      case "Attribute": {
        const name = node.name.toLowerCase();
        if (SKIP_ATTRS.has(name) || name.startsWith("data-") || name.startsWith("on")) return;
        const values = Array.isArray(node.value)
          ? node.value
          : node.value === true
            ? []
            : [node.value];
        for (const v of values) {
          if (v.type === "Text") {
            if (isShownLiteral(v.data)) push(lineOf(v.start), v.data);
          } else if (v.type === "ExpressionTag") {
            estreeLiterals(v.expression, push, lineOf);
          }
        }
        return;
      }
      case "ExpressionTag":
        estreeLiterals(node.expression, push, lineOf);
        return;
      case "StyleDirective":
      case "ClassDirective":
      case "BindDirective":
      case "OnDirective":
      case "UseDirective":
      case "TransitionDirective":
      case "AnimateDirective":
        return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent" || key === "metadata" || key === "loc") continue;
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast.fragment);
}

/** @typedef {{ file: string; line: number; term: string; text: string; reason: string }} Finding */

/**
 * The findings of one source. `file` is the path relative to apps/web with forward slashes; its
 * extension decides between .svelte and .ts extraction, its prefix decides the area scoping.
 * @param {string} file
 * @param {string} source
 * @returns {Finding[]}
 */
export function scanSource(file, source) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Push} */
  const push = (line, text) => {
    if (text.startsWith("__PARSE_ERROR__")) {
      findings.push({ file, line, term: "parse-error", text, reason: "file could not be parsed" });
      return;
    }
    const clean = text.replace(/\s+/g, " ").trim();
    for (const term of FORBIDDEN_TERMS) {
      if (term.where && !term.where(file)) continue;
      if (!term.re.test(text)) continue;
      if (ALLOWED.some((a) => a.file === file && a.term === term.id && clean.includes(a.text))) {
        continue;
      }
      findings.push({ file, line, term: term.id, text: clean, reason: term.reason });
    }
  };
  if (file.endsWith(".svelte")) svelteTexts(source, push);
  else tsLiterals(source, 1, push);
  return findings;
}

/**
 * The findings of the given files (absolute paths); defaults to the whole scanned tree.
 * @param {string[]} [files]
 * @returns {Finding[]}
 */
export function scan(files = listScannedFiles()) {
  return files.flatMap((full) =>
    scanSource(relative(WEB_ROOT, full).split("\\").join("/"), readFileSync(full, "utf8")),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  /** @type {string[]} */
  const only = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--only" && args[i + 1]) only.push(args[++i]);
  }
  const files = listScannedFiles();
  if (files.length === 0) {
    console.error(
      `[lint:ui-terms] scanned 0 file(s) under ${SCAN_DIRS.join(", ")} — the scan root moved. ` +
        `This is a failure, not a clean result.`,
    );
    process.exit(1);
  }
  const findings = scan(files).filter(
    (f) => only.length === 0 || only.some((prefix) => f.file.startsWith(prefix)),
  );
  const area = only.length > 0 ? ` in ${only.join(", ")}` : "";
  if (findings.length === 0) {
    console.warn(
      `[lint:ui-terms] OK — ${files.length} file(s) walked, no forbidden term in shown text${area} (docs/glossar.md).`,
    );
    process.exit(0);
  }
  for (const f of findings) {
    console.error(`${f.file}:${f.line}  [${f.term}]  "${f.text.slice(0, 140)}"  → ${f.reason}`);
  }
  console.error(
    `\n[lint:ui-terms] ${findings.length} finding(s)${area} across ${files.length} walked file(s). Vocabulary: docs/glossar.md`,
  );
  process.exit(1);
}
