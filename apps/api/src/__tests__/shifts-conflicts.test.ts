// Phase 67.2 Plan 05 — /shifts/conflicts + /shifts/:id/restore tests
//
// Verifies the manager-facing conflict-overview surface:
//   - GET /shifts/conflicts returns soft-deleted (deletedReason=AUTO_BS_DAY_CLEANUP)
//     + currently-flagged (conflictsWithLeave=true) shifts in two buckets
//   - Cross-tenant isolation (a different tenant's shifts do NOT leak)
//   - POST /shifts/:id/restore on a soft-deleted shift clears deletedAt + deletedReason
//     and writes a SHIFT_RESTORED AuditLog entry
//   - Restore on a shift whose month is locked (SaldoSnapshot) returns 422

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon, // Phase 325 (issue #325)
} from "./setup";
import { saldoSnapshotPeriodBounds } from "./test-dates";
import type { FastifyInstance } from "fastify";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function futureDate(daysAhead = 7): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d;
}
function pastDate(daysAgo = 7): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

describe("Shift Conflicts API (Phase 67.2 Plan 05)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "shcf");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    await app.prisma.auditLog.deleteMany({ where: { entity: "Shift" } });
    await app.prisma.shift.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: data.employee.id } });
  });

  it("GET /shifts/conflicts returns soft-deleted shifts in `softDeleted` bucket", async () => {
    const future = futureDate(10);
    const soft = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        salonId: data.salonId, // Phase 325 (issue #325)
        date: future,
        startTime: "08:00",
        endTime: "16:00",
        deletedAt: new Date(),
        deletedReason: "AUTO_BS_DAY_CLEANUP",
      },
    });

    const from = isoDate(futureDate(0));
    const to = isoDate(futureDate(60));
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/conflicts?from=${from}&to=${to}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.softDeleted)).toBe(true);
    expect(Array.isArray(body.flagged)).toBe(true);
    expect(body.softDeleted.map((s: { id: string }) => s.id)).toContain(soft.id);
    expect(body.flagged.map((s: { id: string }) => s.id)).not.toContain(soft.id);
    // Employee join surfaced for display
    const found = body.softDeleted.find((s: { id: string }) => s.id === soft.id);
    expect(found.employee).toBeTruthy();
    expect(found.employee.firstName).toBeTruthy();
    expect(found.employee.lastName).toBeTruthy();
    // Phase 430 (D-10) regression guard — this fixture's employee is FIXED_SCHEDULE, never
    // SHIFT_BASED, so the new live-computed bucket stays empty and the existing two are unchanged.
    expect(body.weekOverbooked).toEqual([]);
  });

  it("GET /shifts/conflicts returns active+flagged shifts in `flagged` bucket", async () => {
    const pastFlagged = pastDate(3);
    const shift = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        salonId: data.salonId, // Phase 325 (issue #325)
        date: pastFlagged,
        startTime: "08:00",
        endTime: "16:00",
        conflictsWithLeave: true,
      },
    });

    const from = isoDate(pastDate(30));
    const to = isoDate(futureDate(30));
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/conflicts?from=${from}&to=${to}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.flagged.map((s: { id: string }) => s.id)).toContain(shift.id);
    expect(body.softDeleted.map((s: { id: string }) => s.id)).not.toContain(shift.id);
    expect(body.weekOverbooked).toEqual([]);
  });

  it("GET /shifts/conflicts weekOverbooked bucket reports a SHIFT_BASED employee overbooked that week (Phase 430 D-10)", async () => {
    // 1-day contract, 2 distinct shift-days inside the [from, to] window -> overbookedBy = 1.
    const schedule = await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 8,
        contractWorkDaysPerWeek: 1,
        validFrom: new Date("2025-01-01"),
      },
    });
    // Monday + Tuesday of a fixed, far-future week — distinct from every other fixture window in
    // this file (futureDate()-based), to never collide across the shared test DB.
    const weekMonday = new Date(Date.UTC(2030, 2, 4)); // 2030-03-04, a Monday
    const weekTuesday = new Date(Date.UTC(2030, 2, 5));
    const shiftIds: string[] = [];
    for (const d of [weekMonday, weekTuesday]) {
      const shift = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          salonId: data.salonId,
          date: d,
          startTime: "08:00",
          endTime: "12:00",
        },
      });
      shiftIds.push(shift.id);
    }

    try {
      const from = isoDate(weekMonday);
      const to = isoDate(new Date(Date.UTC(2030, 2, 10))); // that week's Sunday
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/conflicts?from=${from}&to=${to}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.weekOverbooked).toHaveLength(1);
      const entry = body.weekOverbooked[0];
      expect(entry.employeeId).toBe(data.employee.id);
      expect(entry.weekStart).toBe("2030-03-04");
      expect(entry.weekEnd).toBe("2030-03-10");
      expect(entry.contractDays).toBe(1);
      expect(entry.leaveDays).toBe(0);
      expect(entry.otherAbsenceDays).toBe(0);
      expect(entry.scheduledDays).toBe(2);
      expect(entry.overbookedBy).toBe(1);
    } finally {
      await app.prisma.shift.deleteMany({ where: { id: { in: shiftIds } } });
      await app.prisma.workSchedule.delete({ where: { id: schedule.id } });
    }
  });

  it("Cross-tenant isolation: other-tenant soft-deleted shift NOT returned", async () => {
    // Build a second tenant with a soft-deleted BS shift; the first tenant's admin
    // token MUST NOT see it.
    const otherTenant = await app.prisma.tenant.create({
      data: { name: "Other Co", slug: `other-${Date.now()}`, federalState: "BAYERN" },
    });
    const otherSalon = await createTestSalon(app.prisma, otherTenant.id); // Phase 325 (issue #325)
    await app.prisma.tenantConfig.create({
      data: { tenantId: otherTenant.id, defaultVacationDays: 30, timezone: "Europe/Berlin" },
    });
    const otherUser = await app.prisma.user.create({
      data: {
        email: `other-${Date.now()}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const otherEmp = await app.prisma.employee.create({
      data: {
        tenantId: otherTenant.id,
        userId: otherUser.id,
        employeeNumber: `O-${Date.now()}`,
        firstName: "Other",
        lastName: "Person",
        hireDate: new Date("2024-01-01"),
      },
    });
    const otherShift = await app.prisma.shift.create({
      data: {
        employeeId: otherEmp.id,
        salonId: otherSalon.id, // Phase 325 (issue #325) — the OTHER tenant's own salon
        date: futureDate(10),
        startTime: "08:00",
        endTime: "16:00",
        deletedAt: new Date(),
        deletedReason: "AUTO_BS_DAY_CLEANUP",
      },
    });

    const from = isoDate(futureDate(0));
    const to = isoDate(futureDate(60));
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/conflicts?from=${from}&to=${to}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.softDeleted.map((s: { id: string }) => s.id)).not.toContain(otherShift.id);

    // Clean up other tenant
    try {
      await app.prisma.shift.delete({ where: { id: otherShift.id } });
      await app.prisma.employee.delete({ where: { id: otherEmp.id } });
      await app.prisma.user.delete({ where: { id: otherUser.id } });
      await app.prisma.tenantConfig.delete({ where: { tenantId: otherTenant.id } });
      // Phase 325 (issue #325): Shift -> Salon is onDelete: Restrict — remove before the tenant.
      await app.prisma.salon.delete({ where: { id: otherSalon.id } });
      await app.prisma.tenant.delete({ where: { id: otherTenant.id } });
    } catch (err) {
      console.error("Other-tenant cleanup failed:", err);
    }
  });

  it("POST /shifts/:id/restore on soft-deleted shift clears deletedAt + writes SHIFT_RESTORED audit", async () => {
    const future = futureDate(14);
    const shift = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        salonId: data.salonId, // Phase 325 (issue #325)
        date: future,
        startTime: "08:00",
        endTime: "16:00",
        deletedAt: new Date(),
        deletedReason: "AUTO_BS_DAY_CLEANUP",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/shifts/${shift.id}/restore`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const after = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.deletedReason).toBeNull();

    const audit = await app.prisma.auditLog.findMany({
      where: { entity: "Shift", entityId: shift.id, action: "SHIFT_RESTORED" },
    });
    expect(audit.length).toBe(1);
    expect(audit[0].oldValue).toBeTruthy();
    expect(audit[0].newValue).toBeTruthy();
  });

  it("POST /shifts/:id/restore on locked-month shift returns 422", async () => {
    // Place the shift in a month with an existing SaldoSnapshot (locked).
    // Issue #241: periodStart/periodEnd MUST be built via saldoSnapshotPeriodBounds
    // (real monthRangeUtc() conversion) — a naive Date.UTC(year, month, 1) fixture
    // agrees with the (now-fixed) naive comparison in the route instead of catching it.
    const lockedDate = new Date(Date.UTC(2024, 5, 15)); // June 2024
    const { start, end } = saldoSnapshotPeriodBounds(lockedDate);
    const shift = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        salonId: data.salonId, // Phase 325 (issue #325)
        date: lockedDate,
        startTime: "08:00",
        endTime: "16:00",
        deletedAt: new Date(),
        deletedReason: "AUTO_BS_DAY_CLEANUP",
      },
    });
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: start,
        periodEnd: end,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/shifts/${shift.id}/restore`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(422);
    // Shift must NOT have been modified
    const after = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(after.deletedReason).toBe("AUTO_BS_DAY_CLEANUP");
  });
});
