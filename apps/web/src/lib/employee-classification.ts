// Personalstruktur (Phase 41) — frozen default-map for the 7 EmployeeClassification
// values. The Admin-UI auto-fills coverageWeight + requiresSupervision when the
// classification changes, but the user can override either independently.
//
// Per DD-02: hardcoded (not TenantConfig-konfigurierbar) — user explicitly chose
// this for v1.6. Revisit if a tenant has genuinely different defaults.
//
// Keep this enum in sync with prisma/schema.prisma EmployeeClassification AND
// apps/api/src/routes/employees.ts employeeClassificationSchema.

export type EmployeeClassification =
  | "VOLLZEIT"
  | "TEILZEIT"
  | "MINIJOB"
  | "AZUBI"
  | "AUSHILFE"
  | "WERKSTUDENT"
  | "PRAKTIKANT";

export interface ClassificationDefaults {
  coverageWeight: number;
  requiresSupervision: boolean;
}

// DD-02 default-map — frozen to prevent accidental mutation at runtime.
export const CLASSIFICATION_DEFAULTS: Readonly<
  Record<EmployeeClassification, ClassificationDefaults>
> = Object.freeze({
  VOLLZEIT: { coverageWeight: 1.0, requiresSupervision: false },
  TEILZEIT: { coverageWeight: 1.0, requiresSupervision: false },
  MINIJOB: { coverageWeight: 0.5, requiresSupervision: false },
  AUSHILFE: { coverageWeight: 0.5, requiresSupervision: false },
  WERKSTUDENT: { coverageWeight: 0.5, requiresSupervision: false },
  AZUBI: { coverageWeight: 0.0, requiresSupervision: true },
  PRAKTIKANT: { coverageWeight: 0.0, requiresSupervision: true },
});

// DD-09 — German display labels for the Admin-UI dropdown.
export const CLASSIFICATION_LABELS: Readonly<Record<EmployeeClassification, string>> =
  Object.freeze({
    VOLLZEIT: "Vollzeit",
    TEILZEIT: "Teilzeit",
    MINIJOB: "Minijob",
    AZUBI: "Auszubildende:r",
    AUSHILFE: "Aushilfe",
    WERKSTUDENT: "Werkstudent:in",
    PRAKTIKANT: "Praktikant:in",
  });

// Ordered list for stable dropdown rendering (matches DD-02 table order).
export const CLASSIFICATION_OPTIONS: readonly EmployeeClassification[] = [
  "VOLLZEIT",
  "TEILZEIT",
  "MINIJOB",
  "AZUBI",
  "AUSHILFE",
  "WERKSTUDENT",
  "PRAKTIKANT",
];

/** Return the default coverageWeight + requiresSupervision for a classification. */
export function applyDefaults(classification: EmployeeClassification): ClassificationDefaults {
  return CLASSIFICATION_DEFAULTS[classification];
}

/**
 * True when the current values diverge from the classification's default-map entry —
 * used by the Admin-UI to render the "Manuell überschrieben" badge per DD-03.
 *
 * Numeric tolerance: 1e-6 covers Decimal-to-Number round-trip noise.
 */
export function isOverridden(
  classification: EmployeeClassification,
  field: "coverageWeight" | "requiresSupervision",
  value: number | boolean,
): boolean {
  const defaults = applyDefaults(classification);
  if (field === "coverageWeight") {
    return Math.abs(Number(value) - defaults.coverageWeight) > 1e-6;
  }
  return Boolean(value) !== defaults.requiresSupervision;
}
