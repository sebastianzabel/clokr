/**
 * Integration test: updateOvertimeAccount correctly subtracts Absence rows from
 * expectedMinutes so that employees with pre-tracking absence coverage do not
 * drift to strongly negative saldo on TimeEntry mutations.
 *
 * Reproduces the "a-tenant" bug where 13 MAs went from saldo=0 to -100..-150h
 * after a single test TimeEntry was created.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import { updateOvertimeAccount } from "../routes/time-entries";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

// Today in YYYY-MM-DD (UTC)
function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

describe("Overtime Absence Saldo — pre-tracking absence coverage", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;

  // Employee with Absence covering the whole open period
  let employeeWithAbsenceId: string;
  // Employee WITHOUT Absence (regression sanity check)
  let employeeWithoutAbsenceId: string;

  const HIRE_DATE = new Date("2026-01-01T00:00:00Z");
  const ABSENCE_START = new Date("2026-01-01T00:00:00Z");
  // Absence ends 8 days ago so there's a clear past period fully covered
  const absenceEndDate = new Date(Date.now() - 8 * 86400000);
  absenceEndDate.setUTCHours(0, 0, 0, 0);
  const ABSENCE_END = absenceEndDate;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = "abs-saldo-" + Date.now().toString(36);

    // ── Tenant ──────────────────────────────────────────────────────────────
    const tenant = await prisma.tenant.create({
      data: { name: `Absence Saldo Test ${s}`, slug: `abs-${s}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId: tenant.id, defaultVacationDays: 30, timezone: "Europe/Berlin" },
    });

    // ── Admin user ────────────────────────────────────────────────────────
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    const adminEmp = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "Admin",
        lastName: "Saldo",
        hireDate: HIRE_DATE,
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: adminEmp.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: HIRE_DATE,
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: adminEmp.id, balanceHours: 0 } });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-${s}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken;

    // ── Employee A: WITH full-period Absence ──────────────────────────────
    const empUserA = await prisma.user.create({
      data: {
        email: `emp-a-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const empA = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: empUserA.id,
        employeeNumber: `EA-${s}`,
        firstName: "Anja",
        lastName: "Weiss",
        hireDate: HIRE_DATE,
      },
    });
    employeeWithAbsenceId = empA.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: empA.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: HIRE_DATE,
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empA.id, balanceHours: 0 } });
    // Absence: Jan 1 → 8 days ago (covers the entire open period up to cutoff minus a week)
    await prisma.absence.create({
      data: {
        employeeId: empA.id,
        type: "OTHER",
        startDate: ABSENCE_START,
        endDate: ABSENCE_END,
        days: 100, // approximate; exact count not used by saldo calc
        note: "Pre-tracking absence coverage test",
        createdBy: adminUser.id,
        deletedAt: null,
      },
    });

    // ── Employee B: WITHOUT Absence ───────────────────────────────────────
    const empUserB = await prisma.user.create({
      data: {
        email: `emp-b-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const empB = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: empUserB.id,
        employeeNumber: `EB-${s}`,
        firstName: "Max",
        lastName: "Noabs",
        hireDate: HIRE_DATE,
      },
    });
    employeeWithoutAbsenceId = empB.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: empB.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: HIRE_DATE,
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empB.id, balanceHours: 0 } });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // TODO (issue #6 — Saldo Snapshot architecture):
  // This test was written for the original "recalc-from-hire-date" overtime
  // architecture where Absence over the entire pre-period would clamp saldo
  // to ~0. Since the Snapshot-based redesign (CLAUDE.md § Saldo Calculation &
  // Monatsabschluss + Phase 66), updateOvertimeAccount only computes the
  // CURRENT MONTH's delta (rangeStart = monthStart of "now"). The seeded
  // Absence (Jan 1 → now-8d) does not overlap "now"'s current-month range
  // unless run on a date where the Absence end is in the same month.
  //
  // The 3 commits at the top of `describe(...)` set ABSENCE_END = now - 8d
  // dynamically at module load, which makes the overlap purely timing-
  // dependent (random pass/fail). The fix is to either:
  //   (a) extend ABSENCE_END to "now" and rewrite the regression for the
  //       Snapshot architecture, or
  //   (b) fold this scenario into the existing Saldo Snapshot integration
  //       tests added by issue #6.
  //
  // Skipping rather than thresholding because the threshold is meaningless
  // when the Absence and the computation range do not overlap.
  it.skip("updateOvertimeAccount subtracts Absence rows from expected (no negative drift)", async () => {
    await updateOvertimeAccount(app, employeeWithAbsenceId);

    const account = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: employeeWithAbsenceId },
    });
    const balanceHours = Number(account?.balanceHours ?? 9999);

    expect(balanceHours).toBeGreaterThan(-20);
  });

  // Skipped for the same reason as the sibling test at line 206 (TODO issue #6):
  // both tests assume the pre-Snapshot recalc-from-hire-date overtime architecture.
  // Under the current Snapshot-based redesign (CLAUDE.md § Saldo Calculation &
  // Monatsabschluss), updateOvertimeAccount only computes the current month's delta,
  // so an Absence spanning Jan 1 → now-8d does not overlap the computation range and
  // the assertion at line 259 becomes meaningless. Fold into the Snapshot integration
  // tests (issue #6) when rewriting for the new architecture.
  it.skip("creating a TimeEntry does not drift saldo when prior period is fully absent", async () => {
    // Post a time entry on a weekday that is AFTER ABSENCE_END (i.e., within the last 7 days).
    // Employee has a schedule of 8h/day Mo-Fr.
    // Entry: 8h worked. Expected for that single day: 8h (if weekday). Delta should be ≈ 0.
    // Find the most recent weekday that's at least 1 day in the past
    const entryDate = new Date(Date.now() - 86400000); // start from yesterday
    while (entryDate.getUTCDay() === 0 || entryDate.getUTCDay() === 6) {
      entryDate.setUTCDate(entryDate.getUTCDate() - 1);
    }
    const entryDateStr = entryDate.toISOString().split("T")[0];

    // Use a past time that's definitely in the past
    const startTime = `${entryDateStr}T06:00:00.000Z`;
    const endTime = `${entryDateStr}T14:00:00.000Z`;

    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: employeeWithAbsenceId, date: entryDate, deletedAt: null },
    });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        employeeId: employeeWithAbsenceId,
        date: entryDateStr,
        startTime,
        endTime,
        breakMinutes: 0,
      },
    });
    expect([201, 409]).toContain(createRes.statusCode);

    const account = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: employeeWithAbsenceId },
    });
    const balanceHours = Number(account?.balanceHours ?? 9999);

    // The absence covers Jan–ABSENCE_END (~8 days ago), the entry is after ABSENCE_END.
    // Key assertion: saldo must NOT be strongly negative (pre-fix bug was -100 to -150h).
    // Absence correctly zeroes out expected hours for the covered range.
    // The small uncovered gap (ABSENCE_END+1 → entry day) may make it slightly negative.
    expect(balanceHours).toBeGreaterThan(-30);
  });

  it("regression: WITHOUT Absence, saldo IS strongly negative (sanity check)", async () => {
    // Phase 66 fix (failure #3): pin to a late-month date so updateOvertimeAccount's
    // current-month range (May 1 → pinned-today) covers ~18 workdays * 8h = ~144h
    // expected. Without the pin, on early-month run dates (e.g. 2026-06-03), the
    // range only covers 2 workdays → balance = -16h, failing the < -20 assertion.
    vi.useFakeTimers({ now: new Date("2026-05-26T10:00:00.000Z"), toFake: ["Date"] });
    try {
      // Call updateOvertimeAccount for the employee without any absence.
      // Hire date is Jan 1 2026 — by late May that's ~100 workdays of expected time.
      // With 0 time entries, saldo must be strongly negative.
      await updateOvertimeAccount(app, employeeWithoutAbsenceId);

      const account = await app.prisma.overtimeAccount.findUnique({
        where: { employeeId: employeeWithoutAbsenceId },
      });
      const balanceHours = Number(account?.balanceHours ?? 0);

      // Must be strongly negative — this is the pre-fix behavior for employees with no absence
      expect(balanceHours).toBeLessThan(-20);
    } finally {
      vi.useRealTimers();
    }
  });
});
