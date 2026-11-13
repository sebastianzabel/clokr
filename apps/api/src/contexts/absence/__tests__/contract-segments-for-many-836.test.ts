/**
 * Issue #836 — `loadVacationContractSegmentsForMany` returns, for every employee, exactly what
 * `loadVacationContractSegments` returns for that employee (byte-parity through the one private
 * row -> segment mapping), in a constant number of queries.
 *
 * Fixtures (no names): no schedule row, one FIXED_SCHEDULE row, a SHIFT_BASED row with
 * `usualWorkDays`, two rows with a later mid-month `validFrom` (the #450 snap to the 1st of the
 * following month).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { loadVacationContractSegments, loadVacationContractSegmentsForMany } from "../leave-days";

describe("loadVacationContractSegmentsForMany (Issue #836)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const ids: Record<string, string> = {};

  async function mkEmployee(label: string): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: { email: `cs836-${label}-${uid}@test.de`, passwordHash: "x", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `CS836-${label}-${uid}`.slice(0, 20),
        firstName: "T",
        lastName: "T",
        hireDate: new Date("2024-01-01"),
      },
    });
    return employee.id;
  }

  async function schedule(
    employeeId: string,
    validFrom: string,
    extra: {
      type?: "FIXED_SCHEDULE" | "SHIFT_BASED";
      workDays?: number[];
      usualWorkDays?: number[];
      contractWorkDaysPerWeek?: number;
    },
  ) {
    const workDays = extra.workDays ?? [1, 2, 3, 4, 5];
    await app.prisma.workSchedule.create({
      data: {
        employeeId,
        type: extra.type ?? "FIXED_SCHEDULE",
        mondayHours: workDays.includes(1) ? 8 : 0,
        tuesdayHours: workDays.includes(2) ? 8 : 0,
        wednesdayHours: workDays.includes(3) ? 8 : 0,
        thursdayHours: workDays.includes(4) ? 8 : 0,
        fridayHours: workDays.includes(5) ? 8 : 0,
        saturdayHours: workDays.includes(6) ? 8 : 0,
        sundayHours: workDays.includes(0) ? 8 : 0,
        workDays,
        usualWorkDays: extra.usualWorkDays ?? [],
        contractWorkDaysPerWeek: extra.contractWorkDaysPerWeek ?? null,
        validFrom: new Date(`${validFrom}T00:00:00Z`),
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cs836");
    for (const label of ["none", "fixed", "shift", "two", "pad1", "pad2", "pad3"]) {
      ids[label] = await mkEmployee(label);
    }
    await schedule(ids.fixed, "2024-01-01", { workDays: [2, 3, 4, 5, 6] });
    await schedule(ids.shift, "2024-01-01", {
      type: "SHIFT_BASED",
      workDays: [1, 2, 3, 4, 5],
      usualWorkDays: [2, 3, 4],
      contractWorkDaysPerWeek: 3,
    });
    await schedule(ids.two, "2024-01-01", { workDays: [1, 2, 3, 4, 5] });
    await schedule(ids.two, "2026-03-15", { workDays: [1, 2, 3, 4] }); // mid-month, snaps to 04-01
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
  });

  it("returns for every employee exactly what the single-person loader returns", async () => {
    const many = await loadVacationContractSegmentsForMany(app.prisma, data.tenant.id, [
      ids.none,
      ids.fixed,
      ids.shift,
      ids.two,
    ]);
    for (const label of ["none", "fixed", "shift", "two"]) {
      const single = await loadVacationContractSegments(app.prisma, ids[label], data.tenant.id);
      expect(many.get(ids[label]), label).toEqual(single);
    }
    // The cases really differ (a parity test over four equal answers would be vacuous).
    expect(many.get(ids.none)![0].workScheduleId).toBeNull();
    expect(many.get(ids.shift)![0].usualWorkDays).toEqual([2, 3, 4]);
    expect(many.get(ids.two)!.length).toBe(2);
    expect(many.get(ids.two)![1].from.toISOString().slice(0, 10)).toBe("2026-04-01");
  });

  it("an empty input returns an empty map with zero queries", async () => {
    const spy = vi.spyOn(app.prisma.workSchedule, "findMany");
    const result = await loadVacationContractSegmentsForMany(app.prisma, data.tenant.id, []);
    expect(result.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("issues the same number of queries for 1 and for 5 employees", async () => {
    const schedSpy = vi.spyOn(app.prisma.workSchedule, "findMany");
    const cfgSpy = vi.spyOn(app.prisma.tenantConfig, "findUnique");
    await loadVacationContractSegmentsForMany(app.prisma, data.tenant.id, [ids.fixed]);
    const oneSched = schedSpy.mock.calls.length;
    const oneCfg = cfgSpy.mock.calls.length;
    schedSpy.mockClear();
    cfgSpy.mockClear();
    await loadVacationContractSegmentsForMany(app.prisma, data.tenant.id, [
      ids.none,
      ids.fixed,
      ids.shift,
      ids.two,
      ids.pad1,
    ]);
    expect(schedSpy.mock.calls.length).toBe(oneSched);
    expect(cfgSpy.mock.calls.length).toBe(oneCfg);
    expect(oneSched).toBe(1);
    expect(oneCfg).toBe(1);
    schedSpy.mockRestore();
    cfgSpy.mockRestore();
  });
});
