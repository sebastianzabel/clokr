import { FastifyInstance } from "fastify";
import { requireRole } from "../middleware/auth";

export async function auditLogRoutes(app: FastifyInstance) {
  // GET /audit-logs — ADMIN only, paginated
  app.get(
    "/",
    { preHandler: requireRole("ADMIN") },
    async (req, _reply) => {
      const { page = "1", limit = "50", action, entity, userId } = req.query as {
        page?: string;
        limit?: string;
        action?: string;
        entity?: string;
        userId?: string;
      };

      const take = Math.min(parseInt(limit), 200);
      const skip = (parseInt(page) - 1) * take;

      const where = {
        ...(action   ? { action }   : {}),
        ...(entity   ? { entity }   : {}),
        ...(userId   ? { userId }   : {}),
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
