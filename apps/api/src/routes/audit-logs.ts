import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../middleware/auth";

const querySchema = z.object({
  page: z.string().regex(/^\d+$/).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  action: z.string().min(1).max(64).optional(),
  entity: z.string().min(1).max(64).optional(),
  userId: z.string().uuid().optional(),
});

export async function auditLogRoutes(app: FastifyInstance) {
  // GET /audit-logs — ADMIN only, paginated, tenant-scoped
  app.get(
    "/",
    { preHandler: requireRole("ADMIN") },
    async (req, _reply) => {
      const { page = "1", limit = "50", action, entity, userId } = querySchema.parse(req.query);

      const take = Math.min(parseInt(limit), 200);
      const skip = (parseInt(page) - 1) * take;

      // Tenant scoping: AuditLog.userId → User.employee.tenantId
      // (User has no direct tenantId; tenant is reached via the Employee 1:1 relation)
      const where = {
        user: { employee: { tenantId: req.user.tenantId } },
        ...(action ? { action } : {}),
        ...(entity ? { entity } : {}),
        ...(userId ? { userId } : {}),
      };

      const [logs, total] = await Promise.all([
        app.prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take,
          skip,
          include: {
            user: { select: { email: true } },
          },
        }),
        app.prisma.auditLog.count({ where }),
      ]);

      return { logs, total, page: parseInt(page), limit: take };
    }
  );
}
