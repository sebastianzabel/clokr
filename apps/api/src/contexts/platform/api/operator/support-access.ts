/**
 * Operator support access — the grant lifecycle (Issue #93, D-01, D-02, D-03, D-18).
 *
 *   POST /                  request a time-boxed, read-only support access to one tenant
 *   GET  /                  this operator's grants for the tenant (active and history)
 *   POST /:accessId/end     end this operator's active grant early
 *
 * Mounted at `/api/v1/operator/tenants/:id/support-access`; `:id` is the tenant. The reads that the grant
 * opens live in the sibling plugin `support.ts` under their own prefix (D-18), so the grant lifecycle and
 * the data reads can never share a handler. Every route is guarded by `requireOperator`; a tenant token is
 * refused with 403 and an audit row.
 *
 * The reason (10 to 500 characters, trimmed) and the duration (one of 1, 4, 8, 24 hours, default 1) are
 * the only inputs; the server computes the end and never accepts a free end time. A second request while
 * a grant is running is refused: there is no extension, a new request needs a new reason. Whether a grant
 * is active is decided only by `support-access.ts` of this context. History and early end resolve a grant
 * by tenant AND operator in one lookup, so another operator's grant id is indistinguishable from an
 * unknown one. Request parameters and bodies are parsed inside the handler, after the guard.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../../../config";
import { requireOperator } from "../../operator-auth";
import {
  SUPPORT_ACCESS_DURATION_HOURS,
  SUPPORT_ACCESS_DEFAULT_HOURS,
  SUPPORT_ACCESS_REASON_MAX,
  SUPPORT_ACCESS_REASON_MIN,
  createSupportAccess,
  endSupportAccessByOperator,
  listSupportAccessesForOperator,
  toSupportAccessDto,
} from "../../support-access";

const mutationRateLimit = {
  rateLimit: { max: config.NODE_ENV === "test" ? 1000 : 20, timeWindow: "1 minute" },
};

const readRateLimit = {
  rateLimit: { max: config.NODE_ENV === "test" ? 1000 : 60, timeWindow: "1 minute" },
};

const tenantParamSchema = z.object({ id: z.string().uuid() });
const endParamSchema = z.object({ id: z.string().uuid(), accessId: z.string().uuid() });

const requestGrantSchema = z
  .object({
    reason: z.string().trim().min(SUPPORT_ACCESS_REASON_MIN).max(SUPPORT_ACCESS_REASON_MAX),
    durationHours: z
      .literal([...SUPPORT_ACCESS_DURATION_HOURS])
      .default(SUPPORT_ACCESS_DEFAULT_HOURS),
  })
  .strict();

const TENANT_NOT_FOUND = { error: "Mandant nicht gefunden" };
const ACCESS_NOT_FOUND = { error: "Support-Zugriff nicht gefunden" };

export async function operatorSupportAccessRoutes(app: FastifyInstance) {
  // POST /api/v1/operator/tenants/:id/support-access
  app.post("/", {
    config: mutationRateLimit,
    schema: {
      tags: ["Betreiber"],
      description:
        "Requests a time-boxed, read-only support access to one tenant (reason and duration required).",
    },
    preHandler: requireOperator,
    handler: async (req, reply) => {
      const { id: tenantId } = tenantParamSchema.parse(req.params);
      const body = requestGrantSchema.parse(req.body);

      const now = new Date();
      const result = await createSupportAccess(
        app,
        {
          tenantId,
          operatorId: req.operator.sub,
          reason: body.reason,
          durationHours: body.durationHours,
          request: req,
        },
        now,
      );

      switch (result.status) {
        case "NOT_FOUND":
          return reply.code(404).send(TENANT_NOT_FOUND);
        case "TENANT_DEACTIVATED":
          return reply.code(409).send({
            error: "Der Mandant ist deaktiviert. Ein Support-Zugriff ist nicht möglich.",
            code: "TENANT_DEACTIVATED",
          });
        case "ALREADY_ACTIVE":
          return reply.code(409).send({
            error:
              "Für diesen Mandanten besteht bereits ein aktiver Support-Zugriff. Eine Verlängerung ist nicht möglich; nach dem Ende ist ein neuer Antrag mit Grund nötig.",
            code: "SUPPORT_ACCESS_ALREADY_ACTIVE",
          });
        case "CREATED":
          return reply.code(201).send({ access: toSupportAccessDto(result.row, now) });
      }
    },
  });

  // GET /api/v1/operator/tenants/:id/support-access
  app.get("/", {
    config: readRateLimit,
    schema: {
      tags: ["Betreiber"],
      description:
        "The calling operator's support accesses for one tenant: the active one and the history.",
    },
    preHandler: requireOperator,
    handler: async (req, reply) => {
      const { id: tenantId } = tenantParamSchema.parse(req.params);
      const tenant = await app.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true },
      });
      if (!tenant) return reply.code(404).send(TENANT_NOT_FOUND);
      return listSupportAccessesForOperator(app.prisma, {
        tenantId,
        operatorId: req.operator.sub,
      });
    },
  });

  // POST /api/v1/operator/tenants/:id/support-access/:accessId/end
  app.post("/:accessId/end", {
    config: mutationRateLimit,
    schema: {
      tags: ["Betreiber"],
      description: "Ends the calling operator's active support access early.",
    },
    preHandler: requireOperator,
    handler: async (req, reply) => {
      const { id: tenantId, accessId } = endParamSchema.parse(req.params);
      const result = await endSupportAccessByOperator(app, {
        tenantId,
        operatorId: req.operator.sub,
        accessId,
        request: req,
      });
      switch (result.status) {
        case "NOT_FOUND":
          return reply.code(404).send(ACCESS_NOT_FOUND);
        case "NOT_ACTIVE":
          return reply.code(409).send({
            error: "Der Support-Zugriff ist nicht mehr aktiv.",
            code: "SUPPORT_ACCESS_NOT_ACTIVE",
          });
        case "ENDED":
          return reply.code(200).send({ access: result.access });
      }
    },
  });
}
