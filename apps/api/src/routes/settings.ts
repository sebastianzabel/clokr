import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { FederalState } from "@clokr/db";

const VALID_FEDERAL_STATES = Object.values(FederalState) as string[];

const tenantConfigSchema = z.object({
  defaultWeeklyHours:    z.number().min(1).max(60).optional(),
  defaultMondayHours:    z.number().min(0).max(24).optional(),
  defaultTuesdayHours:   z.number().min(0).max(24).optional(),
  defaultWednesdayHours: z.number().min(0).max(24).optional(),
  defaultThursdayHours:  z.number().min(0).max(24).optional(),
  defaultFridayHours:    z.number().min(0).max(24).optional(),
  defaultSaturdayHours:  z.number().min(0).max(24).optional(),
  defaultSundayHours:    z.number().min(0).max(24).optional(),
  overtimeThreshold:        z.number().min(1).max(500).optional(),
  allowOvertimePayout:      z.boolean().optional(),
  federalState:             z.string().refine((s) => VALID_FEDERAL_STATES.includes(s)).optional(),
  carryOverDeadlineDay:     z.number().int().min(1).max(31).optional(),
  carryOverDeadlineMonth:   z.number().int().min(1).max(12).optional(),
  defaultVacationDays:      z.number().int().min(1).max(365).optional(),
});

const vacationEntitlementSchema = z.object({
  year:             z.number().int().min(2000).max(2100),
  totalDays:        z.number().min(0).max(365),
  carriedOverDays:  z.number().min(0).max(365).optional(),
  carryOverDeadline: z.string().nullable().optional(), // ISO date string or null
});

