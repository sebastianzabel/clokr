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
    // Placeholder MUST be injectedDelta-neutral under the 2026-08 round-2 hardening
    // (carryOver - balanceMinutes === the previous row's stored carryOver, i.e.
    // BRIDGE_CARRY_OVER here) — an arbitrary "obviously wrong" sentinel like
    // -99999/-99999 is no longer a valid placeholder once recompute takes the STORED
    // carryOver seriously (it would itself read back as a bogus injected delta). This
    // never occurs with real prod data, where every existing snapshot was written by
    // a genuine closeEmployeeMonth call, never an arbitrary sentinel — expectedMinutes
    // is set to a dummy 1 solely so this placeholder itself doesn't match the bridge
    // shape (which would skip it instead of exercising the real recompute path).
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: bridgeEmp.id,
        periodType: "MONTHLY",
        periodStart: MAY_START,
        periodEnd: MAY_END,
        workedMinutes: 0,
        expectedMinutes: 1, // dummy nonzero — recalc will overwrite (not a bridge row)
        balanceMinutes: 0,
        carryOver: BRIDGE_CARRY_OVER, // injectedDelta-neutral placeholder (see comment above)
        closedAt: new Date("2026-06-01T00:00:00Z"),
        closedBy: null,
        note: "Placeholder for bridge regression test",
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

