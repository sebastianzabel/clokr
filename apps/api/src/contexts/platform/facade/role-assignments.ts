/**
 * Phase 74b (Issue #74) — Unterbau's role-assignment resolution facade.
 *
 * Every exported function here takes `db: Prisma.TransactionClient` first and a REQUIRED
 * `tenantId` — `apps/api/scripts/lint-facade-signatures.ts` (F1/F3) and
 * `apps/api/scripts/lint-tenant-scoping.ts` enforce this mechanically, the same shape as
 * `facade/salons.ts`. This module has no `app` and calls no `app.audit()` — resolution is a pure
 * read, evaluated live, never audited (there is nothing to record: no state changes). The
 * lockout guard `withRoleLockoutGuard` writes nothing itself either: it runs the CALLER's write
 * and audit inside the caller's transaction and only decides whether that transaction may commit.
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
  RoleLockoutError,
  countHoldersPerGuardedPermission,
  decideUserMayApply,
  findLockedOutPermission,
  normalizeRoleAssignmentScope,
  type GuardedPermission,
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

// ── Lockout protection (Phase 74b, D-17..D-19) ──────────────────────────────────────────────────

/**
 * D-17: the number of distinct holders per guarded permission in `tenantId`, as seen by `db`. A
 * holder is an active user whose employee belongs to the tenant, with a TENANT-scope assignment in
 * the tenant whose role grants the permission. Reading through `db` means that, inside a
 * transaction, the count sees that transaction's own uncommitted writes.
 */
export async function countGuardedPermissionHolders(
  db: Prisma.TransactionClient,
  tenantId: string,
): Promise<Record<GuardedPermission, number>> {
  const rows = await db.roleAssignment.findMany({
    where: {
      tenantId,
      scopeType: "TENANT",
      user: { isActive: true, employee: { tenantId } },
    },
    select: {
      userId: true,
      accessRole: { select: { tenantId: true, permissions: true } },
    },
  });
  return countHoldersPerGuardedPermission(tenantId, rows);
}

/**
 * D-19: runs `write` under the lockout rule and returns its result.
 *
 * MUST be called inside an interactive `$transaction`, with the SAME client the write (and its
 * audit) uses. The tenant row lock lasts only as long as the transaction it runs in, and the
 * after-count must see the write's uncommitted effect. Counting on another client would read the
 * pre-write state and never fire (74b-RESEARCH Pitfall 9).
 *
 * Order: lock the tenant row `FOR NO KEY UPDATE`, which serialises every guarded change in the
 * tenant. Then count holders, run `write`, and count again. When a guarded permission went from
 * >= 1 holders to 0 (D-18), throw {@link RoleLockoutError}. The throw rolls back the write AND its
 * audit row. Every caller maps the error to 409 `ROLE_LOCKOUT_MESSAGE`.
 *
 * Lock mode: `FOR NO KEY UPDATE`, not the `FOR UPDATE` D-19 names — same intent, narrower lock.
 * `FOR NO KEY UPDATE` conflicts with itself, so two guarded changes in one tenant still wait for
 * each other. Unlike `FOR UPDATE` it does NOT conflict with `FOR KEY SHARE`, the lock PostgreSQL
 * takes on the referenced Tenant row for every foreign-key check. With `FOR UPDATE`, every
 * concurrent insert (or FK-column update) of any tenant-scoped row — a time entry, a leave
 * request — would wait for the guarded transaction to finish.
 */
export async function withRoleLockoutGuard<T>(
  db: Prisma.TransactionClient,
  tenantId: string,
  write: () => Promise<T>,
): Promise<T> {
  await db.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR NO KEY UPDATE`;
  const before = await countGuardedPermissionHolders(db, tenantId);
  const result = await write();
  const after = await countGuardedPermissionHolders(db, tenantId);
  const lockedOut = findLockedOutPermission(before, after);
  if (lockedOut !== null) {
    throw new RoleLockoutError(lockedOut);
  }
  return result;
}
