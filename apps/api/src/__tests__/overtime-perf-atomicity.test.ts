/**
 * PERF-V1814-02 — Payout concurrency and floor-guard regression tests.
 *
 * Verifies that POST /overtime/payout:
 *   1. Cannot overdraw an account via two concurrent requests (FOR UPDATE row lock)
 *   2. Rejects (400) with German error when a single payout would exceed the balance
 *   3. Succeeds (200) and correctly decrements balance for a valid payout
 *
 * RED state (before Task 2): current code has no row lock — two concurrent payouts
 * both pass the balance check and both decrement, leaving a negative balance.
 * GREEN state (after Task 2): SELECT … FOR UPDATE inside interactive $transaction
 * serialises concurrent payouts; floor guard also rejects any post-decrement overdraw.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("PERF-V1814-02 — POST /overtime/payout atomicity", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let payoutEmployeeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "payatom");

    // Create a dedicated payout employee with allowOvertimePayout=true
    const s = `pa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `pa-emp-${s}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `PA-${s}`.slice(0, 20),
        firstName: "Payout",
        lastName: "Atomicity",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
        allowOvertimePayout: true,
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: emp.id, balanceHours: 0 },
    });
    payoutEmployeeId = emp.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("overtime-perf-atomicity cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("Test 1 (concurrency): two concurrent payouts do not overdraw the account", async () => {
    // Seed balance = 1.0h — enough for exactly one 0.6h payout, not two
    await app.prisma.overtimeAccount.upsert({
      where: { employeeId: payoutEmployeeId },
      create: { employeeId: payoutEmployeeId, balanceHours: 1.0 },
      update: { balanceHours: 1.0 },
    });

    // Fire two concurrent payout requests via Promise.all; only one can succeed without overdrawing
    const [r1, r2] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/overtime/payout",
        payload: { employeeId: payoutEmployeeId, hours: 0.6 },
        headers: { authorization: `Bearer ${data.adminToken}` },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/overtime/payout",
        payload: { employeeId: payoutEmployeeId, hours: 0.6 },
        headers: { authorization: `Bearer ${data.adminToken}` },
      }),
    ]);

    // Exactly one succeeds (200), one is rejected (400)
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([200, 400]);

    // Balance must never go negative — the invariant of the floor guard
    const account = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: payoutEmployeeId },
    });
    expect(Number(account!.balanceHours)).toBeGreaterThanOrEqual(0);
  });

  it("Test 2 (floor guard): single payout exceeding balance is rejected with German error", async () => {
    // Balance = 0.5h; payout requested = 0.6h → must be rejected
    await app.prisma.overtimeAccount.upsert({
      where: { employeeId: payoutEmployeeId },
      create: { employeeId: payoutEmployeeId, balanceHours: 0.5 },
      update: { balanceHours: 0.5 },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/payout",
      payload: { employeeId: payoutEmployeeId, hours: 0.6 },
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Nicht genug Überstunden auf dem Konto");

    // Balance must remain unchanged at 0.5
    const account = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: payoutEmployeeId },
    });
    expect(Number(account!.balanceHours)).toBeCloseTo(0.5, 5);
  });

  it("Test 3 (happy path): valid payout decrements balance and creates OvertimeTransaction", async () => {
    // Balance = 2.0h, payout = 0.5h → 200, new balance = 1.5h, one PAYOUT transaction
    await app.prisma.overtimeAccount.upsert({
      where: { employeeId: payoutEmployeeId },
      create: { employeeId: payoutEmployeeId, balanceHours: 2.0 },
      update: { balanceHours: 2.0 },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/payout",
      payload: { employeeId: payoutEmployeeId, hours: 0.5 },
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { success: boolean; newBalance: number };
    expect(body.success).toBe(true);
    expect(body.newBalance).toBeCloseTo(1.5, 5);

    // Verify the OvertimeTransaction row was created with the correct type and hours
    const account = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: payoutEmployeeId },
      include: { transactions: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    expect(account).not.toBeNull();
    expect(Number(account!.balanceHours)).toBeCloseTo(1.5, 5);
    const txn = account!.transactions[0];
    expect(txn).toBeDefined();
    expect(txn.type).toBe("PAYOUT");
    expect(Number(txn.hours)).toBeCloseTo(-0.5, 5);
  });
});
