import { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { Prisma, type Role, type RoleAssignmentScopeType } from "@clokr/db";
import { requireAuth } from "../../../middleware/auth";
import { hasPermission, permissionReach, requirePermission } from "../request-permissions";
import { loadPasswordPolicy } from "../password-policy";
import { accessContextFromRequest } from "../access-context"; // Phase 91b Plan 10 (#91), D-12/D-14
import { resolveAccessReach } from "../facade/role-assignments"; // Phase 91b Plan 10 (#91), D-12/D-14
import {
  isPersonMasterDataInScope,
  isStammsalonScopeMatch,
  resolvePersonScopedEmployeeIds,
  resolveStammsalonScopedEmployeeIds,
} from "../scope-filter"; // Phase 91b Plan 10 (#91), D-10/D-12/D-14; Phase 85b Plan 01 (#547), D-01/D-02
import { anonymizeEmployeeData, NOT_ANONYMIZED_EMPLOYEE_WHERE } from "../anonymize";
import {
  removeRoleAssignmentsOfUser,
  withRoleLockoutGuard,
  type RemovedRoleAssignment,
} from "../facade/role-assignments";
import { requestAuditFields } from "../request-audit-fields";
import { RoleLockoutError, ROLE_LOCKOUT_MESSAGE } from "../role-assignment";
import {
  assignmentsBlockingDemotionToEmployee,
  isDemotionToEmployee,
  replaceSystemRoleAssignment,
  requestedRoleNeedsRoleAssignmentManage,
  requestedRoleUnchanged,
  ROLE_DEMOTION_BLOCKED_MESSAGE_PREFIX,
  RoleDemotionBlockedError,
  syncCompatRoleColumn,
} from "../compat-role";
import {
  auditRoleAssignmentChange,
  createdAssignmentAuditEntry,
  removedAssignmentAuditEntry,
} from "../role-assignment-audit";
import { hardDeleteOvertimeDataForEmployee, getTenantTimezone } from "../../working-time-account"; // Phase 100B Plan 06 — W13/W15; Phase 67b Plan 03 — D-22/D-07
import {
  ARBZG_FLOOR_OVER_6H,
  ARBZG_FLOOR_OVER_9H,
  BREAK_MAX_OVER_6H,
  BREAK_MAX_OVER_9H,
  hardDeleteTimeDataForEmployee,
} from "../../time-tracking"; // Phase 100B Plan 08 — T11; issue #246, E-6
import {
  getVacationEntitlement,
  hardDeleteEntitlementsForEmployee,
  getSection9DocumentPaths,
  getAbsenceDocumentPaths,
  hardDeleteAbsencesForEmployee,
  hardDeleteLeaveRequestsForEmployee,
  statutoryMinimumVacationDays, // Issue #435 (D-11) — 5-day-base floor on POST/PATCH
  statutoryMinimumViolationMessage, // Issue #435 (D-11) — the ONE German 400 message builder
  daysDiffer, // Issue #435 code review (WR-01) — reused by the PATCH "did annualVacationDays change" guard
  syncExitYearVacationEntitlement, // Issue #447 (D-07) — recomputes an exit-year row on exitDate set/change
  exitVacationOverUseWarning, // Issue #447 (D-08) — the one over-use warning string
} from "../../absence"; // Phase 100B Plan 10 — A11 (Issue #205 reroute) / F3; Plan 11 — F3; Plan 12 — F3; Plan 13 — F3; issue #246, E-6; issue #416; issue #435; issue #436; issue #447 (E-4 resolved)
// Phase 67b Plan 03 (issue #67, D-22/D-07/D-24) — the Stammsalon lifecycle helpers.
import { fillHomeGapBeforeHireDate, readTenantTimezone } from "../facade/salon-assignments";
import { salonExistsInForeignTenant } from "../facade/salons";
import { auditSalonAssignmentEvent } from "../salon-assignment-audit";
import { dayToDate, tenantLocalDay, toAssignmentDto } from "../salon-assignment-rules";
import {
  bsSlotEmployeeFields,
  createEmployeeInTransaction,
  createEmployeeSchema,
  employeeClassificationSchema,
  employeeCreatedAuditValue,
  prepareEmployeeCreation,
  reissueEmployeeInvitation,
  type EmployeeCreationAudit,
} from "../employee-creation"; // Phase 88 Plan 10 (D-04a) — the one place employee creation lives

// ── Retention constant ─────────────────────────────────────────────────────
const DEFAULT_RETENTION_YEARS = 10;

// Issue #357 sub-fix B: the German scope label for the demotion-blocked 409 message.
const SCOPE_LABEL: Record<RoleAssignmentScopeType, string> = {
  TENANT: "mandantenweit",
  SALONS: "salonbezogen",
  PERSONS: "personenbezogen",
};

const idParamSchema = z.object({ id: z.string().uuid() });

const updateEmployeeSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  employeeNumber: z.string().min(1).optional(),
  hireDate: z.string().datetime().optional(),
  role: z.enum(["ADMIN", "MANAGER", "EMPLOYEE"]).optional(),
  nfcCardId: z.string().nullable().optional(),
  exitDate: z.string().datetime().nullable().optional(),
  // Phase 65 — Geburtsdatum (needed for JArbSchG §9 AZUBI <18 check + UI suggestion)
  birthDate: z.string().datetime().nullable().optional(),
  // Issue #435 D-02/D-11 — identical Zod chain to createEmployeeSchema's field; null = back to
  // the classification-aware base value from resolveVacationBaseDays() (Issue #482). The
  // statutory-minimum 400 runs in the handler.
  annualVacationDays: z
    .number()
    .min(0.5)
    .max(365)
    .refine((v) => Math.round(v * 100) / 100 === v, "Höchstens zwei Nachkommastellen.")
    .optional()
    .nullable(),
  // Personalstruktur (Phase 41)
  classification: employeeClassificationSchema.optional(),
  coverageWeight: z.number().min(0).max(9.99).optional(),
  requiresSupervision: z.boolean().optional(),
  // Phase 64 — Pausendauer Override (D-08, BREAK-02, BREAK-04):
  // nullable Int — null clears override → fall back to TenantConfig defaults.
  breakOver6hOverride: z
    .number()
    .int()
    .min(
      ARBZG_FLOOR_OVER_6H,
      "Pausendauer für Arbeitstage über 6 Stunden darf nicht unter 30 Minuten liegen (ArbZG §4 Pflichtpause).",
    )
    .max(
      BREAK_MAX_OVER_6H,
      "Pausendauer für Arbeitstage über 6 Stunden darf 120 Minuten nicht überschreiten.",
    )
    .nullable()
    .optional(),
  breakOver9hOverride: z
    .number()
    .int()
    .min(
      ARBZG_FLOOR_OVER_9H,
      "Pausendauer für Arbeitstage über 9 Stunden darf nicht unter 45 Minuten liegen (ArbZG §4 Pflichtpause).",
    )
    .max(
      BREAK_MAX_OVER_9H,
      "Pausendauer für Arbeitstage über 9 Stunden darf 180 Minuten nicht überschreiten.",
    )
    .nullable()
    .optional(),
  // Phase 85.1.1 (D-01, D-04) — per-employee Phorest Vor-/Nachbereitungszeit
  // Override (update). undefined = no change, null = clear (fall back to
  // TenantConfig defaults), number 0-30 = set explicit override.
  phorestPrepMinutesOverride: z
    .number()
    .int()
    .min(0, "Vorbereitungszeit darf nicht negativ sein.")
    .max(30, "Vorbereitungszeit darf 30 Minuten nicht überschreiten.")
    .nullable()
    .optional(),
  phorestWrapupMinutesOverride: z
    .number()
    .int()
    .min(0, "Nachbereitungszeit darf nicht negativ sein.")
    .max(30, "Nachbereitungszeit darf 30 Minuten nicht überschreiten.")
    .nullable()
    .optional(),
  // Phase 76.7 (D-11, EMP-V19-01) — § 18 ArbZG-Befreiung. ADMIN-only (route
  // already gated by employee:update:ZUGEWIESEN). Boolean — null is NOT a valid value.
  // undefined = no change. Audit row SET_TIME_TRACKING_EXEMPT fires only on
  // actual value change (see PATCH handler below).
  isTimeTrackingExempt: z.boolean().optional(),
  // Phase 76.31 D-06 — per-employee bsSlot* overrides (update). undefined = no
  // change; explicit null clears the override (delegate down a layer).
  ...bsSlotEmployeeFields,
});

