/**
 * Issue #433 review (WR-01) — GET /dashboard/ MONTHLY_HOURS branch must not fabricate
 * `today` as a stand-in hireDate when the employee row cannot be found.
 *
 * Before this fix, `dashboard.ts`'s MONTHLY_HOURS Soll block fetched `meEmployee` and fell
 * back with `hireDate: meEmployee?.hireDate ?? today`. A missing employee row (deleted
 * mid-request, DB inconsistency) silently produced a Soll clipped to "hired today" — i.e. a
 * drastically wrong, too-small Soll — instead of skipping the computation the way the file's
 * own established convention elsewhere (`meEmployee?.hireDate ?? null`) treats this case.
 *
 * This test simulates that race by mocking the ONE `app.prisma.employee.findUnique` call the
 * MONTHLY_HOURS branch makes to return null for a single invocation, then asserts the dashboard
 * degrades to no Soll (`targetHours: 0`) rather than computing a "hired today" value.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";

describe("Issue #433 review (WR-01) — dashboard MONTHLY_HOURS Soll with a vanished employee row", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empToken: string;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-20T10:00:00.000Z"));

    app = await getTestApp();
    const seed = await seedTestData(app, "dashwr01433", { withDefaultSalon: false });
    tenantId = seed.tenant.id;

    const salon = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });

    const passwordHash = await bcrypt.hash("test1234", 10);
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const email = `wr01-433-${suffix}@test.de`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `wr01-433-${suffix}`,
        firstName: "WR01",
        lastName: "Missing433",
        hireDate: new Date("2025-01-01T00:00:00Z"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "MONTHLY_HOURS",
        monthlyHours: 44,
        workDays: [1, 2, 3, 4, 5],
        overtimeMode: "CARRY_FORWARD",
        validFrom: new Date("2025-01-01T00:00:00Z"),
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId: employee.id,
        salonId: salon.id,
        kind: "HOME",
        validFrom: new Date("2025-01-01T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: 0 },
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "test1234" },
    });
    empToken = (JSON.parse(loginRes.body) as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("dashboard-monthly-hours-missing-employee-433 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("skips the Soll computation (targetHours: 0) instead of using `today` as hireDate", async () => {
    // Simulate the employee row vanishing between the auth check (JWT-only) and the
    // MONTHLY_HOURS branch's own lookup — the race the review flagged. Only the FIRST
    // `employee.findUnique` call in this route (the MONTHLY_HOURS branch's own lookup,
    // dashboard.ts line ~219) is mocked away — a LATER, unrelated `employee.findUnique`
    // call further down the same route (the open-items hireDate/exitDate clamp) still
    // resolves normally, so this test does not assert a call count.
    const findUniqueSpy = vi
      .spyOn(app.prisma.employee, "findUnique")
      .mockResolvedValueOnce(null as never);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/",
      headers: { authorization: `Bearer ${empToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { month?: { targetHours: number } };
    expect(body.month?.targetHours).toBe(0);
    expect(findUniqueSpy).toHaveBeenCalled();

    findUniqueSpy.mockRestore();
  });

  it("control: with the employee row present, the Soll is computed normally (non-zero)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/",
      headers: { authorization: `Bearer ${empToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { month?: { targetHours: number } };
    expect(body.month?.targetHours).toBeGreaterThan(0);
  });
});
