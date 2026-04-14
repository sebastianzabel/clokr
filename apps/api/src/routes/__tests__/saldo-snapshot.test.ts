import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";

/**
 * Tests for POST /api/v1/overtime/unlock-month
 * Verifies: role enforcement, tenant isolation, atomic unlock transaction
 */
describe("POST /overtime/unlock-month", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "snap");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  it("returns 403 when called with EMPLOYEE role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/unlock-month",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: {
        employeeId: data.employee.id,
        year: 2024,
        month: 1,
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it("returns 404 when no snapshot exists for the month", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/unlock-month",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        year: 2024,
        month: 5, // May 2024 — no snapshot exists
      },
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Monat ist nicht abgeschlossen");
  });

  it("returns 404 for employeeId from a different tenant (tenant isolation)", async () => {
    // Create a second tenant + employee
    const otherTenant = await app.prisma.tenant.create({
      data: {
        name: "Other Tenant Snap",
        slug: `other-snap-${Date.now()}`,
        federalState: "BERLIN",
      },
    });
    await app.prisma.tenantConfig.create({
      data: { tenantId: otherTenant.id, defaultVacationDays: 20, timezone: "Europe/Berlin" },
    });
    const hash = await bcrypt.hash("test1234", 10);
    const otherUser = await app.prisma.user.create({
      data: {
        email: `other-snap-${Date.now()}@test.de`,
        passwordHash: hash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const otherEmp = await app.prisma.employee.create({
      data: {
        tenantId: otherTenant.id,
        userId: otherUser.id,
        employeeNumber: "OE-1",
        firstName: "Other",
        lastName: "Emp",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: otherEmp.id, balanceHours: 0 } });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/unlock-month",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: otherEmp.id, // cross-tenant employee
          year: 2024,
          month: 1,
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("Mitarbeiter nicht gefunden");
    } finally {
      await app.prisma.overtimeAccount.deleteMany({ where: { employeeId: otherEmp.id } });
      await app.prisma.employee.delete({ where: { id: otherEmp.id } });
      await app.prisma.user.delete({ where: { id: otherUser.id } });
      await app.prisma.tenantConfig.deleteMany({ where: { tenantId: otherTenant.id } });
      await app.prisma.tenant.delete({ where: { id: otherTenant.id } });
    }
  });

  it("deletes snapshot, unlocks entries, returns 200 on valid admin unlock", async () => {
    // Europe/Berlin UTC+1 in January 2024: Jan 1 00:00 Berlin = Dec 31 23:00 UTC
    const monthStart = new Date("2023-12-31T23:00:00Z");
    const monthEnd = new Date("2024-01-31T22:59:59Z");

    // Create a snapshot (simulating a closed month)
    const snapshot = await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: monthStart,
        periodEnd: monthEnd,
        workedMinutes: 1600,
        expectedMinutes: 1600,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });

    // Create a locked time entry in that month
    const lockedEntry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: new Date("2024-01-15T00:00:00Z"),
        startTime: new Date("2024-01-15T08:00:00Z"),
        endTime: new Date("2024-01-15T16:00:00Z"),
        breakMinutes: 30,
        source: "MANUAL",
        isLocked: true,
        lockedAt: new Date(),
      },
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/unlock-month",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          year: 2024,
          month: 1,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.message).toBe("Monat entsperrt");

      // Verify snapshot was deleted
      const deletedSnap = await app.prisma.saldoSnapshot.findUnique({
        where: { id: snapshot.id },
      });
      expect(deletedSnap).toBeNull();

      // Verify time entry was unlocked
      const updatedEntry = await app.prisma.timeEntry.findUnique({
        where: { id: lockedEntry.id },
      });
      expect(updatedEntry?.isLocked).toBe(false);
      expect(updatedEntry?.lockedAt).toBeNull();
    } finally {
      // Clean up even if snapshot was already deleted by the endpoint
      await app.prisma.saldoSnapshot.deleteMany({ where: { id: snapshot.id } });
      await app.prisma.timeEntry.deleteMany({ where: { id: lockedEntry.id } });
    }
  });
});
