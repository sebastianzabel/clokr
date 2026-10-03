/**
 * Issue #468, finding 4 (D-08..D-11, A-1) — § 17 Abs. 1 BEEG Elternzeit-Kürzung: preview, commit
 * and revocation, anchored on an approved `LeaveRequest` of leave-type code `PARENTAL`.
 *
 * Every route here requires `leave-entitlement:update:ZUGEWIESEN` — the SAME permission
 * `PUT /settings/vacation/:employeeId` already uses (D-11: this action changes the identical
 * resource, just through a different, audited, § 17-shaped write). Guard order, shared by all
 * three routes via {@link loadReducibleRequest} (D-11 / T-468-12, mirroring
 * `leave.ts`'s `PATCH /requests/:id/correct` and `leave-settings.ts`'s guard idiom):
 *   1. not found / soft-deleted -> 404, no audit
 *   2. foreign tenant -> audited CROSS_TENANT_ACCESS_DENIED, same 404
 *   3. out-of-scope (Stammsalon, Stichtag = the request's own startDate) -> audited
 *      SCOPE_ACCESS_DENIED, same 404
 *   4. not a PARENTAL request -> 409 (`NOT_PARENTAL_MESSAGE`)
 * A foreign-tenant id, an out-of-scope real id and an unknown id are therefore byte-identical at
 * every one of these three routes (T-100-09).
 *
 * `isAutoCalculated` is deliberately NEVER written here (grep-enforced, see the plan's
 * acceptance criteria): the entitlement stays human-owned purely through the shape of the audit
 * ({@link hasHumanVacationWrite} in `../leave-days.ts`), exactly like `PUT /settings/vacation`.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Prisma } from "@clokr/db";
import {
  requirePermission,
  accessContextFromRequest,
  resolveAccessReach,
  isStammsalonScopeMatch,
  auditReasonSchema,
} from "../../platform";
import { todayInTz, getTenantTimezone } from "../../working-time-account";
import { EFFECTIVE_LEAVE_STATUSES } from "../effective-leave-statuses";
import { getVacationEntitlement } from "../facade/entitlements";
import { recalculateCarryOver } from "../leave-days";
import { buildParentalReductionPreview } from "../parental-leave-reduction";

const APPROVED_MESSAGE = "Nur für genehmigte Elternzeit möglich.";
const NOT_PARENTAL_MESSAGE = "Nur für Elternzeit-Anträge möglich.";
const NOT_FOUND_MESSAGE = "Antrag nicht gefunden";

const leaveRequestIdParamSchema = z.object({ leaveRequestId: z.string().uuid() });

const commitBodySchema = z.object({
  declaredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Format YYYY-MM-DD erwartet"),
  years: z.array(z.number().int().min(2000).max(2100)).min(1),
});

const revokeBodySchema = z.object({
  year: z.number().int().min(2000).max(2100),
  reason: auditReasonSchema,
});

/** DD.MM.YYYY, UTC accessors — mirrors `leave.ts`'s own module-private `formatDateDe` (not
 * exported there; this file keeps its own copy rather than widen that file's exports). */
function formatDateDe(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

function isP2002(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code: unknown }).code === "P2002",
  );
}

/** Thrown inside a `$transaction` callback to signal a specific, year-scoped 409 to the outer
 * handler — `$transaction` itself rejects with whatever the callback throws. */
class ParentalReductionYearConflictError extends Error {
  constructor(public readonly message2: string) {
    super(message2);
  }
}

type LoadedParentalRequest = Prisma.LeaveRequestGetPayload<{
  include: { leaveType: true; employee: { select: { tenantId: true } } };
}>;

/**
 * The shared guard of all three routes (D-11). Writes the reply and returns `null` when the
 * request fails any guard; returns the loaded row (with `leaveType`/`employee.tenantId`
 * included) otherwise. Callers MUST `return` immediately when this returns `null`.
 */
