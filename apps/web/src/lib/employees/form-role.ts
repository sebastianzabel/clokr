// Issue #539 (D-14) - the employee screen's no-role display rule, as a pure module so it is unit
// testable (the page itself is not mountable in the web test setup).
//
// The server derives the person's form role from their stored role assignments and sends null for
// a person who holds none. The role choice itself moved to the role-assignment block (Issue #580,
// D-580-04); never derive a role from a display name.

export type FormRole = "ADMIN" | "MANAGER" | "EMPLOYEE";

/** Shown to an admin on the detail page of a person who holds no role (D-14). */
export const NO_ROLE_HINT =
  "Dieser Person ist keine Rolle zugewiesen. Eine Anmeldung ist erst möglich, nachdem ihr eine Rolle zugewiesen wurde.";

/** True when the employee has a user account whose server-derived role is null. */
export function hasNoRole(user: { role: FormRole | null } | null | undefined): boolean {
  return user != null && user.role === null;
}
