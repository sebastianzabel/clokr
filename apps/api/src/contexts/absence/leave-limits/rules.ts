/**
 * Issue #836 (D-836-06) — which rule applies to (salon, day), and which wins. Pure, no I/O.
 *
 * Days are `YYYY-MM-DD` strings and are compared lexicographically (a `@db.Date` column is converted
 * once by the loader, never here).
 */
import type { EmployeeClassification } from "@clokr/db";

export type LeaveLimitGroupKindValue = "ALL" | "CLASSIFICATION" | "ACCESS_ROLE";

export type LeaveLimitRuleRow = {
  id: string;
  salonId: string | null;
  groupKind: LeaveLimitGroupKindValue;
  classification: EmployeeClassification | null;
  accessRoleId: string | null;
  maxPersons: number;
  /** Inclusive window bounds as `YYYY-MM-DD`; both null = the whole year. */
  validFrom: string | null;
  validUntil: string | null;
  name: string | null;
  createdAt: Date;
  /** The moment the current parameters took effect: rules are edited in place (D-836-02). */
  updatedAt: Date;
};

/** `ALL` | `CLASSIFICATION:<value>` | `ACCESS_ROLE:<id>` — the key a group is counted under. */
export function groupKeyOf(
  rule: Pick<LeaveLimitRuleRow, "groupKind" | "classification" | "accessRoleId">,
): string {
  if (rule.groupKind === "CLASSIFICATION") return `CLASSIFICATION:${rule.classification}`;
  if (rule.groupKind === "ACCESS_ROLE") return `ACCESS_ROLE:${rule.accessRoleId}`;
  return "ALL";
}

/** True iff the rule is for this salon (or for every salon) and its inclusive window holds the day. */
export function ruleAppliesOn(
  rule: Pick<LeaveLimitRuleRow, "salonId" | "validFrom" | "validUntil">,
  salonId: string,
  day: string,
): boolean {
  if (rule.salonId !== null && rule.salonId !== salonId) return false;
  if (rule.validFrom !== null && day < rule.validFrom) return false;
  if (rule.validUntil !== null && day > rule.validUntil) return false;
  return true;
}

/**
 * Per group the strictest applicable rule: the lowest `maxPersons`, a tie resolved by `id`
 * ascending so the result is deterministic (D-05, D-836-06).
 */
export function strictestRulesOn(
  rules: readonly LeaveLimitRuleRow[],
  salonId: string,
  day: string,
): Map<string, LeaveLimitRuleRow> {
  const winners = new Map<string, LeaveLimitRuleRow>();
  for (const rule of rules) {
    if (!ruleAppliesOn(rule, salonId, day)) continue;
    const key = groupKeyOf(rule);
    const current = winners.get(key);
    if (
      !current ||
      rule.maxPersons < current.maxPersons ||
      (rule.maxPersons === current.maxPersons && rule.id < current.id)
    ) {
      winners.set(key, rule);
    }
  }
  return winners;
}

/** The stored fields a `LeaveLimitRule` record needs to become a kernel row. */
type LeaveLimitRuleRecordLike = {
  id: string;
  salonId: string | null;
  groupKind: LeaveLimitGroupKindValue;
  classification: EmployeeClassification | null;
  accessRoleId: string | null;
  maxPersons: number;
  validFrom: Date | null;
  validUntil: Date | null;
  name: string | null;
  createdAt: Date;
  /** The moment the current parameters took effect: rules are edited in place (D-836-02). */
  updatedAt: Date;
};

/** A stored rule as a kernel row: the `@db.Date` bounds become `YYYY-MM-DD` strings, once. */
export function ruleRowOf(record: LeaveLimitRuleRecordLike): LeaveLimitRuleRow {
  return {
    id: record.id,
    salonId: record.salonId,
    groupKind: record.groupKind,
    classification: record.classification,
    accessRoleId: record.accessRoleId,
    maxPersons: record.maxPersons,
    validFrom: record.validFrom ? record.validFrom.toISOString().slice(0, 10) : null,
    validUntil: record.validUntil ? record.validUntil.toISOString().slice(0, 10) : null,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
