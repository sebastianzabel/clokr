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
 *   display name); MANAGER when any well-formed TENANT assignment's role grants at least one
 *   ZUGEWIESEN permission; EMPLOYEE otherwise. Every row passes the same filters the 74b
 *   resolution applies: the role must belong to the tenant (a system role or a customer role of
 *   that tenant) and the stored scope must be well-formed (`storedRoleAssignmentScope`, fail
 *   closed). A row at SALONS or PERSONS scope contributes nothing here — the live resolver
 *   (`request-permissions.ts`) grants ZUGEWIESEN permissions from a TENANT-scope source only
 *   (D-09), so a compat role derived over a wider scope would overstate what the caller can
 *   actually do at the API (Issue #357 sub-fix A; before the fix a SALONS/PERSONS assignment
 *   holding a ZUGEWIESEN key wrongly derived MANAGER). A role grants through `roleGrants` only
 *   (AK-73-7).
 *
 * {@link compatRoleForUser} combines both for token issuance: a user without a stored assignment
 * in the tenant (every user without Employee, whose tenant is "", and every fallback user) keeps
 * exactly the column value. That equals deriving over the implicit fallback assignment — the unit
 * tests prove the equivalence for all three system roles — without a second query.
 *
 * The write half (Phase 75b Plan 11, D-14/D-15/D-26/D-29) keeps the column and the stored
 * assignments consistent on every assignment write path — the employee form, the CSV import, the
 * role-assignment API and the anonymization:
 * - {@link materializeLegacyRoleAssignment} turns the implicit fallback into a stored row before
 *   the first assignment write, so a first customer role never silently removes a legacy role;
 * - {@link replaceSystemRoleAssignment} swaps the user's tenant-wide system role, leaving every
 *   customer-role assignment untouched;
 * - {@link assignmentsBlockingDemotionToEmployee} (Issue #357 sub-fix B): the employee-form PATCH
 *   handler calls this BEFORE replacing the system role with Mitarbeiter — a non-empty result
 *   throws {@link RoleDemotionBlockedError} and the whole request is rejected with 409, naming the
 *   still-granting assignments, instead of leaving them in place unnoticed OR silently deleting
 *   a customer-role assignment (itself an unrequested rights change);
 * - {@link syncCompatRoleColumn} rewrites `User.role` to the value derived over the STORED rows and
 *   reports the change, so the caller records it on the triggering audit row.
 * None of them audits: this module has no `app`. Each returns what it wrote, and the caller (a
 * route with the request's actor) writes the audit rows inside the same transaction.
 *
 * Removed together with `User.role` in #83.
 */
import type { Prisma, Role, RoleAssignmentScopeType } from "@clokr/db";
import { roleGrants } from "./access-role";
import { PERMISSIONS, permissionKey, type PermissionKey } from "./permission-catalog";
import { storedRoleAssignmentScope } from "./role-assignment";
import { SYSTEM_ROLE_IDS, isSystemRoleId } from "./system-roles";

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
 * Issue #354 (pre-merge security review of #75): does a request's `role` field ask for anything
 * other than the schema default EMPLOYEE? `employee:create` (`POST /employees`) and
 * `employee:import` (`POST /imports/employees`) cover the new hire's profile, never handing out a
 * system role — a value other than EMPLOYEE additionally needs `role-assignment:manage`, the same
 * rule `PATCH /employees/:id` already applies. The comparison lives here, the allowlisted module
 * (D-19/D-14): a plain `body.role !== "EMPLOYEE"` at the call site is a role check the gate rejects
 * regardless of the fact that the compared value describes a request payload, not the caller's own
 * role — this is the sanctioned way to move it behind a helper instead of converting it to a
 * permission (there is nothing to ask a permission FOR here; the decision is what the value IS).
 */
export function requestedRoleNeedsRoleAssignmentManage(role: Role): boolean {
  return role !== "EMPLOYEE";
}

/**
 * Issue #357 sub-fix B: does the employee form's requested `role` demote its target TO Mitarbeiter
 * — the case {@link assignmentsBlockingDemotionToEmployee} must guard? Same shape and same reason
 * as {@link requestedRoleNeedsRoleAssignmentManage} just above: the compared value is a REQUEST
 * field, not the caller's own role, but `lint-role-checks.ts` flags any `role`-named comparison
 * regardless — so the comparison lives here, the allowlisted module, instead of a bare
 * `role === "EMPLOYEE"` at the call site in `employees.ts`.
 */
export function isDemotionToEmployee(role: Role): boolean {
  return role === "EMPLOYEE";
}

/**
 * The compat role derived from a user's stored assignments in `tenantId` (D-14). Rows whose role
 * belongs to another tenant, rows with a malformed scope, and rows at SALONS or PERSONS scope
 * (Issue #357 sub-fix A — only a TENANT-scope assignment grants anything tenant-wide, D-09)
 * contribute nothing. An empty (or fully filtered) input yields EMPLOYEE — the column write-back
 * of a user whose last assignment was revoked (D-08).
 */
export function deriveCompatRole(tenantId: string, rows: readonly CompatRoleAssignmentRow[]): Role {
  const effective = rows.filter((row) => {
    const roleBelongsHere =
      row.accessRole.tenantId === null || row.accessRole.tenantId === tenantId;
    return roleBelongsHere && row.scopeType === "TENANT" && storedRoleAssignmentScope(row) !== null;
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

// ── Report data filter (Phase 75b Plan 12) ──────────────────────────────────────────────────────

/** The compat roles a report may filter its LISTED employees by (the company monthly PDF). */
export type CompatRoleFilter = "EMPLOYEE" | "MANAGER";

/**
 * Allowlist parse of a report's `role` query parameter: `MANAGER` or `EMPLOYEE`, anything else
 * (absent, `ADMIN`, garbage) → no filter. The untrusted string never reaches a Prisma enum. This
 * is a data filter on the listed employees, not an access decision about the caller — it lives
 * here because this module is the one place that compares role values (D-14, D-19).
 */
export function parseCompatRoleFilter(value: unknown): CompatRoleFilter | undefined {
  return value === "MANAGER" ? "MANAGER" : value === "EMPLOYEE" ? "EMPLOYEE" : undefined;
}

/**
 * The `User` where-fragment "users whose compat role is `filter`" (`{}` without a filter), to be
 * spread into a `user: { … }` relation filter. The column `User.role` IS the compat role: the
 * legacy value for a fallback user, the derived value written back on every assignment change
 * (D-14) for everyone else.
 */
export function compatRoleUserWhere(filter: CompatRoleFilter | undefined): { role?: Role } {
  return filter ? { role: filter } : {};
}

// ── Write half (Phase 75b Plan 11) ──────────────────────────────────────────────────────────────

/** A stored role assignment a write-half function created or removed, for the caller's audit. */
export interface WrittenRoleAssignment {
  id: string;
  userId: string;
  accessRoleId: string;
  scopeType: RoleAssignmentScopeType;
  salonIds: string[];
  employeeIds: string[];
  roleName: string;
}

/** A change of the `User.role` column, recorded as `compatRole` on the triggering audit row (D-29). */
export interface CompatRoleChange {
  from: Role;
  to: Role;
}

const WRITTEN_ASSIGNMENT_INCLUDE = { accessRole: { select: { name: true } } } as const;

function toWrittenAssignment(row: {
  id: string;
  userId: string;
  accessRoleId: string;
  scopeType: RoleAssignmentScopeType;
  salonIds: string[];
  employeeIds: string[];
  accessRole: { name: string };
}): WrittenRoleAssignment {
  return {
    id: row.id,
    userId: row.userId,
    accessRoleId: row.accessRoleId,
    scopeType: row.scopeType,
    salonIds: row.salonIds,
    employeeIds: row.employeeIds,
    roleName: row.accessRole.name,
  };
}

/** The `User.role` column of `userId`, when the user belongs to an employee of `tenantId`. */
async function legacyRoleColumn(
  db: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
): Promise<Role | null> {
  const user = await db.user.findFirst({
    where: { id: userId, employee: { tenantId } },
    select: { role: true },
  });
  return user === null ? null : user.role;
}

/**
 * D-26: when `userId` has NO stored role assignment in `tenantId`, stores the implicit fallback
 * (D-08) as a real TENANT assignment on the system role of its `User.role` column, and returns the
 * created row together with that legacy value (the caller audits it with origin SYSTEM). Returns
 * null when the user already has a stored row — any row, even a malformed one, disables the
 * fallback — or does not belong to an employee of the tenant.
 *
 * Runs before every assignment write on an existing user: without it, the first stored row (e.g.
 * a customer role) would end the fallback and silently remove the rights of the legacy role.
 */
export async function materializeLegacyRoleAssignment(
  db: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
): Promise<{ assignment: WrittenRoleAssignment; legacyRole: Role } | null> {
  const stored = await db.roleAssignment.count({ where: { tenantId, userId } });
  if (stored > 0) return null;
  const legacyRole = await legacyRoleColumn(db, tenantId, userId);
  if (legacyRole === null) return null;
  const created = await db.roleAssignment.create({
    data: {
      tenantId,
      userId,
      accessRoleId: systemRoleIdForLegacyRole(legacyRole),
      scopeType: "TENANT",
      salonIds: [],
      employeeIds: [],
    },
    include: WRITTEN_ASSIGNMENT_INCLUDE,
  });
  return { assignment: toWrittenAssignment(created), legacyRole };
}

/**
 * True when setting `role` on `userId` would change nothing: the user has no stored assignment in
 * `tenantId` and its `User.role` column already equals `role`, so the fallback (D-08) yields
 * exactly that system role. The employee form sends the role with every save, and a request that
 * changes nothing writes nothing — neither a materialized row nor an audit (74b D-07/D-12).
 */
export async function legacyFallbackAlreadyYields(
  db: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
  role: Role,
): Promise<boolean> {
  const stored = await db.roleAssignment.count({ where: { tenantId, userId } });
  if (stored > 0) return false;
  return (await legacyRoleColumn(db, tenantId, userId)) === role;
}

/**
 * D-15: makes the system role of `role` the user's only tenant-wide system-role assignment in
 * `tenantId`. Among the user's TENANT rows on a system role (by id, D-01), every row that is not a
 * well-formed row on the target role is deleted, and the target row is created when none remains.
 * Customer-role rows and SALONS/PERSONS rows are left untouched. Returns the removed and the
 * created rows (removals are written first) for the caller's audit.
 *
 * Does not materialize the fallback — a caller changing an existing user runs
 * {@link materializeLegacyRoleAssignment} first; a brand-new user has nothing to materialize.
 */
export async function replaceSystemRoleAssignment(
  db: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
  role: Role,
): Promise<{ removed: WrittenRoleAssignment[]; created: WrittenRoleAssignment | null }> {
  const targetRoleId = systemRoleIdForLegacyRole(role);
  const systemRows = (
    await db.roleAssignment.findMany({
      where: { tenantId, userId, scopeType: "TENANT" },
      include: WRITTEN_ASSIGNMENT_INCLUDE,
      orderBy: { createdAt: "asc" },
    })
  ).filter((row) => isSystemRoleId(row.accessRoleId));

  const keep = systemRows.filter(
    (row) => row.accessRoleId === targetRoleId && storedRoleAssignmentScope(row) !== null,
  );
  const remove = systemRows.filter((row) => !keep.includes(row));

  if (remove.length > 0) {
    await db.roleAssignment.deleteMany({
      where: { tenantId, userId, id: { in: remove.map((row) => row.id) } },
    });
  }

  let created: WrittenRoleAssignment | null = null;
  if (keep.length === 0) {
    const row = await db.roleAssignment.create({
      data: {
        tenantId,
        userId,
        accessRoleId: targetRoleId,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
      include: WRITTEN_ASSIGNMENT_INCLUDE,
    });
    created = toWrittenAssignment(row);
  }

  return { removed: remove.map(toWrittenAssignment), created };
}

// ── Demotion guard (Issue #357 sub-fix B) ──────────────────────────────────────────────────────

/** An assignment named in the 409 the employee-form demotion guard answers with. */
export interface BlockingRoleAssignment {
  id: string;
  roleName: string;
  scopeType: RoleAssignmentScopeType;
  salonIds: string[];
  employeeIds: string[];
}

const BLOCKING_ASSIGNMENT_INCLUDE = {
  accessRole: { select: { id: true, tenantId: true, name: true, permissions: true } },
} as const;

/**
 * True when `row` grants more than the Mitarbeiter system role ever does. Mitarbeiter is
 * EIGENE-only (`EMPLOYEE_PERMISSION_KEYS` in `system-roles.ts`, D-03), so any well-formed,
 * tenant-relevant row that grants at least one ZUGEWIESEN key is strictly more — Admin included,
 * since the Admin system role's permission set grants ZUGEWIESEN keys too.
 *
 * Deliberately does NOT restrict itself to TENANT scope the way {@link deriveCompatRole} does
 * (Issue #357 sub-fix A): a SALONS or PERSONS assignment on such a role still hands out real, if
 * scoped, power (`decideUserMayApply` in `role-assignment.ts`) — exactly the kind of leftover
 * right Issue #357 sub-fix B must catch before a demotion to Mitarbeiter in the employee form.
 */
export function assignmentExceedsEmployee(tenantId: string, row: CompatRoleAssignmentRow): boolean {
  const roleBelongsHere = row.accessRole.tenantId === null || row.accessRole.tenantId === tenantId;
  if (!roleBelongsHere || storedRoleAssignmentScope(row) === null) return false;
  return ZUGEWIESEN_KEYS.some((key) => roleGrants(row.accessRole, key));
}

/**
 * Issue #357 sub-fix B: the assignments that would still grant `userId` more than the Mitarbeiter
 * system role even AFTER {@link replaceSystemRoleAssignment} replaces the user's TENANT
 * system-role row with Mitarbeiter — every OTHER stored assignment (a customer role at any scope,
 * or a system role kept at SALONS/PERSONS scope, since `replaceSystemRoleAssignment` only ever
 * touches TENANT-scope system-role rows) for which {@link assignmentExceedsEmployee} holds.
 *
 * Called by the employee-form PATCH handler BEFORE any write, when the requested role is
 * Mitarbeiter: a non-empty result means the whole request must be rejected (409, naming these
 * rows) rather than the API silently deleting a customer-role assignment (an unrequested rights
 * change of its own) or silently leaving it in place (the bug this issue reports) — see the
 * issue's decision comment for the reasoning.
 */
export async function assignmentsBlockingDemotionToEmployee(
  db: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
): Promise<BlockingRoleAssignment[]> {
  const rows = await db.roleAssignment.findMany({
    where: { tenantId, userId },
    include: BLOCKING_ASSIGNMENT_INCLUDE,
  });
  return rows
    .filter((row) => !(row.scopeType === "TENANT" && isSystemRoleId(row.accessRoleId)))
    .filter((row) => assignmentExceedsEmployee(tenantId, row))
    .map((row) => ({
      id: row.id,
      roleName: row.accessRole.name,
      scopeType: row.scopeType,
      salonIds: row.salonIds,
      employeeIds: row.employeeIds,
    }));
}

/** The German 409 message the employee-form PATCH handler answers with (Issue #357 sub-fix B). */
export const ROLE_DEMOTION_BLOCKED_MESSAGE_PREFIX =
  "Rückstufung auf Mitarbeiter nicht möglich: Es bestehen noch weitere Rechte über zusätzliche Rollenzuweisungen";

/**
 * Thrown inside the employee-form's transaction when a demotion to Mitarbeiter would leave
 * `blocking` assignments in place (Issue #357 sub-fix B). Throwing rolls back the write AND its
 * audit row, same pattern as {@link RoleLockoutError} in `role-assignment.ts`. Callers branch on
 * `instanceof RoleDemotionBlockedError`, never on the message text.
 */
export class RoleDemotionBlockedError extends Error {
  readonly blocking: BlockingRoleAssignment[];

  constructor(blocking: BlockingRoleAssignment[]) {
    super(
      `RoleDemotionBlockedError: ${blocking.length} assignment(s) would still grant more than Mitarbeiter`,
    );
    this.name = "RoleDemotionBlockedError";
    this.blocking = blocking;
  }
}

/**
 * D-14/D-29: rewrites `User.role` of `userId` to the compat role derived over its STORED
 * assignments in `tenantId` (none → EMPLOYEE, D-08) and returns `{ from, to }` when the column
 * changed, null otherwise (also for a user that does not belong to an employee of the tenant).
 * Called after every assignment change; the caller records the returned change as `compatRole` on
 * the triggering change's audit row, so the column is never written silently.
 */
export async function syncCompatRoleColumn(
  db: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
): Promise<CompatRoleChange | null> {
  const current = await legacyRoleColumn(db, tenantId, userId);
  if (current === null) return null;
  const rows = await db.roleAssignment.findMany({
    where: { tenantId, userId },
    select: {
      scopeType: true,
      salonIds: true,
      employeeIds: true,
      accessRole: { select: { id: true, tenantId: true, permissions: true } },
    },
  });
  const derived = deriveCompatRole(tenantId, rows);
  if (derived === current) return null;
  await db.user.update({ where: { id: userId }, data: { role: derived } });
  return { from: current, to: derived };
}
