// Phase 67.2 Plan 04 — Shift-Auto-Cleanup integration tests
//
// Verifies the cleanup-hook is invoked end-to-end:
//   - Generator (PATTERN trigger): runVocationalSchoolGeneration soft-deletes
//     future shifts on newly-created BS days + dispatches notifications.
//   - Manual-insert (MANUAL trigger, D-23): POST /vocational-school/manual-insert
//     soft-deletes overlapping future shifts.
//   - dryRun: preview does NOT mutate any shift.
//   - Notification recipients: ADMIN + MANAGER users in the tenant.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

function nextDow(targetDow: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const native = d.getUTCDay(); // 0=Sun..6=Sat
  const cur = native === 0 ? 6 : native - 1; // 0=Mo..6=So
  const add = (targetDow - cur + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d;
}
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe("Shift-Auto-Cleanup integration (Phase 67.2 Plan 04)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "scli");
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
    await app.prisma.employeeVocationalSchoolPattern.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.absence.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.shift.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.notification.deleteMany({ where: { type: "SHIFT_BS_CLEANUP" } });
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { vocationalSchoolAutoCleanupShifts: true },
    });
  });

  it("Generator (PATTERN) — soft-deletes future shifts overlapping new BS-days", async () => {
    // Seed a future Tuesday BS pattern.
    const tuesday = nextDow(1);
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1,
        daysOfWeek: [1],
        blockWeeks: [],
        validFrom: new Date("2020-01-01"),
        isActive: true,
      },
    });
    // Pre-seed a future Shift on that Tuesday.
    const shift = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: tuesday,
        startTime: "08:00",
        endTime: "16:00",
        conflictsWithLeave: false,
      },
    });

    const { runVocationalSchoolGeneration } = await import("../utils/vocational-school-generator");
    const result = await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      weeksAhead: 4,
    });
    expect(result.created).toBeGreaterThan(0);

    // The pre-existing future Shift on the Tuesday is now soft-deleted.
    const after = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(after.deletedReason).toBe("AUTO_BS_DAY_CLEANUP");
  });

  it("Generator — sends batched SHIFT_BS_CLEANUP notification to ADMIN + MANAGER users", async () => {
    const tuesday = nextDow(1);
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1,
        daysOfWeek: [1],
        blockWeeks: [],
        validFrom: new Date("2020-01-01"),
        isActive: true,
      },
    });
    await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: tuesday,
        startTime: "08:00",
        endTime: "16:00",
      },
    });

    const { runVocationalSchoolGeneration } = await import("../utils/vocational-school-generator");
    await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      weeksAhead: 4,
    });

    // adminUser is the ADMIN seeded by seedTestData — they should have received a
    // SHIFT_BS_CLEANUP notification.
    const adminNotifs = await app.prisma.notification.findMany({
      where: { userId: data.adminUser.id, type: "SHIFT_BS_CLEANUP" },
    });
    expect(adminNotifs.length).toBeGreaterThan(0);
    expect(adminNotifs[0].title).toBe("Schichten auf Berufsschultagen");
    expect(adminNotifs[0].link).toBe("/shifts/conflicts");

    // The EMPLOYEE user is NOT a manager — they should NOT receive the notification.
    const empNotifs = await app.prisma.notification.findMany({
      where: { userId: data.empUser.id, type: "SHIFT_BS_CLEANUP" },
    });
    expect(empNotifs.length).toBe(0);
  });

  it("Preview (dryRun) — does NOT mutate or notify", async () => {
    const tuesday = nextDow(1);
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1,
        daysOfWeek: [1],
        blockWeeks: [],
        validFrom: new Date("2020-01-01"),
        isActive: true,
      },
    });
    const shift = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: tuesday,
        startTime: "08:00",
        endTime: "16:00",
      },
    });

    const { previewVocationalSchoolGeneration } =
      await import("../utils/vocational-school-generator");
    const result = await previewVocationalSchoolGeneration(app.prisma, {
      tenantId: data.tenant.id,
      weeksAhead: 4,
    });
    expect(result.created).toBeGreaterThan(0);

    // Shift must NOT be soft-deleted.
    const after = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(after.deletedAt).toBeNull();

    // No notifications dispatched.
    const notifs = await app.prisma.notification.findMany({ where: { type: "SHIFT_BS_CLEANUP" } });
    expect(notifs.length).toBe(0);
  });

  it("Generator — tenant opt-out (vocationalSchoolAutoCleanupShifts=false) bypasses cleanup", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { vocationalSchoolAutoCleanupShifts: false },
    });

    const tuesday = nextDow(1);
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1,
        daysOfWeek: [1],
        blockWeeks: [],
        validFrom: new Date("2020-01-01"),
        isActive: true,
      },
    });
    const shift = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: tuesday,
        startTime: "08:00",
        endTime: "16:00",
      },
    });

    const { runVocationalSchoolGeneration } = await import("../utils/vocational-school-generator");
    await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      weeksAhead: 4,
    });

    // Shift is unchanged — opt-out short-circuits everything.
    const after = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(after.deletedAt).toBeNull();
    const notifs = await app.prisma.notification.findMany({ where: { type: "SHIFT_BS_CLEANUP" } });
    expect(notifs.length).toBe(0);
  });

  it("POST /vocational-school/manual-insert (MANUAL) — soft-deletes overlapping future shift", async () => {
    // Manual insert requires AZUBI classification.
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "AZUBI" },
    });
    const tuesday = nextDow(1);
    const shift = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: tuesday,
        startTime: "08:00",
        endTime: "16:00",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: data.employee.id, date: toIsoDate(tuesday) },
    });
    expect(res.statusCode).toBe(201);

    // The pre-existing shift is soft-deleted as a side-effect of the manual insert.
    const after = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(after.deletedReason).toBe("AUTO_BS_DAY_CLEANUP");
  });
});