async function loadReducibleRequest(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  leaveRequestId: string,
): Promise<LoadedParentalRequest | null> {
  const existing = await app.prisma.leaveRequest.findFirst({
    where: { id: leaveRequestId, deletedAt: null },
    include: { leaveType: true, employee: { select: { tenantId: true } } },
  });
  if (!existing) {
    reply.code(404).send({ error: NOT_FOUND_MESSAGE });
    return null;
  }

  if (existing.employee.tenantId !== req.user.tenantId) {
    await app.audit({
      userId: req.user.sub,
      action: "CROSS_TENANT_ACCESS_DENIED",
      entity: "LeaveRequest",
      entityId: leaveRequestId,
      request: { ip: req.ip, headers: req.headers as Record<string, string> },
    });
    reply.code(404).send({ error: NOT_FOUND_MESSAGE });
    return null;
  }

  const access = accessContextFromRequest(req);
  const scopeReach = await resolveAccessReach(
    app.prisma,
    access,
    "leave-entitlement:update:ZUGEWIESEN",
  );
  if (
    !(await isStammsalonScopeMatch(
      app.prisma,
      req.user.tenantId,
      scopeReach,
      existing.employeeId,
      existing.startDate,
    ))
  ) {
    await app.audit({
      userId: req.user.sub,
      action: "SCOPE_ACCESS_DENIED",
      entity: "LeaveRequest",
      entityId: leaveRequestId,
      request: { ip: req.ip, headers: req.headers as Record<string, string> },
    });
    reply.code(404).send({ error: NOT_FOUND_MESSAGE });
    return null;
  }

  if (existing.leaveType.code !== "PARENTAL") {
    reply.code(409).send({ error: NOT_PARENTAL_MESSAGE });
    return null;
  }

  return existing as LoadedParentalRequest;
}

