/**
 * Phase 67b Plan 01 (issue #67) — Unterbau's admin `EmployeeSalonAssignment` routes, registered
 * under the employees namespace (`prefix: "/api/v1/employees"`).
 *
 * Plan 01 registered the read path (`GET /:id/salon-assignments`). Plan 02 (D-05..D-21) adds the
 * write surface: create an Einsatzsalon (DEPLOYMENT), change the Stammsalon (HOME), end an
 * assignment — each lock-checked, audited in the same transaction as the write, and T-100-09-safe.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  employeeExistsInForeignTenant,
  findEmployeeInTenant,
  listSalonAssignments,
} from "../facade/salon-assignments";
import { createDeploymentAssignment } from "../facade/salon-assignment-changes";
import { salonExistsInForeignTenant } from "../facade/salons";
import { isCalendarDay, toAssignmentDto, WEEKDAY_ADVERB_DE } from "../salon-assignment-rules";
import { auditSalonAssignmentEvent } from "../salon-assignment-audit";
import { requireRole } from "../../../middleware/auth";

const idParamSchema = z.object({ id: z.string().uuid() });

const EMPLOYEE_NOT_FOUND = "Mitarbeiter nicht gefunden";
const SALON_NOT_FOUND = "Salon nicht gefunden";
const SALON_INACTIVE_MESSAGE =
  "Einem deaktivierten Salon kann keine neue Zuordnung zugewiesen werden.";
const BEFORE_HIRE_DATE_MESSAGE = "Die Zuordnung darf nicht vor dem Eintrittsdatum beginnen.";
const INVALID_PERIOD_MESSAGE = "Das Ende der Zuordnung darf nicht vor ihrem Beginn liegen.";
const SAME_SALON_OVERLAP_MESSAGE =
  "Der Mitarbeiter ist diesem Salon im gewählten Zeitraum bereits zugeordnet.";
const MONTH_LOCKED_MESSAGE =
  "Der Zeitraum betrifft einen abgeschlossenen Monat. Rückwirkende Zuordnungen sind dort nicht möglich.";

const calendarDaySchema = z
  .string()
  .refine(isCalendarDay, { message: "Datum im Format JJJJ-MM-TT erwartet." });

/**
 * D-08: `{ salonId, validFrom, validUntil?, weekdays? }` for a new Einsatzsalon (DEPLOYMENT).
 * `.strict()` rejects an unknown key (400) — the same convention `createSalonSchema` uses.
 */
const createDeploymentSchema = z
  .object({
    salonId: z.string().uuid(),
    validFrom: calendarDaySchema,
    validUntil: calendarDaySchema.nullable().optional(),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
  })
  .strict();

/**
 * D-19: the shared T-100-09 guard for every route below with an `:id` (employee) path parameter. A
 * foreign tenant's real employee and a nonexistent id both end up here and get the IDENTICAL
 * 404 — the only difference is whether a `CROSS_TENANT_ACCESS_DENIED` row is written first, and
 * that row's existence never reaches the client. Same shape as `rejectUnknownSalon`
 * (`api/salons.ts`).
 */
async function rejectUnknownEmployee(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  employeeId: string,
) {
  if (await employeeExistsInForeignTenant(app.prisma, req.user.tenantId, employeeId)) {
    await auditSalonAssignmentEvent(app, req, {
      entity: "Employee",
      action: "CROSS_TENANT_ACCESS_DENIED",
      entityId: employeeId,
    });
  }
  return reply.code(404).send({ error: EMPLOYEE_NOT_FOUND });
}

/**
 * D-13/D-19: the shared guard for a body-supplied `salonId` — reused, not duplicated, from
 * `facade/salons.ts` (Plan 01's read facade already exports both primitives). Always 400 (not 404
 * — a body field is different from a path parameter), byte-identical for a foreign tenant's real
 * salon and a nonexistent one; `CROSS_TENANT_ACCESS_DENIED` audited only when the foreign row
 * exists.
 */
