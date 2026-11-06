/**
 * Issue #835 (D-835-01..08, D-835-13/14, D-835-22) — the leave planner (Urlaubsplaner) routes under
 * /api/v1/leave/plans. A plan is a non-binding yearly leave plan of one salon: employees enter
 * VACATION wishes, a holder of `leave-plan:manage` opens the plan and finally takes the wishes over
 * into real leave requests through the normal create core.
 *
 * Tracer routes (835-03): open a plan, read it, add an own wish, take it over. Admission follows
 * the #836 pattern: a salon is validated by `resolveSalonInReach` against the reach of the
 * endpoint's own permission, a plan is loaded with a SCOPED `findFirst({ id, tenantId })`, and every
 * rejection cause (foreign tenant, unknown id, outside the reach, unreadable) is the same frozen
 * 404 body, so no tenant-membership oracle exists (T-100-09).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../../middleware/auth";
import {
  accessContextFromRequest,
  hasPermission,
  requirePermission,
  resolveAccessReach,
  resolveSalonInReach,
  type AccessReach,
} from "../../platform";
import { limitExceptionSchema } from "../leave-limits";
import {
  LEAVE_PLAN_ALREADY_OPEN,
  LEAVE_PLAN_CLOSED,
  LEAVE_PLAN_MESSAGES,
  PLAN_NOT_FOUND_ERROR,
  canReadPlan,
  createWish,
  readPlanner,
  takeOverLeavePlan,
  toPlanDto,
  toPlannerWish,
  dayToDate,
} from "../leave-plan";

/** One body per rejection cause (T-100-09), byte-identical for every reason inside that cause. */
const SALON_NOT_FOUND = { error: "Salon nicht gefunden" } as const;
const PLAN_NOT_FOUND = { error: PLAN_NOT_FOUND_ERROR } as const;
const PERSON_NOT_FOUND = { error: "Mitarbeiter nicht gefunden" } as const;

const MANAGE_KEY = "leave-plan:manage:ZUGEWIESEN" as const;

const idParamSchema = z.object({ id: z.string().uuid() });

const dayString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum im Format JJJJ-MM-TT erwartet")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Ungültiges Datum");

const openBodySchema = z.object({
  salonId: z.string().uuid(),
  year: z.number().int().min(2000).max(2100),
  deadline: dayString.nullable().optional(),
});

const wishBodySchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    startDate: dayString,
    endDate: dayString,
    halfDay: z.boolean().default(false),
  })
  .refine((body) => body.startDate <= body.endDate, {
    message: "Das Enddatum darf nicht vor dem Startdatum liegen.",
    path: ["endDate"],
  });

const takeoverBodySchema = z.object({
  limitExceptions: z
    .array(z.object({ wishId: z.string().uuid() }).merge(limitExceptionSchema))
    .optional(),
});

function requestAudit(req: FastifyRequest) {
  return { ip: req.ip, headers: req.headers as Record<string, string> };
}

