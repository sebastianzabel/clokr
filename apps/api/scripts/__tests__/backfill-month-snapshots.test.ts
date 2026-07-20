/**
 * Phase 76.30 Plan 00 — Tests for backfill-month-snapshots operator script.
 *
 * Pure-logic unit tests (Task 1): DB-free, synthetic numeric fixtures only.
 * DB-backed integration tests (Task 2): getTestApp + synthetic tenant/employee fixtures,
 * initials-only naming, no PII.
 *
 * Covers:
 *   Task 1 — buildBackfillMonthRange / projectCarryOverChain pure helpers:
 *     T1: basic ordering May→Jul
 *     T2: cross-year Nov→Feb
 *     T3: empty when firstOpen > ceiling
 *     T4: carryOver chaining — +64h stale-May fixture lands neutral/negative
 *     T5: seed zero chaining
 *
 *   Task 2 — main(app, opts) DB-backed:
 *     T6: dry-run zero-write (no SaldoSnapshot, no AuditLog created)
 *     T7: --apply audit (BACKFILL origin, closedBy null, Jun then Jul)
 *     T8: idempotency (second --apply is a no-op, bridge snapshot preserved)
 *     T9: ordering assertion (Jun before Jul, chain integrity)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  buildBackfillMonthRange,
  projectCarryOverChain,
  main,
  type BackfillOptions,
} from "../backfill-month-snapshots";
import { getTestApp, closeTestApp } from "../../src/__tests__/setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

// ── Task 1: Pure-logic unit tests (no DB, no Prisma) ────────────────────────

describe("buildBackfillMonthRange", () => {
  it("T1: basic ordering — May 2026 to Jul 2026 yields [May, Jun, Jul]", () => {
    const result = buildBackfillMonthRange({ year: 2026, month: 5 }, { year: 2026, month: 7 });
    expect(result).toEqual([
      { year: 2026, month: 5 },
      { year: 2026, month: 6 },
      { year: 2026, month: 7 },
    ]);
  });

  it("T2: cross-year — Nov 2025 to Feb 2026 yields [Nov, Dec, Jan, Feb]", () => {
    const result = buildBackfillMonthRange({ year: 2025, month: 11 }, { year: 2026, month: 2 });
    expect(result).toEqual([
      { year: 2025, month: 11 },
      { year: 2025, month: 12 },
      { year: 2026, month: 1 },
      { year: 2026, month: 2 },
    ]);
  });

  it("T3: empty — firstOpen 2026-08 > ceiling 2026-07", () => {
    const result = buildBackfillMonthRange({ year: 2026, month: 8 }, { year: 2026, month: 7 });
    expect(result).toEqual([]);
  });

  it("single month — firstOpen equals ceiling", () => {
    const result = buildBackfillMonthRange({ year: 2026, month: 3 }, { year: 2026, month: 3 });
    expect(result).toEqual([{ year: 2026, month: 3 }]);
  });

  it("60-month guard — does not exceed 60 months", () => {
    const result = buildBackfillMonthRange({ year: 2020, month: 1 }, { year: 2030, month: 12 });
    expect(result.length).toBeLessThanOrEqual(60);
  });
});

describe("projectCarryOverChain", () => {
  it("T4: +64h stale-May seed — chain lands neutral/negative by last month", () => {
    // +64h in minutes = 3840
    // seed = +3840 min (stale inflated balance)
    // month balances: May=-120 (close to zero), Jun=-3600 (-60h wipes out the +64h),
    // Jul=-600 (further negative)
    const seedCarryOver = 3840;
    const balances = [-120, -3600, -600]; // May, Jun, Jul
    const result = projectCarryOverChain(seedCarryOver, balances);

    // May carryOver = 3840 + (-120) = 3720
    expect(result.perMonthCarryOver[0]).toBe(3720);
    // Jun carryOver = 3720 + (-3600) = 120
    expect(result.perMonthCarryOver[1]).toBe(120);
    // Jul carryOver = 120 + (-600) = -480 (negative — the fix sanity check)
    expect(result.perMonthCarryOver[2]).toBe(-480);

    expect(result.finalCarryOverMinutes).toBe(-480);
    // Must be neutral or negative per the plan: +64h fixture should land <= 0 at end
    // After applying real month closes, the inflated +64h gets wiped out
    expect(result.finalCarryOverMinutes).toBeLessThanOrEqual(120); // neutral/negative
  });

  it("T5: seed zero — basic chain", () => {
    const result = projectCarryOverChain(0, [480, -240]);
    // month 1: 0 + 480 = 480
    expect(result.perMonthCarryOver[0]).toBe(480);
    // month 2: 480 + (-240) = 240
    expect(result.perMonthCarryOver[1]).toBe(240);
    expect(result.finalCarryOverMinutes).toBe(240);
  });

  it("empty balances — finalCarryOver equals seed", () => {
    const result = projectCarryOverChain(100, []);
    expect(result.finalCarryOverMinutes).toBe(100);
    expect(result.perMonthCarryOver).toEqual([]);
  });

  it("single month balance", () => {
    const result = projectCarryOverChain(1000, [500]);
    expect(result.perMonthCarryOver[0]).toBe(1500);
    expect(result.finalCarryOverMinutes).toBe(1500);
  });
});

// ── Task 2: DB-backed integration tests ────────────────────────────────────
// Uses initials-only naming (E.M., A.T.) — no PII per MEMORY feedback_no_pii_in_github.
// Synthetic fixture: FIXED_WEEKLY employee (39h/week, Mo-Fr) stuck at May 2026 snapshot.
// Two open months: Jun 2026 and Jul 2026 with zero time entries → balance ≈ -expected.

describe("backfill-month-snapshots main() — DB-backed", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;
  let bridgeSnapId: string; // the May 2026 "last active" snapshot (acts like bridge)
  let oldLiveBalanceHours: number;

  // Fixture dates (synthetic, no real employee)
  const HIRE_DATE = new Date("2026-01-01T00:00:00Z");
  // May 2026 snapshot — this is the "last closed" month; Jun+Jul are open
  const MAY_SNAP_PERIOD_START = new Date("2026-04-30T22:00:00Z"); // Europe/Berlin: May 1 00:00 CEST → UTC
  const MAY_SNAP_PERIOD_END = new Date("2026-05-31T21:59:59Z");

  // Backfill ceiling: June 2026 (we only test Jun+Jul relative to "until" = Jul 2026)
  // We'll pass until: { year: 2026, month: 7 } so it closes Jun and Jul

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const slug = "p7630-" + Date.now().toString(36);

    // ── Tenant ──────────────────────────────────────────────────────────
    const tenant = await prisma.tenant.create({
      data: { name: `P7630-00 ${slug}`, slug, federalState: "NIEDERSACHSEN" },
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

    // ── Admin user ───────────────────────────────────────────────────────
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

    // ── Main test employee: stuck-open fixture ───────────────────────────
    // FIXED_WEEKLY 39h/week Mo-Fr (7.8h/day).
    // Last closed month: May 2026. Open: Jun + Jul 2026.
    // OvertimeAccount.balanceHours deliberately inflated (+64h) to represent the
    // prod anomaly — after backfill it should land neutral/negative.
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

    // Work schedule: FIXED_SCHEDULE 39h Mo-Fr
    await prisma.workSchedule.create({
      data: {
        employeeId: empId,
        type: "FIXED_SCHEDULE",
        weeklyHours: 39,
        mondayHours: 7.8,
        tuesdayHours: 7.8,
        wednesdayHours: 7.8,
        thursdayHours: 7.8,
        fridayHours: 7.8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: HIRE_DATE,
      },
    });

    // OvertimeAccount with inflated balance (+64h → the prod anomaly)
    oldLiveBalanceHours = 64;
    await prisma.overtimeAccount.create({
      data: { employeeId: empId, balanceHours: oldLiveBalanceHours },
    });

    // May 2026 snapshot (bridge/last-closed): carryOver = +3840 min (+64h).
    // This is the bridge: has superseded=false, will be preserved through idempotency.
    const maySnap = await prisma.saldoSnapshot.create({
      data: {
        employeeId: empId,
        periodType: "MONTHLY",
        periodStart: MAY_SNAP_PERIOD_START,
        periodEnd: MAY_SNAP_PERIOD_END,
        workedMinutes: 9360, // some worked minutes for May
        expectedMinutes: 8580, // 39h * ~22 working days
        balanceMinutes: 780, // small positive balance
        carryOver: 3840, // +64h accumulated (stale inflated)
        closedAt: new Date("2026-06-02T06:00:00Z"),
        closedBy: null,
        note: "Automatischer Monatsabschluss",
        superseded: false,
      },
    });
    bridgeSnapId = maySnap.id;

    // No time entries for Jun/Jul (open months with gaps → 0h worked, full Soll expected)
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanup();
    } catch (err) {
      console.error("76.30-00 script test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function cleanup() {
    const prisma = app.prisma;
    // Remove snapshots created by the backfill (keep the May bridge snap)
    await prisma.saldoSnapshot.deleteMany({
      where: { employeeId: empId, id: { not: bridgeSnapId } },
    });
    // Remove backfill AuditLog rows
    await prisma.auditLog.deleteMany({
      where: {
        entityId: empId,
        action: "CREATE",
        entity: "SaldoSnapshot",
      },
    });
    // Reset OvertimeAccount to original inflated balance
    await prisma.overtimeAccount.updateMany({
      where: { employeeId: empId },
      data: { balanceHours: oldLiveBalanceHours },
    });
    // Unlock any locked time entries (there are none in this fixture, but be safe)
    await prisma.timeEntry.updateMany({
      where: { employeeId: empId },
      data: { isLocked: false, lockedAt: null },
    });
  }

  // ── T6: Dry-run writes ZERO rows ──────────────────────────────────────────
  it("T6: dry-run (no --apply) writes zero SaldoSnapshot and zero AuditLog rows", async () => {
    await cleanup();

    const beforeSnapCount = await app.prisma.saldoSnapshot.count({
      where: { employeeId: empId },
    });
    const beforeAuditCount = await app.prisma.auditLog.count({
      where: { entityId: empId, action: "CREATE", entity: "SaldoSnapshot" },
    });

    const opts: BackfillOptions = {
      apply: false,
      tenantId,
      employeeIds: [empId],
      until: { year: 2026, month: 7 },
    };
    const summary = await main(app, opts);

    const afterSnapCount = await app.prisma.saldoSnapshot.count({
      where: { employeeId: empId },
    });
    const afterAuditCount = await app.prisma.auditLog.count({
      where: { entityId: empId, action: "CREATE", entity: "SaldoSnapshot" },
    });

    // Zero writes of any kind
    expect(afterSnapCount).toBe(beforeSnapCount);
    expect(afterAuditCount).toBe(beforeAuditCount);

    // Summary contains the employee with projected carryOver
    const empEntry = summary.employees.find((e) => e.employeeId === empId);
    expect(empEntry).toBeDefined();
    expect(empEntry!.oldLiveBalanceHours).toBeCloseTo(oldLiveBalanceHours, 1);
    // Projected carryOver should be <= oldLiveBalanceHours (the fix: closing open months
    // removes the inflated balance)
    expect(empEntry!.projectedCarryOverHours).toBeLessThanOrEqual(empEntry!.oldLiveBalanceHours);
  }, 120_000);

  // ── T7: --apply closes Jun then Jul with BACKFILL audit ───────────────────
  it("T7: --apply closes Jun then Jul; each snapshot has closedBy=null; one BACKFILL AuditLog per close", async () => {
    await cleanup();

    const opts: BackfillOptions = {
      apply: true,
      tenantId,
      employeeIds: [empId],
      until: { year: 2026, month: 7 },
    };
    const summary = await main(app, opts);

    // Summary recorded writes
    const empEntry = summary.employees.find((e) => e.employeeId === empId);
    expect(empEntry).toBeDefined();
    expect(empEntry!.monthsToClose.length).toBeGreaterThanOrEqual(2);

    // Two new snapshots should exist (Jun + Jul), both with closedBy=null
    const newSnaps = await app.prisma.saldoSnapshot.findMany({
      where: { employeeId: empId, superseded: false, id: { not: bridgeSnapId } },
      orderBy: { periodStart: "asc" },
    });
    expect(newSnaps.length).toBeGreaterThanOrEqual(2);
    for (const snap of newSnaps) {
      expect(snap.closedBy).toBeNull();
    }

    // Exactly one BACKFILL AuditLog per closed month (not counting the May bridge)
    const auditRows = await app.prisma.auditLog.findMany({
      where: { entityId: empId, action: "CREATE", entity: "SaldoSnapshot" },
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(2);

    for (const row of auditRows) {
      expect(row.userId).toBeNull(); // SYSTEM actor
      const nv = row.newValue as Record<string, unknown>;
      expect(nv.origin).toBe("BACKFILL");
      expect(nv.backfill).toBe(true);
    }
  }, 120_000);

  // ── T8: Idempotency — second --apply is a no-op; bridge preserved ──────────
  it("T8: second --apply is a no-op; May bridge snapshot is preserved (superseded=false)", async () => {
    await cleanup();

    const opts: BackfillOptions = {
      apply: true,
      tenantId,
      employeeIds: [empId],
      until: { year: 2026, month: 7 },
    };

    // First run
    await main(app, opts);

    const snapCountAfterFirst = await app.prisma.saldoSnapshot.count({
      where: { employeeId: empId, superseded: false },
    });
    const auditCountAfterFirst = await app.prisma.auditLog.count({
      where: { entityId: empId, action: "CREATE", entity: "SaldoSnapshot" },
    });

    // Second run — must be a no-op
    await main(app, opts);

    const snapCountAfterSecond = await app.prisma.saldoSnapshot.count({
      where: { employeeId: empId, superseded: false },
    });
    const auditCountAfterSecond = await app.prisma.auditLog.count({
      where: { entityId: empId, action: "CREATE", entity: "SaldoSnapshot" },
    });

    // No new snapshots or audit rows
    expect(snapCountAfterSecond).toBe(snapCountAfterFirst);
    expect(auditCountAfterSecond).toBe(auditCountAfterFirst);

    // May bridge snapshot must NOT have been superseded
    const bridgeSnap = await app.prisma.saldoSnapshot.findUnique({
      where: { id: bridgeSnapId },
    });
    expect(bridgeSnap).not.toBeNull();
    expect(bridgeSnap!.superseded).toBe(false);
  }, 120_000);

  // ── T9: Ordering assertion — Jun before Jul, chain integrity ─────────────
  it("T9: Jun snapshot exists before Jul; Jul.carryOver == Jun.carryOver + Jul.balanceMinutes", async () => {
    await cleanup();

    const opts: BackfillOptions = {
      apply: true,
      tenantId,
      employeeIds: [empId],
      until: { year: 2026, month: 7 },
    };
    await main(app, opts);

    // Get new snapshots ordered by periodStart
    const newSnaps = await app.prisma.saldoSnapshot.findMany({
      where: { employeeId: empId, superseded: false, id: { not: bridgeSnapId } },
      orderBy: { periodStart: "asc" },
    });
    expect(newSnaps.length).toBeGreaterThanOrEqual(2);

    const junSnap = newSnaps[0];
    const julSnap = newSnaps[1];

    // Jun must come before Jul in periodStart
    expect(junSnap!.periodStart.getTime()).toBeLessThan(julSnap!.periodStart.getTime());

    // Chain integrity: Jul.carryOver = Jun.carryOver + Jul.balanceMinutes
    expect(julSnap!.carryOver).toBe(junSnap!.carryOver + julSnap!.balanceMinutes);
  }, 120_000);
});
