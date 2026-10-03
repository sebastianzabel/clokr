/**
 * Issue #451 (D-07) — GET /leave/entitlements/:employeeId carries the Resturlaub facade's
 * result additively as `vacationBalance` on the VACATION row. Fixed calendar dates (2026) —
 * the carry-over deadline (31 March 2026) is already in the past relative to the real wall
 * clock this route reads (`req.testNow ?? new Date()`, no fake-clock header in this suite), and
 * stays in the past for every future run — this is not a time bomb (see `carryOverAtRiskDays`'s
 * own "0 once the deadline has passed" rule: once `now > deadline` holds once, it holds forever).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { getVacationBalance } from "../contexts/absence/facade/vacation-balance";
import type { FastifyInstance } from "fastify";

describe("Issue #451 (D-07) — GET /leave/entitlements exposes vacationBalance", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployee(label: string): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `evb451-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `EVB451-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate: new Date(Date.UTC(2024, 0, 1)),
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
        validFrom: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    return employee.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "evb451");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("VACATION row carries vacationBalance equal to the facade's own result and the /leave page formula", async () => {
    const employeeId = await mkEmployee("s1");
    const ent = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        usedDays: 7,
        carriedOverDays: 5,
        carryOverDeadline: new Date(Date.UTC(2026, 2, 31, 23, 59, 59)),
        isAutoCalculated: true,
      },
    });
    await app.prisma.auditLog.create({
      data: {
        action: "CARRYOVER_WARNED",
        entity: "LeaveEntitlement",
        entityId: ent.id,
        newValue: { year: 2026, carriedOverDays: 5 },
      },
    });
    // 3 days before the deadline (consumes the carry via FIFO) + 4 days after it — 7 total,
    // matching the entitlement's own usedDays above so selfHealUsedDays is a no-op here.
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2026, 1, 2)),
        endDate: new Date(Date.UTC(2026, 1, 4)),
        days: 3,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2026, 5, 1)),
        endDate: new Date(Date.UTC(2026, 5, 4)),
        days: 4,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2026`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode, `GET must succeed: ${res.body}`).toBe(200);
    const rows = JSON.parse(res.body) as Array<{
      id: string;
      typeCode: string;
      totalDays: string | number;
      usedDays: string | number;
      effectiveCarryOverDays: number;
      vacationBalance: {
        remainingDays: number;
        carriedOverEffectiveDays: number;
        carriedOverExpiredDays: number;
      } | null;
    }>;
    const row = rows.find((r) => r.id === ent.id);
    expect(row, "entitlement row must be present").toBeDefined();
    expect(row!.typeCode).toBe("VACATION");

    expect(row!.vacationBalance).not.toBeNull();
    expect(row!.vacationBalance!.remainingDays).toBe(26);
    expect(row!.vacationBalance!.carriedOverEffectiveDays).toBe(3);
    expect(row!.vacationBalance!.carriedOverExpiredDays).toBe(2);

    // The two cannot diverge: GET's own `effectiveCarryOverDays` field is now taken FROM the
    // facade result, and the /leave page's own formula (totalDays + effectiveCarryOverDays -
    // usedDays) must equal the facade's remainingDays.
    expect(row!.effectiveCarryOverDays).toBe(row!.vacationBalance!.carriedOverEffectiveDays);
    expect(Number(row!.totalDays) + row!.effectiveCarryOverDays - Number(row!.usedDays)).toBe(
      row!.vacationBalance!.remainingDays,
    );

    const direct = await getVacationBalance(
      app.prisma,
      employeeId,
      data.tenant.id,
      2026,
      new Date(),
    );
    expect(direct).not.toBeNull();
    expect(direct!.remainingDays).toBe(row!.vacationBalance!.remainingDays);
  });

  it("non-VACATION rows carry no vacationBalance; every pre-existing field keeps its value", async () => {
    const employeeId = await mkEmployee("s2");
    const specialType = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, name: "Sonderurlaub (Test #451)", code: "SPECIAL" },
    });
    const vacEnt = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        usedDays: 7,
        carriedOverDays: 5,
        carryOverDeadline: new Date(Date.UTC(2026, 2, 31, 23, 59, 59)),
        isAutoCalculated: true,
      },
    });
    await app.prisma.auditLog.create({
      data: {
        action: "CARRYOVER_WARNED",
        entity: "LeaveEntitlement",
        entityId: vacEnt.id,
        newValue: { year: 2026, carriedOverDays: 5 },
      },
    });
    const specialEnt = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: specialType.id,
        year: 2026,
        totalDays: 10,
        usedDays: 0,
        carriedOverDays: 0,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2026`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<{
      id: string;
      typeCode: string;
      effectiveCarryOverDays: number;
      vacationBalance: unknown;
    }>;

    const specialRow = rows.find((r) => r.id === specialEnt.id);
    expect(specialRow, "non-VACATION row must still be present").toBeDefined();
    expect(specialRow!.vacationBalance).toBeNull();

    const vacRow = rows.find((r) => r.id === vacEnt.id);
    expect(vacRow, "VACATION row must still be present").toBeDefined();
    // Pre-existing field untouched by this plan.
    expect(vacRow!.effectiveCarryOverDays).toBe(3);
  });
});
