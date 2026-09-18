/**
 * Phase 204 Plan 02 — tests for lint-tenant-scoping-candidates.ts.
 *
 * DB-free: fixtures under fixtures/tenant-scoping/provenance/ are parsed with
 * `ts.createSourceFile`, never executed and never type-checked, so they carry `declare const`
 * stand-ins instead of real imports. The two live-repo assertions (D-15 exclusion, the D-14
 * candidate-count band) run `listScopedFiles`/`selectCandidates` against the actual seven
 * `SCOPED_DIRS` trees (Phase 99b Plan 07 final shape), so they track real drift rather than a
 * restatement of a fixture.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ts from "typescript";
import {
  listScopedFiles,
  findPrismaCalls,
  classifyProvenance,
  selectCandidates,
  MissingScopedDirError,
} from "../lint-tenant-scoping-candidates";
import { enclosingHandler, collectRequestBindings } from "../lint-tenant-scoping-request-bindings";

const FIXTURES_DIR = path.join(__dirname, "fixtures/tenant-scoping/provenance");
const REPO_ROOT = path.resolve(process.cwd(), "../..");

function loadFixture(file: string): ts.SourceFile {
  const abs = path.join(FIXTURES_DIR, file);
  const text = fs.readFileSync(abs, "utf8");
  return ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);
}

// ── One row per provenance shape measured in this repo (204-02-PLAN.md <behavior>) ───────────

type ProvenanceCase =
  | {
      file: string;
      model: string;
      expectCandidate: true;
      expectedViaSubstring: string;
    }
  | {
      file: string;
      model: string;
      expectCandidate: false;
      expectedReasonSubstrings: readonly string[];
    };

const CASES: readonly ProvenanceCase[] = [
  {
    file: "inline-param-cast.ts",
    model: "timeEntry",
    expectCandidate: true,
    expectedViaSubstring: "id",
  },
  {
    file: "zod-parsed-param.ts",
    model: "presenceDevice",
    expectCandidate: true,
    expectedViaSubstring: "id",
  },
  {
    file: "body-field.ts",
    model: "workSchedule",
    expectCandidate: true,
    expectedViaSubstring: "body",
  },
  {
    file: "fetched-row-id.ts",
    model: "employee",
    expectCandidate: false,
    expectedReasonSubstrings: ["fetched-row", "existing.employeeId"],
  },
  {
    file: "helper-parameter.ts",
    model: "workSchedule",
    expectCandidate: false,
    expectedReasonSubstrings: ["helper-parameter", "employeeId"],
  },
  {
    file: "where-as-variable.ts",
    model: "leaveRequest",
    expectCandidate: true,
    expectedViaSubstring: "id",
  },
  // where-shorthand.ts (integrations.ts:470-473's ONE shorthand-`{ where }` occurrence):
  // this implementation resolves the shorthand back to its `const where = {...}` declaration,
  // so the measured outcome is a NORMAL candidate via "id" — asserted explicitly, per the
  // plan's own instruction that silence here is the failure mode.
  {
    file: "where-shorthand.ts",
    model: "phorestSyncRun",
    expectCandidate: true,
    expectedViaSubstring: "id",
  },
];

describe.each(CASES)("provenance fixture: $file", (testCase) => {
  it(`classifies the ${testCase.model} call as ${testCase.expectCandidate ? "a candidate" : "NOT a candidate"}`, () => {
    const sourceFile = loadFixture(testCase.file);
    const calls = findPrismaCalls(sourceFile, testCase.file);
    const target = calls.find((discovered) => discovered.call.model === testCase.model);
    expect(target, `expected a "${testCase.model}" call in ${testCase.file}`).toBeDefined();

    const handler = enclosingHandler(target!.node, sourceFile);
    const bindings = collectRequestBindings(handler, sourceFile);
    const provenance = classifyProvenance(target!.whereArg, bindings, sourceFile);

    expect(provenance.clientSupplied).toBe(testCase.expectCandidate);
    if (provenance.clientSupplied) {
      expect(testCase.expectCandidate).toBe(true);
      if (testCase.expectCandidate) {
        expect(provenance.via.some((entry) => entry.includes(testCase.expectedViaSubstring))).toBe(
          true,
        );
      }
    } else {
      expect(testCase.expectCandidate).toBe(false);
      if (!testCase.expectCandidate) {
        for (const substring of testCase.expectedReasonSubstrings) {
          expect(provenance.reason).toContain(substring);
        }
      }
    }
  });
});

it("every provenance fixture file is accounted for by exactly one CASES row", () => {
  const fixtureFiles = fs
    .readdirSync(FIXTURES_DIR)
    .filter((entry) => entry.endsWith(".ts"))
    .sort();
  // Phase 235 (D-02/AC-4): without this, the equality below could pass on two empty sets if
  // fixtures/tenant-scoping/provenance/ ever moved or emptied at the same time CASES did.
  expect(
    fixtureFiles.length,
    "no provenance fixture file found — fixtures/tenant-scoping/provenance/ moved or emptied",
  ).toBeGreaterThan(0);
  const casedFiles = [...new Set(CASES.map((c) => c.file))].sort();
  expect(fixtureFiles).toEqual(casedFiles);
});

// ── D-15: __tests__ is excluded explicitly, as a live assertion ──────────────────────────────

it("D-15: listScopedFiles never returns a path under a __tests__ segment", () => {
  const files = listScopedFiles(REPO_ROOT);
  expect(files.length).toBeGreaterThan(20);
  const leaked = files.filter((file) => file.includes("__tests__"));
  expect(leaked).toEqual([]);
});

// ── #229 Guard A: a SCOPED_DIRS entry that points nowhere is a hard error, not a silent skip ───

it("#229 Guard A: listScopedFiles throws MissingScopedDirError when a scoped dir does not exist", () => {
  const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), "lint-tenant-scoping-missing-dir-"));
  try {
    // No SCOPED_DIRS entry created under emptyRepo — every one of the seven points nowhere on
    // this throwaway repo root.
    expect(() => listScopedFiles(emptyRepo)).toThrowError(MissingScopedDirError);
    try {
      listScopedFiles(emptyRepo);
      expect.unreachable("listScopedFiles must throw before returning");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingScopedDirError);
      expect((err as Error).message).toContain("apps/api/src/contexts/platform/api");
    }
  } finally {
    fs.rmSync(emptyRepo, { recursive: true, force: true });
  }
});

// ── D-14: the filter is measurably doing work on the real tree ───────────────────────────────

it("selectCandidates over the real tree stays inside the measured band around 211", () => {
  const candidates = selectCandidates(REPO_ROOT);
  const failureMessage =
    `selectCandidates returned ${candidates.length} candidates. The plan measured 211 ` +
    `candidates on main @ 708ffbfa after applying the D-14 filter. A large move away from ` +
    `that band means the filter's behaviour changed (too permissive risks D-17's exception-list ` +
    `hard stop; too restrictive silently hides the exact IDOR this gate targets) and must be ` +
    `re-justified, not just accepted.`;
  expect(candidates.length, failureMessage).toBeGreaterThanOrEqual(120);
  expect(candidates.length, failureMessage).toBeLessThanOrEqual(320);
});
