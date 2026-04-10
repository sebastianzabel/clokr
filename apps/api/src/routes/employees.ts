import { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto, { createHash } from "crypto";
import { Prisma } from "@clokr/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { validatePassword, loadPasswordPolicy } from "../utils/password-policy";

// ── Retention constant ─────────────────────────────────────────────────────
const DEFAULT_RETENTION_YEARS = 10;

/** SHA-256 hash for tokens stored in DB. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const createEmployeeSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  employeeNumber: z.string().min(1),
  hireDate: z.string().datetime(),
  role: z.enum(["ADMIN", "MANAGER", "EMPLOYEE"]).default("EMPLOYEE"),
  weeklyHours: z.number().min(0).max(60).default(0),
  scheduleType: z.enum(["FIXED_WEEKLY", "MONTHLY_HOURS"]).default("FIXED_WEEKLY"),
  monthlyHours: z.number().min(0).max(999).nullable().optional(),
  nfcCardId: z.string().optional(),
  password: z.string().min(8).optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

const updateEmployeeSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  employeeNumber: z.string().min(1).optional(),
  hireDate: z.string().datetime().optional(),
  role: z.enum(["ADMIN", "MANAGER", "EMPLOYEE"]).optional(),
  nfcCardId: z.string().nullable().optional(),
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
        where: { tenantId: req.user.tenantId },
        include: {
          user: { select: { email: true, role: true, isActive: true, lastLoginAt: true } },
          workSchedules: { orderBy: { validFrom: "desc" }, take: 1 },
          overtimeAccount: { select: { balanceHours: true } },
          invitations: { orderBy: { createdAt: "desc" }, take: 1 },
        },
        orderBy: { lastName: "asc" },
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

      const { employee, invitationToken } = await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
          },
        });

        await tx.workSchedule.create({
          data: {
            employeeId: emp.id,
            type: body.scheduleType,
            weeklyHours: body.weeklyHours,
            monthlyHours: body.monthlyHours ?? null,
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
      });

      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "Employee",
        entityId: employee.id,
        newValue: { ...employee, email: body.email, directPassword },
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
        invitationStatus: directPassword ? "ACCEPTED" : deriveInvitationStatus(fullEmployee.user.isActive, fullEmployee.invitations),
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

      const employee = await app.prisma.employee.findUnique({ where: { id, tenantId: req.user.tenantId } });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      const updates: Record<string, unknown> = {};
      if (body.firstName !== undefined) updates.firstName = body.firstName;
      if (body.lastName !== undefined) updates.lastName = body.lastName;
      if (body.employeeNumber !== undefined) updates.employeeNumber = body.employeeNumber;
      if (body.hireDate !== undefined) updates.hireDate = new Date(body.hireDate);
      if (body.nfcCardId !== undefined) updates.nfcCardId = body.nfcCardId;

      const updated = await app.prisma.employee.update({ where: { id }, data: updates });

      if (body.role !== undefined) {
        await app.prisma.user.update({ where: { id: employee.userId }, data: { role: body.role } });
      }

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "Employee",
        entityId: id,
        oldValue: employee,
        newValue: { ...updated, role: body.role },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return updated;
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

      const userId = employee.userId;
      const anonymizedLabel = `GELÖSCHT-${employee.employeeNumber || id.slice(0, 8)}`;

      await app.audit({
        userId: req.user.sub,
        action: "ANONYMIZE",
        entity: "Employee",
        entityId: id,
        oldValue: { email: employee.user.email, employeeNumber: employee.employeeNumber },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // AuditLog anonymisieren (userId → null)
        await tx.auditLog.updateMany({ where: { userId }, data: { userId: null } });

        // Employee: personenbezogene Daten anonymisieren, Record behalten
        await tx.employee.update({
          where: { id },
          data: {
            firstName: "Gelöscht",
            lastName: anonymizedLabel,
            employeeNumber: anonymizedLabel,
            nfcCardId: null,
          },
        });

        // User: deaktivieren + anonymisieren (kein Login mehr möglich)
        await tx.user.update({
          where: { id: userId },
          data: {
            email: `deleted-${id.slice(0, 8)}@anonymized.local`,
            passwordHash: "ANONYMIZED",
            isActive: false,
          },
        });

        // Notizen in Zeiteinträgen anonymisieren (können persönliche Daten enthalten)
        await tx.timeEntry.updateMany({
          where: { employeeId: id, note: { not: null } },
          data: { note: null },
        });

        // Notizen in Urlaubsanträgen anonymisieren
        await tx.leaveRequest.updateMany({
          where: { employeeId: id, note: { not: null } },
          data: { note: null },
        });

        // Notizen in Abwesenheiten anonymisieren + Dokument-Pfad entfernen
        await tx.absence.updateMany({
          where: { employeeId: id },
          data: { note: null, documentPath: null },
        });

        // Auth-Tokens löschen (nicht aufbewahrungspflichtig)
        await tx.invitation.deleteMany({ where: { employeeId: id } });
        await tx.otpToken.deleteMany({ where: { userId } });
        await tx.refreshToken.deleteMany({ where: { userId } });
      });

      return reply.code(204).send();
    },
  });

  // DELETE /api/v1/employees/:id/hard-delete — Endgültige Löschung nach Ablauf der Aufbewahrungsfrist
  // Darf nur auf bereits anonymisierte Mitarbeiter angewendet werden (firstName === "Gelöscht").
  // Gesetzliche Aufbewahrungsfrist: §147 AO / §257 HGB — 10 Jahre nach Austritt/Anlage.
  app.delete("/:id/hard-delete", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);

      const employee = await app.prisma.employee.findUnique({
        where: { id, tenantId: req.user.tenantId },
        include: { user: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Guard: must be already anonymized
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
      if (new Date() < retentionExpires) {
        return reply.code(409).send({
          error: "Aufbewahrungsfrist noch nicht abgelaufen",
          retentionExpiresAt: retentionExpires.toISOString(),
        });
      }

      // Audit log BEFORE deletion (entity will be gone after)
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
}
