/**
 * Issue #595, Plan 595-01 - fixing the closed-month lookup is a READ change. A legacy
 * UTC-naive row is read as closed with its stored figures and is never rewritten, superseded or
 * recomputed (CLAUDE.md "Saldo Calculation & Monatsabschluss": closed months are never
 * recalculated).
 *
 * Every reader that touches the account is run against a tenant holding a legacy-closed month, a
 * TZ-converted closed month, an open month and an OvertimeAccount row; afterwards every
 * SaldoSnapshot and OvertimeAccount row of the tenant must be deep-equal to its state before the
 * reads, and no SaldoSnapshot/OvertimeAccount audit row may have been written by the caller.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  salonIdForEmployee,
} from "./setup";
import { legacySaldoSnapshotPeriodBounds, saldoSnapshotPeriodBounds } from "./test-dates";
import {
  computeMonthSaldo,
  computeMonthReportFigures,
} from "../contexts/working-time-account/month-saldo";

async function snapshotState(app: FastifyInstance, employeeIds: string[]) {
  return app.prisma.saldoSnapshot.findMany({
    where: { employeeId: { in: employeeIds } },
    orderBy: [{ id: "asc" }],
  });
}

async function accountState(app: FastifyInstance, employeeIds: string[]) {
  return app.prisma.overtimeAccount.findMany({
    where: { employeeId: { in: employeeIds } },
    orderBy: [{ id: "asc" }],
  });
}

describe("Issue #595 - readers never write a closed month", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let adminUserId: string;
  let employeeId: string;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));

    app = await getTestApp();
    const seed = await seedTestData(app, "nowrite-595");
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;
    adminUserId = seed.adminUser.id;

    const passwordHash = await bcrypt.hash("test1234", 10);
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `nw595-${suffix}@example.invalid`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `nw595-${suffix}`,
        firstName: "nw595",
        lastName: "NoWrite595",
        hireDate: new Date("2025-06-01T00:00:00Z"),
      },
    });
    employeeId = employee.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2025-06-01T00:00:00Z"),
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId: seed.salonId,
        kind: "HOME",
        validFrom: new Date("2025-06-01T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId, balanceHours: 12.5 } });

    for (const d of ["2026-09-01", "2026-09-02", "2026-10-01", "2026-10-02"]) {
      const start = new Date(`${d}T08:00:00Z`);
      await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: new Date(`${d}T00:00:00Z`),
          startTime: start,
          endTime: new Date(start.getTime() + 480 * 60_000),
          breakMinutes: 30,
          type: "WORK",
          salonId: await salonIdForEmployee(app.prisma, employeeId),
        },
      });
    }

    const mk = (bounds: { start: Date; end: Date }, worked: number, expected: number) =>
      app.prisma.saldoSnapshot.create({
        data: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: bounds.start,
          periodEnd: bounds.end,
          workedMinutes: worked,
          expectedMinutes: expected,
          balanceMinutes: worked - expected,
          carryOver: worked - expected,
          closedAt: new Date(),
          closedBy: adminUserId,
        },
      });
    await mk(legacySaldoSnapshotPeriodBounds(2026, 9), 10530, 10560);
    await mk(saldoSnapshotPeriodBounds(new Date("2026-08-01T00:00:00Z")), 10200, 10080);
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("closed-month-never-recalculated-595 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("snapshot rows, accounts and the audit trail are untouched after every reader ran", async () => {
    const before = {
      snapshots: await snapshotState(app, [employeeId]),
      accounts: await accountState(app, [employeeId]),
    };
    expect(before.snapshots).toHaveLength(2);
    expect(before.accounts).toHaveLength(1);
    const startedAt = new Date();

    const headers = { authorization: `Bearer ${adminToken}` };
    for (const month of [8, 9, 10]) {
      await computeMonthSaldo(app, employeeId, 2026, month);
      await computeMonthReportFigures(app, employeeId, 2026, month);
      for (const url of [
        `/api/v1/overtime/month-saldo/${employeeId}?year=2026&month=${month}`,
        `/api/v1/reports/monthly?employeeId=${employeeId}&year=2026&month=${month}`,
        `/api/v1/reports/monthly/pdf?employeeId=${employeeId}&year=2026&month=${month}`,
        `/api/v1/reports/monthly/pdf/all?year=2026&month=${month}`,
      ]) {
        const res = await app.inject({ method: "GET", url, headers });
        expect(res.statusCode, url).toBe(200);
      }
    }
    for (const url of [
      `/api/v1/overtime/snapshots/${employeeId}`,
      `/api/v1/dashboard/team-trend?months=6`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers });
      expect(res.statusCode, url).toBe(200);
    }

    expect(await snapshotState(app, [employeeId])).toEqual(before.snapshots);
    expect(await accountState(app, [employeeId])).toEqual(before.accounts);

    const audit = await app.prisma.auditLog.findMany({
      where: {
        entity: { in: ["SaldoSnapshot", "OvertimeAccount"] },
        userId: adminUserId,
        createdAt: { gte: startedAt },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(audit).toHaveLength(0);
  });
});
