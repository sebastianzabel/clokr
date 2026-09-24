/**
 * Phase 74b (Issue #74) — pure core of role-assignment resolution.
 *
 * A `RoleAssignment` binds one user to one role (system or customer, Phase 73b `AccessRole`) with
 * exactly one scope:
 * - `TENANT`: the whole tenant.
 * - `SALONS`: an explicit list of salons.
 * - `PERSONS`: an explicit list of employees.
 *
 * The effective right of a user is the UNION over all of their assignments in the tenant — an
 * assignment contributes a permission ONLY through {@link roleGrants} from `access-role.ts` (the
 * ONE role-evaluation path, AK-73-7); nothing in this module re-evaluates a role. Salon activity
 * and user activity are evaluated LIVE by the caller (the facade) and handed in as facts — nothing
 * is stored on the assignment about either. Which resource belongs to which salon is #91's
 * decision, not this module's: a target that names no `salonId` never matches a SALONS scope.
 *
 * This module has no runtime import of `@clokr/db` — `RoleAssignmentScopeType` is imported as a
 * type only, so this file stays usable in a pure/unit-test context with no Prisma connection.
 */
import type { RoleAssignmentScopeType } from "@clokr/db";
import { roleGrants } from "./access-role";
import type { PermissionKey, PermissionReach, PermissionRelation } from "./permission-catalog";

/** The scope of a role assignment, as the API/application shape (not the stored row). */
export type RoleAssignmentScope =
  | { type: "TENANT" }
  | { type: "SALONS"; salonIds: readonly string[] }
  | { type: "PERSONS"; employeeIds: readonly string[] };

/** What a permission check is being asked about: an employee and/or a salon, or neither. */
export interface RoleAssignmentTarget {
  readonly employeeId?: string;
  readonly salonId?: string;
}

/** A scope normalized for storage/comparison — always both arrays present, never `undefined`. */
export interface NormalizedRoleAssignmentScope {
  scopeType: RoleAssignmentScopeType;
  salonIds: string[];
  employeeIds: string[];
}

/**
 * D-03: enforces the shape invariant on every write — TENANT -> both arrays empty; SALONS ->
 * `salonIds` de-duplicated and ascending-sorted (stable audit diffs, same idea as 73b D-03),
 * `employeeIds` empty; PERSONS mirrored. Throws `RangeError` on an empty SALONS/PERSONS list —
 * callers validate with Zod first (400 on an empty list at the API boundary); this is the second
 * line of defense for any caller that skips that validation (e.g. a script or a test fixture).
 */
export function normalizeRoleAssignmentScope(
  scope: RoleAssignmentScope,
): NormalizedRoleAssignmentScope {
  if (scope.type === "TENANT") {
    return { scopeType: "TENANT", salonIds: [], employeeIds: [] };
  }
  if (scope.type === "SALONS") {
    const salonIds = dedupeSorted(scope.salonIds);
    if (salonIds.length === 0) {
      throw new RangeError(
        "normalizeRoleAssignmentScope: a SALONS scope requires at least one salon id",
      );
    }
    return { scopeType: "SALONS", salonIds, employeeIds: [] };
  }
  const employeeIds = dedupeSorted(scope.employeeIds);
  if (employeeIds.length === 0) {
    throw new RangeError(
      "normalizeRoleAssignmentScope: a PERSONS scope requires at least one employee id",
    );
  }
  return { scopeType: "PERSONS", salonIds: [], employeeIds };
}

