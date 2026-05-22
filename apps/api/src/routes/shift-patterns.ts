import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";

// ── Schemas ──────────────────────────────────────────────────────────────────

const patternItemSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  templateId: z.string().uuid().nullable().optional(),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "validFrom muss YYYY-MM-DD sein"),
  validUntil: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "validUntil muss YYYY-MM-DD sein")
    .nullable()
    .optional(),
});

const putPatternsSchema = z.object({
  patterns: z.array(patternItemSchema),
});

// ── Routes ───────────────────────────────────────────────────────────────────

export async function shiftPatternRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // GET /api/v1/employees/:id/shift-patterns
  // Returns the active recurring shift patterns for an employee.
  // Access: ADMIN, MANAGER, or the employee themselves.
  app.get("/:id/shift-patterns", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };

      // Ensure the employee belongs to the requesting tenant
      const employee = await app.prisma.employee.findFirst({
        where: { id, tenantId: req.user.tenantId },
        select: { id: true, userId: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Permission: EMPLOYEE may only read their own patterns
      if (req.user.role === "EMPLOYEE" && req.user.employeeId !== id) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const patterns = await app.prisma.employeeShiftPattern.findMany({
        where: { employeeId: id, isActive: true },
        include: {
          template: {
            select: { id: true, name: true, startTime: true, endTime: true, color: true },
          },
        },
        orderBy: [{ validFrom: "desc" }, { dayOfWeek: "asc" }],
      });

      return patterns.map((p) => ({
        ...p,
        validFrom: p.validFrom.toISOString().slice(0, 10),
        validUntil: p.validUntil ? p.validUntil.toISOString().slice(0, 10) : null,
      }));
    },
  });

  // PUT /api/v1/employees/:id/shift-patterns
  // Replaces the active patterns for an employee (ADMIN + MANAGER only).
  // Existing patterns for this employee are deactivated; new ones are inserted.
  app.put("/:id/shift-patterns", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = putPatternsSchema.parse(req.body);

      const employee = await app.prisma.employee.findFirst({
        where: { id, tenantId: req.user.tenantId },
        select: { id: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Validate any provided templateIds belong to this tenant
      const templateIds = Array.from(
        new Set(body.patterns.map((p) => p.templateId).filter((t): t is string => !!t)),
      );
      if (templateIds.length > 0) {
        const tpls = await app.prisma.shiftTemplate.findMany({
          where: { id: { in: templateIds }, tenantId: req.user.tenantId },
          select: { id: true },
        });
        if (tpls.length !== templateIds.length) {
          return reply.code(400).send({ error: "Unbekannte Schicht-Vorlage referenziert" });
        }
      }

      // Audit before-snapshot
      const oldPatterns = await app.prisma.employeeShiftPattern.findMany({
        where: { employeeId: id },
      });

      // Replace: deactivate existing then create new active ones in a transaction
      const created = await app.prisma.$transaction(async (tx) => {
        await tx.employeeShiftPattern.updateMany({
          where: { employeeId: id, isActive: true },
          data: { isActive: false },
        });

        const out = [];
        for (const p of body.patterns) {
          // Use upsert on the unique (employeeId, dayOfWeek, validFrom) constraint so
          // re-saving the same shape doesn't error.
          const row = await tx.employeeShiftPattern.upsert({
            where: {
              employeeId_dayOfWeek_validFrom: {
                employeeId: id,
                dayOfWeek: p.dayOfWeek,
                validFrom: new Date(p.validFrom),
              },
            },
            update: {
              templateId: p.templateId ?? null,
              validUntil: p.validUntil ? new Date(p.validUntil) : null,
              isActive: true,
            },
            create: {
              employeeId: id,
              dayOfWeek: p.dayOfWeek,
              templateId: p.templateId ?? null,
              validFrom: new Date(p.validFrom),
              validUntil: p.validUntil ? new Date(p.validUntil) : null,
              isActive: true,
            },
          });
          out.push(row);
        }
        return out;
      });

      await app.audit({
        userId: req.user.sub,
        action: "REPLACE",
        entity: "EmployeeShiftPattern",
        entityId: id,
        oldValue: { patterns: oldPatterns },
        newValue: { patterns: created },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(200).send({
        patterns: created.map((p) => ({
          ...p,
          validFrom: p.validFrom.toISOString().slice(0, 10),
          validUntil: p.validUntil ? p.validUntil.toISOString().slice(0, 10) : null,
        })),
      });
    },
  });
}

// Phase 48 — Tenant-wide bulk read for the pattern-editor matrix UI.
// Mounted under /api/v1/shift-patterns so the URL is tenant-scoped, not employee-scoped.
export async function shiftPatternTenantRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // GET /api/v1/shift-patterns/tenant
  // Returns all active EmployeeShiftPattern rows for SHIFT_BASED employees in the
  // requesting tenant. Used by the pattern-editor matrix to load Mitarbeiter ×
  // Wochentag state in one round-trip instead of N per-employee calls.
  app.get("/tenant", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req) => {
      const rows = await app.prisma.employeeShiftPattern.findMany({
        where: {
          isActive: true,
          employee: {
            tenantId: req.user.tenantId,
            workSchedules: { some: { type: "SHIFT_BASED" } },
          },
        },
        select: {
          id: true,
          employeeId: true,
          dayOfWeek: true,
          templateId: true,
          validFrom: true,
          validUntil: true,
        },
        orderBy: [{ employeeId: "asc" }, { dayOfWeek: "asc" }],
      });
      return rows.map((p) => ({
        ...p,
        validFrom: p.validFrom.toISOString().slice(0, 10),
        validUntil: p.validUntil ? p.validUntil.toISOString().slice(0, 10) : null,
      }));
    },
  });
}
