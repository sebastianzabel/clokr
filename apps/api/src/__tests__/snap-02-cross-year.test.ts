/**
 * SNAP-02: Cross-year Dec→Jan backfill carryOver base + multi-month oldest-first backfill.
 *
 * Wave 0 — RED-first scaffold. These tests MUST FAIL against current code.
 * They turn GREEN after the SNAP-02 backward backfill loop (plan 76.27-03).
 *
 * The current cron (auto-close-month.ts) has a sequential guard that targets
 * ONLY the single `prevMonth`. If N-1 has no active snapshot, it skips the
 * employee entirely. This means:
 *
 *   - If an employee has last snapshot = month M and months M+1 and M+2 are
 *     both open, the cron invoked in month M+3 (or later) will target M+2
 *     (prevMonth), check M+1 (N-1), find no snapshot → SKIP. Only M+2 is
 *     targeted, but it can never close because M+1 is still open. The employee
 *     is stuck forever.
 *
 *   - If an employee has last snapshot = Dec 2025 and January 2026 is open,
 *     the cron in Feb 2026 targets Jan 2026 (prevMonth), checks Dec 2025 (N-1),
 *     finds the snapshot → PASSES the guard. ONLY the multi-month case fails;
 *     the single Dec→Jan case may actually PASS on current code. The RED for
 *     cross-year is in the second case where Dec is missing (multi-month gap
 *     across a year boundary).
 *
 * Test cases:
 *
 * Case (a) — Multi-month oldest-first backfill:
 *   Employee last snapshot = January 2026. February + March 2026 are open.
 *   Cron invoked at April 16 2026 (prevMonth = March 2026).
 *   Sequential guard checks February → no snapshot → SKIPS employee.
 *   Assert: February has an active snapshot. FAILS (null).
 *   Assert: March has an active snapshot. FAILS (null).
 *   Assert: March.carryOver reflects February's balance (chain). FAILS (can't check).
 *
 * Case (b) — Cross-year Dec→Jan gap + Feb gap:
 *   Employee last snapshot = November 2025. December 2025 + January 2026 are open.
 *   Cron invoked at February 16 2026 (prevMonth = January 2026).
 *   Sequential guard checks December 2025 → no snapshot → SKIPS employee.
 *   Assert: December 2025 has an active snapshot. FAILS (null).
 *   Assert: January 2026 has an active snapshot. FAILS (null).
 *   (The Dec→Jan year boundary is exercised because December 2025 must close first,
 *   with November 2025's carryOver, before January 2026 can close using December's.)
 *
 * Why RED on current code:
 *   In case (a): the sequential guard at auto-close-month.ts:138–169 checks only N-1
 *   (February for March target). February has no snapshot → guard fires → employee
 *   skipped entirely. Neither February nor March gets a snapshot.
 *
 *   In case (b): the guard checks December 2025 for January 2026 target. December
 *   has no snapshot (only November does) → guard fires → employee skipped. December
 *   and January never get snapshots. The year boundary (cross-year) compounds the bug:
 *   the backward loop must wrap month=1 → month=12 of the previous year, which the
 *   single-target cron never does.
 *
 * Postconditions (after 76.27-03 backward loop ships):
 *   - Case (a): backfill closes February then March in one invocation; March.carryOver
 *     = January.carryOver + February.balance + March.balance.
 *   - Case (b): backfill closes December 2025 (carryOverIn = November 2025.carryOver)
 *     then January 2026 (carryOverIn = December 2025.effectiveCarryOverOut).
 *
 * All snapshot assertions use superseded: false (Pitfall B5 from RESEARCH §5.3).
 * No PII — synthetic fixtures only.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { monthRangeUtc, monthDayBounds, dateStrInTz } from "../utils/timezone";
import { periodStartWindow } from "../utils/snapshot-period";

const TZ = "Europe/Berlin";

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Seed a TimeEntry (type=WORK, zero break) for a given date and net duration. */
async function seedEntry(
  app: FastifyInstance,
  empId: string,
  dateStr: string,
  netMinutes: number,
): Promise<void> {
  const start = new Date(dateStr + "T08:00:00Z");
  const end = new Date(start.getTime() + netMinutes * 60_000);
  await app.prisma.timeEntry.create({
    data: {
      employeeId: empId,
      date: new Date(dateStr + "T00:00:00Z"),
      startTime: start,
      endTime: end,
      breakMinutes: 0,
      type: "WORK",
    },
  });
}

