import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../request-permissions";
import {
  attachAffectedEmployees,
  auditExportQuerySchema,
  auditFilterQuerySchema,
  auditFilterWhere,
  auditTenantTimezone,
  inclusiveDayCount,
  periodBounds,
} from "../audit-log-read";
import { AUDIT_CSV_MAX_ROWS, auditCsvFilename, auditLogCsv } from "../audit-csv";

/** Longest period one CSV export may span, in calendar days. */
const AUDIT_EXPORT_MAX_DAYS = 366;

const idParamSchema = z.object({
  id: z.string().min(1),
});

/*
 * Tenant scope of an AuditLog read — the same two-branch `OR` is spelled inline in both reads below
 * (the tenant-scoping gate does not follow helper functions, so a shared builder would hide the
 * constraint from it):
 *   1. rows written by a tenant user (`AuditLog.userId` → `User.employee.tenantId`; the User has
 *      no tenantId of its own, the tenant is reached through the Employee 1:1 relation);
 *   2. rows written by the operator principal (Phase 89, D-09a). They have no user, so the first
 *      branch can never match them. `operator-tenant-audit.ts` stamps `newValue.actor.tenantId`
 *      on every such row, and the second branch matches exactly that stamp.
 * Operator rows written before Phase 89 carry no stamp and stay invisible to every tenant
 * (append-only, deliberately not backfilled; a real `AuditLog.tenantId` column is the deferred
 * long-term model). A stamp naming another tenant matches nothing here.
 */

export async function auditLogRoutes(app: FastifyInstance) {
  // GET /audit-logs — audit-log:read (legacy: ADMIN only), paginated, tenant-scoped
  app.get(
    "/",
    { preHandler: requirePermission("audit-log:read:ZUGEWIESEN") },
    async (req, _reply) => {
      const {
        page = "1",
        limit = "50",
        from,
        to,
        ...filters
      } = auditFilterQuerySchema.parse(req.query);

      const take = Math.min(parseInt(limit), 200);
      const skip = (parseInt(page) - 1) * take;

      const tenantId = req.user.tenantId;
      // The period is read in the tenant's own time zone, so it is looked up only when it is used.
      const bounds =
        from || to ? periodBounds(from, to, await auditTenantTimezone(app.prisma, tenantId)) : {};
      // The tenant scope sits in its own AND member, so no optional filter (a `userId` or an
      // `employeeId` included) can ever widen the set.
      const where = {
        AND: [
          {
            OR: [
              { user: { employee: { tenantId } } },
              { userId: null, newValue: { path: ["actor", "tenantId"], equals: tenantId } },
            ],
          },
          auditFilterWhere(filters, bounds),
        ],
      };

      const [logs, total] = await Promise.all([
        app.prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take,
          skip,
          include: {
            user: { select: { email: true } },
          },
        }),
        app.prisma.auditLog.count({ where }),
      ]);

      return {
        logs: await attachAffectedEmployees(app.prisma, tenantId, logs),
        total,
        page: parseInt(page),
        limit: take,
      };
    },
  );

  // GET /audit-logs/export?from=&to=[&action=&entity=&userId=&employeeId=] - audit-log:read.
  // The filtered protocol as a spreadsheet file (Issue #583): the same parser, the same tenant `OR`
  // and the same filter clause as the list, so the file holds exactly what the list shows. It is an
  // export of personal data: the successful download is audited BEFORE the bytes leave; a refusal
  // (400, 403) writes nothing. Registered as a static path, which the router prefers to `/:id`.
  app.get(
    "/export",
    {
      schema: {
        tags: ["Audit"],
        security: [{ bearerAuth: [] }],
        description:
          "CSV export of the audit log: the list of GET /audit-logs for a mandatory period (from, to as tenant-local days, at most 366 days) and the optional filters action, entity, userId and employeeId, as UTF-8 with BOM, semicolon separated, with every action and object as German label and as code. At most 10000 rows. Old and new values are not exported. Audited as EXPORT (AUDIT_LOG_CSV) before the file is sent.",
      },
      preHandler: requirePermission("audit-log:read:ZUGEWIESEN"),
    },
    async (req, reply) => {
      const { from, to, ...filters } = auditExportQuerySchema.parse(req.query);
      if (inclusiveDayCount(from, to) > AUDIT_EXPORT_MAX_DAYS) {
        return reply.code(400).send({ error: "Der Zeitraum darf höchstens 366 Tage umfassen." });
      }
      const tenantId = req.user.tenantId;
      const tz = await auditTenantTimezone(app.prisma, tenantId);
      const where = {
        AND: [
          {
            OR: [
              { user: { employee: { tenantId } } },
              { userId: null, newValue: { path: ["actor", "tenantId"], equals: tenantId } },
            ],
          },
          auditFilterWhere(filters, periodBounds(from, to, tz)),
        ],
      };

      // Count first: a set above the cap is refused before anything is read or written.
      const total = await app.prisma.auditLog.count({ where });
      if (total > AUDIT_CSV_MAX_ROWS) {
        return reply
          .code(400)
          .send({ error: "Zu viele Einträge für einen Export. Wähle einen kürzeren Zeitraum." });
      }

      const logs = await app.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: AUDIT_CSV_MAX_ROWS,
        include: { user: { select: { email: true } } },
      });
      const rows = await attachAffectedEmployees(app.prisma, tenantId, logs);

      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "AuditLog",
        newValue: {
          type: "AUDIT_LOG_CSV",
          from,
          to,
          action: filters.action ?? null,
          entity: filters.entity ?? null,
          userId: filters.userId ?? null,
          employeeId: filters.employeeId ?? null,
          rowCount: rows.length,
        },
      });
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${auditCsvFilename(from, to)}"`);
      return reply.send(auditLogCsv(rows, tz));
    },
  );

  // GET /audit-logs/:id — audit-log:read (legacy: ADMIN only), single entry, tenant-scoped
  app.get(
    "/:id",
    { preHandler: requirePermission("audit-log:read:ZUGEWIESEN") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const tenantId = req.user.tenantId;

      const log = await app.prisma.auditLog.findFirst({
        where: {
          id,
          OR: [
            { user: { employee: { tenantId } } },
            { userId: null, newValue: { path: ["actor", "tenantId"], equals: tenantId } },
          ],
        },
        include: {
          user: { select: { email: true } },
        },
      });

      if (!log) {
        return reply.code(404).send({ error: "Audit-Eintrag nicht gefunden" });
      }

      const [withEmployee] = await attachAffectedEmployees(app.prisma, tenantId, [log]);
      return withEmployee;
    },
  );
}
