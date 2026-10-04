// Issue #482 (owner decision 2026-10-04) — DISPLAY mirror of which vacation-days Standard
// (Mandanten-Standard or Azubi-Standard) applies to a given classification. The server's
// resolveVacationBaseDays() (apps/api/src/contexts/absence/leave-days.ts) is the authoritative
// resolver — this module computes no entitlement, it only decides which Standard to SHOW and
// whether a typed value equals that Standard (so it can be collapsed to null before sending the
// create payload, G-5/G-7).

import type { EmployeeClassification } from "./employee-classification";

/**
 * The Standard that applies to `classification`: AZUBI follows the Azubi-Standard
 * (`apprenticeDefault`), every other classification follows the Mandanten-Standard
 * (`tenantDefault`). A `null` input (Standard not loaded yet / tenant has no value) passes
 * through unchanged.
 */
export function vacationBaseDefaultFor(
  classification: EmployeeClassification,
  tenantDefault: number | null,
  apprenticeDefault: number | null,
): number | null {
  return classification === "AZUBI" ? apprenticeDefault : tenantDefault;
}

/**
 * The `annualVacationDays` payload value for `value` given `classification` — collapses to
 * `null` when `value` equals the classification's OWN Standard (G-5, mirrors #435 D-13), so the
 * person keeps following later changes to that Standard instead of freezing today's number as
 * an explicit override. Never collapses against an unknown (`null`) Standard — an unknown
 * Standard cannot be proven equal to anything.
 */
export function annualVacationDaysPayload(
  value: number | null,
  classification: EmployeeClassification,
  tenantDefault: number | null,
  apprenticeDefault: number | null,
): number | null {
  if (value === null) return null;
  const standard = vacationBaseDefaultFor(classification, tenantDefault, apprenticeDefault);
  if (standard !== null && value === standard) return null;
  return value;
}

/**
 * The German placeholder text naming which Standard applies to `classification` — shown in the
 * "Urlaubstage pro Jahr" field when it is empty (AC-6).
 */
export function vacationBaseDefaultPlaceholder(
  classification: EmployeeClassification,
  tenantDefault: number | null,
  apprenticeDefault: number | null,
): string {
  const value = vacationBaseDefaultFor(classification, tenantDefault, apprenticeDefault);
  const label = classification === "AZUBI" ? "Azubi-Standard" : "Mandanten-Standard";
  const formatted =
    value === null ? "unbekannt" : value.toLocaleString("de-DE", { maximumFractionDigits: 2 });
  return `${label} (${formatted})`;
}
