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
  salonAssignmentExistsInForeignTenant,
} from "../facade/salon-assignments";
import {
  changeHomeSalon,
  createDeploymentAssignment,
  endSalonAssignment,
} from "../facade/salon-assignment-changes";
import { salonExistsInForeignTenant } from "../facade/salons";
import { isCalendarDay, toAssignmentDto, WEEKDAY_ADVERB_DE } from "../salon-assignment-rules";
import { auditSalonAssignmentEvent } from "../salon-assignment-audit";
import { requirePermission } from "../request-permissions";
import { accessContextFromRequest } from "../access-context"; // Phase 91b Plan 10 (#91), D-10/D-12/D-14
import { resolveAccessReach } from "../facade/role-assignments"; // Phase 91b Plan 10 (#91), D-10/D-12/D-14
import { isPersonMasterDataInScope, isStammsalonScopeMatch } from "../scope-filter"; // Phase 91b Plan 10 (#91), D-10/D-12/D-14
import type { PermissionKey } from "../permission-catalog";

const idParamSchema = z.object({ id: z.string().uuid() });
const assignmentIdParamSchema = z.object({
  id: z.string().uuid(),
  assignmentId: z.string().uuid(),
});

const EMPLOYEE_NOT_FOUND = "Mitarbeiter nicht gefunden";
const SALON_NOT_FOUND = "Salon nicht gefunden";
const ASSIGNMENT_NOT_FOUND = "Zuordnung nicht gefunden";
const SALON_INACTIVE_MESSAGE =
  "Einem deaktivierten Salon kann keine neue Zuordnung zugewiesen werden.";
const BEFORE_HIRE_DATE_MESSAGE = "Die Zuordnung darf nicht vor dem Eintrittsdatum beginnen.";
const INVALID_PERIOD_MESSAGE = "Das Ende der Zuordnung darf nicht vor ihrem Beginn liegen.";
const SAME_SALON_OVERLAP_MESSAGE =
  "Der Mitarbeiter ist diesem Salon im gewählten Zeitraum bereits zugeordnet.";
const MONTH_LOCKED_MESSAGE =
  "Der Zeitraum betrifft einen abgeschlossenen Monat. Rückwirkende Zuordnungen sind dort nicht möglich.";
const HOME_OVERLAP_MESSAGE =
  "Der Stammsalon-Wechsel überschneidet sich mit einer bestehenden Stammsalon-Zuordnung.";
const ALREADY_HOME_MESSAGE = "Der Salon ist ab diesem Datum bereits Stammsalon.";
const FIRST_HOME_NOT_AT_HIRE_DATE_MESSAGE =
  "Die erste Stammsalon-Zuordnung muss am Eintrittsdatum beginnen.";
const HOME_NEEDS_SUCCESSOR_MESSAGE =
  "Ein Stammsalon kann nur durch einen neuen Stammsalon beendet werden.";
const END_BEFORE_START_MESSAGE = "Eine Zuordnung kann frühestens am Tag vor ihrem Beginn enden.";
const ONLY_SHORTEN_MESSAGE = "Eine Zuordnung kann nur verkürzt, nicht verlängert werden.";

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
 * D-05: `{ salonId, validFrom }` for a Stammsalon (HOME) change. `.strict()` rejects `validUntil`
 * or `weekdays` (400) — a Stammsalon ends only by a successor, never by its own body.
 */
const changeHomeSalonSchema = z
  .object({
    salonId: z.string().uuid(),
    validFrom: calendarDaySchema,
  })
  .strict();

/** D-11: `{ validUntil }` for ending an assignment. */
const endAssignmentSchema = z.object({ validUntil: calendarDaySchema }).strict();

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

/**
 * D-19: the shared T-100-09 guard for `:assignmentId` (the `end` route). A row belonging to
 * another employee, a foreign tenant's real row, and a nonexistent id are ALL indistinguishable
 * from "not found" by construction — `endSalonAssignment`'s own lookup already scopes by
 * `{ id, tenantId, employeeId }` — so this helper's byte-identical 404 covers all three at once.
 * `CROSS_TENANT_ACCESS_DENIED` is audited only when the row exists in ANOTHER tenant (an
 * other-employee, same-tenant row never triggers it — that is not a tenant boundary crossing).
 */
async function rejectUnknownAssignment(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  assignmentId: string,
) {
  if (await salonAssignmentExistsInForeignTenant(app.prisma, req.user.tenantId, assignmentId)) {
    await auditSalonAssignmentEvent(app, req, {
      entity: "EmployeeSalonAssignment",
      action: "CROSS_TENANT_ACCESS_DENIED",
      entityId: assignmentId,
    });
  }
  return reply.code(404).send({ error: ASSIGNMENT_NOT_FOUND });
}

