import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

/**
 * Regression test for WR-05: sick day double-counting fix.
 *
 * Before the fix, `sickDaysWithoutAttest` was initialized to `sickDaysAbsence`,
 * causing double-counting when both a LeaveRequest and an Absence(SICK) existed
 * for the same period (Absence was an AU-Bescheinigung document tracker, not the
 * authoritative sick day source — LeaveRequest is).
 *
 * This test suite guards that boundary and ensures the fix is never silently
 * reverted.
 */
describe("Reports: sick day double-count regression (WR-05)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Separate employees for each test to avoid cross-test interference
  let empA: { id: string };
  let empB: { id: string };
  let empC: { id: string };

  let krankmeldungTypeId: string;
  let kinderkrankTypeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rpt-sick");

    // Create sick leave types for this tenant
    const krankmeldungType = await app.prisma.leaveType.create({
      data: {
        tenantId: data.tenant.id,
        name: "Krankmeldung",
        isPaid: true,
        requiresApproval: false,
        color: "#EF4444",
      },
    });
    krankmeldungTypeId = krankmeldungType.id;

    const kinderkrankType = await app.prisma.leaveType.create({
      data: {
        tenantId: data.tenant.id,
        name: "Kinderkrank",
        isPaid: true,
        requiresApproval: false,
        color: "#F97316",
      },
    });
    kinderkrankTypeId = kinderkrankType.id;

    // ── Employee A: Krankmeldung + matching Absence(SICK) — double-count guard ──
    const userA = await app.prisma.user.create({
      data: {
        email: `emp-a-${Date.now()}@rpt-sick-test.de`,
        passwordHash: "DUMMY",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employeeA = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: userA.id,
        employeeNumber: `RSA-${Date.now()}`,
        firstName: "Anna",
        lastName: "SickTest",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employeeA.id,
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
      data: { employeeId: employeeA.id, balanceHours: 0 },
    });
    empA = { id: employeeA.id };

    // LeaveRequest: Krankmeldung 2025-03-03 to 2025-03-05 (Mon-Wed, 3 days), no attest
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employeeA.id,
        leaveTypeId: krankmeldungTypeId,
        startDate: new Date("2025-03-03T00:00:00.000Z"),
        endDate: new Date("2025-03-05T00:00:00.000Z"),
        days: 3,
        status: "APPROVED",
        attestPresent: false,
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date(),
      },
    });

    // Absence(SICK): same 3-day range — this tracks the AU-Bescheinigung document,
    // NOT the authoritative sick count. Must NOT double the sick day total.
    await app.prisma.absence.create({
      data: {
        employeeId: employeeA.id,
        type: "SICK",
        startDate: new Date("2025-03-03T00:00:00.000Z"),
        endDate: new Date("2025-03-05T00:00:00.000Z"),
        days: 3,
        createdBy: data.adminUser.id,
      },
    });

    // ── Employee B: Kinderkrank LeaveRequest only, NO Absence ──────────────────
    const userB = await app.prisma.user.create({
      data: {
        email: `emp-b-${Date.now()}@rpt-sick-test.de`,
        passwordHash: "DUMMY",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employeeB = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: userB.id,
        employeeNumber: `RSB-${Date.now()}`,
        firstName: "Ben",
        lastName: "SickTest",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employeeB.id,
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
      data: { employeeId: employeeB.id, balanceHours: 0 },
    });
    empB = { id: employeeB.id };

    // LeaveRequest: Kinderkrank 2025-03-10 to 2025-03-11 (Mon-Tue, 2 days), no attest, no Absence
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employeeB.id,
        leaveTypeId: kinderkrankTypeId,
        startDate: new Date("2025-03-10T00:00:00.000Z"),
        endDate: new Date("2025-03-11T00:00:00.000Z"),
        days: 2,
        status: "APPROVED",
        attestPresent: false,
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date(),
      },
    });
    // No Absence record for employee B

    // ── Employee C: Krankmeldung with full attest + matching Absence ───────────
    const userC = await app.prisma.user.create({
      data: {
        email: `emp-c-${Date.now()}@rpt-sick-test.de`,
        passwordHash: "DUMMY",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employeeC = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: userC.id,
        employeeNumber: `RSC-${Date.now()}`,
        firstName: "Clara",
        lastName: "SickTest",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employeeC.id,
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
      data: { employeeId: employeeC.id, balanceHours: 0 },
    });
    empC = { id: employeeC.id };

    // LeaveRequest: Krankmeldung 2025-03-17 to 2025-03-21 (Mon-Fri, 5 days), full attest
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employeeC.id,
        leaveTypeId: krankmeldungTypeId,
        startDate: new Date("2025-03-17T00:00:00.000Z"),
        endDate: new Date("2025-03-21T00:00:00.000Z"),
        days: 5,
        status: "APPROVED",
        attestPresent: true,
        attestValidFrom: new Date("2025-03-17T00:00:00.000Z"),
        attestValidTo: new Date("2025-03-21T00:00:00.000Z"),
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date(),
      },
    });

    // Matching Absence(SICK) — must NOT double-count with attest LeaveRequest
    await app.prisma.absence.create({
      data: {
        employeeId: employeeC.id,
        type: "SICK",
        startDate: new Date("2025-03-17T00:00:00.000Z"),
        endDate: new Date("2025-03-21T00:00:00.000Z"),
        days: 5,
        createdBy: data.adminUser.id,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Test A: Double-count prevention ────────────────────────────────────────
  it("Test A: sickDaysWithoutAttest = 3 when LeaveRequest + Absence(SICK) both exist for 3 days", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?year=2025&month=3&employeeId=${empA.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Response is { month, year, rows: [...] }
    const rows: Array<{
      employeeId: string;
      sickDays: number;
      sickDaysWithAttest: number;
      sickDaysWithoutAttest: number;
    }> = body.rows;

    const emp = rows.find((r) => r.employeeId === empA.id);
    expect(emp).toBeDefined();

    // Regression guard: sickDaysWithoutAttest must be 3 (from LeaveRequest only)
    // Before the WR-05 fix it was 6 (3 from sickDaysAbsence init + 3 from LeaveRequest loop)
    expect(emp!.sickDaysWithoutAttest).toBe(3);
    expect(emp!.sickDaysWithAttest).toBe(0);
    expect(emp!.sickDays).toBe(3);
  });

  // ── Test B: No absence record — only LeaveRequest ──────────────────────────
  it("Test B: sickDaysWithoutAttest = 2 when only a Kinderkrank LeaveRequest exists (no Absence)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?year=2025&month=3&employeeId=${empB.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const rows: Array<{
      employeeId: string;
      sickDays: number;
      sickDaysWithAttest: number;
      sickDaysWithoutAttest: number;
    }> = body.rows;

    const emp = rows.find((r) => r.employeeId === empB.id);
    expect(emp).toBeDefined();

    expect(emp!.sickDaysWithoutAttest).toBe(2);
    expect(emp!.sickDaysWithAttest).toBe(0);
    expect(emp!.sickDays).toBe(2);
  });

  // ── Test C: Full attest + Absence — no double-count ────────────────────────
  it("Test C: sickDaysWithAttest = 5, sickDaysWithoutAttest = 0 when full attest + Absence(SICK) for same 5 days", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?year=2025&month=3&employeeId=${empC.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const rows: Array<{
      employeeId: string;
      sickDays: number;
      sickDaysWithAttest: number;
      sickDaysWithoutAttest: number;
    }> = body.rows;

    const emp = rows.find((r) => r.employeeId === empC.id);
    expect(emp).toBeDefined();

    // All 5 days are attestiert — sickDaysWithoutAttest must be 0 (not 5 from Absence init)
    expect(emp!.sickDaysWithAttest).toBe(5);
    expect(emp!.sickDaysWithoutAttest).toBe(0);
    expect(emp!.sickDays).toBe(5);
  });

  // ── Integrity: sickDays always equals the sum of attest + without-attest ───
  it("sickDays = sickDaysWithAttest + sickDaysWithoutAttest (no double-count in total)", async () => {
    // Verify all three employees in one batch call without employeeId filter
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?year=2025&month=3`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const rows: Array<{
      employeeId: string;
      sickDays: number;
      sickDaysWithAttest: number;
      sickDaysWithoutAttest: number;
    }> = body.rows;

    const empIds = [empA.id, empB.id, empC.id];
    for (const id of empIds) {
      const emp = rows.find((r) => r.employeeId === id);
      expect(emp).toBeDefined();
      // Fundamental invariant: total = attest + without-attest
      expect(emp!.sickDays).toBe(emp!.sickDaysWithAttest + emp!.sickDaysWithoutAttest);
    }
  });
});
