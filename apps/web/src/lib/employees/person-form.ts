// Issue #854 (plan 854-20) - the pure model of the „Person“ tab of the employee detail: which keys a
// section owns, the form values of a stored employee, the validation and the PATCH body of each
// section. The tab keeps a snapshot and the live values (`$lib/settings/section-state`); a section
// sends exactly its own keys, never the whole record (D-854-04, #878).
//
// The server stays the authority for every rule (statutory vacation minimum, unique employee number,
// pro-rata warning); the checks here only save a round trip.

import { applyDefaults, type EmployeeClassification } from "$lib/employee-classification";

/** The part of the employee record the Person tab reads. */
export interface PersonEmployee {
  id: string;
  firstName: string;
  lastName: string;
  employeeNumber?: string;
  nfcCardId?: string | null;
  exitDate?: string | null;
  birthDate?: string | null;
  classification?: EmployeeClassification;
  coverageWeight?: number | string | null;
  requiresSupervision?: boolean;
  annualVacationDays?: number | string | null;
  isTimeTrackingExempt?: boolean;
}

/** What the sections show and compare against; a date is an ISO day or null, a blank text is "". */
export type PersonValues = {
  firstName: string;
  lastName: string;
  employeeNumber: string;
  birthDate: string | null;
  nfcCardId: string;
  classification: EmployeeClassification;
  coverageWeight: number | null;
  requiresSupervision: boolean;
  exitDate: string | null;
  annualVacationDays: number | null;
};

/** „Persönliche Daten“: the keys of that section. */
export const IDENTITY_KEYS = [
  "firstName",
  "lastName",
  "employeeNumber",
  "birthDate",
  "nfcCardId",
] as const satisfies readonly (keyof PersonValues)[];

/** „Personalstruktur“: the keys of that section. */
export const STRUCTURE_KEYS = [
  "classification",
  "coverageWeight",
  "requiresSupervision",
] as const satisfies readonly (keyof PersonValues)[];

/** „Austritt und Urlaubsbasis“: the keys of that section. */
export const EMPLOYMENT_KEYS = [
  "exitDate",
  "annualVacationDays",
] as const satisfies readonly (keyof PersonValues)[];

/** The calendar day of a stored timestamp (`2026-03-01T00:00:00.000Z` -> `2026-03-01`), or null. */
export function dayOf(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const day = String(stored).split("T")[0];
  return day === "" ? null : day;
}

function numberOrNull(value: number | string | null | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The form values of a stored employee. A missing coverage weight falls back to the classification's default. */
export function personValuesOf(employee: PersonEmployee): PersonValues {
  const classification = employee.classification ?? "VOLLZEIT";
  const defaults = applyDefaults(classification);
  return {
    firstName: employee.firstName ?? "",
    lastName: employee.lastName ?? "",
    employeeNumber: employee.employeeNumber ?? "",
    birthDate: dayOf(employee.birthDate),
    nfcCardId: employee.nfcCardId ?? "",
    classification,
    coverageWeight: numberOrNull(employee.coverageWeight) ?? defaults.coverageWeight,
    requiresSupervision: employee.requiresSupervision ?? defaults.requiresSupervision,
    exitDate: dayOf(employee.exitDate),
    // Issue #482: null = the classification's own Standard, resolved server-side.
    annualVacationDays: numberOrNull(employee.annualVacationDays),
  };
}

/** An ISO day as the UTC-midnight timestamp the API stores (`new Date("2026-03-01")` is UTC midnight). */
function dayToTimestamp(day: string | null): string | null {
  return day ? new Date(day).toISOString() : null;
}

/** The PATCH body of „Persönliche Daten“. */
export function identityPatch(values: PersonValues) {
  return {
    firstName: values.firstName.trim(),
    lastName: values.lastName.trim(),
    employeeNumber: values.employeeNumber.trim(),
    birthDate: dayToTimestamp(values.birthDate),
    nfcCardId: values.nfcCardId.trim() === "" ? null : values.nfcCardId.trim(),
  };
}

/** The PATCH body of „Personalstruktur“. */
export function structurePatch(values: PersonValues) {
  return {
    classification: values.classification,
    // Validated before the call, so a missing value cannot reach the body.
    coverageWeight: values.coverageWeight as number,
    requiresSupervision: values.requiresSupervision,
  };
}

/** The PATCH body of „Austritt und Urlaubsbasis“. */
export function employmentPatch(values: PersonValues) {
  return {
    exitDate: dayToTimestamp(values.exitDate),
    // Issue #482 (G-5): null = back to the classification's own Standard.
    annualVacationDays: values.annualVacationDays ?? null,
  };
}

export type PersonErrors = Partial<Record<keyof PersonValues, string>>;

/** Client-side messages of „Persönliche Daten“. */
export function identityErrors(values: PersonValues): PersonErrors {
  const errors: PersonErrors = {};
  if (values.firstName.trim() === "") errors.firstName = "Gib den Vornamen ein.";
  if (values.lastName.trim() === "") errors.lastName = "Gib den Nachnamen ein.";
  if (values.employeeNumber.trim() === "") {
    errors.employeeNumber = "Gib die Mitarbeiter-Nr. ein.";
  }
  return errors;
}

/** Client-side messages of „Personalstruktur“. */
export function structureErrors(values: PersonValues): PersonErrors {
  const errors: PersonErrors = {};
  const weight = values.coverageWeight;
  if (weight === null || !Number.isFinite(weight) || weight < 0 || weight > 9.99) {
    errors.coverageWeight = "Gib ein Schicht-Gewicht zwischen 0 und 9,99 ein.";
  }
  return errors;
}

/** Client-side messages of „Austritt und Urlaubsbasis“. */
export function employmentErrors(values: PersonValues): PersonErrors {
  const errors: PersonErrors = {};
  const days = values.annualVacationDays;
  if (days !== null && (!Number.isFinite(days) || days < 0.5 || days > 365)) {
    errors.annualVacationDays = "Gib Urlaubstage zwischen 0,5 und 365 ein.";
  }
  return errors;
}

/** The weight and supervision flag a classification brings by default. */
export function structureDefaultsFor(classification: EmployeeClassification) {
  return applyDefaults(classification);
}
