/**
 * Phase 204 Plan 03 — tests for lint-tenant-scoping-verdict.ts.
 *
 * DB-free: fixtures under fixtures/tenant-scoping/verdict/ are parsed with `ts.createSourceFile`,
 * never executed and never type-checked. `buildModelGraph()` is called against the REAL, already
 * generated `@clokr/db` client (no database connection, no `main()`), so a model's classification
 * changing in schema.prisma surfaces here rather than only in a hand-built fixture graph.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { buildModelGraph } from "../lint-tenant-scoping-model-graph";
import { enclosingHandler, collectRequestBindings } from "../lint-tenant-scoping-request-bindings";
import { findPrismaCalls } from "../lint-tenant-scoping-candidates";
import { findInlineScoping, reachVerdict } from "../lint-tenant-scoping-verdict";
import type { RequestBindings, ScopedVia, Verdict } from "../lint-tenant-scoping-types";

const FIXTURES_DIR = path.join(__dirname, "fixtures/tenant-scoping/verdict");
const graph = buildModelGraph();

function loadFixture(file: string): ts.SourceFile {
  const abs = path.join(FIXTURES_DIR, file);
  const text = fs.readFileSync(abs, "utf8");
  return ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);
}

/** Parses one fixture, locates the judged call by model (and optionally method), reaches a verdict. */
function judge(file: string, model: string, method?: string): Verdict {
  const sourceFile = loadFixture(file);
  const calls = findPrismaCalls(sourceFile, file);
  const target = method
    ? calls.find((c) => c.call.model === model && c.call.method === method)
    : calls.find((c) => c.call.model === model);
  if (!target) {
    throw new Error(
      `expected a "${model}"${method ? `.${method}` : ""} call in ${file}, found: ${calls
        .map((c) => `${c.call.model}.${c.call.method}`)
        .join(", ")}`,
    );
  }
  const handler = enclosingHandler(target.node, sourceFile);
  const bindings = collectRequestBindings(handler, sourceFile);
  return reachVerdict({
    call: target.call,
    node: target.node,
    whereArg: target.whereArg,
    handler,
    bindings,
    graph,
    sourceFile,
  });
}

// ── One row per call shape named in RESEARCH.md §Architecture Patterns, plus the three
// adversarial negatives (204-03-PLAN.md <behavior>) ──────────────────────────────────────────

type Case =
  | { file: string; model: string; method?: string; scoped: true; via: ScopedVia }
  | {
      file: string;
      model: string;
      method?: string;
      scoped: false;
      detailContains: readonly string[];
    };

const CASES: readonly Case[] = [
  {
    file: "shape1-inline-tenant-id.ts",
    model: "shiftTemplate",
    scoped: true,
    via: "inline-tenant-id",
  },
  {
    file: "shape2-relation-filter.ts",
    model: "shift",
    scoped: true,
    via: "inline-relation-filter",
  },
  {
    file: "shape2b-nested-relation-filter.ts",
    model: "auditLog",
    scoped: true,
    via: "inline-relation-filter",
  },
  {
    file: "shape1b-principal-field.ts",
    model: "notification",
    scoped: true,
    via: "inline-principal-field",
  },
  {
    file: "shape6-fetch-then-compare.ts",
    model: "timeEntry",
    scoped: true,
    via: "fetch-then-compare",
  },
  {
    file: "shape6b-aliased-principal.ts",
    model: "timeEntry",
    scoped: true,
    via: "fetch-then-compare",
  },
  {
    file: "shape6d-promise-all-destructure.ts",
    model: "employee",
    method: "findUnique",
    scoped: true,
    via: "fetch-then-compare",
  },
  {
    file: "shape6c-guard-fetch.ts",
    model: "coverageRule",
    method: "update",
    scoped: true,
    via: "guard-fetch",
  },
  {
    file: "shape7-chained-validation.ts",
    model: "break",
    scoped: false,
    detailContains: ["D-16", "chained validation across model boundaries"],
  },
  {
    file: "unscoped-findunique.ts",
    model: "coverageRule",
    method: "findFirst",
    scoped: false,
    detailContains: ["no tenant scoping found"],
  },
  {
    file: "unscoped-update-after-unrelated-check.ts",
    model: "presenceDevice",
    method: "update",
    scoped: false,
    detailContains: ["no tenant scoping found"],
  },
  {
    file: "unscoped-compare-to-client-value.ts",
    model: "leaveType",
    method: "update",
    scoped: false,
    detailContains: ["no tenant scoping found"],
  },
  // CR-01 (204-REVIEW.md): a tenant comparison that exists but never gates anything must not be
  // accepted as fetch-then-compare.
  {
    file: "unused-comparison-no-gate.ts",
    model: "leaveType",
    method: "update",
    scoped: false,
    detailContains: ["no tenant scoping found"],
  },
  {
    file: "non-returning-if-branch.ts",
    model: "leaveType",
    method: "update",
    scoped: false,
    detailContains: ["no tenant scoping found"],
  },
  // CR-02 (204-REVIEW.md): guard/identifier searches must respect function-scope boundaries.
  {
    file: "guard-inside-nested-closure.ts",
    model: "coverageRule",
    method: "update",
    scoped: false,
    detailContains: ["no tenant scoping found"],
  },
  {
    file: "shadowed-identifier-nested-helper.ts",
    model: "coverageRule",
    method: "update",
    scoped: false,
    detailContains: ["no tenant scoping found"],
  },
];

