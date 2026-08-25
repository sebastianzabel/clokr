import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import { computeMonthSaldo } from "../../utils/month-saldo";
import type { FastifyInstance } from "fastify";

/**
 * Phase 99 Plan 04 (OB-02) — integration proof that the manual-close path
 * (POST /api/v1/overtime/close-month) and the month-saldo display path
 * (computeMonthSaldo) both resolve their carry-in through getCarryOverBase(),
 * and that this is a PROVABLE no-op for employees without an OpeningBalance.
 *
 * Fixed calendar dates only (April/May 2025) — no `new Date()`-derived fixtures.
 * One shared tenant (own seedTestData call, isolated from other suites), one
 * fresh Employee per scenario within it — OpeningBalance is employee-scoped,
 * so per-employee isolation is what matters here, not per-tenant isolation.
 *
 * No PII — initials/synthetic names only (memory feedback_no_pii_in_github).
 */
describe("Opening Balance seeding — manual close & month-saldo parity (OB-02)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "obseed");
  });

  afterAll(async () => {
    try {
      // OpeningBalance.employeeId is onDelete: Restrict (Revisionssicherheit) — must be
      // cleared before cleanupTestData deletes the tenant's employees, or the FK blocks it.
      await app.prisma.openingBalance.deleteMany({
        where: { employee: { tenantId: data.tenant.id } },
      });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  /** Create a fresh Employee (own User + WorkSchedule + OvertimeAccount) in the shared tenant. */
  async function createEmployee(suffix: string, hireDateStr: string) {
    const passwordHash = await bcrypt.hash("test1234", 10);
    const user = await app.prisma.user.create({
      data: {
        email: `ob-seed-${suffix}-${Date.now().toString(36)}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `OB-${suffix}`,
        firstName: "Test",
        lastName: suffix,
        hireDate: new Date(`${hireDateStr}T00:00:00Z`),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date(`${hireDateStr}T00:00:00Z`),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: 0 },
    });
    return employee;
  }

  /** Create a fixed-date, fixed-hours WORK time entry (8h net, 60min break). */
  async function createEntry(employeeId: string, dateStr: string) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date(`${dateStr}T00:00:00Z`),
        startTime: new Date(`${dateStr}T08:00:00.000Z`),
        endTime: new Date(`${dateStr}T17:00:00.000Z`),
        breakMinutes: 60,
        source: "MANUAL",
        type: "WORK",
      },
    });
  }

  /** POST /overtime/close-month with confirmGaps:true (fixtures never fill every workday). */
  async function closeMonth(employeeId: string, year: number, month: number) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-month",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId, year, month, confirmGaps: true },
    });
    return res;
  }

  async function createOpeningBalance(
    employeeId: string,
    minutes: number,
    opts: { superseded?: boolean; effectiveFromStr: string },
  ) {
    return app.prisma.openingBalance.create({
      data: {
        employeeId,
        minutes,
        effectiveFrom: new Date(`${opts.effectiveFromStr}T00:00:00Z`),
        reason: "OB-02 integration fixture — synthetic opening balance",
        source: "ADMIN_ENTRY",
        createdBy: data.adminUser.id,
        superseded: opts.superseded ?? false,
      },
    });
  }

  it("Test 1: manual close, NO OpeningBalance — carryOver equals balanceMinutes (no-op proof)", async () => {
    const emp = await createEmployee("t1", "2025-04-01");
    await createEntry(emp.id, "2025-04-01");
    await createEntry(emp.id, "2025-04-02");

    const res = await closeMonth(emp.id, 2025, 4);
    expect(res.statusCode).toBe(201);
    const snapshot = JSON.parse(res.body);

    expect(snapshot.carryOver).toBe(snapshot.balanceMinutes);
  });

  it("Test 2: manual close, WITH an active OpeningBalance of +4200 — carryOver equals 4200 + balanceMinutes", async () => {
    const emp = await createEmployee("t2", "2025-04-01");
    await createEntry(emp.id, "2025-04-01");
    await createEntry(emp.id, "2025-04-02");
    await createOpeningBalance(emp.id, 4200, { effectiveFromStr: "2025-04-01" });

    const res = await closeMonth(emp.id, 2025, 4);
    expect(res.statusCode).toBe(201);
    const snapshot = JSON.parse(res.body);

    expect(snapshot.carryOver).toBe(4200 + snapshot.balanceMinutes);
  });

  it("Test 3: manual close, SUPERSEDED OpeningBalance only — superseded history is ignored (carryOver equals balanceMinutes)", async () => {
    const emp = await createEmployee("t3", "2025-04-01");
    await createEntry(emp.id, "2025-04-01");
    await createEntry(emp.id, "2025-04-02");
    // A superseded-only row exists (no active row) — must be ignored entirely, same as no row.
    await createOpeningBalance(emp.id, 9999, {
      superseded: true,
      effectiveFromStr: "2025-04-01",
    });

    const res = await closeMonth(emp.id, 2025, 4);
    expect(res.statusCode).toBe(201);
    const snapshot = JSON.parse(res.body);

    expect(snapshot.carryOver).toBe(snapshot.balanceMinutes);
  });

  it("Test 4: month-saldo display parity — computeMonthSaldo and the close path agree, with and without the OpeningBalance", async () => {
    const emp = await createEmployee("t4", "2025-05-01");
    await createEntry(emp.id, "2025-05-05");
    await createEntry(emp.id, "2025-05-06");

    // ── Open month, NO OpeningBalance yet ──────────────────────────────────
    const resultNoOB = await computeMonthSaldo(app, emp.id, 2025, 5);
    expect(resultNoOB.closed).toBe(false);
    expect(resultNoOB.days.length).toBeGreaterThan(0);
    const lastNoOB = resultNoOB.days[resultNoOB.days.length - 1];
    expect(lastNoOB.cumulativeSaldoMinutes).toBe(resultNoOB.balanceMinutes);

    // ── Same open month, WITH an active OpeningBalance ─────────────────────
    await createOpeningBalance(emp.id, 4200, { effectiveFromStr: "2025-05-01" });
    const resultWithOB = await computeMonthSaldo(app, emp.id, 2025, 5);
    expect(resultWithOB.closed).toBe(false);
    // The opening balance shifts the carry-in (cumulative), NOT the month's own balance.
    expect(resultWithOB.balanceMinutes).toBe(resultNoOB.balanceMinutes);
    const lastWithOB = resultWithOB.days[resultWithOB.days.length - 1];
    expect(lastWithOB.cumulativeSaldoMinutes).toBe(4200 + resultWithOB.balanceMinutes);

    // ── Close the same month — the close path must produce the SAME carry-in ──
    const res = await closeMonth(emp.id, 2025, 5);
    expect(res.statusCode).toBe(201);
    const snapshot = JSON.parse(res.body);
    expect(snapshot.balanceMinutes).toBe(resultWithOB.balanceMinutes);
    expect(snapshot.carryOver).toBe(lastWithOB.cumulativeSaldoMinutes);
    expect(snapshot.carryOver).toBe(4200 + snapshot.balanceMinutes);

    // ── Closed month: computeMonthSaldo now returns the snapshot verbatim ──
    const resultClosed = await computeMonthSaldo(app, emp.id, 2025, 5);
    expect(resultClosed.closed).toBe(true);
    expect(resultClosed.days[resultClosed.days.length - 1].cumulativeSaldoMinutes).toBe(
      snapshot.carryOver,
    );
  });

  it("Test 5: mid-chain isolation — with a predecessor snapshot present, the OpeningBalance is ignored by both paths", async () => {
    const emp = await createEmployee("t5", "2025-04-01");

    // ── Establish a predecessor: close April 2025 with NO OpeningBalance ───
    await createEntry(emp.id, "2025-04-01");
    await createEntry(emp.id, "2025-04-02");
    const aprilRes = await closeMonth(emp.id, 2025, 4);
    expect(aprilRes.statusCode).toBe(201);
    const aprilSnapshot = JSON.parse(aprilRes.body);
    expect(aprilSnapshot.carryOver).toBe(aprilSnapshot.balanceMinutes);

    // ── An OpeningBalance is created AFTER a predecessor already exists ────
    // (e.g. an admin backfilling one later). It must never leak into May's
    // carry-in — the predecessor snapshot is the sole source once it exists.
    await createOpeningBalance(emp.id, 4200, { effectiveFromStr: "2025-04-01" });

    // ── Open May 2025: computeMonthSaldo must thread April's carryOver, NOT the OB ──
    await createEntry(emp.id, "2025-05-05");
    await createEntry(emp.id, "2025-05-06");
    const mayOpen = await computeMonthSaldo(app, emp.id, 2025, 5);
    expect(mayOpen.closed).toBe(false);
    const lastMayOpen = mayOpen.days[mayOpen.days.length - 1];
    expect(lastMayOpen.cumulativeSaldoMinutes).toBe(
      aprilSnapshot.carryOver + mayOpen.balanceMinutes,
    );

    // ── Close May 2025: the close path must also thread April's carryOver, NOT the OB ──
    const mayRes = await closeMonth(emp.id, 2025, 5);
    expect(mayRes.statusCode).toBe(201);
    const maySnapshot = JSON.parse(mayRes.body);
    expect(maySnapshot.carryOver).toBe(aprilSnapshot.carryOver + maySnapshot.balanceMinutes);
  });
});
