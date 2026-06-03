import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";

// ── Schemas ──────────────────────────────────────────────────────────────────

// Phase 62 — Berufsschultag pattern item.
// LOCKED decision (CONTEXT.md): at least one of daysOfWeek OR blockWeeks must be set.
// blockYear is required when blockWeeks is set so annual block-week intent is unambiguous.
//
// Phase 67.1 (v1.7.4) — daysOfWeek Int[] replaces single-value dayOfWeek Int?.
// Legacy callers sending `dayOfWeek: N` are normalised in the PUT handler to
// `daysOfWeek: [N]` so old clients (NFC terminal, integration tests) keep working
// during the soak release. Drop the legacy field in v1.7.5.
const patternItemSchema = z
  .object({
    // Legacy single-value field, kept for backwards compat during v1.7.4 soak.
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    // New multi-day field — array of 0=Mo..6=So.
    daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
    blockWeeks: z.array(z.number().int().min(1).max(53)).default([]),
    blockYear: z.number().int().min(2000).max(2100).nullable().optional(),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "validFrom muss YYYY-MM-DD sein"),
    validUntil: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "validUntil muss YYYY-MM-DD sein")
      .nullable()
      .optional(),
  })
  // At least one weekday OR at least one block week must be set.
  // Legacy `dayOfWeek` counts as "weekday set" since the PUT handler normalises it.
  .refine(
    (p) =>
      (p.daysOfWeek && p.daysOfWeek.length > 0) ||
      p.dayOfWeek != null ||
      (p.blockWeeks && p.blockWeeks.length > 0),
    {
      message: "Entweder daysOfWeek oder blockWeeks muss gesetzt sein",
    },
  )
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
        orderBy: [{ validFrom: "desc" }],
      });

      // Phase 67.1: Response includes BOTH `daysOfWeek` (new canonical) AND `dayOfWeek`
      // (legacy single value, derived for backwards-compat consumers — populated only when
      // the row maps to exactly one weekday). Drop `dayOfWeek` from the response in v1.7.5.
      return patterns.map((p) => ({
        ...p,
        dayOfWeek: p.daysOfWeek.length === 1 ? p.daysOfWeek[0] : (p.dayOfWeek ?? null),
        daysOfWeek: p.daysOfWeek,
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
          // Phase 67.1 normalisation: legacy clients send `dayOfWeek: N` instead of
          // `daysOfWeek: [N]`. Coerce into the new shape (dedup + sort for stable rows).
          // Legacy `dayOfWeek` column is still written for one release of soak so a
          // downgrade can roll back to v1.7.3 without breaking existing readers; new
          // canonical reads come from `daysOfWeek`.
          const incomingDays =
            p.daysOfWeek && p.daysOfWeek.length > 0
              ? p.daysOfWeek
              : p.dayOfWeek != null
                ? [p.dayOfWeek]
                : [];
          const normalisedDays = Array.from(new Set(incomingDays)).sort((a, b) => a - b);
          const legacyDayOfWeek = normalisedDays.length === 1 ? normalisedDays[0] : null;

          const row = await tx.employeeVocationalSchoolPattern.create({
            data: {
              employeeId: id,
              dayOfWeek: legacyDayOfWeek,
              daysOfWeek: normalisedDays,
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
          // Phase 67.1: mirror GET shape so the UI's optimistic re-hydrate works
          // regardless of whether it reads `daysOfWeek` (new) or `dayOfWeek` (legacy).
          dayOfWeek: p.daysOfWeek.length === 1 ? p.daysOfWeek[0] : (p.dayOfWeek ?? null),
          daysOfWeek: p.daysOfWeek,
          validFrom: p.validFrom.toISOString().slice(0, 10),
          validUntil: p.validUntil ? p.validUntil.toISOString().slice(0, 10) : null,
        })),
      });
    },
  });
}
