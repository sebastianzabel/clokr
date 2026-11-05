/**
 * Issue #660 — source guard of the travel offer: ONE reach rule, and no figure ever reads the offer.
 *
 *  1. `validateTravelEntry` (the write) calls `travelWriteCoversDay`, and `travel-offer.ts` (the
 *     offer) calls the same function plus the write rule's own pure anchor check
 *     `validateTravelAnchors`. The offer file names neither `dayCoverage` nor `resolveAccessReach`,
 *     so there is no second reach rule that could drift from the write.
 *  2. None of the day kernels, the working-time account, the report/dashboard composition or the
 *     T1/T2 facade imports a `travel-offer` module or names `travelOffersOfDay`,
 *     `createTravelOfferContext`, `travelWriteCoversDay` or `travelOffers`. (The #92 guard
 *     `travel-saldo-isolation-92` only matches the `travel-entry` specifier, so a `travel-offer`
 *     import needs this guard.)
 *
 * The scan parses each file with the TypeScript compiler; comments are not scanned. Anti-vacuity:
 * every read file is non-empty, the walked working-time-account set is non-empty, and a positive
 * control proves the detector flags a constructed source that reaches the offer.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { describe, it, expect } from "vitest";
import * as ts from "typescript";

// __dirname is apps/api/src/contexts/time-tracking/__tests__ - six levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const TT_ROOT = "apps/api/src/contexts/time-tracking";
const WTA_ROOT = "apps/api/src/contexts/working-time-account";

const OFFER_NAMES = new Set([
  "travelOffersOfDay",
  "createTravelOfferContext",
  "travelWriteCoversDay",
  "travelOffers",
]);
const OFFER_SPECIFIER = /(?:^|\/)travel-offer$/;

const PROTECTED_FILES = [
  `${TT_ROOT}/day-break-rule.ts`,
  `${TT_ROOT}/day-break-placement.ts`,
  `${TT_ROOT}/break-finding-days.ts`,
  `${TT_ROOT}/arbzg.ts`,
  `${TT_ROOT}/entry-durations.ts`,
  `${TT_ROOT}/facade/time-entries.ts`,
  "apps/api/src/composition/reports.ts",
  "apps/api/src/composition/reports-period.ts",
  "apps/api/src/composition/dashboard.ts",
];

function read(rel: string): string {
  const source = readFileSync(join(REPO_ROOT, rel), "utf8");
  expect(source.length, `${rel} must be non-empty (anti-vacuity)`).toBeGreaterThan(0);
  return source;
}

function walkTs(absDir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(absDir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const abs = join(absDir, entry);
    if (statSync(abs).isDirectory()) walkTs(abs, out);
    else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts")) out.push(abs);
  }
  return out;
}

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
}

/** The offer names / `travel-offer` specifiers a source text carries (identifiers, strings, imports). */
function offerReferences(fileName: string, source: string): string[] {
  const hits = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && OFFER_NAMES.has(node.text)) hits.add(node.text);
    if (ts.isStringLiteralLike(node)) {
      if (OFFER_NAMES.has(node.text)) hits.add(node.text);
      const parent = node.parent;
      if (
        parent &&
        (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
        OFFER_SPECIFIER.test(node.text)
      ) {
        hits.add(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(fileName, source));
  return [...hits].sort();
}

/** Names of every function called anywhere inside `root` (plain calls `f(...)` only). */
function calledNames(root: ts.Node): Set<string> {
  const calls = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.add(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return calls;
}

/** Every identifier that appears anywhere in `root` (imports included). */
function identifiersIn(root: ts.Node): Set<string> {
  const ids = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) ids.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return ids;
}

function functionBody(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name,
  );
  expect(fn, `function ${name} must exist`).toBeDefined();
  return fn!;
}

describe("Issue #660 - one reach rule for the travel write and the travel offer", () => {
  it("validateTravelEntry asks travelWriteCoversDay and no longer resolves the reach itself", () => {
    const sf = parse("travel-entry.ts", read(`${TT_ROOT}/travel-entry.ts`));
    const calls = calledNames(functionBody(sf, "validateTravelEntry"));
    expect(calls.has("travelWriteCoversDay")).toBe(true);
    expect(calls.has("resolveAccessReach")).toBe(false);
    expect(calls.has("dayCoverage")).toBe(false);
    // The predicate itself is where the reach is resolved.
    const predicate = calledNames(functionBody(sf, "travelWriteCoversDay"));
    expect(predicate.has("resolveAccessReach")).toBe(true);
    expect(predicate.has("dayCoverage")).toBe(true);
  });

  it("travel-offer.ts calls the same predicate and the write rule's anchor check, and no reach function of its own", () => {
    const sf = parse("travel-offer.ts", read(`${TT_ROOT}/travel-offer.ts`));
    const calls = calledNames(sf);
    expect(calls.has("travelWriteCoversDay")).toBe(true);
    expect(calls.has("validateTravelAnchors")).toBe(true);
    const ids = identifiersIn(sf);
    expect(ids.has("dayCoverage")).toBe(false);
    expect(ids.has("resolveAccessReach")).toBe(false);
  });
});

describe("Issue #660 - no kernel, saldo or figure file reaches the offer", () => {
  const walked = walkTs(join(REPO_ROOT, WTA_ROOT));

  it("the walked working-time-account set is non-empty and every protected file is read non-empty", () => {
    expect(walked.length).toBeGreaterThan(5);
    for (const rel of PROTECTED_FILES) read(rel);
  });

  it("the detector flags a constructed source that reaches the offer (positive control)", () => {
    const constructed =
      'import { travelOffersOfDay } from "./travel-offer";\nexport const x = travelOffersOfDay;\n';
    expect(offerReferences("constructed.ts", constructed)).toEqual([
      "./travel-offer",
      "travelOffersOfDay",
    ]);
    const viaName = "export const y = { travelOffers: [] };\n";
    expect(offerReferences("constructed.ts", viaName)).toEqual(["travelOffers"]);
    expect(offerReferences("clean.ts", "export const z = 1;\n")).toEqual([]);
  });

  it("no protected figure file names the offer", () => {
    for (const rel of PROTECTED_FILES) {
      expect(offerReferences(rel, read(rel)), rel).toEqual([]);
    }
  });

  it("no non-test file of the working-time account names the offer", () => {
    for (const abs of walked) {
      const source = readFileSync(abs, "utf8");
      expect(source.length, `${abs} must be non-empty`).toBeGreaterThan(0);
      expect(offerReferences(abs, source), abs).toEqual([]);
    }
  });
});
