/**
 * Issue #836 (D-836-08, D-836-12) — the wire shape of a limit warning. Pure, no I/O.
 *
 * Without a `redaction` argument the output is COUNTS ONLY: `personIds` of the checker result never
 * leave the module. With one, every day item additionally names the other persons the reader may
 * already read (`persons`) and counts the rest (`hiddenCount`); a hidden person is a number, never
 * an id, a name or a flag (AC-12). Existing responses stay byte-identical because the caller adds
 * the key only when the list is non-empty.
 */
import type { EmployeeClassification } from "@clokr/db";
import type { LeaveLimitExceedance } from "./check";
import { isPersonVisibleOn, type ReaderVisibility } from "./redact";

export type LeaveLimitRedaction = {
  visibility: ReaderVisibility;
  personNames: ReadonlyMap<string, { firstName: string; lastName: string }>;
};

export type LeaveLimitWarningPerson = { employeeId: string; firstName: string; lastName: string };

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
  days: Array<{
    day: string;
    count: number;
    max: number;
    persons?: LeaveLimitWarningPerson[];
    hiddenCount?: number;
  }>;
};

/** Name order of every list a reader sees: last name, first name, id. */
export function comparePersons(a: LeaveLimitWarningPerson, b: LeaveLimitWarningPerson): number {
  return (
    a.lastName.localeCompare(b.lastName, "de") ||
    a.firstName.localeCompare(b.firstName, "de") ||
    (a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0)
  );
}

export function toLeaveLimitWarnings(
  exceedances: readonly LeaveLimitExceedance[],
  redaction?: LeaveLimitRedaction,
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
      .map((d) => {
        if (!redaction) return { day: d.day, count: d.count, max: d.max };
        // The candidate counts on every reported day (D-836-07), so the others are `count - 1`.
        const others = d.personIds.filter((id) => id !== e.candidateEmployeeId);
        const persons: LeaveLimitWarningPerson[] = [];
        for (const id of others) {
          const name = redaction.personNames.get(id);
          if (!name || !isPersonVisibleOn(redaction.visibility, id, e.salonId)) continue;
          persons.push({ employeeId: id, firstName: name.firstName, lastName: name.lastName });
        }
        persons.sort(comparePersons);
        return {
          day: d.day,
          count: d.count,
          max: d.max,
          persons,
          hiddenCount: others.length - persons.length,
        };
      }),
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
