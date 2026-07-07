/**
 * Company Shutdowns — Audit Coverage (COMP-V1814-06)
 *
 * Verifies that every mutating endpoint on /api/v1/company-shutdowns writes an
 * AuditLog row with the required fields. Strategy: capture beforeTs before each
 * mutation, filter AuditLog by createdAt >= beforeTs to isolate produced logs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Company Shutdowns — audit coverage", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let shutdownId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cs-audit");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("company-shutdowns test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("audit coverage — company shutdown CREATE writes AuditLog", async () => {
    const beforeTs = new Date();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/company-shutdowns",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        name: "Betriebsurlaub Sommer",
        startDate: "2025-08-01",
        endDate: "2025-08-15",
        deductsFromVacation: true,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    shutdownId = body.id;

    const logs = await app.prisma.auditLog.findMany({
      where: {
        entity: "CompanyShutdown",
        action: "CREATE",
        entityId: shutdownId,
        createdAt: { gte: beforeTs },
      },
    });

    expect(logs.length).toBeGreaterThanOrEqual(1);
    const log = logs[0];
    expect(log.userId).toBe(data.adminUser.id);
    expect(log.action).toBe("CREATE");
    expect(log.entity).toBe("CompanyShutdown");
    expect(log.entityId).toBe(shutdownId);
    expect(log.newValue).toBeDefined();
  });

  it("audit coverage — company shutdown UPDATE writes AuditLog", async () => {
    if (!shutdownId) {
      console.warn("Skipping: no shutdown created by previous test");
      return;
    }

    const beforeTs = new Date();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/company-shutdowns/${shutdownId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { name: "Betriebsurlaub Sommer (geändert)" },
    });

    expect(res.statusCode).toBe(200);

    const logs = await app.prisma.auditLog.findMany({
      where: {
        entity: "CompanyShutdown",
        action: "UPDATE",
        entityId: shutdownId,
        createdAt: { gte: beforeTs },
      },
    });

    expect(logs.length).toBeGreaterThanOrEqual(1);
    const log = logs[0];
    expect(log.userId).toBe(data.adminUser.id);
    expect(log.action).toBe("UPDATE");
    expect(log.entity).toBe("CompanyShutdown");
    expect(log.oldValue).toBeDefined();
    expect(log.newValue).toBeDefined();
  });

  it("audit coverage — company shutdown DELETE writes AuditLog", async () => {
    if (!shutdownId) {
      console.warn("Skipping: no shutdown created by previous test");
      return;
    }

    const beforeTs = new Date();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/company-shutdowns/${shutdownId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect([204]).toContain(res.statusCode);

    const logs = await app.prisma.auditLog.findMany({
      where: {
        entity: "CompanyShutdown",
        action: "DELETE",
        entityId: shutdownId,
        createdAt: { gte: beforeTs },
      },
    });

    expect(logs.length).toBeGreaterThanOrEqual(1);
    const log = logs[0];
    expect(log.userId).toBe(data.adminUser.id);
    expect(log.action).toBe("DELETE");
    expect(log.entity).toBe("CompanyShutdown");
    expect(log.oldValue).toBeDefined();
  });
});