const employeeScheduleSchema = z.object({
  weeklyHours:    z.number().min(1).max(60),
  mondayHours:    z.number().min(0).max(24),
  tuesdayHours:   z.number().min(0).max(24),
  wednesdayHours: z.number().min(0).max(24),
  thursdayHours:  z.number().min(0).max(24),
  fridayHours:    z.number().min(0).max(24),
  saturdayHours:  z.number().min(0).max(24),
  sundayHours:    z.number().min(0).max(24),
  overtimeThreshold:   z.number().min(1).max(500),
  allowOvertimePayout: z.boolean(),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function settingsRoutes(app: FastifyInstance) {

  // GET /api/v1/settings/work  — globale Vorgaben
  app.get("/work", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const tenantId = await getTenantId(app, req.user.sub);
      const [config, tenant] = await Promise.all([
        app.prisma.tenantConfig.findUnique({ where: { tenantId } }),
        app.prisma.tenant.findUnique({ where: { id: tenantId } }),
      ]);

      const base = config ?? {
        tenantId,
        defaultWeeklyHours:      40,
        defaultMondayHours:      8,
        defaultTuesdayHours:     8,
        defaultWednesdayHours:   8,
        defaultThursdayHours:    8,
        defaultFridayHours:      8,
        defaultSaturdayHours:    0,
        defaultSundayHours:      0,
        overtimeThreshold:       60,
        allowOvertimePayout:     false,
        carryOverDeadlineDay:    31,
        carryOverDeadlineMonth:  3,
        defaultVacationDays:     30,
      };

      return { ...base, federalState: tenant?.federalState ?? "NIEDERSACHSEN" };
    },
  });

  // PUT /api/v1/settings/work  — globale Vorgaben speichern (nur Admin)
  app.put("/work", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const body = tenantConfigSchema.parse(req.body);
      const tenantId = await getTenantId(app, req.user.sub);

      // federalState gehört zum Tenant, nicht zur TenantConfig
      const { federalState, ...configBody } = body;

      const [config] = await Promise.all([
        app.prisma.tenantConfig.upsert({
          where: { tenantId },
          update: configBody,
          create: { tenantId, ...configBody },
        }),
        federalState
          ? app.prisma.tenant.update({
              where: { id: tenantId },
              data: { federalState: federalState as FederalState },
            })
          : Promise.resolve(null),
      ]);

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "TenantConfig",
        entityId: config.id,
        newValue: body,
      });

      return { ...config, federalState: federalState ?? undefined };
    },
  });

  // GET /api/v1/settings/work/:employeeId  — Arbeitszeit eines Mitarbeiters
  app.get("/work/:employeeId", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };
      const isManager = ["ADMIN", "MANAGER"].includes(req.user.role);

      if (!isManager && req.user.employeeId !== employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }

      const schedule = await app.prisma.workSchedule.findUnique({ where: { employeeId } });
      if (!schedule) return reply.code(404).send({ error: "Kein Arbeitszeitmodell gefunden" });

      return schedule;
    },
  });

  // PUT /api/v1/settings/work/:employeeId  — Arbeitszeit eines Mitarbeiters setzen
  app.put("/work/:employeeId", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };
      const body = employeeScheduleSchema.parse(req.body);

      const employee = await app.prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      const old = await app.prisma.workSchedule.findUnique({ where: { employeeId } });

      const schedule = await app.prisma.workSchedule.upsert({
        where: { employeeId },
        update: {
          weeklyHours:    body.weeklyHours,
          mondayHours:    body.mondayHours,
          tuesdayHours:   body.tuesdayHours,
          wednesdayHours: body.wednesdayHours,
          thursdayHours:  body.thursdayHours,
          fridayHours:    body.fridayHours,
          saturdayHours:  body.saturdayHours,
          sundayHours:    body.sundayHours,
          overtimeThreshold:   body.overtimeThreshold,
          allowOvertimePayout: body.allowOvertimePayout,
          validFrom: new Date(body.validFrom),
        },
        create: {
          employeeId,
          weeklyHours:    body.weeklyHours,
          mondayHours:    body.mondayHours,
          tuesdayHours:   body.tuesdayHours,
          wednesdayHours: body.wednesdayHours,
          thursdayHours:  body.thursdayHours,
          fridayHours:    body.fridayHours,
          saturdayHours:  body.saturdayHours,
          sundayHours:    body.sundayHours,
          overtimeThreshold:   body.overtimeThreshold,
          allowOvertimePayout: body.allowOvertimePayout,
          validFrom: new Date(body.validFrom),
        },
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "WorkSchedule",
        entityId: schedule.id,
        oldValue: old,
        newValue: schedule,
      });

      return schedule;
    },
  });

  // GET /api/v1/settings/vacation/:employeeId?year=  — Urlaubsanspruch eines Mitarbeiters
  app.get("/vacation/:employeeId", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };
      const { year: yearStr } = req.query as { year?: string };
      const year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();

      const employee = await app.prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Urlaub-LeaveType finden
      const vacationType = await app.prisma.leaveType.findFirst({
        where: { tenantId: employee.tenantId, name: { contains: "Urlaub", mode: "insensitive" } },
      });
      if (!vacationType) return reply.code(404).send({ error: "Urlaubstyp nicht konfiguriert" });

      const entitlement = await app.prisma.leaveEntitlement.findUnique({
        where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: vacationType.id, year } },
      });

      return {
        year,
        leaveTypeId: vacationType.id,
        totalDays: entitlement ? Number(entitlement.totalDays) : null,
        usedDays: entitlement ? Number(entitlement.usedDays) : 0,
        carriedOverDays: entitlement ? Number(entitlement.carriedOverDays) : 0,
        carryOverDeadline: entitlement?.carryOverDeadline ?? null,
      };
    },
  });

  // PUT /api/v1/settings/vacation/:employeeId  — Urlaubsanspruch setzen
  app.put("/vacation/:employeeId", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };
      const body = vacationEntitlementSchema.parse(req.body);

      const employee = await app.prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      const vacationType = await app.prisma.leaveType.findFirst({
        where: { tenantId: employee.tenantId, name: { contains: "Urlaub", mode: "insensitive" } },
      });
      if (!vacationType) return reply.code(404).send({ error: "Urlaubstyp nicht konfiguriert" });

      const data = {
        totalDays: body.totalDays,
        carriedOverDays: body.carriedOverDays ?? 0,
        carryOverDeadline: body.carryOverDeadline ? new Date(body.carryOverDeadline) : null,
      };

      const entitlement = await app.prisma.leaveEntitlement.upsert({
        where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: vacationType.id, year: body.year } },
        update: data,
        create: { employeeId, leaveTypeId: vacationType.id, year: body.year, ...data },
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "LeaveEntitlement",
        entityId: entitlement.id,
        newValue: body,
      });

      return {
        year: body.year,
        totalDays: Number(entitlement.totalDays),
        usedDays: Number(entitlement.usedDays),
        carriedOverDays: Number(entitlement.carriedOverDays),
        carryOverDeadline: entitlement.carryOverDeadline,
      };
    },
  });

  // GET /api/v1/settings/smtp
  app.get("/smtp", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const tenantId = await getTenantId(app, req.user.sub);
      const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      return {
        smtpHost:         cfg?.smtpHost      ?? null,
        smtpPort:         cfg?.smtpPort      ?? null,
        smtpUser:         cfg?.smtpUser      ?? null,
        smtpPasswordSet:  !!(cfg?.smtpPassword),
        smtpFromEmail:    cfg?.smtpFromEmail ?? null,
        smtpFromName:     cfg?.smtpFromName  ?? null,
        smtpSecure:       cfg?.smtpSecure    ?? false,
      };
    },
  });

  // PUT /api/v1/settings/smtp
  app.put("/smtp", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const smtpSchema = z.object({
        smtpHost:      z.string().min(1),
        smtpPort:      z.number().int().min(1).max(65535),
        smtpUser:      z.string().min(1),
        smtpPassword:  z.string().optional(),
        smtpFromEmail: z.string().email(),
        smtpFromName:  z.string().min(1),
        smtpSecure:    z.boolean(),
      });
      const body = smtpSchema.parse(req.body);
      const tenantId = await getTenantId(app, req.user.sub);

      const updateData: Record<string, unknown> = {
        smtpHost:      body.smtpHost,
        smtpPort:      body.smtpPort,
        smtpUser:      body.smtpUser,
        smtpFromEmail: body.smtpFromEmail,
        smtpFromName:  body.smtpFromName,
        smtpSecure:    body.smtpSecure,
      };
      if (body.smtpPassword) updateData.smtpPassword = body.smtpPassword;

      await app.prisma.tenantConfig.upsert({
        where:  { tenantId },
        update: updateData,
        create: { tenantId, ...updateData },
      });

      return { success: true };
    },
  });

  // POST /api/v1/settings/smtp/test
  app.post("/smtp/test", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { email } = z.object({ email: z.string().email() }).parse(req.body);
      try {
        await app.mailer.sendTestMail(email);
        return { success: true, message: "Testmail erfolgreich gesendet" };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: `SMTP-Fehler: ${msg}` });
      }
    },
  });

  // GET /api/v1/settings/security
  app.get("/security", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const tenantId = await getTenantId(app, req.user.sub);
      const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      return { twoFaEnabled: cfg?.twoFaEnabled ?? false };
    },
  });

  // PUT /api/v1/settings/security
  app.put("/security", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const { twoFaEnabled } = z.object({ twoFaEnabled: z.boolean() }).parse(req.body);
      const tenantId = await getTenantId(app, req.user.sub);
      await app.prisma.tenantConfig.upsert({
        where:  { tenantId },
        update: { twoFaEnabled },
        create: { tenantId, twoFaEnabled },
      });
      return { twoFaEnabled };
    },
  });

  // GET /api/v1/settings/employees  — alle Mitarbeiter mit ihren Arbeitszeitmodellen
  app.get("/employees", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req) => {
      const tenantId = await getTenantId(app, req.user.sub);

      const employees = await app.prisma.employee.findMany({
        where: { tenantId },
        include: {
          user: { select: { email: true } },
          workSchedule: true,
        },
        orderBy: { employeeNumber: "asc" },
      });

      return employees.map((e) => ({
        id:             e.id,
        employeeNumber: e.employeeNumber,
        firstName:      e.firstName,
        lastName:       e.lastName,
        email:          e.user.email,
        workSchedule:   e.workSchedule,
      }));
    },
  });
}

async function getTenantId(app: FastifyInstance, userId: string): Promise<string> {
  const employee = await app.prisma.employee.findFirst({ where: { userId } });
  if (employee) return employee.tenantId;
  // Fallback: ersten Tenant nehmen (für Admins ohne Employee-Profil)
  const tenant = await app.prisma.tenant.findFirst();
  if (!tenant) throw new Error("Kein Tenant gefunden");
  return tenant.id;
}
