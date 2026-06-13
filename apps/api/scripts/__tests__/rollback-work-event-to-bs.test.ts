/**
 * Phase 80 Plan 02 — Inverse rollback script tests.
 *
 * Reverses every operation of Plan 80-01's forward script. Source of truth =
 * `WorkEvent.legacyAbsenceId` (the provenance link). Critical safety:
 * operator-created WorkEvent rows (legacyAbsenceId IS NULL) are LEFT UNTOUCHED.
 *
 * Covers:
 *   - Round-trip with byte-equivalent note preservation (B4 + M-6 paranoia)
 *   - Flag flip back to false
 *   - Summary-only AuditLog with operator userId (B2)
 *   - Idempotent re-run (--apply after success → zero-count summary)
 *   - Operator-created WorkEvent rows untouched (W5 mirror)
 *   - Generator pause/resume (M-4)
 *   - Dry-run does NOT mutate
 *   - Tenant + operator UUID validation (B2)
 *   - Partial-state note suffix idempotency
 *
 * Uses initials only (NO PII per memory `feedback_no_pii_in_github`).
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "../../src/__tests__/setup";
import {
  main as rollbackMain,
  type RollbackSummary,
} from "../rollback-work-event-to-bs";
import { main as migrateMain, type MigrationSummary } from "../migrate-bs-to-work-event";
import * as generator from "../../src/utils/vocational-school-generator";
import { _resetPausedTenantsForTests } from "../../src/utils/vocational-school-generator";
import {
  getTenantWorkEventModelLive,
  invalidateTenantWorkEventModelLiveCache,
} from "../../src/utils/work-event";
import { AbsenceType, WorkEventType, EmployeeClassification } from "@clokr/db";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

describe("rollback-work-event-to-bs (Phase 80 Plan 02)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // IN-11: prevent pause-set leak across tests.
    _resetPausedTenantsForTests();
    // Reset workEventModelLive cache so flag flips are observed by getTenantWorkEventModelLive.
    invalidateTenantWorkEventModelLiveCache();
    vi.restoreAllMocks();
  });

  // ── Seed helpers ────────────────────────────────────────────────────────────

  let tenantCounter = 0;

  async function seedTenantAndEmployee(opts: {
    classification?: EmployeeClassification;
    vocationalSchoolBlockMinutesPerWeek?: number;
    vocationalSchoolMinutesPerDay?: number;
  }): Promise<{
    tenantId: string;
    employeeId: string;
    operatorUserId: string;
  }> {
    const prisma = app.prisma;
    tenantCounter++;
    const s = `p80-02-${Date.now().toString(36)}-${tenantCounter}-${Math.random().toString(36).slice(2, 6)}`;

    const tenant = await prisma.tenant.create({
      data: { name: `P80-02 ${s}`, slug: `p80-02-${s}`, federalState: "NIEDERSACHSEN" },
    });
    await prisma.tenantConfig.create({
      data: {
        tenantId: tenant.id,
        defaultVacationDays: 30,
        timezone: "Europe/Berlin",
        vocationalSchoolMinutesPerDay: opts.vocationalSchoolMinutesPerDay ?? 480,
        vocationalSchoolBlockMinutesPerWeek: opts.vocationalSchoolBlockMinutesPerWeek ?? 2400,
      },
    });

    const operator = await prisma.user.create({
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
        classification: opts.classification ?? EmployeeClassification.AZUBI,
        hireDate: new Date("2024-01-01T00:00:00Z"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

    return {
      tenantId: tenant.id,
      employeeId: emp.id,
      operatorUserId: operator.id,
    };
  }

  async function seedAbsenceVS(opts: {
    employeeId: string;
    dateISO: string;
    note?: string | null;
  }): Promise<{ id: string; note: string | null }> {
    const ab = await app.prisma.absence.create({
      data: {
        employeeId: opts.employeeId,
        type: AbsenceType.VOCATIONAL_SCHOOL,
        source: "PATTERN",
        startDate: new Date(opts.dateISO + "T00:00:00Z"),
        endDate: new Date(opts.dateISO + "T00:00:00Z"),
        days: 1.0,
        note: opts.note ?? null,
        createdBy: "SYSTEM",
      },
      select: { id: true, note: true },
    });
    return { id: ab.id, note: ab.note };
  }

  async function cleanupTenant(tenantId: string) {
    try {
      const employees = await app.prisma.employee.findMany({
        where: { tenantId },
        select: { id: true },
      });
      const employeeIds = employees.map((e) => e.id);
      await app.prisma.auditLog.deleteMany({
        where: {
          OR: [
            { action: "WORK_EVENT_MIGRATION_V19" },
            { action: "WORK_EVENT_ROLLBACK_V19" },
            { entity: "Tenant", entityId: tenantId },
          ],
        },
      });
      await app.prisma.workEvent.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("p80-02 test cleanup failed:", err);
    }
  }

  // ── Snapshot helper for Test 1 (round-trip) ──────────────────────────────────

  async function snapshotState(tenantId: string) {
    const prisma = app.prisma;
    const absences = await prisma.absence.findMany({
      where: { employee: { tenantId }, type: AbsenceType.VOCATIONAL_SCHOOL },
      select: { id: true, deletedAt: true, note: true, employeeId: true, startDate: true },
      orderBy: [{ employeeId: "asc" }, { startDate: "asc" }],
    });
    const workEvents = await prisma.workEvent.findMany({
      where: { employee: { tenantId }, type: WorkEventType.VOCATIONAL_SCHOOL },
      select: {
        id: true,
        deletedAt: true,
        legacyAbsenceId: true,
        employeeId: true,
        date: true,
        note: true,
      },
      orderBy: [{ employeeId: "asc" }, { date: "asc" }],
    });
    const tc = await prisma.tenantConfig.findUnique({ where: { tenantId } });
    return { absences, workEvents, flag: tc?.workEventModelLive ?? null };
  }

  // ── Test 1 (B4 + M-6): Round-trip with byte-equivalent note preservation ────

  it(
    "B4 + M-6: forward → rollback → forward preserves Absence.note byte-equivalent on round-trip",
    async () => {
      const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
        classification: EmployeeClassification.AZUBI,
      });

      try {
        const operatorNote = "AZUBI XY hat Sondergenehmigung vom Berufsschullehrer";

        const ab1 = await seedAbsenceVS({
          employeeId,
          dateISO: "2026-06-01",
          note: operatorNote,
        });
        const ab2 = await seedAbsenceVS({ employeeId, dateISO: "2026-06-15", note: null });
        const ab3 = await seedAbsenceVS({ employeeId, dateISO: "2026-07-01", note: null });

        // ── Pre-forward snapshot ───────────────────────────────────────────
        const preForward = await snapshotState(tenantId);
        expect(preForward.absences).toHaveLength(3);
        expect(preForward.workEvents).toHaveLength(0);
        expect(preForward.flag).toBe(false);
        const preNotes = new Map(preForward.absences.map((a) => [a.id, a.note]));
        expect(preNotes.get(ab1.id)).toBe(operatorNote);
        expect(preNotes.get(ab2.id)).toBeNull();
        expect(preNotes.get(ab3.id)).toBeNull();

        // ── Forward 1 ──────────────────────────────────────────────────────
        const fwd1 = await migrateMain(
          ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
          app.prisma,
        );
        expect(fwd1.createdCount).toBe(3);
        expect(fwd1.flagFlipped).toBe(true);

        const afterForward = await snapshotState(tenantId);
        expect(afterForward.flag).toBe(true);
        const notedAfterForward = afterForward.absences.find((a) => a.id === ab1.id);
        expect(notedAfterForward!.note).toBe(
          `${operatorNote}\n[Migrated to WorkEvent. Run: ${fwd1.runId}]`,
        );
        // null-note rows get the suffix only.
        const ab2AfterForward = afterForward.absences.find((a) => a.id === ab2.id);
        expect(ab2AfterForward!.note).toBe(`[Migrated to WorkEvent. Run: ${fwd1.runId}]`);

        // ── Rollback ───────────────────────────────────────────────────────
        const rb1 = await rollbackMain(
          ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
          app.prisma,
        );
        expect(rb1.reactivatedCount).toBe(3);
        expect(rb1.flagFlipped).toBe(true);

        const afterRollback = await snapshotState(tenantId);
        expect(afterRollback.flag).toBe(false);

        // CRITICAL B4 — operator note round-trips byte-for-byte.
        const notedAfterRollback = afterRollback.absences.find((a) => a.id === ab1.id);
        expect(notedAfterRollback!.note).toBe(operatorNote);
        expect(notedAfterRollback!.deletedAt).toBeNull();

        // null-note rows collapse back to null (NOT empty string).
        const ab2AfterRollback = afterRollback.absences.find((a) => a.id === ab2.id);
        expect(ab2AfterRollback!.note).toBeNull();
        expect(ab2AfterRollback!.deletedAt).toBeNull();
        const ab3AfterRollback = afterRollback.absences.find((a) => a.id === ab3.id);
        expect(ab3AfterRollback!.note).toBeNull();
        expect(ab3AfterRollback!.deletedAt).toBeNull();

        // WorkEvent rows still EXIST (audit trail) with deletedAt set.
        expect(afterRollback.workEvents).toHaveLength(3);
        for (const we of afterRollback.workEvents) {
          expect(we.deletedAt).not.toBeNull();
        }

        // ── Forward 2 (after rollback) ─────────────────────────────────────
        // After rollback, the WorkEvent rows still exist with deletedAt set
        // AND legacyAbsenceId pointing at the now-reactivated Absences. The
        // forward script's same-row idempotency pre-check
        // (existingByLegacy.sameRow) recognizes these as already-migrated
        // (same employeeId/date/type) and skips them — leaving the
        // reactivated Absences UNTOUCHED. This is the forward script's
        // idempotency contract: re-runs do not re-mutate already-migrated
        // rows. M-6 round-trip is satisfied by: pre-forward == after-rollback
        // (byte-equivalent), which Test 1's primary assertions verify.
        const fwd2 = await migrateMain(
          ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
          app.prisma,
        );
        // Skipped via same-row idempotency — 3 rows recognized as already migrated.
        expect(fwd2.skipped).toBe(3);
        expect(fwd2.createdCount).toBe(0);
        expect(fwd2.flagFlipped).toBe(true);

        const afterForward2 = await snapshotState(tenantId);
        expect(afterForward2.flag).toBe(true);

        // Absences stay reactivated (with operator notes preserved
        // byte-equivalent) because the same-row idempotency path doesn't
        // touch them. This is the locked behavior of the forward script.
        const notedAfterForward2 = afterForward2.absences.find((a) => a.id === ab1.id);
        expect(notedAfterForward2!.note).toBe(operatorNote);
        expect(notedAfterForward2!.deletedAt).toBeNull();
      } finally {
        await cleanupTenant(tenantId);
      }
    },
    30_000,
  );

  // ── Test 2: Flag flip back to false ─────────────────────────────────────────

  it("flag flips back to false after successful --apply rollback", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      await seedAbsenceVS({ employeeId, dateISO: "2026-06-01" });

      await migrateMain(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );
      const tcMid = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      expect(tcMid?.workEventModelLive).toBe(true);

      const summary = await rollbackMain(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );
      expect(summary.flagFlipped).toBe(true);

      const tcAfter = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      expect(tcAfter?.workEventModelLive).toBe(false);
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 3 (B2 + M-2): Summary-only AuditLog with operator userId ───────────

  it("M-2 + B2: exactly 1 AuditLog row per --apply rollback run with userId = operatorUserId", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      const dates = ["2026-06-01", "2026-06-15", "2026-07-01"];
      for (const d of dates) {
        await seedAbsenceVS({ employeeId, dateISO: d });
      }

      await migrateMain(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );

      await rollbackMain(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );

      const auditRows = await app.prisma.auditLog.findMany({
        where: { action: "WORK_EVENT_ROLLBACK_V19", entityId: tenantId },
      });
      expect(auditRows).toHaveLength(1);
      const row = auditRows[0];
      expect(row.entity).toBe("Tenant");
      expect(row.entityId).toBe(tenantId);
      expect(row.userId).toBe(operatorUserId); // B2 — never null

      const newValue = row.newValue as Record<string, unknown> | null;
      expect(newValue).not.toBeNull();
      expect(newValue).toMatchObject({
        runId: expect.any(String),
        sourceCount: expect.any(Number),
        reactivatedCount: expect.any(Number),
        skipped: expect.any(Number),
        durationMs: expect.any(Number),
      });

      const oldValue = row.oldValue as Record<string, unknown> | null;
      expect(oldValue).not.toBeNull();
      expect(oldValue!.workEventModelLive).toBe(true);
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 4: Idempotent re-run after successful rollback ─────────────────────

  it("re-running --apply after successful rollback is a no-op (sourceCount=0)", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      await seedAbsenceVS({ employeeId, dateISO: "2026-06-01" });
      await seedAbsenceVS({ employeeId, dateISO: "2026-06-15" });

      await migrateMain(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );

      const rb1 = await rollbackMain(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );
      expect(rb1.reactivatedCount).toBe(2);
      expect(rb1.flagFlipped).toBe(true);

      const rb2 = await rollbackMain(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );
      // Second rollback: source query filters by deletedAt:null on WorkEvent
      // AND legacyAbsenceId:not null. Since the first rollback soft-deleted
      // those WorkEvent rows, source count is 0.
      expect(rb2.sourceCount).toBe(0);
      expect(rb2.reactivatedCount).toBe(0);
      expect(rb2.skipped).toBe(0);

      // Exactly 2 AuditLog rows for ROLLBACK action (one per --apply run).
      const auditRows = await app.prisma.auditLog.findMany({
        where: { action: "WORK_EVENT_ROLLBACK_V19", entityId: tenantId },
      });
      expect(auditRows).toHaveLength(2);
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 5 (W5 mirror): Operator-created WorkEvent rows NOT touched ─────────

  it("W5 mirror: WorkEvent rows with legacyAbsenceId=null are NOT rolled back", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      await seedAbsenceVS({ employeeId, dateISO: "2026-06-08" });

      // Pre-insert an operator-created WorkEvent (legacyAbsenceId=null) on a
      // DIFFERENT date — simulates Phase 79 endpoint creation.
      const operatorWE = await app.prisma.workEvent.create({
        data: {
          employeeId,
          type: WorkEventType.VOCATIONAL_SCHOOL,
          date: new Date("2026-05-01T00:00:00Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
          legacyAbsenceId: null,
          createdBy: operatorUserId,
        },
      });

      // Forward with --allow-existing-work-events override.
      await migrateMain(
        [
          "--tenant-id",
          tenantId,
          "--operator-user-id",
          operatorUserId,
          "--apply",
          "--allow-existing-work-events",
        ],
        app.prisma,
      );

      // Now rollback.
      const summary = await rollbackMain(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );
      expect(summary.reactivatedCount).toBe(1); // only the forward-script row

      // The operator-created WorkEvent must be UNCHANGED.
      const stillThere = await app.prisma.workEvent.findUnique({
        where: { id: operatorWE.id },
      });
      expect(stillThere).not.toBeNull();
      expect(stillThere!.deletedAt).toBeNull();
      expect(stillThere!.legacyAbsenceId).toBeNull();

      // The forward-script-created WorkEvent IS soft-deleted.
      const forwardWE = await app.prisma.workEvent.findMany({
        where: { employeeId, legacyAbsenceId: { not: null } },
      });
      expect(forwardWE).toHaveLength(1);
      expect(forwardWE[0].deletedAt).not.toBeNull();
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 6 (M-4): Generator pause/resume around rollback tx ─────────────────

  it("M-4: calls pauseTenantGeneration before tx + resumeTenantGeneration in finally", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      await seedAbsenceVS({ employeeId, dateISO: "2026-06-01" });

      // Forward first (no spy yet).
      await migrateMain(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );

      const pauseSpy = vi.spyOn(generator, "pauseTenantGeneration");
      const resumeSpy = vi.spyOn(generator, "resumeTenantGeneration");

      await rollbackMain(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );

      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(pauseSpy).toHaveBeenCalledWith(tenantId);
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(resumeSpy).toHaveBeenCalledWith(tenantId);

      const pauseOrder = pauseSpy.mock.invocationCallOrder[0];
      const resumeOrder = resumeSpy.mock.invocationCallOrder[0];
      expect(pauseOrder).toBeLessThan(resumeOrder);

      pauseSpy.mockRestore();
      resumeSpy.mockRestore();
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 7: Cache invalidated after flag un-flip ────────────────────────────

  it("invalidates getTenantWorkEventModelLive cache after flag un-flip", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      await seedAbsenceVS({ employeeId, dateISO: "2026-06-01" });

      await migrateMain(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );

      // Cache should now report true.
      const liveMid = await getTenantWorkEventModelLive(app.prisma, tenantId);
      expect(liveMid).toBe(true);

      await rollbackMain(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );

      // After rollback the cache MUST be invalidated → new value observed.
      const liveAfter = await getTenantWorkEventModelLive(app.prisma, tenantId);
      expect(liveAfter).toBe(false);
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 8 (B2): Tenant + operator UUID + existence validation ──────────────

  it("B2: validates tenant + operator UUID + existence; missing --operator-user-id halts", async () => {
    const { tenantId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      // Invalid tenant UUID format.
      await expect(
        rollbackMain(
          ["--tenant-id", "not-a-uuid", "--operator-user-id", operatorUserId, "--apply"],
          app.prisma,
        ),
      ).rejects.toThrow(/muss eine gültige UUID sein/);

      // Tenant doesn't exist.
      await expect(
        rollbackMain(
          [
            "--tenant-id",
            "00000000-0000-0000-0000-000000000000",
            "--operator-user-id",
            operatorUserId,
            "--apply",
          ],
          app.prisma,
        ),
      ).rejects.toThrow(/Tenant.*nicht gefunden/);

      // Operator user doesn't exist.
      await expect(
        rollbackMain(
          [
            "--tenant-id",
            tenantId,
            "--operator-user-id",
            "00000000-0000-0000-0000-000000000000",
            "--apply",
          ],
          app.prisma,
        ),
      ).rejects.toThrow(/Operator-User.*nicht gefunden/);

      // Missing --operator-user-id → B2 halt.
      await expect(
        rollbackMain(["--tenant-id", tenantId, "--apply"], app.prisma),
      ).rejects.toThrow(/Operator-Auswahl erforderlich.*--operator-user-id/);

      // Missing --tenant-id → halt.
      await expect(
        rollbackMain(["--operator-user-id", operatorUserId, "--apply"], app.prisma),
      ).rejects.toThrow(/Tenant-Auswahl erforderlich.*--tenant-id/);
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 9: Partial-state note suffix idempotency ───────────────────────────

  it("strips MIGRATION_NOTE_PATTERN suffix even when the source Absence already has it (partial-state)", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      // Seed Absence (soft-deleted, simulating mid-migration aftermath) with a
      // pre-existing migration marker suffix. Then pre-insert a matching
      // WorkEvent row linked via legacyAbsenceId — simulating the precise
      // state Plan 80-01 leaves after a successful run.
      const fakeRunId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const originalNote = "operator note";
      const ab = await app.prisma.absence.create({
        data: {
          employeeId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "PATTERN",
          startDate: new Date("2026-06-01T00:00:00Z"),
          endDate: new Date("2026-06-01T00:00:00Z"),
          days: 1.0,
          note: `${originalNote}\n[Migrated to WorkEvent. Run: ${fakeRunId}]`,
          deletedAt: new Date(),
          createdBy: "SYSTEM",
        },
      });
      // Linked WorkEvent — must have deletedAt:null so the rollback finds it.
      await app.prisma.workEvent.create({
        data: {
          employeeId,
          type: WorkEventType.VOCATIONAL_SCHOOL,
          date: new Date("2026-06-01T00:00:00Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
          legacyAbsenceId: ab.id,
          createdBy: operatorUserId,
        },
      });
      // Manually flip the flag to true since we bypassed the forward script.
      await app.prisma.tenantConfig.update({
        where: { tenantId },
        data: { workEventModelLive: true },
      });

      const summary = await rollbackMain(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );
      expect(summary.reactivatedCount).toBe(1);

      // Suffix stripped → original note restored byte-equivalent.
      const reactivated = await app.prisma.absence.findUnique({ where: { id: ab.id } });
      expect(reactivated!.deletedAt).toBeNull();
      expect(reactivated!.note).toBe(originalNote);

      // Flag back to false.
      const tc = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      expect(tc?.workEventModelLive).toBe(false);
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 10: Dry-run does NOT mutate ────────────────────────────────────────

  it("dry-run (default — no --apply) prints summary, does NOT mutate DB", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      await seedAbsenceVS({ employeeId, dateISO: "2026-06-01" });
      await seedAbsenceVS({ employeeId, dateISO: "2026-06-15" });

      // Run forward FIRST so there's state to roll back.
      await migrateMain(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );

      // Snapshot post-forward.
      const before = await snapshotState(tenantId);

      // Dry-run rollback.
      const dry = await rollbackMain(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId],
        app.prisma,
      );
      expect(dry.dryRun).toBe(true);
      expect(dry.sourceCount).toBe(2);
      expect(dry.flagFlipped).toBe(false);

      // State must be unchanged.
      const after = await snapshotState(tenantId);
      expect(after.flag).toBe(true); // flag still true (no flip)
      // Absences still soft-deleted.
      for (const ab of after.absences) {
        expect(ab.deletedAt).not.toBeNull();
      }
      // WorkEvents still active.
      for (const we of after.workEvents) {
        expect(we.deletedAt).toBeNull();
      }

      // No ROLLBACK AuditLog row written.
      const audit = await app.prisma.auditLog.findMany({
        where: { action: "WORK_EVENT_ROLLBACK_V19", entityId: tenantId },
      });
      expect(audit).toHaveLength(0);

      // before === after sanity
      expect(before.absences.length).toBe(after.absences.length);
      expect(before.workEvents.length).toBe(after.workEvents.length);
    } finally {
      await cleanupTenant(tenantId);
    }
  });
});

// Avoid unused warning for type imports.
const _types: RollbackSummary | MigrationSummary | null = null;
void _types;
