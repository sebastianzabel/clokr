// Issue #539 (D-10, D-14) - the employee screen's role rules, as a pure module so they are unit
// testable (the page itself is not mountable in the web test setup).
//
// The server derives the form's role from the person's stored role assignments and sends null for
// a person who holds none. Never derive a role from a display name, and never preselect a default
// role: a person without a role stays without one until an admin chooses and saves one.

export type FormRole = "ADMIN" | "MANAGER" | "EMPLOYEE";

/** The role select's value while no role is chosen. */
export type FormRoleChoice = FormRole | "";

/** Shown to an admin on the detail page of a person who holds no role (D-14). */
export const NO_ROLE_HINT =
  "Dieser Person ist keine Rolle zugewiesen. Eine Anmeldung ist erst möglich, nachdem eine Rolle gewählt und gespeichert wurde.";

/** The select's initial value: the server-derived role, or the empty choice for null. */
export function initialFormRole(role: FormRole | null | undefined): FormRoleChoice {
  return role ?? "";
}

/**
 * The role part of the employee PATCH body: only a caller who may assign roles sends one, and
 * only once a role was chosen (the empty choice sends nothing, so an unrelated save never
 * assigns a role).
 */
export function roleForSave(canAssignRoles: boolean, choice: FormRoleChoice): { role?: FormRole } {
  return canAssignRoles && choice !== "" ? { role: choice } : {};
}

/** True when the employee has a user account whose server-derived role is null. */
export function hasNoRole(user: { role: FormRole | null } | null | undefined): boolean {
  return user != null && user.role === null;
}
