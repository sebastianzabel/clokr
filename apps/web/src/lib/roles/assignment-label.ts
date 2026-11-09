/**
 * Issue #580 (D-580-02) — the ONE place the role-assignment wording lives. /admin/roles
 * („Zuweisungen“), the employee detail tab „Berechtigungen“, the employee list and the create dialog
 * all read it, so a person's roles read identically everywhere. Role names come only from the
 * stored roles (D-580-06) — this module never names a role itself, except the default role the
 * create API grants (CREATE_DEFAULT_ROLE_NAME, pinned to the API constant by a parity test).
 * `role-assignment-wording-one-place-580.test.ts` fails on a second copy of these labels.
 */
import type { AssignmentScope, RoleAssignment } from "$lib/api/roles";

export const SCOPE_TENANT_LABEL = "Ganzes Unternehmen";
export const UNKNOWN_SALON_LABEL = "Salon nicht mehr aktiv";
export const UNKNOWN_PERSON_LABEL = "Person nicht mehr verfügbar";
export const NO_ASSIGNMENT_LABEL = "Keine Rolle zugewiesen";
export const SYSTEM_ROLE_CHIP_LABEL = "Systemrolle";
export const ROLE_READ_REQUIRED_NOTE =
  "Zum Zuweisen und Ändern brauchst du zusätzlich das Recht, Rollen zu lesen.";
export const ASSIGN_RIGHT_REQUIRED_NOTE =
  "Zum Zuweisen, Ändern und Entziehen von Rollen fehlt dir das Recht, Rollen zuzuweisen.";
/**
 * The system role `POST /employees` grants for the whole company when no `role` is sent (its
 * schema defaults to EMPLOYEE). Mirrors `SYSTEM_ROLE_NAMES.EMPLOYEE` of the API
 * (`contexts/platform/system-roles.ts`); system roles cannot be renamed, and
 * `assignment-label-580.test.ts` pins the parity.
 */
export const CREATE_DEFAULT_ROLE_NAME = "Mitarbeiter";

export interface AssignmentLabelContext {
  salons: { id: string; name: string }[];
  /** False while the salon list is still loading — never read as "deactivated" then (D-05). */
  salonsLoaded: boolean;
  people: { employeeId: string; firstName: string; lastName: string }[];
}

/** The scope of an assignment in words: the whole company, or the named salons or persons. */
export function scopeLabel(scope: AssignmentScope, ctx: AssignmentLabelContext): string {
  if (scope.type === "TENANT") return SCOPE_TENANT_LABEL;
  if (scope.type === "SALONS") {
    const names = scope.salonIds.map((id) =>
      ctx.salonsLoaded ? (ctx.salons.find((s) => s.id === id)?.name ?? UNKNOWN_SALON_LABEL) : "…",
    );
    return `Salons: ${names.join(", ")}`;
  }
  const names = scope.employeeIds.map((id) => {
    const person = ctx.people.find((p) => p.employeeId === id);
    return person ? `${person.firstName} ${person.lastName}` : UNKNOWN_PERSON_LABEL;
  });
  return `Personen: ${names.join(", ")}`;
}

/** One assignment on one line: „<Rolle> · <Geltungsbereich>“ (list, create dialog). */
export function assignmentLabel(
  assignment: { roleName: string; scope: AssignmentScope },
  ctx: AssignmentLabelContext,
): string {
  return `${assignment.roleName} · ${scopeLabel(assignment.scope, ctx)}`;
}

/** The distinct role names of some assignments, sorted the German way. */
export function assignedRoleNames(items: { roleName: string }[]): string[] {
  return [...new Set(items.map((item) => item.roleName))].sort((a, b) => a.localeCompare(b, "de"));
}

/** The assignments grouped by user id, each group in list order. */
export function groupAssignmentsByUser(list: RoleAssignment[]): Record<string, RoleAssignment[]> {
  const byUser: Record<string, RoleAssignment[]> = {};
  for (const assignment of list) (byUser[assignment.userId] ??= []).push(assignment);
  return byUser;
}
