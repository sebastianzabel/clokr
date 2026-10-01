/**
 * Phase 430 (D-05..D-07) — Type-2 conflict: a SHIFT_BASED person scheduled on more distinct days
 * in an ISO week than her contract allows once approved leave and other absences that week are
 * subtracted. `detectWeekCapacityConflict` is pure detection (no mutation, no persisted state —
 * D-06); `notifyWeekCapacityConflictOnce` is the idempotent notification layer, deduped purely via
 * a query against the existing `Notification` model (no new table).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { detectWeekCapacityConflict, notifyWeekCapacityConflictOnce } from "../shift-week-capacity"; // Phase 430-06 — moved out of the index barrel, see contexts/scheduling/index.ts's docblock
import type { FastifyInstance } from "fastify";

function utcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

describe("Schichtplanung — detectWeekCapacityConflict / notifyWeekCapacityConflictOnce (Phase 430)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Week: Mon 2029-04-02 .. Sun 2029-04-08. Far enough in the future, distinct from every other
  // fixture window in this file's sibling tests, to never collide across the shared test DB.
  const weekStart = utcDate(2029, 4, 2);
  const weekEnd = utcDate(2029, 4, 8);

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sched-week-capacity");
    await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        contractWorkDaysPerWeek: 5,
        validFrom: new Date("2024-01-01"),
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function createShiftsOn(dates: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const iso of dates) {
      const shift = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          salonId: data.salonId!,
          date: new Date(iso + "T00:00:00Z"),
          startTime: "08:00",
          endTime: "12:00",
        },
      });
      ids.push(shift.id);
    }
    return ids;
  }

  describe("detectWeekCapacityConflict", () => {
    it("5-day contract, 2 approved leave days, 4 shifts scheduled -> conflict, overbookedBy === 1", async () => {
      const leave = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: utcDate(2029, 4, 5), // Thursday
          endDate: utcDate(2029, 4, 6), // Friday
          days: 2,
          status: "APPROVED",
          halfDay: false,
        },
      });
      // Mon, Tue, Wed, Sat — 4 distinct shift-days.
      const shiftIds = await createShiftsOn([
        "2029-04-02",
        "2029-04-03",
        "2029-04-04",
        "2029-04-07",
      ]);
      try {
        const result = await detectWeekCapacityConflict(
          app.prisma,
          data.employee.id,
          data.tenant.id,
          weekStart,
          weekEnd,
        );
        expect(result).toEqual({
          contractDays: 5,
          leaveDays: 2,
          otherAbsenceDays: 0,
          scheduledDays: 4,
          overbookedBy: 1,
        });
      } finally {
        await app.prisma.shift.deleteMany({ where: { id: { in: shiftIds } } });
        await app.prisma.leaveRequest.delete({ where: { id: leave.id } });
      }
    });

    it("5-day contract, 2 approved leave days, 3 shifts scheduled -> no conflict (null)", async () => {
      const leave = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: utcDate(2029, 4, 5),
          endDate: utcDate(2029, 4, 6),
          days: 2,
          status: "APPROVED",
          halfDay: false,
        },
      });
      const shiftIds = await createShiftsOn(["2029-04-02", "2029-04-03", "2029-04-04"]);
      try {
        const result = await detectWeekCapacityConflict(
          app.prisma,
          data.employee.id,
          data.tenant.id,
          weekStart,
          weekEnd,
        );
        expect(result).toBeNull();
      } finally {
        await app.prisma.shift.deleteMany({ where: { id: { in: shiftIds } } });
        await app.prisma.leaveRequest.delete({ where: { id: leave.id } });
      }
    });

    it("an other absence (e.g. Mutterschutz) further reduces allowed days the same way leave does", async () => {
      // No leave this time — one MATERNITY absence Thu+Fri, plus 4 shifts -> same overbookedBy as
      // the leave case above (proves absence and leave reduce the allowed count identically).
      const absence = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "MATERNITY",
          startDate: utcDate(2029, 4, 5),
          endDate: utcDate(2029, 4, 6),
          days: 2,
          createdBy: "test-setup",
        },
      });
      const shiftIds = await createShiftsOn([
        "2029-04-02",
        "2029-04-03",
        "2029-04-04",
        "2029-04-07",
      ]);
      try {
        const result = await detectWeekCapacityConflict(
          app.prisma,
          data.employee.id,
          data.tenant.id,
          weekStart,
          weekEnd,
        );
        expect(result).toEqual({
          contractDays: 5,
          leaveDays: 0,
          otherAbsenceDays: 2,
          scheduledDays: 4,
          overbookedBy: 1,
        });
      } finally {
        await app.prisma.shift.deleteMany({ where: { id: { in: shiftIds } } });
        await app.prisma.absence.delete({ where: { id: absence.id } });
      }
    });
  });

  describe("notifyWeekCapacityConflictOnce", () => {
    it("called twice for the SAME (employeeId, weekStart, recipient) creates only ONE Notification row; after dismissal a new call creates a new one", async () => {
      // A MANAGER with no stored RoleAssignment falls back to the system role of User.role
      // (D-08), which grants shift:plan:ZUGEWIESEN at wholeTenant reach — same pattern
      // shift-leave-conflict-notify.test.ts's own notify test already relies on.
      const bcryptMod = await import("bcryptjs");
      const mgrPasswordHash = await bcryptMod.default.hash("test1234", 10);
      const mgrUser = await app.prisma.user.create({
        data: {
          email: `mgr-week-cap-${Date.now()}@test.de`,
          passwordHash: mgrPasswordHash,
          role: "MANAGER",
          isActive: true,
        },
      });
      const mgrEmployee = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: mgrUser.id,
          employeeNumber: `WCM-${Date.now()}`,
          firstName: "Mona",
          lastName: "Manager",
          hireDate: new Date("2024-01-01"),
        },
      });

      const params = {
        employeeId: data.employee.id,
        tenantId: data.tenant.id,
        employeeName: { firstName: data.employee.firstName, lastName: data.employee.lastName },
        weekStart,
        salonId: data.salonId!,
        conflict: {
          contractDays: 5,
          leaveDays: 2,
          otherAbsenceDays: 0,
          scheduledDays: 4,
          overbookedBy: 1,
        },
      };
      const relatedId = `${data.employee.id}:${weekStart.toISOString().slice(0, 10)}`;

      try {
        // First call: creates the notification.
        await notifyWeekCapacityConflictOnce(app, params);
        const afterFirst = await app.prisma.notification.count({
          where: {
            userId: mgrUser.id,
            type: "SHIFT_WEEK_OVERBOOKED",
            relatedType: "ShiftWeekConflict",
            relatedId,
          },
        });
        expect(afterFirst).toBe(1);

        // Second call, SAME params: idempotent — still exactly one row (the not-yet-dismissed
        // dedup check must find the first row and skip).
        await notifyWeekCapacityConflictOnce(app, params);
        const afterSecond = await app.prisma.notification.count({
          where: {
            userId: mgrUser.id,
            type: "SHIFT_WEEK_OVERBOOKED",
            relatedType: "ShiftWeekConflict",
            relatedId,
          },
        });
        expect(afterSecond).toBe(1);

        // Dismiss the existing notification, then call again — the dedup only suppresses while
        // still ACTIVE (dismissedAt: null); a dismissed conflict re-arms the check.
        await app.prisma.notification.updateMany({
          where: { userId: mgrUser.id, relatedType: "ShiftWeekConflict", relatedId },
          data: { dismissedAt: new Date() },
        });
        await notifyWeekCapacityConflictOnce(app, params);
        const afterDismissAndRecall = await app.prisma.notification.count({
          where: {
            userId: mgrUser.id,
            type: "SHIFT_WEEK_OVERBOOKED",
            relatedType: "ShiftWeekConflict",
            relatedId,
          },
        });
        expect(afterDismissAndRecall).toBe(2);
      } finally {
        await app.prisma.notification.deleteMany({
          where: { relatedType: "ShiftWeekConflict", relatedId },
        });
        await app.prisma.employee.delete({ where: { id: mgrEmployee.id } });
        await app.prisma.user.delete({ where: { id: mgrUser.id } });
      }
    });
  });
});
