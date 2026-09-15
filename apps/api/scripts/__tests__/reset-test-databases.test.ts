/**
 * Phase 106 Plan 03 — unit tests for the drop-gates this repository has. Phase 132 (D-11) adds a
 * third gate, `mayPruneDatabase`, and makes `mayRollbackDrop` take an explicit `workerNames`
 * parameter and the two name sets (`MAIN_WORKERS`/`NS_WORKERS`) namespace-parameterised on
 * purpose — see the comment above their declaration below.
 *
 * DB-free: imports ONLY the pure exported gate functions. This is true only because
 * `reset-test-databases.ts`'s trailing `main()` invocation is guarded by an
 * `import.meta.url === pathToFileURL(process.argv[1]).href` check (GH #203) — before that guard
 * existed, this exact import silently re-ran the real script's `main()` on every vitest run (local
 * or CI), performing a genuine `DROP DATABASE ... WITH (FORCE)` against the live per-worker test
 * databases mid-suite. That defect shipped with this file at Phase 106 and went undetected until
 * 2026-09; do not remove the guard to "simplify" this import. See
 * `scripts/__tests__/script-import-safety.test.ts` for the regression test that proves the guard
 * holds. Conventions follow scripts/__tests__/audit-saldo-chain-integrity.test.ts: describe/it
 * shape, no mocking framework, no hardcoded calendar date anywhere.
 */
import { describe, it, expect } from "vitest";
import { mayDropDatabase, mayRollbackDrop, mayPruneDatabase } from "../reset-test-databases";
import {
  TEST_DATABASE_MARKER,
  TEST_DATABASE_NAME,
  isWorkerDatabaseName,
  workerDatabaseNames,
} from "../../src/utils/test-database";

// Both name sets are pinned to an EXPLICIT namespace argument rather than the resolved default.
// These are pure-function tests; if they took the ambient namespace they would silently assert
// something different depending on whether the suite happens to be running inside a worktree.
const MAIN_WORKERS = workerDatabaseNames("");
const NS = "a1b2c3d4";
const NS_WORKERS = workerDatabaseNames(NS);
const VALID_MARKER = `${TEST_DATABASE_MARKER} — provisioned by …`;

describe("mayDropDatabase (Phase 106, D-07 — the only DROP-capable gate in this repo)", () => {
  it("allows a worker database carrying the marker", () => {
    expect(mayDropDatabase("clokr_test_1", `${TEST_DATABASE_MARKER} — provisioned by …`)).toBe(
      true,
    );
  });

  it("refuses the template even with a valid marker (never dropped by this script)", () => {
    expect(mayDropDatabase("clokr_test", `${TEST_DATABASE_MARKER} — provisioned by …`)).toBe(false);
  });

  it("refuses the dev database with no marker", () => {
    expect(mayDropDatabase("clokr", null)).toBe(false);
  });

  it("refuses the dev database even with a valid-looking marker (name fails)", () => {
    expect(mayDropDatabase("clokr", `${TEST_DATABASE_MARKER} — provisioned by …`)).toBe(false);
  });

  it("refuses a worker database with no marker — refuse loudly, do not drop", () => {
    expect(mayDropDatabase("clokr_test_1", null)).toBe(false);
  });

  it("refuses a worker database with an unrelated marker string", () => {
    expect(mayDropDatabase("clokr_test_1", "something-else")).toBe(false);
  });

  it("refuses an unanchored near-miss name even with a valid marker (D-06)", () => {
    expect(
      mayDropDatabase("clokr_test_kopie_von_prod", `${TEST_DATABASE_MARKER} — provisioned by …`),
    ).toBe(false);
  });

  it("refuses a marker that merely contains the marker string but does not start with it", () => {
    expect(mayDropDatabase("clokr_test_1", `not-really-${TEST_DATABASE_MARKER}`)).toBe(false);
  });

  it("refuses a namespaced TEMPLATE even with a valid marker — a template is not a worker (Phase 132)", () => {
    // This is the assertion that would have caught the pre-plan-01 not-equal-to-one-literal bug:
    // isWorkerDatabaseName used to be `isTestDatabaseName(name) && name !== TEST_DATABASE_NAME`,
    // which misclassifies a namespaced TEMPLATE (not equal to the unnamespaced constant) as a
    // worker.
    expect(mayDropDatabase("clokr_test_a1b2c3d4", VALID_MARKER)).toBe(false);
  });

  it("refuses an unanchored near-miss built from a namespaced prefix", () => {
    expect(mayDropDatabase(`clokr_test_${NS}_kopie`, VALID_MARKER)).toBe(false);
  });
});

describe("mayRollbackDrop (WR-01 — the marker-stamp rollback path)", () => {
  it("allows a worker database this run derived from the template", () => {
    expect(mayRollbackDrop(MAIN_WORKERS[0], MAIN_WORKERS)).toBe(true);
  });

  it("refuses the dev database", () => {
    expect(mayRollbackDrop("clokr", MAIN_WORKERS)).toBe(false);
  });

  it("refuses the template — it must survive every reset", () => {
    expect(mayRollbackDrop(TEST_DATABASE_NAME, MAIN_WORKERS)).toBe(false);
  });

  it("refuses a worker-shaped name outside the set this run derived", () => {
    // Namespace-valid, but not one of the N names MAIN_WORKERS holds.
    const outOfSet = `clokr_test_${MAIN_WORKERS.length + 99}`;
    expect(isWorkerDatabaseName(outOfSet)).toBe(true);
    expect(mayRollbackDrop(outOfSet, MAIN_WORKERS)).toBe(false);
  });

  it("refuses an unanchored near-miss name", () => {
    expect(mayRollbackDrop("clokr_test_kopie_von_prod", MAIN_WORKERS)).toBe(false);
    expect(mayRollbackDrop("myclokr_test", MAIN_WORKERS)).toBe(false);
  });

  it("allows a worker database from a NAMESPACED run's own worker-name set", () => {
    expect(mayRollbackDrop(NS_WORKERS[0], NS_WORKERS)).toBe(true);
  });

  it("refuses a foreign namespace's worker database — D-10 as a unit test", () => {
    // A run in the main-tree namespace ("") must not be able to roll back a worker database
    // belonging to a different (namespaced) run, even though the name is worker-shaped.
    expect(mayRollbackDrop(MAIN_WORKERS[0], NS_WORKERS)).toBe(false);
  });

  it("refuses a namespaced TEMPLATE — a template is not a worker (Phase 132)", () => {
    expect(mayRollbackDrop(`clokr_test_${NS}`, NS_WORKERS)).toBe(false);
  });
});

