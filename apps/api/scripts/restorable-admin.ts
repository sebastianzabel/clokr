/**
 * Issue #539 (Release A), D-12 — the selection rule of `seed-int-admin.ts`, kept in a module
 * without top-level code so it can be imported (and tested) without running the script.
 *
 * Since Release A only stored role assignments grant permissions, so the int admin restore picks
 * its user by a stored TENANT assignment on the Admin system role. The compat column on the user
 * is never read for the choice: a user whose column says "admin" but who holds no stored
 * assignment would be refused at login with NO_ROLE_ASSIGNED, so a fresh password for it would be
 * a login that does not work.
 */
import type { Prisma } from "@clokr/db";
import { SYSTEM_ROLE_IDS } from "../src/contexts/platform/system-roles";

/**
 * The `User` where-fragment of the default pick: active, has an Employee (since Issue #551 a user
 * without one has no tenant and cannot sign in) and holds a stored TENANT assignment on the Admin
 * system role.
 */
export function restorableAdminWhere(): Prisma.UserWhereInput {
  return {
    isActive: true,
    employee: { isNot: null },
    roleAssignments: {
      some: { scopeType: "TENANT", accessRoleId: SYSTEM_ROLE_IDS.ADMIN },
    },
  };
}

/** What `pinnedUserRefusal` needs to know about the user a `--email` flag pinned. */
export interface PinnedUserFacts {
  email: string;
  hasEmployee: boolean;
  /** Every stored role assignment of the user (id of the role and scope type). */
  assignments: ReadonlyArray<{ accessRoleId: string; scopeType: string }>;
}

/**
 * Why a pinned user must not be restored, or `null` when it may be. Checked before anything is
 * written. Operator-facing text (English, like every other message of the script).
 */
export function pinnedUserRefusal(user: PinnedUserFacts): string | null {
  if (!user.hasEmployee) {
    return (
      `${user.email} has no Employee, hence no tenant — since Issue #551 such a user cannot ` +
      "sign in (403 TENANT_REQUIRED). Pick an admin that has an Employee. Nothing written."
    );
  }
  if (user.assignments.length === 0) {
    return (
      `${user.email} holds no stored role assignment — since Issue #539 only stored assignments ` +
      "grant permissions, so the login would be refused with NO_ROLE_ASSIGNED. Nothing written."
    );
  }
  const holdsAdmin = user.assignments.some(
    (row) => row.scopeType === "TENANT" && row.accessRoleId === SYSTEM_ROLE_IDS.ADMIN,
  );
  if (!holdsAdmin) {
    return (
      `${user.email} holds no tenant-wide Admin system role assignment, expected an admin. ` +
      "Nothing written."
    );
  }
  return null;
}
