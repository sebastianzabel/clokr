/**
 * Issue #836 (D-836-02/D-836-13/D-836-14/D-836-22) - maintenance of the leave limits and blackouts of
 * a salon. A rule is data of a salon (or of all salons) and one table serves both: a blackout is a
 * rule with groupKind ALL and maxPersons 0 (AC-10).
 *
 * Admission is exactly the #647 coverage-rule pattern: a chosen salon is validated by
 * `resolveSalonInReach` against the reach of `leave-limit:manage`, every rejection (foreign tenant,
 * unknown, inactive, outside the reach) is the one `SALON_NOT_FOUND` body, and a rule id of another
 * tenant answers the same body as an unknown id (T-100-09). A rule for ALL salons (salonId null) is
 * written only with a whole-tenant reach of the key, and the route - not the key's relation - is what
 * enforces it.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Prisma } from "@clokr/db";
import { requireAuth } from "../../../middleware/auth";
import {
  accessContextFromRequest,
  accessRoleChoices,
  accessRoleOfTenant,
  hasPermission,
  listSalons,
  requirePermission,
  resolveAccessReach,
  resolveSalonInReach,
  type AccessReach,
} from "../../platform";
import {
  leaveLimitRuleBodySchema,
  ruleDataFromBody,
  toLeaveLimitRuleDto,
  type LeaveLimitRuleBody,
  type LeaveLimitRuleRecord,
} from "../leave-limits/rule-dto";

/** One body for every salon rejection cause (T-100-09), byte-identical with the other salon filters. */
const SALON_NOT_FOUND = { error: "Salon nicht gefunden" } as const;
const RULE_NOT_FOUND = { error: "Regel nicht gefunden" } as const;
const ROLE_NOT_FOUND = { error: "Rolle nicht gefunden" } as const;
const ALL_SALONS_FORBIDDEN = {
  error: "Eine Regel für alle Salons kann nur anlegen, wer für den ganzen Mandanten zuständig ist.",
} as const;

const listQuerySchema = z.object({ salonId: z.string().uuid().optional() });

const MANAGE_KEY = "leave-limit:manage:ZUGEWIESEN" as const;

type Reach = AccessReach;

/** Union of reaches: any whole-tenant reach wins, scoped reaches merge their salon ids. */
function unionReach(reaches: readonly Reach[]): Reach {
  if (reaches.some((reach) => reach.kind === "wholeTenant")) return { kind: "wholeTenant" };
  const salonIds = new Set<string>();
  for (const reach of reaches) {
    if (reach.kind === "scoped") for (const id of reach.salonIds) salonIds.add(id);
  }
  return { kind: "scoped", salonIds: [...salonIds], employeeIds: [] };
}

/** True iff the reach covers the rule scope: a salon in reach, or the all-salons scope with a whole-tenant reach. */
function reachCovers(reach: Reach, salonId: string | null): boolean {
  if (reach.kind === "wholeTenant") return true;
  return salonId !== null && reach.salonIds.includes(salonId);
}

/** Plain stored fields of a rule for the audit row (dates as `YYYY-MM-DD`). */
function auditSnapshot(row: LeaveLimitRuleRecord) {
  return {
    salonId: row.salonId,
    groupKind: row.groupKind,
    classification: row.classification,
    accessRoleId: row.accessRoleId,
    maxPersons: row.maxPersons,
    validFrom: row.validFrom ? row.validFrom.toISOString().slice(0, 10) : null,
    validUntil: row.validUntil ? row.validUntil.toISOString().slice(0, 10) : null,
    name: row.name,
  };
}

function requestAudit(req: FastifyRequest) {
  return { ip: req.ip, headers: req.headers as Record<string, string> };
}

