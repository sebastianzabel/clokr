import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";

/**
 * GET /api/v1/activity?limit=5
 *
 * Returns role-gated recent events for the dashboard "Aktivität" widget.
 *
 * EMPLOYEE: only own events
 *   - Own time-entry clock-ins/clock-outs
 *   - Status changes on own leave requests (submitted / approved / rejected)
 *   - Own monthly close snapshots (SaldoSnapshot)
 *
 * MANAGER: own events + team events within the same tenant
 *   - Leave approvals/rejections the manager performed
 *   - Team leave requests submitted (any pending/approved/rejected leave in tenant)
 *
 * ADMIN: full audit-log feed (last 7 days, same tenant via user.tenantId on the actor)
 */

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export interface ActivityItem {
  id: string;
  icon: "check" | "clock" | "inbox" | "edit" | "lock" | "info" | "x";
  who: string;
  what: string;
  when: string; // ISO timestamp
  category: "time" | "leave" | "close" | "audit";
}

export async function activityRoutes(app: FastifyInstance) {
  app.get(
    "/",
    {
      schema: {
        tags: ["Dashboard"],
        summary: "Recent activity feed (role-gated)",
        security: [{ bearerAuth: [] }],
      },
      preHandler: requireAuth,
    },
    async (req, _reply) => {
      const { limit } = querySchema.parse(req.query);
      const role = req.user.role;
      const tenantId = req.user.tenantId;
      const userId = req.user.sub;
      const employeeId = req.user.employeeId ?? null;

      const items: ActivityItem[] = [];

      // ── ADMIN: full audit-log feed (last 7 days) ─────────────────────────
      if (role === "ADMIN") {
        const since = new Date();
        since.setDate(since.getDate() - 7);

        const logs = await app.prisma.auditLog.findMany({
          where: {
            createdAt: { gte: since },
            // Scope to tenant via the actor's Employee.tenantId
            // (User has no tenantId; tenant lives on Employee)
            user: { employee: { tenantId } },
          },
          orderBy: { createdAt: "desc" },
          take: limit,
          include: {
            user: {
              select: {
                email: true,
                employee: { select: { firstName: true, lastName: true } },
              },
            },
          },
        });

        for (const log of logs) {
          const actor = log.user?.employee
            ? `${log.user.employee.firstName} ${log.user.employee.lastName}`.trim()
            : (log.user?.email ?? "System");
          items.push({
            id: log.id,
            icon: mapActionToIcon(log.action),
            who: actor,
            what: describeAuditAction(log.action, log.entity),
            when: log.createdAt.toISOString(),
            category: "audit",
          });
        }
        return { items };
      }

      // ── EMPLOYEE / MANAGER: build from domain tables ─────────────────────
      const fetchLimit = Math.max(limit * 2, 10); // over-fetch then trim

      // Own time entries (today + last 7 days)
      if (employeeId) {
        const since = new Date();
        since.setDate(since.getDate() - 7);
        const entries = await app.prisma.timeEntry.findMany({
          where: {
            employeeId,
            deletedAt: null,
            createdAt: { gte: since },
          },
          orderBy: { createdAt: "desc" },
          take: fetchLimit,
        });
        for (const e of entries) {
          const startHHMM = e.startTime.toISOString().substring(11, 16);
          items.push({
            id: `te-${e.id}`,
            icon: "clock",
            who: "Du",
            what: e.endTime
              ? `Ausstempeln um ${e.endTime.toISOString().substring(11, 16)}`
              : `Einstempeln um ${startHHMM}`,
            when: e.createdAt.toISOString(),
            category: "time",
          });
        }

        // Own leave requests (recent status changes)
        const myLeaves = await app.prisma.leaveRequest.findMany({
          where: { employeeId, deletedAt: null },
          orderBy: { updatedAt: "desc" },
          take: fetchLimit,
          include: { leaveType: { select: { name: true } } },
        });
        for (const lr of myLeaves) {
          const typeName = lr.leaveType?.name ?? "Urlaub";
          let what: string;
          let icon: ActivityItem["icon"];
          if (lr.status === "APPROVED") {
            what = `${typeName} genehmigt`;
            icon = "check";
          } else if (lr.status === "REJECTED") {
            what = `${typeName} abgelehnt`;
            icon = "x";
          } else if (lr.status === "CANCELLED") {
            what = `${typeName} storniert`;
            icon = "x";
          } else if (lr.status === "CANCELLATION_REQUESTED") {
            what = `Stornierung beantragt (${typeName})`;
            icon = "inbox";
          } else {
            what = `${typeName} eingereicht`;
            icon = "inbox";
          }
          items.push({
            id: `lr-${lr.id}`,
            icon,
            who: "Du",
            what,
            when: lr.updatedAt.toISOString(),
            category: "leave",
          });
        }

        // Own monthly close snapshots
        const snapshots = await app.prisma.saldoSnapshot.findMany({
          where: { employeeId, periodType: "MONTHLY" },
          orderBy: { closedAt: "desc" },
          take: fetchLimit,
        });
        for (const s of snapshots) {
          const month = s.periodStart.toLocaleDateString("de-DE", {
            month: "long",
            year: "numeric",
          });
          items.push({
            id: `ss-${s.id}`,
            icon: "lock",
            who: "System",
            what: `Monatsabschluss ${month} bestätigt`,
            when: s.closedAt.toISOString(),
            category: "close",
          });
        }
      }

      // ── MANAGER: also include team events in tenant ──────────────────────
      if (role === "MANAGER") {
        // Leave approvals / rejections this manager performed
        const myReviews = await app.prisma.leaveRequest.findMany({
          where: {
            reviewedBy: userId,
            deletedAt: null,
            status: { in: ["APPROVED", "REJECTED"] },
            // Defense in depth (CLAUDE.md § Multi-Tenancy Convention): also
            // scope by tenant on the related employee. Today reviewedBy is
            // already tenant-bound by the regular review flow, but guarding
            // here prevents an impersonation bug elsewhere from leaking
            // cross-tenant review rows through this read.
            employee: { tenantId },
          },
          orderBy: { reviewedAt: "desc" },
          take: fetchLimit,
          include: {
            leaveType: { select: { name: true } },
            employee: { select: { firstName: true, lastName: true } },
          },
        });
        for (const lr of myReviews) {
          if (!lr.reviewedAt) continue;
          const empName = `${lr.employee.firstName} ${lr.employee.lastName}`.trim();
          const typeName = lr.leaveType?.name ?? "Urlaub";
          items.push({
            id: `rev-${lr.id}`,
            icon: lr.status === "APPROVED" ? "check" : "x",
            who: empName,
            what: lr.status === "APPROVED" ? `${typeName}: Genehmigt` : `${typeName}: Abgelehnt`,
            when: lr.reviewedAt.toISOString(),
            category: "leave",
          });
        }

        // Recent team leave submissions (tenant-wide)
        const teamLeaves = await app.prisma.leaveRequest.findMany({
          where: {
            deletedAt: null,
            employee: { tenantId },
            employeeId: employeeId ? { not: employeeId } : undefined,
          },
          orderBy: { createdAt: "desc" },
          take: fetchLimit,
          include: {
            leaveType: { select: { name: true } },
            employee: { select: { firstName: true, lastName: true } },
          },
        });
        for (const lr of teamLeaves) {
          const empName = `${lr.employee.firstName} ${lr.employee.lastName}`.trim();
          const typeName = lr.leaveType?.name ?? "Urlaub";
          items.push({
            id: `tlr-${lr.id}`,
            icon: "inbox",
            who: empName,
            what: `hat einen ${typeName}-Antrag eingereicht`,
            when: lr.createdAt.toISOString(),
            category: "leave",
          });
        }
      }

      // Sort all items by when desc, dedupe by id, trim to limit
      items.sort((a, b) => b.when.localeCompare(a.when));
      const seen = new Set<string>();
      const deduped: ActivityItem[] = [];
      for (const it of items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        deduped.push(it);
        if (deduped.length >= limit) break;
      }

      return { items: deduped };
    },
  );
}

