import { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto, { createHash } from "crypto";
import { Prisma } from "@clokr/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { validatePassword, loadPasswordPolicy } from "../utils/password-policy";
import { calculateProRataVacation } from "../utils/vacation-calc";
import { normalizeMac } from "../utils/normalize-mac";
import { normalizeWorkDays, type PerDayHours } from "../utils/calculate-work-days";
import { anonymizeEmployeeData } from "../utils/anonymize";
import {
  ARBZG_FLOOR_OVER_6H,
  ARBZG_FLOOR_OVER_9H,
  BREAK_MAX_OVER_6H,
  BREAK_MAX_OVER_9H,
} from "../utils/break-constants";

// ── Retention constant ─────────────────────────────────────────────────────
const DEFAULT_RETENTION_YEARS = 10;

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
  // Phase 76.7 (D-11, EMP-V19-01) — § 18 ArbZG-Befreiung. ADMIN-only (route
  // already gated by requireRole("ADMIN")). Boolean — null is NOT a valid value.
  // undefined = no change. Audit row SET_TIME_TRACKING_EXEMPT fires only on
  // actual value change (see PATCH handler below).
  isTimeTrackingExempt: z.boolean().optional(),
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

export async function employeeRoutes(app: FastifyInstance) {
  // GET /api/v1/employees
  app.get("/", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req) => {
      const employees = await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          // v1.8.8 — hide DSGVO-anonymized rows from the team picker.
          // Anonymization marker (per CLAUDE.md DSGVO Employee Deletion):
          //   firstName='Gelöscht' AND lastName starts with 'GELÖSCHT-'.
          // GET /:id (audit view) is NOT filtered — anonymized rows must remain
          // resolvable by UUID for audit-trail traceability (T-188-06).
          NOT: {
            AND: [{ firstName: "Gelöscht" }, { lastName: { startsWith: "GELÖSCHT-" } }],
          },
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

      if (user.role === "EMPLOYEE" && user.employeeId !== id) {
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
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const body = createEmployeeSchema.parse(req.body);

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

      const { employee, invitationToken } = await app.prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
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
              validFrom: new Date(body.hireDate),
            },
          });

          await tx.overtimeAccount.create({
            data: { employeeId: emp.id, balanceHours: 0 },
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

          return { employee: emp, invitationToken: token };
        },
      );

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
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const body = updateEmployeeSchema.parse(req.body);

      const employee = await app.prisma.employee.findUnique({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

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
      // Phase 76.7 (D-11, EMP-V19-01) — § 18 ArbZG-Befreiung. undefined = no
      // change, true/false = explicit set. Audit row SET_TIME_TRACKING_EXEMPT
      // fires only when the value actually changes (see Phase 76.7 audit block
      // below, modeled on the Phase 64 break-override pattern).
      if (body.isTimeTrackingExempt !== undefined) {
        updates.isTimeTrackingExempt = body.isTimeTrackingExempt;
      }

      const updated = await app.prisma.employee.update({ where: { id }, data: updates });

      if (body.role !== undefined) {
        await app.prisma.user.update({ where: { id: employee.userId }, data: { role: body.role } });
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
          // Find the VACATION leave type for this tenant
          const vacLeaveType = await app.prisma.leaveType.findFirst({
            where: { tenantId: req.user.tenantId, name: "Urlaub" },
          });
          if (vacLeaveType) {
            const entitlement = await app.prisma.leaveEntitlement.findFirst({
              where: { employeeId: id, leaveTypeId: vacLeaveType.id, year: exitYear },
            });
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
          }
        } catch (err) {
          app.log.warn({ err }, "Pro-rata warning calculation failed silently");
        }
      }

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "Employee",
        entityId: id,
        oldValue: {
          ...employee,
          exitDate: employee.exitDate?.toISOString() ?? null,
          // Personalstruktur (Phase 41) — Decimal → string for stable JSON
          coverageWeight: employee.coverageWeight.toString(),
        },
        newValue: {
          ...updated,
          role: body.role,
          exitDate: updated.exitDate?.toISOString() ?? null,
          // Personalstruktur (Phase 41) — Decimal → string for stable JSON
          coverageWeight: updated.coverageWeight.toString(),
        },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

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
    preHandler: requireRole("ADMIN"),
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
    preHandler: requireRole("ADMIN"),
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
      if (!employee.user.isActive)
        return reply.code(409).send({ error: "Mitarbeiter ist bereits deaktiviert" });

      const effectiveExitDate = exitDate ? new Date(exitDate) : new Date();

      await app.prisma.$transaction([
        app.prisma.user.update({
          where: { id: employee.userId },
          data: { isActive: false },
        }),
        app.prisma.employee.update({
          where: { id },
          data: { exitDate: effectiveExitDate },
        }),
        app.prisma.refreshToken.updateMany({
          where: { userId: employee.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
        app.prisma.otpToken.updateMany({
          where: { userId: employee.userId, usedAt: null },
          data: { usedAt: new Date() },
        }),
      ]);

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "Employee",
        entityId: id,
        newValue: { isActive: false, exitDate: effectiveExitDate },
      });

      return { success: true };
    },
  });

  // PATCH /api/v1/employees/:id/reactivate
  app.patch("/:id/reactivate", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
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
    preHandler: requireRole("ADMIN"),
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
    preHandler: requireRole("ADMIN"),
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

      await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await anonymizeEmployeeData({ tx, employeeId: id });
        await app.audit({
          userId: req.user.sub,
          action: "ANONYMIZE",
          entity: "Employee",
          entityId: id,
          oldValue: { employeeNumber: employee.employeeNumber },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
          tx,
        });
      });

      return reply.code(204).send();
    },
  });

  // DELETE /api/v1/employees/:id/hard-delete — Endgültige Löschung nach Ablauf der Aufbewahrungsfrist
  // Darf nur auf bereits anonymisierte Mitarbeiter angewendet werden (firstName === "Gelöscht").
  // Gesetzliche Aufbewahrungsfrist: §147 AO / §257 HGB — 10 Jahre nach Austritt/Anlage.
  // Optional body: { forceDelete?: boolean } — bypasses retention check when true (admin override).
  // Every force-delete is flagged in the audit log for auditor traceability.
  const forceDeleteBodySchema = z.object({ forceDelete: z.boolean().optional() }).optional();

  // ── WiFi self-service schemas ───────────────────────────────────────────────
  const meWifiPatchSchema = z.object({
    wifiPresenceEnabled: z.boolean().optional(),
  });

  const meWifiDeviceCreateSchema = z.object({
    mac: z.string().min(1),
    label: z.string().max(64).optional(),
  });

  const deviceIdParamSchema = z.object({ id: z.string().uuid() });

  app.delete("/:id/hard-delete", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const { forceDelete } = forceDeleteBodySchema.parse(req.body ?? {}) ?? {};

      const employee = await app.prisma.employee.findUnique({
        where: { id, tenantId: req.user.tenantId },
        include: { user: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Guard: must be already anonymized — forceDelete does NOT bypass this rule
      if (employee.firstName !== "Gelöscht") {
        return reply.code(409).send({ error: "Mitarbeiter muss zuerst anonymisiert werden" });
      }

      // Retention check — default 10 years (§147 AO), configurable per tenant
      // TODO(types): retentionYears is not yet in TenantConfig schema; using hardcoded default
      const retentionYears = DEFAULT_RETENTION_YEARS;
      const retentionStart: Date = employee.exitDate ?? employee.createdAt;
      const retentionExpires = new Date(
        retentionStart.getFullYear() + retentionYears,
        11,
        31,
        23,
        59,
        59,
      );
      if (new Date() < retentionExpires && !forceDelete) {
        return reply.code(409).send({
          error: "Aufbewahrungsfrist noch nicht abgelaufen",
          retentionExpiresAt: retentionExpires.toISOString(),
        });
      }

      // Audit log BEFORE deletion (entity will be gone after).
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
      });

      const userId = employee.userId;

      // Hard delete in correct order — Restrict-protected relations first
      await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Break records (nested under TimeEntry) — delete first
        await tx.break.deleteMany({ where: { timeEntry: { employeeId: id } } });
        // Restrict-protected models
        await tx.timeEntry.deleteMany({ where: { employeeId: id } });
        await tx.leaveRequest.deleteMany({ where: { employeeId: id } });
        await tx.absence.deleteMany({ where: { employeeId: id } });
        // Cascade-owned models (safe to delete explicitly)
        await tx.leaveEntitlement.deleteMany({ where: { employeeId: id } });
        await tx.workSchedule.deleteMany({ where: { employeeId: id } });
        await tx.overtimeAccount.deleteMany({ where: { employeeId: id } });
        // Finally: employee and user records
        await tx.employee.delete({ where: { id } });
        await tx.user.delete({ where: { id: userId } });
      });

      return reply.code(204).send();
    },
  });

  // ── WiFi self-service routes (GDPR opt-in + MAC enrollment) ────────────────

  // GET /api/v1/employees/me/wifi — Read own wifi opt-in status and device list
  app.get("/me/wifi", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const employeeId = req.user.employeeId;
      const tenantId = req.user.tenantId;

      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId, tenantId },
        select: { wifiPresenceEnabled: true, wifiOptInAt: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      const devices = await app.prisma.presenceDevice.findMany({
        where: { employeeId },
        select: { id: true, mac: true, label: true, addedAt: true },
        orderBy: { addedAt: "asc" },
      });

      return reply.send({
        wifiPresenceEnabled: employee.wifiPresenceEnabled,
        wifiOptInAt: employee.wifiOptInAt,
        devices,
      });
    },
  });

  // PATCH /api/v1/employees/me/wifi — Toggle wifi opt-in (GDPR consent)
  app.patch("/me/wifi", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const body = meWifiPatchSchema.parse(req.body);
      const employeeId = req.user.employeeId;
      const tenantId = req.user.tenantId;

      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId, tenantId },
        select: { wifiPresenceEnabled: true, wifiOptInAt: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      if (body.wifiPresenceEnabled === undefined) {
        return reply.send({
          wifiPresenceEnabled: employee.wifiPresenceEnabled,
          wifiOptInAt: employee.wifiOptInAt,
        });
      }

      const oldVal = employee.wifiPresenceEnabled;
      const newVal = body.wifiPresenceEnabled;

      // When enabling for the first time (or re-enabling), stamp wifiOptInAt
      // When disabling, preserve wifiOptInAt as GDPR consent withdrawal trace
      const updateData: { wifiPresenceEnabled: boolean; wifiOptInAt?: Date } = {
        wifiPresenceEnabled: newVal,
      };
      if (newVal && !employee.wifiOptInAt) {
        updateData.wifiOptInAt = new Date();
      }

      const updated = await app.prisma.employee.update({
        where: { id: employeeId },
        data: updateData,
        select: { wifiPresenceEnabled: true, wifiOptInAt: true },
      });

      // Consent changes are permanently retained — purgeable MUST NOT be set true
      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "Employee",
        entityId: employeeId,
        oldValue: { wifiPresenceEnabled: oldVal },
        newValue: { wifiPresenceEnabled: newVal },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.send({
        wifiPresenceEnabled: updated.wifiPresenceEnabled,
        wifiOptInAt: updated.wifiOptInAt,
      });
    },
  });

  // POST /api/v1/employees/me/wifi/devices — Register a new MAC device
  app.post("/me/wifi/devices", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const body = meWifiDeviceCreateSchema.parse(req.body);
      const employeeId = req.user.employeeId;
      const tenantId = req.user.tenantId;

      if (!employeeId) return reply.code(401).send({ error: "Nicht authentifiziert" });

      // Normalize and validate MAC address
      let mac: string;
      try {
        mac = normalizeMac(body.mac);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : "Ungültige MAC-Adresse" });
      }

      // Check for duplicate: unique per tenant+mac
      const existing = await app.prisma.presenceDevice.findUnique({
        where: { tenantId_mac: { tenantId, mac } },
      });
      if (existing) {
        return reply.code(409).send({ error: "Dieses Gerät ist bereits registriert" });
      }

      const device = await app.prisma.presenceDevice.create({
        data: { tenantId, employeeId, mac, label: body.label },
        select: { id: true, mac: true, label: true, addedAt: true },
      });

      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "PresenceDevice",
        entityId: device.id,
        newValue: { mac, label: body.label },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(201).send(device);
    },
  });

  // DELETE /api/v1/employees/me/wifi/devices/:id — Remove own MAC device
  app.delete("/me/wifi/devices/:id", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = deviceIdParamSchema.parse(req.params);
      const employeeId = req.user.employeeId;

      const device = await app.prisma.presenceDevice.findUnique({
        where: { id },
      });
      if (!device) return reply.code(404).send({ error: "Gerät nicht gefunden" });

      // Own-data guard: employee can only delete their own devices
      if (device.employeeId !== employeeId) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      await app.prisma.presenceDevice.delete({ where: { id } });

      await app.audit({
        userId: req.user.sub,
        action: "DELETE",
        entity: "PresenceDevice",
        entityId: id,
        oldValue: { mac: device.mac, label: device.label },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(204).send();
    },
  });
}
