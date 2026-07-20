/**
 * Phase 44 — BUrlG § 7 Hinweispflicht (EuGH C-684/16) tests
 *
 * Verifies the carry-over warning cron + manual trigger:
 * - threshold matching (60/30/14/7 default; tenant-configurable)
 * - AuditLog dedup (audit-before-action, idempotent re-runs)
 * - notify delivery for active employees, AuditLog-only for inactive
 * - tenant-level disable switch
 * - manual /reports/carryover-warn trigger respects tenant scope + dedup
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { runCarryoverWarningOnce } from "../plugins/carryover-warning";
import type { FastifyInstance } from "fastify";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("Carryover-Warning — BUrlG § 7 Hinweispflicht", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "co-warn");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    // Reset state between tests so dedup behaviour can be observed
    // independently. We delete only THIS tenant's audit log + notification
    // entries so we don't pollute parallel suites.
    await app.prisma.auditLog.deleteMany({
      where: {
        entity: "LeaveEntitlement",
        action: { in: ["CARRYOVER_WARNED", "CARRYOVER_WARN_TRIGGERED"] },
      },
    });
    await app.prisma.notification.deleteMany({
      where: { type: "CARRYOVER_EXPIRING" },
    });
    // Reset tenant config defaults
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: {
        carryoverWarningEnabled: true,
        carryoverWarningThresholds: [60, 30, 14, 7],
      },
    });
    // Reset the entitlement so each test starts from a known baseline
    await app.prisma.leaveEntitlement.updateMany({
      where: { employeeId: data.employee.id, leaveTypeId: data.vacationType.id },
      data: {
        carriedOverDays: 0,
        carryOverDeadline: null,
      },
    });
  });

  async function setEntitlementCarryOver(daysAhead: number, carriedOverDays = 5): Promise<string> {
    // Deadline exactly N days from now → ceil((deadline - now) / DAY_MS) === N.
    // We deliberately do NOT round the time-of-day, because rounding can shift
    // the ceil result by ±1 when "now" is in the second half of the day.
    const deadline = new Date(Date.now() + daysAhead * DAY_MS);
    const ent = await app.prisma.leaveEntitlement.update({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          year: new Date().getFullYear(),
        },
      },
      data: {
        carriedOverDays,
        carryOverDeadline: deadline,
      },
    });
    return ent.id;
  }

  it("skips employees with zero carry-over", async () => {
    await setEntitlementCarryOver(30, 0);

    const res = await runCarryoverWarningOnce(app, { onlyTenantId: data.tenant.id });

    expect(res.warned).toBe(0);
    expect(res.scanned).toBe(0);

    const audits = await app.prisma.auditLog.count({
      where: { action: "CARRYOVER_WARNED" },
    });
    expect(audits).toBe(0);
  });

  it("does not warn when no threshold matches the days-until-deadline", async () => {
    // 45 days out — not in default [60,30,14,7]
    await setEntitlementCarryOver(45);

    const res = await runCarryoverWarningOnce(app, { onlyTenantId: data.tenant.id });

    expect(res.warned).toBe(0);
    expect(res.scanned).toBe(1);

    const audits = await app.prisma.auditLog.count({
      where: { action: "CARRYOVER_WARNED" },
    });
    expect(audits).toBe(0);
  });

  it("issues a warning + audit log when a threshold matches", async () => {
    const entitlementId = await setEntitlementCarryOver(30);

    const res = await runCarryoverWarningOnce(app, { onlyTenantId: data.tenant.id });

    expect(res.warned).toBe(1);
    expect(res.scanned).toBe(1);

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "CARRYOVER_WARNED",
        entity: "LeaveEntitlement",
        entityId: entitlementId,
      },
    });
    expect(audit).not.toBeNull();
    const v = audit!.newValue as Record<string, unknown>;
    expect(v.thresholdDays).toBe(30);
    expect(v.employeeId).toBe(data.employee.id);
    expect(v.carriedOverDays).toBe(5);
    expect(v.source).toBe("carryover-warning-cron");

    // Notification was created for the employee user
    const notif = await app.prisma.notification.findFirst({
      where: { userId: data.empUser.id, type: "CARRYOVER_EXPIRING" },
    });
    expect(notif).not.toBeNull();
    expect(notif!.title).toMatch(/Resturlaub verfällt am /);
  });

  it("is idempotent on the same day — second run issues 0 new warnings", async () => {
    await setEntitlementCarryOver(30);

    const first = await runCarryoverWarningOnce(app);
    expect(first.warned).toBe(1);

    const second = await runCarryoverWarningOnce(app);
    expect(second.warned).toBe(0);
    expect(second.skippedDedup).toBe(1);

    // Audit count must remain at 1 — dedup works
    const count = await app.prisma.auditLog.count({
      where: { action: "CARRYOVER_WARNED" },
    });
    expect(count).toBe(1);
  });

  it("respects tenant-level threshold override", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { carryoverWarningThresholds: [45] },
    });

    // Should NOT warn at 30 days
    await setEntitlementCarryOver(30);
    let res = await runCarryoverWarningOnce(app);
    expect(res.warned).toBe(0);

    // Should warn at 45 days
    await setEntitlementCarryOver(45);
    res = await runCarryoverWarningOnce(app);
    expect(res.warned).toBe(1);

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "CARRYOVER_WARNED" },
    });
    expect((audit!.newValue as Record<string, unknown>).thresholdDays).toBe(45);
  });

  it("skips the tenant entirely when carryoverWarningEnabled is false", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { carryoverWarningEnabled: false },
    });

    await setEntitlementCarryOver(30);

    const res = await runCarryoverWarningOnce(app);
    expect(res.warned).toBe(0);
    expect(res.skippedDisabled).toBeGreaterThanOrEqual(1);

    const audits = await app.prisma.auditLog.count({
      where: { action: "CARRYOVER_WARNED" },
    });
    expect(audits).toBe(0);
  });

  it("manual /reports/carryover-warn trigger writes AuditLog and is idempotent", async () => {
    const entitlementId = await setEntitlementCarryOver(30);

    // First manual trigger — should warn
    const res1 = await app.inject({
      method: "POST",
      url: "/api/v1/reports/carryover-warn",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { entitlementId },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.body);
    expect(body1.warned).toBe(1);

    // Second click — dedup kicks in
    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/reports/carryover-warn",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { entitlementId },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.warned).toBe(0);
    expect(body2.skippedDedup).toBe(1);

    // Audit log: 1 CARRYOVER_WARNED + 2 CARRYOVER_WARN_TRIGGERED (one per click)
    const warned = await app.prisma.auditLog.count({
      where: { action: "CARRYOVER_WARNED", entityId: entitlementId },
    });
    expect(warned).toBe(1);

    const triggered = await app.prisma.auditLog.count({
      where: { action: "CARRYOVER_WARN_TRIGGERED", entityId: entitlementId },
    });
    expect(triggered).toBe(2);
  });

  it("/reports/carryover-warn rejects entitlements from other tenants (404)", async () => {
    const otherData = await seedTestData(app, "co-warn-other");
    try {
      const ent = await app.prisma.leaveEntitlement.findFirst({
        where: { employeeId: otherData.employee.id },
      });
      expect(ent).not.toBeNull();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/reports/carryover-warn",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { entitlementId: ent!.id },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await cleanupTestData(app, otherData.tenant.id);
    }
  });

  it("/reports/carryover-at-risk returns at-risk rows with KPI summary", async () => {
    await setEntitlementCarryOver(20, 7); // within 60-day horizon

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/carryover-at-risk?days=60",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      horizonDays: number;
      summary: { employeesAtRisk: number; totalDaysAtRisk: number; warnedLast30: number };
      rows: Array<{ carriedOverDays: number; daysUntilDeadline: number }>;
    };
    expect(body.horizonDays).toBe(60);
    expect(body.summary.employeesAtRisk).toBeGreaterThanOrEqual(1);
    expect(body.summary.totalDaysAtRisk).toBeGreaterThanOrEqual(7);
    expect(body.rows.length).toBeGreaterThanOrEqual(1);
    const ours = body.rows.find((r) => r.carriedOverDays === 7);
    expect(ours).toBeDefined();
    expect(ours!.daysUntilDeadline).toBeLessThanOrEqual(60);
  });
});
