// Phase 79 Plan 01 Task 2 — Unit tests for workEventTypeRules + assertClassificationAllowed.
//
// AZUBI data-gate for VOCATIONAL_SCHOOL — enforced as DATA (table lookup), not
// as hardcoded if-statements (per CONTEXT D-decisions). Phase 80+ adding new
// types becomes a one-line table change.
//
// Pure unit tests — no Fastify, no Prisma. The data table is consumed by the
// POST /work-events handler in Plan 79-03.

import { describe, it, expect } from "vitest";
import { WorkEventType, EmployeeClassification } from "@clokr/db";
import {
  workEventTypeRules,
  assertClassificationAllowed,
  ClassificationNotAllowedError,
  CLASSIFICATION_NOT_ALLOWED_DE_VOCATIONAL_SCHOOL,
} from "../utils/work-event-rules";

describe("workEventTypeRules + assertClassificationAllowed (Phase 79 Plan 01 Task 2)", () => {
  // ── Table-shape tests ──────────────────────────────────────────────────────

  it("Test 1: workEventTypeRules[VOCATIONAL_SCHOOL].allowedClassifications equals ['AZUBI'] exactly", () => {
    const rule = workEventTypeRules[WorkEventType.VOCATIONAL_SCHOOL];
    expect(rule.allowedClassifications).toEqual([EmployeeClassification.AZUBI]);
    expect(rule.allowedClassifications.length).toBe(1);
  });

  it("Test 2: workEventTypeRules[FIELD_SERVICE].allowedClassifications includes every classification (ALL placeholder)", () => {
    const rule = workEventTypeRules[WorkEventType.FIELD_SERVICE];
    // Reserved type — all 7 classifications permitted as placeholder until v1.10+
    expect(rule.allowedClassifications).toContain(EmployeeClassification.VOLLZEIT);
    expect(rule.allowedClassifications).toContain(EmployeeClassification.AZUBI);
    expect(rule.allowedClassifications).toContain(EmployeeClassification.TEILZEIT);
    expect(rule.allowedClassifications).toContain(EmployeeClassification.MINIJOB);
    expect(rule.allowedClassifications).toContain(EmployeeClassification.AUSHILFE);
    expect(rule.allowedClassifications).toContain(EmployeeClassification.WERKSTUDENT);
    expect(rule.allowedClassifications).toContain(EmployeeClassification.PRAKTIKANT);
    expect(rule.allowedClassifications.length).toBe(7);
  });

  it("Test 3: BUSINESS_TRIP / TRAINING / OTHER also default to ALL placeholder (table-driven loop)", () => {
    const reservedTypes = [
      WorkEventType.BUSINESS_TRIP,
      WorkEventType.TRAINING,
      WorkEventType.OTHER,
    ];
    for (const type of reservedTypes) {
      const rule = workEventTypeRules[type];
      expect(rule.allowedClassifications.length).toBe(7);
      expect(rule.allowedClassifications).toContain(EmployeeClassification.VOLLZEIT);
      expect(rule.allowedClassifications).toContain(EmployeeClassification.AZUBI);
      expect(rule.allowedClassifications).toContain(EmployeeClassification.PRAKTIKANT);
    }
  });

  // ── Gate-function tests ────────────────────────────────────────────────────

  it("Test 4: assertClassificationAllowed(VOCATIONAL_SCHOOL, AZUBI) returns void", () => {
    expect(() =>
      assertClassificationAllowed(WorkEventType.VOCATIONAL_SCHOOL, EmployeeClassification.AZUBI),
    ).not.toThrow();
  });

  it("Test 5: assertClassificationAllowed(VOCATIONAL_SCHOOL, VOLLZEIT) throws ClassificationNotAllowedError with German message + statusCode 400", () => {
    let caught: unknown = null;
    try {
      assertClassificationAllowed(WorkEventType.VOCATIONAL_SCHOOL, EmployeeClassification.VOLLZEIT);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClassificationNotAllowedError);
    const err = caught as ClassificationNotAllowedError;
    expect(err.message).toBe("Berufsschule ist nur für Azubis zulässig");
    expect(err.message).toBe(CLASSIFICATION_NOT_ALLOWED_DE_VOCATIONAL_SCHOOL);
    expect(err.statusCode).toBe(400);
    expect(err.name).toBe("ClassificationNotAllowedError");
  });

  it("Test 6: assertClassificationAllowed(FIELD_SERVICE, TEILZEIT) returns void (ALL placeholder covers everyone)", () => {
    expect(() =>
      assertClassificationAllowed(WorkEventType.FIELD_SERVICE, EmployeeClassification.TEILZEIT),
    ).not.toThrow();
    expect(() =>
      assertClassificationAllowed(WorkEventType.OTHER, EmployeeClassification.MINIJOB),
    ).not.toThrow();
    expect(() =>
      assertClassificationAllowed(WorkEventType.TRAINING, EmployeeClassification.WERKSTUDENT),
    ).not.toThrow();
  });

  // ── Data-driven sanity ─────────────────────────────────────────────────────

  it("Test 7: workEventTypeRules is a plain object literal (O(1) table lookup, not if-else)", () => {
    expect(typeof workEventTypeRules).toBe("object");
    expect(workEventTypeRules).not.toBeNull();
    // Every key maps to an object with allowedClassifications array
    for (const type of Object.values(WorkEventType)) {
      const rule = workEventTypeRules[type as WorkEventType];
      expect(rule).toBeDefined();
      expect(Array.isArray(rule.allowedClassifications)).toBe(true);
    }
  });

  it("Test 8: exhaustiveness — every WorkEventType enum value is a key in workEventTypeRules", () => {
    const ruleKeys = Object.keys(workEventTypeRules);
    const enumValues = Object.values(WorkEventType);
    expect(Object.values(WorkEventType).every((k) => k in workEventTypeRules)).toBe(true);
    // Also: no extra keys (avoid drift in the other direction)
    expect(ruleKeys.sort()).toEqual([...enumValues].sort());
  });
});
