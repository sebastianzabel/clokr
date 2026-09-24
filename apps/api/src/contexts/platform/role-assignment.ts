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
import type { PermissionReach, PermissionRelation } from "./permission-catalog";

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
