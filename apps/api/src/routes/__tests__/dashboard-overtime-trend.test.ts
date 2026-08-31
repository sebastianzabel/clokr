import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import { monthStartUtc, monthEndUtc } from "../../__tests__/test-dates";
import type { FastifyInstance } from "fastify";

describe("GET /api/v1/dashboard/overtime-trend", () => {
  let app: FastifyInstance;
  let dataA: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    dataA = await seedTestData(app, "dtA");
    dataB = await seedTestData(app, "dtB");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, dataA.tenant.id);
    } catch (err) {
      console.error("Cleanup A failed:", err);
    }
    try {
      await cleanupTestData(app, dataB.tenant.id);
    } catch (err) {
      console.error("Cleanup B failed:", err);
    }
    await closeTestApp();
  });

  it("401 when unauthenticated", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/overtime-trend",
    });
    expect(res.statusCode).toBe(401);
  });

  it("200 with empty snapshots array and zero balance when no data", async () => {
    // Reset balances to 0 so this test sees "no data"
    await app.prisma.overtimeAccount.updateMany({
      where: { employee: { tenantId: dataA.tenant.id } },
      data: { balanceHours: 0 },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/overtime-trend",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.snapshots)).toBe(true);
    expect(body.snapshots.length).toBe(0);
    expect(body.currentTeamBalanceMinutes).toBe(0);
  });

  it("returns team carry-over sums grouped by periodStart, ascending", async () => {
    // Seed 3 MONTHLY snapshots for the admin employee of tenant A
    // Use recent months within the 6-month window
    const month1 = monthStartUtc(4);
    const month2 = monthStartUtc(3);
    const month3 = monthStartUtc(2);

    // periodEnd = last day of the respective month
    const end1 = monthEndUtc(4);
    const end2 = monthEndUtc(3);
    const end3 = monthEndUtc(2);

    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: dataA.adminEmployee.id,
        periodType: "MONTHLY",
        periodStart: month1,
        periodEnd: end1,
        workedMinutes: 9600,
        expectedMinutes: 9600,
        balanceMinutes: 0,
        carryOver: 600,
        closedAt: new Date(),
      },
    });

    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: dataA.adminEmployee.id,
        periodType: "MONTHLY",
        periodStart: month2,
        periodEnd: end2,
        workedMinutes: 9600,
        expectedMinutes: 9600,
        balanceMinutes: 0,
        carryOver: 1200,
        closedAt: new Date(),
      },
    });

    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: dataA.adminEmployee.id,
        periodType: "MONTHLY",
        periodStart: month3,
        periodEnd: end3,
        workedMinutes: 9600,
        expectedMinutes: 9600,
        balanceMinutes: 0,
        carryOver: 1800,
        closedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/overtime-trend",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.snapshots)).toBe(true);
    // Must have at least 3 snapshots
    expect(body.snapshots.length).toBeGreaterThanOrEqual(3);

    // Find the months we seeded and verify expected values
    const snap600 = body.snapshots.find(
      (s: { month: string; teamCarryOverMinutes: number }) =>
        s.month === month1.toISOString().slice(0, 10),
    );
    const snap1200 = body.snapshots.find(
      (s: { month: string; teamCarryOverMinutes: number }) =>
        s.month === month2.toISOString().slice(0, 10),
    );
    const snap1800 = body.snapshots.find(
      (s: { month: string; teamCarryOverMinutes: number }) =>
        s.month === month3.toISOString().slice(0, 10),
    );

    expect(snap600).toBeDefined();
    expect(snap600.teamCarryOverMinutes).toBe(600);
    expect(snap1200).toBeDefined();
    expect(snap1200.teamCarryOverMinutes).toBe(1200);
    expect(snap1800).toBeDefined();
    expect(snap1800.teamCarryOverMinutes).toBe(1800);

    // Verify ascending order
    const months = body.snapshots.map((s: { month: string }) => s.month);
    const sorted = [...months].sort();
    expect(months).toEqual(sorted);
  });

  it("current balance sums OvertimeAccount.balanceHours across all active employees", async () => {
    // Set admin employee to 35 hours and regular employee to 12.5 hours
    await app.prisma.overtimeAccount.upsert({
      where: { employeeId: dataA.adminEmployee.id },
      create: { employeeId: dataA.adminEmployee.id, balanceHours: 35 },
      update: { balanceHours: 35 },
    });
    await app.prisma.overtimeAccount.upsert({
      where: { employeeId: dataA.employee.id },
      create: { employeeId: dataA.employee.id, balanceHours: 12.5 },
      update: { balanceHours: 12.5 },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/overtime-trend",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // (35 + 12.5) * 60 = 2850
    expect(body.currentTeamBalanceMinutes).toBe(2850);
  });

  it("excludes data from other tenants", async () => {
    // Seed tenant B with large values that must NOT appear in tenant A's response
    const bMonth = monthStartUtc(1);
    const bEnd = monthEndUtc(1);

    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: dataB.adminEmployee.id,
        periodType: "MONTHLY",
        periodStart: bMonth,
        periodEnd: bEnd,
        workedMinutes: 9600,
        expectedMinutes: 9600,
        balanceMinutes: 0,
        carryOver: 99999,
        closedAt: new Date(),
      },
    });

    await app.prisma.overtimeAccount.upsert({
      where: { employeeId: dataB.adminEmployee.id },
      create: { employeeId: dataB.adminEmployee.id, balanceHours: 9999 },
      update: { balanceHours: 9999 },
    });

    // Query with tenant A token
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/overtime-trend",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Tenant A's current balance (35 + 12.5) * 60 = 2850 from previous test
    // Tenant B's 9999 hours must NOT be included
    expect(body.currentTeamBalanceMinutes).toBe(2850);

    // Tenant B's carryOver of 99999 must NOT appear in snapshots
    const hasLeaked = body.snapshots.some(
      (s: { teamCarryOverMinutes: number }) => s.teamCarryOverMinutes >= 99999,
    );
    expect(hasLeaked).toBe(false);
  });

  it("only returns MONTHLY snapshots within the 6-month window", async () => {
    const now = new Date();

    // YEARLY snapshot (should be excluded)
    const yearStart = new Date(Date.UTC(now.getFullYear(), 0, 1));
    const yearEnd = new Date(Date.UTC(now.getFullYear(), 11, 31));
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: dataA.adminEmployee.id,
        periodType: "YEARLY",
        periodStart: yearStart,
        periodEnd: yearEnd,
        workedMinutes: 100000,
        expectedMinutes: 100000,
        balanceMinutes: 0,
        carryOver: 55555,
        closedAt: new Date(),
      },
    });

    // MONTHLY snapshot older than 6 months (should be excluded)
    const oldMonth = monthStartUtc(7);
    const oldEnd = monthEndUtc(7);

    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: dataA.adminEmployee.id,
        periodType: "MONTHLY",
        periodStart: oldMonth,
        periodEnd: oldEnd,
        workedMinutes: 9600,
        expectedMinutes: 9600,
        balanceMinutes: 0,
        carryOver: 44444,
        closedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/overtime-trend",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // YEARLY snapshot's carryOver 55555 must NOT appear
    const hasYearly = body.snapshots.some(
      (s: { teamCarryOverMinutes: number }) => s.teamCarryOverMinutes === 55555,
    );
    expect(hasYearly).toBe(false);

    // Old MONTHLY snapshot's carryOver 44444 must NOT appear
    const hasOld = body.snapshots.some(
      (s: { teamCarryOverMinutes: number }) => s.teamCarryOverMinutes === 44444,
    );
    expect(hasOld).toBe(false);
  });
});