describe.each(CASES)("verdict fixture: $file", (testCase) => {
  it(`reaches the expected verdict for ${testCase.model}${testCase.method ? `.${testCase.method}` : ""}`, () => {
    const verdict = judge(testCase.file, testCase.model, testCase.method);

    expect(verdict.scoped).toBe(testCase.scoped);

    if (testCase.scoped) {
      // Asserting `via` exactly, not just `scoped: true` — a wrong-reason acceptance (right
      // answer, different path) is a defect too (T-204-15), and boolean-only assertions hide it.
      expect(verdict.scoped && verdict.via).toBe(testCase.via);
    } else {
      expect(verdict.detail.length).toBeGreaterThan(0);
      for (const substring of testCase.detailContains) {
        expect(verdict.detail).toContain(substring);
      }
    }
  });
});

it("every verdict fixture file is accounted for by exactly one CASES row", () => {
  const fixtureFiles = fs
    .readdirSync(FIXTURES_DIR)
    .filter((entry) => entry.endsWith(".ts"))
    .sort();
  // Phase 235 (D-02/AC-4): without this, the equality below could pass on two empty sets if
  // fixtures/tenant-scoping/verdict/ ever moved or emptied at the same time CASES did.
  expect(
    fixtureFiles.length,
    "no verdict fixture file found — fixtures/tenant-scoping/verdict/ moved or emptied",
  ).toBeGreaterThan(0);
  const casedFiles = [...new Set(CASES.map((c) => c.file))].sort();
  expect(fixtureFiles).toEqual(casedFiles);
});

it("every NOT-scoped case's detail names at least one of the three D-13 ways that were looked for", () => {
  const notScopedCases = CASES.filter(
    (c): c is Extract<Case, { scoped: false }> => c.scoped === false,
  );
  expect(notScopedCases.length).toBeGreaterThan(0);
  for (const testCase of notScopedCases) {
    const verdict = judge(testCase.file, testCase.model, testCase.method);
    if (verdict.scoped) throw new Error(`expected NOT scoped for ${testCase.file}`);
    // The generic branch of reachVerdict always names all three ways by construction.
    expect(verdict.detail).toContain("tenantId");
    expect(verdict.detail).toMatch(/fetch-then-compare/);
    expect(verdict.detail).toMatch(/guard-fetch/);
  }
});

// ── Direct unit coverage of findInlineScoping's "model has no tenant relevance" branch ─────────
// None of the 11 fixtures above judge a call on `Tenant` itself (the ticket's own scope is
// routes/services calling tenant-SCOPED models; Tenant is the multi-tenancy root, not a resource
// a route reads by client-supplied id) — this exercises that branch directly instead of leaving
// it fixture-less.

const EMPTY_BINDINGS: RequestBindings = {
  clientSupplied: new Set(),
  principalObjects: new Set(),
  principalFields: new Map(),
};

it("findInlineScoping treats a model with ModelTenancy kind 'none' (Tenant) as scoped without a where constraint", () => {
  const sourceFile = ts.createSourceFile("inline.ts", "", ts.ScriptTarget.Latest, true);
  const verdict = findInlineScoping(null, "tenant", graph, EMPTY_BINDINGS, sourceFile);
  expect(verdict).not.toBeNull();
  expect(verdict?.scoped).toBe(true);
  expect(verdict && verdict.scoped && verdict.via).toBe("inline-tenant-id");
  expect(verdict?.detail).toContain("no tenant relevance");
});
