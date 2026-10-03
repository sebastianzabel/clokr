/**
 * resturlaub-parity-451.test.ts
 *
 * Issue #451 point 6 + #445 addendum (D-07, D-08) — Plan 451-08. One cross-site parity test
 * proving the dashboard tile, the Urlaubsübersicht JSON, GET /leave/entitlements and the
 * Resturlaub facade itself all report the SAME remaining vacation for the same employee/year —
 * all from `vacationBalanceForRow`/`getVacationBalance` (contexts/absence/facade/vacation-balance.ts).
 *
 * Fixed fixture (Issue #451's own D-07 example): 30 days, 5 carried over with deadline 31.03.2026
 * and a documented CARRYOVER_WARNED Hinweis, 3 days taken in February (before the deadline — FIFO
 * consumes the carry first), 4 in June → remaining 26 everywhere (the carry's expired 2 days are
 * NOT added back), not 28 (the pre-#451 `total + carried − used` formula).
 *
 * Fake clock 2026-07-01T10:00:00Z throughout — fixed calendar dates, never a date-relative
 * fixture (CLAUDE.md, issues #394/#434); the deadline (31 March 2026) is already in the past
 * relative to the fake clock and stays in the past for every future run.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { getVacationBalance } from "../contexts/absence/facade/vacation-balance";
import type { FastifyInstance } from "fastify";

async function loginAs(app: FastifyInstance, email: string, password = "test1234") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  const { accessToken } = JSON.parse(res.body) as { accessToken: string };
  return accessToken;
}

describe("Issue #451 Plan 08 (D-07, D-08) — one Resturlaub across dashboard, Urlaubsuebersicht, entitlements, facade", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let employeeId: string;
  let empToken: string;
  let entitlementId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rbp451");

    const passwordHash = await bcrypt.hash("test1234", 10);
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const email = `rbp451-${suffix}@test.de`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `RBP451-${suffix}`,
        firstName: "Resturlaub",
        lastName: "Parity451",
        hireDate: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    employeeId = employee.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    if (data.salonId) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: data.tenant.id,
          employeeId: employee.id,
          salonId: data.salonId,
          kind: "HOME",
          validFrom: new Date(Date.UTC(2024, 0, 1)),
          validUntil: null,
          weekdays: [],
        },
      });
    }
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });

    const ent = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        usedDays: 7,
        carriedOverDays: 5,
        carryOverDeadline: new Date(Date.UTC(2026, 2, 31, 23, 59, 59)),
        isAutoCalculated: true,
      },
    });
    entitlementId = ent.id;
    await app.prisma.auditLog.create({
      data: {
        action: "CARRYOVER_WARNED",
        entity: "LeaveEntitlement",
        entityId: ent.id,
        newValue: { year: 2026, carriedOverDays: 5 },
      },
    });

    // 3 days before the deadline (FIFO-consumes the carry) + 4 days after it — 7 total,
    // matching the entitlement's own usedDays above so selfHealUsedDays is a no-op.
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2026, 1, 2)),
        endDate: new Date(Date.UTC(2026, 1, 4)),
        days: 3,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2026, 5, 1)),
        endDate: new Date(Date.UTC(2026, 5, 4)),
        days: 4,
      },
    });
    // A PENDING request in 2026 — the leave-overview row's pendingDays must equal the facade's.
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: data.vacationType.id,
        status: "PENDING",
        startDate: new Date(Date.UTC(2026, 8, 1)),
        endDate: new Date(Date.UTC(2026, 8, 2)),
        days: 2,
      },
    });

    empToken = await loginAs(app, email);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("451-08 resturlaub-parity cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("dashboard, Urlaubsuebersicht, GET /entitlements and the facade all report remaining 26 (not 28)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T10:00:00.000Z"));

    // 1) GET /api/v1/dashboard (employee token)
    const dashRes = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/",
      headers: { authorization: `Bearer ${empToken}` },
    });
    expect(dashRes.statusCode, `dashboard must succeed: ${dashRes.body}`).toBe(200);
    const dashBody = JSON.parse(dashRes.body) as {
      vacation: { remaining: number; total: number; used: number } | null;
    };
    expect(dashBody.vacation, "vacation block must be present").not.toBeNull();
    expect(dashBody.vacation!.remaining, "dashboard remaining — RED before: 28").toBe(26);
    expect(dashBody.vacation!.total, "dashboard total — RED before: 35").toBe(33);
    expect(dashBody.vacation!.used).toBe(7);

    // 2) GET /api/v1/reports/leave-overview?year=2026 (admin token)
    const overviewRes = await app.inject({
      method: "GET",
      url: "/api/v1/reports/leave-overview?year=2026",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(overviewRes.statusCode, `leave-overview must succeed: ${overviewRes.body}`).toBe(200);
    const overviewRows = JSON.parse(overviewRes.body) as Array<{
      employee: { id: string } | { employeeNumber: string };
      leaveType: { code: string } | null;
      remainingDays: number | null;
      carriedOverEffectiveDays?: number;
      carriedOverExpiredDays?: number;
      pendingDays: number | null;
    }>;
    const overviewRow = overviewRows.find(
      (r) =>
        r.leaveType?.code === "VACATION" &&
        "id" in r.employee &&
        (r.employee as { id: string }).id === employeeId,
    );
    expect(overviewRow, "VACATION row for this employee must be present").toBeDefined();
    expect(overviewRow!.remainingDays, "leave-overview remainingDays — RED before: 28").toBe(26);
    expect(overviewRow!.carriedOverEffectiveDays, "RED before: field absent").toBe(3);
    expect(overviewRow!.carriedOverExpiredDays, "RED before: field absent").toBe(2);

    // 3) GET /api/v1/leave/entitlements/:id?year=2026 (admin token) — the 451-07 facade field
    const entRes = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2026`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(entRes.statusCode).toBe(200);
    const entRows = JSON.parse(entRes.body) as Array<{
      id: string;
      vacationBalance: { remainingDays: number; pendingDays: number } | null;
    }>;
    const entRow = entRows.find((r) => r.id === entitlementId);
    expect(entRow, "entitlement row must be present").toBeDefined();
    expect(entRow!.vacationBalance).not.toBeNull();
    expect(entRow!.vacationBalance!.remainingDays).toBe(26);

    // 4) Direct facade call — the single source of truth all three readers above agree with.
    const direct = await getVacationBalance(
      app.prisma,
      employeeId,
      data.tenant.id,
      2026,
      new Date("2026-07-01T10:00:00.000Z"),
    );
    expect(direct).not.toBeNull();
    expect(direct!.remainingDays).toBe(26);

    // All four readers equal.
    expect(dashBody.vacation!.remaining).toBe(overviewRow!.remainingDays);
    expect(overviewRow!.remainingDays).toBe(entRow!.vacationBalance!.remainingDays);
    expect(entRow!.vacationBalance!.remainingDays).toBe(direct!.remainingDays);

    // pendingDays: the leave-overview row equals the facade's own pendingDays (the 2-day
    // PENDING request created above).
    expect(overviewRow!.pendingDays).toBe(2);
    expect(overviewRow!.pendingDays).toBe(direct!.pendingDays);
    expect(entRow!.vacationBalance!.pendingDays).toBe(2);
  });
});
