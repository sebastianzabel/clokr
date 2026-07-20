/**
 * Behavioral integration tests for attendance-checker Features 7 + 8 (Phase 76.28-03).
 *
 * Feature 7: End-of-month employee gap reminder (tryEndOfMonthGapReminder)
 *   - Fires when today is in the last 3 days of the month
 *   - Does NOT fire mid-month
 *   - Respects 7-day dedup (exactly 1 notification on repeat call)
 *   - Excludes isTimeTrackingExempt employees
 *   - Excludes FLEXTIME / MONTHLY_HOURS employees (no daily gap)
 *
 * Feature 8: Beginning-of-month manager gap reminder (tryBeginningOfMonthGapReminder)
 *   - Fires on days 1–3 of the month
 *   - Does NOT fire on day 10+
 *
 * Each case uses an ISOLATED tenant to avoid cross-contamination.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedIsolatedTenant(app: FastifyInstance, suffix: string) {
  const s = `atc-${suffix}-${Date.now().toString(36)}`;
  const prisma = app.prisma;

  const tenant = await prisma.tenant.create({
    data: { name: `ATCTest ${s}`, slug: `atc-${s}`, federalState: "NIEDERSACHSEN" },
  });
  await prisma.tenantConfig.create({
    data: { tenantId: tenant.id, defaultVacationDays: 30, timezone: "Europe/Berlin" },
  });

  // Manager user
  const mgrPw = await bcrypt.hash("test1234", 10);
  const mgrUser = await prisma.user.create({
    data: { email: `mgr-${s}@test.de`, passwordHash: mgrPw, role: "MANAGER", isActive: true },
  });
  const mgrEmployee = await prisma.employee.create({
    data: {
      tenantId: tenant.id,
      userId: mgrUser.id,
      employeeNumber: `M-${s}`,
      firstName: "Manager",
      lastName: "Test",
      hireDate: new Date("2024-01-01"),
    },
  });
  await prisma.workSchedule.create({
    data: {
      employeeId: mgrEmployee.id,
      type: "FIXED_SCHEDULE",
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [1, 2, 3, 4, 5],
      validFrom: new Date("2024-01-01"),
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId: mgrEmployee.id, balanceHours: 0 } });

  // Regular employee
  const empPw = await bcrypt.hash("test1234", 10);
  const empUser = await prisma.user.create({
    data: { email: `emp-${s}@test.de`, passwordHash: empPw, role: "EMPLOYEE", isActive: true },
  });
  const employee = await prisma.employee.create({
    data: {
      tenantId: tenant.id,
      userId: empUser.id,
      employeeNumber: `E-${s}`,
      firstName: "Max",
      lastName: "Lücke",
      hireDate: new Date("2024-01-01"),
    },
  });
  await prisma.workSchedule.create({
    data: {
      employeeId: employee.id,
      type: "FIXED_SCHEDULE",
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [1, 2, 3, 4, 5],
      validFrom: new Date("2024-01-01"),
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });

  return { tenant, mgrUser, mgrEmployee, empUser, employee };
}

/** Seed a time entry for an employee on a given date string "YYYY-MM-DD". */
async function seedEntry(app: FastifyInstance, employeeId: string, dateStr: string) {
  const date = new Date(dateStr + "T00:00:00Z");
  await app.prisma.timeEntry.create({
    data: {
      employeeId,
      date,
      startTime: new Date(dateStr + "T08:00:00Z"),
      endTime: new Date(dateStr + "T16:00:00Z"),
      source: "MANUAL",
    },
  });
}

/** Collect GAP_WARNING_EMPLOYEE notifications for a given userId. */
async function getGapEmployeeNotifs(app: FastifyInstance, userId: string) {
  return app.prisma.notification.findMany({
    where: { userId, type: "GAP_WARNING_EMPLOYEE" },
    orderBy: { createdAt: "asc" },
  });
}