// ── helpers ───────────────────────────────────────────────────────────────

function mapActionToIcon(action: string): ActivityItem["icon"] {
  switch (action) {
    case "CREATE":
      return "inbox";
    case "UPDATE":
      return "edit";
    case "DELETE":
      return "x";
    case "APPROVE":
      return "check";
    case "REJECT":
      return "x";
    case "LOCK":
    case "UNLOCK":
      return "lock";
    case "LOGIN":
      return "clock";
    case "EXPORT":
      return "edit";
    default:
      return "info";
  }
}

function describeAuditAction(action: string, entity: string): string {
  const entityLabel: Record<string, string> = {
    TimeEntry: "Zeiteintrag",
    LeaveRequest: "Urlaubsantrag",
    Employee: "Mitarbeiter",
    SaldoSnapshot: "Monatsabschluss",
    Absence: "Abwesenheit",
    User: "Benutzer",
    Tenant: "Mandant",
  };
  const labelEntity = entityLabel[entity] ?? entity;
  switch (action) {
    case "CREATE":
      return `${labelEntity} angelegt`;
    case "UPDATE":
      return `${labelEntity} aktualisiert`;
    case "DELETE":
      return `${labelEntity} gelöscht`;
    case "APPROVE":
      return `${labelEntity} genehmigt`;
    case "REJECT":
      return `${labelEntity} abgelehnt`;
    case "LOCK":
      return `${labelEntity} gesperrt`;
    case "UNLOCK":
      return `${labelEntity} entsperrt`;
    case "LOGIN":
      return "Anmeldung";
    case "EXPORT":
      return `${labelEntity} exportiert`;
    default:
      return `${action} · ${labelEntity}`;
  }
}
