import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";

// ── Schemas ──────────────────────────────────────────────────────────────────

// Phase 62 — Berufsschultag pattern item.
// LOCKED decision (CONTEXT.md): at least one of dayOfWeek OR blockWeeks must be set.
// blockYear is required when blockWeeks is set so annual block-week intent is unambiguous.
const patternItemSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    blockWeeks: z.array(z.number().int().min(1).max(53)).default([]),
    blockYear: z.number().int().min(2000).max(2100).nullable().optional(),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "validFrom muss YYYY-MM-DD sein"),
    validUntil: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "validUntil muss YYYY-MM-DD sein")
      .nullable()
      .optional(),
  })
  .refine((p) => p.dayOfWeek != null || (p.blockWeeks && p.blockWeeks.length > 0), {
    message: "Entweder dayOfWeek oder blockWeeks muss gesetzt sein",
  })
  .refine((p) => (p.blockWeeks && p.blockWeeks.length > 0 ? p.blockYear != null : true), {
    message: "blockYear ist erforderlich wenn blockWeeks gesetzt ist",
  });

const putPatternsSchema = z.object({
  patterns: z.array(patternItemSchema),
});

// ── Routes ───────────────────────────────────────────────────────────────────

export async function vocationalSchoolPatternRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // GET /api/v1/employees/:id/vocational-school-pattern
  // Returns active vocational-school patterns for an employee.
  // Access: ADMIN, MANAGER, or the employee themselves.
  app.get("/:id/vocational-school-pattern", {
    schema: { tags: ["Berufsschule"], security: [{ bearerAuth: [] }] },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };

      const employee = await app.prisma.employee.findFirst({
        where: { id, tenantId: req.user.tenantId },
        select: { id: true, userId: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Permission: EMPLOYEE may only read their own patterns
      if (req.user.role === "EMPLOYEE" && req.user.employeeId !== id) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const patterns = await app.prisma.employeeVocationalSchoolPattern.findMany({
        where: { employeeId: id, isActive: true },
        orderBy: [{ validFrom: "desc" }, { dayOfWeek: "asc" }],
      });

      return patterns.map((p) => ({
        ...p,
        validFrom: p.validFrom.toISOString().slice(0, 10),
        validUntil: p.validUntil ? p.validUntil.toISOString().slice(0, 10) : null,
      }));
    },
  });

  // PUT /api/v1/employees/:id/vocational-school-pattern
  // Replaces the active patterns for an employee (ADMIN + MANAGER only).
  // Existing patterns for this employee are deactivated; new ones are inserted.
  app.put("/:id/vocational-school-pattern", {
    schema: { tags: ["Berufsschule"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = putPatternsSchema.parse(req.body);

      const employee = await app.prisma.employee.findFirst({
        where: { id, tenantId: req.user.tenantId },
        select: { id: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Audit before-snapshot — include ALL rows (including inactive) so the audit trail
      // captures the full history at the time of the replace.
      const oldPatterns = await app.prisma.employeeVocationalSchoolPattern.findMany({
        where: { employeeId: id },
      });

      // Replace-Semantik: deactivate all currently active rows + create each new row.
      // No upsert needed — there's no unique constraint to upsert on (multiple active
      // patterns per employee are allowed in the data model; consistency is application-side).
      const created = await app.prisma.$transaction(async (tx) => {
        await tx.employeeVocationalSchoolPattern.updateMany({
          where: { employeeId: id, isActive: true },
          data: { isActive: false },
        });

        const out = [];
        for (const p of body.patterns) {
          const row = await tx.employeeVocationalSchoolPattern.create({
            data: {
              employeeId: id,
              dayOfWeek: p.dayOfWeek ?? null,
              blockWeeks: p.blockWeeks ?? [],
              blockYear: p.blockYear ?? null,
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
        entity: "EmployeeVocationalSchoolPattern",
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
