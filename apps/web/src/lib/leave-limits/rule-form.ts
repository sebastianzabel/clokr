// Issue #836 — the pure form model of the rule modal on /admin/leave-limits. A route page cannot be
// mounted in a test (no `$app` alias), so every decision of the form lives here.
//
// The API validates every field again (Zod refines plus the database CHECKs); the messages here only
// spare a round trip. Nothing in this module is an access decision.
import type { EmployeeClassification } from "$lib/employee-classification";
import type { LeaveLimitGroupKind, LeaveLimitRuleBody, LeaveLimitRuleDto } from "./types";

export const MAX_PERSONS_LIMIT = 999;
export const RULE_NAME_MAX_LENGTH = 80;

export interface RuleForm {
  /** Null = all salons. */
  salonId: string | null;
  groupKind: LeaveLimitGroupKind;
  classification: EmployeeClassification | null;
  accessRoleId: string | null;
  /** Kept as text so a half-typed number never becomes NaN in the model. */
  maxPersons: string;
  validFrom: string;
  validUntil: string;
  name: string;
}

/** A new rule: all persons, no window, no maximum typed yet. */
export function emptyRuleForm(salonId: string | null): RuleForm {
  return {
    salonId,
    groupKind: "ALL",
    classification: null,
    accessRoleId: null,
    maxPersons: "",
    validFrom: "",
    validUntil: "",
    name: "",
  };
}

/** The Urlaubssperre preset: everybody, maximum 0; the window is asked for and mandatory. */
export function blackoutPreset(salonId: string | null): RuleForm {
  return { ...emptyRuleForm(salonId), maxPersons: "0" };
}

export function ruleFormFromDto(dto: LeaveLimitRuleDto): RuleForm {
  return {
    salonId: dto.salonId,
    groupKind: dto.groupKind,
    classification: dto.classification,
    accessRoleId: dto.accessRoleId,
    maxPersons: String(dto.maxPersons),
    validFrom: dto.validFrom ?? "",
    validUntil: dto.validUntil ?? "",
    name: dto.name ?? "",
  };
}

/** A German message for the first problem of the form, or null when it can be sent. */
export function validateRuleForm(form: RuleForm, options: { blackout: boolean }): string | null {
  const max = form.maxPersons.trim();
  if (!/^\d+$/.test(max) || Number(max) > MAX_PERSONS_LIMIT) {
    return `Die Höchstzahl muss eine ganze Zahl von 0 bis ${MAX_PERSONS_LIMIT} sein.`;
  }
  if (form.groupKind === "CLASSIFICATION" && !form.classification) {
    return "Bitte wähle eine Beschäftigungsart.";
  }
  if (form.groupKind === "ACCESS_ROLE" && !form.accessRoleId) {
    return "Bitte wähle eine Rolle.";
  }
  if (options.blackout && (!form.validFrom || !form.validUntil)) {
    return "Eine Urlaubssperre braucht einen Zeitraum mit Beginn und Ende.";
  }
  if (form.validFrom && form.validUntil && form.validFrom > form.validUntil) {
    return "Das Ende des Zeitraums darf nicht vor dem Beginn liegen.";
  }
  if (form.name.trim().length > RULE_NAME_MAX_LENGTH) {
    return `Die Bezeichnung darf höchstens ${RULE_NAME_MAX_LENGTH} Zeichen lang sein.`;
  }
  return null;
}

/** The API body: explicit `null` for every unused field, never a stale value of another group. */
export function ruleFormPayload(form: RuleForm): LeaveLimitRuleBody {
  const name = form.name.trim();
  return {
    salonId: form.salonId,
    groupKind: form.groupKind,
    classification: form.groupKind === "CLASSIFICATION" ? form.classification : null,
    accessRoleId: form.groupKind === "ACCESS_ROLE" ? form.accessRoleId : null,
    maxPersons: Number(form.maxPersons.trim()),
    validFrom: form.validFrom || null,
    validUntil: form.validUntil || null,
    name: name === "" ? null : name,
  };
}
