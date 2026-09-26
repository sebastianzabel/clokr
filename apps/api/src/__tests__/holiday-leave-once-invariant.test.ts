/**
 * Phase 71b Plan 04 (issue #71, D-08/AC-12) — "a day reduces Soll exactly once".
 *
 * `calcLeaveAbsenceMinutesTz()` (contexts/working-time-account/timezone.ts) and the `sbClaimed`
 * dedup set in `close-employee-month.ts` carry this invariant and are NOT split or restructured by
 * Phase 71b — they still consume a single "is this day a holiday" `Set<string>` input; only the
 * SOURCE of that Set changed (a single tenant-wide federal state -> the Unterbau's central
 * work-location resolver, `holidaysAtWorkLocation`). This test proves the invariant survives that
 * swap: a leave day that is ALSO a statutory holiday at the employee's work location on that day
 * reduces the June Soll exactly once — not twice (double deduction), not zero (holiday ignored).
 *
 * Fronleichnam 2026 = Thursday 2026-06-04 (BAYERN, not NIEDERSACHSEN). June 2026 has 22 Mo-Fr
 * workdays -> FIXED 40h Mo-Fr (8h/day) June Soll with no leave/holiday at all = 10560 minutes.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";

describe("A day reduces Soll exactly once (Phase 71b Plan 04, issue #71, D-08/AC-12)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let vacationTypeId: string;
  let salonAId: string; // BAYERN
  let salonBId: string; // NIEDERSACHSEN, created FIRST — the tenant's default salon
  let inv1Id: string; // HOME B + DEPLOYMENT A Thursdays, one 5-day leave request spanning Fronleichnam
  let inv2Id: string; // HOME B + DEPLOYMENT A Thursdays, two leave requests deliberately excluding Fronleichnam
  let inv3Id: string; // HOME B only, one 5-day leave request spanning the same week

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-10T10:00:00.000Z"));

    app = await getTestApp();
    const seed = await seedTestData(app, "hloi", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;
    vacationTypeId = seed.vacationType.id;

    const salonB = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonBId = salonB.id;
    const salonA = await createTestSalon(app.prisma, tenantId, { federalState: "BAYERN" });
    salonAId = salonA.id;

    const passwordHash = await bcrypt.hash("test1234", 10);

    async function createFixedEmployee(label: string) {
      const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const user = await app.prisma.user.create({
        data: {
          email: `hloi-${label}-${suffix}@test.de`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `HLOI-${label}-${suffix}`,
          firstName: label,
          lastName: "LeaveOnceInvariant",
          hireDate: new Date("2026-06-01"),
        },
      });
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "FIXED_SCHEDULE",
          weeklyHours: 40,
          mondayHours: 8,
          tuesdayHours: 8,
          wednesdayHours: 8,
          thursdayHours: 8,
          fridayHours: 8,
          saturdayHours: 0,
          sundayHours: 0,
          validFrom: new Date("2026-06-01"),
        },
      });
      await app.prisma.overtimeAccount.create({
        data: { employeeId: employee.id, balanceHours: 0 },
      });
      return employee;
    }

    async function assignHome(employeeId: string, salonId: string) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId,
          employeeId,
          salonId,
          kind: "HOME",
          validFrom: new Date("2026-06-01"),
          validUntil: null,
          weekdays: [],
        },
      });
    }
    async function assignDeployment(employeeId: string, salonId: string, weekdays: number[]) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId,
          employeeId,
          salonId,
          kind: "DEPLOYMENT",
          validFrom: new Date("2026-06-01"),
          validUntil: null,
          weekdays,
        },
      });
    }
    async function createApprovedLeave(employeeId: string, startDate: string, endDate: string) {
      await app.prisma.leaveRequest.create({
        data: {
          employeeId,
          leaveTypeId: vacationTypeId,
          startDate: new Date(`${startDate}T00:00:00Z`),
          endDate: new Date(`${endDate}T00:00:00Z`),
          days: 5,
          halfDay: false,
          status: "APPROVED",
        },
      });
    }

    // inv1: deployed to BAYERN on Thursdays, ONE leave request 06-01..06-05 (spans Fronleichnam).
    const inv1 = await createFixedEmployee("inv1");
    inv1Id = inv1.id;
    await assignHome(inv1Id, salonBId);
    await assignDeployment(inv1Id, salonAId, [3]); // Thursday (0 = Monday)
    await createApprovedLeave(inv1Id, "2026-06-01", "2026-06-05");

    // inv2: same assignments, but the leave requests deliberately EXCLUDE Fronleichnam itself —
    // the holiday must still be recognized (via the DEPLOYMENT) and reduce the Soll on its own.
    const inv2 = await createFixedEmployee("inv2");
    inv2Id = inv2.id;
    await assignHome(inv2Id, salonBId);
    await assignDeployment(inv2Id, salonAId, [3]);
    await createApprovedLeave(inv2Id, "2026-06-01", "2026-06-03");
    await createApprovedLeave(inv2Id, "2026-06-05", "2026-06-05");

    // inv3: HOME B (NIEDERSACHSEN) only — Thursday is a plain leave day there, never a holiday.
    const inv3 = await createFixedEmployee("inv3");
    inv3Id = inv3.id;
    await assignHome(inv3Id, salonBId);
    await createApprovedLeave(inv3Id, "2026-06-01", "2026-06-05");
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("holiday-leave-once-invariant cleanup failed:", err);
    }
  });

  async function monthSaldo(employeeId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${employeeId}?year=2026&month=6`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as { expectedMinutes: number };
  }

  it("inv1: a leave request spanning a work-location holiday reduces Soll by holiday + leave days, not holiday + full leave range (8160, not 7680)", async () => {
    const result = await monthSaldo(inv1Id);
    expect(result.expectedMinutes).toBe(8160);
  });

  it("inv2: leave requests deliberately excluding the holiday day still combine with the DEPLOYMENT-derived holiday to the same total (8160, not 8640 if the holiday were ignored)", async () => {
    const result = await monthSaldo(inv2Id);
    expect(result.expectedMinutes).toBe(8160);
  });

  it("inv3: with no work-location holiday at all, the same week's full 5-day leave reaches the same total via a different composition (8160)", async () => {
    const result = await monthSaldo(inv3Id);
    expect(result.expectedMinutes).toBe(8160);
  });
});
