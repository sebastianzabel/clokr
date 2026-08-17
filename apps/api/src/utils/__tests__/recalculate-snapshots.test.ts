/**
 * Phase 76.12 Plan 02 — Smoke tests for recalculateSnapshots.
 *
 * Verifies the leave-reduce uses calcLeaveAbsenceMinutesTz with halfDay
 * (D-15). v1.6.3-scoped decision (no absence-subtraction in this file)
 * is RESPECTED — we do not add absence-subtraction in Phase 76.12.
 *
 * No PII — initials only (memory feedback_no_pii_in_github).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { getTestApp, closeTestApp, cleanupTestData } from "../../__tests__/setup";
import { recalculateSnapshots } from "../recalculate-snapshots";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

describe("recalculateSnapshots (Phase 76.12 Plan 02) — Ø-Methode leave subtraction", () => {
  const SOURCE_PATH = join(__dirname, "..", "recalculate-snapshots.ts");
  const source = readFileSync(SOURCE_PATH, "utf-8");
  // Phase 76.26: the per-month saldo math (absence subtraction, BS-doubling, leave
  // reduction) was extracted from this file into the SHARED pure core
  // close-employee-month.ts, which manual close, cron, and recalc all now call.
  // These white-box structural tests therefore assert (a) recalc DELEGATES to the
  // shared core, and (b) the moved logic lives in that core. The behavioural parity
  // proof is unchanged: saldo-invariant-e2e.test.ts (step 6), bs-day-saldo-parity.test.ts,
  // and recalculate-snapshots-atomic.test.ts all stay green.
  const CLOSE_SOURCE_PATH = join(__dirname, "..", "close-employee-month.ts");
  const closeSource = readFileSync(CLOSE_SOURCE_PATH, "utf-8");

  // ── Phase 76.21 (debug D7) → Phase 76.26: parity now guaranteed structurally via the shared core ──
  it("Phase 76.26: recalc delegates to closeEmployeeMonth (shared core subtracts absences + BS-doubling for parity with the close)", () => {
    // v1.6.3 scoped absence-subtraction OUT of recalc → recalc-vs-close drift. Debug D7
    // (76.21) reversed that inline; Phase 76.26 extracted the whole computation into
    // closeEmployeeMonth so recalc == manual == cron is STRUCTURAL (same function), not
    // hand-maintained. Behaviour proven by saldo-invariant-e2e + bs-day-saldo-parity.
    expect(source).toMatch(/closeEmployeeMonth\(/);
    // The absence subtraction + BS-doubling now live in the shared core.
    expect(closeSource).toMatch(/parity with the manual close|bsExpectedMinutes/);
  });

  // ── D-15: leave-reduce uses calcLeaveAbsenceMinutesTz with halfDay (now in the shared core) ──
  it("D-15: leave-reduce uses calcLeaveAbsenceMinutesTz with halfDay propagation (in close-employee-month.ts)", () => {
    expect(closeSource).toMatch(/calcLeaveAbsenceMinutesTz\(/);
    expect(closeSource).toMatch(/halfDay: Boolean\(lr\.halfDay\)/);
  });

  // ── Integration: existing snapshot is rewritten to Ø-Methode values ──
  describe("integration: existing snapshot recalc honors halfDay", () => {
    let app: FastifyInstance;
    let tenantId: string;
    let vacationTypeId: string;
    let asEmpId: string;

    const HIRE_DATE = new Date("2026-04-01T00:00:00Z");
    const MAY_START = new Date("2026-04-30T22:00:00Z"); // May 1 00:00 Berlin = April 30 22:00 UTC
    const MAY_END = new Date("2026-05-31T21:59:59.999Z");
    // RECALC_FROM <= snapshot.periodStart so the snapshot is in scope.
    const RECALC_FROM = new Date("2026-04-30T00:00:00Z");

    beforeAll(async () => {
      app = await getTestApp();
      const prisma = app.prisma;
      const s = "recalc-76-12-" + Date.now().toString(36);

      const tenant = await prisma.tenant.create({
        data: { name: `Recalc 76.12 ${s}`, slug: `rc-${s}`, federalState: "NIEDERSACHSEN" },
      });
      tenantId = tenant.id;
      await prisma.tenantConfig.create({
        data: { tenantId, defaultVacationDays: 30, timezone: "Europe/Berlin" },
      });

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

      const vacationType = await prisma.leaveType.create({
        data: { tenantId, name: "Urlaub", isPaid: true, requiresApproval: true, color: "#3B82F6" },
      });
      vacationTypeId = vacationType.id;

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
          // workDays explicit (soll-ignores-workdays-on-legacy-schedules fix):
          // avgWorkMinutesCore is now workDays-primary. Without this, the row
          // would silently inherit the Prisma schema default workDays=[1..5]
          // (includes Monday, which this fixture does NOT work per
          // mondayHours=0 below). Set to the fixture's real Tue-Fri pattern —
          // matches what normalizeWorkDays() would derive from these same
          // {day}Hours in production and keeps expected values unchanged.
          workDays: [2, 3, 4, 5],
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

      // Seed an existing May 2026 snapshot with STALE values (simulates a
      // pre-fix state). recalculateSnapshots will overwrite it with the
      // Ø-Methode values.
      await prisma.saldoSnapshot.create({
        data: {
          employeeId: asEmp.id,
          periodType: "MONTHLY",
          periodStart: MAY_START,
          periodEnd: MAY_END,
          workedMinutes: 0,
          expectedMinutes: 99999, // stale value — will be overwritten
          balanceMinutes: -99999,
          carryOver: -99999,
          closedAt: new Date("2026-06-01T00:00:00Z"),
          closedBy: null,
          note: "Stale snapshot for 76.12 recalc test",
        },
      });
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
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("recalculate-snapshots 76.12 test cleanup failed:", err);
      }
      await closeTestApp();
      vi.useRealTimers();
    });

    it("recalculateSnapshots — halfDay leave reduces Soll by exactly half vs full-day leave (Ø-Methode + halfDay propagation)", async () => {
      // ── First recalc with FULL-day Fri 2026-05-29 leave ─────────────────
      await app.prisma.leaveRequest.deleteMany({ where: { employeeId: asEmpId } });
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: asEmpId,
          leaveTypeId: vacationTypeId,
          startDate: new Date("2026-05-29"),
          endDate: new Date("2026-05-29"),
          days: 1,
          halfDay: false,
          status: "APPROVED",
        },
      });
      await recalculateSnapshots(app, asEmpId, RECALC_FROM);
      // COMP-V1814-04: recalc supersedes old row and creates new active one; filter superseded:false
      const snapFull = await app.prisma.saldoSnapshot.findFirst({
        where: { employeeId: asEmpId, periodType: "MONTHLY", superseded: false },
        orderBy: { periodStart: "desc" },
      });
      expect(snapFull).not.toBeNull();
      const expectedFull = snapFull!.expectedMinutes;

      // ── Second recalc with HALF-day version ─────────────────────────────
      await app.prisma.leaveRequest.deleteMany({ where: { employeeId: asEmpId } });
      // Reset only the active (superseded=false) snapshot so recalc has a fresh row to work on
      await app.prisma.saldoSnapshot.updateMany({
        where: { employeeId: asEmpId, periodType: "MONTHLY", superseded: false },
        data: { expectedMinutes: 99999, balanceMinutes: -99999, carryOver: -99999 },
      });
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: asEmpId,
          leaveTypeId: vacationTypeId,
          startDate: new Date("2026-05-29"),
          endDate: new Date("2026-05-29"),
          days: 0.5,
          halfDay: true,
          status: "APPROVED",
        },
      });
      await recalculateSnapshots(app, asEmpId, RECALC_FROM);
      const snapHalf = await app.prisma.saldoSnapshot.findFirst({
        where: { employeeId: asEmpId, periodType: "MONTHLY", superseded: false },
        orderBy: { periodStart: "desc" },
      });
      expect(snapHalf).not.toBeNull();
      const expectedHalf = snapHalf!.expectedMinutes;

      // Pre-fix bug: halfDay was IGNORED → expectedFull === expectedHalf.
      // Post-fix: halfDay produces round(570/2) = 285 LESS subtracted from
      // expected → expectedHalf is exactly 285 GREATER than expectedFull.
      // A.S. Fri Ø-Methode = 38h × 60min / 4 workdays = 570min full-day subtraction.
      // halfDay = round(570/2) = 285min subtraction.
      // Difference = 570 - 285 = 285min more remaining in expectedMinutes.
      expect(expectedHalf - expectedFull).toBe(285);
    });

    it("recalculateSnapshots — no leave produces a baseline; adding full-day Fri leave reduces expected by exactly 570 (Ø-Methode for A.S. Fri)", async () => {
      // Baseline — no leave at all.
      await app.prisma.leaveRequest.deleteMany({ where: { employeeId: asEmpId } });
      // Reset only active (superseded:false) so recalc has a fresh row to overwrite
      await app.prisma.saldoSnapshot.updateMany({
        where: { employeeId: asEmpId, periodType: "MONTHLY", superseded: false },
        data: { expectedMinutes: 99999, balanceMinutes: -99999, carryOver: -99999 },
      });
      await recalculateSnapshots(app, asEmpId, RECALC_FROM);
      // COMP-V1814-04: filter superseded:false to get the new active row
      const snapNoLeave = await app.prisma.saldoSnapshot.findFirst({
        where: { employeeId: asEmpId, periodType: "MONTHLY", superseded: false },
        orderBy: { periodStart: "desc" },
      });
      const expectedNoLeave = snapNoLeave!.expectedMinutes;

      // Add full-day Fri leave.
      await app.prisma.saldoSnapshot.updateMany({
        where: { employeeId: asEmpId, periodType: "MONTHLY", superseded: false },
        data: { expectedMinutes: 99999, balanceMinutes: -99999, carryOver: -99999 },
      });
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: asEmpId,
          leaveTypeId: vacationTypeId,
          startDate: new Date("2026-05-29"),
          endDate: new Date("2026-05-29"),
          days: 1,
          halfDay: false,
          status: "APPROVED",
        },
      });
      await recalculateSnapshots(app, asEmpId, RECALC_FROM);
      const snapWithLeave = await app.prisma.saldoSnapshot.findFirst({
        where: { employeeId: asEmpId, periodType: "MONTHLY", superseded: false },
        orderBy: { periodStart: "desc" },
      });
      const expectedWithLeave = snapWithLeave!.expectedMinutes;

      // Ø-Methode A.S. 1 day Fri = 570 min subtracted from expectedMinutes.
      expect(expectedNoLeave - expectedWithLeave).toBe(570);
    });
  });
});

describe("recalculateSnapshots — bridge/opening-balance snapshot protection (2026-08 hardening)", () => {
  // Prod incident: recalculateSnapshots() used to unconditionally supersede+recreate
  // EVERY MONTHLY snapshot in range, including manually-injected opening-balance
  // "bridge" rows (expectedMinutes=0, workedMinutes=0, balanceMinutes=0, carryOver!=0).
  // That silently zeroed ~102h of legitimately earned pre-tracking overtime on prod.
  // This test builds a bridge snapshot followed by a later closed month and calls
  // recalculateSnapshots with fromDate AT the bridge month (mirroring the real
  // WorkSchedule-edit trigger) — without the isBridgeSnapshot guard in
  // recalculate-snapshots.ts, the bridge row would be superseded and its carryOver
  // recomputed to whatever the (nonexistent) April activity yields, i.e. NOT 6120.
  let app: FastifyInstance;
  let tenantId: string;
  let bridgeEmpId: string;

  const HIRE_DATE = new Date("2026-01-01T00:00:00Z");
  // April 2026, Europe/Berlin (CEST, UTC+2) — bridge month.
  const APRIL_START = new Date("2026-03-31T22:00:00Z"); // April 1 00:00 Berlin
  const APRIL_END = new Date("2026-04-30T21:59:59.999Z"); // April 30 23:59:59.999 Berlin
  // May 2026 — the first normally-tracked month after the bridge.
  const MAY_START = new Date("2026-04-30T22:00:00Z");
  const MAY_END = new Date("2026-05-31T21:59:59.999Z");
  // fromDate AT/BEFORE the bridge month — the exact trigger shape of a retroactive
  // WorkSchedule/leave/holiday edit that walks the chain from an early month forward.
  const RECALC_FROM = new Date("2026-03-01T00:00:00Z");
  const BRIDGE_CARRY_OVER = 6120; // 102h × 60min — magnitude mirrors the real prod incident

  let bridgeSnapshotId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = "recalc-bridge-" + Date.now().toString(36);

    const tenant = await prisma.tenant.create({
      data: { name: `Recalc Bridge ${s}`, slug: `rcb-${s}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: "Europe/Berlin" },
    });

    const bridgeUser = await prisma.user.create({
      data: {
        email: `bridge-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const bridgeEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: bridgeUser.id,
        employeeNumber: `BR-${s}`,
        firstName: "B.",
        lastName: "R.",
        classification: "VOLLZEIT",
        hireDate: HIRE_DATE,
      },
    });
    bridgeEmpId = bridgeEmp.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: bridgeEmp.id,
        type: "FLEXTIME",
        weeklyHours: 38,
        workDays: [1, 2, 3, 4, 5],
        mondayHours: 7.6,
        tuesdayHours: 7.6,
        wednesdayHours: 7.6,
        thursdayHours: 7.6,
        fridayHours: 7.6,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: HIRE_DATE,
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: bridgeEmp.id, balanceHours: 0 } });

    // The bridge row: shape per isBridgeSnapshot() — all-zero activity, non-zero carryOver.
    // Simulates a human-operator-injected opening balance for pre-tracking overtime.
    const bridgeSnap = await prisma.saldoSnapshot.create({
      data: {
        employeeId: bridgeEmp.id,
        periodType: "MONTHLY",
        periodStart: APRIL_START,
        periodEnd: APRIL_END,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: BRIDGE_CARRY_OVER,
        closedAt: new Date("2026-05-01T00:00:00Z"),
        closedBy: null,
        note: "Bridge/opening-balance seed for regression test",
      },
    });
    bridgeSnapshotId = bridgeSnap.id;

    // A normal closed month right after the bridge — no time entries, so it will be
    // pure undertime, but its carryOver MUST chain from the bridge's carryOver.
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: bridgeEmp.id,
        periodType: "MONTHLY",
        periodStart: MAY_START,
        periodEnd: MAY_END,
        workedMinutes: 0,
        expectedMinutes: 99999, // stale placeholder — recalc will overwrite (not a bridge row)
        balanceMinutes: -99999,
        carryOver: -99999,
        closedAt: new Date("2026-06-01T00:00:00Z"),
        closedBy: null,
        note: "Stale placeholder for bridge regression test",
      },
    });
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
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("recalculate-snapshots bridge regression test cleanup failed:", err);
    }
    await closeTestApp();
    vi.useRealTimers();
  });

  it("does NOT supersede the bridge row and threads its carryOver unchanged into the next month", async () => {
    await recalculateSnapshots(app, bridgeEmpId, RECALC_FROM);

    // (a) Bridge row is untouched: same id, still active, carryOver unchanged.
    const bridgeAfter = await app.prisma.saldoSnapshot.findUnique({
      where: { id: bridgeSnapshotId },
    });
    expect(bridgeAfter).not.toBeNull();
    expect(bridgeAfter!.superseded).toBe(false);
    expect(bridgeAfter!.carryOver).toBe(BRIDGE_CARRY_OVER);
    expect(bridgeAfter!.expectedMinutes).toBe(0);
    expect(bridgeAfter!.workedMinutes).toBe(0);
    expect(bridgeAfter!.balanceMinutes).toBe(0);

    // No audit entry for the bridge row — nothing changed, so nothing to log
    // (audit-proof rule: audit records real mutations, not no-ops).
    const bridgeAudits = await app.prisma.auditLog.findMany({
      where: { entity: "SaldoSnapshot", entityId: bridgeSnapshotId },
    });
    expect(bridgeAudits.length).toBe(0);

    // (b) Only ONE active snapshot exists for the bridge month (April) — no duplicate
    // was created alongside the untouched bridge row.
    const aprilActiveCount = await app.prisma.saldoSnapshot.count({
      where: {
        employeeId: bridgeEmpId,
        periodType: "MONTHLY",
        periodStart: APRIL_START,
        superseded: false,
      },
    });
    expect(aprilActiveCount).toBe(1);

    // (c) May (the normal month) WAS recalculated (superseded+recreated is expected —
    // it is not a bridge row), and its new carryOver chains from the bridge's carryOver
    // (byte-identical threading: bridge.carryOver + May's own balanceMinutes).
    const mayActive = await app.prisma.saldoSnapshot.findFirst({
      where: {
        employeeId: bridgeEmpId,
        periodType: "MONTHLY",
        periodStart: MAY_START,
        superseded: false,
      },
    });
    expect(mayActive).not.toBeNull();
    expect(mayActive!.id).not.toBe(bridgeSnapshotId);
    expect(mayActive!.carryOver).toBe(BRIDGE_CARRY_OVER + mayActive!.balanceMinutes);

    // Final chain carryOver (OvertimeAccount.balanceHours) matches the recalculated
    // May row exactly — the bridge's contribution survived the full chain intact.
    const account = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: bridgeEmpId },
    });
    expect(account).not.toBeNull();
    expect(Math.round(Number(account!.balanceHours) * 60)).toBe(mayActive!.carryOver);
  });
});