function deriveInvitationStatus(
  isActive: boolean,
  invitations: { expiresAt: Date; acceptedAt: Date | null }[],
): "ACCEPTED" | "PENDING" | "EXPIRED" | "NONE" {
  if (isActive) return invitations.length > 0 ? "ACCEPTED" : "NONE";
  if (invitations.length === 0) return "EXPIRED";
  const latest = invitations[0];
  if (latest.acceptedAt) return "ACCEPTED";
  if (latest.expiresAt > new Date()) return "PENDING";
  return "EXPIRED";
}

/**
 * Phase 74b (D-12/D-22): one `DELETE` audit entry per role assignment removed on behalf of `req`
 * (anonymization, hard delete), inside the caller's transaction, with `oldValue` in the D-12 shape
 * and `newValue.reason` naming the trigger. 74b review WR-06: the actor is resolved through
 * `requestAuditFields`, so an API-key caller is recorded as `newValue.actor` instead of failing
 * the `AuditLog.userId` foreign key and with it the whole transaction.
 */
async function auditRemovedRoleAssignments(
  app: FastifyInstance,
  req: FastifyRequest,
  tx: Prisma.TransactionClient,
  removed: RemovedRoleAssignment[],
  reason: string,
) {
  for (const row of removed) {
    await app.audit({
      action: "DELETE",
      entity: "RoleAssignment",
      entityId: row.id,
      oldValue: {
        userId: row.userId,
        accessRoleId: row.accessRoleId,
        roleName: row.roleName,
        scopeType: row.scopeType,
        salonIds: row.salonIds,
        employeeIds: row.employeeIds,
      },
      ...requestAuditFields(req, { reason }),
      tx,
    });
  }
}

/**
 * Phase 75b (D-15, D-26, D-29): the employee form's role setting on an EXISTING user. Must run
 * inside `withRoleLockoutGuard` on the caller's transaction — demoting the tenant's last stored
 * holder of a guarded permission then rolls back this change, the employee-field update and every
 * audit row together (D-31).
 *
 * Order: a request whose role equals the role DERIVED from the target's stored assignments (the
 * one the form shows, Issue #539 D-10/D-11) is no role change (D-16) and writes nothing. A user
 * with no stored assignment has no derived role, so any requested role runs the path below and
 * gives them one. A different value runs the path below unchanged. For a demotion TO Mitarbeiter,
 * {@link assignmentsBlockingDemotionToEmployee} runs first (Issue #357 sub-fix B) — a
 * still-granting customer-role or salon/person-scoped assignment throws
 * {@link RoleDemotionBlockedError} before any write, so the whole request (this role change AND
 * every other field on the same PATCH) rolls back atomically rather than silently applying a
 * partial demotion. Otherwise the system-role
 * assignment is replaced (customer roles untouched), the column is rewritten to the derived value,
 * and the audit rows are written in the order of the writes with the column change on the last one
 * (D-29).
 */
async function applyRoleFromEmployeeForm(
  app: FastifyInstance,
  req: FastifyRequest,
  tx: Prisma.TransactionClient,
  userId: string,
  role: Role,
): Promise<void> {
  const tenantId = req.user.tenantId;
  if (await requestedRoleUnchanged(tx, tenantId, userId, role)) return;
  if (isDemotionToEmployee(role)) {
    const blocking = await assignmentsBlockingDemotionToEmployee(tx, tenantId, userId);
    if (blocking.length > 0) throw new RoleDemotionBlockedError(blocking);
  }
  const { removed, created } = await replaceSystemRoleAssignment(tx, tenantId, userId, role);
  const compatRole = await syncCompatRoleColumn(tx, tenantId, userId);
  await auditRoleAssignmentChange(app, req, tx, {
    userId,
    entries: [
      ...removed.map((row) => removedAssignmentAuditEntry(row)),
      ...(created !== null ? [createdAssignmentAuditEntry(created)] : []),
    ],
    compatRole,
  });
}

/**
 * Phase 91b Plan 10 (Issue #91), D-12/D-14: enforces person-master-data scope on a single,
 * already-tenant-checked employee row. Returns `true` when the caller may proceed; on a scope
 * miss it writes the `SCOPE_ACCESS_DENIED` audit entry and sends the SAME 404 body the route
 * already uses for a genuinely nonexistent id (never a distinguishable 403 — T-100-09), then
 * returns `false` so the caller returns immediately. Mirrors `time-entries.ts`'s
 * `enforceTimeEntryScope` shape. Callers pass their own EIGENE/self bypass decision — this
 * function only decides scope, never ownership.
 */
async function enforcePersonScope(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: import("fastify").FastifyReply,
  employeeId: string,
  permission: import("../permission-catalog").PermissionKey,
  notFoundMessage: string,
): Promise<boolean> {
  const access = accessContextFromRequest(req);
  const scopeReach = await resolveAccessReach(app.prisma, access, permission);
  const inScope = await isPersonMasterDataInScope(
    app.prisma,
    req.user.tenantId,
    scopeReach,
    employeeId,
  );
  if (inScope) return true;
  await app.audit({
    userId: req.user.sub,
    action: "SCOPE_ACCESS_DENIED",
    entity: "Employee",
    entityId: employeeId,
    request: { ip: req.ip, headers: req.headers as Record<string, string> },
  });
  reply.code(404).send({ error: notFoundMessage });
  return false;
}

/**
 * Phase 91b Plan 10 (Issue #91), D-10/D-14: enforces Stammsalon-only scope for
 * account-lifecycle/administrative actions on an employee (unlock, deactivate, reactivate,
 * resend-invitation, anonymize/hard-delete) — deliberately NARROWER than {@link
 * enforcePersonScope}'s D-12 rule (Stammsalon-OR-active-deployment): a manager at a salon where an
 * employee is only temporarily DEPLOYED can see their basic identity data (D-12), but account
 * state changes stay a HOME-salon manager's decision, mirroring the same distinction Plan 91b-09
 * already drew for this exact permission's ACCOUNT_LOCKED notification narrowing
 * (`platform/api/auth.ts`). Stichtag = today (a live administrative action, no other natural
 * period).
 */
async function enforcePersonAdminScope(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: import("fastify").FastifyReply,
  employeeId: string,
  permission: import("../permission-catalog").PermissionKey,
  notFoundMessage: string,
): Promise<boolean> {
  const access = accessContextFromRequest(req);
  const scopeReach = await resolveAccessReach(app.prisma, access, permission);
  const inScope = await isStammsalonScopeMatch(
    app.prisma,
    req.user.tenantId,
    scopeReach,
    employeeId,
    new Date(),
  );
  if (inScope) return true;
  await app.audit({
    userId: req.user.sub,
    action: "SCOPE_ACCESS_DENIED",
    entity: "Employee",
    entityId: employeeId,
    request: { ip: req.ip, headers: req.headers as Record<string, string> },
  });
  reply.code(404).send({ error: notFoundMessage });
  return false;
}

/**
 * Issue #547 (Phase 85b Plans 01 and 15, D-02): the persons whose STORED total saldo the caller
 * may read — `"all"` for a whole-tenant `overtime:read` reach, otherwise the set of covered person
 * ids (an own-row reach covers only the caller). The ONE place this decision lives: every
 * `/employees` response that carries `overtimeAccount` goes through it plus `maskOvertimeAccount`
 * (owner decision 2026-08-27: the total saldo is visible to Inhaber, Personalabteilung and the
 * employee). Decided once per request.
 */
