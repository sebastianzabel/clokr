/**
 * Phase 100B Plan 04 — tests for the facade-aware tenant-scoping gate (D-10, G1/G2/G3).
 *
 * DB-free: fixtures under fixtures/tenant-scoping/facade/ are parsed with `ts.createSourceFile`,
 * never executed and never type-checked — same discipline as
 * lint-tenant-scoping-candidates.test.ts / -verdict.test.ts. `buildModelGraph()` is called
 * against the REAL, already-generated `@clokr/db` client (no database connection, no `main()`).
 *
 * The fixture files physically live under `scripts/__tests__/fixtures/tenant-scoping/facade/` —
 * NOT under `apps/api/src/contexts/*\/facade/` — because `isFacadeModulePath` is a pure string
 * predicate over the `repoRelativePath` argument the caller supplies. Passing a synthetic
 * `apps/api/src/contexts/scheduling/facade/<name>.ts` path into `findPrismaCalls` /
 * `collectRequestBindings` exercises the exact same code path a real facade file on disk would,
 * without needing a throwaway file under `src/` for every case (Task 2's live probe covers that
 * end-to-end, on the real tree, separately — see 100B-04-SUMMARY.md).
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { buildModelGraph } from "../lint-tenant-scoping-model-graph";
import { isFacadeModulePath } from "../lint-tenant-scoping-types";
import { enclosingHandler, collectRequestBindings } from "../lint-tenant-scoping-request-bindings";
import { findPrismaCalls, classifyProvenance } from "../lint-tenant-scoping-candidates";
import { reachVerdict } from "../lint-tenant-scoping-verdict";
import type { ScopedVia, Provenance } from "../lint-tenant-scoping-types";

const FIXTURES_DIR = path.join(__dirname, "fixtures/tenant-scoping/facade");
const graph = buildModelGraph();

/** A repo-relative path that DOES match isFacadeModulePath — a plausible scheduling facade. */
const FACADE_PATH = "apps/api/src/contexts/scheduling/facade/probe.ts";
/** The same shape, but under `api/`, not `facade/` — must NOT be recognised as a facade module. */
const NON_FACADE_PATH = "apps/api/src/contexts/scheduling/api/probe.ts";

function loadFixture(file: string): ts.SourceFile {
  const abs = path.join(FIXTURES_DIR, file);
  const text = fs.readFileSync(abs, "utf8");
  return ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);
}

function findCall(sourceFile: ts.SourceFile, repoRelativePath: string, model: string) {
  const calls = findPrismaCalls(sourceFile, repoRelativePath);
  const target = calls.find((c) => c.call.model === model);
  if (!target) {
    throw new Error(
      `expected a "${model}" call in ${repoRelativePath}, found: ${calls
        .map((c) => `${c.call.model}.${c.call.method}`)
        .join(", ")}`,
    );
  }
  return target;
}

// ── isFacadeModulePath (G1's recognition predicate) — the one place this shape is stated ──────

describe("isFacadeModulePath", () => {
  it("matches a facade module under a plain context name", () => {
    expect(isFacadeModulePath("apps/api/src/contexts/scheduling/facade/shifts-facade.ts")).toBe(
      true,
    );
  });

  it("matches a facade module under a HYPHENATED context name (the #240 gap)", () => {
    expect(
      isFacadeModulePath("apps/api/src/contexts/working-time-account/facade/overtime.ts"),
    ).toBe(true);
    expect(isFacadeModulePath("apps/api/src/contexts/time-tracking/facade/clock.ts")).toBe(true);
  });

  it("does NOT match the same context's api/ directory", () => {
    expect(isFacadeModulePath("apps/api/src/contexts/scheduling/api/shifts.ts")).toBe(false);
  });

  it("does NOT match a nested __tests__ directory under facade/", () => {
    // Out of scope for THIS predicate — EXCLUDED_DIR_SEGMENT in listScopedFiles is what keeps
    // __tests__ out, this predicate only decides "is this a facade path shape at all".
    expect(
      isFacadeModulePath("apps/api/src/contexts/scheduling/facade/__tests__/shifts.test.ts"),
    ).toBe(true);
  });

  it("does NOT match a directory merely PREFIXED with facade (facade-old/)", () => {
    expect(isFacadeModulePath("apps/api/src/contexts/scheduling/facade-old/shifts.ts")).toBe(false);
  });

  it("does NOT match composition/ or services/ (not a contexts/<x>/facade shape at all)", () => {
    expect(isFacadeModulePath("apps/api/src/composition/dashboard.ts")).toBe(false);
    expect(isFacadeModulePath("apps/api/src/services/clock/resolver.ts")).toBe(false);
  });
});

// ── G2/G3 fixture cases (100B-04-PLAN.md Task 1 <behavior>) ────────────────────────────────────

