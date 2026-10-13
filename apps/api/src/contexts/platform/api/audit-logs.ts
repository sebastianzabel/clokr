import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../request-permissions";

const querySchema = z.object({
  page: z.string().regex(/^\d+$/).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  action: z.string().min(1).max(64).optional(),
  entity: z.string().min(1).max(64).optional(),
  userId: z.string().uuid().optional(),
});

const idParamSchema = z.object({
  id: z.string().min(1),
});

/*
 * Tenant scope of an AuditLog read — the same two-branch `OR` is spelled inline in both reads below
 * (the tenant-scoping gate does not follow helper functions, so a shared builder would hide the
 * constraint from it):
 *   1. rows written by a tenant user (`AuditLog.userId` → `User.employee.tenantId`; the User has
 *      no tenantId of its own, the tenant is reached through the Employee 1:1 relation);
 *   2. rows written by the operator principal (Phase 89, D-09a). They have no user, so the first
 *      branch can never match them. `operator-tenant-audit.ts` stamps `newValue.actor.tenantId`
 *      on every such row, and the second branch matches exactly that stamp.
 * Operator rows written before Phase 89 carry no stamp and stay invisible to every tenant
 * (append-only, deliberately not backfilled; a real `AuditLog.tenantId` column is the deferred
 * long-term model). A stamp naming another tenant matches nothing here.
 */

export async function auditLogRoutes(app: FastifyInstance) {
  // GET /audit-logs — audit-log:read (legacy: ADMIN only), paginated, tenant-scoped
  app.get(
    "/",
    { preHandler: requirePermission("audit-log:read:ZUGEWIESEN") },
    async (req, _reply) => {
      const { page = "1", limit = "50", action, entity, userId } = querySchema.parse(req.query);

      const take = Math.min(parseInt(limit), 200);
      const skip = (parseInt(page) - 1) * take;

      const tenantId = req.user.tenantId;
      // The tenant scope sits in its own AND member, so no optional filter (a `userId` included)
      // can ever widen the set.
      const where = {
        AND: [
          {
            OR: [
              { user: { employee: { tenantId } } },
              { userId: null, newValue: { path: ["actor", "tenantId"], equals: tenantId } },
            ],
          },
          {
            ...(action ? { action } : {}),
            ...(entity ? { entity } : {}),
            ...(userId ? { userId } : {}),
          },
        ],
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
    },
  );

  // GET /audit-logs/:id — audit-log:read (legacy: ADMIN only), single entry, tenant-scoped
  app.get(
    "/:id",
    { preHandler: requirePermission("audit-log:read:ZUGEWIESEN") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const tenantId = req.user.tenantId;

      const log = await app.prisma.auditLog.findFirst({
        where: {
          id,
          OR: [
            { user: { employee: { tenantId } } },
            { userId: null, newValue: { path: ["actor", "tenantId"], equals: tenantId } },
          ],
        },
        include: {
          user: { select: { email: true } },
        },
      });

      if (!log) {
        return reply.code(404).send({ error: "Audit-Eintrag nicht gefunden" });
      }

      return log;
    },
  );
}
