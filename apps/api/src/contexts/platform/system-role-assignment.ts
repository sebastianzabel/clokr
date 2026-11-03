/**
 * Phase 75b (Issue #75) - the one place where a REQUESTED system role (`ADMIN` / `MANAGER` /
 * `EMPLOYEE`: the employee form's "Wunschrolle", `POST /employees`, the CSV import, provisioning,
 * the e2e bootstrap) becomes a stored TENANT role assignment, and where the role the employee
 * form shows is derived back from the stored assignments.
 *
 * Since #75 no access decision reads a role value (D-12): guards and handler checks ask
 * `request-permissions.ts` for catalog permissions. Since #539 Release A the value is not
 * published in a token or a sign-in body any more. Since #641 Release B no column stores it
 * either: the value exists only DERIVED from the stored assignments, for the employee form and
 * the `user.role` key of the employee responses.
 *
 * Two directions:
 * - {@link systemRoleIdFor}: a requested role value -> the system role it stands for.
 * - {@link deriveFormRole}: stored assignments -> the form role to publish. ADMIN only for a
 *   well-formed TENANT assignment on the Admin system role (identified by id, D-01 - never by the
 *   display name); MANAGER when any well-formed TENANT assignment's role grants at least one
 *   ZUGEWIESEN permission; EMPLOYEE otherwise. Every row passes the same filters the 74b
 *   resolution applies: the role must belong to the tenant (a system role or a customer role of
 *   that tenant) and the stored scope must be well-formed (`storedRoleAssignmentScope`, fail
 *   closed). A row at SALONS or PERSONS scope contributes nothing here - the live resolver
 *   (`request-permissions.ts`) grants ZUGEWIESEN permissions from a TENANT-scope source only
 *   (D-09), so a role derived over a wider scope would overstate what the caller can actually do
 *   at the API (Issue #357 sub-fix A). A role grants through `roleGrants` only (AK-73-7).
 *
 * The write half (Phase 75b Plan 11, D-15/D-29) keeps the stored assignments consistent on the
 * employee form, the CSV import, the role-assignment API and the anonymization. There is no
 * materialization step: the D-26 function that stored a column's role as a real row before the
 * first assignment write is gone since #539, because it would be an implicit grant of that role:
 * - {@link replaceSystemRoleAssignment} swaps the user's tenant-wide system role, leaving every
 *   customer-role assignment untouched;
 * - {@link assignmentsBlockingDemotionToEmployee} (Issue #357 sub-fix B): the employee-form PATCH
 *   handler calls this BEFORE replacing the system role with Mitarbeiter - a non-empty result
 *   throws {@link RoleDemotionBlockedError} and the whole request is rejected with 409, naming the
 *   still-granting assignments, instead of leaving them in place unnoticed OR silently deleting
 *   a customer-role assignment (itself an unrequested rights change).
 * Neither audits: this module has no `app`. Each returns what it wrote, and the caller (a route
 * with the request's actor) writes the audit rows inside the same transaction.
 */
import type { Prisma, RoleAssignmentScopeType } from "@clokr/db";
import { roleGrants } from "./access-role";
import { PERMISSIONS, permissionKey, type PermissionKey } from "./permission-catalog";
import { storedRoleAssignmentScope } from "./role-assignment";
import { SYSTEM_ROLE_IDS } from "./system-roles";

/**
 * The vocabulary of a REQUESTED system role: the employee form's "Wunschrolle", `POST /employees`
 * and the CSV import (the three values of their Zod enums). Its own union because the Prisma
 * `Role` enum is removed by Release B (#641); it names a request value that only feeds a stored
 * TENANT assignment, never an access decision.
 */
export type SystemRoleName = "ADMIN" | "MANAGER" | "EMPLOYEE";