async function resolveBalanceVisibility(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<"all" | ReadonlySet<string>> {
  const tenantId = req.user.tenantId;
  const ownEmployeeId = req.user.employeeId ?? null;
  const overtimeReach = await permissionReach(req, "overtime:read");
  if (overtimeReach === "EIGENE") {
    return new Set(ownEmployeeId ? [ownEmployeeId] : []);
  }
  if (overtimeReach === "ZUGEWIESEN") {
    const overtimeScope = await resolveAccessReach(
      app.prisma,
      accessContextFromRequest(req),
      "overtime:read:ZUGEWIESEN",
    );
    // Stichtag = tenant-local today, computed exactly as resolvePersonScopedEmployeeIds does
    // (a running saldo has no closed-period Stichtag, see overtime.ts GET /:employeeId).
    const tz = await readTenantTimezone(app.prisma, tenantId);
    const today = dayToDate(tenantLocalDay(new Date(), tz));
    const covered = await resolveStammsalonScopedEmployeeIds(
      app.prisma,
      tenantId,
      overtimeScope,
      today,
    );
    return covered === "all"
      ? "all"
      : new Set(ownEmployeeId ? [...covered, ownEmployeeId] : covered);
  }
  return new Set<string>();
}

/**
 * Applies `resolveBalanceVisibility` to one person's account: a person without an account stays
 * `null`; a hidden balance is `null`, never a fabricated 0. Every other field of the account row
 * keeps its key so the response shape does not depend on the caller.
 */
function maskOvertimeAccount<A extends { balanceHours: unknown }>(
  visibleFor: "all" | ReadonlySet<string>,
  employeeId: string,
  account: A | null,
): (Omit<A, "balanceHours"> & { balanceHours: A["balanceHours"] | null }) | null {
  if (!account) return null;
  const visible = visibleFor === "all" || visibleFor.has(employeeId);
  return visible ? account : { ...account, balanceHours: null };
}

export async function employeeRoutes(app: FastifyInstance) {
  // GET /api/v1/employees
  //
  // Issue #547 (Phase 85b Plan 01, D-01/D-02): the list is narrowed like the single view. A scoped
  // `employee:read` reach lists only the persons of the master-data rule (Stammsalon today OR an
  // active deployment today in the reach, OR the reach's person ids) plus the caller's own row —
  // the same rule `GET /:id` applies (Phase 91b D-12), so the list is never wider than the single
  // view. `overtimeAccount.balanceHours` is the stored value only where the caller's `overtime:read`
  // reach covers the person; otherwise it is `null`, never a fabricated 0 (owner decision
  // 2026-08-27: the total saldo is visible to Inhaber, Personalabteilung and the employee). A
  // whole-tenant caller receives the unchanged response.
  app.get("/", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("employee:read:ZUGEWIESEN"),
    handler: async (req) => {
      // v1.8.8 — anonymized rows are hidden by default (team picker etc. must stay clean).
      // ADMINs can opt in via ?includeAnonymized=true so the admin employee list can surface
      // DSGVO-deleted rows for audit/management (the "Anonymisierte anzeigen" toggle). The flag
      // is honored for ADMIN only; MANAGERs never receive anonymized rows. GET /:id (audit view)
      // is NOT filtered — anonymized rows must remain resolvable by UUID (T-188-06).
      const { includeAnonymized } = req.query as { includeAnonymized?: string };
      // Lazy: the permission is checked only when the flag is actually set (issue #75, D-13)
      const showAnonymized =
        includeAnonymized === "true" && (await hasPermission(req, "employee:anonymize:ZUGEWIESEN"));

      const tenantId = req.user.tenantId;
      const ownEmployeeId = req.user.employeeId ?? null;
      const access = accessContextFromRequest(req);

      // D-01: the persons the caller's employee:read reach covers ("all" for a whole-tenant reach).
      const readReach = await resolveAccessReach(app.prisma, access, "employee:read:ZUGEWIESEN");
      const personIds = await resolvePersonScopedEmployeeIds(app.prisma, tenantId, readReach);

      const employees = await app.prisma.employee.findMany({
        where: {
          tenantId,
          ...(showAnonymized ? {} : NOT_ANONYMIZED_EMPLOYEE_WHERE),
          // The caller's own row is always part of the list (the self rule of GET /:id).
          ...(personIds !== "all"
            ? { id: { in: ownEmployeeId ? [...personIds, ownEmployeeId] : personIds } }
            : {}),
        },
        include: {
          user: { select: { email: true, role: true, isActive: true, lastLoginAt: true } },
          workSchedules: { orderBy: { validFrom: "desc" }, take: 1 },
          overtimeAccount: { select: { balanceHours: true } },
          invitations: { orderBy: { createdAt: "desc" }, take: 1 },
        },
        orderBy: { lastName: "asc" },
        // PERF-V1814-03: defense-in-depth cap (tenant scope already limits naturally)
        take: 1000,
      });

      // D-02: whose stored balance this caller may read — decided once per request.
      const balanceVisibleFor = await resolveBalanceVisibility(app, req);

      return employees.map((e) => {
        return {
          ...e,
          overtimeAccount: maskOvertimeAccount(balanceVisibleFor, e.id, e.overtimeAccount),
          workSchedule: e.workSchedules[0] ?? null,
          workSchedules: undefined,
          invitationStatus: deriveInvitationStatus(e.user.isActive, e.invitations),
          invitations: undefined,
        };
      });
    },
  });

  // GET /api/v1/employees/:id
  app.get("/:id", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      // Accept any non-empty string id (incl. legacy short ids like 'e1')
      const { id } = req.params as { id: string };
      if (!id) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      const user = req.user;

      const readReach = await permissionReach(req, "employee:read");
      if (readReach !== "ZUGEWIESEN" && user.employeeId !== id) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (readReach === null) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const employee = await app.prisma.employee.findUnique({
        where: { id, tenantId: req.user.tenantId },
        include: {
          user: { select: { email: true, role: true, isActive: true } },
          workSchedules: { orderBy: { validFrom: "desc" }, take: 1 },
          overtimeAccount: true,
          leaveEntitlements: { include: { leaveType: true } },
          invitations: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      });

      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Phase 91b Plan 10 (Issue #91), D-12/D-14: a ZUGEWIESEN reach viewing someone else's
      // profile may still be scoped to salons/persons — person master data is in scope under
      // Stammsalon-TODAY OR an active DEPLOYMENT-TODAY at one of the reach's salons, OR a listed
      // employeeId (D-12), never Stammsalon-only (D-10) — a temporarily deployed employee's basic
      // identity data is visible to their current salon's manager too.
      if (readReach === "ZUGEWIESEN" && user.employeeId !== id) {
        if (
          !(await enforcePersonScope(
            app,
            req,
            reply,
            id,
            "employee:read:ZUGEWIESEN",
            "Mitarbeiter nicht gefunden",
          ))
        ) {
          return;
        }
      }

      return {
        ...employee,
        // Issue #547 (Phase 85b Plan 15): the single view masks the total saldo exactly like the list.
        overtimeAccount: maskOvertimeAccount(
          await resolveBalanceVisibility(app, req),
          employee.id,
          employee.overtimeAccount,
        ),
        workSchedule: employee.workSchedules[0] ?? null,
        workSchedules: undefined,
        invitationStatus: deriveInvitationStatus(employee.user.isActive, employee.invitations),
        invitations: undefined,
      };
    },
  });

  // POST /api/v1/employees — Anlegen + Einladungsmail
  app.post("/", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("employee:create:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const body = createEmployeeSchema.parse(req.body);

      // Issue #354 (pre-merge security review of #75): `employee:create` covers the new hire's
      // profile, never handing out a system role — mirrors the PATCH /:id check above (D-15
      // extension). A role other than the schema default EMPLOYEE additionally needs
      // role-assignment:manage, checked before any write.
      if (
        requestedRoleNeedsRoleAssignmentManage(body.role) &&
        !(await hasPermission(req, "role-assignment:manage:ZUGEWIESEN"))
      ) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      // Everything that is rejected before a write (statutory vacation minimum, password policy,
      // workDays, usualWorkDays) is decided in employee-creation.ts — one place for the route and
      // the operator's first-admin provisioning (Phase 88, D-04a).
      const prepared = await prepareEmployeeCreation(app.prisma, req.user.tenantId, body, {
        passwordPolicy: body.password
          ? await loadPasswordPolicy(app, req.user.tenantId)
          : undefined,
      });
      if (!prepared.ok) {
        return reply.code(prepared.status).send({ error: prepared.error });
      }
      const { directPassword } = prepared;

      // The audit rows of the creation are attributed to the calling tenant user (or, for an API
      // key, recorded with an API_KEY actor) through the existing request-bound helpers.
      const tenantAudit: EmployeeCreationAudit = {
        vacationEntitlement: async (entry, tx) =>
          app.audit({
            userId: req.user.sub,
            ...entry,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
            tx,
          }),
        roleAssignmentChange: (change, tx) => auditRoleAssignmentChange(app, req, tx, change),
        salonAssignmentCreated: (entry, tx) =>
          auditSalonAssignmentEvent(app, req, {
            entity: "EmployeeSalonAssignment",
            action: "CREATE",
            entityId: entry.entityId,
            newValue: entry.newValue,
            tx,
          }),
        employeeCreated: (entry, tx) =>
          app.audit({
            userId: req.user.sub,
            action: "CREATE",
            entity: "Employee",
            entityId: entry.entityId,
            newValue: entry.newValue,
            tx,
          }),
      };

      const result = await app.prisma.$transaction((tx: Prisma.TransactionClient) =>
        createEmployeeInTransaction(tx, req.user.tenantId, body, prepared, tenantAudit),
      );

      if (result.status !== "OK") {
        switch (result.status) {
          case "SALON_NOT_FOUND": {
            // T-100-09: byte-identical 400 for a foreign tenant's real salon and a nonexistent one;
            // the CROSS_TENANT audit fires only for the foreign case and never reaches the client.
            if (
              await salonExistsInForeignTenant(app.prisma, req.user.tenantId, body.homeSalonId!)
            ) {
              await auditSalonAssignmentEvent(app, req, {
                entity: "Salon",
                action: "CROSS_TENANT_ACCESS_DENIED",
                entityId: body.homeSalonId!,
              });
            }
            return reply.code(400).send({ error: "Salon nicht gefunden" });
          }
          case "SALON_INACTIVE":
            return reply.code(400).send({
              error: "Einem deaktivierten Salon kann keine neue Zuordnung zugewiesen werden.",
            });
          case "HOME_SALON_REQUIRED":
            return reply.code(400).send({
              error: "Bei mehreren aktiven Salons ist die Angabe des Stammsalons erforderlich.",
            });
          case "NO_ACTIVE_SALON":
            return reply.code(400).send({ error: "Der Mandant hat keinen aktiven Salon." });
          default: {
            // Compile-time exhaustiveness: resolveHomeSalonForNewEmployee's return type has no
            // other non-OK status.
            const unreachable: never = result;
            return unreachable;
          }
        }
      }

      const { employee, user, workSchedule, invitation, invitationToken } = result;

      await tenantAudit.employeeCreated({
        entityId: employee.id,
        newValue: employeeCreatedAuditValue(employee, body, workSchedule, directPassword),
      });

      // Einladungsmail nur senden wenn kein direktes Passwort
      let emailError: string | undefined;
      if (!directPassword && invitationToken) {
        try {
          await app.mailer.sendInvitation({
            to: body.email,
            firstName: body.firstName,
            token: invitationToken,
            tenantId: req.user.tenantId,
          });
        } catch (err) {
          emailError = "E-Mail konnte nicht gesendet werden. Bitte SMTP-Einstellungen prüfen.";
          app.log.error({ err }, "Einladungsmail konnte nicht gesendet werden");
        }
      }

      // Re-fetch the created employee with the full shape (same as GET /employees)
      // so the frontend can append it to the list without a full page reload.
      try {
        const fullEmployee = await app.prisma.employee.findUniqueOrThrow({
          where: { id: employee.id },
          include: {
            user: { select: { email: true, role: true, isActive: true, lastLoginAt: true } },
            workSchedules: { orderBy: { validFrom: "desc" }, take: 1 },
            overtimeAccount: { select: { balanceHours: true } },
            invitations: { orderBy: { createdAt: "desc" }, take: 1 },
          },
        });

        return reply.code(201).send({
          ...fullEmployee,
          workSchedule: fullEmployee.workSchedules[0] ?? null,
          workSchedules: undefined,
          invitationStatus: directPassword
            ? "ACCEPTED"
            : deriveInvitationStatus(fullEmployee.user.isActive, fullEmployee.invitations),
          invitations: undefined,
          ...(emailError ? { emailError } : {}),
        });
      } catch (err) {
        // Issue #379: the creation transaction above already committed durably — a failure of
        // this independent post-commit read (measured on int: a transient DNS blip) must not
        // surface as a 500 for a request that in truth fully succeeded. A naive client retry on
        // a false 500 would then hit 409 (duplicate employeeNumber) or create a near-duplicate.
        // Answer 201 from the data the transaction already produced instead of a second read.
        app.log.error(
          { err, employeeId: employee.id },
          "Mitarbeiter angelegt, aber Nachladen für die Antwort fehlgeschlagen — antworte mit Transaktionsdaten",
        );

        return reply.code(201).send({
          ...employee,
          user: {
            email: user.email,
            role: user.role,
            isActive: user.isActive,
            lastLoginAt: user.lastLoginAt,
          },
          workSchedule,
          // createOvertimeAccount() writes balanceHours: 0 unconditionally for a brand-new
          // account (apps/api/src/contexts/working-time-account/facade/overtime-account.ts:233-240)
          // — a fresh account can only ever be 0 immediately after creation, so this is not a guess.
          overtimeAccount: { balanceHours: 0 },
          invitationStatus: directPassword
            ? "ACCEPTED"
            : deriveInvitationStatus(user.isActive, invitation ? [invitation] : []),
          ...(emailError ? { emailError } : {}),
        });
      }
    },
  });

  // PATCH /api/v1/employees/:id — Profil aktualisieren
  app.patch("/:id", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("employee:update:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const body = updateEmployeeSchema.parse(req.body);

      // Phase 75b (D-15): setting the role replaces a role assignment, so it additionally needs
      // role-assignment:manage — today both that and employee:update are Admin-only, so the check
      // changes nothing for the legacy roles. Checked before the lookup: a caller without it gets
      // the same 403 for a foreign and an unknown id (T-100-09).
      const requestedRole = body.role;
      if (
        requestedRole !== undefined &&
        !(await hasPermission(req, "role-assignment:manage:ZUGEWIESEN"))
      ) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const employee = await app.prisma.employee.findUnique({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Phase 91b Plan 10 (Issue #91), D-12/D-14: same person-master-data scope rule as GET /:id.
      if (
        !(await enforcePersonScope(
          app,
          req,
          reply,
          id,
          "employee:update:ZUGEWIESEN",
          "Mitarbeiter nicht gefunden",
        ))
      ) {
        return;
      }

      // Issue #435 (D-11): mirrors the POST check above; unchanged values are never rejected
      // (same "legacy row stays editable" principle as D-10).
      // Code review WR-01: reuse daysDiffer() (the shared Decimal(5,2) "did it change" compare,
      // also used by PUT /settings/vacation) instead of a re-implemented raw !== comparison.
      if (
        body.annualVacationDays != null &&
        (employee.annualVacationDays === null ||
          daysDiffer(Number(employee.annualVacationDays), body.annualVacationDays))
      ) {
        const birthDateForCheck =
          body.birthDate !== undefined
            ? body.birthDate
              ? new Date(body.birthDate)
              : null
            : employee.birthDate;
        const checkYear = new Date().getUTCFullYear();
        const minimum = statutoryMinimumVacationDays(birthDateForCheck, checkYear, 5);
        if (Math.round(body.annualVacationDays * 100) < Math.round(minimum * 100)) {
          return reply.code(400).send({
            error: statutoryMinimumViolationMessage(minimum, birthDateForCheck, checkYear),
          });
        }
      }

      const updates: Record<string, unknown> = {};
      if (body.firstName !== undefined) updates.firstName = body.firstName;
      if (body.lastName !== undefined) updates.lastName = body.lastName;
      if (body.employeeNumber !== undefined) updates.employeeNumber = body.employeeNumber;
      if (body.hireDate !== undefined) updates.hireDate = new Date(body.hireDate);
      if (body.nfcCardId !== undefined) updates.nfcCardId = body.nfcCardId;
      if (body.exitDate !== undefined) {
        updates.exitDate = body.exitDate === null ? null : new Date(body.exitDate);
      }
      // Phase 65 — Geburtsdatum (JArbSchG §9 AZUBI <18 check)
      if (body.birthDate !== undefined) {
        updates.birthDate = body.birthDate === null ? null : new Date(body.birthDate);
      }
      // Issue #435 (D-15): the person value only affects rows NOT YET created (future years, the
      // #445 zero-placeholder heal) — an existing LeaveEntitlement row is deliberately NOT
      // recomputed here; a correction to an already-set year goes through PUT
      // /settings/vacation (audited there, D-10).
      if (body.annualVacationDays !== undefined) {
        updates.annualVacationDays = body.annualVacationDays;
      }
      // Personalstruktur (Phase 41)
      if (body.classification !== undefined) updates.classification = body.classification;
      if (body.coverageWeight !== undefined) updates.coverageWeight = body.coverageWeight;
      if (body.requiresSupervision !== undefined) {
        updates.requiresSupervision = body.requiresSupervision;
      }
      // Phase 64 (D-08, BREAK-02): per-employee break override on update.
      // body.breakOver*hOverride: undefined = no change, null = clear (fall back
      // to tenant default), number = set explicit override (Zod validated).
      if (body.breakOver6hOverride !== undefined) {
        updates.breakOver6hOverride = body.breakOver6hOverride;
      }
      if (body.breakOver9hOverride !== undefined) {
        updates.breakOver9hOverride = body.breakOver9hOverride;
      }
      // Phase 85.1.1 (D-01, D-04): per-employee Phorest puffer override on
      // update. body.phorest*MinutesOverride: undefined = no change, null =
      // clear (fall back to tenant default), number 0-30 = set explicit override.
      if (body.phorestPrepMinutesOverride !== undefined) {
        updates.phorestPrepMinutesOverride = body.phorestPrepMinutesOverride;
      }
      if (body.phorestWrapupMinutesOverride !== undefined) {
        updates.phorestWrapupMinutesOverride = body.phorestWrapupMinutesOverride;
      }
      // Phase 76.7 (D-11, EMP-V19-01) — § 18 ArbZG-Befreiung. undefined = no
      // change, true/false = explicit set. Audit row SET_TIME_TRACKING_EXEMPT
      // fires only when the value actually changes (see Phase 76.7 audit block
      // below, modeled on the Phase 64 break-override pattern).
      if (body.isTimeTrackingExempt !== undefined) {
        updates.isTimeTrackingExempt = body.isTimeTrackingExempt;
      }
      // Phase 76.31 (D-06): per-employee bsSlot* overrides on update.
      // undefined = no change, null = clear (delegate down a layer), number = set.
      if (body.bsSlotFirstLongDayMinutes !== undefined) {
        updates.bsSlotFirstLongDayMinutes = body.bsSlotFirstLongDayMinutes;
      }
      if (body.bsSlotSecondLongDayMinutes !== undefined) {
        updates.bsSlotSecondLongDayMinutes = body.bsSlotSecondLongDayMinutes;
      }
      if (body.bsSlotShortDayMinutes !== undefined) {
        updates.bsSlotShortDayMinutes = body.bsSlotShortDayMinutes;
      }
      if (body.bsSlotBlockWeekMinutes !== undefined) {
        updates.bsSlotBlockWeekMinutes = body.bsSlotBlockWeekMinutes;
      }

      // Phase 67b Plan 03 (D-07, issue #67, research Pitfall 2): only reads TenantConfig
      // (cached), safe before the tx — resolved only when hireDate actually moves.
      const tz =
        body.hireDate !== undefined ? await getTenantTimezone(app.prisma, req.user.tenantId) : null;

      // D-07: the employee update, the role change, the HOME gap-fill (when hireDate moves
      // earlier) and their audit rows commit or roll back together — a crash between them must
      // never leave a real day without a Stammsalon row, nor an audited gap-fill without its audited
      // hire-date move (review IN-05). The pro-rata warning below stays OUTSIDE this transaction: it
      // only reads and shapes a response field, and must not roll back a successful write.
      // Phase 75b (D-31): the role part runs under the lockout guard in this SAME transaction, so a
      // RoleLockoutError (mapped to 409 below) leaves nothing committed — not the field update either.
      let updated;
      try {
        updated = await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const updatedEmp = await tx.employee.update({ where: { id }, data: updates });

          // Issue #447 (D-07) — invariant-carrying (ADR 0002 Entscheidung 10): when exitDate was
          // sent and the stored value actually changed (null-safe time-value compare), the
          // exit-year rows of BOTH the old and the new exit year are recomputed to their § 5
          // BUrlG value inside this same transaction — the booking check (D-06) trusts the
          // persisted row, so the recompute commits or rolls back with the exit-date write. The
          // actor is the PATCH user (API-key safe, via requestAuditFields).
          if (body.exitDate !== undefined) {
            const oldExitDate = employee.exitDate;
            const newExitDate = updatedEmp.exitDate;
            if ((oldExitDate?.getTime() ?? null) !== (newExitDate?.getTime() ?? null)) {
              const exitYears = new Set<number>();
              if (oldExitDate) exitYears.add(oldExitDate.getUTCFullYear());
              if (newExitDate) exitYears.add(newExitDate.getUTCFullYear());
              for (const exitYear of exitYears) {
                await syncExitYearVacationEntitlement(
                  tx,
                  id,
                  req.user.tenantId,
                  exitYear,
                  (entry) =>
                    app.audit({
                      action: entry.action,
                      entity: "LeaveEntitlement",
                      entityId: entry.entityId,
                      oldValue: entry.oldValue,
                      tx,
                      ...requestAuditFields(req, entry.newValue as object | undefined),
                    }),
                );
              }
            }
          }

          // D-15/D-26/D-29: the role is no longer written into the column directly — it replaces
          // the system-role assignment, and the column follows the stored assignments.
          if (requestedRole !== undefined) {
            await withRoleLockoutGuard(tx, req.user.tenantId, () =>
              applyRoleFromEmployeeForm(app, req, tx, employee.userId, requestedRole),
            );
          }

          if (body.hireDate !== undefined && tz !== null) {
            const gapOutcome = await fillHomeGapBeforeHireDate(
              tx,
              req.user.tenantId,
              id,
              tenantLocalDay(new Date(body.hireDate), tz),
            );
            if (gapOutcome.status === "FILLED") {
              await auditSalonAssignmentEvent(app, req, {
                entity: "EmployeeSalonAssignment",
                action: "CREATE",
                entityId: gapOutcome.created.id,
                newValue: { ...toAssignmentDto(gapOutcome.created), trigger: "HIRE_DATE_CHANGED" },
                tx,
              });
            }
          }

          // Review IN-05: the Employee UPDATE audit commits or rolls back with the update it
          // describes (and with the gap-fill's CREATE audit above). Inside the transaction a failing
          // audit rolls the write back, so the actor is resolved through requestAuditFields — an API
          // key's `apikey:<id>` subject would otherwise fail the AuditLog.userId foreign key.
          await app.audit({
            action: "UPDATE",
            entity: "Employee",
            entityId: id,
            oldValue: {
              ...employee,
              exitDate: employee.exitDate?.toISOString() ?? null,
              // Personalstruktur (Phase 41) — Decimal → string for stable JSON
              coverageWeight: employee.coverageWeight.toString(),
              // Issue #435 (D-02/D-15) — Decimal → string for stable JSON (same treatment as coverageWeight)
              annualVacationDays: employee.annualVacationDays?.toString() ?? null,
            },
            ...requestAuditFields(req, {
              ...updatedEmp,
              role: body.role,
              exitDate: updatedEmp.exitDate?.toISOString() ?? null,
              // Personalstruktur (Phase 41) — Decimal → string for stable JSON
              coverageWeight: updatedEmp.coverageWeight.toString(),
              // Issue #435 (D-02/D-15) — Decimal → string for stable JSON (same treatment as coverageWeight)
              annualVacationDays: updatedEmp.annualVacationDays?.toString() ?? null,
            }),
            tx,
          });

          return updatedEmp;
        });
      } catch (err) {
        if (err instanceof RoleLockoutError) {
          return reply.code(409).send({ error: ROLE_LOCKOUT_MESSAGE });
        }
        if (err instanceof RoleDemotionBlockedError) {
          // Issue #357 sub-fix B: name the surviving assignments so the admin knows what to
          // remove first, instead of the API silently deleting a customer-role assignment (an
          // unrequested rights change of its own) or silently leaving it in place (the bug
          // reported in #357).
          const names = err.blocking
            .map((a) => `${a.roleName} (${SCOPE_LABEL[a.scopeType]})`)
            .join(", ");
          return reply.code(409).send({
            error: `${ROLE_DEMOTION_BLOCKED_MESSAGE_PREFIX}: ${names}. Bitte diese Zuweisungen zuerst entfernen oder beenden.`,
            remainingAssignments: err.blocking,
          });
        }
        throw err;
      }

      // ── Pro-rata Urlaubswarnung ──────────────────────────────────────────────
      // Compute warning when exitDate is set (or was just set) within the current year.
      let proRataWarning: { used: number; entitlement: number; message: string } | undefined =
        undefined;
      const effectiveExitDate =
        (updates.exitDate as Date | null | undefined) ?? employee.exitDate ?? null;
      if (effectiveExitDate !== null) {
        // Issue #447 WR-01: exitDate is a UTC-midnight @db.Date value — use the UTC accessor
        // to match the sync code (getUTCFullYear()) that just keyed the LeaveEntitlement row.
        const exitYear = effectiveExitDate.getUTCFullYear();
        try {
          // Issue #205, finding 2: resolves the VACATION leave type by its stable code (A11),
          // not by its tenant-editable display name — a renamed "Urlaub" type no longer silently
          // loses this warning.
          const vacation = await getVacationEntitlement(
            app.prisma,
            id,
            req.user.tenantId,
            exitYear,
          );
          const entitlement = vacation?.entitlement ?? null;
          if (entitlement) {
            // Issue #447 (D-08) — the one over-use warning string, neutral and legally correct
            // (no reclaim suggestion, § 5 Abs. 3 BUrlG); the row is already exit-synced above.
            proRataWarning =
              exitVacationOverUseWarning({
                employeeName: `${updated.firstName} ${updated.lastName}`,
                exitDate: effectiveExitDate,
                row: entitlement,
              }) ?? undefined;
          }
        } catch (err) {
          app.log.warn({ err }, "Pro-rata warning calculation failed silently");
        }
      }

      // Phase 64 (D-11): Dedicated audit row for break-override changes — emitted
      // ONLY when the PATCH body actually changed at least one of the two fields.
      // A no-op (body absent or identical value) does NOT emit.
      const changedOver6h =
        body.breakOver6hOverride !== undefined &&
        body.breakOver6hOverride !== employee.breakOver6hOverride;
      const changedOver9h =
        body.breakOver9hOverride !== undefined &&
        body.breakOver9hOverride !== employee.breakOver9hOverride;
      if (changedOver6h || changedOver9h) {
        await app.audit({
          userId: req.user.sub,
          action: "EMPLOYEE_BREAK_OVERRIDE_CHANGED",
          entity: "Employee",
          entityId: id,
          oldValue: {
            breakOver6hOverride: employee.breakOver6hOverride,
            breakOver9hOverride: employee.breakOver9hOverride,
          },
          newValue: {
            breakOver6hOverride: changedOver6h
              ? (body.breakOver6hOverride ?? null)
              : employee.breakOver6hOverride,
            breakOver9hOverride: changedOver9h
              ? (body.breakOver9hOverride ?? null)
              : employee.breakOver9hOverride,
          },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
      }

      // Phase 85.1.1 (D-04): Dedicated audit row for Phorest puffer override
      // changes — emitted ONLY when the PATCH body actually changed at least
      // one of the two fields. A no-op (body absent or identical value) does
      // NOT emit. Mirrors the Phase 64 break-override audit pattern above.
      const changedPrepOverride =
        body.phorestPrepMinutesOverride !== undefined &&
        body.phorestPrepMinutesOverride !== employee.phorestPrepMinutesOverride;
      const changedWrapupOverride =
        body.phorestWrapupMinutesOverride !== undefined &&
        body.phorestWrapupMinutesOverride !== employee.phorestWrapupMinutesOverride;
      if (changedPrepOverride || changedWrapupOverride) {
        await app.audit({
          userId: req.user.sub,
          action: "EMPLOYEE_PHOREST_PUFFER_OVERRIDE_CHANGED",
          entity: "Employee",
          entityId: id,
          oldValue: {
            phorestPrepMinutesOverride: employee.phorestPrepMinutesOverride,
            phorestWrapupMinutesOverride: employee.phorestWrapupMinutesOverride,
          },
          newValue: {
            phorestPrepMinutesOverride: changedPrepOverride
              ? (body.phorestPrepMinutesOverride ?? null)
              : employee.phorestPrepMinutesOverride,
            phorestWrapupMinutesOverride: changedWrapupOverride
              ? (body.phorestWrapupMinutesOverride ?? null)
              : employee.phorestWrapupMinutesOverride,
          },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
      }

      // Phase 76.7 (D-13, AUDIT-V19-02) — Dedicated AuditLog row for the
      // § 18 ArbZG exemption toggle. Only emit when the body actually changed
      // the value (no-op suppression mirrors Phase 64 break-override pattern).
      // The generic UPDATE audit row above still fires for any PATCH so the
      // overall update trail is preserved.
      const changedExempt =
        body.isTimeTrackingExempt !== undefined &&
        body.isTimeTrackingExempt !== employee.isTimeTrackingExempt;
      if (changedExempt) {
        await app.audit({
          userId: req.user.sub,
          action: "SET_TIME_TRACKING_EXEMPT",
          entity: "Employee",
          entityId: id,
          oldValue: { isTimeTrackingExempt: employee.isTimeTrackingExempt },
          newValue: { isTimeTrackingExempt: body.isTimeTrackingExempt! },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        app.log.info(
          {
            employeeId: id,
            exempt: body.isTimeTrackingExempt,
            actorId: req.user.sub,
          },
          "Employee time-tracking exemption toggled",
        );
      }

      return reply.send({ ...updated, ...(proRataWarning ? { proRataWarning } : {}) });
    },
  });

  // PATCH /api/v1/employees/:id/unlock — Admin entsperrt gesperrten Account
  app.patch("/:id/unlock", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("employee:manage-access:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const employee = await app.prisma.employee.findUnique({
        where: { id },
        include: { user: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      if (employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "Employee",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }
      // Phase 91b Plan 10 (Issue #91), D-10/D-14: account-lifecycle action, Stammsalon-only.
      if (
        !(await enforcePersonAdminScope(
          app,
          req,
          reply,
          id,
          "employee:manage-access:ZUGEWIESEN",
          "Mitarbeiter nicht gefunden",
        ))
      ) {
        return;
      }

      await app.prisma.user.update({
        where: { id: employee.userId },
        data: { failedLoginAttempts: 0, lockedUntil: null, lastFailedLoginAt: null },
      });

      await app.audit({
        userId: req.user.sub,
        action: "ACCOUNT_UNLOCKED",
        entity: "User",
        entityId: employee.userId,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return { success: true };
    },
  });

  // PATCH /api/v1/employees/:id/deactivate
  app.patch("/:id/deactivate", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("employee:manage-access:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const { exitDate } = z.object({ exitDate: z.string().optional() }).parse(req.body ?? {});

      const employee = await app.prisma.employee.findUnique({
        where: { id },
        include: { user: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      if (employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "Employee",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }
      // Phase 91b Plan 10 (Issue #91), D-10/D-14: account-lifecycle action, Stammsalon-only —
      // runs BEFORE the isActive branch below, so an out-of-scope employee's current state never
      // leaks through a distinguishable 409 (T-100-09).
      if (
        !(await enforcePersonAdminScope(
          app,
          req,
          reply,
          id,
          "employee:manage-access:ZUGEWIESEN",
          "Mitarbeiter nicht gefunden",
        ))
      ) {
        return;
      }
      if (!employee.user.isActive)
        return reply.code(409).send({ error: "Mitarbeiter ist bereits deaktiviert" });

      const effectiveExitDate = exitDate ? new Date(exitDate) : new Date();

      // Phase 74b (D-19/D-20): deactivating the tenant's last active tenant-wide holder of
      // role:manage / role-assignment:manage would lock every admin out of role management. The
      // four writes AND the audit run in one interactive transaction under the lockout guard, so a
      // RoleLockoutError rolls all of them back. The user's role assignments stay (D-22): an
      // inactive user holds no effective right, and reactivation restores it.
      try {
        await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await withRoleLockoutGuard(tx, req.user.tenantId, async () => {
            await tx.user.update({
              where: { id: employee.userId },
              data: { isActive: false },
            });
            await tx.employee.update({
              where: { id },
              data: { exitDate: effectiveExitDate },
            });
            // Issue #447 (D-07) — same invariant-carrying recompute as PATCH /:id: both the
            // old and the new exit year's VACATION row are brought to their § 5 BUrlG value
            // inside this guarded transaction.
            {
              const exitYears = new Set<number>([effectiveExitDate.getUTCFullYear()]);
              if (employee.exitDate) exitYears.add(employee.exitDate.getUTCFullYear());
              for (const exitYear of exitYears) {
                await syncExitYearVacationEntitlement(
                  tx,
                  id,
                  req.user.tenantId,
                  exitYear,
                  (entry) =>
                    app.audit({
                      action: entry.action,
                      entity: "LeaveEntitlement",
                      entityId: entry.entityId,
                      oldValue: entry.oldValue,
                      tx,
                      ...requestAuditFields(req, entry.newValue as object | undefined),
                    }),
                );
              }
            }
            await tx.refreshToken.updateMany({
              where: { userId: employee.userId, revokedAt: null },
              data: { revokedAt: new Date() },
            });
            await tx.otpToken.updateMany({
              where: { userId: employee.userId, usedAt: null },
              data: { usedAt: new Date() },
            });
            // 74b review WR-06: inside the guarded transaction a failing audit rolls the
            // deactivation back, so the actor must never be an API key's `apikey:<id>` subject
            // (AuditLog.userId FK); requestAuditFields also adds the request IP/user agent.
            await app.audit({
              action: "UPDATE",
              entity: "Employee",
              entityId: id,
              ...requestAuditFields(req, { isActive: false, exitDate: effectiveExitDate }),
              tx,
            });
          });
        });
      } catch (err) {
        if (err instanceof RoleLockoutError) {
          return reply.code(409).send({ error: ROLE_LOCKOUT_MESSAGE });
        }
        throw err;
      }

      return { success: true };
    },
  });

  // PATCH /api/v1/employees/:id/reactivate
  app.patch("/:id/reactivate", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("employee:manage-access:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);

      const employee = await app.prisma.employee.findUnique({
        where: { id },
        include: { user: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      if (employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "Employee",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }
      // Phase 91b Plan 10 (Issue #91), D-10/D-14: same rule as deactivate above.
      if (
        !(await enforcePersonAdminScope(
          app,
          req,
          reply,
          id,
          "employee:manage-access:ZUGEWIESEN",
          "Mitarbeiter nicht gefunden",
        ))
      ) {
        return;
      }
      if (employee.user.isActive)
        return reply.code(409).send({ error: "Mitarbeiter ist bereits aktiv" });

      // Issue #447 (D-07) — converted from the array-form $transaction to an interactive one:
      // clearing exitDate syncs the old exit year's VACATION row back to its regular (non-exit)
      // value inside the same transaction as the two writes below.
      await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.user.update({
          where: { id: employee.userId },
          data: { isActive: true },
        });
        await tx.employee.update({
          where: { id },
          data: { exitDate: null },
        });
        if (employee.exitDate) {
          const exitYear = employee.exitDate.getUTCFullYear();
          await syncExitYearVacationEntitlement(tx, id, req.user.tenantId, exitYear, (entry) =>
            app.audit({
              action: entry.action,
              entity: "LeaveEntitlement",
              entityId: entry.entityId,
              oldValue: entry.oldValue,
              tx,
              ...requestAuditFields(req, entry.newValue as object | undefined),
            }),
          );
        }
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "Employee",
        entityId: id,
        newValue: { isActive: true, exitDate: null },
      });

      const updated = await app.prisma.employee.findUnique({
        where: { id },
        include: {
          user: { select: { email: true, role: true, isActive: true } },
          workSchedules: { orderBy: { validFrom: "desc" }, take: 1 },
          overtimeAccount: { select: { balanceHours: true } },
        },
      });

      return {
        ...updated,
        // Issue #547 (Phase 85b Plan 15): same saldo mask as the list and the single view.
        overtimeAccount: maskOvertimeAccount(
          await resolveBalanceVisibility(app, req),
          id,
          updated?.overtimeAccount ?? null,
        ),
        workSchedule: updated?.workSchedules[0] ?? null,
        workSchedules: undefined,
      };
    },
  });

  // POST /api/v1/employees/:id/resend-invitation
  app.post("/:id/resend-invitation", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("employee:manage-access:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);

      const employee = await app.prisma.employee.findUnique({
        where: { id },
        include: { user: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      if (employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "Employee",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }
      // Phase 91b Plan 10 (Issue #91), D-10/D-14: same rule as unlock/deactivate/reactivate above.
      if (
        !(await enforcePersonAdminScope(
          app,
          req,
          reply,
          id,
          "employee:manage-access:ZUGEWIESEN",
          "Mitarbeiter nicht gefunden",
        ))
      ) {
        return;
      }
      if (employee.user.isActive) {
        return reply.code(409).send({ error: "Mitarbeiter hat Einladung bereits akzeptiert" });
      }

      // Expire the open invitations and issue a new one (the invitation rule lives in
      // employee-creation.ts).
      const { token: rawToken } = await reissueEmployeeInvitation(app.prisma, {
        employeeId: id,
        email: employee.user.email,
      });

      try {
        await app.mailer.sendInvitation({
          to: employee.user.email,
          firstName: employee.firstName,
          token: rawToken,
          tenantId: req.user.tenantId,
        });
      } catch (err) {
        app.log.error({ err }, "Einladungsmail konnte nicht gesendet werden");
        return reply.code(502).send({ error: "E-Mail konnte nicht gesendet werden" });
      }

      return { success: true, message: "Einladung erneut gesendet" };
    },
  });

  // DELETE /api/v1/employees/:id — DSGVO-konforme Anonymisierung
  // Personenbezogene Daten werden anonymisiert, sachbezogene Daten (Zeiteinträge,
  // Urlaubsanträge, Salden) bleiben für die gesetzlichen Aufbewahrungsfristen erhalten.
  app.delete("/:id", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("employee:anonymize:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);

      const employee = await app.prisma.employee.findUnique({
        where: { id },
        include: { user: true, overtimeAccount: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      if (employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "Employee",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }
      // Phase 91b Plan 10 (Issue #91), D-10/D-14: DSGVO anonymization is an account-lifecycle
      // action, same Stammsalon-only rule as unlock/deactivate/reactivate above.
      if (
        !(await enforcePersonAdminScope(
          app,
          req,
          reply,
          id,
          "employee:anonymize:ZUGEWIESEN",
          "Mitarbeiter nicht gefunden",
        ))
      ) {
        return;
      }

      // Pre-fetch MinIO object paths BEFORE the tx (anonymizeEmployeeData nulls documentPath
      // inside the tx; after commit those paths are gone from Postgres).
      // MinIO deletes MUST happen AFTER the tx commits — MinIO is not transactional with
      // Postgres. A rolled-back tx must not have deleted the actual files.
      // Phase 100B Plan 12 — F3, contexts/absence facade.
      const absenceDocs = await getAbsenceDocumentPaths(app.prisma, id);
      // Phase 104-07 (D-26): same pre-fetch-before-tx reasoning as absenceDocs above — a
      // paper-AU document is an Art. 9 DSGVO health datum and must be erased on Art. 17
      // deletion just as reliably as an avatar or absence document.
      const section9Docs = await getSection9DocumentPaths(app.prisma, id);

      // Phase 74b (D-19/D-20/D-22): the anonymization, the per-assignment DELETE audits and the
      // ANONYMIZE audit run under the lockout guard. Anonymizing the tenant's last active
      // tenant-wide holder of role:manage / role-assignment:manage rolls all of it back and
      // answers 409 — and that return comes BEFORE the MinIO block below, so a rolled-back
      // anonymization never loses a document.
      try {
        await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await withRoleLockoutGuard(tx, req.user.tenantId, async () => {
            const { removedRoleAssignments } = await anonymizeEmployeeData({
              tx,
              employeeId: id,
            });
            await auditRemovedRoleAssignments(
              app,
              req,
              tx,
              removedRoleAssignments,
              "Anonymisierung",
            );
            await app.audit({
              action: "ANONYMIZE",
              entity: "Employee",
              entityId: id,
              oldValue: { employeeNumber: employee.employeeNumber },
              ...requestAuditFields(req),
              tx,
            });
          });
        });
      } catch (err) {
        if (err instanceof RoleLockoutError) {
          return reply.code(409).send({ error: ROLE_LOCKOUT_MESSAGE });
        }
        throw err;
      }

      // Delete MinIO objects after the Postgres tx has committed successfully.
      // Failures are non-fatal — legal anonymization is already committed.
      if (employee.avatarPath) {
        await app.storage
          .delete(employee.avatarPath)
          .catch((err: unknown) =>
            app.log.warn({ err }, "Anonymize: avatar delete failed (non-fatal)"),
          );
      }
      for (const d of absenceDocs) {
        if (d.documentPath) {
          await app.storage
            .delete(d.documentPath)
            .catch((err: unknown) =>
              app.log.warn({ err }, "Anonymize: absence document delete failed (non-fatal)"),
            );
        }
      }
      for (const d of section9Docs) {
        if (d.documentPath) {
          await app.storage
            .delete(d.documentPath)
            .catch((err: unknown) =>
              app.log.warn({ err }, "Anonymize: § 9 AU document delete failed (non-fatal)"),
            );
        }
      }

      return reply.code(204).send();
    },
  });

  // DELETE /api/v1/employees/:id/hard-delete — Endgültige Löschung nach Ablauf der Aufbewahrungsfrist
  // Darf nur auf bereits anonymisierte Mitarbeiter angewendet werden (firstName === "Gelöscht").
  // Gesetzliche Aufbewahrungsfrist: §147 AO / §257 HGB — 10 Jahre nach Austritt/Anlage.
  // §16 Abs. 2 ArbZG: unconditional 2-year minimum floor — forceDelete cannot bypass.
  // forceDelete inside retention window: requires 4-eyes (second ADMIN via POST /:id/hard-delete/authorize).
  const forceDeleteBodySchema = z.object({ forceDelete: z.boolean().optional() }).optional();

  // POST /api/v1/employees/:id/hard-delete/authorize — Second-admin authorization for in-window force-delete (4-eyes)
  // Writes a HARD_DELETE_AUTHORIZED AuditLog row with a 15-minute TTL; the DELETE /:id/hard-delete handler
  // checks for a valid row by a DIFFERENT admin before proceeding when forceDelete=true inside the window.
  app.post("/:id/hard-delete/authorize", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("employee:anonymize:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);

      const employee = await app.prisma.employee.findUnique({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      // Phase 91b Plan 10 (Issue #91), D-10/D-14: same rule as the other account-lifecycle
      // actions above — runs before the "already anonymized" state check so an out-of-scope
      // employee's state never leaks (T-100-09).
      if (
        !(await enforcePersonAdminScope(
          app,
          req,
          reply,
          id,
          "employee:anonymize:ZUGEWIESEN",
          "Mitarbeiter nicht gefunden",
        ))
      ) {
        return;
      }

      // Must already be anonymized to be eligible for force-delete authorization
      if (employee.firstName !== "Gelöscht") {
        return reply.code(409).send({ error: "Mitarbeiter muss zuerst anonymisiert werden" });
      }

      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      await app.audit({
        userId: req.user.sub,
        action: "HARD_DELETE_AUTHORIZED",
        entity: "Employee",
        entityId: id,
        newValue: { authorizedBy: req.user.sub, expiresAt },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(200).send({ authorized: true, expiresAt });
    },
  });

  app.delete("/:id/hard-delete", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("employee:anonymize:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const { forceDelete } = forceDeleteBodySchema.parse(req.body ?? {}) ?? {};

      const employee = await app.prisma.employee.findUnique({
        where: { id, tenantId: req.user.tenantId },
        include: { user: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      // Phase 91b Plan 10 (Issue #91), D-10/D-14: same rule as hard-delete/authorize above.
      if (
        !(await enforcePersonAdminScope(
          app,
          req,
          reply,
          id,
          "employee:anonymize:ZUGEWIESEN",
          "Mitarbeiter nicht gefunden",
        ))
      ) {
        return;
      }

      // Guard: must be already anonymized — forceDelete does NOT bypass this rule
      if (employee.firstName !== "Gelöscht") {
        return reply.code(409).send({ error: "Mitarbeiter muss zuerst anonymisiert werden" });
      }

      // Retention check — read years from tenant config (§147 AO default 10 years)
      const tenantConfig = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: req.user.tenantId },
        select: { dataRetentionYears: true },
      });
      const retentionYears = tenantConfig?.dataRetentionYears ?? DEFAULT_RETENTION_YEARS;
      const retentionStart: Date = employee.exitDate ?? employee.createdAt;
      const retentionExpires = new Date(
        retentionStart.getFullYear() + retentionYears,
        11,
        31,
        23,
        59,
        59,
      );

      // §16 Abs. 2 ArbZG: unconditional 2-year minimum floor — forceDelete cannot bypass this
      const twoYearFloor = new Date(retentionStart.getFullYear() + 2, 11, 31, 23, 59, 59);
      if (new Date() < twoYearFloor) {
        return reply.code(409).send({
          error: "Mindestaufbewahrungsfrist (§ 16 Abs. 2 ArbZG: 2 Jahre) noch nicht abgelaufen",
          floorExpiresAt: twoYearFloor.toISOString(),
        });
      }

      if (new Date() < retentionExpires && !forceDelete) {
        return reply.code(409).send({
          error: "Aufbewahrungsfrist noch nicht abgelaufen",
          retentionExpiresAt: retentionExpires.toISOString(),
        });
      }

      // 4-eyes gate: forceDelete inside retention window requires a second admin's authorization
      // (COMP-V1814-07 T-76.21-20 — T-76.21-22). The authorization must be authored by a DIFFERENT
      // admin (userId != caller) within the last 15 minutes.
      if (forceDelete && new Date() < retentionExpires) {
        const authRow = await app.prisma.auditLog.findFirst({
          where: {
            action: "HARD_DELETE_AUTHORIZED",
            entity: "Employee",
            entityId: id,
            userId: { not: req.user.sub }, // different admin required
            createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) },
          },
          orderBy: { createdAt: "desc" },
        });
        if (!authRow) {
          return reply.code(409).send({
            error:
              "Force-Delete erfordert Freigabe durch einen zweiten Administrator (4-Augen-Prinzip)",
          });
        }
      }

      const userId = employee.userId;

      // WR-01: audit is written as the FIRST step INSIDE the $transaction so that
      // a failed deletion rolls back both the audit row and the deletes atomically.
      // A phantom HARD_DELETE audit entry on a failed deletion is not acceptable in
      // an immutable audit trail (Revisionssicherheit).
      // AuditLog.userId uses onDelete:SetNull → the row survives the User deletion.
      // Hard delete in correct order — Restrict-protected relations first
      // Phase 74b (D-20): the whole transaction body runs under the lockout guard, order
      // unchanged. On the real path the tenant's last holder never gets here — the
      // anonymization precondition above refuses first, and anonymized users are inactive and
      // normally hold no assignments (any left over are removed with an audit below). The guard
      // is wired anyway so the rule holds by construction.
      try {
        await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await withRoleLockoutGuard(tx, req.user.tenantId, async () => {
            // Audit first — entity still queryable; tx rollback removes phantom audit row
            // Include forceDelete flag and retentionExpiresAt so auditors can identify overrides.
            await app.audit({
              userId: req.user.sub,
              action: "HARD_DELETE",
              entity: "Employee",
              entityId: id,
              oldValue: {
                employeeNumber: employee.employeeNumber,
                userEmail: employee.user.email,
                retentionStart: retentionStart.toISOString(),
              },
              newValue: {
                forceDelete: forceDelete === true,
                retentionExpiresAt: retentionExpires.toISOString(),
              },
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
              tx,
            });
            // ⚠️ PRE-EXISTING GAP, recorded in Phase 99 (OB-05) — deliberately NOT fixed here.
            // This handler does not deleteMany() SaldoSnapshot, whose Employee relation is
            // onDelete: Restrict — so tx.employee.delete() below will fail with an FK-restrict
            // violation for any employee that ever had a closed month. Phase 99 adds OpeningBalance
            // with the same Restrict relation, which inherits (does not cause) the same failure mode.
            // Fixing the cascade is orthogonal to opening balances and needs its own retention/
            // Revisionssicherheit decision (what may legally be hard-deleted after §147 AO expiry).
            // Break records (nested under TimeEntry) — delete first
            // Phase 100B Plan 08 — T11, contexts/time-tracking facade (Break before TimeEntry,
            // the onDelete:Restrict ordering invariant, unchanged).
            await hardDeleteTimeDataForEmployee(tx, id);
            // Restrict-protected models
            // Phase 100B Plan 13 — F3, contexts/absence facade (IN PLACE, ordering unchanged).
            await hardDeleteLeaveRequestsForEmployee(tx, id);
            // Phase 100B Plan 12 — F3, contexts/absence facade (IN PLACE, H5 ordering unchanged).
            await hardDeleteAbsencesForEmployee(tx, id);
            // Cascade-owned models (safe to delete explicitly)
            // Phase 100B Plan 10 — F3, contexts/absence facade.
            await hardDeleteEntitlementsForEmployee(tx, id);
            await tx.workSchedule.deleteMany({ where: { employeeId: id } });
            await hardDeleteOvertimeDataForEmployee(tx, id);
            // 74b review WR-04 (D-12/D-22): remove the user's remaining role assignments
            // explicitly, one DELETE audit each, before the user row goes. The
            // RoleAssignment.userId `onDelete: Cascade` stays only as a backstop: a cascade
            // writes no audit row, and an anonymized user can still hold an assignment that was
            // written directly (script, fixture) rather than through a route.
            const removedRoleAssignments = await removeRoleAssignmentsOfUser(
              tx,
              req.user.tenantId,
              userId,
            );
            await auditRemovedRoleAssignments(
              app,
              req,
              tx,
              removedRoleAssignments,
              "Endgültige Löschung",
            );
            // Phase 67b Plan 03 (D-24, issue #67): named compliance deletion after retention
            // expiry, same class as workSchedule.deleteMany above — EmployeeSalonAssignment.employee
            // is onDelete: Restrict, so this must run before tx.employee.delete below. The only
            // non-anonymising removal of a Stammsalon/Einsatzsalon history in the product.
            await tx.employeeSalonAssignment.deleteMany({
              where: { employeeId: id, tenantId: req.user.tenantId },
            });
            // Finally: employee and user records
            await tx.employee.delete({ where: { id } });
            await tx.user.delete({ where: { id: userId } });
          });
        });
      } catch (err) {
        if (err instanceof RoleLockoutError) {
          return reply.code(409).send({ error: ROLE_LOCKOUT_MESSAGE });
        }
        throw err;
      }

      return reply.code(204).send();
    },
  });
}