/**
 * Phase 91b Plan 10 (Issue #91), D-12/D-14: person-master-data scope for the READ route
 * (Stammsalon-OR-active-deployment, same rule as `employees.ts` GET /:id — salon-history is basic
 * identity data, visible to a temporarily-deployed employee's current salon manager too).
 */
async function rejectOutOfScopePersonRead(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  employeeId: string,
  permission: PermissionKey,
): Promise<boolean> {
  const access = accessContextFromRequest(req);
  const scopeReach = await resolveAccessReach(app.prisma, access, permission);
  if (await isPersonMasterDataInScope(app.prisma, req.user.tenantId, scopeReach, employeeId)) {
    return true;
  }
  await auditSalonAssignmentEvent(app, req, {
    entity: "Employee",
    action: "SCOPE_ACCESS_DENIED",
    entityId: employeeId,
  });
  reply.code(404).send({ error: EMPLOYEE_NOT_FOUND });
  return false;
}

/**
 * Phase 91b Plan 10 (Issue #91), D-10/D-14: Stammsalon-only scope for the WRITE routes below
 * (create/change/end a salon assignment) — an administrative change to an employee's salon
 * structure stays a HOME-salon manager's decision, same distinction `employees.ts`'s
 * `enforcePersonAdminScope` draws for account-lifecycle actions. Stichtag = today.
 */
async function rejectOutOfScopePersonWrite(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  employeeId: string,
  permission: PermissionKey,
): Promise<boolean> {
  const access = accessContextFromRequest(req);
  const scopeReach = await resolveAccessReach(app.prisma, access, permission);
  if (
    await isStammsalonScopeMatch(app.prisma, req.user.tenantId, scopeReach, employeeId, new Date())
  ) {
    return true;
  }
  await auditSalonAssignmentEvent(app, req, {
    entity: "Employee",
    action: "SCOPE_ACCESS_DENIED",
    entityId: employeeId,
  });
  reply.code(404).send({ error: EMPLOYEE_NOT_FOUND });
  return false;
}

// Rows are never deleted (D-03/D-11/AC-Aenderung-1) — this file registers no DELETE handler for
// any assignment; the only permitted change to an existing row is `validUntil`, via `end` below.

