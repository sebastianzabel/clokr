/**
 * Phase 83 Plan 04 — Integration tests for reresolve-work-event-minutes.ts
 * and rollback-reresolve-work-event.ts.
 *
 * Tests all 9 Wave-0 scaffold items:
 *  1. Dry-run prints JSON without writing
 *  2. Missing --operator-user-id exits non-zero with German error
 *  3. --apply updates workedMinutes via slot resolver
 *  4. --apply does NOT set expectedMinutes for MONTHLY_HOURS (D-04)
 *  5. Skips WorkEvent rows in locked months (T-83-01)
 *  6. Writes exactly ONE summary AuditLog per tenant per run
 *  7. Re-run produces affectedRows=0 (idempotency)
 *  8. Rollback restores pre-resolution workedMinutes/expectedMinutes
 *  9. Rollback writes AuditLog RERESOLVE_WORK_EVENT_MINUTES_ROLLBACK_V19
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "../../src/__tests__/setup";
import { main, RERESOLVE_ACTION } from "../reresolve-work-event-minutes";
import { main as rollbackMain, ROLLBACK_ACTION } from "../rollback-reresolve-work-event";
import { WorkEventType, EmployeeClassification } from "@clokr/db";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// Snapshot dir mirrors what the script uses at runtime.
const __filename = fileURLToPath(import.meta.url);
const SNAPSHOT_DIR = join(dirname(__filename), "..", ".snapshots");

describe("reresolve-work-event-minutes (Phase 83 operator script)", () => {
  let app: FastifyInstance;
  let tenantCounter = 0;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
    // Clean up any snapshots written during tests.
    if (existsSync(SNAPSHOT_DIR)) {
      rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
    }
  });

  // ── Seed helpers ─────────────────────────────────────────────────────────────

  async function seedTenantWithAzubi(opts: {
    scheduleType?: "FIXED_SCHEDULE" | "MONTHLY_HOURS";
    bsSlotFirstLongDayMinutes?: number;
    bsSlotSecondLongDayMinutes?: number;
    bsSlotShortDayMinutes?: number;
  } = {}): Promise<{
    tenantId: string;
    employeeId: string;
    operatorUserId: string;
  }> {
    const prisma = app.prisma;
    tenantCounter++;
    const s = `p83-04-${Date.now().toString(36)}-${tenantCounter}-${Math.random().toString(36).slice(2, 6)}`;

    const tenant = await prisma.tenant.create({
      data: { name: `P83-04 ${s}`, slug: `p83-04-${s}`, federalState: "NIEDERSACHSEN" },
    });
    await prisma.tenantConfig.create({
      data: {
        tenantId: tenant.id,
        defaultVacationDays: 30,
        timezone: "Europe/Berlin",
        vocationalSchoolMinutesPerDay: 480,
        vocationalSchoolBlockMinutesPerWeek: 2400,
        bsSlotFirstLongDayMinutes: opts.bsSlotFirstLongDayMinutes ?? null,
        bsSlotSecondLongDayMinutes: opts.bsSlotSecondLongDayMinutes ?? null,
        bsSlotShortDayMinutes: opts.bsSlotShortDayMinutes ?? null,
      },
    });

    const opUser = await prisma.user.create({
      data: {
        email: `op-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });

    const empUser = await prisma.user.create({
      data: {
        email: `emp-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: empUser.id,
        employeeNumber: `E-${s}`,
        firstName: "A.",
        lastName: "Z.",
        classification: EmployeeClassification.AZUBI,
        hireDate: new Date("2024-01-01T00:00:00Z"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: opts.scheduleType ?? "FIXED_SCHEDULE",
        weeklyHours: opts.scheduleType === "MONTHLY_HOURS" ? 0 : 40,
        mondayHours: opts.scheduleType === "MONTHLY_HOURS" ? 0 : 8,
        tuesdayHours: opts.scheduleType === "MONTHLY_HOURS" ? 0 : 8,
        wednesdayHours: opts.scheduleType === "MONTHLY_HOURS" ? 0 : 8,
        thursdayHours: opts.scheduleType === "MONTHLY_HOURS" ? 0 : 8,
        fridayHours: opts.scheduleType === "MONTHLY_HOURS" ? 0 : 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

    return { tenantId: tenant.id, employeeId: emp.id, operatorUserId: opUser.id };
  }

  async function seedWorkEvent(opts: {
    employeeId: string;
    dateISO: string;
    workedMinutes?: number;
    expectedMinutes?: number | null;
  }): Promise<string> {
    const we = await app.prisma.workEvent.create({
      data: {
        employeeId: opts.employeeId,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        date: new Date(opts.dateISO + "T00:00:00Z"),
        workedMinutes: opts.workedMinutes ?? 480,
        expectedMinutes: opts.expectedMinutes !== undefined ? opts.expectedMinutes : 480,
      },
    });
    return we.id;
  }

  async function cleanupTenant(tenantId: string) {
    try {
      await app.prisma.auditLog.deleteMany({
        where: {
          OR: [
            { action: RERESOLVE_ACTION },
            { action: ROLLBACK_ACTION },
            { entity: "WorkEvent", entityId: tenantId },
          ],
        },
      });
      await app.prisma.workEvent.deleteMany({
        where: { employee: { tenantId } },
      });
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("p83-04 test cleanup failed:", err);
    }
  }

  // ── Test 1: dry-run default ──────────────────────────────────────────────────

  describe("dry-run default", () => {
    it("Without --apply prints JSON summary and writes nothing", async () => {
      const { tenantId, employeeId, operatorUserId } = await seedTenantWithAzubi();
      try {
        await seedWorkEvent({ employeeId, dateISO: "2026-06-01", workedMinutes: 480 });

        const summary = await main(["--tenant-id", tenantId, "--operator-user-id", operatorUserId], app.prisma);

        expect(summary.dryRun).toBe(true);
        expect(summary.tenantId).toBe(tenantId);
        expect(typeof summary.affectedRows).toBe("number");
        expect(typeof summary.unchangedRows).toBe("number");
        expect(summary.snapshotPath).toBeNull();

        // Dry-run must NOT write AuditLog.
        const auditCount = await app.prisma.auditLog.count({
          where: { action: RERESOLVE_ACTION, entityId: tenantId },
        });
        expect(auditCount).toBe(0);

        // WorkEvent must not be modified.
        const we = await app.prisma.workEvent.findFirst({ where: { employeeId } });
        expect(we?.workedMinutes).toBe(480);
      } finally {
        await cleanupTenant(tenantId);
      }
    });

    // ── Test 2: missing --operator-user-id ─────────────────────────────────────

    it("Missing --operator-user-id throws German error 'Operator-Auswahl erforderlich'", async () => {
      const { tenantId } = await seedTenantWithAzubi();
      try {
        await expect(
          main(["--tenant-id", tenantId], app.prisma),
        ).rejects.toThrow(/Operator-Auswahl erforderlich.*--operator-user-id/);
      } finally {
        await cleanupTenant(tenantId);
      }
    });
  });

  // ── Test 3 + 4: --apply behavior ────────────────────────────────────────────

  describe("--apply behavior", () => {
    it("Updates WorkEvent.workedMinutes via slot resolver for non-locked rows (FIRST_LONG_DAY)", async () => {
      // FIRST_LONG_DAY: ordinal 1 → creditedMinutes = bsSlotFirstLongDayMinutes (600)
      // vs. old value 480. Script must update to 600.
      const { tenantId, employeeId, operatorUserId } = await seedTenantWithAzubi({
        bsSlotFirstLongDayMinutes: 600,
      });
      const runId = randomUUID();
      try {
        const weId = await seedWorkEvent({
          employeeId,
          dateISO: "2026-06-01", // Monday — ordinal 1 in its week
          workedMinutes: 480,     // stale Phase-78 value
          expectedMinutes: 480,
        });

        const summary = await main(
          ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
          app.prisma,
          runId,
        );

        expect(summary.dryRun).toBe(false);
        expect(summary.affectedRows).toBe(1);
        expect(summary.unchangedRows).toBe(0);
        expect(summary.snapshotPath).not.toBeNull();

        const we = await app.prisma.workEvent.findUnique({ where: { id: weId } });
        expect(we?.workedMinutes).toBe(600);
        expect(we?.expectedMinutes).toBe(600);
      } finally {
        await cleanupTenant(tenantId);
      }
    });

    it("Does NOT set expectedMinutes for MONTHLY_HOURS schedule (D-04 invariant)", async () => {
      // D-04: MONTHLY_HOURS → contributesToExpected=false → expectedMinutes=null
      const { tenantId, employeeId, operatorUserId } = await seedTenantWithAzubi({
        scheduleType: "MONTHLY_HOURS",
        bsSlotFirstLongDayMinutes: 480,
      });
      const runId = randomUUID();
      try {
        const weId = await seedWorkEvent({
          employeeId,
          dateISO: "2026-06-01",
          workedMinutes: 480,
          expectedMinutes: 480, // incorrect — should be null for MONTHLY_HOURS
        });

        await main(
          ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
          app.prisma,
          runId,
        );

        const we = await app.prisma.workEvent.findUnique({ where: { id: weId } });
        expect(we?.workedMinutes).toBe(480); // creditedMinutes for FIRST_LONG_DAY
        expect(we?.expectedMinutes).toBeNull(); // D-04: MONTHLY_HOURS → null
      } finally {
        await cleanupTenant(tenantId);
      }
    });

    it("Skips WorkEvent rows in closed months (T-83-01 locked-month immutability)", async () => {
      const { tenantId, employeeId, operatorUserId } = await seedTenantWithAzubi({
        bsSlotFirstLongDayMinutes: 600,
      });
      const runId = randomUUID();
      try {
        // Seed a WorkEvent in June 2026.
        const weId = await seedWorkEvent({
          employeeId,
          dateISO: "2026-06-01",
          workedMinutes: 480, // stale
          expectedMinutes: 480,
        });

        // Create a locked TimeEntry in June 2026 (canonical locked-month signal).
        await app.prisma.timeEntry.create({
          data: {
            employeeId,
            date: new Date("2026-06-01T00:00:00Z"),
            startTime: new Date("2026-06-01T08:00:00Z"),
            endTime: new Date("2026-06-01T16:00:00Z"),
            isLocked: true,
          },
        });

        const summary = await main(
          ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
          app.prisma,
          runId,
        );

        // The WorkEvent must be skipped (locked month).
        expect(summary.lockedSkipped).toBe(1);
        expect(summary.affectedRows).toBe(0);

        // Original value must be preserved.
        const we = await app.prisma.workEvent.findUnique({ where: { id: weId } });
        expect(we?.workedMinutes).toBe(480); // untouched
      } finally {
        await cleanupTenant(tenantId);
      }
    });

    it("Writes exactly one summary AuditLog row per tenant per --apply run", async () => {
      const { tenantId, employeeId, operatorUserId } = await seedTenantWithAzubi({
        bsSlotFirstLongDayMinutes: 600,
      });
      const runId = randomUUID();
      try {
        await seedWorkEvent({ employeeId, dateISO: "2026-06-01", workedMinutes: 480 });
        await seedWorkEvent({ employeeId, dateISO: "2026-06-08", workedMinutes: 480 });

        await main(
          ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
          app.prisma,
          runId,
        );

        const auditRows = await app.prisma.auditLog.findMany({
          where: { action: RERESOLVE_ACTION, entityId: tenantId },
        });
        // Exactly ONE summary AuditLog row per run (M-2 pattern).
        expect(auditRows).toHaveLength(1);
        const row = auditRows[0];
        expect(row.userId).toBe(operatorUserId); // B2
        expect(row.entity).toBe("WorkEvent");
        const newValue = row.newValue as Record<string, unknown> | null;
        expect(newValue?.runId).toBe(runId);
        expect(typeof newValue?.affectedRows).toBe("number");
      } finally {
        await cleanupTenant(tenantId);
      }
    });

    it("Re-run on same tenant produces affectedRows=0 (idempotent)", async () => {
      const { tenantId, employeeId, operatorUserId } = await seedTenantWithAzubi({
        bsSlotFirstLongDayMinutes: 600,
      });
      const runId1 = randomUUID();
      const runId2 = randomUUID();
      try {
        await seedWorkEvent({ employeeId, dateISO: "2026-06-01", workedMinutes: 480 });

        // First apply — should update.
        const first = await main(
          ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
          app.prisma,
          runId1,
        );
        expect(first.affectedRows).toBe(1);

        // Second apply — resolver gives same output → no diffs.
        const second = await main(
          ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
          app.prisma,
          runId2,
        );
        expect(second.affectedRows).toBe(0);
        expect(second.unchangedRows).toBe(1);
      } finally {
        await cleanupTenant(tenantId);
      }
    });
  });

  // ── Test 8 + 9: rollback companion ──────────────────────────────────────────

  describe("rollback companion script (rollback-reresolve-work-event.ts)", () => {
    it("Rollback restores pre-resolution workedMinutes/expectedMinutes from snapshot", async () => {
      const { tenantId, employeeId, operatorUserId } = await seedTenantWithAzubi({
        bsSlotFirstLongDayMinutes: 600,
      });
      const runId = randomUUID();
      try {
        const weId = await seedWorkEvent({
          employeeId,
          dateISO: "2026-06-01",
          workedMinutes: 480, // stale
          expectedMinutes: 480,
        });

        // Forward --apply: changes 480 → 600.
        const forwardSummary = await main(
          ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
          app.prisma,
          runId,
        );
        expect(forwardSummary.affectedRows).toBe(1);
        expect(forwardSummary.snapshotPath).not.toBeNull();

        // Verify the forward update applied.
        const afterForward = await app.prisma.workEvent.findUnique({ where: { id: weId } });
        expect(afterForward?.workedMinutes).toBe(600);

        // Rollback --apply: must restore to 480.
        const rollbackSummary = await rollbackMain(
          [
            "--tenant-id", tenantId,
            "--run-id", runId,
            "--operator-user-id", operatorUserId,
            "--apply",
          ],
          app.prisma,
        );

        expect(rollbackSummary.restoreCount).toBe(1);
        expect(rollbackSummary.lockedSkipped).toBe(0);

        const afterRollback = await app.prisma.workEvent.findUnique({ where: { id: weId } });
        expect(afterRollback?.workedMinutes).toBe(480); // restored to pre-resolution value
        expect(afterRollback?.expectedMinutes).toBe(480);
      } finally {
        await cleanupTenant(tenantId);
      }
    });

    it("Rollback writes AuditLog action RERESOLVE_WORK_EVENT_MINUTES_ROLLBACK_V19", async () => {
      const { tenantId, employeeId, operatorUserId } = await seedTenantWithAzubi({
        bsSlotFirstLongDayMinutes: 600,
      });
      const runId = randomUUID();
      try {
        await seedWorkEvent({ employeeId, dateISO: "2026-06-01", workedMinutes: 480 });

        // Forward to create snapshot.
        await main(
          ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
          app.prisma,
          runId,
        );

        // Rollback --apply.
        await rollbackMain(
          [
            "--tenant-id", tenantId,
            "--run-id", runId,
            "--operator-user-id", operatorUserId,
            "--apply",
          ],
          app.prisma,
        );

        const rollbackAudit = await app.prisma.auditLog.findFirst({
          where: { action: ROLLBACK_ACTION, entityId: tenantId },
          orderBy: { createdAt: "desc" },
        });
        expect(rollbackAudit).not.toBeNull();
        expect(rollbackAudit!.userId).toBe(operatorUserId); // B2
        expect(rollbackAudit!.entity).toBe("WorkEvent");

        const newValue = rollbackAudit!.newValue as Record<string, unknown> | null;
        expect(newValue?.restoredFromRunId).toBe(runId);
        expect(typeof newValue?.restoreCount).toBe("number");
      } finally {
        await cleanupTenant(tenantId);
      }
    });
  });
});