describe("recalculateSnapshots — injectedDelta preservation for real-activity rows (2026-08 hardening round 2)", () => {
  // The isBridgeSnapshot() shape guard only protects rows with NO activity at all. It
  // is blind to a row that has GENUINE worked/expected activity and also carries a
  // hand-injected carryOver correction on top (e.g. an operator adding pre-Clokr
  // overtime minutes directly onto an already-real, already-closed month). This
  // exact shape (worked=expected, balance=0, plus an unexplained carryOver jump) is
  // what a real prod row looked like — the shape guard let it fall through to full
  // recomputation, which silently discarded the injected minutes. This test builds
  // that exact scenario and proves the delta survives a recompute, without needing
  // to hand-derive the Ø-Methode (avgWorkMinutesCore) formula: it runs
  // recalculateSnapshots twice as a "warm-up" to let the engine itself produce a
  // correct, real-activity, balance=0 row, THEN manually injects a delta on top
  // (mirroring the real "opening balance restore" UPDATE pattern) and re-runs.
  let app: FastifyInstance;
  let tenantId: string;
  let deltaEmpId: string;

  const HIRE_DATE = new Date("2026-01-01T00:00:00Z");
  // June 2026 — outside the recalc range; anchors runningCarryOver like `prevSnapshot`.
  const JUNE_START = new Date("2026-05-31T22:00:00Z");
  const JUNE_END = new Date("2026-06-30T21:59:59.999Z");
  // July 2026 — the row that will carry the injected delta.
  const JULY_START = new Date("2026-06-30T22:00:00Z");
  const JULY_END = new Date("2026-07-31T21:59:59.999Z");
  // August 2026 — downstream continuation, must NOT re-apply the delta a second time.
  const AUGUST_START = new Date("2026-07-31T22:00:00Z");
  const AUGUST_END = new Date("2026-08-31T21:59:59.999Z");
  const RECALC_FROM = JULY_START;

  const JUNE_CARRY_OVER = 1000; // arbitrary clean anchor — no injection involved
  const INJECTED_DELTA = 6129; // minutes — mirrors the real prod incident magnitude (~102h)

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = "recalc-delta-" + Date.now().toString(36);

    const tenant = await prisma.tenant.create({
      data: { name: `Recalc Delta ${s}`, slug: `rcd-${s}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: "Europe/Berlin" },
    });

    const deltaUser = await prisma.user.create({
      data: {
        email: `delta-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const deltaEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: deltaUser.id,
        employeeNumber: `DE-${s}`,
        firstName: "D.",
        lastName: "E.",
        classification: "VOLLZEIT",
        hireDate: HIRE_DATE,
      },
    });
    deltaEmpId = deltaEmp.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: deltaEmp.id,
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
    await prisma.overtimeAccount.create({ data: { employeeId: deltaEmp.id, balanceHours: 0 } });

    // June: the pre-existing, out-of-range anchor snapshot — clean, no injection.
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: deltaEmp.id,
        periodType: "MONTHLY",
        periodStart: JUNE_START,
        periodEnd: JUNE_END,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: JUNE_CARRY_OVER,
        closedAt: new Date("2026-07-01T00:00:00Z"),
        closedBy: null,
        note: "Clean anchor for injectedDelta regression test",
      },
    });

    // July: placeholder to seed — will be warmed up below (no entries yet).
    // Placeholder MUST be injectedDelta-neutral (carryOver - balanceMinutes ===
    // June's stored carryOver) under the 2026-08 round-2 hardening — see the parallel
    // comment in the bridge-protection describe block above for why an arbitrary
    // sentinel is no longer valid once recompute takes the stored carryOver seriously.
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: deltaEmp.id,
        periodType: "MONTHLY",
        periodStart: JULY_START,
        periodEnd: JULY_END,
        workedMinutes: 0,
        expectedMinutes: 1, // dummy nonzero — warm-up run #1 overwrites it (not a bridge row)
        balanceMinutes: 0,
        carryOver: JUNE_CARRY_OVER, // injectedDelta-neutral placeholder (see comment above)
        closedAt: new Date("2026-08-01T00:00:00Z"),
        closedBy: null,
        note: "Warm-up placeholder for injectedDelta regression test",
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("recalculate-snapshots injectedDelta test cleanup failed:", err);
    }
    await closeTestApp();
    vi.useRealTimers();
  });

  it("preserves a hand-injected carryOver delta on a real-activity (worked=expected, balance=0) row across recompute, without double-applying it downstream", async () => {
    const prisma = app.prisma;

    // ── Warm-up run #1: no entries yet — discover the real expectedMinutes for July
    // from the schedule itself (Ø-Methode), without hand-deriving avgWorkMinutesCore. ──
    await recalculateSnapshots(app, deltaEmpId, RECALC_FROM);
    const warm1 = await prisma.saldoSnapshot.findFirst({
      where: {
        employeeId: deltaEmpId,
        periodType: "MONTHLY",
        periodStart: JULY_START,
        superseded: false,
      },
    });
    expect(warm1).not.toBeNull();
    const targetMinutes = warm1!.expectedMinutes;
    expect(targetMinutes).toBeGreaterThan(0); // sanity: July has real workdays under this schedule

    // Seed a single WORK entry totaling EXACTLY targetMinutes — guarantees
    // workedMinutes === expectedMinutes (balance=0) on the next recompute, matching
    // the real prod row's exact shape (worked=expected=900, balance=0).
    const entryStart = new Date("2026-07-15T06:00:00Z"); // July 15 08:00 Berlin (CEST)
    const entryEnd = new Date(entryStart.getTime() + targetMinutes * 60_000);
    await prisma.timeEntry.create({
      data: {
        employeeId: deltaEmpId,
        date: new Date("2026-07-15T00:00:00Z"),
        startTime: entryStart,
        endTime: entryEnd,
        breakMinutes: 0,
        source: "MANUAL",
        type: "WORK",
      },
    });

    // ── Warm-up run #2: now produces the real, correct, balance=0 row. ──
    await recalculateSnapshots(app, deltaEmpId, RECALC_FROM);
    const warm2 = await prisma.saldoSnapshot.findFirst({
      where: {
        employeeId: deltaEmpId,
        periodType: "MONTHLY",
        periodStart: JULY_START,
        superseded: false,
      },
    });
    expect(warm2).not.toBeNull();
    expect(warm2!.workedMinutes).toBe(targetMinutes);
    expect(warm2!.expectedMinutes).toBe(targetMinutes);
    expect(warm2!.balanceMinutes).toBe(0);
    const naturalCarryOver = warm2!.carryOver;
    expect(naturalCarryOver).toBe(JUNE_CARRY_OVER); // balance=0 → carryOver unchanged from June

    // ── Inject the delta directly onto the already-correct, already-real row —
    // mirrors the real "opening balance restore" UPDATE pattern exactly (an operator
    // adds minutes to an existing row's carryOver; nothing else about the row changes). ──
    await prisma.saldoSnapshot.update({
      where: { id: warm2!.id },
      data: { carryOver: naturalCarryOver + INJECTED_DELTA },
    });

    // August: downstream continuation, chained from July's now-injected carryOver.
    // Its OWN stored balance is a clean placeholder (0) so its OWN injectedDelta is 0 —
    // it must inherit July's preserved delta exactly once, not re-derive or drop it.
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: deltaEmpId,
        periodType: "MONTHLY",
        periodStart: AUGUST_START,
        periodEnd: AUGUST_END,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: naturalCarryOver + INJECTED_DELTA,
        closedAt: new Date("2026-09-01T00:00:00Z"),
        closedBy: null,
        note: "Downstream continuation for injectedDelta regression test",
      },
    });

    const julyRowIdBeforeFinalRecalc = warm2!.id;

    // ── The actual test run: re-recalculate from July again. Without the fix, this
    // would recompute July's carryOver as naturalCarryOver (1000) alone — the
    // INJECTED_DELTA (6129) would be silently discarded, exactly like the real
    // prod incident (5216 → 4200). ──
    await recalculateSnapshots(app, deltaEmpId, RECALC_FROM);

    const julyFinal = await prisma.saldoSnapshot.findFirst({
      where: {
        employeeId: deltaEmpId,
        periodType: "MONTHLY",
        periodStart: JULY_START,
        superseded: false,
      },
    });
    expect(julyFinal).not.toBeNull();
    // Legitimate part reproduced identically — the delta's presence must not perturb
    // the real worked/expected/balance recompute.
    expect(julyFinal!.workedMinutes).toBe(targetMinutes);
    expect(julyFinal!.expectedMinutes).toBe(targetMinutes);
    expect(julyFinal!.balanceMinutes).toBe(0);
    // THE KEY ASSERTION: the injected delta survived.
    expect(julyFinal!.carryOver).toBe(naturalCarryOver + INJECTED_DELTA);
    expect(julyFinal!.carryOver).not.toBe(naturalCarryOver); // would be the bug's (lost-delta) value

    // Audit trail: this recompute's SUPERSEDE entry for the pre-final July row
    // records the non-zero injectedDelta explicitly — traceable, not mysterious.
    const julySupersedeAudit = await prisma.auditLog.findFirst({
      where: { entity: "SaldoSnapshot", entityId: julyRowIdBeforeFinalRecalc, action: "SUPERSEDE" },
      orderBy: { createdAt: "desc" },
    });
    expect(julySupersedeAudit).not.toBeNull();
    const newVal = julySupersedeAudit!.newValue as Record<string, unknown>;
    expect(newVal.injectedDelta).toBe(INJECTED_DELTA);

    // Downstream: August must reflect July's preserved delta exactly ONCE — not
    // re-applied a second time, not dropped.
    const augustFinal = await prisma.saldoSnapshot.findFirst({
      where: {
        employeeId: deltaEmpId,
        periodType: "MONTHLY",
        periodStart: AUGUST_START,
        superseded: false,
      },
    });
    expect(augustFinal).not.toBeNull();
    expect(augustFinal!.carryOver).toBe(julyFinal!.carryOver + augustFinal!.balanceMinutes);
  });
});

