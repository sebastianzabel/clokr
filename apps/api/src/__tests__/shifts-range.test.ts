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

  // v1.8.9: TenantConfig for the seed tenant (needed to assert break-based netto).
  // seedTestData creates a TenantConfig with defaults; we capture the record so
  // individual test cases can inspect or update defaultBreakOver6h/9h.
  let seedTenantId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sr");
    seedTenantId = data.tenant.id;

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
  it("returns shifts for a given date range with correct durationMin and durationMinNetto", async () => {
    // Create 3 shifts: 06:00–14:00 (480 min), 07:45–18:00 (615 min), 09:00–17:00 (480 min)
    // Default tenant: defaultBreakOver6h=30, defaultBreakOver9h=45.
    // Expected netto: 480−30=450, 615−45=570, 480−30=450.
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
      durationMinNetto: number;
    }>;

    const s1 = body.find((r) => r.date === "2025-05-05");
    const s2 = body.find((r) => r.date === "2025-05-06");
    const s3 = body.find((r) => r.date === "2025-05-07");

    // Brutto unchanged (backward-compat for TeamCalendar weekly-overview consumers)
    expect(s1).toBeDefined();
    expect(s1?.durationMin).toBe(480); // 06:00–14:00 brutto
    expect(s2).toBeDefined();
    expect(s2?.durationMin).toBe(615); // 07:45–18:00 brutto
    expect(s3).toBeDefined();
    expect(s3?.durationMin).toBe(480); // 09:00–17:00 brutto

    // v1.8.9: netto = brutto − getEffectiveBreakDuration (default 30/45 min)
    expect(s1?.durationMinNetto).toBe(450); // 480−30 (>6h → 30 min break)
    expect(s2?.durationMinNetto).toBe(570); // 615−45 (>9h → 45 min break)
    expect(s3?.durationMinNetto).toBe(450); // 480−30 (>6h → 30 min break)

    // Cleanup
    await app.prisma.shift.deleteMany({ where: { id: { in: [shift1.id, shift2.id, shift3.id] } } });
  });

  // ── 2. Multi-shift day: both rows present (frontend sums) ─────────────────
  it("returns both rows for a multi-shift day (API does not pre-sum)", async () => {
    // Each shift is 08:00–12:00 and 13:00–17:00 = 240 min each (≤6h → 0 break).
    // v1.8.9: break policy is per-shift-row, not per-day. Each ≤6h row has durationMinNetto=240.
    // Frontend sums → 480 netto for the day. Documented design choice: policy per shift, not per day.
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
    const body = JSON.parse(res.body) as Array<{
      date: string;
      durationMin: number;
      durationMinNetto: number;
    }>;
    const rows = body.filter((r) => r.date === "2025-06-10");
    expect(rows).toHaveLength(2);
    // Each row is separate — caller sums them (480 brutto total)
    const durations = rows.map((r) => r.durationMin).sort();
    expect(durations).toEqual([240, 240]);
    // v1.8.9: each shift ≤6h → 0 break → netto = brutto = 240
    const nettoValues = rows.map((r) => r.durationMinNetto).sort();
    expect(nettoValues).toEqual([240, 240]);

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
    const body = JSON.parse(res.body) as Array<{
      date: string;
      durationMin: number;
      durationMinNetto: number;
    }>;
    const row = body.find((r) => r.date === "2025-08-01");
    expect(row).toBeDefined();
    expect(row?.durationMin).toBe(480); // 09:00–17:00 brutto
    // v1.8.9: 480 brutto (>6h) − 30 min default break = 450 netto
    expect(row?.durationMinNetto).toBe(450);

    await app.prisma.shift.delete({ where: { id: ownShift.id } });
  });

  // ── 7. Cross-midnight duration ────────────────────────────────────────────
  it("computes correct durationMin and durationMinNetto for cross-midnight shifts (e.g. 22:00–06:00 = 480 brutto, 450 netto)", async () => {
    // v1.8.9: cross-midnight fix also applies netto. 22:00–06:00 = 480 brutto (>6h → 30 min break) → 450 netto.
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
    const body = JSON.parse(res.body) as Array<{
      date: string;
      durationMin: number;
      durationMinNetto: number;
    }>;
    const row = body.find((r) => r.date === "2025-09-01");
    expect(row).toBeDefined();
    expect(row?.durationMin).toBe(480); // 22:00 → 06:00 = 8h = 480 min brutto
    expect(row?.durationMinNetto).toBe(450); // 480 − 30 min default break = 450 netto

    await app.prisma.shift.delete({ where: { id: nightShift.id } });
  });

  // ── 8. durationMinNetto — netto computation: overrides + boundary ─────────
  describe("GET /api/v1/shifts/range — netto computation", () => {
    // Use unique dates far in the future to avoid collision with other tests
    const BASE_YEAR = "2099";

    it("employee breakOver6hOverride=60: 08:00–16:00 (480 brutto, >6h) → durationMinNetto=420", async () => {
      // Set the employee's 6h override
      await app.prisma.employee.update({
        where: { id: data.employee.id },
        data: { breakOver6hOverride: 60 },
      });
      const sh = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(`${BASE_YEAR}-01-10T00:00:00Z`),
          startTime: "08:00",
          endTime: "16:00",
        },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/range?from=${BASE_YEAR}-01-01&to=${BASE_YEAR}-01-31&employeeId=${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const body = JSON.parse(res.body) as Array<{
        date: string;
        durationMin: number;
        durationMinNetto: number;
      }>;
      const row = body.find((r) => r.date === `${BASE_YEAR}-01-10`);
      expect(row?.durationMin).toBe(480);
      expect(row?.durationMinNetto).toBe(420); // 480 − 60 (employee override)
      // Cleanup
      await app.prisma.shift.delete({ where: { id: sh.id } });
      await app.prisma.employee.update({
        where: { id: data.employee.id },
        data: { breakOver6hOverride: null },
      });
    });

    it("employee breakOver9hOverride=90: 07:00–18:00 (660 brutto, >9h) → durationMinNetto=570", async () => {
      await app.prisma.employee.update({
        where: { id: data.employee.id },
        data: { breakOver9hOverride: 90 },
      });
      const sh = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(`${BASE_YEAR}-02-10T00:00:00Z`),
          startTime: "07:00",
          endTime: "18:00",
        },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/range?from=${BASE_YEAR}-02-01&to=${BASE_YEAR}-02-28&employeeId=${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const body = JSON.parse(res.body) as Array<{
        date: string;
        durationMin: number;
        durationMinNetto: number;
      }>;
      const row = body.find((r) => r.date === `${BASE_YEAR}-02-10`);
      expect(row?.durationMin).toBe(660);
      expect(row?.durationMinNetto).toBe(570); // 660 − 90 (employee override)
      await app.prisma.shift.delete({ where: { id: sh.id } });
      await app.prisma.employee.update({
        where: { id: data.employee.id },
        data: { breakOver9hOverride: null },
      });
    });

    it("tenant defaultBreakOver6h=45 (no employee override): 08:00–15:00 (420 brutto, >6h) → durationMinNetto=375", async () => {
      await app.prisma.tenantConfig.update({
        where: { tenantId: seedTenantId },
        data: { defaultBreakOver6h: 45 },
      });
      const sh = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(`${BASE_YEAR}-03-10T00:00:00Z`),
          startTime: "08:00",
          endTime: "15:00",
        },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/range?from=${BASE_YEAR}-03-01&to=${BASE_YEAR}-03-31&employeeId=${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const body = JSON.parse(res.body) as Array<{
        date: string;
        durationMin: number;
        durationMinNetto: number;
      }>;
      const row = body.find((r) => r.date === `${BASE_YEAR}-03-10`);
      expect(row?.durationMin).toBe(420);
      expect(row?.durationMinNetto).toBe(375); // 420 − 45 (tenant defaultBreakOver6h=45)
      await app.prisma.shift.delete({ where: { id: sh.id } });
      await app.prisma.tenantConfig.update({
        where: { tenantId: seedTenantId },
        data: { defaultBreakOver6h: 30 }, // restore default
      });
    });

    it("tenant defaultBreakOver9h=60 (no employee override): 06:00–17:00 (660 brutto, >9h) → durationMinNetto=600", async () => {
      await app.prisma.tenantConfig.update({
        where: { tenantId: seedTenantId },
        data: { defaultBreakOver9h: 60 },
      });
      const sh = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(`${BASE_YEAR}-04-10T00:00:00Z`),
          startTime: "06:00",
          endTime: "17:00",
        },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/range?from=${BASE_YEAR}-04-01&to=${BASE_YEAR}-04-30&employeeId=${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const body = JSON.parse(res.body) as Array<{
        date: string;
        durationMin: number;
        durationMinNetto: number;
      }>;
      const row = body.find((r) => r.date === `${BASE_YEAR}-04-10`);
      expect(row?.durationMin).toBe(660);
      expect(row?.durationMinNetto).toBe(600); // 660 − 60 (tenant defaultBreakOver9h=60)
      await app.prisma.shift.delete({ where: { id: sh.id } });
      await app.prisma.tenantConfig.update({
        where: { tenantId: seedTenantId },
        data: { defaultBreakOver9h: 45 }, // restore default
      });
    });

    it("boundary: exactly 6h shift (08:00–14:00 = 360 brutto) → durationMinNetto=360 (strict >, not >=)", async () => {
      // getEffectiveBreakDuration uses strict > (not >=), so exactly 360 min → 0 break
      const sh = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(`${BASE_YEAR}-05-10T00:00:00Z`),
          startTime: "08:00",
          endTime: "14:00",
        },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/range?from=${BASE_YEAR}-05-01&to=${BASE_YEAR}-05-31&employeeId=${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const body = JSON.parse(res.body) as Array<{
        date: string;
        durationMin: number;
        durationMinNetto: number;
      }>;
      const row = body.find((r) => r.date === `${BASE_YEAR}-05-10`);
      expect(row?.durationMin).toBe(360);
      expect(row?.durationMinNetto).toBe(360); // exactly 6h → no break (strict >)
      await app.prisma.shift.delete({ where: { id: sh.id } });
    });

    it("short shift (10:00–14:00 = 240 brutto) → durationMinNetto=240 (≤6h → 0 break)", async () => {
      const sh = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(`${BASE_YEAR}-06-10T00:00:00Z`),
          startTime: "10:00",
          endTime: "14:00",
        },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/range?from=${BASE_YEAR}-06-01&to=${BASE_YEAR}-06-30&employeeId=${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const body = JSON.parse(res.body) as Array<{
        date: string;
        durationMin: number;
        durationMinNetto: number;
      }>;
      const row = body.find((r) => r.date === `${BASE_YEAR}-06-10`);
      expect(row?.durationMin).toBe(240);
      expect(row?.durationMinNetto).toBe(240); // ≤6h → 0 break
      await app.prisma.shift.delete({ where: { id: sh.id } });
    });
  });
});
