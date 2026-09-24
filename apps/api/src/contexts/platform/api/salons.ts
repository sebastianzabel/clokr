/**
 * Phase 64b Plan 01 (issue #64) — Unterbau's admin `Salon` routes, prefix `/api/v1/salons`.
 *
 * Plan 01 registered the read path (`GET /`). Plan 02 (issue #64, AC-1/AC-2/AC-4/AC-5/AC-6) adds
 * the full lifecycle: read by id, create, update, deactivate, re-activate — each write audited in
 * the SAME `$transaction` as the mutation (D-12), and every `/:id` route answering a foreign
 * tenant's real salon byte-identically to a nonexistent id (D-13, T-100-09) via the shared
 * {@link rejectUnknownSalon} helper. See `contexts/platform/facade/salons.ts` for the tenant-
 * scoped functions these routes call into.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireRole } from "../../../middleware/auth";
import {
  activateSalon,
  createSalon,
  createSalonSchema,
  deactivateSalon,
  findSalon,
  isMultiSalonTenant,
  listSalons,
  salonExistsInForeignTenant,
  updateSalon,
  updateSalonSchema,
} from "../facade/salons";

const listQuerySchema = z.object({
  includeInactive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

const idParamSchema = z.object({ id: z.string().uuid() });

const SALON_NOT_FOUND = "Salon nicht gefunden";
const NO_CHANGES = "Keine Änderungen angegeben.";
const ALREADY_INACTIVE_MESSAGE = "Der Salon ist bereits deaktiviert.";
const ALREADY_ACTIVE_MESSAGE = "Der Salon ist bereits aktiv.";
const LAST_ACTIVE_SALON_MESSAGE =
  "Der letzte aktive Salon eines Mandanten kann nicht deaktiviert werden.";

/**
 * D-13: the shared T-100-09 guard for every `/:id` route below. A foreign tenant's real salon and
 * a nonexistent id both end up here and get the IDENTICAL 404 — the only difference is whether a
 * `CROSS_TENANT_ACCESS_DENIED` row is written first, and that row's existence never reaches the
 * client (it only ever changes the audit log, never the response).
 */
async function rejectUnknownSalon(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  salonId: string,
) {
  if (await salonExistsInForeignTenant(app.prisma, req.user.tenantId, salonId)) {
    await app.audit({
      userId: req.user.sub,
      action: "CROSS_TENANT_ACCESS_DENIED",
      entity: "Salon",
      entityId: salonId,
      request: { ip: req.ip, headers: req.headers as Record<string, string> },
    });
  }
  return reply.code(404).send({ error: SALON_NOT_FOUND });
}

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

  // GET /api/v1/salons/:id — read a single salon (D-13: T-100-09-safe by construction)
  app.get("/:id", {
    schema: {
      tags: ["Salons"],
      summary: "Get a single salon by id",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const salon = await findSalon(app.prisma, req.user.tenantId, id);
      if (!salon) return rejectUnknownSalon(app, req, reply, id);
      return salon;
    },
  });

  // POST /api/v1/salons — create a salon (active or inactive), audited (D-12)
  app.post("/", {
    schema: {
      tags: ["Salons"],
      summary: "Create a salon",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const body = createSalonSchema.parse(req.body);

      const salon = await app.prisma.$transaction(async (tx) => {
        const created = await createSalon(tx, req.user.tenantId, body);
        await app.audit({
          userId: req.user.sub,
          action: "CREATE",
          entity: "Salon",
          entityId: created.id,
          newValue: created,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
          tx,
        });
        return created;
      });

      return reply.code(201).send(salon);
    },
  });

  // PATCH /api/v1/salons/:id — update master data, audited (D-12), T-100-09-safe (D-13)
  app.patch("/:id", {
    schema: {
      tags: ["Salons"],
      summary: "Update a salon's master data",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      // D-07/D-13: validated BEFORE the lookup, so the register's `probe` minimalBody for this
      // route reaches the tenant guard instead of 400ing on both arms first.
      const patch = updateSalonSchema.parse(req.body);

      if (Object.keys(patch).length === 0) {
        const existing = await findSalon(app.prisma, req.user.tenantId, id);
        if (!existing) return rejectUnknownSalon(app, req, reply, id);
        return reply.code(400).send({ error: NO_CHANGES });
      }

      const result = await app.prisma.$transaction(async (tx) => {
        const outcome = await updateSalon(tx, req.user.tenantId, id, patch);
        if (!outcome) return null;
        await app.audit({
          userId: req.user.sub,
          action: "UPDATE",
          entity: "Salon",
          entityId: id,
          oldValue: outcome.existing,
          newValue: outcome.updated,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
          tx,
        });
        return outcome.updated;
      });

      if (!result) return rejectUnknownSalon(app, req, reply, id);
      return result;
    },
  });

  // POST /api/v1/salons/:id/deactivate — D-06/D-07/D-08, audited, never deletes
  app.post("/:id/deactivate", {
    schema: {
      tags: ["Salons"],
      summary: "Deactivate a salon",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);

      const outcome = await app.prisma.$transaction(async (tx) => {
        const change = await deactivateSalon(tx, req.user.tenantId, id);
        if (change.status === "OK") {
          await app.audit({
            userId: req.user.sub,
            action: "DEACTIVATE",
            entity: "Salon",
            entityId: id,
            oldValue: change.existing,
            newValue: change.updated,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
            tx,
          });
        }
        return change;
      });

      switch (outcome.status) {
        case "OK":
          return outcome.updated;
        case "NOT_FOUND":
          return rejectUnknownSalon(app, req, reply, id);
        case "ALREADY_INACTIVE":
          return reply.code(409).send({ error: ALREADY_INACTIVE_MESSAGE });
        case "LAST_ACTIVE_SALON":
          return reply.code(409).send({ error: LAST_ACTIVE_SALON_MESSAGE });
        default:
          // ALREADY_ACTIVE cannot occur on the deactivate path — exhaustiveness guard only.
          return reply.code(409).send({ error: "Unerwarteter Zustand." });
      }
    },
  });

  // POST /api/v1/salons/:id/activate — D-07, audited, mirror of deactivate
  app.post("/:id/activate", {
    schema: {
      tags: ["Salons"],
      summary: "Re-activate an inactive salon",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);

      const outcome = await app.prisma.$transaction(async (tx) => {
        const change = await activateSalon(tx, req.user.tenantId, id);
        if (change.status === "OK") {
          await app.audit({
            userId: req.user.sub,
            action: "ACTIVATE",
            entity: "Salon",
            entityId: id,
            oldValue: change.existing,
            newValue: change.updated,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
            tx,
          });
        }
        return change;
      });

      switch (outcome.status) {
        case "OK":
          return outcome.updated;
        case "NOT_FOUND":
          return rejectUnknownSalon(app, req, reply, id);
        case "ALREADY_ACTIVE":
          return reply.code(409).send({ error: ALREADY_ACTIVE_MESSAGE });
        default:
          // ALREADY_INACTIVE/LAST_ACTIVE_SALON cannot occur on the activate path.
          return reply.code(409).send({ error: "Unerwarteter Zustand." });
      }
    },
  });
}