/** Collect GAP_WARNING_MANAGER notifications for a given userId. */
async function getGapManagerNotifs(app: FastifyInstance, userId: string) {
  return app.prisma.notification.findMany({
    where: { userId, type: "GAP_WARNING_MANAGER" },
    orderBy: { createdAt: "asc" },
  });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("attendance-checker — Feature 7: end-of-month employee gap reminder", () => {
  let app: FastifyInstance;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    for (const id of tenantIds) {
      try {
        await cleanupTestData(app, id);
      } catch (err) {
        console.error(`Cleanup failed for tenant ${id}:`, err);
      }
    }
    await closeTestApp();
  });

  it("Feature 7 FIRES on the last 3 days of the month", async () => {
    // Use July 2026: 31 days. Last 3 days = 29, 30, 31.
    // We set system time to 2026-07-29 (3rd-to-last day).
    // Seed entries for all Mon-Fri in July EXCEPT 2026-07-06 (a Monday = gap).
    const seed = await seedIsolatedTenant(app, "f7-fires");
    tenantIds.push(seed.tenant.id);

    // All weekdays in July 2026 except 2026-07-06
    const weekdays = [
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
      "2026-07-13",
      "2026-07-14",
      "2026-07-15",
      "2026-07-16",
      "2026-07-17",
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
      "2026-07-24",
      "2026-07-27",
      "2026-07-28",
      // 2026-07-06 intentionally omitted = gap
    ];
    for (const d of weekdays) {
      await seedEntry(app, seed.employee.id, d);
    }

    // Set system time to 2026-07-29T07:00:00Z (Berlin = 09:00 CEST = last 3 days)
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-29T07:00:00.000Z"));

    await app.tryEndOfMonthGapReminder();

    const notifs = await getGapEmployeeNotifs(app, seed.empUser.id);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].type).toBe("GAP_WARNING_EMPLOYEE");
  });

  it("Feature 7 does NOT fire mid-month (day 10)", async () => {
    const seed = await seedIsolatedTenant(app, "f7-nomid");
    tenantIds.push(seed.tenant.id);

    // Seed all days except one gap — same setup but we'll call mid-month
    await seedEntry(app, seed.employee.id, "2026-07-01");
    await seedEntry(app, seed.employee.id, "2026-07-02");
    await seedEntry(app, seed.employee.id, "2026-07-03");
    // 2026-07-07 (Monday) is the gap — intentionally no entry

    // Set system time to 2026-07-10 (mid-month, day 10)
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-10T07:00:00.000Z"));

    await app.tryEndOfMonthGapReminder();

    const notifs = await getGapEmployeeNotifs(app, seed.empUser.id);
    expect(notifs).toHaveLength(0);
  });

  it("Feature 7 dedup: second call within 7 days produces exactly 1 notification", async () => {
    const seed = await seedIsolatedTenant(app, "f7-dedup");
    tenantIds.push(seed.tenant.id);

    // Leave a gap on 2026-07-07 — only seed a few other days
    await seedEntry(app, seed.employee.id, "2026-07-01");
    await seedEntry(app, seed.employee.id, "2026-07-02");
    await seedEntry(app, seed.employee.id, "2026-07-03");

    vi.useFakeTimers({ toFake: ["Date"] });

    // First call: 2026-07-29 (last 3 days)
    vi.setSystemTime(new Date("2026-07-29T07:00:00.000Z"));
    await app.tryEndOfMonthGapReminder();

    // Second call: 2026-07-30 (still last 3 days, within 7-day dedup window)
    vi.setSystemTime(new Date("2026-07-30T07:00:00.000Z"));
    await app.tryEndOfMonthGapReminder();

    const notifs = await getGapEmployeeNotifs(app, seed.empUser.id);
    // Dedup: only 1 notification, not 2
    expect(notifs).toHaveLength(1);
  });

  it("Feature 7 excludes isTimeTrackingExempt employees", async () => {
    const seed = await seedIsolatedTenant(app, "f7-exempt");
    tenantIds.push(seed.tenant.id);

    // Mark the employee as exempt
    await app.prisma.employee.update({
      where: { id: seed.employee.id },
      data: { isTimeTrackingExempt: true },
    });

    // No entries at all = would trigger gap if not exempt

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-29T07:00:00.000Z"));

    await app.tryEndOfMonthGapReminder();

    const notifs = await getGapEmployeeNotifs(app, seed.empUser.id);
    expect(notifs).toHaveLength(0);
  });

  it("Feature 7 excludes MONTHLY_HOURS employees (no daily gap rule)", async () => {
    const seed = await seedIsolatedTenant(app, "f7-monthly");
    tenantIds.push(seed.tenant.id);

    // Change the work schedule type to MONTHLY_HOURS
    const schedules = await app.prisma.workSchedule.findMany({
      where: { employeeId: seed.employee.id },
    });
    await app.prisma.workSchedule.update({
      where: { id: schedules[0].id },
      data: {
        type: "MONTHLY_HOURS",
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        workDays: [],
      },
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-29T07:00:00.000Z"));

    await app.tryEndOfMonthGapReminder();

    const notifs = await getGapEmployeeNotifs(app, seed.empUser.id);
    expect(notifs).toHaveLength(0);
  });

  it("Feature 7 excludes FLEXTIME employees (no daily gap rule)", async () => {
    const seed = await seedIsolatedTenant(app, "f7-flextime");
    tenantIds.push(seed.tenant.id);

    const schedules = await app.prisma.workSchedule.findMany({
      where: { employeeId: seed.employee.id },
    });
    await app.prisma.workSchedule.update({
      where: { id: schedules[0].id },
      data: {
        type: "FLEXTIME",
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        workDays: [],
      },
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-29T07:00:00.000Z"));

    await app.tryEndOfMonthGapReminder();

    const notifs = await getGapEmployeeNotifs(app, seed.empUser.id);
    expect(notifs).toHaveLength(0);
  });
});

describe("attendance-checker — Feature 8: beginning-of-month manager gap reminder", () => {
  let app: FastifyInstance;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    for (const id of tenantIds) {
      try {
        await cleanupTestData(app, id);
      } catch (err) {
        console.error(`Cleanup failed for tenant ${id}:`, err);
      }
    }
    await closeTestApp();
  });

  it("Feature 8 FIRES on day 2 of the month for previous month gaps", async () => {
    // System time: 2026-08-02 (day 2 of August) → checks July 2026
    // Employee has a gap in July 2026 (no entry on 2026-07-07)
    const seed = await seedIsolatedTenant(app, "f8-fires");
    tenantIds.push(seed.tenant.id);

    // Seed a few July entries but leave 2026-07-07 empty
    await seedEntry(app, seed.employee.id, "2026-07-01");
    await seedEntry(app, seed.employee.id, "2026-07-02");
    await seedEntry(app, seed.employee.id, "2026-07-03");
    // 2026-07-07 (Monday) intentionally missing

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-02T07:00:00.000Z")); // day 2 of August (Berlin = Aug 2)

    await app.tryBeginningOfMonthGapReminder();

    const notifs = await getGapManagerNotifs(app, seed.mgrUser.id);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].type).toBe("GAP_WARNING_MANAGER");
  });

  it("Feature 8 does NOT fire on day 10 of the month", async () => {
    const seed = await seedIsolatedTenant(app, "f8-noday10");
    tenantIds.push(seed.tenant.id);

    // Employee has gaps in July 2026 but we call on Aug 10
    await seedEntry(app, seed.employee.id, "2026-07-01");
    // 2026-07-07 gap intentionally left

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-10T07:00:00.000Z")); // day 10 → should not fire

    await app.tryBeginningOfMonthGapReminder();

    const notifs = await getGapManagerNotifs(app, seed.mgrUser.id);
    expect(notifs).toHaveLength(0);
  });
});
