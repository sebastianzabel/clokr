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
 * The one writing function, `removeRoleAssignmentsOfUser` (DSGVO anonymization, D-22), returns the
 * removed rows so that its caller writes the audit entries.
 *
 * `userMayApply` takes FLAT parameters rather than a single destructured options object — a
 * deviation from the plan's suggested `userMayApply(db, { tenantId, userId }, permission,
 * target)` shape, recorded in the phase SUMMARY. `lint-facade-signatures.ts`'s F3 rule requires a
 * `*Id`/`*Ids`-shaped parameter to have a sibling parameter literally named `tenantId`; a
 * destructured object parameter has no per-property name the gate's AST walk can see, so the
 * object form would either fail F3 or need a new exception. Flat parameters pass F1/F2/F3
 * directly, with no new entry in `lint-facade-signatures-exceptions.json`.
 *
 * `resolveAccessReach` (Phase 91b, Issue #91) is the one exception to "a REQUIRED `tenantId`
 * parameter": its tenant travels inside its second parameter, `ctx: AccessContext` — it has no
 * `*Id`/`*Ids`-shaped parameter of its own, so F3 does not apply to it, and its signature carries
 * no Fastify type either (F2), confirmed against `lint:facade-signatures` before this landed.
 */
import type { Prisma } from "@clokr/db";
import type { AccessContext, AccessReach } from "../access-context";
import {
  PERMISSIONS,
  PERMISSION_RESOURCES,
  permissionKey,
  type PermissionKey,
} from "../permission-catalog";
import { roleGrants } from "../access-role";
import { NOT_ANONYMIZED_EMPLOYEE_WHERE } from "../employee-anonymization-filter";
import { findSalon, listSalons } from "./salons";
import { currentAndFutureAssignmentSalonIds, homeSalonAt } from "./salon-assignments";
import {
  RoleLockoutError,
  countHoldersPerGuardedPermission,
  decideUserMayApply,
  findLockedOutPermission,
  storedRoleAssignmentScope,
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
 * `roleGrants` — the ONE role-evaluation path (AK-73-7) — and normalize their scopes, skipping a
 * stored row that violates the D-03 shape (fail closed, IN-02); no granting assignment denies
 * before any target lookup. (d) resolve the target's live facts (employee validity, salon
 * tenant-membership and activity). (e) hand everything to the pure decision table
 * `decideUserMayApply`.
 *
 * Answers "may", not "should": it does not exclude the user's own employee as a target, so it
 * never replaces a self-approval or different-approver check (74b review IN-01, see
 * `decideUserMayApply`).
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
    // 74b review IN-02: a row that violates the D-03 shape (no DB CHECK constraint exists)
    // contributes nothing — fail closed for that row, never throw for the whole check.
    const scope = storedRoleAssignmentScope(assignment);
    if (scope === null) continue;
    grantingScopes.push(scope);
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

// ── Reach resolution (Phase 91b, Issue #91, D-03/D-04) ──────────────────────────────────────────

/**
 * D-04: how far does `ctx.actor` reach for `permission`, right now?
 *
 * Reach depends on WHICH permission is asked about — a SALONS assignment might grant
 * `time-entry:read:ZUGEWIESEN` via one role while a separate TENANT assignment on the SAME user
 * grants `leave-request:read:ZUGEWIESEN` — so this cannot be a static field of `AccessContext`
 * (built once, before any permission is known); it is a new async, DB-touching function instead.
 *
 * - `ctx.actor.kind !== "user"` (apiKey, system) → `{ kind: "wholeTenant" }` unconditionally, no
 *   `RoleAssignment` read at all — API keys stay out of scope in this phase (D-04).
 * - No stored assignment at all → `{ kind: "scoped", salonIds: [], employeeIds: [] }` (#539, D-02/
 *   D-03): reach comes ONLY from stored rows, exactly like `resolveGrants()`/
 *   `userIdsHoldingPermission()`. The former legacy-role fallback ("Altrollen-Rückfall", which let
 *   the system role of `User.role` stand in as one implicit TENANT assignment) no longer exists, so
 *   a user without a row — and a deleted user, who has none — fails closed (see
 *   `resolve-access-reach.test.ts`'s mutation proof M2).
 * - Otherwise: union every well-formed assignment (`storedRoleAssignmentScope`, IN-02, fail closed
 *   on a malformed row exactly like `userMayApply`/`userIdsHoldingPermission`) whose role belongs
 *   to this tenant and grants `permission` via `roleGrants` (AK-73-7, the one role-evaluation
 *   path). Any well-formed TENANT grant short-circuits to `{ kind: "wholeTenant" }` (matches
 *   `decideUserMayApply`'s "any TENANT grant wins" precedence). Otherwise the SALONS ids and
 *   PERSONS ids of every granting assignment are unioned into one `scoped` reach — the salon ids
 *   are filtered to CURRENTLY active salons with one batched query (salon activity is evaluated
 *   live, never stored on the assignment, same as `decideUserMayApply`'s `targetSalon.isActive`
 *   check).
 *
 * An unknown `permission` throws — the same fail-loud philosophy as `request-permissions.ts`'s
 * `assertKnownKey`; a typo must never silently read as "no reach".
 */
export async function resolveAccessReach(
  db: Prisma.TransactionClient,
  ctx: AccessContext,
  permission: PermissionKey,
): Promise<AccessReach> {
  const catalogEntry = PERMISSIONS.find((candidate) => permissionKey(candidate) === permission);
  if (!catalogEntry) {
    throw new Error(`resolveAccessReach: unknown permission "${permission}" (not in the catalog)`);
  }

  if (ctx.actor.kind !== "user") {
    return { kind: "wholeTenant" };
  }
  const userId = ctx.actor.userId;
  const tenantId = ctx.tenantId;

  const assignments = await db.roleAssignment.findMany({
    where: { tenantId, userId },
    include: { accessRole: true },
  });

  // Zero rows: the loop below sees nothing and the answer is the scoped-empty reach (fail closed).
  const salonIds = new Set<string>();
  const employeeIds = new Set<string>();
  for (const assignment of assignments) {
    const accessRole = assignment.accessRole;
    const roleBelongsHere = accessRole.tenantId === null || accessRole.tenantId === tenantId;
    if (!roleBelongsHere) continue;
    if (!roleGrants(accessRole, permission)) continue;
    // 74b review IN-02, mirrored: a row that violates the D-03 shape contributes nothing.
    const scope = storedRoleAssignmentScope(assignment);
    if (scope === null) continue;
    if (scope.scopeType === "TENANT") {
      return { kind: "wholeTenant" };
    }
    for (const salonId of scope.salonIds) salonIds.add(salonId);
    for (const employeeId of scope.employeeIds) employeeIds.add(employeeId);
  }

  let activeSalonIds: string[] = [];
  if (salonIds.size > 0) {
    const activeSalons = await db.salon.findMany({
      where: { tenantId, id: { in: [...salonIds] }, isActive: true },
      select: { id: true },
    });
    activeSalonIds = activeSalons.map((salon) => salon.id);
  }

  return {
    kind: "scoped",
    salonIds: activeSalonIds.sort(),
    employeeIds: [...employeeIds].sort(),
  };
}

// ── Salon context (Phase 82, Issue #82, D-03/D-04) ───────────────────────────────────────────────

/** The salons a caller can reach, as {@link contextSalonIds} answers it (ids ascending). */
export type ContextSalonIds = {
  /** Union of `managedSalonIds` and `ownSalonIds`. */
  salonIds: string[];
  /** Reach of the caller's stored role assignments (none stored → empty, #539). */
  managedSalonIds: string[];
  /** Salons of the caller's own current and future salon assignments. */
  ownSalonIds: string[];
  /** The caller's HOME salon on `today`, only when it is in `salonIds`. */
  homeSalonId: string | null;
};

/** Ascending by UTF-16 code unit — the same order as a bare `.sort()`, stated explicitly. */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Every ZUGEWIESEN key of the catalog — "grants at least one of these" makes a role managing. */
const ZUGEWIESEN_KEYS: readonly PermissionKey[] = PERMISSIONS.filter(
  (permission) => permission.reach === "ZUGEWIESEN",
).map(permissionKey);

/**
 * Phase 82 (Issue #82, D-03): the ACTIVE salons of `ctx.tenantId` the caller can reach — the input
 * of the web's salon context (`GET /api/v1/me/context`). A PRESENTATION context only, never an
 * access decision: every endpoint keeps resolving its own reach per permission
 * ({@link resolveAccessReach}), and nothing reads this answer back (D-05).
 *
 * The union of two parts:
 * - **managed:** every well-formed assignment whose role (system or this tenant's) grants at least
 *   one ZUGEWIESEN key — TENANT → every active salon, SALONS → those of its salons that are active
 *   in this tenant, PERSONS → none (a person list is not a salon). No stored assignment → no
 *   managed salon, like {@link resolveAccessReach} (#539: the legacy-role fallback is gone); a
 *   deleted user manages nothing. A non-user actor (API key, job) reaches every active salon, mirroring
 *   `resolveAccessReach`'s `wholeTenant` answer.
 * - **own:** the salons of the caller's own current and future salon assignments
 *   ({@link currentAndFutureAssignmentSalonIds}, Phase 87b D-10 — the validity rule lives there
 *   only), filtered to active salons — an employee working in two salons reaches its own data in
 *   both (EIGENE reach).
 *
 * `context-salon-ids-82.test.ts` pins the managed part EQUAL to the union of `resolveAccessReach`
 * over every ZUGEWIESEN key, so the two can never drift apart. Not re-exported from
 * `contexts/platform/index.ts` — only platform's own `me.ts` reads it, so it is no Unterbau change
 * in the sense of ADR 0002 Entscheidung 7.
 */
export async function contextSalonIds(
  db: Prisma.TransactionClient,
  ctx: AccessContext,
  today: Date,
): Promise<ContextSalonIds> {
  const tenantId = ctx.tenantId;
  const activeSalonIds = async (): Promise<string[]> =>
    (await listSalons(db, tenantId, { includeInactive: false }))
      .map((salon) => salon.id)
      .sort(byCodeUnit);

  if (ctx.actor.kind !== "user") {
    return {
      salonIds: await activeSalonIds(),
      managedSalonIds: await activeSalonIds(),
      ownSalonIds: [],
      homeSalonId: null,
    };
  }
  const userId = ctx.actor.userId;
  const grantsAnyZugewiesen = (role: { tenantId: string | null; permissions: readonly string[] }) =>
    ZUGEWIESEN_KEYS.some((key) => roleGrants(role, key));

  let managed: string[] = [];
  const assignments = await db.roleAssignment.findMany({
    where: { tenantId, userId },
    include: { accessRole: true },
  });
  // #539, D-02/D-03: zero stored rows leave `managed` empty (fail closed) — no legacy-role stand-in.
  const collected = new Set<string>();
  let wholeTenant = false;
  for (const assignment of assignments) {
    const accessRole = assignment.accessRole;
    const roleBelongsHere = accessRole.tenantId === null || accessRole.tenantId === tenantId;
    if (!roleBelongsHere) continue;
    if (!grantsAnyZugewiesen(accessRole)) continue;
    const scope = storedRoleAssignmentScope(assignment);
    if (scope === null) continue;
    if (scope.scopeType === "TENANT") {
      wholeTenant = true;
      break;
    }
    for (const salonId of scope.salonIds) collected.add(salonId);
  }
  if (wholeTenant) {
    managed = await activeSalonIds();
  } else if (collected.size > 0) {
    const salons = await db.salon.findMany({
      where: { tenantId, id: { in: [...collected] }, isActive: true },
      select: { id: true },
    });
    managed = salons.map((salon) => salon.id).sort(byCodeUnit);
  }

  let own: string[] = [];
  let homeSalonId: string | null = null;
  const employee = await db.employee.findFirst({
    where: { tenantId, userId, ...NOT_ANONYMIZED_EMPLOYEE_WHERE },
    select: { id: true },
  });
  if (employee) {
    const candidateIds = await currentAndFutureAssignmentSalonIds(db, tenantId, employee.id, today);
    if (candidateIds.length > 0) {
      const salons = await db.salon.findMany({
        where: { tenantId, id: { in: candidateIds }, isActive: true },
        select: { id: true },
      });
      own = salons.map((salon) => salon.id).sort(byCodeUnit);
    }
  }

  const salonIds = [...new Set([...managed, ...own])].sort(byCodeUnit);
  if (employee) {
    const home = await homeSalonAt(db, tenantId, employee.id, today);
    if (home && salonIds.includes(home.salonId)) homeSalonId = home.salonId;
  }
  return { salonIds, managedSalonIds: managed, ownSalonIds: own, homeSalonId };
}

// ── DSGVO removal (Phase 74b, D-22) ─────────────────────────────────────────────────────────────

/** One removed assignment, in the shape the caller's `DELETE` audit records as `oldValue`. */
export type RemovedRoleAssignment = {
  id: string;
  userId: string;
  accessRoleId: string;
  roleName: string;
  scopeType: "TENANT" | "SALONS" | "PERSONS";
  salonIds: string[];
  employeeIds: string[];
};

/**
 * D-22: hard-deletes every role assignment of `userId` in `tenantId` and returns the removed rows.
 *
 * Called by `anonymizeEmployeeData` inside the anonymization transaction (DSGVO Art. 17). An
 * anonymized person must not hold any right, and a leftover row would block deleting its role
 * forever (`RoleAssignment.accessRoleId` is `onDelete: Restrict`). This module has no `app`, so the
 * rows are returned for the caller to write one `DELETE` audit entry each. Person-scope lists of
 * OTHER users that contain the employee's id are left alone: they hold ids only, and the
 * resolution (`userMayApply`) ignores anonymized targets.
 */
export async function removeRoleAssignmentsOfUser(
  db: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
): Promise<RemovedRoleAssignment[]> {
  const rows = await db.roleAssignment.findMany({
    where: { tenantId, userId },
    include: { accessRole: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return [];
  // Delete exactly the rows loaded above, so every deletion has its audit entry.
  await db.roleAssignment.deleteMany({
    where: { tenantId, userId, id: { in: rows.map((row) => row.id) } },
  });
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    accessRoleId: row.accessRoleId,
    roleName: row.accessRole.name,
    scopeType: row.scopeType,
    salonIds: row.salonIds,
    employeeIds: row.employeeIds,
  }));
}

// ── Lockout protection (Phase 74b, D-17..D-19) ──────────────────────────────────────────────────

/**
 * D-17: the number of distinct holders per guarded permission in `tenantId`, as seen by `db`. A
 * holder is an active user whose employee belongs to the tenant, with a well-formed TENANT-scope
 * assignment in the tenant whose role grants the permission. Reading through `db` means that, inside a
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
      // 74b review IN-02: only a well-formed TENANT row (both lists empty, D-03) makes a holder
      // — the same rows `userMayApply` evaluates. A malformed one grants nothing there, so
      // counting it here would let the guard remove the last holder who actually has the right.
      salonIds: { isEmpty: true },
      employeeIds: { isEmpty: true },
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
 * D-19: takes the tenant row lock that serialises every change to the tenant's role assignments,
 * for the rest of the caller's transaction. MUST be called on the transaction client of an
 * interactive `$transaction`; the lock is released at commit or rollback.
 *
 * {@link withRoleLockoutGuard} takes it first. A write that cannot decrease any holder count (a
 * grant) needs no before/after count but still needs the lock: without it, `POST
 * /role-assignments` could check "user not anonymized" before a concurrent anonymization commits
 * and insert after it, leaving an anonymized person with an assignment (74b review WR-02, D-22).
 * Every statement after the lock reads a fresh READ COMMITTED snapshot, so it sees what the
 * previous lock holder committed.
 *
 * Lock mode `FOR NO KEY UPDATE`, see {@link withRoleLockoutGuard} for why not `FOR UPDATE`.
 */
export async function lockTenantForRoleChanges(
  db: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await db.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR NO KEY UPDATE`;
}

