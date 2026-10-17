/**
 * Issue #92 (Phase 92b-04, D-03, D-07) — the travel dimension never reaches the saldo or a figure
 * file. Sibling of `activity-kind-saldo-isolation-81.test.ts` (never imported or edited: its
 * constants are module-private and it runs `describe` on import; the names are restated here).
 *
 * A travel entry is ordinary working time (§ 2 Abs. 1 ArbZG, ADR 0002). What makes it a trip is its
 * kind TRAVEL and its arrival salon `travelToSalonId` — an evaluation and display dimension only.
 * The working-time account, the day kernels, the report/dashboard/PDF composition and the holiday
 * resolution must never read it: if any of those files started to, a trip could weigh differently
 * from the same minutes of ordinary work, and closed months (never recalculated) could drift.
 *
 * Rules:
 *  - every non-test file of the working-time account and the PROTECTED figure files carry none of the
 *    forbidden names and import no `travel-entry` module;
 *  - the T1/T2 facade file `contexts/time-tracking/facade/time-entries.ts` is the one protected file
 *    that MAY import from `travel-entry`: it also holds the CSV import writer, which calls
 *    `checkTravelNeighbours` (an imported row must not land between a trip and its arrival entry).
 *    It still carries none of the four travel FIELD names and no TRAVEL value, so the T1/T2 readers
 *    can never select or filter on them; the allowed import is pinned to exactly two names.
 *
 * The scan parses each file with the TypeScript compiler. A forbidden NAME counts as an identifier
 * (member access, import name, object key, type name) or as a string literal / bracket access; a module
 * specifier counts when an import/export names the travel module. Comments are not scanned.
 *
 * Named blind spot: a figure file that reaches the travel fields through a NEW helper with an unrelated
 * name in a module outside the walked tree and the protected list is not seen here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { describe, it, expect } from "vitest";
import * as ts from "typescript";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const WTA_ROOT = "apps/api/src/contexts/working-time-account";
const TT_ROOT = "apps/api/src/contexts/time-tracking";

/** The four travel FIELD names (and the kind value): no figure file may carry them. */
const TRAVEL_FIELD_NAMES = new Set([
  "travelToSalonId",
  "travelToSalon",
  "travelEntriesTo",
  "travelToSalonName",
  "TRAVEL",
]);

/** Travel function / type names: banned everywhere except in the facade's one allowed import. */
const TRAVEL_FUNCTION_NAMES = new Set([
  "validateTravelEntry",
  "classifyTravelWrite",
  "classifyTravelUpdate",
  "validateTravelAnchors",
  "travelRowsOrphanedBy",
  "checkTravelNeighbours",
  "TravelRefusalError",
  "TravelRefusal",
  "TravelClassification",
]);

const FORBIDDEN_NAMES = new Set([...TRAVEL_FIELD_NAMES, ...TRAVEL_FUNCTION_NAMES]);

/** Module specifier of the travel module. */
const TRAVEL_SPECIFIER = /(?:^|\/)travel-entry$/;

/** The facade file: the saldo's entry reads (T1/T2) and the CSV import writer. */
const FACADE_FILE = `${TT_ROOT}/facade/time-entries.ts`;
/** The only names the facade may import from the travel module. */
const FACADE_ALLOWED_TRAVEL_IMPORTS = ["TravelRefusalError", "checkTravelNeighbours"];

/** The saldo files: they must be walked AND clean. */
const SALDO_FILES = [
  `${WTA_ROOT}/close-employee-month.ts`,
  `${WTA_ROOT}/month-saldo.ts`,
  `${WTA_ROOT}/overtime-balance.ts`,
  `${WTA_ROOT}/timezone.ts`,
];

