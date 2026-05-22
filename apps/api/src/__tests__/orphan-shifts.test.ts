/**
 * Phase 49.3 — Orphan-Shift-Lifecycle integration tests.
 *
 * Covers the behavior of PUT /api/v1/settings/work/:employeeId when the
 * schedule type changes FROM SHIFT_BASED to another type and future shifts exist.
 *
 * Reference: apps/api/src/__tests__/shifts.test.ts (Phase 47.2 past-immutability pattern)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

// Build an ISO date string N days from today (positive = future, negative = past)
function isoDateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("Orphan-Shift-Lifecycle (PUT /api/v1/settings/work/:employeeId)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // A shared SHIFT_BASED employee used across tests.
  // Each test that changes the schedule type must reset it back to SHIFT_BASED.
  let shiftEmployee: { id: string };

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "osh");

    // Create a dedicated employee for orphan-shift tests
    const bcryptMod = await import("bcryptjs");
    const passwordHash = await bcryptMod.default.hash("test1234", 10);
    const user = await app.prisma.user.create({
      data: {
        email: `osh-emp-${Date.now()}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    shiftEmployee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `OSH-${Date.now()}`,
        firstName: "Orphan",
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: shiftEmployee.id, balanceHours: 0 },
    });

    // Assign SHIFT_BASED schedule (validFrom = past so it's "effective now")
    await app.prisma.workSchedule.create({
      data: {
        employeeId: shiftEmployee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        validFrom: new Date("2024-01-01"),
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Orphan-shift test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Helper: reset employee back to SHIFT_BASED ────────────────────────────
  async function resetToShiftBased() {
    await app.prisma.workSchedule.deleteMany({ where: { employeeId: shiftEmployee.id } });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: shiftEmployee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        validFrom: new Date("2024-01-01"),
      },
    });
  }

  // ── Helper: create N future shifts ───────────────────────────────────────
  async function createFutureShifts(count: number) {
    const shifts = [];
    for (let i = 1; i <= count; i++) {
      shifts.push({
        employeeId: shiftEmployee.id,
        date: new Date(isoDateOffset(i) + "T00:00:00Z"),
        startTime: "08:00",
        endTime: "16:00",
        createdBy: data.adminEmployee.id,
      });
    }
    await app.prisma.shift.createMany({ data: shifts });
  }

  // ── Test 1: SHIFT_BASED → FLEXTIME with 0 future shifts → 200 ────────────
  it("SHIFT_BASED → FLEXTIME with 0 future shifts → 200, schedule updated", async () => {
    await resetToShiftBased();
    // No future shifts created

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${shiftEmployee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FLEXTIME",
        weeklyHours: 40,
        validFrom: isoDateOffset(0),
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.type).toBe("FLEXTIME");

    // Restore SHIFT_BASED for subsequent tests
    await resetToShiftBased();
  });

  // ── Test 2: SHIFT_BASED → FLEXTIME with 3 future shifts, no flag → 409 ──
  it("SHIFT_BASED → FLEXTIME with 3 future shifts + no flag → 409 ORPHAN_SHIFTS_PENDING", async () => {
    await resetToShiftBased();
    await createFutureShifts(3);

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${shiftEmployee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FLEXTIME",
        weeklyHours: 40,
        validFrom: isoDateOffset(0),
      },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("ORPHAN_SHIFTS_PENDING");
    expect(body.pendingShifts).toBe(3);
    // shiftPreview: first 3 with date/startTime/endTime
    expect(Array.isArray(body.shiftPreview)).toBe(true);
    expect(body.shiftPreview).toHaveLength(3);
    expect(body.shiftPreview[0]).toMatchObject({
      date: expect.any(String),
      startTime: "08:00",
      endTime: "16:00",
    });
    // Schedule must NOT have changed
    const schedule = await app.prisma.workSchedule.findFirst({
      where: { employeeId: shiftEmployee.id },
      orderBy: { validFrom: "desc" },
    });
    expect(schedule?.type).toBe("SHIFT_BASED");

    // Cleanup future shifts for next tests
    await app.prisma.shift.deleteMany({
      where: { employeeId: shiftEmployee.id, date: { gte: new Date(isoDateOffset(0) + "T00:00:00Z") } },
    });
  });

  // ── Test 3: cancelOrphanShifts=true → 200 + 3 shifts deleted + audit ─────
  it("SHIFT_BASED → FLEXTIME with cancelOrphanShifts=true → 200 + 3 shifts deleted + 3 audit entries", async () => {
    await resetToShiftBased();
    await createFutureShifts(3);

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${shiftEmployee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FLEXTIME",
        weeklyHours: 40,
        validFrom: isoDateOffset(0),
        cancelOrphanShifts: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.type).toBe("FLEXTIME");

    // Future shifts must be deleted
    const remainingFuture = await app.prisma.shift.findMany({
      where: {
        employeeId: shiftEmployee.id,
        date: { gte: new Date(isoDateOffset(0) + "T00:00:00Z") },
      },
    });
    expect(remainingFuture).toHaveLength(0);

    // 3 AuditLog entries with entity "Shift" and action "DELETE"
    const auditEntries = await app.prisma.auditLog.findMany({
      where: { entity: "Shift", action: "DELETE" },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    // At least 3 audit entries for Shift DELETE
    const shiftDeleteAudits = auditEntries.filter((a) => {
      const old = a.oldValue as { note?: string } | null;
      return old?.note === "SHIFT_CANCELLED_SCHEDULE_TYPE_CHANGE";
    });
    expect(shiftDeleteAudits.length).toBeGreaterThanOrEqual(3);

    await resetToShiftBased();
  });

  // ── Test 4: keepOrphanShifts=true → 200 + 3 shifts preserved ─────────────
  it("SHIFT_BASED → FLEXTIME with keepOrphanShifts=true → 200 + 3 shifts preserved", async () => {
    await resetToShiftBased();
    await createFutureShifts(3);

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${shiftEmployee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FLEXTIME",
        weeklyHours: 40,
        validFrom: isoDateOffset(0),
        keepOrphanShifts: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.type).toBe("FLEXTIME");

    // Future shifts must be preserved
    const remaining = await app.prisma.shift.findMany({
      where: {
        employeeId: shiftEmployee.id,
        date: { gte: new Date(isoDateOffset(0) + "T00:00:00Z") },
      },
    });
    expect(remaining).toHaveLength(3);

    // Cleanup
    await app.prisma.shift.deleteMany({
      where: { employeeId: shiftEmployee.id },
    });
    await resetToShiftBased();
  });

  // ── Test 5: FLEXTIME → FIXED_SCHEDULE (not from SHIFT_BASED) → 200 ───────
  it("FLEXTIME → FIXED_SCHEDULE (prior type not SHIFT_BASED) → 200, no orphan prompt", async () => {
    // Set employee to FLEXTIME first
    await app.prisma.workSchedule.deleteMany({ where: { employeeId: shiftEmployee.id } });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: shiftEmployee.id,
        type: "FLEXTIME",
        weeklyHours: 40,
        validFrom: new Date("2024-01-01"),
      },
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${shiftEmployee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        validFrom: isoDateOffset(0),
      },
    });

    // Should succeed without any 409 — prior type was FLEXTIME, not SHIFT_BASED
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).type).toBe("FIXED_SCHEDULE");

    await resetToShiftBased();
  });

  // ── Test 6: SHIFT_BASED → FLEXTIME with PAST shifts only → 200 ───────────
  it("SHIFT_BASED → FLEXTIME with only PAST shifts → 200, no orphan prompt (past immutable)", async () => {
    await resetToShiftBased();

    // Create shifts in the PAST (date < today) — these are immutable
    const pastDate1 = isoDateOffset(-10);
    const pastDate2 = isoDateOffset(-5);
    await app.prisma.shift.createMany({
      data: [
        {
          employeeId: shiftEmployee.id,
          date: new Date(pastDate1 + "T00:00:00Z"),
          startTime: "08:00",
          endTime: "16:00",
        },
        {
          employeeId: shiftEmployee.id,
          date: new Date(pastDate2 + "T00:00:00Z"),
          startTime: "08:00",
          endTime: "16:00",
        },
      ],
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${shiftEmployee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FLEXTIME",
        weeklyHours: 40,
        validFrom: isoDateOffset(0),
      },
    });

    // Only past shifts — no future orphans → should proceed without 409
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).type).toBe("FLEXTIME");

    // Past shifts are untouched
    const pastShifts = await app.prisma.shift.findMany({
      where: {
        employeeId: shiftEmployee.id,
        date: { lt: new Date(isoDateOffset(0) + "T00:00:00Z") },
      },
    });
    expect(pastShifts).toHaveLength(2);

    // Cleanup past shifts + reset
    await app.prisma.shift.deleteMany({ where: { employeeId: shiftEmployee.id } });
    await resetToShiftBased();
  });

  // ── Test 7: Both flags true → 400 Zod validation error ───────────────────
  it("keepOrphanShifts=true AND cancelOrphanShifts=true → 400 (mutually exclusive)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${shiftEmployee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FLEXTIME",
        weeklyHours: 40,
        validFrom: isoDateOffset(0),
        keepOrphanShifts: true,
        cancelOrphanShifts: true,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Validierungsfehler");
  });
});