async function rejectUnknownBodySalon(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  salonId: string,
) {
  if (await salonExistsInForeignTenant(app.prisma, req.user.tenantId, salonId)) {
    await auditSalonAssignmentEvent(app, req, {
      entity: "Salon",
      action: "CROSS_TENANT_ACCESS_DENIED",
      entityId: salonId,
    });
  }
  return reply.code(400).send({ error: SALON_NOT_FOUND });
}

export async function salonAssignmentRoutes(app: FastifyInstance) {
  // GET /api/v1/employees/:id/salon-assignments — full history (D-17, D-18, D-19)
  app.get("/:id/salon-assignments", {
    schema: {
      tags: ["Mitarbeiter"],
      summary: "List an employee's full salon assignment history (HOME + DEPLOYMENT)",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const tenantId = req.user.tenantId;

      const employee = await findEmployeeInTenant(app.prisma, tenantId, id);
      if (!employee) return rejectUnknownEmployee(app, req, reply, id);

      const rows = await listSalonAssignments(app.prisma, tenantId, id);
      return { assignments: rows.map(toAssignmentDto) };
    },
  });

  // POST /api/v1/employees/:id/salon-assignments — create an Einsatzsalon (DEPLOYMENT), D-08..D-13
  app.post("/:id/salon-assignments", {
    schema: {
      tags: ["Mitarbeiter"],
      summary: "Create an Einsatzsalon (DEPLOYMENT) assignment for an employee",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      // D-19: the body is validated BEFORE any lookup, so the register's `probe` minimalBody
      // reaches the employee guard rather than 400ing on both arms first.
      const body = createDeploymentSchema.parse(req.body);
      const tenantId = req.user.tenantId;

      const outcome = await app.prisma.$transaction(async (tx) => {
        const result = await createDeploymentAssignment(tx, tenantId, id, {
          salonId: body.salonId,
          validFrom: body.validFrom,
          validUntil: body.validUntil ?? null,
          weekdays: body.weekdays ?? [],
        });
        if (result.status === "OK_CREATED") {
          await auditSalonAssignmentEvent(app, req, {
            entity: "EmployeeSalonAssignment",
            action: "CREATE",
            entityId: result.created.id,
            newValue: toAssignmentDto(result.created),
            tx,
          });
        }
        return result;
      });

      switch (outcome.status) {
        case "OK_CREATED":
          return reply.code(201).send(toAssignmentDto(outcome.created));
        case "EMPLOYEE_NOT_FOUND":
          return rejectUnknownEmployee(app, req, reply, id);
        case "SALON_NOT_FOUND":
          return rejectUnknownBodySalon(app, req, reply, body.salonId);
        case "SALON_INACTIVE":
          return reply.code(400).send({ error: SALON_INACTIVE_MESSAGE });
        case "BEFORE_HIRE_DATE":
          return reply.code(400).send({ error: BEFORE_HIRE_DATE_MESSAGE });
        case "INVALID_PERIOD":
          return reply.code(400).send({ error: INVALID_PERIOD_MESSAGE });
        case "SAME_SALON_OVERLAP":
          return reply.code(409).send({ error: SAME_SALON_OVERLAP_MESSAGE });
        case "WEEKDAY_CONFLICT":
          return reply.code(409).send({
            error: `Der Mitarbeiter ist ${WEEKDAY_ADVERB_DE[outcome.weekday]} im gewählten Zeitraum bereits einem anderen Einsatzsalon zugeordnet.`,
          });
        case "MONTH_LOCKED":
          return reply.code(409).send({ error: MONTH_LOCKED_MESSAGE });
        default: {
          // Compile-time exhaustiveness: createDeploymentAssignment's return type has no other
          // status.
          const unreachable: never = outcome;
          return unreachable;
        }
      }
    },
  });
}
