/**
 * Operator dashboard (Issue #90, D-01..D-05).
 *
 *   GET /   aggregated, person-free metrics of every tenant
 *
 * Guarded by `requireOperator`. The counts come from ONE place, `operatorTenantMetrics()` of the
 * Unterbau facade; this file never names a person model. The dashboard is the one documented
 * exception to the "no counts in operator responses" rule of #89 D-14a: it serves aggregates only
 * (counts and one calendar day per tenant), never a row, name, id or time of a person.
 *
 * Every successful call writes one `DASHBOARD_VIEWED` operator audit row (Art. 32 DSGVO) inside the
 * same RepeatableRead transaction as the reads, so view and log commit together and a failing audit
 * write fails the request — nothing is served unlogged.
 *
 * Discretion choices:
 * - `lastActivityAt` is served as the UTC calendar day (YYYY-MM-DD), not an instant: in a
 *   one-admin tenant a minute-exact login time would describe one person (Art. 5 Abs. 1 lit. c
 *   DSGVO). The `inactive` flag is computed on full precision before the truncation.
 * - A tenant is `inactive` when it is not deactivated and its newest login is missing or lies MORE
 *   than `OPERATOR_INACTIVITY_DAYS` days before now (exactly 30 days is still active). A
 *   deactivated tenant is never `inactive`.
 * - Deactivated tenants are listed with their counts, but `activeSalons`, `activeEmployees` and
 *   `inactiveTenants` of the totals sum over non-deactivated tenants only.
 */
import type { FastifyInstance } from "fastify";
import { Prisma } from "@clokr/db";
import { config } from "../../../../config";
import { OPERATOR_AUDIT_ACTIONS, recordOperatorAudit } from "../../operator-audit";
import { requireOperator } from "../../operator-auth";
import {
  OPERATOR_INACTIVITY_DAYS,
  operatorTenantMetrics,
  type OperatorTenantMetrics,
} from "../../facade/operator-metrics";

const readRateLimit = {
  rateLimit: { max: config.NODE_ENV === "test" ? 1000 : 60, timeWindow: "1 minute" },
};

const DAY_MS = 24 * 60 * 60 * 1000;

type TenantMetadata = { id: string; name: string; slug: string; deactivatedAt: Date | null };

export type OperatorDashboardTenantItem = {
  id: string;
  name: string;
  slug: string;
  deactivatedAt: string | null;
  activeSalons: number;
  totalSalons: number;
  activeEmployees: number;
  lastActivityAt: string | null;
  inactive: boolean;
};

export type OperatorDashboardBody = {
  inactivityDays: number;
  totals: {
    tenants: number;
    activeTenants: number;
    deactivatedTenants: number;
    activeSalons: number;
    activeEmployees: number;
    inactiveTenants: number;
  };
  tenants: OperatorDashboardTenantItem[];
};

function isInactive(deactivatedAt: Date | null, lastActivityAt: Date | null, now: Date): boolean {
  if (deactivatedAt) return false;
  if (!lastActivityAt) return true;
  return now.getTime() - lastActivityAt.getTime() > OPERATOR_INACTIVITY_DAYS * DAY_MS;
}

/** Pure body builder (explicit keys only, never a spread of a row); `now` is injected for tests. */
export function buildOperatorDashboardBody(
  tenants: TenantMetadata[],
  metrics: OperatorTenantMetrics[],
  now: Date,
): OperatorDashboardBody {
  const metricsByTenant = new Map(metrics.map((m) => [m.tenantId, m]));
  const items = tenants.map((tenant): OperatorDashboardTenantItem => {
    const metric = metricsByTenant.get(tenant.id);
    if (!metric) {
      throw new Error("Operator dashboard: tenant without metrics inside one snapshot");
    }
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      deactivatedAt: tenant.deactivatedAt ? tenant.deactivatedAt.toISOString() : null,
      activeSalons: metric.activeSalons,
      totalSalons: metric.totalSalons,
      activeEmployees: metric.activeEmployees,
      lastActivityAt: metric.lastActivityAt
        ? metric.lastActivityAt.toISOString().slice(0, 10)
        : null,
      inactive: isInactive(tenant.deactivatedAt, metric.lastActivityAt, now),
    };
  });
  const live = items.filter((item) => item.deactivatedAt === null);
  return {
    inactivityDays: OPERATOR_INACTIVITY_DAYS,
    totals: {
      tenants: items.length,
      activeTenants: live.length,
      deactivatedTenants: items.length - live.length,
      activeSalons: live.reduce((sum, item) => sum + item.activeSalons, 0),
      activeEmployees: live.reduce((sum, item) => sum + item.activeEmployees, 0),
      inactiveTenants: items.filter((item) => item.inactive).length,
    },
    tenants: items,
  };
}

export async function operatorDashboardRoutes(app: FastifyInstance) {
  app.get("/", {
    config: readRateLimit,
    schema: {
      tags: ["Betreiber"],
      description:
        "Aggregated, person-free metrics of every tenant (salon and employee counts, day of the last login, inactivity flag); every call is logged.",
    },
    preHandler: requireOperator,
    handler: async (req) => {
      const now = new Date();
      return app.prisma.$transaction(
        async (tx) => {
          const tenants = await tx.tenant.findMany({
            select: { id: true, name: true, slug: true, deactivatedAt: true },
            orderBy: [{ name: "asc" }, { id: "asc" }],
          });
          const metrics = await operatorTenantMetrics(tx, now);
          const body = buildOperatorDashboardBody(tenants, metrics, now);
          await recordOperatorAudit(tx, {
            action: OPERATOR_AUDIT_ACTIONS.DASHBOARD_VIEWED,
            operatorId: req.operator.sub,
            entity: "OperatorDashboard",
            request: req,
          });
          return body;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    },
  });
}