export async function leavePlanRoutes(app: FastifyInstance) {
  async function manageReach(req: FastifyRequest): Promise<AccessReach> {
    return resolveAccessReach(app.prisma, accessContextFromRequest(req), MANAGE_KEY);
  }

  async function readReach(req: FastifyRequest): Promise<AccessReach> {
    return resolveAccessReach(
      app.prisma,
      accessContextFromRequest(req),
      "leave-request:read:ZUGEWIESEN",
    );
  }

  async function approveReach(req: FastifyRequest): Promise<AccessReach> {
    return resolveAccessReach(
      app.prisma,
      accessContextFromRequest(req),
      "leave-request:approve:ZUGEWIESEN",
    );
  }

  /** The plan of this tenant by id, or null: foreign, unknown and removed are one cause. */
  async function loadPlan(req: FastifyRequest, id: string) {
    return app.prisma.leavePlan.findFirst({ where: { id, tenantId: req.user.tenantId } });
  }

  /** True iff the plan's salon is an active salon inside the caller's manage reach. */
  async function manageCovers(req: FastifyRequest, salonId: string): Promise<boolean> {
    const salon = await resolveSalonInReach(
      app.prisma,
      req.user.tenantId,
      await manageReach(req),
      salonId,
    );
    return salon.ok && salon.salonId !== null;
  }

  app.post("/", {
    schema: {
      tags: ["Abwesenheiten"],
      security: [{ bearerAuth: [] }],
      summary: "Open a leave plan for a salon and year",
      description:
        "Opens the non-binding yearly leave plan of one salon in the caller's leave-plan:manage reach. At most one open plan per salon and year.",
    },
    preHandler: requirePermission(MANAGE_KEY),
    handler: async (req, reply) => {
      const body = openBodySchema.parse(req.body);
      const tenantId = req.user.tenantId;
      const salon = await resolveSalonInReach(
        app.prisma,
        tenantId,
        await manageReach(req),
        body.salonId,
      );
      if (!salon.ok || salon.salonId === null) return reply.code(404).send(SALON_NOT_FOUND);
      const salonId = salon.salonId;

      const created = await app.prisma.$transaction(async (tx) => {
        // Serialises two openers of the same salon and year; the partial unique index of 835-04 is
        // the database backstop of the same rule.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`leave-plan:${tenantId}:${salonId}:${body.year}`}, 0))`;
        const open = await tx.leavePlan.findFirst({
          where: { tenantId, salonId, year: body.year, status: "OPEN" },
          select: { id: true },
        });
        if (open) return null;
        const row = await tx.leavePlan.create({
          data: {
            tenantId,
            salonId,
            year: body.year,
            deadline: body.deadline ? dayToDate(body.deadline) : null,
            openedByUserId: req.user.sub,
          },
        });
        await app.audit({
          userId: req.user.sub,
          action: "CREATE",
          entity: "LeavePlan",
          entityId: row.id,
          newValue: { salonId, year: body.year, deadline: body.deadline ?? null },
          request: requestAudit(req),
          tx,
        });
        return row;
      });
      if (!created) {
        return reply.code(409).send({
          error: LEAVE_PLAN_MESSAGES[LEAVE_PLAN_ALREADY_OPEN],
          code: LEAVE_PLAN_ALREADY_OPEN,
        });
      }
      return reply.code(201).send({ plan: toPlanDto(created) });
    },
  });

  app.get("/:id", {
    schema: {
      tags: ["Abwesenheiten"],
      security: [{ bearerAuth: [] }],
      summary: "Read a leave plan (the planner)",
      description:
        "Returns the planner of one plan: the persons with wishes inside the caller's admission. Readable with a leave-request:read reach over the salon or as a person homed in it.",
    },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const tenantId = req.user.tenantId;
      const plan = await loadPlan(req, id);
      if (!plan) return reply.code(404).send(PLAN_NOT_FOUND);

      const reachToRead = await readReach(req);
      const selfEmployeeId = req.user.employeeId ?? null;
      const admitted = await canReadPlan(app.prisma, {
        tenantId,
        readReach: reachToRead,
        selfEmployeeId,
        salonId: plan.salonId,
        year: plan.year,
      });
      if (!admitted) return reply.code(404).send(PLAN_NOT_FOUND);

      const reachToManage = await manageReach(req);
      const reachToApprove = await approveReach(req);
      const holdsRead = await resolveSalonInReach(app.prisma, tenantId, reachToRead, plan.salonId);
      const canManage = await manageCovers(req, plan.salonId);
      const dto = await readPlanner(app, {
        tenantId,
        plan,
        viewer: {
          userId: req.user.sub,
          employeeId: selfEmployeeId,
          canManage,
          canSeeAllTypes: holdsRead.ok,
          canCreateOwn: await hasPermission(req, "leave-request:create:EIGENE"),
          entitlementReach: reachToRead,
          manageReach: reachToManage,
          approveReach: reachToApprove,
        },
        now: new Date(),
      });
      return reply.send(dto);
    },
  });

  app.post("/:id/wishes", {
    schema: {
      tags: ["Abwesenheiten"],
      security: [{ bearerAuth: [] }],
      summary: "Add a vacation wish to a leave plan",
      description:
        "Adds an own VACATION wish (leave-request:create:EIGENE) to an open plan the caller may read. The wish counts nowhere until the takeover turns it into a request.",
    },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const body = wishBodySchema.parse(req.body);
      const tenantId = req.user.tenantId;
      const plan = await loadPlan(req, id);
      if (!plan) return reply.code(404).send(PLAN_NOT_FOUND);

      const selfEmployeeId = req.user.employeeId ?? null;
      const admitted = await canReadPlan(app.prisma, {
        tenantId,
        readReach: await readReach(req),
        selfEmployeeId,
        salonId: plan.salonId,
        year: plan.year,
      });
      if (!admitted) return reply.code(404).send(PLAN_NOT_FOUND);

      // Tracer: only the caller's own person. A wish for someone else is the manager path (835-05).
      if (body.employeeId !== undefined && body.employeeId !== selfEmployeeId) {
        return reply.code(404).send(PERSON_NOT_FOUND);
      }
      if (!(await hasPermission(req, "leave-request:create:EIGENE"))) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (selfEmployeeId === null) {
        return reply.code(400).send({ error: "Für dein Konto ist kein Mitarbeiter hinterlegt." });
      }

      const outcome = await createWish(app, {
        tenantId,
        planId: plan.id,
        employeeId: selfEmployeeId,
        actorUserId: req.user.sub,
        startDay: body.startDate,
        endDay: body.endDate,
        halfDay: body.halfDay,
        request: requestAudit(req),
      });
      if (!outcome.ok) return reply.code(outcome.statusCode).send(outcome.body);
      return reply.code(201).send({ wish: toPlannerWish(outcome.wish, { planStatus: "OPEN" }) });
    },
  });

  app.post("/:id/takeover", {
    schema: {
      tags: ["Abwesenheiten"],
      security: [{ bearerAuth: [] }],
      summary: "Take the wishes of a leave plan over into leave requests",
      description:
        "Creates a leave request for every active wish through the normal create core, approves the ones the caller may approve and leaves the caller's own wishes PENDING for a second approver.",
    },
    preHandler: requirePermission(MANAGE_KEY),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const body = takeoverBodySchema.parse(req.body ?? {});
      const tenantId = req.user.tenantId;
      const plan = await loadPlan(req, id);
      if (!plan || !(await manageCovers(req, plan.salonId))) {
        return reply.code(404).send(PLAN_NOT_FOUND);
      }
      if (plan.status !== "OPEN") {
        return reply
          .code(409)
          .send({ error: LEAVE_PLAN_MESSAGES[LEAVE_PLAN_CLOSED], code: LEAVE_PLAN_CLOSED });
      }

      const limitExceptions = new Map(
        (body.limitExceptions ?? []).map((entry) => [entry.wishId, entry.reason] as const),
      );
      const result = await takeOverLeavePlan(app, {
        tenantId,
        planId: plan.id,
        taker: {
          userId: req.user.sub,
          employeeId: req.user.employeeId ?? null,
          approveReach: await approveReach(req),
        },
        limitExceptions,
        request: requestAudit(req),
      });
      return reply.send(result);
    },
  });
}
