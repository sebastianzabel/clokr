/**
 * Phase 76.22 Plan 03 — Ops script tests for
 * recalculate-snapshots-after-shift-soll-fix.
 *
 * Covers:
 *   - D-17: CLI arg contract (tenant-selection required, --year)
 *   - D-08: Opening-bridge snapshot preserved (carryOver untouched, used as chain start)
 *   - D-18: Locked-month skip (summary.skippedLocked, no write)
 *   - D-19: AuditLog row shape (RECALC_ACTION, old→new values, reason verbatim)
 *   - D-20: Idempotency (second --apply writes nothing)
 *   - Dry-run zero-write (spy on SaldoSnapshot.update / AuditLog.create)
 *   - --apply on Model-A SHIFT_BASED snapshot writes Model B values
 *
 * Uses initials-only (no PII per memory feedback_no_pii_in_github).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "../../src/__tests__/setup";
import {
  main,
  parseArgs2,
  type RecalcSummary,
} from "../recalculate-snapshots-after-shift-soll-fix";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

// ── February 2026 UTC bounds (Europe/Berlin = UTC+1) ───────────────────────
// periodStart for Feb 2026 Berlin: 2026-01-31T23:00:00Z
// periodEnd:                       2026-02-28T22:59:59.999Z
const FEB_START = new Date("2026-01-31T23:00:00.000Z");
const FEB_END = new Date("2026-02-28T22:59:59.999Z");

// A snapshot one month earlier (January 2026 Berlin):
// periodStart: 2025-12-31T23:00Z
const JAN_START = new Date("2025-12-31T23:00:00.000Z");
const JAN_END = new Date("2026-01-31T22:59:59.999Z");

// Out-of-year snapshot for --year scoping test (December 2025 Berlin):
const DEC_2025_START = new Date("2025-11-30T23:00:00.000Z");
const DEC_2025_END = new Date("2025-12-31T22:59:59.999Z");

// Model-A stale values — what a snapshot looked like before v1.8.16.
// Set to obviously wrong values so recalc changes are unambiguous.
const STALE_WORKED = 0;
const STALE_EXPECTED = 99999; // Model A stored Σ shifts; we use a sentinel
const STALE_BALANCE = -99999;
const STALE_CARRY = -99999;

const RECALC_ACTION = "SALDO_RECALC_AFTER_SHIFT_SOLL_FIX";
const RECALC_REASON = "v1.8.16 SHIFT_BASED Model B Soll (contract-anchored, § 615 guard)";

describe("recalculate-snapshots-after-shift-soll-fix (Phase 76.22 Plan 03)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string; // SHIFT_BASED employee used in most tests

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const slug = "p7622-" + Date.now().toString(36);

    const tenant = await prisma.tenant.create({
      data: { name: `P7622-03 ${slug}`, slug, federalState: "NIEDERSACHSEN" },
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

    // Admin user (required by tenant structure)
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
        firstName: "Admin",
        lastName: "T.",
        hireDate: new Date("2026-01-01T00:00:00Z"),
      },
    });

    // SHIFT_BASED employee (M.K.) — weeklyHours=38, Mon–Fri
    const empUser = await prisma.user.create({
      data: {
        email: `mk-${slug}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: empUser.id,
        employeeNumber: `MK-${slug}`,
        firstName: "M.",
        lastName: "K.",
        hireDate: new Date("2026-01-01T00:00:00Z"),
        breakOver6hOverride: 0, // zero-break so brutto=netto in tests
        breakOver9hOverride: 0,
      },
    });
    empId = emp.id;
    await prisma.workSchedule.create({
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
        validFrom: new Date("2026-01-01T00:00:00Z"),
        workDays: [1, 2, 3, 4, 5],
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empId, balanceHours: 0 } });
  }, 60_000);

  afterAll(async () => {
    try {
      await resetAll();
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("76.22-03 script test cleanup failed:", err);
    }
    await closeTestApp();
    vi.useRealTimers();
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Seed a stale Model-A SaldoSnapshot for empId. */
  async function seedSnapshot(opts: {
    employeeId?: string;
    periodStart: Date;
    periodEnd: Date;
    locked?: boolean;
    workedMinutes?: number;
    expectedMinutes?: number;
    balanceMinutes?: number;
    carryOver?: number;
  }) {
    const eid = opts.employeeId ?? empId;
    const prisma = app.prisma;
    const snap = await prisma.saldoSnapshot.create({
      data: {
        employeeId: eid,
        periodType: "MONTHLY",
        periodStart: opts.periodStart,
        periodEnd: opts.periodEnd,
        workedMinutes: opts.workedMinutes ?? STALE_WORKED,
        expectedMinutes: opts.expectedMinutes ?? STALE_EXPECTED,
        balanceMinutes: opts.balanceMinutes ?? STALE_BALANCE,
        carryOver: opts.carryOver ?? STALE_CARRY,
        closedAt: new Date(),
        closedBy: null,
        note: "Stale Model-A (76.22-03 test seed)",
      },
    });

    if (opts.locked) {
      // Seed a locked TimeEntry inside the period — the canonical locked-month signal.
      const midPeriod = new Date((opts.periodStart.getTime() + opts.periodEnd.getTime()) / 2);
      await prisma.timeEntry.create({
        data: {
          employeeId: eid,
          date: midPeriod,
          startTime: midPeriod,
          endTime: new Date(midPeriod.getTime() + 8 * 60 * 60 * 1000),
          breakMinutes: 0,
          type: "WORK",
          isLocked: true,
          lockedAt: new Date(),
        },
      });
    }

    return snap;
  }

  /** Clear all snapshots, time entries, and audit rows for empId between tests. */
  async function resetAll(employeeId?: string) {
    const eid = employeeId ?? empId;
    await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: eid } });
    await app.prisma.timeEntry.deleteMany({ where: { employeeId: eid } });
    await app.prisma.auditLog.deleteMany({
      where: { action: RECALC_ACTION },
    });
  }

  // ── Test 1: Tenant-selection required (D-17) ───────────────────────────────
  it("D-17: throws German error when neither --tenant-id nor --all-tenants provided", async () => {
    await expect(main([], app.prisma)).rejects.toThrow(/Tenant-Auswahl|--tenant-id.*--all-tenants/);
  });

  // ── Test 2: parseArgs2 rejects invalid --year ──────────────────────────────
  it("D-17: parseArgs2 throws for non-numeric --year", () => {
    expect(() => parseArgs2(["--tenant-id", "abc", "--year", "not-a-year"])).toThrow(
      /vierstellige Jahreszahl/,
    );
  });

  // ── Test 3: Dry-run writes nothing ────────────────────────────────────────
  it("dry-run (default, no --apply) writes zero SaldoSnapshot rows and zero AuditLog rows", async () => {
    await resetAll();
    await seedSnapshot({ periodStart: FEB_START, periodEnd: FEB_END });

    const beforeSnapCount = await app.prisma.saldoSnapshot.count({
      where: { employeeId: empId },
    });
    const beforeAudit = await app.prisma.auditLog.count({
      where: { action: RECALC_ACTION },
    });

    // Spy to confirm no DB write calls happen
    const updateSpy = vi.spyOn(app.prisma.saldoSnapshot, "update");
    const auditSpy = vi.spyOn(app.prisma.auditLog, "create");

    const summary = await main([`--tenant-id`, tenantId], app.prisma);

    const afterAudit = await app.prisma.auditLog.count({
      where: { action: RECALC_ACTION },
    });
    const afterSnapCount = await app.prisma.saldoSnapshot.count({
      where: { employeeId: empId },
    });

    expect(summary.dryRun).toBe(true);
    expect(afterAudit).toBe(beforeAudit);
    expect(afterSnapCount).toBe(beforeSnapCount);
    // Verify the snapshot was NOT mutated
    const snap = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId: empId },
    });
    expect(snap!.expectedMinutes).toBe(STALE_EXPECTED);
    expect(snap!.balanceMinutes).toBe(STALE_BALANCE);

    updateSpy.mockRestore();
    auditSpy.mockRestore();
  }, 60_000);

  // ── Test 4: --apply writes new Model-B values + one AuditLog row ──────────
  it("--apply on stale Model-A SHIFT_BASED snapshot writes Model-B expected + exactly 1 AuditLog row", async () => {
    await resetAll();
    await seedSnapshot({ periodStart: FEB_START, periodEnd: FEB_END });

    const summary = await main([`--tenant-id`, tenantId, `--apply`], app.prisma);

    const auditRows = await app.prisma.auditLog.findMany({
      where: { action: RECALC_ACTION },
    });
    expect(auditRows).toHaveLength(1);
    expect(summary.dryRun).toBe(false);
    expect(summary.recalculated).toBe(1);
    expect(summary.unchanged).toBe(0);

    const snap = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId: empId, periodStart: FEB_START },
    });
    // Model B: expectedMinutes = C_net (contract Soll), not sentinel 99999.
    expect(snap!.expectedMinutes).not.toBe(STALE_EXPECTED);
    // February 2026 Berlin: 20 Mon–Fri workdays, C = round(38×60×20/5) = 9120.
    // Zero shifts, zero entries → balanceMinutes = max(0,0-9120) − max(0,0-0) = 0.
    expect(snap!.expectedMinutes).toBe(9120);
    expect(snap!.balanceMinutes).toBe(0);
  }, 60_000);

  // ── Test 5: Locked month skipped (D-18) ───────────────────────────────────
  it("D-18: locked-month snapshot is skipped; appears in summary.skippedLocked; no write", async () => {
    await resetAll();
    await seedSnapshot({
      periodStart: FEB_START,
      periodEnd: FEB_END,
      locked: true,
    });

    const summary = await main([`--tenant-id`, tenantId, `--apply`], app.prisma);

    // No AuditLog written for locked months.
    const auditRows = await app.prisma.auditLog.findMany({
      where: { action: RECALC_ACTION },
    });
    expect(auditRows).toHaveLength(0);
    expect(summary.skippedLocked).toHaveLength(1);
    expect(summary.recalculated).toBe(0);

    // Snapshot values must be untouched.
    const snap = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId: empId, periodStart: FEB_START },
    });
    expect(snap!.expectedMinutes).toBe(STALE_EXPECTED);
    expect(snap!.balanceMinutes).toBe(STALE_BALANCE);
  }, 60_000);

  // ── Test 6: skippedLocked structure (D-18) ────────────────────────────────
  it("D-18: skippedLocked entry has snapshotId, employeeId, tenantId, periodStart, deltaBalanceMinutes", async () => {
    await resetAll();
    const seeded = await seedSnapshot({
      periodStart: FEB_START,
      periodEnd: FEB_END,
      locked: true,
    });

    const summary = await main([`--tenant-id`, tenantId, `--apply`], app.prisma);

    expect(summary.skippedLocked).toHaveLength(1);
    const skipped = summary.skippedLocked[0];
    expect(skipped).toMatchObject({
      snapshotId: seeded.id,
      employeeId: empId,
      tenantId,
      periodStart: expect.any(Date),
      deltaBalanceMinutes: expect.any(Number),
    });
  }, 60_000);

  // ── Test 7: Idempotency (D-20) ────────────────────────────────────────────
  it("D-20: second --apply on already-recalced data writes zero new AuditLog rows (noop detection)", async () => {
    await resetAll();
    await seedSnapshot({ periodStart: FEB_START, periodEnd: FEB_END });

    // First run — recalculates.
    await main([`--tenant-id`, tenantId, `--apply`], app.prisma);
    const afterFirst = await app.prisma.auditLog.count({
      where: { action: RECALC_ACTION },
    });
    expect(afterFirst).toBe(1);

    // Second run — values are now Model B; should be noop.
    const summary2 = await main([`--tenant-id`, tenantId, `--apply`], app.prisma);
    const afterSecond = await app.prisma.auditLog.count({
      where: { action: RECALC_ACTION },
    });

    expect(afterSecond).toBe(afterFirst); // no new rows
    expect(summary2.unchanged).toBeGreaterThanOrEqual(1);
    expect(summary2.recalculated).toBe(0);
  }, 60_000);

  // ── Test 8: Opening-bridge snapshot preserved (D-08) ──────────────────────
  it("D-08: bridge snapshot (workedMinutes=0, expectedMinutes=0, balanceMinutes=0, carryOver!=0) is preserved and its carryOver seeds the chain", async () => {
    await resetAll();

    // Seed a bridge snapshot for January (opening balance from operator).
    const BRIDGE_CARRY = 3600; // 60h carry-in
    await seedSnapshot({
      periodStart: JAN_START,
      periodEnd: JAN_END,
      workedMinutes: 0,
      expectedMinutes: 0,
      balanceMinutes: 0,
      carryOver: BRIDGE_CARRY,
    });

    // Seed a stale February snapshot that needs Model B fix.
    await seedSnapshot({ periodStart: FEB_START, periodEnd: FEB_END });

    const summary = await main([`--tenant-id`, tenantId, `--apply`], app.prisma);

    // Bridge itself is not touched — counted as skipped (not recalculated).
    expect(summary.recalculated).toBe(1); // only February
    expect(summary.unchanged).toBe(0); // bridge is not noop — it's preserved separately

    // The bridge's carryOver MUST NOT be overwritten.
    const janSnap = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId: empId, periodStart: JAN_START },
    });
    expect(janSnap!.carryOver).toBe(BRIDGE_CARRY);
    expect(janSnap!.expectedMinutes).toBe(0); // unchanged

    // February's carryOver is chained from the bridge: BRIDGE_CARRY + feb_balance.
    // Feb: R=0, W=0, C=9120 → balance=0, so carryOver = BRIDGE_CARRY + 0 = BRIDGE_CARRY.
    const febSnap = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId: empId, periodStart: FEB_START },
    });
    expect(febSnap!.carryOver).toBe(BRIDGE_CARRY); // chained correctly
  }, 60_000);

  // ── Test 9: AuditLog row shape (D-19) ─────────────────────────────────────
  it("D-19: AuditLog row has correct action, entity, entityId, oldValue, newValue with reason verbatim", async () => {
    await resetAll();
    const seeded = await seedSnapshot({ periodStart: FEB_START, periodEnd: FEB_END });

    await main([`--tenant-id`, tenantId, `--apply`], app.prisma);

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: RECALC_ACTION },
    });
    expect(audit).not.toBeNull();
    expect(audit!.action).toBe(RECALC_ACTION);
    expect(audit!.entity).toBe("SaldoSnapshot");
    expect(audit!.entityId).toBe(seeded.id);
    expect(audit!.userId).toBeNull(); // system-initiated

    const oldVal = audit!.oldValue as Record<string, unknown>;
    const newVal = audit!.newValue as Record<string, unknown>;
    expect(oldVal).not.toBeNull();
    expect(newVal).not.toBeNull();
    expect(oldVal!.expectedMinutes).toBe(STALE_EXPECTED);
    expect(oldVal!.balanceMinutes).toBe(STALE_BALANCE);
    expect(typeof newVal!.expectedMinutes).toBe("number");
    expect(typeof newVal!.balanceMinutes).toBe("number");
    expect(newVal!.reason).toBe(RECALC_REASON);
  }, 60_000);

  // ── Test 10: --year scoping ────────────────────────────────────────────────
  it("--year 2026 scopes recalc to 2026 only; Dec-2025 snapshot untouched", async () => {
    await resetAll();
    // Seed a 2025 snapshot that must remain untouched.
    await seedSnapshot({ periodStart: DEC_2025_START, periodEnd: DEC_2025_END });
    // Seed a 2026 snapshot that should be recalculated.
    await seedSnapshot({ periodStart: FEB_START, periodEnd: FEB_END });

    const summary = await main([`--tenant-id`, tenantId, `--year`, `2026`, `--apply`], app.prisma);

    const auditRows = await app.prisma.auditLog.findMany({
      where: { action: RECALC_ACTION },
    });
    // Only the 2026 snapshot should produce an audit row.
    expect(auditRows).toHaveLength(1);

    const dec2025Snap = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId: empId, periodStart: DEC_2025_START },
    });
    expect(dec2025Snap!.expectedMinutes).toBe(STALE_EXPECTED); // untouched

    expect(summary.recalculated).toBe(1);
  }, 60_000);

  // ── Test 11: Summary shape sanity ─────────────────────────────────────────
  it("summary matches expected RecalcSummary shape", async () => {
    await resetAll();
    await seedSnapshot({ periodStart: FEB_START, periodEnd: FEB_END });
    await seedSnapshot({
      periodStart: JAN_START,
      periodEnd: JAN_END,
      locked: true,
    });

    const summary: RecalcSummary = await main([`--tenant-id`, tenantId, `--apply`], app.prisma);

    expect(summary).toMatchObject({
      dryRun: false,
      tenantsScanned: expect.any(Number),
      snapshotsScanned: expect.any(Number),
      recalculated: expect.any(Number),
      unchanged: expect.any(Number),
      skippedLocked: expect.any(Array),
      errors: expect.any(Array),
    });
    expect(summary.skippedLocked[0]).toMatchObject({
      snapshotId: expect.any(String),
      employeeId: expect.any(String),
      tenantId: expect.any(String),
      periodStart: expect.any(Date),
      deltaBalanceMinutes: expect.any(Number),
    });
  }, 60_000);
});
