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
