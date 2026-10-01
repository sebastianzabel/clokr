/**
 * Phase 430 Plan 01 — the missing direction of Type-1 conflict detection ("Schicht auf genehmigtem
 * Urlaubstag"): a shift CREATED/UPDATED on a day that already has an APPROVED LeaveRequest.
 * `flagShiftsConflictingWithLeave` (S2, tested in facade-shifts.test.ts) only fires the OTHER way
 * (leave approved -> flag pre-existing shifts). `flagShiftIfConflictsWithApprovedLeave` (S4) is its
 * inverse, and `notifyShiftLeaveConflicts` is the audit+notify helper extracted out of
 * `absence/api/leave.ts` so both directions share one implementation (D-02/D-03).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { flagShiftIfConflictsWithApprovedLeave } from "../shift-leave-check"; // Phase 430-06 — moved out of the index barrel, see that module's docblock
import { notifyShiftLeaveConflicts } from "../index";
import type { FastifyInstance } from "fastify";

describe("Schichtplanung — flagShiftIfConflictsWithApprovedLeave / notifyShiftLeaveConflicts (Phase 430)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Fixed future dates, far enough out and distinct from facade-shifts.test.ts's own fixture
  // window (Nov/Dec 2026) so the two files never collide in the shared test database.
  const NO_LEAVE_DATE = "2027-02-01";
  const LEAVE_DATE = "2027-02-08";
  const PENDING_LEAVE_DATE = "2027-02-15";
  // Issue #446 D-02 — not 2027-02-22 (already used by the foreign-tenant case below, whose
  // leave row is never cleaned up because that test only tears down otherTenantData).
  const CANCELLATION_REQUESTED_LEAVE_DATE = "2027-02-28";

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sched-flag-s4");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("flagShiftIfConflictsWithApprovedLeave (S4)", () => {
    it("no approved leave on that day -> returns null, conflictsWithLeave stays false", async () => {
      const shift = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          salonId: data.salonId,
          date: new Date(NO_LEAVE_DATE + "T00:00:00Z"),
          startTime: "08:00",
          endTime: "12:00",
        },
      });

      const result = await flagShiftIfConflictsWithApprovedLeave(
        app.prisma,
        shift.id,
        data.employee.id,
        data.tenant.id,
        new Date(NO_LEAVE_DATE + "T00:00:00Z"),
      );

      expect(result).toBeNull();
      const reloaded = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
      expect(reloaded.conflictsWithLeave).toBe(false);
    });

    it("a PENDING (not APPROVED) leave on that day -> does NOT flag", async () => {
      const shift = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          salonId: data.salonId,
          date: new Date(PENDING_LEAVE_DATE + "T00:00:00Z"),
          startTime: "08:00",
          endTime: "12:00",
        },
      });
      const pending = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date(PENDING_LEAVE_DATE + "T00:00:00Z"),
          endDate: new Date(PENDING_LEAVE_DATE + "T00:00:00Z"),
          days: 1,
          status: "PENDING",
        },
      });

      const result = await flagShiftIfConflictsWithApprovedLeave(
        app.prisma,
        shift.id,
        data.employee.id,
        data.tenant.id,
        new Date(PENDING_LEAVE_DATE + "T00:00:00Z"),
      );

      expect(result).toBeNull();
      const reloaded = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
      expect(reloaded.conflictsWithLeave).toBe(false);

      await app.prisma.leaveRequest.delete({ where: { id: pending.id } });
    });

    it("an APPROVED leave on that day -> flags the shift and returns the conflict details; a second call is a no-op (idempotent)", async () => {
      const shift = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          salonId: data.salonId,
          date: new Date(LEAVE_DATE + "T00:00:00Z"),
          startTime: "08:00",
          endTime: "16:00",
          label: "Frühschicht",
        },
      });
      const approved = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date(LEAVE_DATE + "T00:00:00Z"),
          endDate: new Date(LEAVE_DATE + "T00:00:00Z"),
          days: 1,
          status: "APPROVED",
        },
      });

      const result = await flagShiftIfConflictsWithApprovedLeave(
        app.prisma,
        shift.id,
        data.employee.id,
        data.tenant.id,
        new Date(LEAVE_DATE + "T00:00:00Z"),
      );

      expect(result).not.toBeNull();
      expect(result?.shiftId).toBe(shift.id);
      expect(result?.leaveRequestId).toBe(approved.id);
      expect(result?.salonId).toBe(data.salonId);
      expect(result?.label).toBe("Frühschicht");

      const reloaded = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
      expect(reloaded.conflictsWithLeave).toBe(true);

      // Idempotent: the shift is already flagged — a second call must return null and never
      // re-flag (same state-transition idiom as flagShiftsConflictingWithLeave/S2).
      const again = await flagShiftIfConflictsWithApprovedLeave(
        app.prisma,
        shift.id,
        data.employee.id,
        data.tenant.id,
        new Date(LEAVE_DATE + "T00:00:00Z"),
      );
      expect(again).toBeNull();

      await app.prisma.leaveRequest.delete({ where: { id: approved.id } });
    });

    it("a CANCELLATION_REQUESTED leave on that day -> still flags the shift (Issue #446 D-02: a leave under requested cancellation is still active, CLAUDE.md § Leave Cancellation Flow)", async () => {
      const shift = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          salonId: data.salonId,
          date: new Date(CANCELLATION_REQUESTED_LEAVE_DATE + "T00:00:00Z"),
          startTime: "08:00",
          endTime: "16:00",
        },
      });
      const cancellationRequested = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date(CANCELLATION_REQUESTED_LEAVE_DATE + "T00:00:00Z"),
          endDate: new Date(CANCELLATION_REQUESTED_LEAVE_DATE + "T00:00:00Z"),
          days: 1,
          status: "CANCELLATION_REQUESTED",
        },
      });

      const result = await flagShiftIfConflictsWithApprovedLeave(
        app.prisma,
        shift.id,
        data.employee.id,
        data.tenant.id,
        new Date(CANCELLATION_REQUESTED_LEAVE_DATE + "T00:00:00Z"),
      );

      expect(result).not.toBeNull();
      expect(result?.leaveRequestId).toBe(cancellationRequested.id);

      const reloaded = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
      expect(reloaded.conflictsWithLeave).toBe(true);

      await app.prisma.leaveRequest.delete({ where: { id: cancellationRequested.id } });
    });

    it("a foreign tenant's employeeId/tenantId combination never flags the shift", async () => {
      const otherTenantData = await seedTestData(app, "sched-flag-s4-other");
      try {
        const shift = await app.prisma.shift.create({
          data: {
            employeeId: data.employee.id,
            salonId: data.salonId,
            date: new Date("2027-02-22T00:00:00Z"),
            startTime: "08:00",
            endTime: "12:00",
          },
        });
        await app.prisma.leaveRequest.create({
          data: {
            employeeId: data.employee.id,
            leaveTypeId: data.vacationType.id,
            startDate: new Date("2027-02-22T00:00:00Z"),
            endDate: new Date("2027-02-22T00:00:00Z"),
            days: 1,
            status: "APPROVED",
          },
        });

        // WRONG tenant on purpose — must never leak across tenants.
        const result = await flagShiftIfConflictsWithApprovedLeave(
          app.prisma,
          shift.id,
          data.employee.id,
          otherTenantData.tenant.id,
          new Date("2027-02-22T00:00:00Z"),
        );
        expect(result).toBeNull();
        const reloaded = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
        expect(reloaded.conflictsWithLeave).toBe(false);
      } finally {
        await cleanupTestData(app, otherTenantData.tenant.id);
      }
    });
  });

  describe("notifyShiftLeaveConflicts", () => {
    it("writes one SHIFT_MARKED_CONFLICTING audit row per shift and one SHIFT_LEAVE_CONFLICT notification per scoped shift:plan holder", async () => {
      // A MANAGER with no stored RoleAssignment falls back to the system role of User.role
      // (D-08), which grants shift:plan:ZUGEWIESEN at wholeTenant reach — same pattern
      // apps/api/src/__tests__/shifts.test.ts's own reverse-hook test already relies on.
      const bcryptMod = await import("bcryptjs");
      const mgrPasswordHash = await bcryptMod.default.hash("test1234", 10);
      const mgrUser = await app.prisma.user.create({
        data: {
          email: `mgr-s4-${Date.now()}@test.de`,
          passwordHash: mgrPasswordHash,
          role: "MANAGER",
          isActive: true,
        },
      });
      const mgrEmployee = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: mgrUser.id,
          employeeNumber: `S4M-${Date.now()}`,
          firstName: "Mary",
          lastName: "Manager",
          hireDate: new Date("2024-01-01"),
        },
      });

      const shift1 = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          salonId: data.salonId,
          date: new Date("2027-03-01T00:00:00Z"),
          startTime: "08:00",
          endTime: "12:00",
          label: "A",
        },
      });
      const shift2 = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          salonId: data.salonId,
          date: new Date("2027-03-02T00:00:00Z"),
          startTime: "08:00",
          endTime: "12:00",
          label: "B",
        },
      });
      const approved = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date("2027-03-01T00:00:00Z"),
          endDate: new Date("2027-03-02T00:00:00Z"),
          days: 2,
          status: "APPROVED",
        },
      });

      await notifyShiftLeaveConflicts(app, {
        employeeId: data.employee.id,
        tenantId: data.tenant.id,
        employeeName: { firstName: data.employee.firstName, lastName: data.employee.lastName },
        leaveRequestId: approved.id,
        leaveStart: approved.startDate,
        leaveEnd: approved.endDate,
        conflictingShifts: [
          { id: shift1.id, date: shift1.date, label: shift1.label, salonId: shift1.salonId },
          { id: shift2.id, date: shift2.date, label: shift2.label, salonId: shift2.salonId },
        ],
      });

      const audits = await app.prisma.auditLog.findMany({
        where: {
          entity: "Shift",
          action: "SHIFT_MARKED_CONFLICTING",
          entityId: { in: [shift1.id, shift2.id] },
        },
      });
      expect(audits).toHaveLength(2);
      expect((audits[0].newValue as { leaveRequestId?: string })?.leaveRequestId).toBe(approved.id);

      const notifs = await app.prisma.notification.findMany({
        where: {
          type: "SHIFT_LEAVE_CONFLICT",
          relatedType: "LeaveRequest",
          relatedId: approved.id,
        },
      });
      expect(notifs.length).toBeGreaterThan(0);
      expect(notifs.some((n) => n.userId === mgrUser.id)).toBe(true);
      expect(notifs[0].title).toContain(data.employee.firstName);

      await app.prisma.notification.deleteMany({ where: { relatedId: approved.id } });
      await app.prisma.auditLog.deleteMany({ where: { entityId: { in: [shift1.id, shift2.id] } } });
      await app.prisma.shift.deleteMany({ where: { id: { in: [shift1.id, shift2.id] } } });
      await app.prisma.leaveRequest.delete({ where: { id: approved.id } });
      await app.prisma.employee.delete({ where: { id: mgrEmployee.id } });
      await app.prisma.user.delete({ where: { id: mgrUser.id } });
    });

    it("a no-op call (empty conflictingShifts) writes nothing", async () => {
      const approved = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date("2027-03-10T00:00:00Z"),
          endDate: new Date("2027-03-10T00:00:00Z"),
          days: 1,
          status: "APPROVED",
        },
      });

      await notifyShiftLeaveConflicts(app, {
        employeeId: data.employee.id,
        tenantId: data.tenant.id,
        employeeName: { firstName: data.employee.firstName, lastName: data.employee.lastName },
        leaveRequestId: approved.id,
        leaveStart: approved.startDate,
        leaveEnd: approved.endDate,
        conflictingShifts: [],
      });

      const notifs = await app.prisma.notification.findMany({
        where: {
          type: "SHIFT_LEAVE_CONFLICT",
          relatedType: "LeaveRequest",
          relatedId: approved.id,
        },
      });
      expect(notifs).toHaveLength(0);

      await app.prisma.leaveRequest.delete({ where: { id: approved.id } });
    });
  });
});