describe("mayPruneDatabase (Phase 132, D-11 — the orphan-namespace gate)", () => {
  it("allows a foreign-namespace worker database with a dead provenance and a valid marker", () => {
    expect(
      mayPruneDatabase({
        name: "clokr_test_a1b2c3d4_1",
        marker: VALID_MARKER,
        provenanceExists: false,
        ownNamespace: "",
      }),
    ).toBe(true);
  });

  it("refuses when the provenance path still exists — the worktree is still there", () => {
    expect(
      mayPruneDatabase({
        name: "clokr_test_a1b2c3d4_1",
        marker: VALID_MARKER,
        provenanceExists: true,
        ownNamespace: "",
      }),
    ).toBe(false);
  });

  it("refuses an UNKNOWN provenance (no path recorded) — unknown is not orphaned", () => {
    expect(
      mayPruneDatabase({
        name: "clokr_test_a1b2c3d4_1",
        marker: VALID_MARKER,
        provenanceExists: null,
        ownNamespace: "",
      }),
    ).toBe(false);
  });

  it("refuses a null marker", () => {
    expect(
      mayPruneDatabase({
        name: "clokr_test_a1b2c3d4_1",
        marker: null,
        provenanceExists: false,
        ownNamespace: "",
      }),
    ).toBe(false);
  });

  it("refuses an unrelated marker string", () => {
    expect(
      mayPruneDatabase({
        name: "clokr_test_a1b2c3d4_1",
        marker: "something-else",
        provenanceExists: false,
        ownNamespace: "",
      }),
    ).toBe(false);
  });

  it("refuses a marker that merely contains the marker string but does not start with it", () => {
    expect(
      mayPruneDatabase({
        name: "clokr_test_a1b2c3d4_1",
        marker: `not-really-${TEST_DATABASE_MARKER}`,
        provenanceExists: false,
        ownNamespace: "",
      }),
    ).toBe(false);
  });

  it("refuses the main working tree's namespace even when the provenance path is gone — CI and every non-worktree developer live there", () => {
    expect(
      mayPruneDatabase({
        name: "clokr_test",
        marker: VALID_MARKER,
        provenanceExists: false,
        ownNamespace: "some-other-namespace",
      }),
    ).toBe(false);
    expect(
      mayPruneDatabase({
        name: "clokr_test_1",
        marker: VALID_MARKER,
        provenanceExists: false,
        ownNamespace: "some-other-namespace",
      }),
    ).toBe(false);
  });

  it("refuses the caller's OWN namespace, even with a dead-looking provenance path", () => {
    expect(
      mayPruneDatabase({
        name: "clokr_test_a1b2c3d4_1",
        marker: VALID_MARKER,
        provenanceExists: false,
        ownNamespace: "a1b2c3d4",
      }),
    ).toBe(false);
  });

  it("refuses the dev database", () => {
    expect(
      mayPruneDatabase({
        name: "clokr",
        marker: VALID_MARKER,
        provenanceExists: false,
        ownNamespace: "",
      }),
    ).toBe(false);
  });

  it("refuses an unanchored near-miss name even with a dead provenance and a valid marker (D-06)", () => {
    expect(
      mayPruneDatabase({
        name: "clokr_test_kopie_von_prod",
        marker: VALID_MARKER,
        provenanceExists: false,
        ownNamespace: "",
      }),
    ).toBe(false);
  });

  it("allows the one case a template MAY be dropped: a namespaced TEMPLATE in a foreign, dead namespace", () => {
    // Unlike mayDropDatabase/mayRollbackDrop, a namespaced TEMPLATE (workerIndex === null but
    // namespace !== "") IS prunable here — it is not a worker, but it is in a foreign namespace
    // whose provenance is dead, and D-11 is precisely about reclaiming that whole namespace.
    expect(
      mayPruneDatabase({
        name: "clokr_test_a1b2c3d4",
        marker: VALID_MARKER,
        provenanceExists: false,
        ownNamespace: "",
      }),
    ).toBe(true);
  });
});

it("no gate authorizes the dev database or an unanchored near-miss, under any input", () => {
  for (const name of ["clokr", "clokr_test_kopie_von_prod", "myclokr_test", "postgres"]) {
    expect(mayDropDatabase(name, VALID_MARKER)).toBe(false);
    expect(mayRollbackDrop(name, MAIN_WORKERS)).toBe(false);
    expect(mayRollbackDrop(name, NS_WORKERS)).toBe(false);
    expect(
      mayPruneDatabase({ name, marker: VALID_MARKER, provenanceExists: false, ownNamespace: "" }),
    ).toBe(false);
  }
});