/**
 * D-19: runs `write` under the lockout rule and returns its result.
 *
 * MUST be called inside an interactive `$transaction`, with the SAME client the write (and its
 * audit) uses. The tenant row lock lasts only as long as the transaction it runs in, and the
 * after-count must see the write's uncommitted effect. Counting on another client would read the
 * pre-write state and never fire (74b-RESEARCH Pitfall 9).
 *
 * Order: lock the tenant row `FOR NO KEY UPDATE` ({@link lockTenantForRoleChanges}), which
 * serialises every guarded change in the tenant. Then count holders, run `write`, and count again. When a guarded permission went from
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
  await lockTenantForRoleChanges(db, tenantId);
  const before = await countGuardedPermissionHolders(db, tenantId);
  const result = await write();
  const after = await countGuardedPermissionHolders(db, tenantId);
  const lockedOut = findLockedOutPermission(before, after);
  if (lockedOut !== null) {
    throw new RoleLockoutError(lockedOut);
  }
  return result;
}

// ── Notification recipients (Phase 75b, Issue #75, D-16/D-17) ──────────────────────────────────

/**
 * D-16: the ids of every user of `tenantId` who holds `permission` — a ZUGEWIESEN permission only
 * (an EIGENE key answers nothing at tenant scope, so it throws — D-09). A holder is
 *
 * (a) a well-formed assignment (D-03 shape — fail closed on a malformed row, IN-02:
 *     `storedRoleAssignmentScope` returns `null` for a TENANT row with a non-empty salon/employee
 *     list just as much as for a SALONS/PERSONS row with an empty one) whose role belongs to the
 *     tenant (a system role, or a customer role OF this tenant — a customer role of a FOREIGN
 *     tenant grants nothing even if a row references it) and grants `permission` via `roleGrants`,
 *     the ONE role-evaluation path (AK-73-7) — a TENANT-scope row always qualifies; a SALONS/
 *     PERSONS row qualifies only when `permission`'s resource has relation `PERSON` (Issue #367,
 *     see below).
 * Nobody else is a holder (#539, D-02/D-03): a user with NO stored `RoleAssignment` in the tenant
 * holds nothing and is never returned. The former legacy-role fallback ("Altrollen-Rückfall", which
 * mapped `User.role` onto a system role for such a user) no longer exists.
 *
 * Issue #367 (owner decision 2026-09-29, revises Phase 91b's D-09, ADR 0001-abweichungen Eintrag
 * P): before this fix, (a) required a TENANT-scope row specifically — a SALONS or PERSONS
 * assignment never contributed a candidate here, even when its role would grant `permission` under
 * a TENANT scope. That made every notification-recipient site relying on this function
 * structurally unreachable for a SALONS/PERSONS holder, because `resolveScopedHolderIds()` (D-17)
 * can only narrow a candidate that is already in the list — it never adds one. This function now
 * mirrors D-05's own `zugewiesen`/`zugewiesenAnyScope` split (`request-permissions.ts`): a
 * PERSON-relation permission (every recipient site except one) also accepts a well-formed SALONS/
 * PERSONS candidate, narrowed to the caller's actual salon(s)/person(s) by
 * `resolveScopedHolderIds()` (D-17, unchanged) — never by this facade. A MANDANT-relation
 * permission (`leave-config:manage`, `carryover-warning.ts`'s ONE caller in this category) stays
 * restricted to TENANT-scope candidates only, exactly as before this fix — role composition is not
 * restricted by relation (nothing stops a SALONS-scoped role from also bundling a MANDANT-relation
 * permission), so without this split that caller's un-narrowed candidate list would silently widen
 * too, handing a scoped holder a tenant-wide notification their own access reach could never
 * actually satisfy at the real gate.
 *
 * A caller that does NOT narrow via `resolveScopedHolderIds()` after calling this function is safe
 * only for a MANDANT-relation permission (the candidate set for it is unchanged by this fix); every
 * PERSON-relation caller narrows.
 *
 * Every recipient site (D-16, D-17) keeps its OWN other filters — `isActive`, the employee's
 * tenant, an actor/target skip, the select shape. This facade answers only "who holds the
 * permission", scoped to `tenantId`'s employees; it does not filter `isActive` itself, so an
 * inactive holder is still returned here — exactly what lets a site's own `isActive` filter (or
 * its absence) be the thing the neutrality recording actually exercises, per site.
 *
 * Phase 355 (Issue #355): a departed holder — `Employee.exitDate` set AND in the past, the same
 * "employed as of a date" convention `homeSalonUsageFrom` (`facade/salon-assignments.ts`) uses —
 * is dropped here, the ONE place every one of the 17 recipient lookups (D-16/D-17) resolves
 * through, so a departed ADMIN/MANAGER stops being a notification recipient everywhere at once
 * instead of needing a fix at each of the 17 call sites. Unlike `isActive`, no site filtered
 * `exitDate` on its own before this (docs/permissions.md § Empfängersuchen), which is exactly
 * the personal-data leak #355 reports. An anonymized employee is unaffected by this new filter —
 * DSGVO anonymization already sets `User.isActive` to `false` (see "DSGVO Employee Deletion" in
 * CLAUDE.md), which every site's own `isActive` filter already excludes; anonymization does not
 * set `exitDate`, so this filter does not need to special-case it. A holder whose `exitDate` is in
 * the FUTURE (a planned, not-yet-effective departure) is still a holder — only a past `exitDate`
 * counts as departed.
 *
 */
