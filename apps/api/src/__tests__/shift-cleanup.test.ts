// Phase 67.2 Plan 04 — Shift-Auto-Cleanup Helper Tests
//
// Validates the audit-proof cleanup helper invoked by the BS-Generator
// (utils/vocational-school-generator.ts) + manual-insert route
// (routes/vocational-school.ts D-23).
//
// Audit-Proof Invariants tested (CLAUDE.md / Phase 47.2):
//   T-67.2-11: Past shifts NEVER hard-deleted, NEVER soft-deleted — only flagged.
//   T-67.2-12: Every mutation produces an AuditLog entry (SYSTEM origin).
//   T-67.2-13: Soft-deleted rows respect deletedAt: null contract.
//
// The 8 test scenarios mirror the plan's acceptance criteria one-to-one.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { cleanupShiftsForBSAbsence } from "../utils/shift-cleanup";

function dateOnlyUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function addDaysUtc(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}
function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

// Helpers to seed a shift quickly.
async function seedShift(
  app: FastifyInstance,
  employeeId: string,
  date: Date,
  extra: Partial<{
    deletedAt: Date | null;
    deletedReason: string | null;
    conflictsWithLeave: boolean;
  }> = {},
) {
  return app.prisma.shift.create({
    data: {
      employeeId,
      date,
      startTime: "08:00",
      endTime: "16:00",
      conflictsWithLeave: extra.conflictsWithLeave ?? false,
      deletedAt: extra.deletedAt ?? null,
      deletedReason: extra.deletedReason ?? null,
    },
  });
}

