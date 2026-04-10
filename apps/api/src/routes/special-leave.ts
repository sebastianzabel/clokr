import { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@clokr/db";
import { requireAuth, requireRole } from "../middleware/auth";

/** Statutory special leave defaults per § 616 BGB / common collective agreements. */
const STATUTORY_DEFAULTS = [
  { name: "Eigene Hochzeit", defaultDays: 1, requiresProof: true },
  { name: "Geburt eines Kindes", defaultDays: 1, requiresProof: true },
  { name: "Tod Ehepartner/Lebenspartner", defaultDays: 2, requiresProof: true },
  { name: "Tod Elternteil/Kind", defaultDays: 2, requiresProof: true },
  { name: "Tod Geschwister", defaultDays: 1, requiresProof: true },
  { name: "Tod Schwiegereltern", defaultDays: 1, requiresProof: true },
  { name: "Schwere Erkrankung Hausangehöriger", defaultDays: 1, requiresProof: false },
  { name: "Umzug (betriebsbedingt)", defaultDays: 1, requiresProof: false },
  { name: "Silberne Hochzeit", defaultDays: 1, requiresProof: false },
  { name: "Goldene Hochzeit", defaultDays: 1, requiresProof: false },
  { name: "25-jähriges Dienstjubiläum", defaultDays: 1, requiresProof: false },
];

/** Ensure statutory default rules exist for a tenant (lazy seeding). */
async function ensureStatutoryRules(prisma: Prisma.TransactionClient, tenantId: string) {
  const existing = await prisma.specialLeaveRule.findMany({
    where: { tenantId, isStatutory: true },
  });
  if (existing.length > 0) return;

  for (const def of STATUTORY_DEFAULTS) {
    await prisma.specialLeaveRule.upsert({
      where: { tenantId_name: { tenantId, name: def.name } },
      update: {},
      create: {
        tenantId,
        name: def.name,
        reason: `Gesetzlicher Anspruch gemäß § 616 BGB`,
        defaultDays: def.defaultDays,
        isStatutory: true,
        requiresProof: def.requiresProof,
        isActive: true,
      },
    });
  }
}

const createRuleSchema = z.object({
  name: z.string().min(1).max(100),
  reason: z.string().max(500).optional(),
  defaultDays: z.number().min(0.5).max(30),
  requiresProof: z.boolean().default(false),
});

const updateRuleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  reason: z.string().max(500).nullable().optional(),
  defaultDays: z.number().min(0.5).max(30).optional(),
  requiresProof: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export async function specialLeaveRoutes(app: FastifyInstance) {
  // GET /api/v1/special-leave/rules
  app.get("/rules", {
    schema: { tags: ["Sonderurlaub"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const tenantId = req.user.tenantId;
      await ensureStatutoryRules(app.prisma, tenantId);

      const rules = await app.prisma.specialLeaveRule.findMany({
        where: { tenantId },
        orderBy: [{ isStatutory: "desc" }, { name: "asc" }],
      });
      return rules;
    },
  });

  // POST /api/v1/special-leave/rules — custom rule (admin only)
  app.post("/rules", {
    schema: { tags: ["Sonderurlaub"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, _reply) => {
      const body = createRuleSchema.parse(req.body);
      const tenantId = req.user.tenantId;

      const rule = await app.prisma.specialLeaveRule.create({
        data: {
          tenantId,
          name: body.name,
          reason: body.reason,
          defaultDays: body.defaultDays,
          requiresProof: body.requiresProof,
          isStatutory: false,
          isActive: true,
        },
      });

      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "SpecialLeaveRule",
        entityId: rule.id,
        newValue: body,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return rule;
    },
  });

  // PUT /api/v1/special-leave/rules/:id
  app.put("/rules/:id", {
    schema: { tags: ["Sonderurlaub"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = updateRuleSchema.parse(req.body);

      const existing = await app.prisma.specialLeaveRule.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: "Regel nicht gefunden" });

      // Statutory rules: name cannot be changed
      if (existing.isStatutory && body.name && body.name !== existing.name) {
        return reply.code(400).send({ error: "Name gesetzlicher Regeln kann nicht geändert werden" });
      }

      const updated = await app.prisma.specialLeaveRule.update({
        where: { id },
        data: body,
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "SpecialLeaveRule",
        entityId: id,
        oldValue: { defaultDays: Number(existing.defaultDays), isActive: existing.isActive },
        newValue: body,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return updated;
    },
  });

  // DELETE /api/v1/special-leave/rules/:id — only custom rules
  app.delete("/rules/:id", {
    schema: { tags: ["Sonderurlaub"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };

      const existing = await app.prisma.specialLeaveRule.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: "Regel nicht gefunden" });

      if (existing.isStatutory) {
        return reply.code(400).send({
          error: "Gesetzliche Regeln können nicht gelöscht werden — nur deaktiviert",
        });
      }

      await app.prisma.specialLeaveRule.delete({ where: { id } });

      await app.audit({
        userId: req.user.sub,
        action: "DELETE",
        entity: "SpecialLeaveRule",
        entityId: id,
        oldValue: { name: existing.name },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return { success: true };
    },
  });
}
