// Phase 41 — DD-02 default-map regression guard.
// Locks the hardcoded (coverageWeight, requiresSupervision) defaults for every
// EmployeeClassification value so a future contributor cannot silently change
// them. If a tenant truly needs different defaults, promote the map to
// TenantConfig (DD-02 deferred) — do NOT edit the constant.

import { describe, it, expect } from "vitest";
import {
  CLASSIFICATION_DEFAULTS,
  CLASSIFICATION_LABELS,
  CLASSIFICATION_OPTIONS,
  applyDefaults,
  isOverridden,
  type EmployeeClassification,
} from "../employee-classification";

describe("employee-classification default-map (Phase 41 DD-02)", () => {
  it("VOLLZEIT → coverageWeight 1.00, requiresSupervision false", () => {
    expect(applyDefaults("VOLLZEIT")).toEqual({ coverageWeight: 1.0, requiresSupervision: false });
  });

  it("TEILZEIT → coverageWeight 1.00, requiresSupervision false", () => {
    expect(applyDefaults("TEILZEIT")).toEqual({ coverageWeight: 1.0, requiresSupervision: false });
  });

  it("MINIJOB → coverageWeight 0.50, requiresSupervision false", () => {
    expect(applyDefaults("MINIJOB")).toEqual({ coverageWeight: 0.5, requiresSupervision: false });
  });

  it("AUSHILFE → coverageWeight 0.50, requiresSupervision false", () => {
    expect(applyDefaults("AUSHILFE")).toEqual({ coverageWeight: 0.5, requiresSupervision: false });
  });

  it("WERKSTUDENT → coverageWeight 0.50, requiresSupervision false", () => {
    expect(applyDefaults("WERKSTUDENT")).toEqual({
      coverageWeight: 0.5,
      requiresSupervision: false,
    });
  });

  it("AZUBI → coverageWeight 0.00, requiresSupervision true", () => {
    expect(applyDefaults("AZUBI")).toEqual({ coverageWeight: 0.0, requiresSupervision: true });
  });

  it("PRAKTIKANT → coverageWeight 0.00, requiresSupervision true", () => {
    expect(applyDefaults("PRAKTIKANT")).toEqual({ coverageWeight: 0.0, requiresSupervision: true });
  });

  it("CLASSIFICATION_OPTIONS lists all 7 classifications exactly once", () => {
    expect(CLASSIFICATION_OPTIONS).toEqual([
      "VOLLZEIT",
      "TEILZEIT",
      "MINIJOB",
      "AZUBI",
      "AUSHILFE",
      "WERKSTUDENT",
      "PRAKTIKANT",
    ]);
    expect(new Set(CLASSIFICATION_OPTIONS).size).toBe(7);
  });

  it("every CLASSIFICATION_OPTIONS entry has a label and a defaults entry", () => {
    for (const opt of CLASSIFICATION_OPTIONS) {
      expect(CLASSIFICATION_LABELS[opt]).toBeTruthy();
      expect(CLASSIFICATION_DEFAULTS[opt]).toBeDefined();
    }
  });

  it("German labels match DD-09 verbatim (gender-neutral colon-suffix where applicable)", () => {
    expect(CLASSIFICATION_LABELS.VOLLZEIT).toBe("Vollzeit");
    expect(CLASSIFICATION_LABELS.TEILZEIT).toBe("Teilzeit");
    expect(CLASSIFICATION_LABELS.MINIJOB).toBe("Minijob");
    expect(CLASSIFICATION_LABELS.AZUBI).toBe("Auszubildende:r");
    expect(CLASSIFICATION_LABELS.AUSHILFE).toBe("Aushilfe");
    expect(CLASSIFICATION_LABELS.WERKSTUDENT).toBe("Werkstudent:in");
    expect(CLASSIFICATION_LABELS.PRAKTIKANT).toBe("Praktikant:in");
  });

  it("CLASSIFICATION_DEFAULTS is frozen (DD-02: hardcoded, no runtime mutation)", () => {
    expect(Object.isFrozen(CLASSIFICATION_DEFAULTS)).toBe(true);
  });
});

describe("isOverridden helper (Phase 41 DD-03)", () => {
  it("returns false when coverageWeight matches the default exactly", () => {
    expect(isOverridden("VOLLZEIT", "coverageWeight", 1.0)).toBe(false);
    expect(isOverridden("MINIJOB", "coverageWeight", 0.5)).toBe(false);
    expect(isOverridden("AZUBI", "coverageWeight", 0.0)).toBe(false);
  });

  it("returns true when coverageWeight deviates from the default", () => {
    expect(isOverridden("VOLLZEIT", "coverageWeight", 0.75)).toBe(true);
    expect(isOverridden("MINIJOB", "coverageWeight", 0.6)).toBe(true);
    expect(isOverridden("AZUBI", "coverageWeight", 0.25)).toBe(true);
  });

  it("tolerates 1e-6 float noise from Decimal-to-Number round-trip", () => {
    expect(isOverridden("VOLLZEIT", "coverageWeight", 1.0 + 1e-9)).toBe(false);
    expect(isOverridden("MINIJOB", "coverageWeight", 0.5 - 1e-9)).toBe(false);
  });

  it("returns false when requiresSupervision matches the default", () => {
    expect(isOverridden("VOLLZEIT", "requiresSupervision", false)).toBe(false);
    expect(isOverridden("AZUBI", "requiresSupervision", true)).toBe(false);
    expect(isOverridden("PRAKTIKANT", "requiresSupervision", true)).toBe(false);
  });

  it("returns true when requiresSupervision deviates from the default", () => {
    expect(isOverridden("VOLLZEIT", "requiresSupervision", true)).toBe(true);
    expect(isOverridden("AZUBI", "requiresSupervision", false)).toBe(true);
  });

  it("re-applying defaults after override yields a non-overridden state", () => {
    const cls: EmployeeClassification = "AZUBI";
    const def = applyDefaults(cls);
    expect(isOverridden(cls, "coverageWeight", def.coverageWeight)).toBe(false);
    expect(isOverridden(cls, "requiresSupervision", def.requiresSupervision)).toBe(false);
  });
});
