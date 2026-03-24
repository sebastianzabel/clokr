import { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { requireAuth, requireRole } from "../middleware/auth";

const createEmployeeSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  employeeNumber: z.string().min(1),
  hireDate: z.string().datetime(),
  role: z.enum(["ADMIN", "MANAGER", "EMPLOYEE"]).default("EMPLOYEE"),
  weeklyHours: z.number().positive().default(40),
  nfcCardId: z.string().optional(),
  password: z.string().min(8).optional(),
});

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
          workSchedule: true,
          overtimeAccount: { select: { balanceHours: true } },
          invitations: { orderBy: { createdAt: "desc" }, take: 1 },
        },
        orderBy: { lastName: "asc" },
      });

      return employees.map((e: any) => ({
        ...e,
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
      const { id } = req.params as { id: string };
      const user = req.user;

      if (user.role === "EMPLOYEE" && user.employeeId !== id) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const employee = await app.prisma.employee.findUnique({
        where: { id },
        include: {
          user: { select: { email: true, role: true, isActive: true } },
          workSchedule: true,
          overtimeAccount: true,
          leaveEntitlements: { include: { leaveType: true } },
          invitations: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      });

      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      return {
        ...employee,
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
      const passwordHash = directPassword
        ? await bcrypt.hash(body.password!, 12)
        : await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);

      const { employee, invitationToken } = await app.prisma.$transaction(async (tx: any) => {
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
            weeklyHours: body.weeklyHours,
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
              token,
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
          });
        } catch (err) {
          emailError = "E-Mail konnte nicht gesendet werden. Bitte SMTP-Einstellungen prüfen.";
          app.log.error({ err }, "Einladungsmail konnte nicht gesendet werden");
        }
      }

      return reply.code(201).send({
        ...employee,
        invitationStatus: directPassword ? "ACCEPTED" : "PENDING",
        ...(emailError ? { emailError } : {}),
      });
    },
  });

  // PATCH /api/v1/employees/:id — Profil aktualisieren
  app.patch("/:id", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = updateEmployeeSchema.parse(req.body);

      const employee = await app.prisma.employee.findUnique({ where: { id } });
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

      return updated;
    },
  });

  // PATCH /api/v1/employees/:id/deactivate
  app.patch("/:id/deactivate", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
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
      const { id } = req.params as { id: string };

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
          workSchedule: true,
          overtimeAccount: { select: { balanceHours: true } },
        },
      });

      return updated;
    },
  });

  // POST /api/v1/employees/:id/resend-invitation
  app.post("/:id/resend-invitation", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };

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

      const token = crypto.randomBytes(32).toString("hex");
      await app.prisma.invitation.create({
        data: {
          token,
          employeeId: id,
          email: employee.user.email,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      try {
        await app.mailer.sendInvitation({
          to: employee.user.email,
          firstName: employee.firstName,
          token,
        });
      } catch (err) {
        app.log.error({ err }, "Einladungsmail konnte nicht gesendet werden");
        return reply.code(502).send({ error: "E-Mail konnte nicht gesendet werden" });
      }

      return { success: true, message: "Einladung erneut gesendet" };
    },
  });

  // DELETE /api/v1/employees/:id — DSGVO Hard-Delete
  app.delete("/:id", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };

      const employee = await app.prisma.employee.findUnique({
        where: { id },
        include: { user: true, overtimeAccount: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      const userId = employee.userId;
      const overtimeAccountId = employee.overtimeAccount?.id;

      await app.audit({
        userId: req.user.sub,
        action: "DELETE",
        entity: "Employee",
        entityId: id,
        oldValue: { email: employee.user.email, employeeNumber: employee.employeeNumber },
      });

      // Schrittweise löschen in korrekter Reihenfolge (FK-Constraints)
      await app.prisma.$transaction(async (tx: any) => {
        // AuditLog anonymisieren (userId → null), nicht löschen
        await tx.auditLog.updateMany({ where: { userId }, data: { userId: null } });

        await tx.timeEntry.deleteMany({ where: { employeeId: id } });
        await tx.leaveRequest.deleteMany({ where: { employeeId: id } });
        await tx.absence.deleteMany({ where: { employeeId: id } });
        await tx.leaveEntitlement.deleteMany({ where: { employeeId: id } });
        await tx.overtimePlan.deleteMany({ where: { employeeId: id } });

        if (overtimeAccountId) {
          await tx.overtimeTransaction.deleteMany({ where: { overtimeAccountId } });
          await tx.overtimeAccount.delete({ where: { id: overtimeAccountId } });
        }

        await tx.workSchedule.deleteMany({ where: { employeeId: id } });
        await tx.invitation.deleteMany({ where: { employeeId: id } });
        await tx.otpToken.deleteMany({ where: { userId } });
        await tx.refreshToken.deleteMany({ where: { userId } });
        await tx.employee.delete({ where: { id } });
        await tx.user.delete({ where: { id: userId } });
      });

      return reply.code(204).send();
    },
  });
}
