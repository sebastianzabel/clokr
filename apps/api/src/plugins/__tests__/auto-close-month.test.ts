/**
 * Phase 76.12 Plan 02 — Smoke tests for auto-close-month plugin.
 *
 * Asserts D-14 invariants on the auto-close-month plugin source AND on
 * the live behavior:
 *  - leave-reduce path uses calcLeaveAbsenceMinutesTz with halfDay (D-14)
 *  - bsAbsences query (separate, intentional BS-Doubling path) remains
 *    UNCHANGED — keeps type: 'VOCATIONAL_SCHOOL' filter (D-14)
 *  - Snapshot created with Ø-Methode-consistent balanceMinutes for an
 *    A.S.-style FLEXTIME employee with halfDay Fri leave.
 *
 * Note: tryAutoCloseMonth has many guard branches (D-11 grace period,
 * existingSnapshot, missingDates, monthlyHours). The integration test
 * pins the date past day 15 of June 2026 and pre-seeds time entries
 * for every workday of May 2026 so the close branch is reached.
 *
 * No PII — initials only (memory feedback_no_pii_in_github).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { getTestApp, closeTestApp, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

describe("auto-close-month plugin (Phase 76.12 Plan 02) — Ø-Methode + bsAbsences invariant", () => {
  const PLUGIN_SOURCE_PATH = join(__dirname, "..", "auto-close-month.ts");
  const pluginSource = readFileSync(PLUGIN_SOURCE_PATH, "utf-8");

  // ── Structural invariant: bsAbsences VOCATIONAL_SCHOOL path preserved ──
  it("D-14: bsAbsences query KEEPS type: 'VOCATIONAL_SCHOOL' filter (BS-Doubling intact)", () => {
    expect(pluginSource).toMatch(/const bsAbsences = await app\.prisma\.absence\.findMany/);
    expect(pluginSource).toMatch(/type: "VOCATIONAL_SCHOOL"/);
  });

  // ── Structural invariant: leave-reduce uses new helper + halfDay ──
  it("D-14: leave-reduce uses calcLeaveAbsenceMinutesTz with halfDay propagation", () => {
    expect(pluginSource).toMatch(/calcLeaveAbsenceMinutesTz\(/);
    expect(pluginSource).toMatch(/halfDay: Boolean\(lr\.halfDay\)/);
  });

  // ── Integration: snapshot created with Ø-Methode-consistent balance ──
  describe("integration: snapshot creation honors Ø-Methode leave subtraction", () => {
    let app: FastifyInstance;
    let tenantId: string;
    let adminUserId: string;
    let vacationTypeId: string;
    let asEmpId: string;

    const HIRE_DATE = new Date("2026-04-01T00:00:00Z");
    // June 16, 2026 → past day 15 grace, previous month = May 2026.
    const PINNED_NOW = new Date("2026-06-16T06:00:00Z");

    beforeAll(async () => {
      app = await getTestApp();
      const prisma = app.prisma;
      const s = "acm-76-12-" + Date.now().toString(36);

      const tenant = await prisma.tenant.create({
        data: { name: `ACM 76.12 ${s}`, slug: `acm-${s}`, federalState: "NIEDERSACHSEN" },
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
      adminUserId = adminUser.id;
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

      // A.S.-style MONTHLY_HOURS=0 (pure tracking) to bypass the missing-dates
      // completeness check (which iterates schedule.workDays). We test the
      // leave-reduce math by seeding leave, then verifying the snapshot's
      // balanceMinutes reflects Ø-Methode (FLEXTIME version below).
      // Use FLEXTIME instead because pure tracking sets leaveMinutes=0 in the
      // isPureTracking branch (line 305 in auto-close-month.ts).
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

      // Seed time entries for every workday in May 2026 so completeness check
      // passes (skipping the day covered by leave).
      // May 2026 workdays for A.S. (Di/Mi/Do/Fr, May 1 = Tag der Arbeit holiday):
      //   Di: 5,12,19,26  Mi: 6,13,20,27  Do: 7,14,21,28  Fr: 1(holiday),8,15,22,29
      const workdays = [
        "2026-05-05",
        "2026-05-06",
        "2026-05-07",
        "2026-05-08",
        "2026-05-12",
        "2026-05-13",
        "2026-05-14",
        "2026-05-15",
        "2026-05-19",
        "2026-05-20",
        "2026-05-21",
        "2026-05-22",
        "2026-05-26",
        "2026-05-27",
        "2026-05-28",
        // 2026-05-29 (Fri) covered by leave below
      ];
      for (const day of workdays) {
        await prisma.timeEntry.create({
          data: {
            employeeId: asEmp.id,
            date: new Date(day + "T00:00:00Z"),
            startTime: new Date(day + "T07:00:00Z"),
            endTime: new Date(day + "T16:30:00Z"),
            breakMinutes: 0,
            type: "WORK",
            source: "MANUAL",
          },
        });
      }

      // Halftime Fr 2026-05-29 leave.
      await prisma.leaveRequest.create({
        data: {
          employeeId: asEmp.id,
          leaveTypeId: vacationType.id,
          startDate: new Date("2026-05-29"),
          endDate: new Date("2026-05-29"),
          days: 0.5,
          halfDay: true,
          status: "APPROVED",
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
        console.error("auto-close-month 76.12 test cleanup failed:", err);
      }
      await closeTestApp();
      vi.useRealTimers();
    });

    it("snapshot for A.S. May 2026 with halfDay Fri leave uses Ø-Methode (leaveMin = 285)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(PINNED_NOW);
      try {
        await app.tryAutoCloseMonth();

        const snap = await app.prisma.saldoSnapshot.findFirst({
          where: { employeeId: asEmpId, periodType: "MONTHLY" },
          orderBy: { periodStart: "desc" },
        });
        expect(snap).not.toBeNull();

        // May 2026 workdays for A.S. (Di/Mi/Do/Fr):
        //   Di=5,12,19,26 (4) + Mi=6,13,20,27 (4) + Do=7,14,21,28 (4) + Fr=1,8,15,22,29 (5)
        //   = 17 workdays.
        // expectedMinutes (Ø-Methode FLEXTIME via calcExpectedMinutesTz) =
        //   38 * 60 * 17 / 4 = 9690 min.
        // Holidays in May 2026 for A.S. (DE-NI):
        //   May 1 (Fri, Tag der Arbeit) = 9.5h × 60 = 570 min
        //   May 14 (Thu, Christi Himmelfahrt) = 9.5h × 60 = 570 min
        //   (May 25 Pfingstmontag is Monday → not an A.S. workday, no deduction)
        //   Total holidayMinutes = 1140 min.
        // leaveMinutes (halfDay Fri 2026-05-29, Ø-Methode):
        //   = round(38 * 60 * 1 / 4 / 2) = round(285) = 285 min.
        // workedMinutes: 15 seeded entries × 9.5h = 15 × 570 = 8550 min.
        // netExpected = max(0, 9690 - 1140 - 285) = 8265.
        // balance = 8550 - 8265 = +285.
        //
        // Pre-fix: halfDay was IGNORED → leaveMinutes = round(38 × 60 / 4) = 570
        // → netExpected = max(0, 9690 - 1140 - 570) = 7980 → balance = +570.
        // The fix (halfDay propagated via Boolean(lr.halfDay)) halves the
        // subtraction → balance moves from +570 to +285 (exactly 285 less).
        expect(snap?.balanceMinutes).toBe(285);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