export async function userIdsHoldingPermission(
  db: Prisma.TransactionClient,
  tenantId: string,
  permission: PermissionKey,
): Promise<string[]> {
  const catalogEntry = PERMISSIONS.find((candidate) => permissionKey(candidate) === permission);
  if (!catalogEntry || catalogEntry.reach !== "ZUGEWIESEN") {
    throw new RangeError(
      `userIdsHoldingPermission: "${permission}" is not a ZUGEWIESEN permission`,
    );
  }

  // Every stored assignment of the tenant, any scope; only a well-formed granting one makes a holder
  // (#539: a user without any stored row holds nothing).
  const assignments = await db.roleAssignment.findMany({
    where: { tenantId },
    select: {
      userId: true,
      scopeType: true,
      salonIds: true,
      employeeIds: true,
      accessRole: { select: { tenantId: true, permissions: true } },
    },
  });

  // Issue #367: mirrors D-05's own `zugewiesen`/`zugewiesenAnyScope` split (`request-
  // permissions.ts`) — a MANDANT-relation permission (e.g. `leave-config:manage`) stays candidate-
  // restricted to TENANT-scope assignments, same as before this fix; a PERSON-relation permission
  // (every other ZUGEWIESEN permission a recipient site asks for) now also accepts a well-formed
  // SALONS/PERSONS assignment. Without this split, a role that happens to bundle a MANDANT-
  // relation permission together with PERSON-relation ones (nothing prevents that — role
  // composition is not restricted by relation, see `permission-catalog.ts` § Relation) onto a
  // SALONS/PERSONS assignment would silently become a tenant-wide-config candidate too, which
  // `carryover-warning.ts`'s un-narrowed `leave-config:manage` lookup would then hand a scoped
  // holder a MANDANT notification their own access reach could never actually satisfy (D-05's
  // `hasPermission` gate reads the narrower `zugewiesen` set for MANDANT, never
  // `zugewiesenAnyScope`) — measured while building this fix's neutrality-amendment coverage.
  const isPersonRelation = PERMISSION_RESOURCES[catalogEntry.resource].relation === "PERSON";

  const storedHolderIds = new Set<string>();
  for (const assignment of assignments) {
    // A well-formed TENANT row is always a candidate; a well-formed SALONS/PERSONS row is a
    // candidate only for a PERSON-relation permission (see above). `storedRoleAssignmentScope` is
    // the ONE D-03 shape check (IN-02, fail closed on a malformed row, whichever scope it claims).
    // Narrowing a SALONS/PERSONS holder to their actual scope remains `resolveScopedHolderIds()`'s
    // job (D-17), not this facade's.
    const scope = storedRoleAssignmentScope(assignment);
    if (scope === null) continue;
    if (scope.scopeType !== "TENANT" && !isPersonRelation) continue;
    const roleBelongsHere =
      assignment.accessRole.tenantId === null || assignment.accessRole.tenantId === tenantId;
    if (!roleBelongsHere) continue;
    if (!roleGrants(assignment.accessRole, permission)) continue;
    storedHolderIds.add(assignment.userId);
  }

  const candidateIds = [...storedHolderIds];
  if (candidateIds.length === 0) return [];

  // Phase 355 (Issue #355): drop a departed candidate — `exitDate` set and in the past — the ONE
  // place this is checked for every recipient lookup. `isActive` stays each site's own job
  // (unchanged, see the docstring above).
  const departedEmployees = await db.employee.findMany({
    where: { tenantId, userId: { in: candidateIds }, exitDate: { lt: new Date() } },
    select: { userId: true },
  });
  const departedUserIds = new Set(departedEmployees.map((employee) => employee.userId));

  return candidateIds.filter((id) => !departedUserIds.has(id)).sort();
}

