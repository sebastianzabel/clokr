import { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto, { createHash } from "crypto";
import { Prisma, type Role, type RoleAssignmentScopeType } from "@clokr/db";
import { requireAuth } from "../../../middleware/auth";
import { hasPermission, permissionReach, requirePermission } from "../request-permissions";
import { validatePassword, loadPasswordPolicy } from "../password-policy";
import { accessContextFromRequest } from "../access-context"; // Phase 91b Plan 10 (#91), D-12/D-14
import { resolveAccessReach } from "../facade/role-assignments"; // Phase 91b Plan 10 (#91), D-12/D-14
import { isPersonMasterDataInScope, isStammsalonScopeMatch } from "../scope-filter"; // Phase 91b Plan 10 (#91), D-10/D-12/D-14
// eslint-disable-next-line no-restricted-imports -- E-4: creating an employee computes the pro-rata leave entitlement as a side effect. Disappears in Block 2 via employee-created/employee-changed events. ADR 0001 Eintrag H.
import { calculateProRataVacation } from "../../absence/vacation-calc";
import { normalizeWorkDays, type PerDayHours } from "../calculate-work-days";
import { anonymizeEmployeeData, NOT_ANONYMIZED_EMPLOYEE_WHERE } from "../anonymize";
import {
  lockTenantForRoleChanges,
  removeRoleAssignmentsOfUser,
  withRoleLockoutGuard,
  type RemovedRoleAssignment,
} from "../facade/role-assignments";
import { requestAuditFields } from "../request-audit-fields";
import { RoleLockoutError, ROLE_LOCKOUT_MESSAGE } from "../role-assignment";
import {
  assignmentsBlockingDemotionToEmployee,
  isDemotionToEmployee,
  legacyFallbackAlreadyYields,
  materializeLegacyRoleAssignment,
  replaceSystemRoleAssignment,
  requestedRoleNeedsRoleAssignmentManage,
  ROLE_DEMOTION_BLOCKED_MESSAGE_PREFIX,
  RoleDemotionBlockedError,
  syncCompatRoleColumn,
} from "../compat-role";
import {
  auditRoleAssignmentChange,
  createdAssignmentAuditEntry,
  materializedAssignmentAuditEntry,
  removedAssignmentAuditEntry,
} from "../role-assignment-audit";
import {
  createOvertimeAccount,
  hardDeleteOvertimeDataForEmployee,
  getTenantTimezone,
} from "../../working-time-account"; // Phase 100B Plan 06 — W13/W15; Phase 67b Plan 03 — D-22/D-07
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
  BS_DAILY_MIN_BOUND,
  BS_DAILY_MAX_BOUND,
  BS_BLOCK_WEEKLY_MIN_BOUND,
  BS_BLOCK_WEEKLY_MAX_BOUND,
} from "../../absence"; // Phase 100B Plan 10 — A11 (Issue #205 reroute) / F3; Plan 11 — F3; Plan 12 — F3; Plan 13 — F3; issue #246, E-6
// Phase 67b Plan 03 (issue #67, D-22/D-07/D-24) — the Stammsalon lifecycle helpers.
import {
  createInitialHomeAssignment,
  fillHomeGapBeforeHireDate,
  resolveHomeSalonForNewEmployee,
} from "../facade/salon-assignments";
import { salonExistsInForeignTenant } from "../facade/salons";
import { auditSalonAssignmentEvent } from "../salon-assignment-audit";
import { tenantLocalDay, toAssignmentDto } from "../salon-assignment-rules";

// ── Retention constant ─────────────────────────────────────────────────────
const DEFAULT_RETENTION_YEARS = 10;

// Issue #357 sub-fix B: the German scope label for the demotion-blocked 409 message.
const SCOPE_LABEL: Record<RoleAssignmentScopeType, string> = {
  TENANT: "mandantenweit",
  SALONS: "salonbezogen",
  PERSONS: "personenbezogen",
};

// Phase 76.31 D-06 — per-employee bsSlot* override Zod fields (highest layer of
// the 4-layer slot hierarchy). Nullable Int — explicit null CLEARS the employee
// override so resolution delegates down to Pattern → TenantConfig → daily-Soll.
// Daily bounds 240..600 (4h..10h); block-week bounds 1200..3000 (20h..50h).
const bsSlotEmployeeFields = {
  bsSlotFirstLongDayMinutes: z
    .number()
    .int()
    .min(BS_DAILY_MIN_BOUND)
    .max(BS_DAILY_MAX_BOUND)
    .nullable()
    .optional(),
  bsSlotSecondLongDayMinutes: z
    .number()
    .int()
    .min(BS_DAILY_MIN_BOUND)
    .max(BS_DAILY_MAX_BOUND)
    .nullable()
    .optional(),
  bsSlotShortDayMinutes: z
    .number()
    .int()
    .min(BS_DAILY_MIN_BOUND)
    .max(BS_DAILY_MAX_BOUND)
    .nullable()
    .optional(),
  bsSlotBlockWeekMinutes: z
    .number()
    .int()
    .min(BS_BLOCK_WEEKLY_MIN_BOUND)
    .max(BS_BLOCK_WEEKLY_MAX_BOUND)
    .nullable()
    .optional(),
};