/** Figure files outside the account: formula, day kernels, reports, holiday resolution. */
const PROTECTED_FILES = [
  `${TT_ROOT}/entry-durations.ts`,
  `${TT_ROOT}/arbzg.ts`,
  `${TT_ROOT}/day-break-rule.ts`,
  `${TT_ROOT}/day-break-placement.ts`,
  `${TT_ROOT}/break-finding-days.ts`,
  "apps/api/src/composition/reports.ts",
  "apps/api/src/composition/reports-period.ts", // Issue #612 — the period report is a report figure surface
  "apps/api/src/composition/dashboard.ts",
  "apps/api/src/composition/pdf.ts",
  "apps/api/src/contexts/platform/facade/holiday-resolution.ts",
];

function repoRel(absPath: string): string {
  return relative(REPO_ROOT, absPath).split("\\").join("/");
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

/** The forbidden names / specifiers a source text carries, by AST, restricted to `names`. */
function referencesIn(
  fileName: string,
  source: string,
  names: ReadonlySet<string>,
  withSpecifier: boolean,
): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hits = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text)) hits.add(node.text);
    if (ts.isStringLiteralLike(node)) {
      if (names.has(node.text)) hits.add(node.text);
      const parent = node.parent;
      if (
        withSpecifier &&
        parent &&
        (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
        TRAVEL_SPECIFIER.test(node.text)
      ) {
        hits.add(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...hits].sort();
}

/** Full rule: every travel name and the module specifier. */
function forbiddenReferences(fileName: string, source: string): string[] {
  return referencesIn(fileName, source, FORBIDDEN_NAMES, true);
}

/** Facade rule: the travel FIELDS and the kind value only (the allowed import is pinned separately). */
function facadeReferences(fileName: string, source: string): string[] {
  return referencesIn(fileName, source, TRAVEL_FIELD_NAMES, false);
}

/** The names a source text imports from the travel module (named imports only). */
function importedTravelNames(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  sf.forEachChild((node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      TRAVEL_SPECIFIER.test(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) names.push((el.propertyName ?? el.name).text);
      }
    }
  });
  return names.sort();
}

function sourceOf(file: string): string {
  return readFileSync(join(REPO_ROOT, file), "utf8");
}