export async function leaveLimitRoutes(app: FastifyInstance) {
  async function manageReach(req: FastifyRequest): Promise<Reach> {
    return resolveAccessReach(app.prisma, accessContextFromRequest(req), MANAGE_KEY);
  }

  /**
   * Admission of the salon a body names: `null` needs a whole-tenant manage reach (403), a salon
   * must be an active salon in that reach (404, the one body). Returns the salon id to store.
   */
  async function admitSalon(
    req: FastifyRequest,
    salonId: string | null,
  ): Promise<
    { ok: true; salonId: string | null } | { ok: false; status: 403 | 404; body: object }
  > {
    const reach = await manageReach(req);
    if (salonId === null) {
      return reach.kind === "wholeTenant"
        ? { ok: true, salonId: null }
        : { ok: false, status: 403, body: ALL_SALONS_FORBIDDEN };
    }
    const salon = await resolveSalonInReach(app.prisma, req.user.tenantId, reach, salonId);
    if (!salon.ok || salon.salonId === null)
      return { ok: false, status: 404, body: SALON_NOT_FOUND };
    return { ok: true, salonId: salon.salonId };
  }

  /** A role a rule names must be a system role or a role of the caller's tenant (404 otherwise). */
  async function admitRole(req: FastifyRequest, body: LeaveLimitRuleBody) {
    if (body.groupKind !== "ACCESS_ROLE" || !body.accessRoleId)
      return { ok: true as const, name: null };
    const role = await accessRoleOfTenant(app.prisma, req.user.tenantId, body.accessRoleId);
    return role ? { ok: true as const, name: role.name } : { ok: false as const };
  }

  app.get("/", {
    schema: {
      tags: ["Abwesenheiten"],
      security: [{ bearerAuth: [] }],
      summary: "List leave limit rules and blackouts",
      description:
        "Lists the non-deleted rules of the caller's reach (with salonId: that salon plus every all-salons rule). Needs leave-limit:manage or leave-request:approve.",
    },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const query = listQuerySchema.parse(req.query);
      const tenantId = req.user.tenantId;
      const context = accessContextFromRequest(req);
      // Two literal checks: requireAnyPermission cannot mix two resource:action pairs (D-836-22).
      const holdsManage = await hasPermission(req, "leave-limit:manage:ZUGEWIESEN");
      const holdsApprove = await hasPermission(req, "leave-request:approve:ZUGEWIESEN");
      if (!holdsManage && !holdsApprove) return reply.code(403).send({ error: "Forbidden" });

      const reaches: Reach[] = [];
      if (holdsManage) reaches.push(await resolveAccessReach(app.prisma, context, MANAGE_KEY));
      if (holdsApprove) {
        reaches.push(
          await resolveAccessReach(app.prisma, context, "leave-request:approve:ZUGEWIESEN"),
        );
      }
      const reach = unionReach(reaches);
      const manage: Reach | null = holdsManage ? reaches[0]! : null;

      let where: Prisma.LeaveLimitRuleWhereInput;
      if (query.salonId !== undefined) {
        let admitted = false;
        for (const candidate of reaches) {
          const salon = await resolveSalonInReach(app.prisma, tenantId, candidate, query.salonId);
          if (salon.ok) admitted = true;
        }
        if (!admitted) return reply.code(404).send(SALON_NOT_FOUND);
        where = { tenantId, deletedAt: null, OR: [{ salonId: query.salonId }, { salonId: null }] };
      } else if (reach.kind === "wholeTenant") {
        where = { tenantId, deletedAt: null };
      } else if (reach.salonIds.length > 0) {
        where = {
          tenantId,
          deletedAt: null,
          OR: [{ salonId: { in: [...reach.salonIds] } }, { salonId: null }],
        };
      } else {
        where = { tenantId, deletedAt: null, salonId: { in: [] as string[] } };
      }

      const [rows, salons, roles] = await Promise.all([
        app.prisma.leaveLimitRule.findMany({
          where,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
        listSalons(app.prisma, tenantId, { includeInactive: true }),
        accessRoleChoices(app.prisma, tenantId),
      ]);
      const salonById = new Map(salons.map((salon) => [salon.id, salon]));
      const roleById = new Map(roles.map((role) => [role.id, role.name]));
      return {
        rules: rows.map((row) =>
          toLeaveLimitRuleDto(row, {
            salon: row.salonId ? (salonById.get(row.salonId) ?? null) : null,
            roleName: row.accessRoleId ? (roleById.get(row.accessRoleId) ?? null) : null,
            canManage: manage !== null && reachCovers(manage, row.salonId),
          }),
        ),
        canManageAllSalons: manage !== null && manage.kind === "wholeTenant",
        roleChoices: holdsManage ? roles : [],
      };
    },
  });

  app.post("/", {
    schema: {
      tags: ["Abwesenheiten"],
      security: [{ bearerAuth: [] }],
      summary: "Create a leave limit rule or blackout",
      description:
        "Creates a rule for one salon in the caller's leave-limit:manage reach, or for all salons (salonId null, whole-tenant reach only). A blackout is groupKind ALL with maxPersons 0.",
    },
    preHandler: requirePermission("leave-limit:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const body = leaveLimitRuleBodySchema.parse(req.body);
      const tenantId = req.user.tenantId;
      const salon = await admitSalon(req, body.salonId);
      if (!salon.ok) return reply.code(salon.status).send(salon.body);
      const role = await admitRole(req, body);
      if (!role.ok) return reply.code(404).send(ROLE_NOT_FOUND);

      const created = await app.prisma.leaveLimitRule.create({
        data: {
          tenantId,
          salonId: salon.salonId,
          createdByUserId: req.user.sub,
          ...ruleDataFromBody(body),
        },
      });
      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "LeaveLimitRule",
        entityId: created.id,
        newValue: auditSnapshot(created),
        request: requestAudit(req),
      });
      const salons = salon.salonId
        ? await listSalons(app.prisma, tenantId, { includeInactive: true })
        : [];
      return reply.code(201).send(
        toLeaveLimitRuleDto(created, {
          salon: salons.find((s) => s.id === created.salonId) ?? null,
          roleName: role.name,
          canManage: true,
        }),
      );
    },
  });
}
