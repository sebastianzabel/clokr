/**
 * Phase 64b Plan 01 (issue #64) — GET /api/v1/salons role gate, includeInactive, isMultiSalon.
 *
 * `seedTestData()` does NOT create a Salon for its tenant (D-18 exemption) — every fixture salon
 * this file needs is created directly via `app.prisma.salon.create(...)`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";

describe("GET /api/v1/salons", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;
  let managerToken: string;
  let activeSalonId: string;
  let inactiveSalonId: string;

  beforeAll(async () => {
    app = await getTestApp();
    tenant = await seedTestData(app, "salons-route");

    // Inline MANAGER, same pattern as tenant-isolation.test.ts's SEC-V1814-01 block.
    const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const passwordHash = await bcrypt.hash("test1234", 10);
    const mgrUser = await app.prisma.user.create({
      data: {
        email: `mgr-salons-${s}@test.de`,
        passwordHash,
        role: "MANAGER",
        isActive: true,
      },
    });
    const mgrEmployee = await app.prisma.employee.create({
      data: {
        tenantId: tenant.tenant.id,
        userId: mgrUser.id,
        employeeNumber: `MG-${s}`,
        firstName: "Manager",
        lastName: "Salons",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: mgrEmployee.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: mgrEmployee.id, balanceHours: 0 },
    });
    const mgrLoginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: mgrUser.email, password: "test1234" },
    });
    managerToken = JSON.parse(mgrLoginRes.body).accessToken;

    // One active, one inactive salon for this tenant.
    const active = await app.prisma.salon.create({
      data: {
        tenantId: tenant.tenant.id,
        name: "Aktiver Salon",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    activeSalonId = active.id;
    const inactive = await app.prisma.salon.create({
      data: {
        tenantId: tenant.tenant.id,
        name: "Inaktiver Salon",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: false,
        deactivatedAt: new Date(),
      },
    });
    inactiveSalonId = inactive.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenant.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("rejects EMPLOYEE with 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${tenant.empToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows MANAGER with 200, hides inactive salons by default, isMultiSalon false with one active", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.isMultiSalon).toBe(false);
    const ids = body.salons.map((s: { id: string }) => s.id);
    expect(ids).toContain(activeSalonId);
    expect(ids).not.toContain(inactiveSalonId);
  });

  it("allows ADMIN with 200 (D-11)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${tenant.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("?includeInactive=true lists both active and inactive salons", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/salons?includeInactive=true",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const ids = body.salons.map((s: { id: string }) => s.id);
    expect(ids).toContain(activeSalonId);
    expect(ids).toContain(inactiveSalonId);
  });

  it("AC-5: isMultiSalon becomes true once a second ACTIVE salon exists", async () => {
    const secondActive = await app.prisma.salon.create({
      data: {
        tenantId: tenant.tenant.id,
        name: "Zweiter aktiver Salon",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/salons",
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.isMultiSalon).toBe(true);
    } finally {
      await app.prisma.salon.delete({ where: { id: secondActive.id } });
    }
  });
});