/** A stored role assignment with the fields the derivation reads. */
export interface FormRoleAssignmentRow {
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
 * The system role a form role value stands for. The switch is
 * exhaustive: a new enum value fails the typecheck here instead of silently mapping somewhere.
 */
export function systemRoleIdFor(role: SystemRoleName): string {
  switch (role) {
    case "ADMIN":
      return SYSTEM_ROLE_IDS.ADMIN;
    case "MANAGER":
      return SYSTEM_ROLE_IDS.MANAGER;
    case "EMPLOYEE":
      return SYSTEM_ROLE_IDS.EMPLOYEE;
    default: {
      const unreachable: never = role;
      throw new Error(`systemRoleIdFor: unknown role ${String(unreachable)}`);
    }
  }
}

/**
 * Phase 76b (Issue #76), P-01: the three form system-role ids a role value can stand for — Admin,
 * Manager and Mitarbeiter, exactly the ids {@link systemRoleIdFor} can return. The
 * Phase 76b templates (Inhaber, Salonmanager, Personalabteilung, Ausbilder) are deliberately NOT
 * form roles: the employee-form bridge below ({@link replaceSystemRoleAssignment},
 * {@link assignmentsBlockingDemotionToEmployee}) uses this predicate, not the seven-id
 * `isSystemRoleId` from `system-roles.ts`, so it treats a template assignment like any other
 * customer-role assignment — untouched, and counting as blocking on a demotion. Templates are
 * assigned and removed only through #74's audited role-assignment API.
 *
 * The role-value tuple is typed `satisfies readonly SystemRoleName[]`, so a value outside the
 * `SystemRoleName` union fails the typecheck rather than silently widening the set at runtime.
 */
const FORM_ROLE_VALUES = [
  "ADMIN",
  "MANAGER",
  "EMPLOYEE",
] as const satisfies readonly SystemRoleName[];

const FORM_SYSTEM_ROLE_ID_SET: ReadonlySet<string> = new Set(FORM_ROLE_VALUES.map(systemRoleIdFor));

/**
 * True when `id` is one of the three form system-role ids (Admin, Manager, Mitarbeiter) the
 * form role values can stand for. See {@link FORM_SYSTEM_ROLE_ID_SET} for why this,
 * not `isSystemRoleId`, is what the employee-form bridge narrows itself to (P-01).
 */
export function isFormSystemRoleId(id: string): boolean {
  return FORM_SYSTEM_ROLE_ID_SET.has(id);
}

/**
 * Issue #354 (pre-merge security review of #75): does a request's `role` field ask for anything
 * other than the schema default EMPLOYEE? `employee:create` (`POST /employees`) and
 * `employee:import` (`POST /imports/employees`) cover the new hire's profile, never handing out a
 * system role — a value other than EMPLOYEE additionally needs `role-assignment:manage`, the same
 * rule `PATCH /employees/:id` already applies. The comparison lives here (D-14): a plain
 * `body.role !== "EMPLOYEE"` at the call site is a role check `lint:role-checks` rejects regardless
 * of the fact that the compared value describes a request payload, not the caller's own role —
 * the sanctioned way is a helper whose parameter is typed {@link SystemRoleName}, classified in
 * `docs/permissions.md` (there is nothing to ask a permission FOR here; the decision is what the
 * value IS).
 */
export function requestedRoleNeedsRoleAssignmentManage(role: SystemRoleName): boolean {
  return role !== "EMPLOYEE";
}

/**
 * Issue #357 sub-fix B: does the employee form's requested `role` demote its target TO Mitarbeiter
 * — the case {@link assignmentsBlockingDemotionToEmployee} must guard? Same shape and same reason
 * as {@link requestedRoleNeedsRoleAssignmentManage} just above: the compared value is a REQUEST
 * field, not the caller's own role, but `lint-role-checks.ts` flags a comparison on a `.role`
 * property regardless — so the comparison lives here, on a {@link SystemRoleName} parameter,
 * instead of a bare `body.role === "EMPLOYEE"` at the call site in `employees.ts`.
 */
export function isDemotionToEmployee(role: SystemRoleName): boolean {
  return role === "EMPLOYEE";
}

/**
 * The form role derived from a user's stored assignments in `tenantId` (D-14). Rows whose role
 * belongs to another tenant, rows with a malformed scope, and rows at SALONS or PERSONS scope
 * (Issue #357 sub-fix A — only a TENANT-scope assignment grants anything tenant-wide, D-09)
 * contribute nothing. An empty (or fully filtered) input yields EMPLOYEE.
 */
export function deriveFormRole(
  tenantId: string,
  rows: readonly FormRoleAssignmentRow[],
): SystemRoleName {
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

/**
 * Issue #539 (D-10): the role the employee screen shows and preselects for each of `userIds` in
 * `tenantId`, DERIVED from the stored assignments ({@link deriveFormRole}), the only place a
 * role lives (#641). `null` when a user holds no well-formed assignment
 * of the tenant (no row at all, or only rows of another tenant's role or with a malformed scope):
 * the person holds no role, which drives the „Keine Rolle zugewiesen“ hint (D-14). A row at SALONS
 * or PERSONS scope counts as "has a role" but derives EMPLOYEE, exactly like the token claim.
 * One query for any number of users. Lives here because this module is the one place that
 * derives the role value (D-14); it is served under the existing `user.role` key of the employee
 * responses.
 */
export async function formRolesByUserId(
  db: Prisma.TransactionClient,
  tenantId: string,
  userIds: readonly string[],
): Promise<Map<string, SystemRoleName | null>> {
  const result = new Map<string, SystemRoleName | null>();
  if (userIds.length === 0) return result;
  const rows = await db.roleAssignment.findMany({
    where: { tenantId, userId: { in: [...userIds] } },
    select: {
      userId: true,
      scopeType: true,
      salonIds: true,
      employeeIds: true,
      accessRole: { select: { id: true, tenantId: true, permissions: true } },
    },
  });
  const byUser = new Map<string, FormRoleAssignmentRow[]>();
  for (const row of rows) {
    const belongsHere = row.accessRole.tenantId === null || row.accessRole.tenantId === tenantId;
    if (!belongsHere || storedRoleAssignmentScope(row) === null) continue;
    const list = byUser.get(row.userId) ?? [];
    list.push(row);
    byUser.set(row.userId, list);
  }
  for (const userId of userIds) {
    const own = byUser.get(userId);
    result.set(userId, own === undefined ? null : deriveFormRole(tenantId, own));
  }
  return result;
}

/**
 * Phase 76b (Issue #76) D-16: true when setting `role` on `userId` would request nothing new — the
 * requested value equals the role the employee form shows for the target, i.e. the role DERIVED
 * from its stored assignments ({@link formRolesByUserId}, Issue #539 D-10/D-11). A target without a
 * stored assignment has no such role (`null`), so any requested role is a change and gives them
 * one — the form is the admin's way to assign a role to a person who holds none.
 *
 * Accepted residual (#539 Release A, documented in the ADR Nachtrag): a browser tab opened before
 * a deploy may echo a stale role value on an unrelated save; the comparison is against the
 * derived role, so a stale-HIGH value would be a role change requested by an admin holding
 * `role-assignment:manage` (and audited as such).
 *
 * A request that changes nothing writes nothing: no replaced row, no demotion check, no audit
 * (74b D-07/D-12). Returns false when `userId` does not belong to an employee of `tenantId` (no
 * stored row there), so that case always runs the ordinary path below.
 *
 * Lives here, not in employees.ts, next to the derivation it compares against.
 */
export async function requestedRoleUnchanged(
  db: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
  role: SystemRoleName,
): Promise<boolean> {
  return (await formRolesByUserId(db, tenantId, [userId])).get(userId) === role;
}

/**
 * D-15: makes the system role of `role` the user's only tenant-wide FORM system-role assignment
 * in `tenantId` (Phase 76b P-01: only Admin, Manager and Mitarbeiter — never a template). Among
 * the user's TENANT rows on a FORM system role (Admin, Manager, Mitarbeiter, by id — D-01,
 * {@link isFormSystemRoleId}), every row that is not a well-formed row on the target role is
 * deleted, and the target row is created when none remains. Customer-role rows, Phase 76b template
 * rows (Inhaber, Salonmanager, Personalabteilung, Ausbilder) and SALONS/PERSONS rows are left
 * untouched — they count as blocking on a demotion (see
 * {@link assignmentsBlockingDemotionToEmployee}). Returns the removed and the created rows
 * (removals are written first) for the caller's audit.
 *
 * Writes exactly the requested role: nothing is stored on the user's behalf first (the legacy
 * fallback is gone, #539).
 */
export async function replaceSystemRoleAssignment(
  db: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
  role: SystemRoleName,
): Promise<{ removed: WrittenRoleAssignment[]; created: WrittenRoleAssignment | null }> {
  const targetRoleId = systemRoleIdFor(role);
  const systemRows = (
    await db.roleAssignment.findMany({
      where: { tenantId, userId, scopeType: "TENANT" },
      include: WRITTEN_ASSIGNMENT_INCLUDE,
      orderBy: { createdAt: "asc" },
    })
  ).filter((row) => isFormSystemRoleId(row.accessRoleId));

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
 * Deliberately does NOT restrict itself to TENANT scope the way {@link deriveFormRole} does
 * (Issue #357 sub-fix A): a SALONS or PERSONS assignment on such a role still hands out real, if
 * scoped, power (`decideUserMayApply` in `role-assignment.ts`) — exactly the kind of leftover
 * right Issue #357 sub-fix B must catch before a demotion to Mitarbeiter in the employee form.
 */
export function assignmentExceedsEmployee(tenantId: string, row: FormRoleAssignmentRow): boolean {
  const roleBelongsHere = row.accessRole.tenantId === null || row.accessRole.tenantId === tenantId;
  if (!roleBelongsHere || storedRoleAssignmentScope(row) === null) return false;
  return ZUGEWIESEN_KEYS.some((key) => roleGrants(row.accessRole, key));
}

/**
 * Issue #357 sub-fix B: the assignments that would still grant `userId` more than the Mitarbeiter
 * system role even AFTER {@link replaceSystemRoleAssignment} replaces the user's TENANT FORM
 * system-role row with Mitarbeiter — every OTHER stored assignment (a customer role at any scope,
 * a Phase 76b template — Inhaber, Salonmanager, Personalabteilung, Ausbilder — at any scope
 * (P-01), or a form system role kept at SALONS/PERSONS scope, since
 * `replaceSystemRoleAssignment` only ever touches TENANT-scope FORM system-role rows,
 * {@link isFormSystemRoleId}) for which {@link assignmentExceedsEmployee} holds.
 *
 * Called by the employee-form PATCH handler BEFORE any write, when the requested role is
 * Mitarbeiter: a non-empty result means the whole request must be rejected (409, naming these
 * rows) rather than the API silently deleting a customer-role or template assignment (an
 * unrequested rights change of its own) or silently leaving it in place (the bug this issue
 * reports) — see the issue's decision comment for the reasoning.
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
    .filter((row) => !(row.scopeType === "TENANT" && isFormSystemRoleId(row.accessRoleId)))
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
