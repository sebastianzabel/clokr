/**
 * Phase 75b (Issue #75), D-14 — the compat role: THE one place where legacy `Role` values
 * (`ADMIN` / `MANAGER` / `EMPLOYEE`) are produced from, or mapped onto, role assignments.
 *
 * Since #75 no access decision reads a role value any more (D-12): guards and handler checks ask
 * `request-permissions.ts` for catalog permissions. The legacy value survives only as a compat
 * field — the JWT claim `role` and the login body `user.role`, which the frontend still consumes
 * until #83 removes `User.role` and the enum. This module is the allowlisted exception of the
 * role-check gate (D-19): every comparison of a role value, in either direction, lives here.
 *
 * Two directions:
 * - {@link systemRoleIdForLegacyRole}: `User.role` → the system role it stands for. This is the
 *   inverse mapping the "Altrollen-Rückfall" (D-08) needs for a user with no stored assignment,
 *   and the only other allowed reader of `User.role` values.
 * - {@link deriveCompatRole}: stored assignments → the legacy value to publish. ADMIN only for a
 *   well-formed TENANT assignment on the Admin system role (identified by id, D-01 — never by the
 *   display name); MANAGER when any assignment's role grants at least one ZUGEWIESEN permission;
 *   EMPLOYEE otherwise. Every row passes the same filters the 74b resolution applies: the role
 *   must belong to the tenant (a system role or a customer role of that tenant) and the stored
 *   scope must be well-formed (`storedRoleAssignmentScope`, fail closed). A role grants through
 *   `roleGrants` only (AK-73-7).
 *
 * {@link compatRoleForUser} combines both for token issuance: a user without a stored assignment
 * in the tenant (every user without Employee, whose tenant is "", and every fallback user) keeps
 * exactly the column value. That equals deriving over the implicit fallback assignment — the unit
 * tests prove the equivalence for all three system roles — without a second query.
 *
 * Removed together with `User.role` in #83.
 */
import type { Prisma, Role, RoleAssignmentScopeType } from "@clokr/db";
import { roleGrants } from "./access-role";
import { PERMISSIONS, permissionKey, type PermissionKey } from "./permission-catalog";
import { storedRoleAssignmentScope } from "./role-assignment";
import { SYSTEM_ROLE_IDS } from "./system-roles";

/** A stored role assignment with the fields the derivation reads. */
export interface CompatRoleAssignmentRow {
  readonly scopeType: RoleAssignmentScopeType;
  readonly salonIds: readonly string[];
  readonly employeeIds: readonly string[];
  readonly accessRole: {
    readonly id: string;
    readonly tenantId: string | null;
    readonly permissions: readonly string[];
  };
}

/** Every ZUGEWIESEN key of the catalog, in catalog order. */
const ZUGEWIESEN_KEYS: readonly PermissionKey[] = PERMISSIONS.filter(
  (permission) => permission.reach === "ZUGEWIESEN",
).map(permissionKey);

/**
 * The system role a legacy `User.role` value stands for (D-08 fallback). The switch is
 * exhaustive: a new enum value fails the typecheck here instead of silently mapping somewhere.
 */
export function systemRoleIdForLegacyRole(role: Role): string {
  switch (role) {
    case "ADMIN":
      return SYSTEM_ROLE_IDS.ADMIN;
    case "MANAGER":
      return SYSTEM_ROLE_IDS.MANAGER;
    case "EMPLOYEE":
      return SYSTEM_ROLE_IDS.EMPLOYEE;
    default: {
      const unreachable: never = role;
      throw new Error(`systemRoleIdForLegacyRole: unknown role ${String(unreachable)}`);
    }
  }
}

/**
 * The compat role derived from a user's stored assignments in `tenantId` (D-14). Rows whose role
 * belongs to another tenant, and rows with a malformed scope, contribute nothing. An empty (or
 * fully filtered) input yields EMPLOYEE — the column write-back of a user whose last assignment
 * was revoked (D-08).
 */
export function deriveCompatRole(tenantId: string, rows: readonly CompatRoleAssignmentRow[]): Role {
  const effective = rows.filter((row) => {
    const roleBelongsHere =
      row.accessRole.tenantId === null || row.accessRole.tenantId === tenantId;
    return roleBelongsHere && storedRoleAssignmentScope(row) !== null;
  });
  if (
    effective.some(
      (row) => row.scopeType === "TENANT" && row.accessRole.id === SYSTEM_ROLE_IDS.ADMIN,
    )
  ) {
    return "ADMIN";
  }
  if (effective.some((row) => ZUGEWIESEN_KEYS.some((key) => roleGrants(row.accessRole, key)))) {
    return "MANAGER";
  }
  return "EMPLOYEE";
}

/**
 * The compat role to publish for `userId` at token issuance (login, OTP, refresh): the column
 * value `legacyRole` when the user has no stored assignment in `tenantId` (always so for an empty
 * tenant — a user without Employee), otherwise {@link deriveCompatRole} over the stored rows.
 */
export async function compatRoleForUser(
  db: Prisma.TransactionClient,
  userId: string,
  tenantId: string,
  legacyRole: Role,
): Promise<Role> {
  if (tenantId === "") return legacyRole;
  const rows = await db.roleAssignment.findMany({
    where: { tenantId, userId },
    select: {
      scopeType: true,
      salonIds: true,
      employeeIds: true,
      accessRole: { select: { id: true, tenantId: true, permissions: true } },
    },
  });
  if (rows.length === 0) return legacyRole;
  return deriveCompatRole(tenantId, rows);
}
