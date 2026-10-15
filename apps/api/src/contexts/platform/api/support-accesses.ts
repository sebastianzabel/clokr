/**
 * Tenant view of the support accesses (Issue #93, Phase 93b-06, D-08, D-27, D-29) — the controller's side
 * of the operator's time-boxed read access:
 *
 *   GET  /                list every support access of the own tenant (newest first, paged)
 *   GET  /:id             one access with every read made under it
 *   POST /:id/end         end a running access at once
 *
 * Mounted at `/api/v1/support-accesses`, outside the operator block: the tenant side exists with or
 * without the operator surface. Reading needs `audit-log:read`, ending needs `tenant-settings:update`;
 * both permissions have the relation MANDANT, so `requirePermission` already enforces whole-tenant reach
 * and no salon- or person-scoped holder gets through (a role assignment of a narrower scope never
 * satisfies a MANDANT key). An operator token is refused by `requireAuth` and an EMPLOYEE has neither
 * permission.
 *
 * What the tenant sees is minimised (Art. 5 (1)(c) GDPR): the operator's display name — never its e-mail
 * or the client address, which stay in the operator's own log — the reason, the window, the early end and
 * the reads. A read row carries its category, the employee (name only while not anonymised, D-13), the
 * month and the filters, all of which the operator's audit transaction stored as control values, dates
 * and ids.
 *
 * Every lookup is keyed by the caller's tenant in the SAME `where` as the id: a foreign tenant's access
 * and an unknown id fall through the one `null` path and answer the identical 404 (T-100-09). Reads are
 * found in the tenant's own AuditLog through the operator stamp `newValue.actor.tenantId` that
 * `operatorTenantAudit()` writes on every row (`userId` is null for them). Both scopes are spelled inline
 * in each query because the tenant-scoping gate does not follow helper functions.
 *
 * There is no route that changes or deletes a `SupportAccess` or an `AuditLog` row apart from the one end
 * transition: an access row is immutable at the database (trigger), the guarded `updateMany` below is the
 * single legal change, and the end is written to the tenant log by the acting user and to the operator log
 * with a null operator (the tenant acted, D-27).
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { z } from "zod";
import { requirePermission } from "../request-permissions";
import { requestAuditFields } from "../request-audit-fields";
import { isAnonymizedEmployee } from "../employee-anonymization-filter";
import { OPERATOR_AUDIT_ACTIONS, recordOperatorAudit } from "../operator-audit";
import { readTenantTimezone } from "../facade/salon-assignments";
import { dismissSupportAccessNotices, supportAccessStatus } from "../support-access";
import type {
  SupportAccessEndedBy,
  TenantSupportAccessItemDto,
  TenantSupportAccessReadDto,
} from "../support-access-types";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const querySchema = z
  .object({
    page: z
      .string()
      .regex(/^[1-9]\d{0,5}$/)
      .optional(),
    limit: z
      .string()
      .regex(/^[1-9]\d{0,3}$/)
      .optional(),
  })
  .strict();

const idParamSchema = z.object({ id: z.string().uuid() });

const ACCESS_NOT_FOUND = { error: "Support-Zugriff nicht gefunden" };

type AccessRow = Prisma.SupportAccessGetPayload<{
  include: { operator: { select: { displayName: true } } };
}>;

function parseEndedBy(value: string | null): SupportAccessEndedBy | null {
  return value === "OPERATOR" || value === "TENANT" ? value : null;
}

function toItem(row: AccessRow, readCount: number, now: Date): TenantSupportAccessItemDto {
  return {
    id: row.id,
    operatorName: row.operator.displayName,
    reason: row.reason,
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    endedBy: parseEndedBy(row.endedBy),
    status: supportAccessStatus(row, now),
    readCount,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export async function supportAccessRoutes(app: FastifyInstance) {
  // GET /api/v1/support-accesses
  app.get(
    "/",
    {
      schema: {
        tags: ["Support-Zugriffe"],
        description:
          "Lists every support access of the own tenant with its status and the number of reads (whole-tenant audit-log:read).",
      },
      preHandler: requirePermission("audit-log:read:ZUGEWIESEN"),
    },
    async (req) => {
      const query = querySchema.parse(req.query);
      const page = query.page ? parseInt(query.page, 10) : 1;
      const limit = Math.min(query.limit ? parseInt(query.limit, 10) : DEFAULT_LIMIT, MAX_LIMIT);
      const tenantId = req.user.tenantId;
      const now = new Date();

      const [rows, total, timezone] = await Promise.all([
        app.prisma.supportAccess.findMany({
          where: { tenantId },
          orderBy: [{ startedAt: "desc" }, { id: "asc" }],
          take: limit,
          skip: (page - 1) * limit,
          include: { operator: { select: { displayName: true } } },
        }),
        app.prisma.supportAccess.count({ where: { tenantId } }),
        readTenantTimezone(app.prisma, tenantId),
      ]);

      const ids = rows.map((row) => row.id);
      const grouped =
        ids.length === 0
          ? []
          : await app.prisma.auditLog.groupBy({
              by: ["entityId"],
              where: {
                entity: "SupportAccess",
                action: OPERATOR_AUDIT_ACTIONS.SUPPORT_DATA_READ,
                entityId: { in: ids },
                userId: null,
                newValue: { path: ["actor", "tenantId"], equals: tenantId },
              },
              _count: { _all: true },
            });
      const readCounts = new Map<string, number>();
      for (const group of grouped) {
        if (group.entityId) readCounts.set(group.entityId, group._count._all);
      }

      return {
        items: rows.map((row) => toItem(row, readCounts.get(row.id) ?? 0, now)),
        total,
        page,
        limit,
        timezone,
      };
    },
  );

  // GET /api/v1/support-accesses/:id
  app.get(
    "/:id",
    {
      schema: {
        tags: ["Support-Zugriffe"],
        description:
          "One support access of the own tenant with every read made under it (whole-tenant audit-log:read).",
      },
      preHandler: requirePermission("audit-log:read:ZUGEWIESEN"),
    },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const tenantId = req.user.tenantId;
      const now = new Date();

      const row = await app.prisma.supportAccess.findFirst({
        where: { id, tenantId },
        include: { operator: { select: { displayName: true } } },
      });
      if (!row) return reply.code(404).send(ACCESS_NOT_FOUND);

      const readRows = await app.prisma.auditLog.findMany({
        where: {
          entity: "SupportAccess",
          action: OPERATOR_AUDIT_ACTIONS.SUPPORT_DATA_READ,
          entityId: id,
          userId: null,
          newValue: { path: ["actor", "tenantId"], equals: tenantId },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { createdAt: true, newValue: true },
      });

      const employeeIds = new Set<string>();
      for (const read of readRows) {
        const value = isPlainObject(read.newValue) ? read.newValue : {};
        const employeeId = stringOrNull(value.employeeId);
        if (employeeId) employeeIds.add(employeeId);
      }
      const employees =
        employeeIds.size === 0
          ? []
          : await app.prisma.employee.findMany({
              where: { id: { in: [...employeeIds] }, tenantId },
              select: { id: true, firstName: true, lastName: true },
            });
      const employeeById = new Map(employees.map((employee) => [employee.id, employee]));

      const reads: TenantSupportAccessReadDto[] = readRows.map((read) => {
        const value = isPlainObject(read.newValue) ? read.newValue : {};
        const employeeId = stringOrNull(value.employeeId);
        const employee = employeeId ? employeeById.get(employeeId) : undefined;
        const anonymized = employee ? isAnonymizedEmployee(employee) : false;
        return {
          at: read.createdAt.toISOString(),
          category: stringOrNull(value.category) ?? "UNKNOWN",
          employee: employeeId
            ? {
                id: employeeId,
                name: employee && !anonymized ? `${employee.firstName} ${employee.lastName}` : null,
                anonymized,
              }
            : null,
          month: stringOrNull(value.month),
          filters: isPlainObject(value.filters) ? value.filters : null,
        };
      });

      return {
        access: toItem(row, reads.length, now),
        reads,
        timezone: await readTenantTimezone(app.prisma, tenantId),
      };
    },
  );

  // POST /api/v1/support-accesses/:id/end
  app.post(
    "/:id/end",
    {
      schema: {
        tags: ["Support-Zugriffe"],
        description:
          "Ends a running support access of the own tenant at once; the operator's next read is refused (whole-tenant tenant-settings:update).",
      },
      preHandler: requirePermission("tenant-settings:update:ZUGEWIESEN"),
    },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const tenantId = req.user.tenantId;
      const now = new Date();
      const audit = requestAuditFields(req, { endedBy: "TENANT", endedAt: now.toISOString() });

      type EndOutcome =
        { status: "NOT_FOUND" } | { status: "NOT_ACTIVE" } | { status: "ENDED"; row: AccessRow };

      const outcome = await app.prisma.$transaction(
        async (tx): Promise<EndOutcome> => {
          // The single transition the database trigger allows: `endedAt` and `endedBy` set once. The
          // guard (`endedAt: null`, `expiresAt > now`) makes a second end and the end of a lapsed
          // access a no-op, and a foreign tenant's id matches nothing.
          const { count } = await tx.supportAccess.updateMany({
            where: { id, tenantId, endedAt: null, expiresAt: { gt: now } },
            data: { endedAt: now, endedBy: "TENANT", endedByUserId: audit.userId ?? null },
          });
          const row = await tx.supportAccess.findFirst({
            where: { id, tenantId },
            include: { operator: { select: { displayName: true } } },
          });
          if (!row) return { status: "NOT_FOUND" };
          if (count === 0) return { status: "NOT_ACTIVE" };

          await app.audit({
            tx,
            action: OPERATOR_AUDIT_ACTIONS.SUPPORT_ACCESS_ENDED,
            entity: "SupportAccess",
            entityId: id,
            ...audit,
          });
          // The tenant acted, so the operator column stays null; the grant's operator and the acting
          // user are named in the value (D-27).
          await recordOperatorAudit(tx, {
            action: OPERATOR_AUDIT_ACTIONS.SUPPORT_ACCESS_ENDED,
            operatorId: null,
            subjectTenantId: tenantId,
            entity: "SupportAccess",
            entityId: id,
            newValue: {
              endedBy: "TENANT",
              endedByUserId: audit.userId ?? null,
              grantOperatorId: row.operatorId,
            },
            request: req,
          });
          return { status: "ENDED", row };
        },
        { timeout: 15_000, maxWait: 15_000 },
      );

      if (outcome.status === "NOT_FOUND") return reply.code(404).send(ACCESS_NOT_FOUND);
      if (outcome.status === "NOT_ACTIVE") {
        return reply.code(409).send({
          error: "Der Support-Zugriff ist nicht mehr aktiv.",
          code: "SUPPORT_ACCESS_NOT_ACTIVE",
        });
      }

      // Reactive: the start notices of this access disappear for every recipient (D-14).
      try {
        await dismissSupportAccessNotices(app, id);
      } catch (err) {
        req.log.warn({ err, accessId: id }, "Support access notice dismissal failed");
      }

      const readCount = await app.prisma.auditLog.count({
        where: {
          entity: "SupportAccess",
          action: OPERATOR_AUDIT_ACTIONS.SUPPORT_DATA_READ,
          entityId: id,
          userId: null,
          newValue: { path: ["actor", "tenantId"], equals: tenantId },
        },
      });
      return reply.code(200).send({ access: toItem(outcome.row, readCount, now) });
    },
  );
}
