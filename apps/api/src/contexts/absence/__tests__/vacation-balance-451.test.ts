/**
 * Issue #451 (D-07) — the ONE Resturlaub function: `vacationBalanceForRow`/`getVacationBalance`
 * (`facade/vacation-balance.ts`). Fixed dates only (2026/2027) — no assertion depends on
 * `new Date()`; every scenario explicitly passes its own `now` instead of relying on a wall
 * clock. Each scenario uses its own fresh employee (hire 2024-01-01, FIXED Mo-Fr,
 * initials-only — CLAUDE.md, no PII).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { vacationBalanceForRow, getVacationBalance } from "../facade/vacation-balance";
import type { FastifyInstance } from "fastify";
import type { LeaveEntitlement } from "@clokr/db";

describe("Issue #451 (D-07) — the Resturlaub facade", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployee(
    label: string,
    overrides: { hireDate?: Date; exitDate?: Date | null } = {},
  ): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `vb451-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `VB451-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate: overrides.hireDate ?? new Date(Date.UTC(2024, 0, 1)),
        exitDate: overrides.exitDate ?? null,
      },
    });
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
        validFrom: overrides.hireDate ?? new Date(Date.UTC(2024, 0, 1)),
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    return employee.id;
  }

  async function mkEntitlement(
    employeeId: string,
    overrides: {
      totalDays?: number;
      usedDays?: number;
      carriedOverDays?: number;
      carryOverDeadline?: Date;
    } = {},
  ): Promise<LeaveEntitlement> {
    return app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        usedDays: 0,
        carriedOverDays: 0,
        isAutoCalculated: true,
        ...overrides,
      },
    });
  }

  async function mkApprovedVacation(employeeId: string, start: Date, end: Date, days: number) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: start,
        endDate: end,
        days,
      },
    });
  }

  async function seedWarned(entitlementId: string, year: number, carriedOverDays: number) {
    await app.prisma.auditLog.create({
      data: {
        action: "CARRYOVER_WARNED",
        entity: "LeaveEntitlement",
        entityId: entitlementId,
        newValue: { year, carriedOverDays },
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vb451");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("warned FIFO carry-over past its deadline: effective 3, expired 2, used 7, remaining 26, atRisk 0", async () => {
    const employeeId = await mkEmployee("s1");
    const ent = await mkEntitlement(employeeId, {
      totalDays: 30,
      carriedOverDays: 5,
      carryOverDeadline: new Date(Date.UTC(2026, 2, 31, 23, 59, 59)),
    });
    await mkApprovedVacation(
      employeeId,
      new Date(Date.UTC(2026, 1, 2)),
      new Date(Date.UTC(2026, 1, 4)),
      3,
    );
    await mkApprovedVacation(
      employeeId,
      new Date(Date.UTC(2026, 5, 1)),
      new Date(Date.UTC(2026, 5, 4)),
      4,
    );
    await seedWarned(ent.id, 2026, 5);
    const used = await app.prisma.leaveEntitlement.update({
      where: { id: ent.id },
      data: { usedDays: 7 },
    });

    const result = await vacationBalanceForRow(
      app.prisma,
      used,
      data.tenant.id,
      new Date(Date.UTC(2026, 6, 1)),
    );

    expect(result.carriedOverEffectiveDays).toBe(3);
    expect(result.carriedOverExpiredDays).toBe(2);
    expect(result.usedDays).toBe(7);
    expect(result.remainingDays).toBe(26);
    expect(result.atRiskDays).toBe(0);
  });

  it("same fixture WITHOUT the CARRYOVER_WARNED audit — the carry never lapses (EuGH C-684/16)", async () => {
    const employeeId = await mkEmployee("s2");
    const ent = await mkEntitlement(employeeId, {
      totalDays: 30,
      carriedOverDays: 5,
      carryOverDeadline: new Date(Date.UTC(2026, 2, 31, 23, 59, 59)),
    });
    await mkApprovedVacation(
      employeeId,
      new Date(Date.UTC(2026, 1, 2)),
      new Date(Date.UTC(2026, 1, 4)),
      3,
    );
    await mkApprovedVacation(
      employeeId,
      new Date(Date.UTC(2026, 5, 1)),
      new Date(Date.UTC(2026, 5, 4)),
      4,
    );
    const used = await app.prisma.leaveEntitlement.update({
      where: { id: ent.id },
      data: { usedDays: 7 },
    });

    const result = await vacationBalanceForRow(
      app.prisma,
      used,
      data.tenant.id,
      new Date(Date.UTC(2026, 6, 1)),
    );

    expect(result.carriedOverEffectiveDays).toBe(5);
    expect(result.carriedOverExpiredDays).toBe(0);
    expect(result.remainingDays).toBe(28);
  });

  it("before the deadline, carry 5 minus 2 already taken is still at risk: atRisk 3", async () => {
    const employeeId = await mkEmployee("s3");
    const ent = await mkEntitlement(employeeId, {
      totalDays: 30,
      carriedOverDays: 5,
      carryOverDeadline: new Date(Date.UTC(2026, 2, 31, 23, 59, 59)),
    });
    await mkApprovedVacation(
      employeeId,
      new Date(Date.UTC(2026, 1, 2)),
      new Date(Date.UTC(2026, 1, 3)),
      2,
    );

    const result = await vacationBalanceForRow(
      app.prisma,
      ent,
      data.tenant.id,
      new Date(Date.UTC(2026, 2, 1)),
    );

    expect(result.atRiskDays).toBe(3);
  });

  it("a PENDING VACATION request starting in the row's year counts; one starting next year does not", async () => {
    const employeeId = await mkEmployee("s4");
    const ent = await mkEntitlement(employeeId);
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "PENDING",
        startDate: new Date(Date.UTC(2026, 8, 1)),
        endDate: new Date(Date.UTC(2026, 8, 2)),
        days: 2,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "PENDING",
        startDate: new Date(Date.UTC(2027, 0, 4)),
        endDate: new Date(Date.UTC(2027, 0, 5)),
        days: 2,
      },
    });

    const result = await vacationBalanceForRow(
      app.prisma,
      ent,
      data.tenant.id,
      new Date(Date.UTC(2026, 6, 1)),
    );

    expect(result.pendingDays).toBe(2);
  });

  it("exit-year row (synced by the existing #447 path): exitReductionDays is the full-year value minus the synced totalDays (30 → 15)", async () => {
    const employeeId = await mkEmployee("s5", { exitDate: new Date(Date.UTC(2026, 5, 30)) });
    // Full-year value (hired 2024, no exit) is 30; exiting 30 June 2026 (6 of 12 months) syncs
    // the row's totalDays down to 15 via the existing #447 path (resolveRegularVacationDays).
    const ent = await mkEntitlement(employeeId, { totalDays: 15 });

    const result = await vacationBalanceForRow(
      app.prisma,
      ent,
      data.tenant.id,
      new Date(Date.UTC(2026, 6, 1)),
    );

    expect(result.exitReductionDays).toBe(15); // 30 (without exit) - 15 (with exit)
  });

  it("getVacationBalance returns null for a year without a VACATION row", async () => {
    const employeeId = await mkEmployee("s6");

    const result = await getVacationBalance(
      app.prisma,
      employeeId,
      data.tenant.id,
      2026,
      new Date(Date.UTC(2026, 6, 1)),
    );

    expect(result).toBeNull();
  });
});
