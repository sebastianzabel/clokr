// Phase 79 Plan 01 Task 2 — AZUBI data-gate for WorkEvent (API-V19-03).
//
// CONTEXT D-decision: "AZUBI gate enforced as DATA, not code". Adding or
// tightening a WorkEvent type becomes a one-line table change here. Route
// handlers (Plan 79-03) call `assertClassificationAllowed(type, classification)`
// — no per-type if-statements anywhere in the routes layer.
//
// VOCATIONAL_SCHOOL: only AZUBI permitted (BBiG §15 — Berufsschultag is part of
// the apprenticeship contract, not a general workforce concept).
//
// Reserved types (FIELD_SERVICE / BUSINESS_TRIP / TRAINING / OTHER): every
// classification permitted as ALL placeholder. Phase 80+ will tighten these
// per business rule when the types come online.

import { WorkEventType, EmployeeClassification } from "@clokr/db";

/**
 * German error string surfaced when a VOCATIONAL_SCHOOL WorkEvent is attempted
 * for a non-AZUBI employee. Single source of truth for route handlers + BC proxy.
 *
 * Wording follows CONTEXT D — "Berufsschule ist nur für Azubis zulässig". The
 * legacy `vocational-school.ts` route used a longer phrase ("Berufsschultage
 * sind nur für Auszubildende vorgesehen.") — the new constant is the canonical
 * one going forward.
 */
export const CLASSIFICATION_NOT_ALLOWED_DE_VOCATIONAL_SCHOOL =
  "Berufsschule ist nur für Azubis zulässig";

/**
 * Helper enumerating every `EmployeeClassification` value. Used as the "ALL"
 * placeholder for reserved WorkEvent types until v1.10+ tightens per-type rules.
 */
const ALL_CLASSIFICATIONS: readonly EmployeeClassification[] = [
  EmployeeClassification.VOLLZEIT,
  EmployeeClassification.TEILZEIT,
  EmployeeClassification.MINIJOB,
  EmployeeClassification.AZUBI,
  EmployeeClassification.AUSHILFE,
  EmployeeClassification.WERKSTUDENT,
  EmployeeClassification.PRAKTIKANT,
];

/**
 * Per-WorkEventType classification rule. Today only `allowedClassifications`
 * exists; future fields (e.g. `messageDe` per type) can be added without
 * changing call sites.
 */
export type ClassificationRule = {
  readonly allowedClassifications: readonly EmployeeClassification[];
};

/**
 * Data-driven gate table mapping `WorkEventType` → `ClassificationRule`.
 *
 * Adding a new WorkEvent type or relaxing/tightening an existing one is a
 * one-line change here — NO route handler or test modification is required as
 * long as the route just calls `assertClassificationAllowed()`.
 *
 * The exhaustiveness test (Test 8 in work-event-rules.test.ts) asserts that
 * every `WorkEventType` enum value is a key here — a missing key would fail
 * both at TS compile time AND at runtime test.
 */
export const workEventTypeRules: Record<WorkEventType, ClassificationRule> = {
  [WorkEventType.VOCATIONAL_SCHOOL]: {
    allowedClassifications: [EmployeeClassification.AZUBI],
  },
  [WorkEventType.FIELD_SERVICE]: { allowedClassifications: ALL_CLASSIFICATIONS },
  [WorkEventType.BUSINESS_TRIP]: { allowedClassifications: ALL_CLASSIFICATIONS },
  [WorkEventType.TRAINING]: { allowedClassifications: ALL_CLASSIFICATIONS },
  [WorkEventType.OTHER]: { allowedClassifications: ALL_CLASSIFICATIONS },
};

/**
 * Thrown by `assertClassificationAllowed` when the classification is not
 * permitted for the given WorkEvent type. Route handlers catch this and map it
 * to HTTP 400 with the error's German `message` as the response `error` field.
 *
 * `statusCode = 400` is part of the shape so a generic error mapper can route
 * the response without per-error-class knowledge.
 */
export class ClassificationNotAllowedError extends Error {
  readonly statusCode = 400 as const;

  constructor(
    public readonly type: WorkEventType,
    public readonly classification: EmployeeClassification,
    message: string,
  ) {
    super(message);
    this.name = "ClassificationNotAllowedError";
    Object.setPrototypeOf(this, ClassificationNotAllowedError.prototype);
  }
}

/**
 * Throw `ClassificationNotAllowedError` if `classification` is not permitted
 * for the given WorkEvent `type` per the `workEventTypeRules` table. Resolves
 * to `void` otherwise.
 *
 * Pure function — no DB access. Route handlers call this AFTER looking up the
 * employee row (for tenant scoping etc.) and BEFORE the
 * `prisma.workEvent.create`.
 *
 * Per-type German messages: today only VOCATIONAL_SCHOOL has a tightened rule
 * so we hard-code that message. When future types tighten, add per-type
 * messages here (or a `messageDe` field on the `ClassificationRule` row).
 */
export function assertClassificationAllowed(
  type: WorkEventType,
  classification: EmployeeClassification,
): void {
  const rule = workEventTypeRules[type];
  if (!rule.allowedClassifications.includes(classification)) {
    const message =
      type === WorkEventType.VOCATIONAL_SCHOOL
        ? CLASSIFICATION_NOT_ALLOWED_DE_VOCATIONAL_SCHOOL
        : `Ereignistyp ${type} ist für Klassifikation ${classification} nicht zulässig.`;
    throw new ClassificationNotAllowedError(type, classification, message);
  }
}
