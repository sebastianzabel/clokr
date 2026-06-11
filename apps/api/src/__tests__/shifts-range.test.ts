import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("GET /api/v1/shifts/range", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Tenant B (cross-tenant isolation test)
  let otherTenantId: string;
  let otherEmployeeId: string;
  let otherAdminToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sr");

    // Layer SHIFT_BASED WorkSchedule on top of the seed default (FIXED_SCHEDULE)
    // so the EMPLOYEE role test doesn't hit a 410 "Nicht im Schichtsystem" guard.
    await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        validFrom: new Date("2024-02-01"),
      },
    });

    // Create a second tenant + admin for cross-tenant isolation test
    const bcryptMod = await import("bcryptjs");
    const otherTenant = await app.prisma.tenant.create({
      data: { name: "OtherTenant-sr", slug: `other-sr-${Date.now()}` },
    });
    otherTenantId = otherTenant.id;
    const otherAdmin = await app.prisma.user.create({
      data: {
        email: `other-admin-sr-${Date.now()}@test.de`,
        passwordHash: await bcryptMod.default.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    const otherEmp = await app.prisma.employee.create({
      data: {
        tenantId: otherTenant.id,
        userId: otherAdmin.id,
        employeeNumber: `OA-${Date.now()}`,
        firstName: "Other",
        lastName: "Admin",
        hireDate: new Date("2024-01-01"),
      },
    });
    otherEmployeeId = otherEmp.id;
    await app.prisma.overtimeAccount.create({
      data: { employeeId: otherEmp.id, balanceHours: 0 },
    });
    await app.prisma.tenantConfig.create({
      data: {
        tenantId: otherTenant.id,
        timezone: "Europe/Berlin",
      },
    });
    const otherLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: otherAdmin.email, password: "test1234" },
    });
    otherAdminToken = JSON.parse(otherLogin.body).accessToken;
    // Create a shift for the other-tenant employee on the same date as main tenant
    await app.prisma.shift.create({
      data: {
        employeeId: otherEmp.id,
        date: new Date("2025-05-01T00:00:00Z"),
        startTime: "08:00",
        endTime: "16:00",
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      // Clean up second tenant
      await app.prisma.shift.deleteMany({ where: { employee: { tenantId: otherTenantId } } });
      await app.prisma.overtimeAccount.deleteMany({
        where: { employee: { tenantId: otherTenantId } },
      });
      await app.prisma.employee.deleteMany({ where: { tenantId: otherTenantId } });
      await app.prisma.user.deleteMany({
        where: { email: { endsWith: "@test.de", contains: "other-admin-sr" } },
      });
      await app.prisma.tenantConfig.deleteMany({ where: { tenantId: otherTenantId } });
      await app.prisma.tenant.delete({ where: { id: otherTenantId } }).catch(() => {});
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── 1. Happy path ─────────────────────────────────────────────────────────
  it("returns shifts for a given date range with correct durationMin", async () => {
    // Create 3 shifts: 06:00–14:00 (480 min), 07:45–18:00 (615 min), 09:00–17:00 (480 min)
    const shift1 = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: new Date("2025-05-05T00:00:00Z"),
        startTime: "06:00",
        endTime: "14:00",
      },
    });
    const shift2 = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: new Date("2025-05-06T00:00:00Z"),
        startTime: "07:45",
        endTime: "18:00",
      },
    });
    const shift3 = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: new Date("2025-05-07T00:00:00Z"),
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/range?from=2025-05-01&to=2025-05-31&employeeId=${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{
      date: string;
      startTime: string;
      endTime: string;
      durationMin: number;
    }>;

    const s1 = body.find((r) => r.date === "2025-05-05");
    const s2 = body.find((r) => r.date === "2025-05-06");
    const s3 = body.find((r) => r.date === "2025-05-07");

    expect(s1).toBeDefined();
    expect(s1?.durationMin).toBe(480); // 06:00–14:00
    expect(s2).toBeDefined();
    expect(s2?.durationMin).toBe(615); // 07:45–18:00
    expect(s3).toBeDefined();
    expect(s3?.durationMin).toBe(480); // 09:00–17:00

    // Cleanup
    await app.prisma.shift.deleteMany({ where: { id: { in: [shift1.id, shift2.id, shift3.id] } } });
  });

  // ── 2. Multi-shift day: both rows present (frontend sums) ─────────────────
  it("returns both rows for a multi-shift day (API does not pre-sum)", async () => {
    const s1 = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: new Date("2025-06-10T00:00:00Z"),
        startTime: "08:00",
        endTime: "12:00",
      },
    });
    const s2 = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: new Date("2025-06-10T00:00:00Z"),
        startTime: "13:00",
        endTime: "17:00",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/range?from=2025-06-01&to=2025-06-30&employeeId=${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{ date: string; durationMin: number }>;
    const rows = body.filter((r) => r.date === "2025-06-10");
    expect(rows).toHaveLength(2);
    // Each row is separate — caller sums them (480 total)
    const durations = rows.map((r) => r.durationMin).sort();
    expect(durations).toEqual([240, 240]);

    await app.prisma.shift.deleteMany({ where: { id: { in: [s1.id, s2.id] } } });
  });

  // ── 3. Tenant scoping ─────────────────────────────────────────────────────
  it("does not return shifts from a different tenant", async () => {
    // The other-tenant shift (2025-05-01, otherEmployeeId) was created in beforeAll.
    // Query it from the main-tenant admin — should get 0 rows for that employee+date.
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/range?from=2025-05-01&to=2025-05-31&employeeId=${otherEmployeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    // Prisma tenant guard returns empty (employee in other tenant → 0 rows, not a 404/403)
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as unknown[];
    expect(body).toHaveLength(0);
  });

  // ── 4. deletedAt filter ───────────────────────────────────────────────────
  it("does not return soft-deleted shifts", async () => {
    const deletedShift = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: new Date("2025-07-01T00:00:00Z"),
        startTime: "08:00",
        endTime: "16:00",
        deletedAt: new Date(), // soft-deleted
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/range?from=2025-07-01&to=2025-07-31&employeeId=${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{ date: string }>;
    expect(body.some((r) => r.date === "2025-07-01")).toBe(false);

    await app.prisma.shift.delete({ where: { id: deletedShift.id } });
  });

  // ── 5. 400 on missing from/to ─────────────────────────────────────────────
  it("returns 400 when from is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/range?to=2025-05-31&employeeId=${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/from und to/);
  });

  it("returns 400 when to is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/range?from=2025-05-01&employeeId=${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/from und to/);
  });

  // ── 6. EMPLOYEE role defaults to own employeeId ───────────────────────────
  it("EMPLOYEE role returns own shifts without passing employeeId", async () => {
    const ownShift = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: new Date("2025-08-01T00:00:00Z"),
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    // Call without employeeId — EMPLOYEE role should default to caller's own employee
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/range?from=2025-08-01&to=2025-08-31`,
      headers: { authorization: `Bearer ${data.empToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{ date: string; durationMin: number }>;
    const row = body.find((r) => r.date === "2025-08-01");
    expect(row).toBeDefined();
    expect(row?.durationMin).toBe(480); // 09:00–17:00

    await app.prisma.shift.delete({ where: { id: ownShift.id } });
  });

  // ── 7. Cross-midnight duration ────────────────────────────────────────────
  it("computes correct durationMin for cross-midnight shifts (e.g. 22:00–06:00 = 480)", async () => {
    const nightShift = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: new Date("2025-09-01T00:00:00Z"),
        startTime: "22:00",
        endTime: "06:00",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/range?from=2025-09-01&to=2025-09-30&employeeId=${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{ date: string; durationMin: number }>;
    const row = body.find((r) => r.date === "2025-09-01");
    expect(row).toBeDefined();
    expect(row?.durationMin).toBe(480); // 22:00 → 06:00 = 8h = 480 min

    await app.prisma.shift.delete({ where: { id: nightShift.id } });
  });
});