describe("recalculateSnapshots — well-behaved multi-month chain is a byte-identical no-op (2026-08 hardening round 2)", () => {
  // injectedDelta must be 0 for every row whose stored carryOver is fully explained
  // by "previous month's stored carryOver + this month's own stored balance" — i.e.
  // any chain that was never manually tampered with. This test builds a normal
  // 3-month chain (no bridges, no injections) with real activity, runs
  // recalculateSnapshots once to produce correct closed snapshots, then runs it
  // AGAIN from the same fromDate (idempotent re-run, matching the function's own
  // documented contract) and asserts every field of every snapshot is byte-identical
  // between the two runs — proving the new delta-preservation logic is a true no-op
  // for well-behaved data, with zero false positives.
  let app: FastifyInstance;
  let tenantId: string;
  let chainEmpId: string;

  const HIRE_DATE = new Date("2026-01-01T00:00:00Z");
  const SEP_START = new Date("2026-08-31T22:00:00Z"); // Sept 1 00:00 Berlin (CEST)
  const SEP_END = new Date("2026-09-30T21:59:59.999Z");
  const OCT_START = new Date("2026-09-30T22:00:00Z"); // Oct 1 00:00 Berlin (CEST until Oct 25)
  const OCT_END = new Date("2026-10-31T22:59:59.999Z"); // CET after DST switch
  const NOV_START = new Date("2026-10-31T23:00:00Z"); // Nov 1 00:00 Berlin (CET)
  const NOV_END = new Date("2026-11-30T22:59:59.999Z");
  const RECALC_FROM = SEP_START;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = "recalc-chain-" + Date.now().toString(36);

    const tenant = await prisma.tenant.create({
      data: { name: `Recalc Chain ${s}`, slug: `rcc-${s}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: "Europe/Berlin" },
    });

    const chainUser = await prisma.user.create({
      data: {
        email: `chain-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const chainEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: chainUser.id,
        employeeNumber: `CH-${s}`,
        firstName: "C.",
        lastName: "H.",
        classification: "TEILZEIT",
        hireDate: HIRE_DATE,
      },
    });
    chainEmpId = chainEmp.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: chainEmp.id,
        type: "FLEXTIME",
        weeklyHours: 30,
        workDays: [1, 2, 3, 4],
        mondayHours: 0,
        tuesdayHours: 7.5,
        wednesdayHours: 7.5,
        thursdayHours: 7.5,
        fridayHours: 7.5,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: HIRE_DATE,
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: chainEmp.id, balanceHours: 0 } });

    // A little real (uneven, non-zero-balance) activity in each of the 3 months —
    // deliberately NOT matching Soll exactly, so each month has genuine over/undertime.
    for (const [dateStr, hours] of [
      ["2026-09-08", 5],
      ["2026-10-06", 6],
      ["2026-11-03", 4],
    ] as const) {
      const start = new Date(`${dateStr}T07:00:00Z`);
      await prisma.timeEntry.create({
        data: {
          employeeId: chainEmp.id,
          date: new Date(`${dateStr}T00:00:00Z`),
          startTime: start,
          endTime: new Date(start.getTime() + hours * 60 * 60_000),
          breakMinutes: 0,
          source: "MANUAL",
          type: "WORK",
        },
      });
    }

    // Placeholder snapshots for all 3 months — first recalc run overwrites them with
    // real, correct values. Placeholders MUST be injectedDelta-neutral under the
    // 2026-08 round-2 hardening: there is no real prior anchor for this brand-new
    // employee (no snapshot exists before September), so runningCarryOver/
    // prevStoredCarryOver start at 0 — a uniform (balanceMinutes=0, carryOver=0)
    // placeholder for every month keeps storedCarryIn===prevStoredCarryOver===0 all
    // the way down the chain (injectedDelta=0 throughout). expectedMinutes=1 is a
    // dummy nonzero value solely so these placeholders don't match the bridge shape.
    for (const [start, end] of [
      [SEP_START, SEP_END],
      [OCT_START, OCT_END],
      [NOV_START, NOV_END],
    ] as const) {
      await prisma.saldoSnapshot.create({
        data: {
          employeeId: chainEmp.id,
          periodType: "MONTHLY",
          periodStart: start,
          periodEnd: end,
          workedMinutes: 0,
          expectedMinutes: 1,
          balanceMinutes: 0,
          carryOver: 0,
          closedAt: new Date(end.getTime() + 24 * 60 * 60_000),
          closedBy: null,
          note: "Placeholder for well-behaved-chain no-op regression test",
        },
      });
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("recalculate-snapshots well-behaved-chain test cleanup failed:", err);
    }
    await closeTestApp();
    vi.useRealTimers();
  });

  it("produces byte-identical snapshots on a second (idempotent) recalc run — zero false-positive injectedDelta on a normal chain", async () => {
    const prisma = app.prisma;

    const fieldsOf = (row: {
      workedMinutes: number;
      expectedMinutes: number;
      balanceMinutes: number;
      carryOver: number;
    }) => ({
      workedMinutes: row.workedMinutes,
      expectedMinutes: row.expectedMinutes,
      balanceMinutes: row.balanceMinutes,
      carryOver: row.carryOver,
    });

    const readActiveRows = async () =>
      prisma.saldoSnapshot.findMany({
        where: { employeeId: chainEmpId, periodType: "MONTHLY", superseded: false },
        orderBy: { periodStart: "asc" },
      });

    // Run #1: produces the real, correct snapshots (from stale placeholders).
    await recalculateSnapshots(app, chainEmpId, RECALC_FROM);
    const run1Rows = await readActiveRows();
    const run1 = run1Rows.map(fieldsOf);
    const run1Ids = run1Rows.map((r) => r.id); // will be superseded by run #2 below
    expect(run1.length).toBe(3);
    // Sanity: at least one month has genuine non-zero balance (real, uneven activity).
    expect(run1.some((r) => r.balanceMinutes !== 0)).toBe(true);

    // Run #2: idempotent re-run, nothing changed in between. Every row's
    // injectedDelta must compute to 0 (stored carryOver is fully explained by the
    // chain from run #1), so the result must be byte-identical to run #1.
    await recalculateSnapshots(app, chainEmpId, RECALC_FROM);
    const run2 = (await readActiveRows()).map(fieldsOf);

    expect(run2).toEqual(run1);

    // No injectedDelta log/audit noise on a well-behaved chain: every SUPERSEDE
    // audit entry from run #2 (scoped to THIS test's own run-#1 row ids — never a
    // global/unscoped AuditLog query, which would be flaky under parallel test files
    // sharing the same test database) must carry injectedDelta === 0.
    const run2Audits = await prisma.auditLog.findMany({
      where: { entity: "SaldoSnapshot", action: "SUPERSEDE", entityId: { in: run1Ids } },
    });
    expect(run2Audits.length).toBe(3);
    for (const a of run2Audits) {
      const nv = a.newValue as Record<string, unknown>;
      expect(nv.injectedDelta).toBe(0);
    }
  });
});