describe("cleanupShiftsForBSAbsence (Phase 67.2 Plan 04)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sclu");
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
    // Reset shifts + audit + snapshot + ensure default cleanup ON.
    await app.prisma.shift.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.auditLog.deleteMany({ where: { entity: "Shift" } });
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { vocationalSchoolAutoCleanupShifts: true },
    });
  });

  // T1: Future shift → soft-delete (deletedAt + reason + audit)
  it("T1 — future shift gets soft-deleted with deletedReason AUTO_BS_DAY_CLEANUP", async () => {
    const now = new Date("2030-06-01T12:00:00Z");
    const future = addDaysUtc(dateOnlyUtc(now), 7);
    const shift = await seedShift(app, data.employee.id, future);

    const result = await cleanupShiftsForBSAbsence(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      dates: [future],
      now,
      triggerSource: "PATTERN",
    });

    expect(result.skipped).toBe(false);
    expect(result.futureSoftDeleted).toBe(1);
    expect(result.pastFlagged).toBe(0);
    expect(result.lockedSkipped).toBe(0);

    const after = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(after.deletedReason).toBe("AUTO_BS_DAY_CLEANUP");

    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "Shift", entityId: shift.id, action: "SHIFT_AUTO_SOFT_DELETED" },
    });
    expect(audits.length).toBe(1);
  });

  // T2: Past shift (yesterday) → flag only (NEVER delete)
  it("T2 — past shift gets conflictsWithLeave=true only, never soft-deleted", async () => {
    const now = new Date("2030-06-01T12:00:00Z");
    const past = addDaysUtc(dateOnlyUtc(now), -1);
    const shift = await seedShift(app, data.employee.id, past);

    const result = await cleanupShiftsForBSAbsence(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      dates: [past],
      now,
      triggerSource: "PATTERN",
    });

    expect(result.futureSoftDeleted).toBe(0);
    expect(result.pastFlagged).toBe(1);

    const after = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(after.deletedAt).toBeNull(); // CRITICAL — past shifts are immutable.
    expect(after.deletedReason).toBeNull();
    expect(after.conflictsWithLeave).toBe(true);

    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "Shift", entityId: shift.id, action: "SHIFT_BS_DAY_CONFLICT_FLAGGED" },
    });
    expect(audits.length).toBe(1);
  });

  // T3: Today's shift → treated as past (flag only)
  it("T3 — today's shift is flagged, NOT deleted (boundary case)", async () => {
    const now = new Date("2030-06-01T12:00:00Z");
    const today = dateOnlyUtc(now);
    const shift = await seedShift(app, data.employee.id, today);

    const result = await cleanupShiftsForBSAbsence(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      dates: [today],
      now,
      triggerSource: "PATTERN",
    });

    expect(result.pastFlagged).toBe(1);
    expect(result.futureSoftDeleted).toBe(0);

    const after = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.conflictsWithLeave).toBe(true);
  });

  // T4: Tenant opt-out → skipped: true, NO mutations.
  it("T4 — vocationalSchoolAutoCleanupShifts=false skips cleanup entirely", async () => {
    const now = new Date("2030-06-01T12:00:00Z");
    const future = addDaysUtc(dateOnlyUtc(now), 7);
    const shift = await seedShift(app, data.employee.id, future);

    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { vocationalSchoolAutoCleanupShifts: false },
    });

    const result = await cleanupShiftsForBSAbsence(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      dates: [future],
      now,
      triggerSource: "PATTERN",
    });

    expect(result.skipped).toBe(true);
    expect(result.futureSoftDeleted).toBe(0);
    expect(result.pastFlagged).toBe(0);

    const after = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(after.deletedAt).toBeNull(); // untouched
    expect(after.conflictsWithLeave).toBe(false);
  });

  // T5: Locked-month shift → lockedSkipped++, NOT touched.
  it("T5 — shift in a locked month is counted as lockedSkipped and NOT mutated", async () => {
    const now = new Date("2030-06-01T12:00:00Z");
    const future = addDaysUtc(dateOnlyUtc(now), 7);
    const shift = await seedShift(app, data.employee.id, future);

    // Seed a SaldoSnapshot locking the month of `future`.
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: monthStartUtc(future),
        periodEnd: monthStartUtc(addDaysUtc(future, 35)),
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });

    const result = await cleanupShiftsForBSAbsence(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      dates: [future],
      now,
      triggerSource: "PATTERN",
    });

    expect(result.lockedSkipped).toBe(1);
    expect(result.futureSoftDeleted).toBe(0);
    expect(result.pastFlagged).toBe(0);

    const after = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.conflictsWithLeave).toBe(false);
  });

  // T6: Already soft-deleted shift → invisible due to deletedAt:null contract.
  it("T6 — already-soft-deleted shift is invisible to cleanup (idempotent)", async () => {
    const now = new Date("2030-06-01T12:00:00Z");
    const future = addDaysUtc(dateOnlyUtc(now), 7);
    const shift = await seedShift(app, data.employee.id, future, {
      deletedAt: new Date("2030-05-01T00:00:00Z"),
      deletedReason: "MANUAL_RESTORE_REVERT",
    });

    const result = await cleanupShiftsForBSAbsence(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      dates: [future],
      now,
      triggerSource: "PATTERN",
    });

    expect(result.futureSoftDeleted).toBe(0);
    expect(result.pastFlagged).toBe(0);
    expect(result.affectedShiftIds.length).toBe(0);

    // Confirm pre-existing soft-delete metadata is unchanged.
    const after = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(after.deletedReason).toBe("MANUAL_RESTORE_REVERT");
  });

  // T7: Already-flagged past shift → no re-audit.
  it("T7 — past shift already flagged conflictsWithLeave=true does not double-audit", async () => {
    const now = new Date("2030-06-01T12:00:00Z");
    const past = addDaysUtc(dateOnlyUtc(now), -1);
    const shift = await seedShift(app, data.employee.id, past, { conflictsWithLeave: true });

    const result = await cleanupShiftsForBSAbsence(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      dates: [past],
      now,
      triggerSource: "PATTERN",
    });

    // We still count the shift as "pastFlagged" so callers can include it in
    // the notification preview, but we skip the AuditLog write because the
    // state didn't change (no-op suppression — matches Phase 64 BREAK pattern).
    expect(result.pastFlagged).toBe(1);

    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "Shift", entityId: shift.id, action: "SHIFT_BS_DAY_CONFLICT_FLAGGED" },
    });
    expect(audits.length).toBe(0);
  });

  // T8: Hard-delete invariant — prisma.shift.delete is NEVER called.
  it("T8 — hard-delete invariant: prisma.shift.delete is NEVER invoked", async () => {
    const now = new Date("2030-06-01T12:00:00Z");
    const future = addDaysUtc(dateOnlyUtc(now), 7);
    const past = addDaysUtc(dateOnlyUtc(now), -1);
    await seedShift(app, data.employee.id, future);
    await seedShift(app, data.employee.id, past);

    const hardDeleteSpy = vi.spyOn(app.prisma.shift, "delete");
    const hardDeleteManySpy = vi.spyOn(app.prisma.shift, "deleteMany");

    await cleanupShiftsForBSAbsence(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      dates: [future, past],
      now,
      triggerSource: "PATTERN",
    });

    expect(hardDeleteSpy.mock.calls.length).toBe(0);
    expect(hardDeleteManySpy.mock.calls.length).toBe(0);

    hardDeleteSpy.mockRestore();
    hardDeleteManySpy.mockRestore();
  });
});