function dedupeSorted(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/**
 * A STORED row as a normalized scope for evaluation, or `null` when the row violates the D-03
 * shape invariant: a TENANT row with any id in either list, a SALONS row without a salon or with
 * person ids, a PERSONS row without a person or with salon ids.
 *
 * Phase 74b review IN-02: there is no DB CHECK constraint (D-03), so a script or fixture can write
 * such a row. Evaluation must fail closed on it — the row grants nothing — rather than throw like
 * {@link normalizeRoleAssignmentScope} (which guards WRITES) and turn every permission check of
 * that user into a 500. A malformed TENANT row is rejected too, not read as tenant-wide: its
 * lists show it was not written through the API, so which reach was meant is unknown.
 */
export function storedRoleAssignmentScope(row: {
  readonly scopeType: RoleAssignmentScopeType;
  readonly salonIds: readonly string[];
  readonly employeeIds: readonly string[];
}): NormalizedRoleAssignmentScope | null {
  if (row.scopeType === "TENANT") {
    return row.salonIds.length === 0 && row.employeeIds.length === 0
      ? { scopeType: "TENANT", salonIds: [], employeeIds: [] }
      : null;
  }
  if (row.scopeType === "SALONS") {
    return row.salonIds.length > 0 && row.employeeIds.length === 0
      ? { scopeType: "SALONS", salonIds: dedupeSorted(row.salonIds), employeeIds: [] }
      : null;
  }
  return row.employeeIds.length > 0 && row.salonIds.length === 0
    ? { scopeType: "PERSONS", salonIds: [], employeeIds: dedupeSorted(row.employeeIds) }
    : null;
}

/** The inverse of {@link normalizeRoleAssignmentScope}: a stored row back to the API shape. */
export function roleAssignmentScopeOf(row: {
  readonly scopeType: RoleAssignmentScopeType;
  readonly salonIds: readonly string[];
  readonly employeeIds: readonly string[];
}): RoleAssignmentScope {
  if (row.scopeType === "TENANT") return { type: "TENANT" };
  if (row.scopeType === "SALONS") return { type: "SALONS", salonIds: row.salonIds };
  return { type: "PERSONS", employeeIds: row.employeeIds };
}

/**
 * The facts {@link decideUserMayApply} needs — all of it pre-resolved by the facade so this
 * function stays a pure decision table with no I/O. `targetEmployeeValid`/`targetSalon` are
 * `null` when the target names no employee / no salon respectively; `grantingScopes` are only the
 * NORMALIZED scopes of assignments whose role already grants `permission` via `roleGrants` — this
 * function never re-checks that.
 */
export interface UserMayApplyFacts {
  readonly reach: PermissionReach;
  readonly relation: PermissionRelation;
  readonly ownEmployeeId: string | null;
  readonly grantingScopes: readonly NormalizedRoleAssignmentScope[];
  readonly target: RoleAssignmentTarget;
  readonly targetEmployeeValid: boolean | null;
  readonly targetSalon: { readonly inTenant: boolean; readonly isActive: boolean } | null;
}

/**
 * D-15: may the user apply the permission described by `facts.reach`/`facts.relation` to
 * `facts.target`, given `facts.grantingScopes` (already filtered to assignments whose role grants
 * the permission via `roleGrants`)? The union is "any grant allows" — scopes of different roles
 * are never merged into one combined scope.
 *
 * - No granting scope at all -> false (fail-closed).
 * - Reach `EIGENE` -> true only if the target names an employee, it equals the user's own
 *   employee id (non-null), and that employee is a valid (non-anonymized, tenant) employee —
 *   regardless of which scope granted it, even a TENANT scope.
 * - Reach `ZUGEWIESEN` -> false if the target names an employee that is not valid, or a salon
 *   that is not in the tenant. Then:
 *   - any granting scope is TENANT -> true (covers both relations).
 *   - relation `MANDANT` and no TENANT grant -> false (a tenant-wide resource only ever takes
 *     effect from a TENANT-scope assignment).
 *   - relation `PERSON`: a SALONS grant listing `target.salonId`, with that salon in the tenant
 *     AND currently active, -> true (salon activity is evaluated live — nothing is stored on the
 *     assignment). Otherwise a PERSONS grant listing `target.employeeId` (already known valid) ->
 *     true — the target's salon plays no role here (salon-crossing, binding: a PERSONS holder
 *     reaches a listed person regardless of which salon that person's target belongs to).
 *     Otherwise -> false.
 */
export function decideUserMayApply(facts: UserMayApplyFacts): boolean {
  if (facts.grantingScopes.length === 0) return false;

  if (facts.reach === "EIGENE") {
    return (
      facts.target.employeeId !== undefined &&
      facts.ownEmployeeId !== null &&
      facts.target.employeeId === facts.ownEmployeeId &&
      facts.targetEmployeeValid === true
    );
  }

  // facts.reach === "ZUGEWIESEN"
  if (facts.targetEmployeeValid === false) return false;
  if (facts.targetSalon?.inTenant === false) return false;

  if (facts.grantingScopes.some((scope) => scope.scopeType === "TENANT")) return true;
  if (facts.relation === "MANDANT") return false;

  const salonId = facts.target.salonId;
  if (
    salonId !== undefined &&
    facts.targetSalon?.isActive === true &&
    facts.grantingScopes.some(
      (scope) => scope.scopeType === "SALONS" && scope.salonIds.includes(salonId),
    )
  ) {
    return true;
  }

  const employeeId = facts.target.employeeId;
  if (
    employeeId !== undefined &&
    facts.targetEmployeeValid === true &&
    facts.grantingScopes.some(
      (scope) => scope.scopeType === "PERSONS" && scope.employeeIds.includes(employeeId),
    )
  ) {
    return true;
  }

  return false;
}

// ── Lockout protection (#73 rule, enforced by #74) ─────────────────────────────────────────────
//
// A HOLDER of a guarded permission is an ACTIVE user (`User.isActive`) whose employee belongs to
// the tenant and who has at least one TENANT-scope assignment in that tenant whose role grants the
// permission via `roleGrants` (D-17). A SALONS or PERSONS assignment never makes a holder: managing
// roles and assignments is a tenant-wide resource (relation MANDANT), so only a TENANT scope can
// ever exercise it (D-15).
//
// BOTH permissions are guarded. `role:manage` is the binding wording of #73/#74. Losing the last
// holder of `role-assignment:manage` is the lockout that actually cannot be repaired from inside
// the tenant: nobody left could grant the right back.
//
// The rule is a TRANSITION rule (D-18): only a change that takes a guarded permission's holder
// count from >= 1 to 0 is rejected. A tenant that has no holder yet — every tenant until #75 seeds
// assignments — is never blocked, otherwise every deactivation in every existing tenant would be
// refused today.
//
// The counting below is pure. The facade (`facade/role-assignments.ts`, `withRoleLockoutGuard`)
// loads the holder rows, locks the tenant row and counts before and after the write inside one
// transaction.

/** The permissions whose last tenant-wide holder must never disappear (D-17). */
export const GUARDED_PERMISSIONS = [
  "role:manage:ZUGEWIESEN",
  "role-assignment:manage:ZUGEWIESEN",
] as const satisfies readonly PermissionKey[];

export type GuardedPermission = (typeof GUARDED_PERMISSIONS)[number];

/** The German 409 message every lockout trigger answers with (D-19). */
export const ROLE_LOCKOUT_MESSAGE =
  "Nicht möglich: Danach hätte kein aktiver Nutzer mehr das Recht, Rollen bzw. Rollenzuweisungen mandantenweit zu verwalten.";

/**
 * Thrown inside a guarded transaction when the write would remove the last holder of
 * `permission`. Throwing rolls back the write AND its audit row. Callers branch on
 * `instanceof RoleLockoutError`, never on the message text.
 */
export class RoleLockoutError extends Error {
  readonly permission: GuardedPermission;

  constructor(permission: GuardedPermission) {
    super(`Role lockout: the last tenant-wide holder of ${permission} would be removed`);
    this.name = "RoleLockoutError";
    this.permission = permission;
  }
}

/**
 * One candidate holder row: a TENANT-scope assignment of an active user of the tenant, with the
 * role it binds. The facade has already applied the user, employee and scope filters. This module
 * only evaluates the role.
 */
export interface GuardedHolderRow {
  userId: string;
  accessRole: { tenantId: string | null; permissions: readonly string[] };
}

/**
 * The number of DISTINCT holders per guarded permission. A role counts only if it is a system role
 * (`tenantId` null) or a customer role of `tenantId`. A foreign tenant's role never counts, even if
 * a row referencing it slipped through.
 */
export function countHoldersPerGuardedPermission(
  tenantId: string,
  rows: readonly GuardedHolderRow[],
): Record<GuardedPermission, number> {
  const holders = new Map<GuardedPermission, Set<string>>(
    GUARDED_PERMISSIONS.map((permission) => [permission, new Set<string>()]),
  );
  for (const row of rows) {
    const roleBelongsHere =
      row.accessRole.tenantId === null || row.accessRole.tenantId === tenantId;
    if (!roleBelongsHere) continue;
    for (const permission of GUARDED_PERMISSIONS) {
      if (roleGrants(row.accessRole, permission)) {
        holders.get(permission)?.add(row.userId);
      }
    }
  }
  const counts = {} as Record<GuardedPermission, number>;
  for (const permission of GUARDED_PERMISSIONS) {
    counts[permission] = holders.get(permission)?.size ?? 0;
  }
  return counts;
}

/**
 * D-18: the first guarded permission whose holder count went from >= 1 (`before`) to 0 (`after`),
 * or `null` when no permission lost its last holder. A 0 -> 0 transition is never a lockout.
 */
export function findLockedOutPermission(
  before: Readonly<Record<GuardedPermission, number>>,
  after: Readonly<Record<GuardedPermission, number>>,
): GuardedPermission | null {
  for (const permission of GUARDED_PERMISSIONS) {
    if (before[permission] >= 1 && after[permission] === 0) return permission;
  }
  return null;
}