export async function salonAssignmentRoutes(app: FastifyInstance) {
  // GET /api/v1/employees/:id/salon-assignments — full history (D-17, D-18, D-19)
  app.get("/:id/salon-assignments", {
    schema: {
      tags: ["Mitarbeiter"],
      summary: "List an employee's full salon assignment history (HOME + DEPLOYMENT)",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requirePermission("employee:read:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const tenantId = req.user.tenantId;

      const employee = await findEmployeeInTenant(app.prisma, tenantId, id);
      if (!employee) return rejectUnknownEmployee(app, req, reply, id);
      if (!(await rejectOutOfScopePersonRead(app, req, reply, id, "employee:read:ZUGEWIESEN"))) {
        return;
      }

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
    preHandler: requirePermission("employee:update:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      // D-19: the body is validated BEFORE any lookup, so the register's `probe` minimalBody
      // reaches the employee guard rather than 400ing on both arms first.
      const body = createDeploymentSchema.parse(req.body);
      const tenantId = req.user.tenantId;

      // Phase 91b Plan 10 (Issue #91), D-10/D-14: Stammsalon-only — a pre-check ahead of the
      // transaction, since createDeploymentAssignment's own EMPLOYEE_NOT_FOUND branch runs INSIDE
      // it and has no scope concept of its own; an unscoped caller never reaches the write.
      const existingForScope = await findEmployeeInTenant(app.prisma, tenantId, id);
      if (existingForScope) {
        if (
          !(await rejectOutOfScopePersonWrite(app, req, reply, id, "employee:update:ZUGEWIESEN"))
        ) {
          return;
        }
      }

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

  // POST /api/v1/employees/:id/salon-assignments/home — change the Stammsalon (HOME), D-05/D-06
  app.post("/:id/salon-assignments/home", {
    schema: {
      tags: ["Mitarbeiter"],
      summary: "Change an employee's Stammsalon (HOME) as of a given date",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requirePermission("employee:update:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      // D-19: validated BEFORE any lookup, same ordering as the DEPLOYMENT create route.
      const body = changeHomeSalonSchema.parse(req.body);
      const tenantId = req.user.tenantId;

      // Phase 91b Plan 10 (Issue #91), D-10/D-14: same pre-check as the DEPLOYMENT create route
      // above — changeHomeSalon's own EMPLOYEE_NOT_FOUND branch runs inside the transaction.
      const existingForScope = await findEmployeeInTenant(app.prisma, tenantId, id);
      if (existingForScope) {
        if (
          !(await rejectOutOfScopePersonWrite(app, req, reply, id, "employee:update:ZUGEWIESEN"))
        ) {
          return;
        }
      }

      const outcome = await app.prisma.$transaction(async (tx) => {
        const result = await changeHomeSalon(tx, tenantId, id, {
          salonId: body.salonId,
          validFrom: body.validFrom,
        });
        if (result.status === "OK_HOME_CHANGED") {
          if (result.ended) {
            await auditSalonAssignmentEvent(app, req, {
              entity: "EmployeeSalonAssignment",
              action: "END",
              entityId: result.ended.after.id,
              oldValue: toAssignmentDto(result.ended.before),
              newValue: toAssignmentDto(result.ended.after),
              tx,
            });
          }
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
        case "OK_HOME_CHANGED":
          return reply.code(201).send({
            ended: outcome.ended ? toAssignmentDto(outcome.ended.after) : null,
            created: toAssignmentDto(outcome.created),
          });
        case "EMPLOYEE_NOT_FOUND":
          return rejectUnknownEmployee(app, req, reply, id);
        case "SALON_NOT_FOUND":
          return rejectUnknownBodySalon(app, req, reply, body.salonId);
        case "SALON_INACTIVE":
          return reply.code(400).send({ error: SALON_INACTIVE_MESSAGE });
        case "BEFORE_HIRE_DATE":
          return reply.code(400).send({ error: BEFORE_HIRE_DATE_MESSAGE });
        case "HOME_OVERLAP":
          return reply.code(409).send({ error: HOME_OVERLAP_MESSAGE });
        case "ALREADY_HOME":
          return reply.code(409).send({ error: ALREADY_HOME_MESSAGE });
        case "FIRST_HOME_NOT_AT_HIRE_DATE":
          return reply.code(400).send({ error: FIRST_HOME_NOT_AT_HIRE_DATE_MESSAGE });
        case "SAME_SALON_OVERLAP":
          return reply.code(409).send({ error: SAME_SALON_OVERLAP_MESSAGE });
        case "MONTH_LOCKED":
          return reply.code(409).send({ error: MONTH_LOCKED_MESSAGE });
        default: {
          // Compile-time exhaustiveness: changeHomeSalon's return type has no other status.
          const unreachable: never = outcome;
          return unreachable;
        }
      }
    },
  });

  // POST /api/v1/employees/:id/salon-assignments/:assignmentId/end — end an assignment, D-06/D-11
  app.post("/:id/salon-assignments/:assignmentId/end", {
    schema: {
      tags: ["Mitarbeiter"],
      summary: "End (shorten) an existing salon assignment",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requirePermission("employee:update:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id, assignmentId } = assignmentIdParamSchema.parse(req.params);
      const body = endAssignmentSchema.parse(req.body);
      const tenantId = req.user.tenantId;

      // Phase 91b Plan 10 (Issue #91), D-10/D-14: same pre-check as the other two write routes
      // above — endSalonAssignment's own not-found branch runs inside the transaction.
      const existingForScope = await findEmployeeInTenant(app.prisma, tenantId, id);
      if (existingForScope) {
        if (
          !(await rejectOutOfScopePersonWrite(app, req, reply, id, "employee:update:ZUGEWIESEN"))
        ) {
          return;
        }
      }

      const outcome = await app.prisma.$transaction(async (tx) => {
        const result = await endSalonAssignment(tx, tenantId, id, assignmentId, body.validUntil);
        if (result.status === "OK_ENDED") {
          await auditSalonAssignmentEvent(app, req, {
            entity: "EmployeeSalonAssignment",
            action: "END",
            entityId: result.after.id,
            oldValue: toAssignmentDto(result.before),
            newValue: toAssignmentDto(result.after),
            tx,
          });
        }
        return result;
      });

      switch (outcome.status) {
        case "OK_ENDED":
          return reply.code(200).send(toAssignmentDto(outcome.after));
        case "EMPLOYEE_NOT_FOUND":
          return rejectUnknownEmployee(app, req, reply, id);
        case "ASSIGNMENT_NOT_FOUND":
          return rejectUnknownAssignment(app, req, reply, assignmentId);
        case "HOME_NEEDS_SUCCESSOR":
          return reply.code(409).send({ error: HOME_NEEDS_SUCCESSOR_MESSAGE });
        case "END_BEFORE_START":
          return reply.code(400).send({ error: END_BEFORE_START_MESSAGE });
        case "ONLY_SHORTEN":
          return reply.code(409).send({ error: ONLY_SHORTEN_MESSAGE });
        case "MONTH_LOCKED":
          return reply.code(409).send({ error: MONTH_LOCKED_MESSAGE });
        default: {
          // Compile-time exhaustiveness: endSalonAssignment's return type has no other status.
          const unreachable: never = outcome;
          return unreachable;
        }
      }
    },
  });
}