describe("Issue #92 (D-03, D-07) — the saldo and the figure files never see the travel dimension", () => {
  const walked = walkTs(join(REPO_ROOT, WTA_ROOT));
  const walkedRel = walked.map(repoRel);

  it("the walk sees the tree (a silently-empty walk would pass forever)", () => {
    expect(walked.length, "no file walked under working-time-account at all").toBeGreaterThan(0);
    // Measured 2026-10-16: 31 non-test files under working-time-account; the floor is 30.
    expect(
      walked.length,
      "fewer files walked than the measured floor — the scan root moved or emptied",
    ).toBeGreaterThanOrEqual(30);
    for (const file of SALDO_FILES) {
      expect(walkedRel, `the walk did not reach ${file}`).toContain(file);
    }
    for (const file of [...PROTECTED_FILES, FACADE_FILE]) {
      expect(sourceOf(file).length, `${file} is empty or missing`).toBeGreaterThan(0);
    }
  });

  it("positive control: the detector flags every forbidden shape", () => {
    expect(
      forbiddenReferences("x.ts", `const k = row.travelToSalonId;`),
      "field identifier",
    ).toEqual(["travelToSalonId"]);
    expect(
      forbiddenReferences("x.ts", `const k = entry.activityKind === "TRAVEL";`),
      "kind value",
    ).toEqual(["TRAVEL"]);
    expect(forbiddenReferences("x.ts", `const f = "travelToSalonName";`), "string literal").toEqual(
      ["travelToSalonName"],
    );
    expect(
      forbiddenReferences("x.ts", `const r = db["travelEntriesTo"];`),
      "bracket access",
    ).toEqual(["travelEntriesTo"]);
    expect(
      forbiddenReferences("x.ts", `await validateTravelEntry(tx, input);`),
      "function name",
    ).toEqual(["validateTravelEntry"]);
    expect(
      forbiddenReferences("x.ts", `import { x } from "../time-tracking/travel-entry";`),
      "module specifier",
    ).toEqual(["../time-tracking/travel-entry"]);
    expect(
      forbiddenReferences("x.ts", `// travelToSalonId and TRAVEL only in a comment`),
      "comments are deliberately not scanned",
    ).toEqual([]);
    // The facade rule: fields and the kind value are flagged, the allowed import is not.
    expect(facadeReferences("x.ts", `select: { travelToSalonId: true }`), "facade field").toEqual([
      "travelToSalonId",
    ]);
    expect(
      facadeReferences("x.ts", `import { checkTravelNeighbours } from "../travel-entry";`),
      "facade import is not a field",
    ).toEqual([]);
    expect(
      importedTravelNames(
        "x.ts",
        `import { checkTravelNeighbours as c, TravelRefusalError } from "../travel-entry";`,
      ),
      "import names are read through the alias",
    ).toEqual(["TravelRefusalError", "checkTravelNeighbours"]);
  });

  it("control run: the travel module and the route carry the names (the guard watches live names)", () => {
    const moduleRefs = forbiddenReferences(
      "travel-entry.ts",
      sourceOf(`${TT_ROOT}/travel-entry.ts`),
    );
    for (const core of [
      "validateTravelEntry",
      "classifyTravelWrite",
      "classifyTravelUpdate",
      "validateTravelAnchors",
      "travelRowsOrphanedBy",
      "checkTravelNeighbours",
      "travelToSalonId",
    ]) {
      expect(moduleRefs, `the core name ${core} no longer exists in travel-entry.ts`).toContain(
        core,
      );
    }
    const routeRefs = forbiddenReferences(
      "time-entries.ts",
      sourceOf(`${TT_ROOT}/api/time-entries.ts`),
    );
    for (const field of ["travelToSalonId", "travelToSalonName", "TRAVEL"]) {
      expect(
        routeRefs,
        `the field name ${field} no longer exists in api/time-entries.ts`,
      ).toContain(field);
    }
    // The facade reaches the travel module (the CSV import writer) — the allowed import is live.
    expect(importedTravelNames("facade", sourceOf(FACADE_FILE))).toEqual(
      FACADE_ALLOWED_TRAVEL_IMPORTS.slice().sort(),
    );
  });

  it("no file of the working-time account references the travel dimension (no allowlist)", () => {
    const offenders = walked
      .map((abs) => [repoRel(abs), forbiddenReferences(abs, readFileSync(abs, "utf8"))] as const)
      .filter(([, refs]) => refs.length > 0)
      .map(([file, refs]) => `${file}: ${refs.join(", ")}`);
    expect(
      offenders,
      `the travel dimension leaked into the working-time account:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no protected figure file references the travel dimension", () => {
    for (const file of PROTECTED_FILES) {
      expect(
        forbiddenReferences(file, sourceOf(file)),
        `${file} references the travel dimension`,
      ).toEqual([]);
    }
  });

  it("the T1/T2 facade file names no travel field, and imports only the neighbour check from the travel module", () => {
    expect(
      facadeReferences(FACADE_FILE, sourceOf(FACADE_FILE)),
      `${FACADE_FILE} names a travel field — a T1/T2 reader must never select or filter on it`,
    ).toEqual([]);
    expect(importedTravelNames(FACADE_FILE, sourceOf(FACADE_FILE))).toEqual(
      FACADE_ALLOWED_TRAVEL_IMPORTS.slice().sort(),
    );
    // Beyond the pinned import, the facade uses the check and the error class only.
    const functionRefs = referencesIn(
      FACADE_FILE,
      sourceOf(FACADE_FILE),
      new Set([...TRAVEL_FUNCTION_NAMES].filter((n) => !FACADE_ALLOWED_TRAVEL_IMPORTS.includes(n))),
      false,
    );
    expect(functionRefs, `${FACADE_FILE} uses a travel function beyond the allowed import`).toEqual(
      [],
    );
  });
});
