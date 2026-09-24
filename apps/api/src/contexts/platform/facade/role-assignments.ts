/**
 * Phase 74b (Issue #74) — Unterbau's role-assignment resolution facade.
 *
 * Every exported function here takes `db: Prisma.TransactionClient` first and a REQUIRED
 * `tenantId` — `apps/api/scripts/lint-facade-signatures.ts` (F1/F3) and
 * `apps/api/scripts/lint-tenant-scoping.ts` enforce this mechanically, the same shape as
 * `facade/salons.ts`. This module has no `app` and calls no `app.audit()` — resolution is a pure
 * read, evaluated live, never audited (there is nothing to record: no state changes).
 *
 * `userMayApply` takes FLAT parameters rather than a single destructured options object — a
 * deviation from the plan's suggested `userMayApply(db, { tenantId, userId }, permission,
 * target)` shape, recorded in the phase SUMMARY. `lint-facade-signatures.ts`'s F3 rule requires a
 * `*Id`/`*Ids`-shaped parameter to have a sibling parameter literally named `tenantId`; a
 * destructured object parameter has no per-property name the gate's AST walk can see, so the
 * object form would either fail F3 or need a new exception. Flat parameters pass F1/F2/F3
 * directly, with no new entry in `lint-facade-signatures-exceptions.json`.
 */
import type { Prisma } from "@clokr/db";
import {
  PERMISSIONS,
  PERMISSION_RESOURCES,
  permissionKey,
  type PermissionKey,
} from "../permission-catalog";
import { roleGrants } from "../access-role";
import { NOT_ANONYMIZED_EMPLOYEE_WHERE } from "../employee-anonymization-filter";
import { findSalon } from "./salons";
import {
  decideUserMayApply,
  normalizeRoleAssignmentScope,
  type NormalizedRoleAssignmentScope,
  type RoleAssignmentTarget,
} from "../role-assignment";

/**
 * D-15: does `userId` (of `tenantId`) currently hold `permission` for `target`?
 *
 * Steps: (a) resolve the catalog entry for `permission` — an unknown key denies. (b) confirm the
 * user is active and belongs to a non-anonymized employee of the tenant — otherwise deny. (c)
 * load the user's assignments in the tenant, keep only those whose role grants `permission` via
 * `roleGrants` — the ONE role-evaluation path (AK-73-7) — and normalize their scopes; no granting
 * assignment denies before any target lookup. (d) resolve the target's live facts (employee
 * validity, salon tenant-membership and activity). (e) hand everything to the pure decision table
 * `decideUserMayApply`.
 */
export async function userMayApply(
  db: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
  permission: PermissionKey,
  target: RoleAssignmentTarget,
): Promise<boolean> {
  const catalogEntry = PERMISSIONS.find((candidate) => permissionKey(candidate) === permission);
  if (!catalogEntry) return false;
  const relation = PERMISSION_RESOURCES[catalogEntry.resource].relation;

  const user = await db.user.findFirst({
    where: {
      id: userId,
      isActive: true,
      employee: { tenantId, ...NOT_ANONYMIZED_EMPLOYEE_WHERE },
    },
    select: { employee: { select: { id: true } } },
  });
  if (!user) return false;
  const ownEmployeeId = user.employee?.id ?? null;

  const assignments = await db.roleAssignment.findMany({
    where: { tenantId, userId },
    include: { accessRole: true },
  });

  const grantingScopes: NormalizedRoleAssignmentScope[] = [];
  for (const assignment of assignments) {
    const accessRole = assignment.accessRole;
    const roleBelongsHere = accessRole.tenantId === null || accessRole.tenantId === tenantId;
    if (!roleBelongsHere) continue;
    if (!roleGrants(accessRole, permission)) continue;
    grantingScopes.push(
      normalizeRoleAssignmentScope(
        assignment.scopeType === "TENANT"
          ? { type: "TENANT" }
          : assignment.scopeType === "SALONS"
            ? { type: "SALONS", salonIds: assignment.salonIds }
            : { type: "PERSONS", employeeIds: assignment.employeeIds },
      ),
    );
  }
  if (grantingScopes.length === 0) return false;

  const targetEmployeeValid =
    target.employeeId === undefined
      ? null
      : (await db.employee.findFirst({
          where: { id: target.employeeId, tenantId, ...NOT_ANONYMIZED_EMPLOYEE_WHERE },
          select: { id: true },
        })) !== null;

  const targetSalon =
    target.salonId === undefined
      ? null
      : await (async () => {
          const salon = await findSalon(db, tenantId, target.salonId as string);
          return { inTenant: salon !== null, isActive: salon?.isActive === true };
        })();

  return decideUserMayApply({
    reach: catalogEntry.reach,
    relation,
    ownEmployeeId,
    grantingScopes,
    target,
    targetEmployeeValid,
    targetSalon,
  });
}
