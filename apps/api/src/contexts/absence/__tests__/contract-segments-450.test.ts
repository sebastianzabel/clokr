/**
 * Issue #450 (D-04/D-09) — DB-backed suite for `loadVacationContractSegments`'s D-04
 * normalization (legacy non-1st `WorkSchedule.validFrom` rows take effect on the 1st of the
 * following month, through the one extended Unterbau helper; the first contract row is never
 * moved) and for `ensureRegularVacationEntitlement`'s create path now computing per segment
 * (D-09) instead of from the newest `WorkSchedule` row alone.
 *
 * Fixed dates only — every date is built via `new Date(Date.UTC(...))`. Initials-only fixtures
 * (firstName "T", lastName "T") — no PII per CLAUDE.md. Own seeded tenant per `seedTestData`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import {
  loadVacationContractSegments,
  resolveRegularVacationDays,
  ensureRegularVacationEntitlement,
} from "../leave-days";
import type { FastifyInstance } from "fastify";

describe("loadVacationContractSegments / resolveRegularVacationDays (Issue #450, D-04)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployee(
    label: string,
    hireDate: Date,
    schedules: Array<{ validFrom: Date; workDays: number[] }>,
  ): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cs450-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `CS450-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate,
      },
    });
    for (const { validFrom, workDays } of schedules) {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
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
    return employee.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cs450");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("legacy non-1st rows normalize to the 1st of the FOLLOWING month; the first row is never moved", async () => {
    const employeeId = await mkEmployee("a", new Date(Date.UTC(2024, 2, 15)), [
      { validFrom: new Date(Date.UTC(2024, 2, 15)), workDays: [1, 2, 3, 4, 5] }, // Mo-Fr
      { validFrom: new Date(Date.UTC(2026, 4, 18)), workDays: [1, 2, 3] }, // Mo-Mi, pre-Phase-60 non-1st
      { validFrom: new Date(Date.UTC(2026, 8, 1)), workDays: [1, 2, 3, 4] }, // Mo-Do, already month-1st
    ]);

    const segments = await loadVacationContractSegments(app.prisma, employeeId, data.tenant.id);
    expect(segments).toHaveLength(3);
    // The first row is the contract start (hire date) — never moved, even though it is mid-month.
    expect(segments[0].from.toISOString()).toBe(new Date(Date.UTC(2024, 2, 15)).toISOString());
    expect(segments[0].workDaysPerWeek).toBe(5);
    // D-04: a pre-Phase-60 non-1st change (18.05.) takes effect on 01.06., never as a fractional
    // month — but the raw validFrom is preserved for the dry-run.
    expect(segments[1].from.toISOString()).toBe(new Date(Date.UTC(2026, 5, 1)).toISOString());
    expect(segments[1].validFrom?.toISOString()).toBe(
      new Date(Date.UTC(2026, 4, 18)).toISOString(),
    );
    expect(segments[1].workDaysPerWeek).toBe(3);
    // An already month-1st row's `from` equals its own `validFrom`.
    expect(segments[2].from.toISOString()).toBe(new Date(Date.UTC(2026, 8, 1)).toISOString());
    expect(segments[2].validFrom?.toISOString()).toBe(new Date(Date.UTC(2026, 8, 1)).toISOString());
    expect(segments[2].workDaysPerWeek).toBe(4);

    // 5x30 (Jan-May) + 3x18 (Jun-Aug) + 4x24 (Sep-Dec) = 300; 300/12 = 25.
    const regularDays = await resolveRegularVacationDays(
      app.prisma,
      employeeId,
      data.tenant.id,
      2026,
    );
    expect(regularDays).toBe(25);
  });

  it("two rows normalizing to the SAME month-1st: the later row wins (tie-break)", async () => {
    const employeeId = await mkEmployee("b", new Date(Date.UTC(2020, 0, 1)), [
      { validFrom: new Date(Date.UTC(2020, 0, 1)), workDays: [1, 2, 3, 4, 5] }, // Mo-Fr
      { validFrom: new Date(Date.UTC(2026, 4, 10)), workDays: [1, 2, 3] }, // Mo-Mi, normalizes to 01.06.
      { validFrom: new Date(Date.UTC(2026, 5, 1)), workDays: [1, 2, 3, 4] }, // Mo-Do, already 01.06.
    ]);

    const segments = await loadVacationContractSegments(app.prisma, employeeId, data.tenant.id);
    expect(segments).toHaveLength(3);
    expect(segments[1].from.toISOString()).toBe(new Date(Date.UTC(2026, 5, 1)).toISOString());
    expect(segments[2].from.toISOString()).toBe(new Date(Date.UTC(2026, 5, 1)).toISOString());

    // Tie at 01.06.: the later array element (Mo-Do, wd=4) wins for June onward.
    // 5x30 (Jan-May) + 7x24 (Jun-Dec) = 318; 318/12 = 26.5 -> 27 (BUrlG rounds up).
    const regularDays = await resolveRegularVacationDays(
      app.prisma,
      employeeId,
      data.tenant.id,
      2026,
    );
    expect(regularDays).toBe(27);
  });

  it("an employee with no WorkSchedule row at all gets exactly one segment at the tenant default", async () => {
    const employeeId = await mkEmployee("c", new Date(Date.UTC(2020, 0, 1)), []);

    const segments = await loadVacationContractSegments(app.prisma, employeeId, data.tenant.id);
    expect(segments).toHaveLength(1);
    expect(segments[0].workDaysPerWeek).toBe(5);
    expect(segments[0].workScheduleId).toBeNull();
  });
});

describe("ensureRegularVacationEntitlement create path (Issue #450, D-09)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployeeNoEntitlement(
    label: string,
    hireDate: Date,
    schedules: Array<{ validFrom: Date; workDays: number[] }>,
  ): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cs450e-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `CS450E-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate,
      },
    });
    for (const { validFrom, workDays } of schedules) {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
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
    return employee.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cs450e");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("creates the 2026 entitlement at the segment-computed value (24), not the newest-row value (30)", async () => {
    const employeeId = await mkEmployeeNoEntitlement("a", new Date(Date.UTC(2024, 0, 1)), [
      { validFrom: new Date(Date.UTC(2024, 0, 1)), workDays: [1, 2, 3] }, // Mo-Mi (3-day)
      { validFrom: new Date(Date.UTC(2026, 6, 1)), workDays: [1, 2, 3, 4, 5] }, // Mo-Fr (5-day) from 01.07.
    ]);

    const result = await ensureRegularVacationEntitlement(
      app.prisma,
      employeeId,
      data.tenant.id,
      2026,
      data.vacationType.id,
      "reason",
    );
    expect(result.created).toBe(true);
    // 6x18 (Jan-Jun, wd=3) + 6x30 (Jul-Dec, wd=5) = 108+180=288; 288/12=24.
    expect(Number(result.entitlement.totalDays)).toBe(24);

    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "LeaveEntitlement", entityId: result.entitlement.id, action: "CREATE" },
    });
    expect(audits).toHaveLength(1);
    expect((audits[0].newValue as { totalDays: number }).totalDays).toBe(24);
  });
});