/**
 * Phase 91b (Issue #91), D-17: narrows `userIdsHoldingPermission`'s tenant-wide holder list to the
 * holders whose OWN resolved reach for `permission` covers the affected resource — the ONE shared
 * narrowing point every manager-notification site in this phase uses; no site re-implements the
 * per-user reach resolution inline.
 *
 * For each `candidateUserIds` entry, resolves that user's own `AccessReach` for `permission` via
 * {@link resolveAccessReach} against a freshly built `AccessContext` (its `reach` field is the
 * constructor's static base, irrelevant here since `resolveAccessReach` ignores it and re-derives
 * per permission from the user's stored `RoleAssignment` rows). A `wholeTenant` reach ALWAYS keeps
 * the user, regardless of the specific `isInScope` callback — enforced HERE, in the one shared
 * narrowing point, rather than trusted to every callback's own implementation (T-91b-38: a
 * misbehaving or incomplete `isInScope` callback must never silently drop a whole-tenant holder
 * from a notification). Every OTHER reach is kept only when `isInScope(reach)` resolves `true`.
 *
 * Callers pass `userIdsHoldingPermission`'s own output as `candidateUserIds` — a candidate that
 * (defensively) holds nothing at all for `permission` still resolves without throwing (its reach
 * fails every `isInScope` check and it is simply excluded). Order of `candidateUserIds` is
 * preserved for ids that are kept (a stable filter, never a re-sort).
 *
 * Only narrows the recipient SET. Every existing lock or eligibility decision (self-approval,
 * four-eyes, cancellation) at a call site is untouched by this function.
 */
