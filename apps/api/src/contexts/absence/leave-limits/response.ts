/**
 * Issue #836 (D-836-08) — the wire shape of a limit warning. Pure, no I/O.
 *
 * The tracer serialises COUNTS ONLY: `personIds` of the checker result never leave the module and no
 * name is built here (836-05 adds reach-redacted persons; counts-only is the safe default of
 * D-836-12). Existing responses stay byte-identical because the caller adds the key only when the
 * list is non-empty.
 */
import type { EmployeeClassification } from "@clokr/db";
import type { LeaveLimitExceedance } from "./check";

export type LeaveLimitWarning = {
  ruleId: string;
  ruleName: string | null;
  groupKind: "ALL" | "CLASSIFICATION" | "ACCESS_ROLE";
  classification: EmployeeClassification | null;
  accessRoleId: string | null;
  accessRoleName: string | null;
  salonId: string;
  maxPersons: number;
  validFrom: string | null;
  validUntil: string | null;
  days: Array<{ day: string; count: number; max: number }>;
};

export function toLeaveLimitWarnings(
  exceedances: readonly LeaveLimitExceedance[],
): LeaveLimitWarning[] {
  const warnings = exceedances.map((e) => ({
    ruleId: e.rule.id,
    ruleName: e.rule.name,
    groupKind: e.rule.groupKind,
    classification: e.rule.classification,
    accessRoleId: e.rule.accessRoleId,
    accessRoleName: e.rule.accessRoleName,
    salonId: e.salonId,
    maxPersons: e.rule.maxPersons,
    validFrom: e.rule.validFrom,
    validUntil: e.rule.validUntil,
    days: [...e.days]
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
      .map((d) => ({ day: d.day, count: d.count, max: d.max })),
  }));
  return warnings.sort((a, b) =>
    a.ruleId !== b.ruleId
      ? a.ruleId < b.ruleId
        ? -1
        : 1
      : a.salonId < b.salonId
        ? -1
        : a.salonId > b.salonId
          ? 1
          : 0,
  );
}
