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
import type { Prisma } from "@clokr/db";
import { requireRole } from "../../../middleware/auth";
import { accessContextFromRequest } from "../access-context";
import { auditSalonAssignmentEvent } from "../salon-assignment-audit";
import { toAssignmentDto } from "../salon-assignment-rules";
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
// Phase 71b (issue #71), D-12: a platform ROUTE file may import the time-tracking index (settings.ts,
// employees.ts, imports.ts already do); the facade module itself (facade/salons.ts) never does.
import { countEntriesForSalon } from "../../time-tracking";

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
 * D-12: names only COUNTS, never any entry or assignment — same convention as
 * {@link homeSalonInUseMessage}.
 */
function federalStateInUseMessage(): string {
  return "Das Bundesland dieses Salons kann nicht mehr geändert werden: Es gibt bereits Zeiteinträge oder Salonzuordnungen für diesen Salon. Ein Umzug ist ein neuer Salon.";
}

/**
 * D-14: names only the COUNT, never any employee — the message text itself is the AC's own
 * requirement, not a display string later compared against as a control value.
 */
function homeSalonInUseMessage(employeeCount: number): string {
  return `Der Salon ist für ${employeeCount} Mitarbeiter ab dem Deaktivierungsdatum Stammsalon und kann nicht deaktiviert werden.`;
}

/**
 * Every Salon audit row goes through here (Phase 64b review, WR-01). For a `clk_` API-key caller
 * `req.user.sub` is `apikey:<id>`, which is not a `User.id` — `AuditLog.userId` has a foreign key
 * to `User`, so passing it through would fail the audit insert: a 500 on every write, and on the
 * T-100-09 path a 500 for a foreign salon against a 404 for an unknown id (an oracle). The actor is
 * resolved by the Unterbau's central access context (`accessContextFromRequest`, #77) rather than by
 * parsing the subject here. Same storage convention as `services/clock/audit-actor.ts`'s
 * `emitClockAudit`: a non-user actor leaves `userId` unset and is recorded as
 * `newValue.actor = { type: "API_KEY", apiKeyId }`. The same fix for every other route that audits
 * `req.user.sub` is tracked in #333.
 */
async function auditSalon(
  app: FastifyInstance,
  req: FastifyRequest,
  entry: {
    action: string;
    entityId: string;
    oldValue?: unknown;
    newValue?: object;
    tx?: Prisma.TransactionClient;
  },
) {
  const { actor } = accessContextFromRequest(req);
  const apiKeyActor =
    actor.kind === "apiKey" ? { type: "API_KEY" as const, apiKeyId: actor.apiKeyId } : null;

  let newValue: object | undefined = entry.newValue;
  if (apiKeyActor) newValue = { ...(entry.newValue ?? {}), actor: apiKeyActor };

  await app.audit({
    userId: actor.kind === "user" ? actor.userId : undefined,
    action: entry.action,
    entity: "Salon",
    entityId: entry.entityId,
    oldValue: entry.oldValue,
    newValue,
    request: { ip: req.ip, headers: req.headers as Record<string, string> },
    tx: entry.tx,
  });
}

/**
 * D-13: the shared T-100-09 guard for every `/:id` route below. A foreign tenant's real salon and
 * a nonexistent id both end up here and get the IDENTICAL 404 — the only difference is whether a
 * `CROSS_TENANT_ACCESS_DENIED` row is written first, and that row's existence never reaches the
 * client (it only ever changes the audit log, never the response). The audit goes through
 * {@link auditSalon}, so an API-key caller gets the same 404 as a JWT caller (WR-01).
 */
async function rejectUnknownSalon(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  salonId: string,
) {
  if (await salonExistsInForeignTenant(app.prisma, req.user.tenantId, salonId)) {
    await auditSalon(app, req, { action: "CROSS_TENANT_ACCESS_DENIED", entityId: salonId });
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
        salons: await listSalons(app.prisma, req.user.tenantId, { includeInactive }),
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
        await auditSalon(app, req, {
          action: "CREATE",
          entityId: created.id,
          newValue: created,
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

      const outcome = await app.prisma.$transaction(async (tx) => {
        const result = await updateSalon(tx, req.user.tenantId, id, patch, (countDb) =>
          countEntriesForSalon(countDb, req.user.tenantId, id),
        );
        if (result.status === "OK") {
          await auditSalon(app, req, {
            action: "UPDATE",
            entityId: id,
            oldValue: result.existing,
            newValue: result.updated,
            tx,
          });
        }
        return result;
      });

      switch (outcome.status) {
        case "OK":
          return outcome.updated;
        case "NOT_FOUND":
          return rejectUnknownSalon(app, req, reply, id);
        case "FEDERAL_STATE_IN_USE":
          return reply.code(409).send({
            error: federalStateInUseMessage(),
            code: "FEDERAL_STATE_IN_USE",
            timeEntryCount: outcome.timeEntryCount,
            assignmentCount: outcome.assignmentCount,
          });
        default: {
          // Compile-time exhaustiveness: updateSalon's return type has no other status.
          const unreachable: never = outcome;
          return unreachable;
        }
      }
    },
  });

  // POST /api/v1/salons/:id/deactivate — D-06/D-07/D-08/D-14/D-15, audited, never deletes
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
          await auditSalon(app, req, {
            action: "DEACTIVATE",
            entityId: id,
            oldValue: change.existing,
            newValue: change.updated,
            tx,
          });
          // D-15/D-21: one END audit row per Einsatzsalon assignment the deactivation ended or
          // voided, next to the salon's own DEACTIVATE row above.
          for (const { before, after } of change.endedAssignments) {
            await auditSalonAssignmentEvent(app, req, {
              entity: "EmployeeSalonAssignment",
              action: "END",
              entityId: before.id,
              oldValue: toAssignmentDto(before),
              newValue: { ...toAssignmentDto(after), trigger: "SALON_DEACTIVATED" },
              tx,
            });
          }
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
        case "HOME_SALON_IN_USE":
          return reply.code(409).send({ error: homeSalonInUseMessage(outcome.employeeCount) });
        default: {
          // Compile-time exhaustiveness: deactivateSalon's return type has no other status.
          const unreachable: never = outcome;
          return unreachable;
        }
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
          await auditSalon(app, req, {
            action: "ACTIVATE",
            entityId: id,
            oldValue: change.existing,
            newValue: change.updated,
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
        default: {
          // Compile-time exhaustiveness: activateSalon's return type has no other status.
          const unreachable: never = outcome;
          return unreachable;
        }
      }
    },
  });
}
