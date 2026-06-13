/**
 * Phase 80 Plan 01 — Forward migration script tests.
 *
 * Covers TEST-V19-02 (idempotency) + the 12 surgical safety properties from the
 * plan-checker revision (B1/B2/B3/B4 + W5/W7 + M-1/M-2/M-4/M-5/M-6 + IN-11).
 *
 * All tests inject `app.prisma` so the script runs against the integration test
 * DB. Uses initials only (NO PII per memory `feedback_no_pii_in_github`).
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "../../src/__tests__/setup";
import {
  main,
  preserveOriginalNote,
  isP2002OnUniqueKey,
  type MigrationSummary,
} from "../migrate-bs-to-work-event";
import * as generator from "../../src/utils/vocational-school-generator";
import { _resetPausedTenantsForTests } from "../../src/utils/vocational-school-generator";
import {
  getTenantWorkEventModelLive,
  invalidateTenantWorkEventModelLiveCache,
} from "../../src/utils/work-event";
import { AbsenceType, WorkEventType, EmployeeClassification } from "@clokr/db";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

describe("migrate-bs-to-work-event (Phase 80 Plan 01)", () => {
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
    // Reset the workEventModelLive cache so flag flips are observed by getTenantWorkEventModelLive.
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
    operatorEmail: string;
  }> {
    const prisma = app.prisma;
    tenantCounter++;
    const s = `p80-01-${Date.now().toString(36)}-${tenantCounter}-${Math.random().toString(36).slice(2, 6)}`;

    const tenant = await prisma.tenant.create({
      data: { name: `P80-01 ${s}`, slug: `p80-01-${s}`, federalState: "NIEDERSACHSEN" },
    });
    await prisma.tenantConfig.create({
      data: {
        tenantId: tenant.id,
        defaultVacationDays: 30,
        timezone: "Europe/Berlin",
        vocationalSchoolMinutesPerDay: opts.vocationalSchoolMinutesPerDay ?? 480,
        vocationalSchoolBlockMinutesPerWeek: opts.vocationalSchoolBlockMinutesPerWeek ?? 2400,
        // workEventModelLive defaults to false per schema
      },
    });

    // Operator user (used as --operator-user-id).
    const opEmail = `op-${s}@test.de`;
    const operator = await prisma.user.create({
      data: {
        email: opEmail,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });

    // The employee being migrated.
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
      operatorEmail: opEmail,
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
            { entity: "Tenant", entityId: tenantId },
          ],
        },
      });
      await app.prisma.workEvent.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("p80-01 test cleanup failed:", err);
    }
  }

  // ── Helper: pure-function tests for exported helpers ────────────────────────

  describe("preserveOriginalNote helper (B4)", () => {
    it("returns marker only when existing note is null", () => {
      const r = preserveOriginalNote(null, "abc-123");
      expect(r).toBe("[Migrated to WorkEvent. Run: abc-123]");
    });

    it("appends marker to existing operator note", () => {
      const r = preserveOriginalNote("AZUBI XY hat Sondergenehmigung", "abc-123");
      expect(r).toBe("AZUBI XY hat Sondergenehmigung\n[Migrated to WorkEvent. Run: abc-123]");
    });

    it("is idempotent — does NOT double-append on re-run with same runId", () => {
      const first = preserveOriginalNote("op note", "abc-123");
      const second = preserveOriginalNote(first, "abc-123");
      expect(second).toBe("op note\n[Migrated to WorkEvent. Run: abc-123]");
    });

    it("strips old marker before appending new runId", () => {
      const first = preserveOriginalNote("op note", "old-run-1234");
      const second = preserveOriginalNote(first, "new-run-5678");
      expect(second).toBe("op note\n[Migrated to WorkEvent. Run: new-run-5678]");
    });
  });

  describe("isP2002OnUniqueKey helper (W7)", () => {
    it("returns false for null / undefined inputs", () => {
      expect(isP2002OnUniqueKey(null, ["employeeId", "date", "type"])).toBe(false);
      expect(isP2002OnUniqueKey(undefined, ["employeeId", "date", "type"])).toBe(false);
    });

    it("returns false for non-PrismaClientKnownRequestError objects", () => {
      expect(isP2002OnUniqueKey(new Error("oops"), ["employeeId", "date", "type"])).toBe(false);
    });
  });

  // ── Test 1 (TEST-V19-02): Idempotency happy path ────────────────────────────

  it("TEST-V19-02: --apply migrates all rows; second run is a no-op (createdCount=0, skipped=N)", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      // Different ISO weeks so block-week math doesn't kick in.
      const dates = ["2026-06-01", "2026-06-15", "2026-07-01", "2026-07-15", "2026-08-03"];
      for (const d of dates) {
        await seedAbsenceVS({ employeeId, dateISO: d });
      }

      const beforeFlag = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      expect(beforeFlag?.workEventModelLive).toBe(false);

      const summary1 = await main(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );

      expect(summary1.createdCount).toBe(5);
      expect(summary1.skipped).toBe(0);
      expect(summary1.flagFlipped).toBe(true);

      const weRows = await app.prisma.workEvent.findMany({ where: { employeeId } });
      expect(weRows).toHaveLength(5);
      for (const r of weRows) {
        expect(r.type).toBe(WorkEventType.VOCATIONAL_SCHOOL);
        expect(r.legacyAbsenceId).not.toBeNull();
        expect(r.workedMinutes).toBe(480);
        expect(r.expectedMinutes).toBe(480);
      }

      const softDeleted = await app.prisma.absence.findMany({
        where: { employeeId, type: AbsenceType.VOCATIONAL_SCHOOL },
      });
      expect(softDeleted).toHaveLength(5);
      for (const ab of softDeleted) {
        expect(ab.deletedAt).not.toBeNull();
      }

      const tcAfter = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      expect(tcAfter?.workEventModelLive).toBe(true);

      const auditRows1 = await app.prisma.auditLog.findMany({
        where: { action: "WORK_EVENT_MIGRATION_V19", entityId: tenantId },
      });
      expect(auditRows1).toHaveLength(1);
      expect(auditRows1[0].userId).toBe(operatorUserId);

      // Re-run — must be no-op for createdCount, skipped=5.
      const summary2 = await main(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );
      expect(summary2.createdCount).toBe(0);
      expect(summary2.skipped).toBe(5);
      expect(summary2.flagFlipped).toBe(true);

      const weAfter = await app.prisma.workEvent.findMany({ where: { employeeId } });
      expect(weAfter).toHaveLength(5);

      const softDeletedAfter = await app.prisma.absence.findMany({
        where: { employeeId, type: AbsenceType.VOCATIONAL_SCHOOL },
      });
      expect(softDeletedAfter).toHaveLength(5);

      const auditRows2 = await app.prisma.auditLog.findMany({
        where: { action: "WORK_EVENT_MIGRATION_V19", entityId: tenantId },
      });
      expect(auditRows2).toHaveLength(2);
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 2: Non-AZUBI safety halt (M-5) ─────────────────────────────────────

  it("M-5: halts when Absence VS rows exist for non-AZUBI employee without override flag", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.VOLLZEIT,
    });

    try {
      await seedAbsenceVS({ employeeId, dateISO: "2026-06-01" });

      await expect(
        main(
          ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
          app.prisma,
        ),
      ).rejects.toThrow(/Pre-flight Halt.*1.*AZUBI/);

      const tc = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      expect(tc?.workEventModelLive).toBe(false);

      const weRows = await app.prisma.workEvent.findMany({ where: { employeeId } });
      expect(weRows).toHaveLength(0);

      const ab = await app.prisma.absence.findFirst({
        where: { employeeId, type: AbsenceType.VOCATIONAL_SCHOOL },
      });
      expect(ab?.deletedAt).toBeNull();
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 3: Non-AZUBI override (M-5) ────────────────────────────────────────

  it("M-5: --allow-non-azubi-legacy proceeds; nonAzubiLegacyCount surfaced in AuditLog", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.VOLLZEIT,
    });

    try {
      await seedAbsenceVS({ employeeId, dateISO: "2026-06-01" });

      const summary = await main(
        [
          "--tenant-id",
          tenantId,
          "--operator-user-id",
          operatorUserId,
          "--apply",
          "--allow-non-azubi-legacy",
        ],
        app.prisma,
      );

      expect(summary.createdCount).toBe(1);
      expect(summary.nonAzubiLegacyCount).toBe(1);
      expect(summary.flagFlipped).toBe(true);

      const audit = await app.prisma.auditLog.findFirst({
        where: { action: "WORK_EVENT_MIGRATION_V19", entityId: tenantId },
      });
      expect(audit).not.toBeNull();
      expect(audit!.userId).toBe(operatorUserId);
      const newValue = audit!.newValue as Record<string, unknown> | null;
      expect(newValue!.allowNonAzubiLegacy).toBe(true);
      expect(newValue!.nonAzubiLegacyCount).toBe(1);
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 4: Existing WorkEvent without legacyAbsenceId (W5) ─────────────────

  it("W5: halts when WorkEvent VS rows without legacyAbsenceId exist; override flag works", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      await seedAbsenceVS({ employeeId, dateISO: "2026-06-08" });
      // Pre-insert a WorkEvent on a DIFFERENT date with no legacyAbsenceId.
      await app.prisma.workEvent.create({
        data: {
          employeeId,
          type: WorkEventType.VOCATIONAL_SCHOOL,
          date: new Date("2026-05-01T00:00:00Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
          legacyAbsenceId: null,
        },
      });

      await expect(
        main(
          ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
          app.prisma,
        ),
      ).rejects.toThrow(/Pre-flight Halt.*1.*bestehende WorkEvent.*legacyAbsenceId/);

      const tcAfter = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      expect(tcAfter?.workEventModelLive).toBe(false);
      const ab = await app.prisma.absence.findFirst({
        where: { employeeId, type: AbsenceType.VOCATIONAL_SCHOOL },
      });
      expect(ab?.deletedAt).toBeNull();

      // Now run with the override.
      const summary = await main(
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
      expect(summary.createdCount).toBe(1);
      expect(summary.existingWorkEventCount).toBe(1);
      expect(summary.flagFlipped).toBe(true);
      expect(summary.dataQualityIssues.existingWorkEventsWithoutLegacyLink).toBe(1);

      const audit = await app.prisma.auditLog.findFirst({
        where: { action: "WORK_EVENT_MIGRATION_V19", entityId: tenantId },
      });
      const newValue = audit!.newValue as Record<string, unknown> | null;
      const dataQuality = newValue!.dataQualityIssues as Record<string, number>;
      expect(dataQuality.existingWorkEventsWithoutLegacyLink).toBe(1);
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 5: Tenant + operator validation ────────────────────────────────────

  it("validates tenant + operator UUID + existence", async () => {
    const { tenantId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      // Invalid UUID format for tenant.
      await expect(
        main(
          ["--tenant-id", "not-a-uuid", "--operator-user-id", operatorUserId, "--apply"],
          app.prisma,
        ),
      ).rejects.toThrow(/muss eine gültige UUID sein/);

      // Tenant doesn't exist.
      await expect(
        main(
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
        main(
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
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 6: Summary-only AuditLog (M-2) + operator attribution (B2) ─────────

  it("M-2 + B2: exactly 1 AuditLog row per --apply run with operator userId set", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      const dates = ["2026-06-01", "2026-06-15", "2026-07-01", "2026-07-15", "2026-08-03"];
      for (const d of dates) {
        await seedAbsenceVS({ employeeId, dateISO: d });
      }

      await main(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );

      const auditRows = await app.prisma.auditLog.findMany({
        where: { action: "WORK_EVENT_MIGRATION_V19", entityId: tenantId },
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
        createdCount: expect.any(Number),
        skipped: expect.any(Number),
        allowNonAzubiLegacy: expect.any(Boolean),
        nonAzubiLegacyCount: expect.any(Number),
        allowExistingWorkEvents: expect.any(Boolean),
        existingWorkEventCount: expect.any(Number),
        dataQualityIssues: expect.any(Object),
        durationMs: expect.any(Number),
      });
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 7: Dry-run does NOT mutate ─────────────────────────────────────────

  it("dry-run (default) prints summary, does NOT mutate DB", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      await seedAbsenceVS({ employeeId, dateISO: "2026-06-01" });
      await seedAbsenceVS({ employeeId, dateISO: "2026-06-15" });
      await seedAbsenceVS({ employeeId, dateISO: "2026-07-01" });

      const summary = await main(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId],
        app.prisma,
      );

      expect(summary.dryRun).toBe(true);
      expect(summary.sourceCount).toBe(3);
      expect(summary.flagFlipped).toBe(false);

      const weRows = await app.prisma.workEvent.findMany({ where: { employeeId } });
      expect(weRows).toHaveLength(0);

      const ab = await app.prisma.absence.findMany({
        where: { employeeId, type: AbsenceType.VOCATIONAL_SCHOOL, deletedAt: null },
      });
      expect(ab).toHaveLength(3);

      const tc = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      expect(tc?.workEventModelLive).toBe(false);

      const audit = await app.prisma.auditLog.findMany({
        where: { action: "WORK_EVENT_MIGRATION_V19", entityId: tenantId },
      });
      expect(audit).toHaveLength(0);
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 8: Cache invalidation after flag flip ──────────────────────────────

  it("invalidates getTenantWorkEventModelLive cache after flag flip", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      await seedAbsenceVS({ employeeId, dateISO: "2026-06-01" });

      // Pre-populate cache — should read false.
      const before = await getTenantWorkEventModelLive(app.prisma, tenantId);
      expect(before).toBe(false);

      await main(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );

      // After --apply, the cache MUST be invalidated so the new flag is observed.
      const after = await getTenantWorkEventModelLive(app.prisma, tenantId);
      expect(after).toBe(true);
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 9: Generator pause/resume around tx (M-4) ──────────────────────────

  it("M-4: calls pauseTenantGeneration before tx + resumeTenantGeneration in finally", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    const pauseSpy = vi.spyOn(generator, "pauseTenantGeneration");
    const resumeSpy = vi.spyOn(generator, "resumeTenantGeneration");

    try {
      await seedAbsenceVS({ employeeId, dateISO: "2026-06-01" });

      await main(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );

      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(pauseSpy).toHaveBeenCalledWith(tenantId);
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(resumeSpy).toHaveBeenCalledWith(tenantId);

      // pause must happen before resume.
      const pauseOrder = pauseSpy.mock.invocationCallOrder[0];
      const resumeOrder = resumeSpy.mock.invocationCallOrder[0];
      expect(pauseOrder).toBeLessThan(resumeOrder);
    } finally {
      await cleanupTenant(tenantId);
      pauseSpy.mockRestore();
      resumeSpy.mockRestore();
    }
  });

  // ── Test 10: Note preservation (B4) ─────────────────────────────────────────

  it("B4: preserves operator note byte-for-byte + appends migration marker", async () => {
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
      const ab2 = await seedAbsenceVS({
        employeeId,
        dateISO: "2026-06-15",
        note: null,
      });

      const summary = await main(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );

      const runId = summary.runId;
      expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      const after1 = await app.prisma.absence.findUnique({ where: { id: ab1.id } });
      expect(after1!.note).toBe(`${operatorNote}\n[Migrated to WorkEvent. Run: ${runId}]`);

      const after2 = await app.prisma.absence.findUnique({ where: { id: ab2.id } });
      expect(after2!.note).toBe(`[Migrated to WorkEvent. Run: ${runId}]`);
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 11: Block-week minute parity (B1 fix) ──────────────────────────────

  it("B1: sum of WorkEvent.workedMinutes for a 5-day block week equals vocationalSchoolBlockMinutesPerWeek", async () => {
    // B1 regression guard: precompute snapshot reads Absence count BEFORE any
    // soft-delete. If the script regressed to per-row bsMin resolution inside
    // the tx loop, this assertion would fail with a value < 2400 because
    // countBsDaysInIsoWeek would see a shrinking live-Absence set after each
    // iteration's soft-delete.
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
      vocationalSchoolBlockMinutesPerWeek: 2400,
      vocationalSchoolMinutesPerDay: 480,
    });

    try {
      // Mon-Fri of ISO week 24 / 2026 (June 8 = Mon).
      const blockDates = ["2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12"];
      for (const d of blockDates) {
        await seedAbsenceVS({ employeeId, dateISO: d });
      }

      const summary = await main(
        ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
        app.prisma,
      );

      expect(summary.createdCount).toBe(5);

      const weRows = await app.prisma.workEvent.findMany({
        where: { employeeId, type: WorkEventType.VOCATIONAL_SCHOOL, deletedAt: null },
      });
      expect(weRows).toHaveLength(5);
      const sumWorked = weRows.reduce((acc, r) => acc + r.workedMinutes, 0);
      expect(sumWorked).toBe(2400);
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 12: Missing operator user (B2) ─────────────────────────────────────

  it("B2: throws German error when --operator-user-id is missing", async () => {
    const { tenantId, employeeId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      await seedAbsenceVS({ employeeId, dateISO: "2026-06-01" });

      await expect(
        main(["--tenant-id", tenantId, "--apply"], app.prisma),
      ).rejects.toThrow(/Operator-Auswahl erforderlich.*--operator-user-id/);

      const tc = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      expect(tc?.workEventModelLive).toBe(false);
      const we = await app.prisma.workEvent.findMany({ where: { employeeId } });
      expect(we).toHaveLength(0);
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  // ── Test 13: P2002 on legacyAbsenceId (W7) ──────────────────────────────────

  it("W7: rethrows P2002 on non-matching target (legacyAbsenceId); tx rolls back; flag stays false", async () => {
    const { tenantId, employeeId, operatorUserId } = await seedTenantAndEmployee({
      classification: EmployeeClassification.AZUBI,
    });

    try {
      const ab = await seedAbsenceVS({ employeeId, dateISO: "2026-06-08" });

      // Pre-insert a WorkEvent on a DIFFERENT date with the SAME legacyAbsenceId
      // we'll try to migrate — triggers P2002 on the `legacyAbsenceId` UNIQUE
      // constraint (NOT on @@unique[employeeId, date, type]). Pre-flight checks
      // for `legacyAbsenceId IS NULL`; since we SET it to ab.id, that pre-flight
      // does NOT halt.
      await app.prisma.workEvent.create({
        data: {
          employeeId,
          type: WorkEventType.VOCATIONAL_SCHOOL,
          date: new Date("2026-05-01T00:00:00Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
          legacyAbsenceId: ab.id,
        },
      });

      await expect(
        main(
          ["--tenant-id", tenantId, "--operator-user-id", operatorUserId, "--apply"],
          app.prisma,
        ),
      ).rejects.toThrow();

      const tc = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      expect(tc?.workEventModelLive).toBe(false); // tx rolled back

      // Absence should NOT be soft-deleted (rollback).
      const abAfter = await app.prisma.absence.findUnique({ where: { id: ab.id } });
      expect(abAfter?.deletedAt).toBeNull();
    } finally {
      await cleanupTenant(tenantId);
    }
  });
});

// Avoid unused warning for the MigrationSummary type when not directly referenced.
const _migrationSummaryType: MigrationSummary | null = null;
void _migrationSummaryType;