/** SHA-256 hash for tokens stored in DB. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Personalstruktur (Phase 41) — keep enum in sync with prisma EmployeeClassification
const employeeClassificationSchema = z.enum([
  "VOLLZEIT",
  "TEILZEIT",
  "MINIJOB",
  "AZUBI",
  "AUSHILFE",
  "WERKSTUDENT",
  "PRAKTIKANT",
]);

const createEmployeeSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  employeeNumber: z.string().min(1),
  hireDate: z.string().datetime(),
  role: z.enum(["ADMIN", "MANAGER", "EMPLOYEE"]).default("EMPLOYEE"),
  weeklyHours: z.number().min(0).max(60).nullable().optional().default(0),
  scheduleType: z
    .enum(["FIXED_SCHEDULE", "FLEXTIME", "MONTHLY_HOURS", "SHIFT_BASED"])
    .default("SHIFT_BASED"),
  monthlyHours: z.number().min(0).max(999).nullable().optional(),
  nfcCardId: z.string().optional(),
  password: z.string().min(8).optional(),
  // Personalstruktur (Phase 41)
  classification: employeeClassificationSchema.optional(),
  coverageWeight: z.number().min(0).max(9.99).optional(),
  requiresSupervision: z.boolean().optional(),
  // Phase 49.2 — FLEXTIME Kernarbeitszeit (optional; only applied when scheduleType=FLEXTIME)
  coreStart: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Format HH:MM erwartet")
    .nullable()
    .optional(),
  coreEnd: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Format HH:MM erwartet")
    .nullable()
    .optional(),
  coreDays: z.array(z.number().int().min(0).max(6)).optional(),
  // Phase 49.5 — Arbeitstage/Woche (optional; fällt auf TenantConfig.defaultWorkDays zurück)
  workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  // Phase 107 (D-01, issue #94) — vertragliche Anzahl Arbeitstage/Woche, NUR für
  // SHIFT_BASED befüllt. .optional().nullable(): see settings.ts's identical field
  // for the rationale (Svelte forms send `field: x ? x : null`).
  contractWorkDaysPerWeek: z.number().int().min(1).max(7).optional().nullable(),
  // Phase 64 — Pausendauer Override (D-08, BREAK-02, BREAK-04):
  // nullable Int — null clears override → fall back to TenantConfig defaults.
  // Floor enforces ArbZG §4 Pflichtpause; cap is a sane upper bound.
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
  // Override (create). Plain 0-30 bound (no ArbZG floor). null = fall back to
  // TenantConfig.phorestPrepMinutes/phorestWrapupMinutes; 0 = explicit "no puffer".
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
  // Phase 76.31 D-06 — per-employee bsSlot* overrides (create).
  ...bsSlotEmployeeFields,
  // Phase 67b Plan 03 (D-22, issue #67) — the new employee's Stammsalon. Omitted or explicit
  // null resolves automatically when the tenant has exactly one active salon; explicit null is
  // accepted because Clokr frontends send `field: x ? x : null`, never omit the key.
  homeSalonId: z.string().uuid().optional().nullable(),
});

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
 * Order: a request that changes nothing (the fallback already yields `role`) writes nothing. Else,
 * for a demotion TO Mitarbeiter, {@link assignmentsBlockingDemotionToEmployee} runs first (Issue
 * #357 sub-fix B) — a still-granting customer-role or salon/person-scoped assignment throws
 * {@link RoleDemotionBlockedError} before any write, so the whole request (this role change AND
 * every other field on the same PATCH) rolls back atomically rather than silently applying a
 * partial demotion. Otherwise the fallback is materialized first (D-26), the system-role
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
  if (await legacyFallbackAlreadyYields(tx, tenantId, userId, role)) return;
  if (isDemotionToEmployee(role)) {
    const blocking = await assignmentsBlockingDemotionToEmployee(tx, tenantId, userId);
    if (blocking.length > 0) throw new RoleDemotionBlockedError(blocking);
  }
  const materialized = await materializeLegacyRoleAssignment(tx, tenantId, userId);
  const { removed, created } = await replaceSystemRoleAssignment(tx, tenantId, userId, role);
  const compatRole = await syncCompatRoleColumn(tx, tenantId, userId);
  await auditRoleAssignmentChange(app, req, tx, {
    userId,
    entries: [
      ...(materialized !== null ? [materializedAssignmentAuditEntry(materialized)] : []),
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

export async function employeeRoutes(app: FastifyInstance) {
  // GET /api/v1/employees
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
      const employees = await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          ...(showAnonymized ? {} : NOT_ANONYMIZED_EMPLOYEE_WHERE),
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

      return employees.map((e) => ({
        ...e,
        workSchedule: e.workSchedules[0] ?? null,
        workSchedules: undefined,
        invitationStatus: deriveInvitationStatus(e.user.isActive, e.invitations),
        invitations: undefined,
      }));
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

      const directPassword = !!body.password;
      if (directPassword) {
        const policy = await loadPasswordPolicy(app, req.user.tenantId);
        const check = validatePassword(body.password!, policy);
        if (!check.valid) {
          return reply.code(400).send({ error: check.errors.join(". ") });
        }
      }
      const passwordHash = directPassword
        ? await bcrypt.hash(body.password!, 12)
        : await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);

      // Phase 49.5 — Arbeitstage: Body-Override > Tenant-Default > Mo-Fr.
      // Phase 61 (v1.6.5) — also derive from per-day-hours when the body doesn't
      // carry them. createEmployeeSchema does not accept per-day-hours today, so
      // we synthesize the Prisma schema defaults (Mo-Fr=8, Sat/Sun=0). When a
      // future schema extension adds these fields, the helper picks them up
      // automatically. The tenant default still wins for callers who want a
      // non-Mo-Fr default at hire-time.
      const tenantConfigForDefaults = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: req.user.tenantId },
        select: { defaultWorkDays: true },
      });
      const perDayHoursForDerive: PerDayHours = {
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
      };
      const resolvedWorkDays = normalizeWorkDays(
        body.workDays,
        perDayHoursForDerive,
        tenantConfigForDefaults?.defaultWorkDays,
      );

      // Phase 67b Plan 03 (D-22, issue #67): only reads TenantConfig (cached), safe before the tx.
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);

      const result = await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // D-22/D-02: the FIRST statement in the transaction — a rejected outcome below returns
        // before any write, so a 400 never leaves behind a User, Employee or assignment row.
        const salonOutcome = await resolveHomeSalonForNewEmployee(
          tx,
          req.user.tenantId,
          body.homeSalonId,
        );
        if (salonOutcome.status !== "OK") return salonOutcome;

        const user = await tx.user.create({
          data: {
            email: body.email,
            passwordHash,
            role: body.role,
            isActive: directPassword, // sofort aktiv wenn Passwort gesetzt
          },
        });

        const emp = await tx.employee.create({
          data: {
            tenantId: req.user.tenantId,
            userId: user.id,
            firstName: body.firstName,
            lastName: body.lastName,
            employeeNumber: body.employeeNumber,
            hireDate: new Date(body.hireDate),
            nfcCardId: body.nfcCardId,
            // Personalstruktur (Phase 41) — schema defaults apply if omitted
            ...(body.classification !== undefined ? { classification: body.classification } : {}),
            ...(body.coverageWeight !== undefined ? { coverageWeight: body.coverageWeight } : {}),
            ...(body.requiresSupervision !== undefined
              ? { requiresSupervision: body.requiresSupervision }
              : {}),
            // Phase 64 (D-08, BREAK-02): per-employee break override on create.
            // undefined / omitted → null (fall back to tenant default).
            breakOver6hOverride: body.breakOver6hOverride ?? null,
            breakOver9hOverride: body.breakOver9hOverride ?? null,
            // Phase 85.1.1 (D-01, D-04): per-employee Phorest puffer override on
            // create. undefined / omitted → null (fall back to tenant default).
            phorestPrepMinutesOverride: body.phorestPrepMinutesOverride ?? null,
            phorestWrapupMinutesOverride: body.phorestWrapupMinutesOverride ?? null,
            // Phase 76.31 (D-06): per-employee bsSlot* overrides on create.
            // undefined / omitted → null (delegate down the slot hierarchy).
            bsSlotFirstLongDayMinutes: body.bsSlotFirstLongDayMinutes ?? null,
            bsSlotSecondLongDayMinutes: body.bsSlotSecondLongDayMinutes ?? null,
            bsSlotShortDayMinutes: body.bsSlotShortDayMinutes ?? null,
            bsSlotBlockWeekMinutes: body.bsSlotBlockWeekMinutes ?? null,
          },
        });

        await tx.workSchedule.create({
          data: {
            employeeId: emp.id,
            type: body.scheduleType,
            // For SHIFT_BASED: default to 40h if caller omits weeklyHours (null/0/undefined)
            weeklyHours:
              body.scheduleType === "SHIFT_BASED" ? body.weeklyHours || 40 : body.weeklyHours,
            monthlyHours: body.monthlyHours ?? null,
            // Phase 49.2 — FLEXTIME Kernarbeitszeit (only persisted when FLEXTIME)
            coreStart: body.scheduleType === "FLEXTIME" ? (body.coreStart ?? null) : null,
            coreEnd: body.scheduleType === "FLEXTIME" ? (body.coreEnd ?? null) : null,
            coreDays: body.scheduleType === "FLEXTIME" ? (body.coreDays ?? []) : [],
            workDays: resolvedWorkDays,
            // Phase 107 (D-01, issue #94) — mirrors the weeklyHours SHIFT_BASED
            // default-if-omitted convention above. Initial schedule on employee
            // creation is a contract START (not a contract CHANGE), so workDays
            // above is still allowed to resolve/derive normally — only the D-02
            // freeze on the settings.ts re-save path is exempted from this.
            contractWorkDaysPerWeek:
              body.scheduleType === "SHIFT_BASED" ? (body.contractWorkDaysPerWeek ?? 5) : null,
            validFrom: new Date(body.hireDate),
          },
        });

        await createOvertimeAccount(tx, emp.id, req.user.tenantId);

        // Phase 75b (D-15): the new user's system-role assignment and its audit row, in this same
        // transaction. A grant cannot lower any holder count, so it takes the tenant lock (which
        // serialises it with every guarded role change) but needs no before/after count. The
        // column already holds `body.role`, so the write-back is a no-op kept for one uniform path.
        await lockTenantForRoleChanges(tx, req.user.tenantId);
        const { created: roleAssignment } = await replaceSystemRoleAssignment(
          tx,
          req.user.tenantId,
          user.id,
          body.role,
        );
        await auditRoleAssignmentChange(app, req, tx, {
          userId: user.id,
          entries: roleAssignment !== null ? [createdAssignmentAuditEntry(roleAssignment)] : [],
          compatRole: await syncCompatRoleColumn(tx, req.user.tenantId, user.id),
        });

        // D-22: the new employee's Stammsalon (HOME) row, open-ended from its tenant-local hire
        // day, in the SAME transaction — audited CREATE right after, still inside the tx.
        const homeAssignment = await createInitialHomeAssignment(
          tx,
          req.user.tenantId,
          emp.id,
          salonOutcome.salonId,
          tenantLocalDay(emp.hireDate, tz),
        );
        await auditSalonAssignmentEvent(app, req, {
          entity: "EmployeeSalonAssignment",
          action: "CREATE",
          entityId: homeAssignment.id,
          newValue: toAssignmentDto(homeAssignment),
          tx,
        });

        // Einladung nur erstellen wenn kein Passwort gesetzt
        let token: string | null = null;
        if (!directPassword) {
          token = crypto.randomBytes(32).toString("hex");
          await tx.invitation.create({
            data: {
              token: hashToken(token),
              employeeId: emp.id,
              email: body.email,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
          });
        }

        return { status: "OK" as const, employee: emp, invitationToken: token };
      });

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

      const { employee, invitationToken } = result;

      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "Employee",
        entityId: employee.id,
        newValue: {
          ...employee,
          email: body.email,
          directPassword,
          // Personalstruktur (Phase 41) — Decimal → string for stable JSON
          coverageWeight: employee.coverageWeight.toString(),
        },
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
            },
            ...requestAuditFields(req, {
              ...updatedEmp,
              role: body.role,
              exitDate: updatedEmp.exitDate?.toISOString() ?? null,
              // Personalstruktur (Phase 41) — Decimal → string for stable JSON
              coverageWeight: updatedEmp.coverageWeight.toString(),
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
        const exitYear = effectiveExitDate.getFullYear();
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
            const proRata = calculateProRataVacation(
              Number(entitlement.totalDays),
              exitYear,
              effectiveExitDate,
            );
            const used = Number(entitlement.usedDays);
            if (used > proRata) {
              proRataWarning = {
                used,
                entitlement: proRata,
                message: `Achtung: Der Mitarbeiter hat mehr Urlaub genommen oder genehmigt (${used} Tage) als ihm anteilig zusteht (${proRata} Tage). Bitte prüfen Sie, ob eine Rückforderung nötig ist.`,
              };
            }
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

      await app.prisma.$transaction([
        app.prisma.user.update({
          where: { id: employee.userId },
          data: { isActive: true },
        }),
        app.prisma.employee.update({
          where: { id },
          data: { exitDate: null },
        }),
      ]);

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

      // Alte Invitations ablaufen lassen
      await app.prisma.invitation.updateMany({
        where: { employeeId: id, acceptedAt: null },
        data: { expiresAt: new Date() },
      });

      const rawToken = crypto.randomBytes(32).toString("hex");
      await app.prisma.invitation.create({
        data: {
          token: hashToken(rawToken),
          employeeId: id,
          email: employee.user.email,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
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
