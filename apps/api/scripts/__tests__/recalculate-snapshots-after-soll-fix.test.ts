/**
 * Phase 76.12 Plan 03 — Ops script tests for recalculate-snapshots-after-soll-fix.
 *
 * Covers D-17 (CLI arg contract), D-18 (locked-month skip), D-19 (AuditLog row
 * shape), D-20 (idempotency), and the --year scoping.
 *
 * Uses A.S. initials (no PII per memory feedback_no_pii_in_github).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "../../src/__tests__/setup";
import { main, type RecalcSummary } from "../recalculate-snapshots-after-soll-fix";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

describe("recalculate-snapshots-after-soll-fix (Phase 76.12 Plan 03)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let asEmpId: string;

  const HIRE_DATE = new Date("2026-04-01T00:00:00Z");
  const MAY_START = new Date("2026-04-30T22:00:00Z"); // May 1 00:00 Berlin = April 30 22:00 UTC
  const MAY_END = new Date("2026-05-31T21:59:59.999Z");
  const APR_START = new Date("2026-03-31T22:00:00Z");
  const APR_END = new Date("2026-04-30T21:59:59.999Z");
  const JAN_2025_START = new Date("2024-12-31T23:00:00Z");
  const JAN_2025_END = new Date("2025-01-31T22:59:59.999Z");

  // Old-formula stale values for seeded snapshots — recalc produces a different result.
  const STALE_EXPECTED = 99999;
  const STALE_BALANCE = -99999;
  const STALE_CARRY = -99999;
  const STALE_WORKED = 0;

  async function seedSnapshot(opts: {
    employeeId: string;
    periodStart: Date;
    periodEnd: Date;
    locked?: boolean;
  }) {
    const prisma = app.prisma;
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: opts.employeeId,
        periodType: "MONTHLY",
        periodStart: opts.periodStart,
        periodEnd: opts.periodEnd,
        workedMinutes: STALE_WORKED,
        expectedMinutes: STALE_EXPECTED,
        balanceMinutes: STALE_BALANCE,
        carryOver: STALE_CARRY,
        closedAt: new Date(),
        closedBy: null,
        note: "Stale (Phase 76.12 Plan 03 test seed)",
      },
    });
    if (opts.locked) {
      // Seed one locked TimeEntry inside the period — this is how the script
      // determines that the snapshot's month is locked (CLAUDE.md immutability
      // after lock — TimeEntry.isLocked flips on Monatsabschluss).
      // Place the TimeEntry safely INSIDE the period (avoid the @db.Date
      // boundary collision between periodEnd 23:59:59 of month N and a
      // periodStart at 22:00 UTC of month N+1 in Europe/Berlin).
      const midPeriod = new Date(
        (opts.periodStart.getTime() + opts.periodEnd.getTime()) / 2,
      );
      await prisma.timeEntry.create({
        data: {
          employeeId: opts.employeeId,
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
  }

  async function resetSnapshots(employeeId: string) {
    await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId } });
    await app.prisma.timeEntry.deleteMany({ where: { employeeId } });
    await app.prisma.auditLog.deleteMany({
      where: { entity: "SaldoSnapshot", entityId: { not: undefined } },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = "p03-" + Date.now().toString(36);

    const tenant = await prisma.tenant.create({
      data: { name: `P03 ${s}`, slug: `p03-${s}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: "Europe/Berlin" },
    });

    // Admin (required by tenant)
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "Admin",
        lastName: "T.",
        hireDate: HIRE_DATE,
      },
    });

    // A.S. employee — FLEXTIME, weeklyHours=38, tue/wed/thu/fri=9.5
    const asUser = await prisma.user.create({
      data: {
        email: `as-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const asEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: asUser.id,
        employeeNumber: `AS-${s}`,
        firstName: "A.",
        lastName: "S.",
        classification: "TEILZEIT",
        hireDate: HIRE_DATE,
      },
    });
    asEmpId = asEmp.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: asEmp.id,
        type: "FLEXTIME",
        weeklyHours: 38,
        mondayHours: 0,
        tuesdayHours: 9.5,
        wednesdayHours: 9.5,
        thursdayHours: 9.5,
        fridayHours: 9.5,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: HIRE_DATE,
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: asEmp.id, balanceHours: 0 } });
  });

  afterAll(async () => {
    try {
      const employees = await app.prisma.employee.findMany({
        where: { tenantId },
        select: { id: true },
      });
      const employeeIds = employees.map((e) => e.id);
      await app.prisma.saldoSnapshot.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await app.prisma.timeEntry.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await app.prisma.auditLog.deleteMany({
        where: {
          OR: [
            { action: "SALDO_RECALC_AFTER_SOLL_FIX" },
            { entity: "SaldoSnapshot", entityId: { in: employeeIds } },
          ],
        },
      });
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("76.12-03 test cleanup failed:", err);
    }
    await closeTestApp();
    vi.useRealTimers();
  });

  // ── Test 1: Tenant-Auswahl required (D-17) ──────────────────────────────
  it("D-17: errors with German message when neither --tenant-id nor --all-tenants is provided", async () => {
    await expect(main([], app.prisma)).rejects.toThrow(
      /Tenant-Auswahl|--tenant-id.*--all-tenants/,
    );
  });

  // ── Test 2: Dry-run writes nothing (D-17) ───────────────────────────────
  it("D-17: --dry-run (default) writes zero AuditLog rows and leaves snapshots unchanged", async () => {
    await resetSnapshots(asEmpId);
    await seedSnapshot({ employeeId: asEmpId, periodStart: MAY_START, periodEnd: MAY_END });

    const beforeAudit = await app.prisma.auditLog.count({
      where: { action: "SALDO_RECALC_AFTER_SOLL_FIX" },
    });

    const summary = await main([`--tenant-id`, tenantId], app.prisma);

    const afterAudit = await app.prisma.auditLog.count({
      where: { action: "SALDO_RECALC_AFTER_SOLL_FIX" },
    });
    const snap = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId: asEmpId },
    });

    expect(afterAudit).toBe(beforeAudit);
    expect(snap!.expectedMinutes).toBe(STALE_EXPECTED);
    expect(snap!.balanceMinutes).toBe(STALE_BALANCE);
    expect(summary.dryRun).toBe(true);
  });

  // ── Test 3: --apply writes audit log; locked snapshot skipped (D-18, D-19) ─
  it("D-18 + D-19: --apply writes exactly 1 AuditLog row per recalculated non-locked snapshot; locked snapshot is untouched", async () => {
    await resetSnapshots(asEmpId);
    // 1 non-locked snapshot (April) + 1 locked snapshot (May)
    await seedSnapshot({ employeeId: asEmpId, periodStart: APR_START, periodEnd: APR_END });
    await seedSnapshot({
      employeeId: asEmpId,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      locked: true,
    });

    const summary = await main([`--tenant-id`, tenantId, `--apply`], app.prisma);

    const auditRows = await app.prisma.auditLog.findMany({
      where: { action: "SALDO_RECALC_AFTER_SOLL_FIX" },
    });
    expect(auditRows).toHaveLength(1);

    // Locked May snapshot is untouched.
    const lockedSnap = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId: asEmpId, periodStart: MAY_START },
    });
    expect(lockedSnap!.expectedMinutes).toBe(STALE_EXPECTED);
    expect(lockedSnap!.balanceMinutes).toBe(STALE_BALANCE);

    // Non-locked April snapshot has been recalculated.
    const aprSnap = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId: asEmpId, periodStart: APR_START },
    });
    expect(aprSnap!.expectedMinutes).not.toBe(STALE_EXPECTED);

    expect(summary.dryRun).toBe(false);
    expect(summary.recalculated).toBe(1);
    expect(summary.skippedLocked).toHaveLength(1);
  });

  // ── Test 4: skippedLocked structure (D-18) ──────────────────────────────
  it("D-18: --apply lists locked snapshots in summary.skippedLocked with snapshotId + employeeId + deltaBalanceMinutes", async () => {
    await resetSnapshots(asEmpId);
    await seedSnapshot({
      employeeId: asEmpId,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      locked: true,
    });

    const summary = await main([`--tenant-id`, tenantId, `--apply`], app.prisma);

    expect(summary.skippedLocked).toHaveLength(1);
    const skipped = summary.skippedLocked[0];
    expect(skipped).toMatchObject({
      snapshotId: expect.any(String),
      employeeId: asEmpId,
      deltaBalanceMinutes: expect.any(Number),
    });
  });

  // ── Test 5: Idempotency (D-20) ──────────────────────────────────────────
  it("D-20: second --apply run on identical data writes zero new AuditLog rows (noop detection)", async () => {
    await resetSnapshots(asEmpId);
    await seedSnapshot({ employeeId: asEmpId, periodStart: APR_START, periodEnd: APR_END });

    await main([`--tenant-id`, tenantId, `--apply`], app.prisma);
    const afterFirst = await app.prisma.auditLog.count({
      where: { action: "SALDO_RECALC_AFTER_SOLL_FIX" },
    });

    await main([`--tenant-id`, tenantId, `--apply`], app.prisma);
    const afterSecond = await app.prisma.auditLog.count({
      where: { action: "SALDO_RECALC_AFTER_SOLL_FIX" },
    });

    expect(afterSecond).toBe(afterFirst);
  });

  // ── Test 6: --year scoping ──────────────────────────────────────────────
  it("--year YYYY scopes recalc to that calendar year only", async () => {
    await resetSnapshots(asEmpId);
    await seedSnapshot({ employeeId: asEmpId, periodStart: JAN_2025_START, periodEnd: JAN_2025_END });
    await seedSnapshot({ employeeId: asEmpId, periodStart: APR_START, periodEnd: APR_END });

    const summary = await main(
      [`--tenant-id`, tenantId, `--year`, `2026`, `--apply`],
      app.prisma,
    );

    // Only the 2026 snapshot should have been recalculated.
    const auditRows = await app.prisma.auditLog.findMany({
      where: { action: "SALDO_RECALC_AFTER_SOLL_FIX" },
    });
    expect(auditRows).toHaveLength(1);

    const jan2025Snap = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId: asEmpId, periodStart: JAN_2025_START },
    });
    // Untouched — outside the year scope.
    expect(jan2025Snap!.expectedMinutes).toBe(STALE_EXPECTED);

    expect(summary.recalculated).toBe(1);
  });

  // ── Test 7: AuditLog row shape per D-19 ─────────────────────────────────
  it("D-19: AuditLog row contains exact action, entity, entityId, oldValue.balanceMinutes, newValue.balanceMinutes, and reason verbatim", async () => {
    await resetSnapshots(asEmpId);
    await seedSnapshot({ employeeId: asEmpId, periodStart: APR_START, periodEnd: APR_END });
    const seeded = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId: asEmpId, periodStart: APR_START },
    });

    await main([`--tenant-id`, tenantId, `--apply`], app.prisma);

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "SALDO_RECALC_AFTER_SOLL_FIX" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.action).toBe("SALDO_RECALC_AFTER_SOLL_FIX");
    expect(audit!.entity).toBe("SaldoSnapshot");
    expect(audit!.entityId).toBe(seeded!.id);

    const oldValue = audit!.oldValue as Record<string, unknown> | null;
    const newValue = audit!.newValue as Record<string, unknown> | null;
    expect(oldValue).not.toBeNull();
    expect(newValue).not.toBeNull();
    expect(oldValue!.balanceMinutes).toBe(STALE_BALANCE);
    expect(typeof newValue!.balanceMinutes).toBe("number");
    expect(newValue!.reason).toBe("v1.8.4 Ø-Methode migration (BAG 9 AZR 406/17)");
  });

  // ── Test 8: summary shape sanity (toMatchObject for the array shape) ────
  it("summary shape: dryRun/tenantsScanned/snapshotsScanned/recalculated/unchanged/skippedLocked are present", async () => {
    await resetSnapshots(asEmpId);
    await seedSnapshot({ employeeId: asEmpId, periodStart: APR_START, periodEnd: APR_END });
    await seedSnapshot({
      employeeId: asEmpId,
      periodStart: MAY_START,
      periodEnd: MAY_END,
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
    });
    expect(summary.skippedLocked[0]).toMatchObject({
      snapshotId: expect.any(String),
      employeeId: expect.any(String),
      tenantId: expect.any(String),
      periodStart: expect.any(Date),
      deltaBalanceMinutes: expect.any(Number),
    });
  });
});
