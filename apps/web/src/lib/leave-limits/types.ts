// Issue #836 — wire types of `/api/v1/leave/limits`. Types only: they mirror
// `apps/api/src/contexts/absence/leave-limits/` (rule-dto.ts, response.ts) and are not imported
// from the API because the web has no access to that workspace.
import type { EmployeeClassification } from "$lib/employee-classification";

export type LeaveLimitGroupKind = "ALL" | "CLASSIFICATION" | "ACCESS_ROLE";

/** One stored rule as `GET /leave/limits` serves it. */
export interface LeaveLimitRuleDto {
  id: string;
  /** Null = the rule applies to every salon of the tenant. */
  salonId: string | null;
  salonName: string | null;
  salonActive: boolean | null;
  groupKind: LeaveLimitGroupKind;
  classification: EmployeeClassification | null;
  accessRoleId: string | null;
  accessRoleName: string | null;
  maxPersons: number;
  /** `YYYY-MM-DD` or null (year-round). */
  validFrom: string | null;
  validUntil: string | null;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  /** Whether the caller may change or remove this rule; the API stays the authority. */
  canManage: boolean;
}

export interface LeaveLimitRoleChoice {
  id: string;
  name: string;
  isSystem: boolean;
}

export interface LeaveLimitRulesResponse {
  rules: LeaveLimitRuleDto[];
  canManageAllSalons: boolean;
  roleChoices: LeaveLimitRoleChoice[];
}

/** Body of POST and PUT; unused fields are sent as explicit `null`. */
export interface LeaveLimitRuleBody {
  salonId: string | null;
  groupKind: LeaveLimitGroupKind;
  classification: EmployeeClassification | null;
  accessRoleId: string | null;
  maxPersons: number;
  validFrom: string | null;
  validUntil: string | null;
  name: string | null;
}

export interface LeaveLimitWarningPerson {
  employeeId: string;
  firstName: string;
  lastName: string;
}

/** A limit warning on a request response; persons and the hidden count exist only when redacted. */
export interface LeaveLimitWarning {
  ruleId: string;
  ruleName: string | null;
  groupKind: LeaveLimitGroupKind;
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
}

/** `GET /leave/limits/load` (plan 836-05). */
export interface LeaveLimitLoadResponse {
  from: string;
  to: string;
  salons: Array<{
    salonId: string;
    salonName: string;
    groups: Array<{
      groupKey: string;
      groupKind: LeaveLimitGroupKind;
      classification: EmployeeClassification | null;
      accessRoleId: string | null;
      accessRoleName: string | null;
      days: Array<{
        day: string;
        count: number;
        max: number | null;
        ruleId: string | null;
        ruleName: string | null;
        exceeded: boolean;
        persons: Array<LeaveLimitWarningPerson & { approvedBeforeRule: boolean }>;
        hiddenCount: number;
        approvedBeforeRuleCount: number;
      }>;
    }>;
  }>;
}
