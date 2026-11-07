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
  findSalon,
  hasPermission,
  requirePermission,
  resolveAccessReach,
  resolveSalonInReach,
  type AccessReach,
} from "../../platform";
import { formatDateDe } from "../leave-decision";
import { limitExceptionSchema } from "../leave-limits";
import {
  LEAVE_PLAN_ALREADY_OPEN,
  LEAVE_PLAN_CLOSED,
  LEAVE_PLAN_MESSAGES,
  PLAN_NOT_FOUND_ERROR,
  WISH_NOT_FOUND_ERROR,
  canReadPlan,
  createWish,
  manageCoversPersonOnDays,
  planPopulation,
  readablePlanYears,
  readPlanner,
  removeWish,
  takeOverLeavePlan,
  toPlanDto,
  toPlannerWish,
  updateWish,
  dayToDate,
  dayOf,
  type WishActor,
} from "../leave-plan";
import { isOpenPlanUniqueViolation } from "../leave-plan/db-refusals";

/** One body per rejection cause (T-100-09), byte-identical for every reason inside that cause. */
const SALON_NOT_FOUND = { error: "Salon nicht gefunden" } as const;
const PLAN_NOT_FOUND = { error: PLAN_NOT_FOUND_ERROR } as const;
const PERSON_NOT_FOUND = { error: "Mitarbeiter nicht gefunden" } as const;
const WISH_NOT_FOUND = { error: WISH_NOT_FOUND_ERROR } as const;

const MANAGE_KEY = "leave-plan:manage:ZUGEWIESEN" as const;

const idParamSchema = z.object({ id: z.string().uuid() });
const wishParamSchema = z.object({ id: z.string().uuid(), wishId: z.string().uuid() });

const dayString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum im Format JJJJ-MM-TT erwartet")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Ungültiges Datum");

