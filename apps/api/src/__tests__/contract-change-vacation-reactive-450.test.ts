/**
 * Issue #450 (D-06, ADR 0002 Entscheidung 10) — the reactive VACATION-entitlement recompute runs
 * AFTER the WorkSchedule write has already committed, and its own failure must never roll back
 * or fail the PUT: the response is still 200, the new WorkSchedule row exists, the entitlement
 * stays whatever it was, and the failure is logged with the employeeId and a fixed message.
 *
 * `recalcVacationEntitlementsForContractChange` is mocked to reject so this is proven directly,
 * not inferred — `vi.mock` is file-scoped (Vitest's per-file module isolation, see setup.ts's own
 * docblock on `app` rebuilding per file), so this mock never leaks into any other test file's
 * `buildApp()`.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("../contexts/absence", async (importOriginal) => {
  const original = await importOriginal<typeof import("../contexts/absence")>();
  return {
    ...original,
    recalcVacationEntitlementsForContractChange: vi.fn(async () => {
      throw new Error("recalc failed (test)");
    }),
  };
});

import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("PUT /api/v1/settings/work/:employeeId — the D-06 recompute's own failure never breaks the write (Issue #450)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployee(label: string, workDays: number[]): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cc450r-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `CC450R-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate: new Date(Date.UTC(2024, 0, 1)),
      },
    });
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
        validFrom: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    return employee.id;
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

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cc450r");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("recompute rejecting still returns 200, commits the WorkSchedule row, leaves the entitlement unchanged, and logs the failure", async () => {
    const employeeId = await mkEmployee("reactive", [1, 2, 3]);
    await mkEntitlement(employeeId, 2026, 18);
    const logSpy = vi.spyOn(app.log, "error");

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { type: "FIXED_SCHEDULE", validFrom: "2026-07-01" },
    });

    expect(res.statusCode).toBe(200);

    const schedule = await app.prisma.workSchedule.findFirst({
      where: { employeeId, validFrom: new Date("2026-07-01T00:00:00Z") },
    });
    expect(schedule).not.toBeNull();

    const row = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId: data.vacationType.id, year: 2026 },
      },
    });
    expect(Number(row.totalDays)).toBe(18);

    const logged = logSpy.mock.calls.find(
      ([obj, msg]) =>
        typeof obj === "object" &&
        obj !== null &&
        (obj as { employeeId?: string }).employeeId === employeeId &&
        msg === "Failed to recalculate vacation entitlements after schedule change",
    );
    expect(
      logged,
      "the recompute failure must be logged with employeeId and the fixed message",
    ).toBeDefined();
  });
});
