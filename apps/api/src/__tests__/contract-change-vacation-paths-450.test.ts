/**
 * Issue #450 (D-06) — the two REMAINING contract-change write paths (the cancelOrphanShifts
 * branch of PUT /api/v1/settings/work/:employeeId and the tenant-wide applyToExisting bulk apply
 * of PUT /api/v1/settings/work) recompute the affected auto-calculated VACATION entitlement per
 * contract segment (EuGH Brandes C-415/12, Greenfield C-219/14), exactly like the regular branch
 * already wired in 450-01.
 *
 * Fixed/real-clock dates only — every date is built via `new Date(Date.UTC(...))` or the real
 * clock (the bulk apply and the cancelOrphanShifts branch both compute their own `validFrom` from
 * "now", so the test mirrors that rather than injecting a fixed date). Initials-only fixtures
 * (firstName "T", lastName "T") — no PII per CLAUDE.md.
 *
 * Own seeded tenant (not shared with other 450-0x test files): the bulk apply touches EVERY
 * employee of the tenant, including seedTestData's own adminEmployee/employee fixtures — this
 * file's bulk-apply assertions are scoped to the specific employees/entitlement rows they create,
 * so the unrelated recomputes on the seed fixtures (if any) never interfere.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { roundVacationDaysBurlG } from "../contexts/absence/vacation-calc";
import { snapToMonthFirstUtc } from "../contexts/platform";

describe("PUT /api/v1/settings/work(/:employeeId) — remaining D-06 write paths recompute VACATION entitlement per segment (Issue #450)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployee(label: string, hireDate: Date): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cc450p-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `CC450P-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate,
      },
    });
    return employee.id;
  }

  async function mkFixedWorkSchedule(
    employeeId: string,
    workDays: number[],
    validFrom: Date,
  ): Promise<void> {
    await app.prisma.workSchedule.create({
      data: {
        employeeId,
        type: "FIXED_SCHEDULE",
        mondayHours: workDays.includes(1) ? 8 : 0,
        tuesdayHours: workDays.includes(2) ? 8 : 0,
        wednesdayHours: workDays.includes(3) ? 8 : 0,
        thursdayHours: workDays.includes(4) ? 8 : 0,
        fridayHours: workDays.includes(5) ? 8 : 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays,
        validFrom,
      },
    });
  }

  async function mkShiftBasedWorkSchedule(
    employeeId: string,
    contractWorkDaysPerWeek: number,
    validFrom: Date,
  ): Promise<void> {
    await app.prisma.workSchedule.create({
      data: {
        employeeId,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        contractWorkDaysPerWeek,
        workDays: [1, 2, 3, 4, 5],
        validFrom,
      },
    });
  }

  async function mkFutureShift(employeeId: string, daysAhead: number): Promise<void> {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
    await app.prisma.shift.create({
      data: {
        employeeId,
        salonId: data.salonId,
        date: new Date(`${iso}T00:00:00Z`),
        startTime: "08:00",
        endTime: "16:00",
        createdBy: data.adminEmployee.id,
      },
    });
  }

  async function mkEntitlement(employeeId: string, year: number, totalDays: number): Promise<void> {
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year,
        totalDays,
        usedDays: 0,
        carriedOverDays: 0,
        isAutoCalculated: true,
      },
    });
  }

  async function entitlementRow(employeeId: string, year: number) {
    return app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId: data.vacationType.id, year },
      },
    });
  }

  async function entitlementAudits(entitlementId: string) {
    return app.prisma.auditLog.findMany({
      where: { entity: "LeaveEntitlement", entityId: entitlementId, action: "UPDATE" },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cc450p");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("cancelOrphanShifts branch: SHIFT_BASED (3-day) -> FIXED_SCHEDULE (Mo-Fr) from the 1st of next UTC month recomputes year V's row by segment", async () => {
    const now = new Date();
    const V = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const validFromStr = V.toISOString().slice(0, 10);
    const Y = V.getUTCFullYear();
    const k = V.getUTCMonth();

    const employeeId = await mkEmployee("cos", new Date(Date.UTC(2024, 0, 1)));
    await mkShiftBasedWorkSchedule(employeeId, 3, new Date(Date.UTC(2024, 0, 1)));
    await mkFutureShift(employeeId, 5);
    await mkEntitlement(employeeId, Y, 18);

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { type: "FIXED_SCHEDULE", cancelOrphanShifts: true, validFrom: validFromStr },
    });
    expect(res.statusCode).toBe(200);

    // Existing behavior: the future shift is gone.
    const remainingShifts = await app.prisma.shift.count({ where: { employeeId } });
    expect(remainingShifts).toBe(0);

    const row = await entitlementRow(employeeId, Y);
    const expected = roundVacationDaysBurlG((18 * k + 30 * (12 - k)) / 12);
    expect(Number(row.totalDays)).toBe(expected);
    expect(row.isAutoCalculated).toBe(true);

    const audits = await entitlementAudits(row.id);
    expect(audits).toHaveLength(1);
    const newValue = audits[0].newValue as {
      totalDays: number;
      isAutoCalculated: boolean;
      reason: string;
      validFrom: string;
    };
    expect(newValue.totalDays).toBe(expected);
    expect(newValue.reason).toBe("Vertragswechsel");
    expect(newValue.validFrom).toBe(validFromStr);
  });

  it("bulk apply (applyToExisting): FIXED Mo-Mi -> Mo-Fr recomputes the current-year row by segment", async () => {
    const now = snapToMonthFirstUtc(new Date());
    const k = now.getUTCMonth();
    const currentYear = new Date().getUTCFullYear();

    const employeeId = await mkEmployee("bulk-e", new Date(Date.UTC(2024, 0, 1)));
    await mkFixedWorkSchedule(employeeId, [1, 2, 3], new Date(Date.UTC(2024, 0, 1)));
    await mkEntitlement(employeeId, currentYear, 18);

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        applyToExisting: true,
        defaultMondayHours: 8,
        defaultTuesdayHours: 8,
        defaultWednesdayHours: 8,
        defaultThursdayHours: 8,
        defaultFridayHours: 8,
      },
    });
    expect(res.statusCode).toBe(200);

    const newest = await app.prisma.workSchedule.findFirstOrThrow({
      where: { employeeId },
      orderBy: { validFrom: "desc" },
    });
    expect(newest.workDays).toEqual([1, 2, 3, 4, 5]);

    const row = await entitlementRow(employeeId, currentYear);
    const expected = roundVacationDaysBurlG((18 * k + 30 * (12 - k)) / 12);
    expect(Number(row.totalDays)).toBe(expected);

    const audits = await entitlementAudits(row.id);
    expect(audits).toHaveLength(1);
    const newValue = audits[0].newValue as {
      totalDays: number;
      isAutoCalculated: boolean;
      reason: string;
      validFrom: string;
    };
    expect(newValue.reason).toBe("Vertragswechsel");
    expect(newValue.validFrom).toBe(now.toISOString().slice(0, 10));
    expect(audits[0].userId).toBe(data.adminUser.id);
  });

  it("bulk apply control: an employee with NO WorkSchedule row and an auto row of 30 stays 30 with zero LeaveEntitlement audits", async () => {
    const currentYear = new Date().getUTCFullYear();
    const employeeId = await mkEmployee("bulk-f", new Date(Date.UTC(2024, 0, 1)));
    await mkEntitlement(employeeId, currentYear, 30);

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        applyToExisting: true,
        defaultMondayHours: 8,
        defaultTuesdayHours: 8,
        defaultWednesdayHours: 8,
        defaultThursdayHours: 8,
        defaultFridayHours: 8,
      },
    });
    expect(res.statusCode).toBe(200);

    const row = await entitlementRow(employeeId, currentYear);
    expect(Number(row.totalDays)).toBe(30);

    const audits = await entitlementAudits(row.id);
    expect(audits).toHaveLength(0);
  });
});