const listQuerySchema = z.object({
  salonId: z.string().uuid(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

const deadlineBodySchema = z.object({ deadline: dayString.nullable() });

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

const wishPatchBodySchema = z
  .object({
    startDate: dayString.optional(),
    endDate: dayString.optional(),
    halfDay: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.startDate !== undefined || body.endDate !== undefined || body.halfDay !== undefined,
    { message: "Mindestens eine Angabe ist erforderlich.", path: ["startDate"] },
  );

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

  /**
   * Issue #835 (D-835-18, D-835-32) — tells every person of the plan population (Stammsalon in the
   * year, employed in the year, never anonymised, with a user account; never the opener) that the
   * planning is open. Reactive: it runs after the open transaction committed and a failure is
   * logged, never raised — the plan exists either way. The recipients come from the server-side
   * population only, never from the request (T-835-23). Texts: the in-app message names salon,
   * year and deadline (own data); mail and push use the neutral registry entries.
   */
  async function notifyPlanOpened(
    req: FastifyRequest,
    plan: { id: string; salonId: string; year: number; deadline: Date | null },
  ): Promise<void> {
    const tenantId = req.user.tenantId;
    try {
      const salon = await findSalon(app.prisma, tenantId, plan.salonId);
      const { persons } = await planPopulation(app.prisma, tenantId, plan.salonId, plan.year);
      const link = `/leave/planung?salonId=${plan.salonId}&year=${plan.year}`;
      const frist = plan.deadline ? ` Frist: ${formatDateDe(plan.deadline)}.` : "";
      const message = `Die Urlaubsplanung ${plan.year} für ${salon?.name ?? "deinen Salon"} ist eröffnet. Trag deine Urlaubswünsche ein.${frist}`;
      const recipients = persons.filter((p) => p.userId !== null && p.userId !== req.user.sub);
      const results = await Promise.allSettled(
        recipients.map((p) =>
          app.notify({
            userId: p.userId as string,
            type: "LEAVE_PLAN_OPENED",
            title: "Urlaubsplanung eröffnet",
            message,
            link,
            tenantId,
            relatedType: "LeavePlan",
            relatedId: plan.id,
            emailSubject: "Urlaubsplanung eröffnet",
          }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        app.log.warn(
          { planId: plan.id, failed },
          "Failed to notify persons of an opened leave plan",
        );
      }
    } catch (err) {
      app.log.warn({ err, planId: plan.id }, "Failed to notify persons of an opened leave plan");
    }
  }

  app.post("/", {
    schema: {
      tags: ["Abwesenheiten"],
      security: [{ bearerAuth: [] }],
      summary: "Open a leave plan for a salon and year",
      description:
        "Opens the non-binding yearly leave plan of one salon in the caller's leave-plan:manage reach. At most one open plan per salon and year.",
    },
    preHandler: requirePermission("leave-plan:manage:ZUGEWIESEN"),
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

      const created = await app.prisma
        .$transaction(async (tx) => {
          // Serialises two openers of the same salon and year; the partial unique index
          // `LeavePlan_open_unique` is the database backstop of the same rule.
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
        })
        .catch((err: unknown) => {
          // A racing opener that slipped past the application check: same answer as the check.
          if (isOpenPlanUniqueViolation(err)) return null;
          throw err;
        });
      if (!created) {
        return reply.code(409).send({
          error: LEAVE_PLAN_MESSAGES[LEAVE_PLAN_ALREADY_OPEN],
          code: LEAVE_PLAN_ALREADY_OPEN,
        });
      }
      await notifyPlanOpened(req, created);
      return reply.code(201).send({ plan: toPlanDto(created) });
    },
  });

  app.get("/", {
    schema: {
      tags: ["Abwesenheiten"],
      security: [{ bearerAuth: [] }],
      summary: "List the leave plans of a salon",
      description:
        "Lists the plans of one salon (optionally one year), newest first. Readable with a leave-request:read reach over the salon, or as a person whose own Stammsalon the salon is in the plan year.",
    },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const query = listQuerySchema.parse(req.query);
      const tenantId = req.user.tenantId;
      const where = {
        tenantId,
        salonId: query.salonId,
        ...(query.year !== undefined ? { year: query.year } : {}),
      };
      // Candidate years: the one asked, else the salon's plan years. Nothing of them is returned
      // before the admission below; a refusal is one body whatever the cause (T-835-18).
      const candidates =
        query.year !== undefined
          ? [query.year]
          : (
              await app.prisma.leavePlan.findMany({
                where,
                select: { year: true },
                distinct: ["year"],
              })
            ).map((row) => row.year);
      const years = await readablePlanYears(app.prisma, {
        tenantId,
        readReach: await readReach(req),
        selfEmployeeId: req.user.employeeId ?? null,
        salonId: query.salonId,
        years: candidates,
      });
      if (years === null) return reply.code(404).send(SALON_NOT_FOUND);

      const plans = await app.prisma.leavePlan.findMany({
        where: { ...where, year: { in: [...years] } },
        orderBy: [{ year: "desc" }, { openedAt: "desc" }, { id: "asc" }],
      });
      return reply.send({ plans: plans.map(toPlanDto) });
    },
  });

  app.patch("/:id", {
    schema: {
      tags: ["Abwesenheiten"],
      security: [{ bearerAuth: [] }],
      summary: "Set or clear the deadline of an open leave plan",
      description:
        "Sets (YYYY-MM-DD) or clears (null) the deadline of an OPEN plan in the caller's leave-plan:manage reach. The deadline is a hint unless the tenant locks own changes after it.",
    },
    preHandler: requirePermission("leave-plan:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const body = deadlineBodySchema.parse(req.body);
      const tenantId = req.user.tenantId;
      const plan = await loadPlan(req, id);
      if (!plan || !(await manageCovers(req, plan.salonId))) {
        return reply.code(404).send(PLAN_NOT_FOUND);
      }

      const outcome = await app.prisma.$transaction(async (tx) => {
        // The plan row lock serialises the edit with a takeover flipping the plan to TAKEN_OVER.
        const locked = await tx.$queryRaw<
          Array<{ status: string; deadline: Date | null }>
        >`SELECT "status", "deadline" FROM "LeavePlan" WHERE "id" = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
        const current = locked[0];
        if (!current) return { kind: "missing" } as const;
        if (current.status !== "OPEN") return { kind: "closed" } as const;

        const oldDeadline = current.deadline ? dayOf(current.deadline) : null;
        const newDeadline = body.deadline ?? null;
        if (oldDeadline === newDeadline) return { kind: "unchanged" } as const;
        const row = await tx.leavePlan.update({
          where: { id, tenantId },
          data: { deadline: newDeadline ? dayToDate(newDeadline) : null },
        });
        await app.audit({
          userId: req.user.sub,
          action: "UPDATE",
          entity: "LeavePlan",
          entityId: id,
          oldValue: { deadline: oldDeadline },
          newValue: { deadline: newDeadline },
          request: requestAudit(req),
          tx,
        });
        return { kind: "updated", row } as const;
      });
      if (outcome.kind === "missing") return reply.code(404).send(PLAN_NOT_FOUND);
      if (outcome.kind === "closed") {
        return reply
          .code(409)
          .send({ error: LEAVE_PLAN_MESSAGES[LEAVE_PLAN_CLOSED], code: LEAVE_PLAN_CLOSED });
      }
      // An unchanged deadline writes nothing and answers the stored plan (200, no audit row).
      return reply.send({ plan: toPlanDto(outcome.kind === "updated" ? outcome.row : plan) });
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
      const canManage = await manageCovers(req, plan.salonId);
      const dto = await readPlanner(app, {
        tenantId,
        plan,
        viewer: {
          userId: req.user.sub,
          employeeId: selfEmployeeId,
          canManage,
          // The calendar's rule (`canSeeLeaveType`): the permission, computed once per request.
          canSeeAllTypes: await hasPermission(req, "leave-request:read:ZUGEWIESEN"),
          canCreateOwn: await hasPermission(req, "leave-request:create:EIGENE"),
          entitlementReach: await resolveAccessReach(
            app.prisma,
            accessContextFromRequest(req),
            "leave-entitlement:read:ZUGEWIESEN",
          ),
          manageReach: reachToManage,
          approveReach: reachToApprove,
          readReach: reachToRead,
        },
        now: req.testNow ?? new Date(),
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
        "Adds a VACATION wish to an open plan the caller may read: an own one (leave-request:create:EIGENE) or, with employeeId, one for a person inside the caller's leave-plan:manage reach. The wish counts nowhere until the takeover turns it into a request.",
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

      const now = req.testNow ?? new Date();
      const reachToManage = await manageReach(req);
      let targetEmployeeId: string;
      let actor: WishActor;
      if (body.employeeId !== undefined && body.employeeId !== selfEmployeeId) {
        // Manager path (D-04): another person's wish needs a manage reach over that person on a
        // wish day. An unknown id, a foreign tenant's person and a person outside the reach are
        // one cause with one body (T-835-25).
        const target = await app.prisma.employee.findFirst({
          where: { id: body.employeeId, tenantId },
          select: { id: true },
        });
        if (
          !target ||
          !(await manageCoversPersonOnDays(
            app.prisma,
            tenantId,
            reachToManage,
            target.id,
            body.startDate,
            body.endDate,
          ))
        ) {
          return reply.code(404).send(PERSON_NOT_FOUND);
        }
        targetEmployeeId = target.id;
        actor = { userId: req.user.sub, kind: "MANAGER", isManagerOfPerson: true };
      } else {
        if (!(await hasPermission(req, "leave-request:create:EIGENE"))) {
          return reply.code(403).send({ error: "Forbidden" });
        }
        if (selfEmployeeId === null) {
          return reply.code(400).send({ error: "Für dein Konto ist kein Mitarbeiter hinterlegt." });
        }
        targetEmployeeId = selfEmployeeId;
        actor = {
          userId: req.user.sub,
          kind: "OWN",
          isManagerOfPerson: await manageCoversPersonOnDays(
            app.prisma,
            tenantId,
            reachToManage,
            selfEmployeeId,
            body.startDate,
            body.endDate,
          ),
        };
      }

      const outcome = await createWish(app, {
        tenantId,
        planId: plan.id,
        employeeId: targetEmployeeId,
        actor,
        now,
        startDay: body.startDate,
        endDay: body.endDate,
        halfDay: body.halfDay,
        request: requestAudit(req),
      });
      if (!outcome.ok) return reply.code(outcome.statusCode).send(outcome.body);
      return reply.code(201).send({ wish: toPlannerWish(outcome.wish, { planStatus: "OPEN" }) });
    },
  });

  /**
   * Loads the plan and the wish of a wish route and decides who the caller is for it. Every cause of
   * "not yours to touch" (foreign tenant, unknown id, removed wish, wish of a person outside the
   * manage reach) is the same frozen 404 body (D-04, T-835-25); a plan the caller may not read
   * answers the plan body.
   */
  async function admitWishWrite(
    req: FastifyRequest,
    ids: { id: string; wishId: string },
  ): Promise<
    | { ok: true; plan: { id: string }; actor: WishActor }
    | { ok: false; statusCode: 403 | 404; body: { error: string } }
  > {
    const tenantId = req.user.tenantId;
    const plan = await loadPlan(req, ids.id);
    if (!plan) return { ok: false, statusCode: 404, body: PLAN_NOT_FOUND };
    const selfEmployeeId = req.user.employeeId ?? null;
    const admitted = await canReadPlan(app.prisma, {
      tenantId,
      readReach: await readReach(req),
      selfEmployeeId,
      salonId: plan.salonId,
      year: plan.year,
    });
    if (!admitted) return { ok: false, statusCode: 404, body: PLAN_NOT_FOUND };

    const wish = await app.prisma.leavePlanWish.findFirst({
      where: { id: ids.wishId, planId: plan.id, tenantId, deletedAt: null },
      select: { employeeId: true, startDate: true, endDate: true },
    });
    if (!wish) return { ok: false, statusCode: 404, body: WISH_NOT_FOUND };

    const covers = await manageCoversPersonOnDays(
      app.prisma,
      tenantId,
      await manageReach(req),
      wish.employeeId,
      dayOf(wish.startDate),
      dayOf(wish.endDate),
    );
    if (selfEmployeeId !== null && wish.employeeId === selfEmployeeId) {
      if (!(await hasPermission(req, "leave-request:create:EIGENE"))) {
        return { ok: false, statusCode: 403, body: { error: "Forbidden" } };
      }
      return {
        ok: true,
        plan,
        actor: { userId: req.user.sub, kind: "OWN", isManagerOfPerson: covers },
      };
    }
    if (!covers) return { ok: false, statusCode: 404, body: WISH_NOT_FOUND };
    return {
      ok: true,
      plan,
      actor: { userId: req.user.sub, kind: "MANAGER", isManagerOfPerson: true },
    };
  }

  app.patch("/:id/wishes/:wishId", {
    schema: {
      tags: ["Abwesenheiten"],
      security: [{ bearerAuth: [] }],
      summary: "Move or resize a wish of a leave plan",
      description:
        "Changes the dates or the half-day flag of an own wish, or of a wish of a person inside the caller's leave-plan:manage reach, in an open plan. A taken-over wish cannot be moved.",
    },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const ids = wishParamSchema.parse(req.params);
      const body = wishPatchBodySchema.parse(req.body);
      const admission = await admitWishWrite(req, ids);
      if (!admission.ok) return reply.code(admission.statusCode).send(admission.body);

      const outcome = await updateWish(app, {
        tenantId: req.user.tenantId,
        planId: admission.plan.id,
        wishId: ids.wishId,
        actor: admission.actor,
        now: req.testNow ?? new Date(),
        startDay: body.startDate,
        endDay: body.endDate,
        halfDay: body.halfDay,
        request: requestAudit(req),
      });
      if (!outcome.ok) return reply.code(outcome.statusCode).send(outcome.body);
      return reply.send({ wish: toPlannerWish(outcome.wish, { planStatus: "OPEN" }) });
    },
  });

  app.delete("/:id/wishes/:wishId", {
    schema: {
      tags: ["Abwesenheiten"],
      security: [{ bearerAuth: [] }],
      summary: "Remove a wish of a leave plan",
      description:
        "Removes an own wish, or a wish of a person inside the caller's leave-plan:manage reach, from an open plan. The row is kept (soft removal) and the removal is audited.",
    },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const ids = wishParamSchema.parse(req.params);
      const admission = await admitWishWrite(req, ids);
      if (!admission.ok) return reply.code(admission.statusCode).send(admission.body);

      const outcome = await removeWish(app, {
        tenantId: req.user.tenantId,
        planId: admission.plan.id,
        wishId: ids.wishId,
        actor: admission.actor,
        now: req.testNow ?? new Date(),
        request: requestAudit(req),
      });
      if (!outcome.ok) return reply.code(outcome.statusCode).send(outcome.body);
      return reply.code(204).send();
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
    preHandler: requirePermission("leave-plan:manage:ZUGEWIESEN"),
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
      const outcome = await takeOverLeavePlan(app, {
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
      if (!outcome.ok) {
        // D-835-41: another run of this plan holds the lock, or the plan was closed meanwhile.
        return reply
          .code(409)
          .send({ error: LEAVE_PLAN_MESSAGES[outcome.code], code: outcome.code });
      }
      return reply.send(outcome.result);
    },
  });
}