export async function parentalLeaveReductionRoutes(app: FastifyInstance) {
  // GET /api/v1/leave/parental-reductions/:leaveRequestId — Vorschau, keine Schreibung.
  app.get("/:leaveRequestId", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("leave-entitlement:update:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { leaveRequestId } = leaveRequestIdParamSchema.parse(req.params);
      const existing = await loadReducibleRequest(app, req, reply, leaveRequestId);
      if (!existing) return;

      if (!(EFFECTIVE_LEAVE_STATUSES as readonly string[]).includes(existing.status)) {
        return reply.code(409).send({ error: APPROVED_MESSAGE });
      }

      const preview = await buildParentalReductionPreview(
        app.prisma,
        existing,
        existing.employee.tenantId,
      );
      return preview;
    },
  });

  // POST /api/v1/leave/parental-reductions/:leaveRequestId — Kürzung erklären und buchen.
  app.post("/:leaveRequestId", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("leave-entitlement:update:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { leaveRequestId } = leaveRequestIdParamSchema.parse(req.params);
      // T-100-09 (D-07): the body is parsed BEFORE the lookup so a minimal valid body reaches
      // the tenant/scope guard for a foreign-tenant or unknown id instead of 400-ing first.
      const body = commitBodySchema.parse(req.body);

      const existing = await loadReducibleRequest(app, req, reply, leaveRequestId);
      if (!existing) return;

      if (existing.status !== "APPROVED") {
        return reply.code(409).send({ error: APPROVED_MESSAGE });
      }

      const tenantId = existing.employee.tenantId;
      const employeeId = existing.employeeId;

      const tz = await getTenantTimezone(app.prisma, tenantId);
      const today = todayInTz(tz);
      const declaredAtDate = new Date(`${body.declaredAt}T00:00:00.000Z`);
      if (declaredAtDate.getTime() > today.getTime()) {
        return reply
          .code(400)
          .send({ error: "Das Datum der Erklärung darf nicht in der Zukunft liegen." });
      }

      const preview = await buildParentalReductionPreview(app.prisma, existing, tenantId);
      const previewByYear = new Map(preview.years.map((y) => [y.year, y]));

      const years = Array.from(new Set(body.years)).sort((a, b) => a - b);

      for (const year of years) {
        const yearPreview = previewByYear.get(year);
        if (!yearPreview || yearPreview.months === 0) {
          return reply
            .code(400)
            .send({ error: `Für ${year} enthält die Elternzeit keinen vollen Kalendermonat.` });
        }
        if (yearPreview.existing) {
          const revokedSuffix =
            yearPreview.existing.status === "REVOKED"
              ? ` (widerrufen am ${formatDateDe(new Date(yearPreview.existing.revokedAt!))})`
              : "";
          return reply.code(409).send({
            error: `Für ${year} ist zu dieser Elternzeit bereits eine Kürzung erklärt.${revokedSuffix}`,
          });
        }
        if (yearPreview.currentTotalDays === null) {
          return reply.code(409).send({
            error: `Für ${year} existiert kein Urlaubsanspruch — bitte zuerst den Urlaubsanspruch anlegen.`,
          });
        }
        if (yearPreview.resultingTotalDays === null || yearPreview.resultingTotalDays < 0) {
          return reply
            .code(409)
            .send({ error: `Die Kürzung übersteigt den Urlaubsanspruch ${year}.` });
        }
      }

      const results: Array<{
        year: number;
        months: number;
        reducedDays: number;
        totalDays: number;
      }> = [];
      const warnings: string[] = [];

      try {
        await app.prisma.$transaction(async (tx) => {
          for (const year of years) {
            const yearPreview = previewByYear.get(year)!;
            const lookup = await getVacationEntitlement(tx, employeeId, tenantId, year);
            const entitlementRow = lookup?.entitlement;
            if (!entitlementRow) {
              // Re-checked inside the transaction (defensive — already validated above).
              throw new ParentalReductionYearConflictError(
                `Für ${year} existiert kein Urlaubsanspruch — bitte zuerst den Urlaubsanspruch anlegen.`,
              );
            }
            const oldTotal = Number(entitlementRow.totalDays);
            const newTotal = Math.round((oldTotal - yearPreview.proposedReducedDays) * 100) / 100;

            const { count } = await tx.leaveEntitlement.updateMany({
              where: { id: entitlementRow.id, totalDays: oldTotal },
              data: { totalDays: newTotal },
            });
            if (count !== 1) {
              throw new ParentalReductionYearConflictError(
                "Gleichzeitige Änderung des Urlaubsanspruchs — bitte erneut versuchen.",
              );
            }

            let reductionRow;
            try {
              reductionRow = await tx.parentalLeaveReduction.create({
                data: {
                  employeeId,
                  leaveRequestId: existing.id,
                  year,
                  months: yearPreview.months,
                  reducedDays: yearPreview.proposedReducedDays,
                  declaredAt: declaredAtDate,
                  createdBy: req.user.sub,
                },
              });
            } catch (err) {
              if (isP2002(err)) {
                throw new ParentalReductionYearConflictError(
                  `Für ${year} ist zu dieser Elternzeit bereits eine Kürzung erklärt.`,
                );
              }
              throw err;
            }

            await app.audit({
              tx,
              userId: req.user.sub,
              action: "UPDATE",
              entity: "LeaveEntitlement",
              entityId: entitlementRow.id,
              oldValue: { totalDays: oldTotal },
              newValue: {
                totalDays: newTotal,
                reason: "Elternzeit-Kürzung (§ 17 Abs. 1 BEEG)",
                leaveRequestId: existing.id,
                parentalLeaveReductionId: reductionRow.id,
                year,
                months: yearPreview.months,
                declaredAt: body.declaredAt,
              },
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
            });
            await app.audit({
              tx,
              userId: req.user.sub,
              action: "PARENTAL_LEAVE_REDUCTION_DECLARED",
              entity: "ParentalLeaveReduction",
              entityId: reductionRow.id,
              newValue: {
                leaveRequestId: existing.id,
                employeeId,
                year,
                months: yearPreview.months,
                reducedDays: yearPreview.proposedReducedDays,
                declaredAt: body.declaredAt,
              },
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
            });

            results.push({
              year,
              months: yearPreview.months,
              reducedDays: yearPreview.proposedReducedDays,
              totalDays: newTotal,
            });

            const usedDays = Number(entitlementRow.usedDays);
            if (newTotal < usedDays) {
              warnings.push(
                `Für ${year} wurde bereits mehr Urlaub genommen, als nach der Kürzung zusteht (§ 17 Abs. 4 BEEG).`,
              );
            }
          }
        });
      } catch (err) {
        if (err instanceof ParentalReductionYearConflictError) {
          return reply.code(409).send({ error: err.message2 });
        }
        throw err;
      }

      // Issue #468 (D-09): the next year's dynamic carry-over follows the changed total, exactly
      // like every other usedDays/totalDays movement — never created if it does not exist yet.
      for (const year of years) {
        const lookup = await getVacationEntitlement(app.prisma, employeeId, tenantId, year);
        if (lookup?.leaveTypeId) {
          await recalculateCarryOver(
            app.prisma,
            tenantId,
            employeeId,
            lookup.leaveTypeId,
            year + 1,
            {
              createIfMissing: false,
            },
          );
        }
      }

      return reply.code(201).send({ reductions: results, warnings });
    },
  });

  // POST /api/v1/leave/parental-reductions/:leaveRequestId/revoke — Widerruf als Korrektureintrag.
  app.post("/:leaveRequestId/revoke", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("leave-entitlement:update:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { leaveRequestId } = leaveRequestIdParamSchema.parse(req.params);
      const body = revokeBodySchema.parse(req.body);

      const existing = await loadReducibleRequest(app, req, reply, leaveRequestId);
      if (!existing) return;

      const tenantId = existing.employee.tenantId;
      const employeeId = existing.employeeId;

      // lint:tenant-scoping (D-13): `leaveRequestId` already came from `loadReducibleRequest`'s
      // own tenant-scoped lookup above, but this query-level `employee: { tenantId: req.user.tenantId }`
      // relation filter makes that proof local to THIS query too, instead of relying on the chain
      // (and the gate's `isPrincipalExpression` only recognises the literal `req.user.tenantId`
      // form, not a DB-fetched local alias of it — hence the inline form here rather than `tenantId`).
      const reduction = await app.prisma.parentalLeaveReduction.findFirst({
        where: {
          leaveRequestId: existing.id,
          year: body.year,
          employee: { tenantId: req.user.tenantId },
        },
      });
      if (!reduction) {
        return reply.code(404).send({ error: `Keine Kürzung für ${body.year} erklärt.` });
      }
      if (reduction.status === "REVOKED") {
        return reply.code(409).send({ error: "Die Kürzung ist bereits widerrufen." });
      }

      const lookup = await getVacationEntitlement(app.prisma, employeeId, tenantId, body.year);
      if (!lookup?.entitlement) {
        return reply.code(409).send({
          error: `Für ${body.year} existiert kein Urlaubsanspruch — bitte zuerst den Urlaubsanspruch anlegen.`,
        });
      }
      const entitlementRow = lookup.entitlement;
      const oldTotal = Number(entitlementRow.totalDays);
      const reducedDays = Number(reduction.reducedDays);
      const newTotal = Math.round((oldTotal + reducedDays) * 100) / 100;

      try {
        await app.prisma.$transaction(async (tx) => {
          const { count: revokeCount } = await tx.parentalLeaveReduction.updateMany({
            where: { id: reduction.id, status: "ACTIVE" },
            data: { status: "REVOKED", revokedAt: new Date(), revokedBy: req.user.sub },
          });
          if (revokeCount !== 1) {
            throw new ParentalReductionYearConflictError("Die Kürzung ist bereits widerrufen.");
          }

          const { count: entCount } = await tx.leaveEntitlement.updateMany({
            where: { id: entitlementRow.id, totalDays: oldTotal },
            data: { totalDays: newTotal },
          });
          if (entCount !== 1) {
            throw new ParentalReductionYearConflictError(
              "Gleichzeitige Änderung des Urlaubsanspruchs — bitte erneut versuchen.",
            );
          }

          await app.audit({
            tx,
            userId: req.user.sub,
            action: "UPDATE",
            entity: "LeaveEntitlement",
            entityId: entitlementRow.id,
            oldValue: { totalDays: oldTotal },
            newValue: {
              totalDays: newTotal,
              reason: "Widerruf Elternzeit-Kürzung (§ 17 Abs. 1 BEEG)",
              parentalLeaveReductionId: reduction.id,
              year: body.year,
            },
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          await app.audit({
            tx,
            userId: req.user.sub,
            action: "PARENTAL_LEAVE_REDUCTION_REVOKED",
            entity: "ParentalLeaveReduction",
            entityId: reduction.id,
            oldValue: { status: "ACTIVE" },
            newValue: { status: "REVOKED", auditReason: body.reason },
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        });
      } catch (err) {
        if (err instanceof ParentalReductionYearConflictError) {
          return reply.code(409).send({ error: err.message2 });
        }
        throw err;
      }

      await recalculateCarryOver(
        app.prisma,
        tenantId,
        employeeId,
        lookup.leaveTypeId,
        body.year + 1,
        {
          createIfMissing: false,
        },
      );

      const updated = await app.prisma.parentalLeaveReduction.findUnique({
        where: { id: reduction.id },
      });

      return reply.code(200).send({
        id: updated!.id,
        leaveRequestId: updated!.leaveRequestId,
        year: updated!.year,
        months: updated!.months,
        reducedDays: Number(updated!.reducedDays),
        status: updated!.status,
        revokedAt: updated!.revokedAt ? updated!.revokedAt.toISOString() : null,
        revokedBy: updated!.revokedBy,
        totalDays: newTotal,
      });
    },
  });
}
