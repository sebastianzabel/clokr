// Issue #836 — German display labels of leave-limit rules. Display only: a label is never
// compared or used as a control value (CLAUDE.md), the group is decided by `groupKind`.
import { CLASSIFICATION_LABELS, type EmployeeClassification } from "$lib/employee-classification";
import type { LeaveLimitGroupKind } from "./types";

/**
 * The fixed legal hint of D-06, shown in the rule form. A block of leave needs urgent operational
 * reasons (§ 7 Abs. 1 BUrlG), must leave room for the annual leave including one stretch of 12
 * consecutive Werktage (§ 7 Abs. 2 BUrlG), and a works council co-determines it (§ 87 Abs. 1
 * Nr. 5 BetrVG). Clokr does not check any of that.
 */
export const LEAVE_LIMIT_LEGAL_HINT =
  "Eine Urlaubssperre braucht dringende betriebliche Gründe. Die Sperre muss Raum lassen, den Jahresurlaub zu nehmen, davon einmal 12 aufeinanderfolgende Werktage (§ 7 Abs. 1 und 2 BUrlG). Gibt es einen Betriebsrat, bestimmt er mit (§ 87 Abs. 1 Nr. 5 BetrVG). Clokr prüft das nicht automatisch – das ist eine Abwägung im Einzelfall.";

/** The group fields of a rule or a warning that the labels read. */
export interface GroupFields {
  groupKind: LeaveLimitGroupKind;
  classification: EmployeeClassification | null;
  accessRoleName: string | null;
}

const CLASSIFICATION_PLURALS: Readonly<Record<EmployeeClassification, string>> = Object.freeze({
  VOLLZEIT: "Vollzeitkräfte",
  TEILZEIT: "Teilzeitkräfte",
  MINIJOB: "Minijobber",
  AZUBI: "Azubis",
  AUSHILFE: "Aushilfen",
  WERKSTUDENT: "Werkstudierende",
  PRAKTIKANT: "Praktikanten",
});

/** Singular group label: "Alle", the classification label, or the role name. */
export function groupLabel(group: GroupFields): string {
  if (group.groupKind === "CLASSIFICATION" && group.classification) {
    return CLASSIFICATION_LABELS[group.classification];
  }
  if (group.groupKind === "ACCESS_ROLE") return group.accessRoleName ?? "Rolle";
  return "Alle";
}

/** Plural form for a sentence such as "höchstens 2 Azubis gleichzeitig im Urlaub". */
export function groupPluralLabel(group: GroupFields): string {
  if (group.groupKind === "CLASSIFICATION" && group.classification) {
    return CLASSIFICATION_PLURALS[group.classification];
  }
  if (group.groupKind === "ACCESS_ROLE") {
    return `Personen mit der Rolle „${group.accessRoleName ?? "?"}“`;
  }
  return "Personen";
}

/** The rule fields the list row texts read. */
export interface RuleTextFields extends GroupFields {
  maxPersons: number;
  validFrom: string | null;
  validUntil: string | null;
}

/** A Urlaubssperre is the rule "everybody, at most 0". */
export function isBlackout(rule: Pick<RuleTextFields, "groupKind" | "maxPersons">): boolean {
  return rule.groupKind === "ALL" && rule.maxPersons === 0;
}

/** `YYYY-MM-DD` as `TT.MM.JJJJ`, by splitting the string: no time zone can move the day. */
function germanDay(day: string): string {
  const [year, month, date] = day.split("-");
  return `${date}.${month}.${year}`;
}

/** The validity window of a rule: "ganzjährig" without one, else the dates. */
export function windowLabel(rule: Pick<RuleTextFields, "validFrom" | "validUntil">): string {
  if (!rule.validFrom && !rule.validUntil) return "ganzjährig";
  if (rule.validFrom && rule.validUntil) {
    return `${germanDay(rule.validFrom)} – ${germanDay(rule.validUntil)}`;
  }
  return rule.validFrom ? `ab ${germanDay(rule.validFrom)}` : `bis ${germanDay(rule.validUntil!)}`;
}

/** The limit for the rule list; the group has its own column, so no plural agreement is needed. */
export function limitText(rule: Pick<RuleTextFields, "maxPersons">): string {
  return rule.maxPersons === 0
    ? "Urlaub gesperrt"
    : `höchstens ${rule.maxPersons} gleichzeitig im Urlaub`;
}
