/**
 * Phase 64b Plan 01 (issue #64) — Unterbau's admin `Salon` routes, prefix `/api/v1/salons`.
 *
 * This task registers only the read path (`GET /`); create/update/(de)activate follow in plan
 * 02. See `contexts/platform/facade/salons.ts` for the tenant-scoped read functions this route
 * calls into.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../../../middleware/auth";
import { isMultiSalonTenant, listSalons } from "../facade/salons";

const listQuerySchema = z.object({
  includeInactive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export async function salonRoutes(app: FastifyInstance) {
  // GET /api/v1/salons — list the caller's tenant's salons + derived multisalon status
  app.get("/", {
    schema: {
      tags: ["Salons"],
      summary: "List the caller's tenant's salons",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req) => {
      const { includeInactive } = listQuerySchema.parse(req.query);

      return {
        salons: await listSalons(app.prisma, req.user.tenantId, {
          includeInactive: includeInactive ?? false,
        }),
        isMultiSalon: await isMultiSalonTenant(app.prisma, req.user.tenantId),
      };
    },
  });
}