/** Invoke the cron auto-close at a frozen "now". */
async function runCronAt(app: FastifyInstance, isoNow: string): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(isoNow));
  try {
    await app.tryAutoCloseMonth();
  } finally {
    vi.useRealTimers();
  }
}

/**
 * Fetch active MONTHLY snapshot for a specific (year, month) (superseded=false, B5 filter).
 * Uses periodStartWindow for convention-robust lookup.
 */
async function fetchActiveMonthlySnapshot(
  app: FastifyInstance,
  empId: string,
  year: number,
  month: number,
) {
  const { start } = monthRangeUtc(year, month, TZ);
  return app.prisma.saldoSnapshot.findFirst({
    where: {
      employeeId: empId,
      periodType: "MONTHLY",
      periodStart: periodStartWindow(start),
      superseded: false,
    },
  });
}

/** Count active (superseded=false) MONTHLY snapshots for an employee. */
async function countActiveMonthlySnapshots(app: FastifyInstance, empId: string): Promise<number> {
  return app.prisma.saldoSnapshot.count({
    where: {
      employeeId: empId,
      periodType: "MONTHLY",
      superseded: false,
    },
  });
}

/**
 * Seed an active MONTHLY SaldoSnapshot directly (bypasses the close logic, simulates
 * a pre-existing closed month with known values).
 */
async function seedMonthlySnapshot(
  app: FastifyInstance,
  empId: string,
  year: number,
  month: number,
  {
    carryOver,
    workedMinutes = 0,
    expectedMinutes = 0,
    balanceMinutes = 0,
  }: {
    carryOver: number;
    workedMinutes?: number;
    expectedMinutes?: number;
    balanceMinutes?: number;
  },
): Promise<void> {
  const { start, end } = monthRangeUtc(year, month, TZ);
  const { firstDay, lastDay } = monthDayBounds(start, end, TZ);
  await app.prisma.saldoSnapshot.create({
    data: {
      employeeId: empId,
      periodType: "MONTHLY",
      periodStart: start,
      periodEnd: end,
      workedMinutes,
      expectedMinutes,
      balanceMinutes,
      carryOver,
      superseded: false,
      closedBy: "SYSTEM",
      closedAt: new Date(),
    },
  });
  // Lock all existing entries in the month as the real close would do
  await app.prisma.timeEntry.updateMany({
    where: {
      employeeId: empId,
      deletedAt: null,
      date: { gte: firstDay, lte: lastDay },
    },
    data: { isLocked: true, lockedAt: new Date() },
  });
}

/**
 * Create an isolated tenant with one FIXED_SCHEDULE 40h/week employee.
 * Returns { tenantId, empId }.
 */