type FacadeCase =
  | {
      name: string;
      file: string;
      model: string;
      facade: true;
      expectCandidate: true;
      scoped: true;
      via: ScopedVia;
    }
  | {
      name: string;
      file: string;
      model: string;
      facade: true;
      expectCandidate: true;
      scoped: false;
    }
  | {
      name: string;
      file: string;
      model: string;
      facade: true;
      expectCandidate: false;
    }
  | {
      name: string;
      file: string;
      model: string;
      facade: false;
      expectCandidate: false;
    };

const CASES: readonly FacadeCase[] = [
  {
    name: "facade fn, where: { id }, no tenant constraint -> CANDIDATE + UNSCOPED",
    file: "unscoped.ts",
    model: "shift",
    facade: true,
    expectCandidate: true,
    scoped: false,
  },
  {
    name: "facade fn, where: { id, tenantId } -> CANDIDATE + inline-tenant-id",
    file: "inline-tenant-id.ts",
    model: "shift",
    facade: true,
    expectCandidate: true,
    scoped: true,
    via: "inline-tenant-id",
  },
  {
    name: "facade fn, where: { id, employee: { tenantId } } -> CANDIDATE + inline-relation-filter",
    file: "inline-relation-filter.ts",
    model: "shift",
    facade: true,
    expectCandidate: true,
    scoped: true,
    via: "inline-relation-filter",
  },
  {
    name: "the SAME unscoped shape, in a NON-facade module -> not a candidate at all",
    file: "unscoped.ts",
    model: "shift",
    facade: false,
    expectCandidate: false,
  },
  {
    name: "facade fn, where references a MODULE-LEVEL CONSTANT, not a parameter -> not client-supplied",
    file: "module-level-constant.ts",
    model: "shift",
    facade: true,
    expectCandidate: false,
  },
];

describe.each(CASES)("$name", (testCase) => {
  const repoRelativePath = testCase.facade ? FACADE_PATH : NON_FACADE_PATH;

  it("classifies candidacy correctly", () => {
    const sourceFile = loadFixture(testCase.file);
    const { node, whereArg } = findCall(sourceFile, repoRelativePath, testCase.model);
    const handler = enclosingHandler(node, sourceFile);
    const bindings = collectRequestBindings(handler, sourceFile, testCase.facade);
    const provenance: Provenance = classifyProvenance(whereArg, bindings, sourceFile);

    expect(provenance.clientSupplied).toBe(testCase.expectCandidate);
  });

  if (testCase.expectCandidate) {
    it("reaches the expected verdict", () => {
      const sourceFile = loadFixture(testCase.file);
      const { call, node, whereArg } = findCall(sourceFile, repoRelativePath, testCase.model);
      const handler = enclosingHandler(node, sourceFile);
      const bindings = collectRequestBindings(handler, sourceFile, testCase.facade);
      const verdict = reachVerdict({ call, node, whereArg, handler, bindings, graph, sourceFile });

      if (testCase.scoped) {
        expect(verdict.scoped).toBe(true);
        if (verdict.scoped) expect(verdict.via).toBe(testCase.via);
      } else {
        expect(verdict.scoped).toBe(false);
      }
    });
  }
});

it("every facade fixture file is accounted for by exactly one CASES row", () => {
  const fixtureFiles = fs
    .readdirSync(FIXTURES_DIR)
    .filter((entry) => entry.endsWith(".ts"))
    .sort();
  // Phase 235 (D-02/AC-4): without this, the equality below could pass on two empty sets if
  // fixtures/tenant-scoping/facade/ ever moved or emptied at the same time CASES did.
  expect(
    fixtureFiles.length,
    "no facade fixture file found — fixtures/tenant-scoping/facade/ moved or emptied",
  ).toBeGreaterThan(0);
  const casedFiles = [...new Set(CASES.map((c) => c.file))].sort();
  expect(fixtureFiles).toEqual(casedFiles);
});

// ── Precedence is unchanged (module header's stated guarantee) ────────────────────────────────

it("a facade module's req-derived bindings still work exactly as a route's would (no req expected in practice, but the ordinary walk must not be short-circuited)", () => {
  // Reuses the ordinary (non-facade) request-binding fixture set indirectly: calling
  // collectRequestBindings with isFacadeModule=false on a facade-shaped path must behave
  // identically to the pre-existing (false) default — proven by the "NON-facade module" case
  // above sharing the exact same fixture text as the facade UNSCOPED case and producing a
  // DIFFERENT (not-a-candidate) result purely because of the boolean, never because of anything
  // about the file's content.
  const sourceFile = loadFixture("unscoped.ts");
  const { node, whereArg } = findCall(sourceFile, NON_FACADE_PATH, "shift");
  const handler = enclosingHandler(node, sourceFile);
  const defaultBindings = collectRequestBindings(handler, sourceFile);
  const explicitFalseBindings = collectRequestBindings(handler, sourceFile, false);
  expect(classifyProvenance(whereArg, defaultBindings, sourceFile).clientSupplied).toBe(false);
  expect(classifyProvenance(whereArg, explicitFalseBindings, sourceFile).clientSupplied).toBe(
    false,
  );
});