export async function resolveScopedHolderIds(
  db: Prisma.TransactionClient,
  tenantId: string,
  candidateUserIds: readonly string[],
  permission: PermissionKey,
  isInScope: (reach: AccessReach) => Promise<boolean> | boolean,
): Promise<string[]> {
  const kept: string[] = [];
  for (const userId of candidateUserIds) {
    const ctx: AccessContext = {
      tenantId,
      actor: { kind: "user", userId },
      reach: { kind: "wholeTenant" },
    };
    const reach = await resolveAccessReach(db, ctx, permission);
    if (reach.kind === "wholeTenant" || (await isInScope(reach))) {
      kept.push(userId);
    }
  }
  return kept;
}

/**
 * Issue #538: the display names of the roles each of `userIds` holds - the ONE derivation behind
 * the caller's own role label (`GET /me/context`) and the per-person role chip of
 * `GET /employees`. Presentation only, it decides nothing; names only. Same source as the access
 * decision: the stored assignments of this tenant (system roles and this tenant's own roles)
 * and nothing else (#539: a user with none stored has no role and maps to an empty list). Distinct,
 * sorted by name. A user id that does not exist maps to an empty list. Two queries for any number of users. Not re-exported from
 * `contexts/platform/index.ts`.
 */
export async function roleNamesByUserId(
  db: Prisma.TransactionClient,
  tenantId: string,
  userIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (userIds.length === 0) return result;
  const namesByUser = new Map<string, Set<string>>();
  const assignments = await db.roleAssignment.findMany({
    where: { tenantId, userId: { in: [...userIds] } },
    select: { userId: true, accessRole: { select: { name: true, tenantId: true } } },
  });
  for (const assignment of assignments) {
    const role = assignment.accessRole;
    if (role.tenantId !== null && role.tenantId !== tenantId) continue;
    const names = namesByUser.get(assignment.userId) ?? new Set<string>();
    names.add(role.name);
    namesByUser.set(assignment.userId, names);
  }
  for (const id of userIds) {
    result.set(
      id,
      [...(namesByUser.get(id) ?? [])].sort((a, b) => a.localeCompare(b, "de")),
    );
  }
  return result;
}

/** The role names of one user (see {@link roleNamesByUserId}); the caller's own label. */
export async function ownRoleNames(
  db: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
): Promise<string[]> {
  return (await roleNamesByUserId(db, tenantId, [userId])).get(userId) ?? [];
}
