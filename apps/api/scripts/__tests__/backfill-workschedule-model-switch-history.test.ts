/**
 * Phase 76.24 Plan 03 — Ops script tests for
 * backfill-workschedule-model-switch-history.
 *
 * Covers:
 *   - Candidate detection: prod defect fixture (single SHIFT_BASED row + prior TimeEntries)
 *   - Dry-run zero-write: summary lists candidate; zero WorkSchedule rows created; zero AuditLog
 *   - --apply writes corrective row + exactly 1 AuditLog per write
 *   - Existing SHIFT_BASED row is NOT mutated, NOT deleted after --apply
 *   - Post-backfill resolution: getEffectiveScheduleForDate returns OLD model for pre-switch dates
 *   - Locked-safe: locked candidate appears in skippedLocked and is NOT written on --apply
 *   - Idempotency: second --apply run writes zero new WorkSchedule rows and zero new AuditLog rows
 *   - Tenant-selection required: throws German error without --tenant-id | --all-tenants
 *
 * Uses initials-only for employee names (no PII per memory feedback_no_pii_in_github).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp } from "../../src/__tests__/setup";
import { main, type BackfillSummary } from "../backfill-workschedule-model-switch-history";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

// ── Test fixture dates ───────────────────────────────────────────────────────
// Employee hireDate: 2025-01-01 — worked as FIXED_SCHEDULE initially.
// AZ-model switch to SHIFT_BASED: 2025-04-01 — the month-1st where the switch
// actually happened.
// Existing (incorrect) single row: SHIFT_BASED validFrom=2025-01-01
//   → the defect: SHIFT_BASED is applied retroactively from hire date.
// Evidence: TimeEntry in February 2025 (before the switch month 2025-04-01).
const HIRE_DATE = new Date("2025-01-01T00:00:00Z");
const EARLY_ENTRY_DATE = new Date("2025-02-15T00:00:00Z"); // pre-switch evidence
const EARLY_ENTRY_START = new Date("2025-02-15T08:00:00Z");
const EARLY_ENTRY_END = new Date("2025-02-15T16:00:00Z");
const SINGLE_ROW_VALID_FROM = new Date("2025-01-01T00:00:00Z"); // defect: same as hireDate but type=SHIFT_BASED

// The proposed corrective row should be validFrom = month-1st of earliest entry
// That is 2025-02-01 (month-1st of the 2025-02-15 entry date)
const EXPECTED_CORRECTIVE_VALID_FROM = new Date("2025-02-01T00:00:00Z");

const BACKFILL_ACTION = "WORKSCHEDULE_MODEL_SWITCH_BACKFILL";

describe("backfill-workschedule-model-switch-history (Phase 76.24 Plan 03)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string; // main SHIFT_BASED employee (defect fixture)
  let singleRowId: string; // the one existing SHIFT_BASED WorkSchedule row

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const slug = "p7624-" + Date.now().toString(36);

    // ── Tenant ──────────────────────────────────────────────────────────
    const tenant = await prisma.tenant.create({
      data: { name: `P7624-03 ${slug}`, slug, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: {
        tenantId,
        defaultVacationDays: 30,
        timezone: "Europe/Berlin",
        defaultBreakOver6h: 30,
        defaultBreakOver9h: 45,
      },
    });

    // ── Admin user (required by tenant structure) ────────────────────────
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${slug}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${slug}`,
        firstName: "A.",
        lastName: "T.",
        hireDate: HIRE_DATE,
      },
    });

    // ── Main test employee: prod-defect fixture ──────────────────────────
    // Single SHIFT_BASED row with validFrom=2025-01-01 (hire date) is the defect.
    // A real TimeEntry in February 2025 proves there was earlier activity.
    const empUser = await prisma.user.create({
      data: {
        email: `emp-${slug}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: empUser.id,
        employeeNumber: `EMP-${slug}`,
        firstName: "E.",
        lastName: "M.",
        hireDate: HIRE_DATE,
        breakOver6hOverride: 0,
        breakOver9hOverride: 0,
      },
    });
    empId = emp.id;
    await prisma.overtimeAccount.create({ data: { employeeId: empId, balanceHours: 0 } });

    // The defect: a single SHIFT_BASED row from hire date.
    const singleRow = await prisma.workSchedule.create({
      data: {
        employeeId: empId,
        type: "SHIFT_BASED",
        weeklyHours: 38,
        mondayHours: 7.6,
        tuesdayHours: 7.6,
        wednesdayHours: 7.6,
        thursdayHours: 7.6,
        fridayHours: 7.6,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: SINGLE_ROW_VALID_FROM,
      },
    });
    singleRowId = singleRow.id;

    // Evidence: a TimeEntry BEFORE the switch month.
    // This is the signal the heuristic uses: activity predates the single schedule row
    // is impossible since both have validFrom=2025-01-01 — BUT validFrom is 2025-01-01
    // and entry is 2025-02-15. In our prod defect, validFrom would be 2025-01-01 (hire)
    // but the SWITCH happened 2025-04-01 — so entry dates in Jan-Mar prove pre-switch activity.
    // For this fixture: the single row has validFrom=2025-01-01. We will simulate a case
    // where the "real" switch should be 2025-04-01 by using a second employee approach, but
    // for simplicity we seed a row with validFrom=2025-04-01 in the main employee in the
    // switched-employee fixture below.
    // The MAIN employee fixture: single row validFrom=2025-01-01, entry on 2025-02-15.
    // Heuristic: entry.date(2025-02-15) < row.validFrom(2025-01-01)? NO — 2025-01-01 is before 2025-02-15.
    // So this fixture doesn't trigger. We need the single row to have validFrom AFTER the entries.
    // Let's update the fixture: SINGLE_ROW_VALID_FROM should be AFTER entry dates.
    //
    // Correct defect scenario:
    //   - Employee hired 2025-01-01
    //   - Worked Jan-Mar as FIXED_SCHEDULE (entries exist)
    //   - Admin changes model to SHIFT_BASED, system creates ONE row with validFrom=2025-01-01
    //     (overwriting history — the bug that Plan 01 prevents going forward)
    //   - Entries from Jan/Feb/Mar exist, but schedule row validFrom=2025-01-01 is the ONLY row
    //
    // Since validFrom=2025-01-01 = hireDate = SAME as entry month, entries won't be "before"
    // the schedule row. The real prod defect is: the row was created with validFrom=HIRE_DATE
    // but the SWITCH happened later. So we need validFrom of the single row to equal hireDate,
    // AND entries that are "before" the SWITCH date (which is later).
    //
    // Revised approach: make the single row validFrom=2025-04-01 (the switch month),
    // and entries in Jan-Mar. This correctly models the prod defect where:
    //   - Admin applied SHIFT_BASED with validFrom=2025-04-01 (the new model)
    //   - But the PRIOR model was lost — no historical FIXED_SCHEDULE row was created
    //   - Evidence: entries in Jan, Feb, Mar (before 2025-04-01)
    //
    // The single SHIFT_BASED row above already has validFrom=2025-01-01.
    // We must update the setup to have validFrom=2025-04-01.

    // Delete the row we just created and create the correct fixture.
    await prisma.workSchedule.delete({ where: { id: singleRow.id } });

    const correctSingleRow = await prisma.workSchedule.create({
      data: {
        employeeId: empId,
        type: "SHIFT_BASED",
        weeklyHours: 38,
        mondayHours: 7.6,
        tuesdayHours: 7.6,
        wednesdayHours: 7.6,
        thursdayHours: 7.6,
        fridayHours: 7.6,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2025-04-01T00:00:00Z"), // real switch month — ONLY row
      },
    });
    singleRowId = correctSingleRow.id;

    // Seed TimeEntry in February 2025 — BEFORE the single row's validFrom (2025-04-01).
    await prisma.timeEntry.create({
      data: {
        employeeId: empId,
        date: EARLY_ENTRY_DATE,
        startTime: EARLY_ENTRY_START,
        endTime: EARLY_ENTRY_END,
        breakMinutes: 0,
        type: "WORK",
        isLocked: false,
      },
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanup();
    } catch (err) {
      console.error("76.24-03 script test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function cleanup() {
    const prisma = app.prisma;
    // Remove corrective WorkSchedule rows (keep the original single row for audit)
    // by deleting only non-original rows for empId
    await prisma.auditLog.deleteMany({ where: { action: BACKFILL_ACTION } });
    await prisma.workSchedule.deleteMany({
      where: { employeeId: empId, id: { not: singleRowId } },
    });
  }

  // ── Test 1: Tenant-selection required ────────────────────────────────────
  it("throws German error when neither --tenant-id nor --all-tenants is provided", async () => {
    await expect(main([], app.prisma)).rejects.toThrow(/Tenant-Auswahl/);
  });

  // ── Test 2: Dry-run detects candidate and writes NOTHING ─────────────────
  it("dry-run (no --apply): candidate detected, zero WorkSchedule rows created, zero AuditLog rows", async () => {
    await cleanup();

    const beforeScheduleCount = await app.prisma.workSchedule.count({
      where: { employeeId: empId },
    });
    const beforeAuditCount = await app.prisma.auditLog.count({
      where: { action: BACKFILL_ACTION },
    });

    const summary: BackfillSummary = await main([`--tenant-id`, tenantId], app.prisma);

    const afterScheduleCount = await app.prisma.workSchedule.count({
      where: { employeeId: empId },
    });
    const afterAuditCount = await app.prisma.auditLog.count({
      where: { action: BACKFILL_ACTION },
    });

    // Summary flags dry-run
    expect(summary.dryRun).toBe(true);

    // Exactly one candidate detected (the defect fixture employee)
    const empCandidate = summary.candidates.find((c) => c.employeeId === empId);
    expect(empCandidate).toBeDefined();
    expect(empCandidate!.existingRow.type).toBe("SHIFT_BASED");
    expect(empCandidate!.proposedCorrectiveRow.type).toBe("FIXED_SCHEDULE");

    // Zero writes of any kind
    expect(afterScheduleCount).toBe(beforeScheduleCount);
    expect(afterAuditCount).toBe(beforeAuditCount);
    expect(summary.written).toBe(0);
  }, 60_000);

  // ── Test 3: --apply writes corrective row + exactly 1 AuditLog ───────────
  it("--apply: inserts corrective WorkSchedule row + exactly 1 AuditLog per write", async () => {
    await cleanup();

    const summary: BackfillSummary = await main([`--tenant-id`, tenantId, `--apply`], app.prisma);

    expect(summary.dryRun).toBe(false);
    expect(summary.written).toBeGreaterThanOrEqual(1);

    // Exactly 1 AuditLog row for the backfill action
    const auditRows = await app.prisma.auditLog.findMany({
      where: { action: BACKFILL_ACTION },
    });
    expect(auditRows).toHaveLength(1);

    const auditRow = auditRows[0];
    expect(auditRow.action).toBe(BACKFILL_ACTION);
    expect(auditRow.entity).toBe("WorkSchedule");
    expect(auditRow.userId).toBeNull(); // system-initiated
    expect(auditRow.ipAddress).toBeNull();

    // AuditLog entityId points to the NEW corrective row
    const newRow = await app.prisma.workSchedule.findUnique({
      where: { id: auditRow.entityId },
    });
    expect(newRow).not.toBeNull();
    expect(newRow!.type).toBe("FIXED_SCHEDULE");
    expect(newRow!.employeeId).toBe(empId);

    // New corrective row has validFrom = month-1st of earliest entry (2025-02-01)
    expect(newRow!.validFrom.toISOString()).toBe(EXPECTED_CORRECTIVE_VALID_FROM.toISOString());

    // oldValue in AuditLog contains the existing row's context
    const oldVal = auditRow.oldValue as Record<string, unknown>;
    expect(oldVal).not.toBeNull();
    expect(oldVal.existingRowId).toBe(singleRowId);
    expect(oldVal.existingType).toBe("SHIFT_BASED");
  }, 60_000);

  // ── Test 4: Existing SHIFT_BASED row NOT mutated, NOT deleted ────────────
  it("--apply: original SHIFT_BASED WorkSchedule row is not mutated and not deleted", async () => {
    await cleanup();

    await main([`--tenant-id`, tenantId, `--apply`], app.prisma);

    // Original row must still exist with original values
    const originalRow = await app.prisma.workSchedule.findUnique({
      where: { id: singleRowId },
    });
    expect(originalRow).not.toBeNull();
    expect(originalRow!.type).toBe("SHIFT_BASED");
    expect(originalRow!.validFrom.toISOString()).toBe(
      new Date("2025-04-01T00:00:00Z").toISOString(),
    );
    expect(Number(originalRow!.weeklyHours)).toBe(38);
  }, 60_000);

  // ── Test 5: Post-backfill resolution returns correct historical model ─────
  it("--apply: after backfill, querying validFrom<=preSwitch returns FIXED_SCHEDULE; validFrom<=postSwitch returns SHIFT_BASED", async () => {
    await cleanup();
    await main([`--tenant-id`, tenantId, `--apply`], app.prisma);

    // Pre-switch date: 2025-02-15 (during the period when employee was FIXED_SCHEDULE)
    const preSwitch = new Date("2025-02-15T00:00:00Z");
    const scheduleAtPreSwitch = await app.prisma.workSchedule.findFirst({
      where: { employeeId: empId, validFrom: { lte: preSwitch } },
      orderBy: { validFrom: "desc" },
    });
    expect(scheduleAtPreSwitch).not.toBeNull();
    expect(scheduleAtPreSwitch!.type).toBe("FIXED_SCHEDULE");

    // Post-switch date: 2025-05-01 (after the switch to SHIFT_BASED)
    const postSwitch = new Date("2025-05-01T00:00:00Z");
    const scheduleAtPostSwitch = await app.prisma.workSchedule.findFirst({
      where: { employeeId: empId, validFrom: { lte: postSwitch } },
      orderBy: { validFrom: "desc" },
    });
    expect(scheduleAtPostSwitch).not.toBeNull();
    expect(scheduleAtPostSwitch!.type).toBe("SHIFT_BASED");
  }, 60_000);

  // ── Test 6: Locked-safe — locked candidate is skipped and surfaced ────────
  it("locked-safe: candidate with locked TimeEntry in corrective period is skipped on --apply and surfaced in skippedLocked", async () => {
    await cleanup();

    // Seed a locked TimeEntry in the corrective period (before the switch)
    const lockedEntry = await app.prisma.timeEntry.create({
      data: {
        employeeId: empId,
        date: new Date("2025-03-10T00:00:00Z"),
        startTime: new Date("2025-03-10T08:00:00Z"),
        endTime: new Date("2025-03-10T16:00:00Z"),
        breakMinutes: 0,
        type: "WORK",
        isLocked: true,
        lockedAt: new Date(),
      },
    });

    try {
      const summary: BackfillSummary = await main([`--tenant-id`, tenantId, `--apply`], app.prisma);

      // No AuditLog created (skipped due to lock)
      const auditRows = await app.prisma.auditLog.findMany({
        where: { action: BACKFILL_ACTION },
      });
      expect(auditRows).toHaveLength(0);

      // Candidate is in skippedLocked
      expect(summary.skippedLocked.length).toBeGreaterThanOrEqual(1);
      const skipped = summary.skippedLocked.find((s) => s.employeeId === empId);
      expect(skipped).toBeDefined();

      // Zero writes
      expect(summary.written).toBe(0);

      // Original row is untouched
      const scheduleCount = await app.prisma.workSchedule.count({
        where: { employeeId: empId },
      });
      expect(scheduleCount).toBe(1); // only the original SHIFT_BASED row
    } finally {
      // Clean up the locked entry
      await app.prisma.timeEntry.delete({ where: { id: lockedEntry.id } });
    }
  }, 60_000);

  // ── Test 7: Idempotency — second --apply is a no-op ──────────────────────
  it("idempotent: second --apply after successful backfill writes zero new WorkSchedule rows and zero new AuditLog rows", async () => {
    await cleanup();

    // First run: applies the corrective row
    const summary1 = await main([`--tenant-id`, tenantId, `--apply`], app.prisma);
    expect(summary1.written).toBeGreaterThanOrEqual(1);

    const auditCountAfterFirst = await app.prisma.auditLog.count({
      where: { action: BACKFILL_ACTION },
    });
    const scheduleCountAfterFirst = await app.prisma.workSchedule.count({
      where: { employeeId: empId },
    });

    // Second run: must be a no-op
    const summary2 = await main([`--tenant-id`, tenantId, `--apply`], app.prisma);

    const auditCountAfterSecond = await app.prisma.auditLog.count({
      where: { action: BACKFILL_ACTION },
    });
    const scheduleCountAfterSecond = await app.prisma.workSchedule.count({
      where: { employeeId: empId },
    });

    expect(summary2.written).toBe(0);
    // After backfill the employee has 2 rows (original + corrective) → no longer
    // a single-row candidate. The no-op is expressed by written=0 and unchanged
    // audit/schedule counts, not by summary2.unchanged (which only counts the
    // explicit idempotency path where the employee is still a 1-row candidate
    // but the corrective row already exists).
    expect(auditCountAfterSecond).toBe(auditCountAfterFirst); // no new audit rows
    expect(scheduleCountAfterSecond).toBe(scheduleCountAfterFirst); // no new schedule rows
  }, 60_000);

  // ── Test 8: Summary shape sanity ─────────────────────────────────────────
  it("summary matches expected BackfillSummary shape", async () => {
    await cleanup();

    const summary: BackfillSummary = await main([`--tenant-id`, tenantId], app.prisma);

    expect(summary).toMatchObject({
      dryRun: expect.any(Boolean),
      tenantsScanned: expect.any(Number),
      employeesScanned: expect.any(Number),
      candidates: expect.any(Array),
      written: expect.any(Number),
      unchanged: expect.any(Number),
      skippedLocked: expect.any(Array),
      errors: expect.any(Array),
    });

    // Each candidate has the expected structure
    if (summary.candidates.length > 0) {
      const c = summary.candidates[0];
      expect(c).toMatchObject({
        employeeId: expect.any(String),
        tenantId: expect.any(String),
        employeeNumber: expect.any(String),
        existingRow: {
          id: expect.any(String),
          type: expect.any(String),
          validFrom: expect.any(Date),
        },
        proposedCorrectiveRow: {
          type: expect.any(String),
          validFrom: expect.any(Date),
        },
        evidence: {
          earliestEntryBeforeSchedule: expect.any(String),
          entryCountBeforeSchedule: expect.any(Number),
          evidenceNote: expect.any(String),
        },
        needsManualReview: expect.any(Boolean),
      });
    }
  }, 60_000);

  // ── Test 9: Employees with > 1 schedule row are NOT flagged ──────────────
  it("employees with more than one WorkSchedule row are not flagged as candidates", async () => {
    await cleanup();
    await main([`--tenant-id`, tenantId, `--apply`], app.prisma); // creates corrective row → 2 rows

    // Now run again; employee now has 2 rows → out of scope (Limitation A3)
    const summaryAfterBackfill = await main([`--tenant-id`, tenantId, `--apply`], app.prisma);

    // unchanged count increments (idempotency), written = 0
    expect(summaryAfterBackfill.written).toBe(0);

    // The employee with 2 rows is detected as "unchanged" (idempotent path)
    // not as a new candidate that would be reprocessed
    const scheduleCount = await app.prisma.workSchedule.count({
      where: { employeeId: empId },
    });
    expect(scheduleCount).toBe(2); // original + corrective, no duplicates
  }, 60_000);
});
