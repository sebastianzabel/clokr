// Phase 62 — Berufsschultag manual trigger + preview routes.
//
// POST /api/v1/vocational-school/generate — ADMIN/MANAGER trigger the generator on-demand
//                                            for their tenant. Returns counts.
// GET  /api/v1/vocational-school/preview   — Dry-run that shows what would be created
//                                            without persisting anything.

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  runVocationalSchoolGeneration,
  previewVocationalSchoolGeneration,
} from "../utils/vocational-school-generator";

const previewQuerySchema = z.object({
  weeks: z.coerce.number().int().min(1).max(26).optional(),
});

export async function vocationalSchoolRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // POST /api/v1/vocational-school/generate — manual trigger (ADMIN/MANAGER)
  app.post("/generate", {
    schema: { tags: ["Berufsschule"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const tenantId = req.user.tenantId;

      // Read tenant's configured preview window (default 4 weeks).
      const config = await app.prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: { vocationalSchoolPreviewWeeks: true },
      });
      const weeksAhead = config?.vocationalSchoolPreviewWeeks ?? 4;

      const result = await runVocationalSchoolGeneration(app.prisma, app.audit, {
        tenantId,
        weeksAhead,
      });
      return reply.code(200).send(result);
    },
  });

  // GET /api/v1/vocational-school/preview?weeks=N — dry-run (ADMIN/MANAGER)
  app.get("/preview", {
    schema: { tags: ["Berufsschule"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const tenantId = req.user.tenantId;
      const q = previewQuerySchema.parse(req.query);

      let weeksAhead = q.weeks;
      if (!weeksAhead) {
        const config = await app.prisma.tenantConfig.findUnique({
          where: { tenantId },
          select: { vocationalSchoolPreviewWeeks: true },
        });
        weeksAhead = config?.vocationalSchoolPreviewWeeks ?? 4;
      }

      const result = await previewVocationalSchoolGeneration(app.prisma, {
        tenantId,
        weeksAhead,
      });
      return reply.code(200).send(result);
    },
  });
}
