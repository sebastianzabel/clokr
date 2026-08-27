/**
 * Phase 106 Plan 03 — unit tests for the two drop-gates this repository has:
 * `mayDropDatabase` (reset path) and `mayRollbackDrop` (marker-stamp rollback path, WR-01).
 *
 * DB-free: imports ONLY the pure exported gate function. Conventions follow
 * scripts/__tests__/audit-saldo-chain-integrity.test.ts: describe/it shape, no mocking
 * framework, no hardcoded calendar date anywhere.
 */
import { describe, it, expect } from "vitest";
import { mayDropDatabase, mayRollbackDrop } from "../reset-test-databases";
import {
  TEST_DATABASE_MARKER,
  TEST_DATABASE_NAME,
  WORKER_DATABASE_NAMES,
  isWorkerDatabaseName,
} from "../../src/utils/test-database";

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
});

describe("mayRollbackDrop (WR-01 — the marker-stamp rollback path)", () => {
  it("allows a worker database this run derived from the template", () => {
    expect(mayRollbackDrop(WORKER_DATABASE_NAMES[0])).toBe(true);
  });

  it("refuses the dev database", () => {
    expect(mayRollbackDrop("clokr")).toBe(false);
  });

  it("refuses the template — it must survive every reset", () => {
    expect(mayRollbackDrop(TEST_DATABASE_NAME)).toBe(false);
  });

  it("refuses a worker-shaped name outside the set this run derived", () => {
    // Namespace-valid, but not one of the N names WORKER_DATABASE_NAMES holds.
    const outOfSet = `clokr_test_${WORKER_DATABASE_NAMES.length + 99}`;
    expect(isWorkerDatabaseName(outOfSet)).toBe(true);
    expect(mayRollbackDrop(outOfSet)).toBe(false);
  });

  it("refuses an unanchored near-miss name", () => {
    expect(mayRollbackDrop("clokr_test_kopie_von_prod")).toBe(false);
    expect(mayRollbackDrop("myclokr_test")).toBe(false);
  });
});
