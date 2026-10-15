/**
 * Issue #90 — the aggregated, person-free tenant metrics of the operator dashboard.
 *
 * `operatorTenantMetrics()` is the ONLY producer of operator-facing counts (D-01). It is
 * cross-tenant by design, because the operator principal sits above the tenant, and it takes no
 * client input. It returns numbers and one timestamp per tenant — never a row, a name, the id of a
 * person, a time entry or a saldo. The operator route files stay blind to person data: they call
 * this function and never name a person model themselves.
 *
 * Rules:
 * - A constant number of grouped statements, independent of the tenant count (no N+1): one tenant
 *   id read, two salon groupings, one employee grouping and one aggregate over the logins.
 * - `activeEmployees` follows the active-workforce rule of #569: not anonymized
 *   (`NOT_ANONYMIZED_EMPLOYEE_WHERE`) and `exitDate` null or on/after the start of the current UTC
 *   day. The UTC day is the operator-level "today"; a few hours of time-zone slack are irrelevant
 *   for a coarse count.
 * - `lastActivityAt` is the newest `User.lastLoginAt` over the tenant's users (a user belongs to a
 *   tenant through its Employee row). Employees that are anonymized (same sentinel as
 *   `NOT_ANONYMIZED_EMPLOYEE_WHERE`) are excluded here too: an erased person's data must not feed
 *   any figure (Art. 17 DSGVO). It is a tenant-level moment, never WHICH user.
 * - No TimeEntry is read (context boundary), so a tenant that only clocks at terminals without any
 *   login shows as inactive. Known limit.
 *
 * Deliberately NOT re-exported from `contexts/platform/index.ts`: only the operator routes inside
 * the platform context use it.
 */
import type { Prisma } from "@clokr/db";
import { NOT_ANONYMIZED_EMPLOYEE_WHERE } from "../employee-anonymization-filter";

/** The one place the inactivity threshold lives; the route serves it so the web never hard-codes it. */
export const OPERATOR_INACTIVITY_DAYS = 30;

export type OperatorTenantMetrics = {
  tenantId: string;
  activeSalons: number;
  totalSalons: number;
  activeEmployees: number;
  lastActivityAt: Date | null;
};

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function operatorTenantMetrics(
  db: Prisma.TransactionClient,
  now: Date,
): Promise<OperatorTenantMetrics[]> {
  const today = startOfUtcDay(now);

  const [tenants, totalSalons, activeSalons, activeEmployees, logins] = await Promise.all([
    db.tenant.findMany({ select: { id: true } }),
    db.salon.groupBy({ by: ["tenantId"], _count: { _all: true } }),
    db.salon.groupBy({ by: ["tenantId"], where: { isActive: true }, _count: { _all: true } }),
    db.employee.groupBy({
      by: ["tenantId"],
      where: {
        ...NOT_ANONYMIZED_EMPLOYEE_WHERE,
        OR: [{ exitDate: null }, { exitDate: { gte: today } }],
      },
      _count: { _all: true },
    }),
    db.$queryRaw<Array<{ tenantId: string; lastLoginAt: Date | null }>>`
      SELECT e."tenantId" AS "tenantId", MAX(u."lastLoginAt") AS "lastLoginAt"
      FROM "Employee" e
      JOIN "User" u ON u."id" = e."userId"
      WHERE NOT (e."firstName" = 'Gelöscht' AND e."lastName" LIKE 'GELÖSCHT-%')
      GROUP BY e."tenantId"
    `,
  ]);

  const countOf = (rows: Array<{ tenantId: string; _count: { _all: number } }>) =>
    new Map(rows.map((row) => [row.tenantId, row._count._all]));
  const totalByTenant = countOf(totalSalons);
  const activeSalonsByTenant = countOf(activeSalons);
  const employeesByTenant = countOf(activeEmployees);
  const loginByTenant = new Map(
    logins.map((row) => [
      String(row.tenantId),
      row.lastLoginAt instanceof Date ? row.lastLoginAt : null,
    ]),
  );

  return tenants
    .map((tenant) => ({
      tenantId: tenant.id,
      activeSalons: activeSalonsByTenant.get(tenant.id) ?? 0,
      totalSalons: totalByTenant.get(tenant.id) ?? 0,
      activeEmployees: employeesByTenant.get(tenant.id) ?? 0,
      lastActivityAt: loginByTenant.get(tenant.id) ?? null,
    }))
    .sort((a, b) => (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0));
}