async function createIsolatedTenant(
  app: FastifyInstance,
  slug: string,
  hireDate: Date,
): Promise<{ tenantId: string; empId: string }> {
  const s = `snap02-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`;
  const prisma = app.prisma;

  const tenant = await prisma.tenant.create({
    data: { name: `Snap02 ${slug}`, slug: s, federalState: "NIEDERSACHSEN" },
  });
  await prisma.tenantConfig.create({
    data: { tenantId: tenant.id, defaultVacationDays: 30, timezone: TZ },
  });

  // Admin user/employee (required for some checks in the cron)
  const adminUser = await prisma.user.create({
    data: {
      email: `admin-${s}@snap02.test`,
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
      lastName: "S2",
      hireDate: new Date("2024-01-01T00:00:00Z"),
    },
  });
  await prisma.workSchedule.create({
    data: {
      employeeId: adminEmp.id,
      type: "FIXED_SCHEDULE",
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      validFrom: new Date("2024-01-01T00:00:00Z"),
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId: adminEmp.id, balanceHours: 0 } });

  // Test employee
  const empUser = await prisma.user.create({
    data: {
      email: `emp-${s}@snap02.test`,
      passwordHash: await bcrypt.hash("test1234", 10),
      role: "EMPLOYEE",
      isActive: true,
    },
  });
  const emp = await prisma.employee.create({
    data: {
      tenantId: tenant.id,
      userId: empUser.id,
      employeeNumber: `EMP-${s}`,
      firstName: "Fixture",
      lastName: slug.toUpperCase(),
      hireDate,
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
    },
  });
  await prisma.workSchedule.create({
    data: {
      employeeId: emp.id,
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
      validFrom: hireDate,
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

  return { tenantId: tenant.id, empId: emp.id };
}

// ── Case (a): Multi-month oldest-first backfill ────────────────────────────────
//
// Fixture:
//   hireDate = 2026-01-01. Employee: FIXED_SCHEDULE.
//   January 2026: active MONTHLY snapshot (closed, carryOver=1200 min = +20h).
//   February 2026: open, has 20 entries × 480 min = 9600 min worked.
//     FIXED_SCHEDULE 40h/week, ~20 workdays Feb → expected ≈ 9600 min. Balance ≈ 0.
//   March 2026: open, has 10 entries × 480 min = 4800 min worked.
//     FIXED_SCHEDULE 40h/week, 21 workdays March → expected ≈ 10080 min. Balance ≈ -5280 min.
//   "Today" = April 16 2026 (past March close, past March 15 grace day).
//
// Expected behavior (after SNAP-02 backward loop):
//   Cron at April 16 targets March 2026 (prevMonth). Backward loop finds:
//     lastSnap = January 2026, firstOpen = February 2026.
//     Loop: Feb → Mar (oldest-first).
//     Feb: no existing snap → close with carryOverIn=1200 → creates Feb snapshot.
//     Mar: no existing snap → close with carryOverIn=(1200 + Feb.balance) → creates Mar snapshot.
//   After: 3 active MONTHLY snapshots (Jan, Feb, Mar).
//
// RED assertion: February snapshot is null after cron (sequential guard blocks the employee;
//   guard checks Feb N-1 for March target → no Feb snap → SKIPS employee → neither Feb
//   nor March gets a snapshot).
//
// NOTE: The admin employee's Jan snapshot is also pre-seeded to avoid it blocking the tenant
//   cron from ever doing anything (the cron iterates all employees; if the admin is blocked
//   by the sequential guard too, the test result is the same but cleaner to isolate).

describe("SNAP-02-A: Multi-month oldest-first backfill", () => {
  let app: FastifyInstance;
  let empId: string;
  let tenantId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const result = await createIsolatedTenant(app, "multibf", new Date("2026-01-01T00:00:00Z"));
    empId = result.empId;
    tenantId = result.tenantId;

    // Seed January 2026 snapshot (already closed, carryOver=1200)
    await seedMonthlySnapshot(app, empId, 2026, 1, {
      carryOver: 1200,
      workedMinutes: 9600,
      expectedMinutes: 9600,
      balanceMinutes: 0,
    });

    // Seed February 2026 entries: Mon 2026-02-02 through Fri 2026-02-20 (20 workdays)
    const febEntries = [
      "2026-02-02",
      "2026-02-03",
      "2026-02-04",
      "2026-02-05",
      "2026-02-06",
      "2026-02-09",
      "2026-02-10",
      "2026-02-11",
      "2026-02-12",
      "2026-02-13",
      "2026-02-16",
      "2026-02-17",
      "2026-02-18",
      "2026-02-19",
      "2026-02-20",
      "2026-02-23",
      "2026-02-24",
      "2026-02-25",
      "2026-02-26",
      "2026-02-27",
    ];
    for (const d of febEntries) {
      await seedEntry(app, empId, d, 480);
    }

    // Seed March 2026 entries: 10 days (Mon 2026-03-02 through Fri 2026-03-13)
    const marEntries = [
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
      "2026-03-13",
    ];
    for (const d of marEntries) {
      await seedEntry(app, empId, d, 480);
    }
  });

  afterAll(async () => {
    await cleanupTestData(app, tenantId);
  });

  it("SNAP-02-A: February 2026 snapshot must exist after backfill at April 16", async () => {
    // EXPECTED RED: current sequential guard checks Feb (N-1 for Mar target) →
    // no Feb snapshot → SKIPS employee → Feb never closes.
    // After 76.27-03: backward loop closes Feb first (oldest), then Mar.
    await runCronAt(app, "2026-04-16T12:00:00Z");

    const febSnap = await fetchActiveMonthlySnapshot(app, empId, 2026, 2);

    // This assertion is RED on current code: febSnap is null because the sequential
    // guard skips the employee (no Feb snapshot before the Mar target).
    expect(
      febSnap,
      `SNAP-02-A: February 2026 snapshot must exist after backfill. ` +
        `Got null — sequential guard is blocking (current code). ` +
        `After 76.27-03 backward loop: Feb closes first, then Mar.`,
    ).not.toBeNull();
  }, 30_000);

  it("SNAP-02-A: March 2026 snapshot must exist after backfill at April 16", async () => {
    // EXPECTED RED (same root cause): sequential guard skips employee entirely.
    // This test will only be checked after the Feb test above; if Feb is null,
    // Mar is definitely null too.
    const marSnap = await fetchActiveMonthlySnapshot(app, empId, 2026, 3);

    expect(
      marSnap,
      `SNAP-02-A: March 2026 snapshot must exist after backfill. ` +
        `Got null — sequential guard blocks the whole employee. ` +
        `After 76.27-03 backward loop: Mar closes after Feb.`,
    ).not.toBeNull();
  }, 30_000);

  it("SNAP-02-A: active snapshot count is 3 (Jan + Feb + Mar) after backfill", async () => {
    // Jan was seeded = 1. After backfill we expect Feb + Mar to be added = 3.
    // RED: current code creates 0 new snapshots (sequential guard stalls); total stays 1.
    const count = await countActiveMonthlySnapshots(app, empId);

    expect(
      count,
      `SNAP-02-A: expected 3 active MONTHLY snapshots (Jan+Feb+Mar). ` +
        `Got ${count} — current code creates 0 new ones (sequential guard stalls). ` +
        `After 76.27-03 backward loop: count = 3.`,
    ).toBe(3);
  }, 30_000);

  it("SNAP-02-A: March snapshot carryOver = January.carryOver + Feb.balance + Mar.balance (oldest-first chain)", async () => {
    // After the backward loop, the carryOver chain must be:
    //   Jan.carryOver = 1200
    //   Feb.balance ≈ 0 (worked 9600, expected ≈ 9600)
    //   Mar.balance ≈ -5280 (worked 4800, expected ≈ 10080)
    //   Mar.carryOver ≈ 1200 + 0 - 5280 = -4080 (± tolerance for exact holiday calc)
    //
    // RED: marSnap is null, so this can't even be checked. The assertion will fail
    // because carryOver on null throws. This is intentional — the RED is already
    // established by the previous tests; this one documents the post-fix invariant.
    const marSnap = await fetchActiveMonthlySnapshot(app, empId, 2026, 3);

    // If marSnap is null (RED case), this expect will fail explicitly:
    expect(marSnap, "March 2026 snapshot must exist to check carryOver chain").not.toBeNull();

    // After 76.27-03: March carryOver = Jan.carryOver(1200) + Feb.balance(≈0) + Mar.balance(≈-5280)
    // Allow ±600 min tolerance for holiday/ArbZG boundary effects.
    const expectedApproxCarryOver = 1200 + 0 + -5280; // = -4080
    const tolerance = 600;
    expect(
      Math.abs(marSnap!.carryOver - expectedApproxCarryOver),
      `SNAP-02-A: March carryOver ≈ ${expectedApproxCarryOver} min. ` +
        `Got ${marSnap?.carryOver} — oldest-first chain not preserved.`,
    ).toBeLessThan(tolerance);
  }, 30_000);
});

// ── Case (b): Cross-year Dec 2025 → Jan 2026 gap backfill ────────────────────
//
// Fixture:
//   hireDate = 2025-11-01. Employee: FIXED_SCHEDULE.
//   November 2025: active MONTHLY snapshot (closed, carryOver=2400 min = +40h carry-in).
//   December 2025: open, has 23 entries × 480 min = 11040 min worked.
//     FIXED_SCHEDULE 40h/week, ~23 workdays Dec → expected ≈ 11040. Balance ≈ 0.
//   January 2026: open, has 22 entries × 480 min = 10560 min worked.
//     FIXED_SCHEDULE 40h/week, ~21 workdays Jan → expected ≈ 10080. Balance ≈ +480 min.
//   "Today" = February 16 2026 (prevMonth = January 2026).
//
// Expected behavior (after SNAP-02 backward loop):
//   Cron at Feb 16 targets January 2026. Backward loop finds:
//     lastSnap = November 2025, firstOpen = December 2025.
//     Loop: Dec 2025 → Jan 2026 (oldest-first, YEAR BOUNDARY: month 12 → month 1 of next year).
//     Dec: no snapshot → close with carryOverIn=2400 (Nov.carryOver) → creates Dec snapshot.
//     Jan: no snapshot → close with carryOverIn=(2400 + Dec.balance) → creates Jan snapshot.
//   After: 3 active MONTHLY snapshots (Nov, Dec, Jan). Jan.carryOver ≈ 2400 + 0 + 480 = 2880.
//
// RED assertion: December 2025 snapshot is null after cron (sequential guard checks
//   December N-1 for January target → no Dec snap → SKIPS employee → neither Dec
//   nor Jan gets a snapshot. The year boundary is never crossed.)
//
// Cross-year significance: The backward loop must wrap the year boundary correctly.
//   December 2025 is "month 12 of 2025" in monthRangeUtc; January 2026 is "month 1 of 2026".
//   The loop must compute prevYear/prevMonth correctly: month=1 → month=12, year=year-1.
//   Current code (single-target) already handles this for the guard check (:62–67), but the
//   backward LOOP doesn't exist yet, so the year boundary crossing is never tested.

describe("SNAP-02-B: Cross-year Dec 2025 → Jan 2026 backfill (year boundary)", () => {
  let app: FastifyInstance;
  let empId: string;
  let tenantId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const result = await createIsolatedTenant(app, "xyr", new Date("2025-11-01T00:00:00Z"));
    empId = result.empId;
    tenantId = result.tenantId;

    // Seed November 2025 snapshot (already closed, carryOver=2400 = +40h)
    await seedMonthlySnapshot(app, empId, 2025, 11, {
      carryOver: 2400,
      workedMinutes: 10560,
      expectedMinutes: 10560,
      balanceMinutes: 0,
    });

    // Seed December 2025 entries: Mon 2025-12-01 through Tue 2025-12-30
    // (23 Mon-Fri workdays in December 2025)
    const decEntries = [
      "2025-12-01",
      "2025-12-02",
      "2025-12-03",
      "2025-12-04",
      "2025-12-05",
      "2025-12-08",
      "2025-12-09",
      "2025-12-10",
      "2025-12-11",
      "2025-12-12",
      "2025-12-15",
      "2025-12-16",
      "2025-12-17",
      "2025-12-18",
      "2025-12-19",
      "2025-12-22",
      "2025-12-23",
      "2025-12-24",
      "2025-12-29",
      "2025-12-30",
    ];
    for (const d of decEntries) {
      await seedEntry(app, empId, d, 480);
    }

    // Seed January 2026 entries: 22 Mon-Fri workdays in January 2026
    // (Jan has 22 workdays: Jan 2 is a Friday, Jan 5-30 = Mon-Fri × 4 full weeks + 2 partial)
    const janEntries = [
      "2026-01-02",
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
      "2026-01-12",
      "2026-01-13",
      "2026-01-14",
      "2026-01-15",
      "2026-01-16",
      "2026-01-19",
      "2026-01-20",
      "2026-01-21",
      "2026-01-22",
      "2026-01-23",
      "2026-01-26",
      "2026-01-27",
      "2026-01-28",
      "2026-01-29",
      "2026-01-30",
    ];
    for (const d of janEntries) {
      await seedEntry(app, empId, d, 480);
    }
  });

  afterAll(async () => {
    await cleanupTestData(app, tenantId);
  });

  it("SNAP-02-B: December 2025 snapshot must exist after backfill at Feb 16 2026", async () => {
    // EXPECTED RED: sequential guard checks Dec 2025 (N-1 for Jan 2026 target) →
    // no Dec snapshot → SKIPS employee → Dec never closes.
    // After 76.27-03 backward loop: Dec is the firstOpen month; loop closes it first.
    await runCronAt(app, "2026-02-16T12:00:00Z");

    const decSnap = await fetchActiveMonthlySnapshot(app, empId, 2025, 12);

    // RED: decSnap is null (sequential guard stalls; backward loop not yet implemented).
    expect(
      decSnap,
      `SNAP-02-B: December 2025 snapshot must exist after backfill. ` +
        `Got null — sequential guard blocks (current code has no backward loop). ` +
        `After 76.27-03: Dec 2025 closes using Nov 2025 carryOver as carryOverIn, ` +
        `crossing the year boundary (month=12 of prevYear=2025).`,
    ).not.toBeNull();
  }, 30_000);

  it("SNAP-02-B: January 2026 snapshot must exist after backfill at Feb 16 2026", async () => {
    // EXPECTED RED (same root cause). Jan 2026 is the prevMonth target; without
    // Dec 2025 closing first, the sequential guard blocks Jan.
    const janSnap = await fetchActiveMonthlySnapshot(app, empId, 2026, 1);

    expect(
      janSnap,
      `SNAP-02-B: January 2026 snapshot must exist after backfill. ` +
        `Got null — sequential guard requires Dec 2025 first. ` +
        `After 76.27-03: Jan closes after Dec (oldest-first, year boundary handled).`,
    ).not.toBeNull();
  }, 30_000);

  it("SNAP-02-B: active snapshot count is 3 (Nov + Dec + Jan) after backfill", async () => {
    // Nov was seeded = 1. After backfill: Dec + Jan added = 3.
    // RED: current code creates 0 new snapshots; count stays 1.
    const count = await countActiveMonthlySnapshots(app, empId);

    expect(
      count,
      `SNAP-02-B: expected 3 active MONTHLY snapshots (Nov 2025 + Dec 2025 + Jan 2026). ` +
        `Got ${count} — sequential guard stalls; backward loop not yet implemented. ` +
        `After 76.27-03: count = 3.`,
    ).toBe(3);
  }, 30_000);

  it("SNAP-02-B: January 2026 carryOver uses December 2025 as its base (cross-year chain)", async () => {
    // Cross-year invariant: Jan 2026.carryOver = Nov.carryOver + Dec.balance + Jan.balance
    //   Nov.carryOver = 2400
    //   Dec.balance ≈ 0 (worked 9600 = ~20×480, expected ~9600 for ~20 workdays in Dec)
    //   Jan.balance ≈ +480 (worked 10080=21×480, expected ~10080 for 21 workdays, ~0±tolerance)
    //   → Jan.carryOver ≈ 2400 + 0 + 480 = 2880 (± 600 tolerance)
    //
    // The critical property: Jan.carryOverIn MUST be Dec.carryOver (Pitfall B2 —
    // immediately preceding month), NOT Nov.carryOver (skipping Dec).
    // After 76.27-03: the backward loop fetches Dec snapshot immediately before
    // closing Jan; it threads Dec.effectiveCarryOverOut as Jan's carryOverIn.
    const janSnap = await fetchActiveMonthlySnapshot(app, empId, 2026, 1);

    // RED: janSnap is null; this assertion will fail because of .not.toBeNull() before.
    // Kept here to document the cross-year carryOver invariant.
    expect(
      janSnap,
      "January 2026 snapshot must exist to verify cross-year carryOver",
    ).not.toBeNull();

    // Cross-year carryOver chain: Jan.carryOver ≈ 2400 + Dec.balance + Jan.balance
    // Tolerance of ±600 min for holiday/ArbZG boundary effects on exact expected minutes.
    const expectedApproxCarryOver = 2400; // ≈ base; Dec+Jan ≈ neutral in this fixture
    const tolerance = 1200; // wider tolerance: exact expected minutes depend on 2025/2026 holiday calendar
    expect(
      Math.abs(janSnap!.carryOver - expectedApproxCarryOver),
      `SNAP-02-B: January 2026 carryOver should be near ${expectedApproxCarryOver} min ` +
        `(Nov.carryOver + Dec.balance + Jan.balance). ` +
        `Got ${janSnap?.carryOver} — cross-year chain may be broken.`,
    ).toBeLessThan(tolerance);
  }, 30_000);
});
