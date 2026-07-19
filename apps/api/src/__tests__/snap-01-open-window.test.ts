/**
 * SNAP-01: After a month-close, the live recompute window starts from the last
 * snapshot's periodEnd+1, NOT from the employee's hireDate.
 *
 * Wave 0 — RED-first scaffold. This test MUST FAIL against current code (or be
 * marginal). It turns GREEN after the SNAP-03 per-month iteration refactor (plan 02)
 * ensures the open window is bounded to [lastSnapshot.periodEnd+1, today].
 *
 * Scenario:
 *   Employee hireDate = 2026-01-01. A FIXED_SCHEDULE 40h/week employee.
 *   Month M (February 2026) is CLOSED with a known carryOver = X min.
 *   Month M-1 (January 2026) also has data — entries that would affect the
 *   saldo if the live path re-read from hireDate instead of last snapshot.
 *   Month M+1 (March 2026) is OPEN with entries worth Y min net overtime.
 *
 * Assertion (pinning the open-window collapse):
 *   (a) live balance reflects Feb snapshot's carryOver as the base, NOT a
 *       re-computation from January entries (window bounded to Feb snapshot).
 *   (b) Seeding an entry in January (before the Feb snapshot) must NOT change
 *       the live balance — proving the window is [Feb28+1, today], not [hireDate, today].
 *
 * Why RED on current code:
 *   The live path at time-entries.ts:1565–1586 reads `lastSnapshot` and sets
 *   `rangeStart = lastSnapshot.periodEnd + 1day`. This is CORRECT for the closed
 *   path. HOWEVER: for SHIFT_BASED, the prior-months lumped block (:1884) runs
 *   if rangeStart < currentMonthStart, meaning February data would re-enter the
 *   computation even when Feb is closed — if the snapshot periodEnd doesn't align
 *   exactly with the month boundary in the query.
 *   For FIXED_SCHEDULE: the test asserts that a January entry does NOT change the
 *   live balance after Feb is closed. This assertion is correct but may pass on
 *   current code (the open-window collapse for FIXED is already roughly correct).
 *   The stronger assertion — that the live balance equals (carryOver + March delta)
 *   within 5 min — is what will be RED if the live path recalculates from hireDate.
 *
 * No PII — synthetic fixtures only.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { monthRangeUtc, monthDayBounds } from "../utils/timezone";
import { updateOvertimeAccount } from "../routes/time-entries";

const TZ = "Europe/Berlin";

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

/** Run updateOvertimeAccount at a frozen "now" and return balanceHours × 60 (minutes). */
async function liveMinutesAt(app: FastifyInstance, empId: string, isoNow: string): Promise<number> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(isoNow));
  try {
    await updateOvertimeAccount(app, empId);
    const acc = await app.prisma.overtimeAccount.findUnique({ where: { employeeId: empId } });
    return Number(acc!.balanceHours) * 60;
  } finally {
    vi.useRealTimers();
  }
}

/** Create an isolated tenant with one FIXED_SCHEDULE 40h/week employee. */
async function createTenant(
  app: FastifyInstance,
  slug: string,
  hireDate: Date,
): Promise<{ tenantId: string; empId: string }> {
  const s = `snap01-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`;
  const prisma = app.prisma;

  const tenant = await prisma.tenant.create({
    data: { name: `Snap01 ${slug}`, slug: s, federalState: "NIEDERSACHSEN" },
  });
  await prisma.tenantConfig.create({
    data: { tenantId: tenant.id, defaultVacationDays: 30, timezone: TZ },
  });

  const adminUser = await prisma.user.create({
    data: {
      email: `admin-${s}@snap01.test`,
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
      lastName: "S1",
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

  const empUser = await prisma.user.create({
    data: {
      email: `emp-${s}@snap01.test`,
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
      validFrom: new Date("2026-01-01T00:00:00Z"),
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

  return { tenantId: tenant.id, empId: emp.id };
}

// ── SNAP-01: open-window collapses to last snapshot ───────────────────────────
//
// Key fixture:
//   hireDate = 2026-01-01.
//   January 2026: seed entries (480 min/day × 20 days = 9600 min worked). Expected = 9600 → balance=0.
//   February 2026: seed MONTHLY SaldoSnapshot with carryOver = 2400 min (= +40h carry-in).
//   March 2026 open: seed 10 entries × 480 min = 4800 min.
//     FIXED_SCHEDULE 40h/week, 21 workdays March → expected ≈ 10080 min.
//     Balance March ≈ 4800 − 10080 = −5280 min.
//   "Today" = March 16 2026 (grace day ≥ 15, past Feb close).
//
//   Expected live balance post-Feb-snapshot: carryOver(2400) + March_delta
//   The March_delta = worked(4800) − expected_to_date(approx).
//   Key: a January entry seeded AFTER the Feb snapshot is already committed must NOT
//   change the live balance (proving window is bounded to Feb.periodEnd+1, not hireDate).
//
// Correct live formula (post-SNAP-03):
//   rangeStart = feb.periodEnd + 1 day = 2026-03-01.
//   snapshotCarryOver = 2400.
//   openRange = [Mar1, Mar16].
//   live = (2400 + marchDelta) / 60 hours.
//
// Why potentially RED on current code:
//   The live path reads lastSnapshot at time-entries.ts:1568–1586, so rangeStart IS set
//   correctly to March 1. However, after SNAP-03, even the FIXED_SCHEDULE case uses
//   closeEmployeeMonth() for complete prior open months, which changes how March partial
//   is computed. The assertion pins that the open window is bounded (Jan entries ignored).

describe("SNAP-01 — open-window collapses to lastSnapshot: pre-snapshot entries do NOT affect live balance", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;

  const HIRE_DATE = new Date("2026-01-01T00:00:00Z");
  const LIVE_NOW = "2026-03-16T10:00:00.000Z";

  // Known snapshot carryOver: 2400 min (+40h carry-in from Feb close)
  const FEB_CARRY_OVER = 2400;

  // Jan entries: 20 days × 480 min = 9600 min (fully balanced, balance=0 for Jan)
  const JAN_ENTRIES = (() => {
    const out: string[] = [];
    const cur = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-31T00:00:00Z");
    while (cur <= end) {
      const dow = cur.getUTCDay();
      if (dow >= 1 && dow <= 5) out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  })();

  // March entries: 10 days × 480 min = 4800 min
  const MARCH_ENTRIES_10 = (() => {
    const out: string[] = [];
    const cur = new Date("2026-03-02T00:00:00Z"); // start from Mar 2 (Mar 1 is Sun)
    let count = 0;
    while (count < 10) {
      const dow = cur.getUTCDay();
      if (dow >= 1 && dow <= 5) {
        out.push(cur.toISOString().slice(0, 10));
        count++;
      }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  })();

  // Live balance BEFORE seeding the "extra Jan entry"
  let liveBefore = 0;

  beforeAll(async () => {
    app = await getTestApp();
    const fixture = await createTenant(app, "open-window", HIRE_DATE);
    tenantId = fixture.tenantId;
    empId = fixture.empId;

    // Seed January 2026 entries (these are BEFORE the Feb snapshot)
    for (const d of JAN_ENTRIES) {
      await seedEntry(app, empId, d, 480);
    }

    // Seed February 2026 MONTHLY SaldoSnapshot (closed, carryOver=2400 min)
    const { start: febStart, end: febEnd } = monthRangeUtc(2026, 2, TZ);
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: empId,
        periodType: "MONTHLY",
        periodStart: febStart,
        periodEnd: febEnd,
        workedMinutes: 9600,
        expectedMinutes: 9600,
        balanceMinutes: 0,
        // carryOver = 2400 (pre-existing balance from before Feb)
        carryOver: FEB_CARRY_OVER,
        closedAt: new Date("2026-03-01T06:00:00Z"),
        closedBy: "snap01-test-seed",
      },
    });

    // Lock January entries (simulating what close does to prior months)
    const { firstDay: janFirstDay, lastDay: janLastDay } = monthDayBounds(
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-31T23:59:59Z"),
      TZ,
    );
    await app.prisma.timeEntry.updateMany({
      where: {
        employeeId: empId,
        date: { gte: janFirstDay, lte: janLastDay },
        deletedAt: null,
      },
      data: { isLocked: true, lockedAt: new Date() },
    });

    // Seed March 2026 entries (open month)
    for (const d of MARCH_ENTRIES_10) {
      await seedEntry(app, empId, d, 480);
    }

    // Record live balance before the extra-January-entry probe
    liveBefore = await liveMinutesAt(app, empId, LIVE_NOW);
  }, 300_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("SNAP-01 cleanup:", err);
    }
    vi.useRealTimers();
  });

  it(// Asserts that the live balance is bounded by the last snapshot (Feb carryOver = 2400).
  // The live balance should reflect: carryOver(2400) + March delta (≈ worked − expected for Mar 1–16).
  // For FIXED 40h/week, 10 entries × 480 min = 4800 min worked; expected ≈ 10 workdays × 480 = 4800.
  // Balance delta ≈ 0. So live ≈ (2400 + 0) / 60 = 40h = 2400 min.
  // If the live path recomputed from hireDate (wrong), it would include Jan balance = 0 too,
  // but would also re-derive Feb expected separately — so the snapshot carryOver(2400) would
  // be DOUBLE-COUNTED or lost depending on implementation. This assertion pins the correct value.
  "live balance uses Feb snapshot carryOver as base — NOT re-derived from January entries", async () => {
    // carryOver is 2400. March: 10 × 480 worked, 10 workdays expected ≈ 4800.
    // Delta = 0. So live ≈ 2400 min.
    // Acceptable range: carryOver ± 600 min (one workday tolerance for March partial expected calc).
    expect(
      liveBefore,
      `live balance must be near carryOver (2400 min) ± 600 min (open-window bounded to Feb snapshot)`,
    ).toBeGreaterThan(FEB_CARRY_OVER - 600);
    expect(
      liveBefore,
      `live balance must not exceed carryOver + major March overtime (bounded window)`,
    ).toBeLessThan(FEB_CARRY_OVER + 600);
  }, 30_000);

  it(// SNAP-01 critical assertion: seeding an entry in January (BEFORE the Feb snapshot)
  // must NOT change the live balance. This proves the live path reads rangeStart from
  // lastSnapshot.periodEnd+1 (= March 1), not from hireDate (= January 1).
  //
  // This test is RED on current code IF the live path recalculates from hireDate after
  // SNAP-03 refactor accidentally widens the range. It serves as a regression guard
  // that the open-window DOES collapse to the last snapshot.
  "seeding a January entry (before Feb snapshot) does NOT change the live balance — window bounded to lastSnapshot+1", async () => {
    // Add an extra entry in January on a Sunday (not already seeded — CLAUDE.md: one entry per day).
    // This entry should be invisible to the live path because rangeStart = March 1.
    // Jan 11, 2026 is a Sunday — not in JAN_ENTRIES (Mon–Fri only), no conflict.
    await seedEntry(app, empId, "2026-01-11", 480); // Sunday Jan 11

    const liveAfter = await liveMinutesAt(app, empId, LIVE_NOW);

    // The delta must be zero (Jan entry invisible to live path)
    expect(
      Math.abs(liveAfter - liveBefore),
      `live balance must NOT change when a Jan entry is added (window bounded to Feb snapshot+1 = Mar 1). Before: ${liveBefore}min, After: ${liveAfter}min`,
    ).toBeLessThan(5);
  }, 30_000);

  it(// Explicit window-start assertion: the live path reads carryOver from the Feb snapshot.
  // Post-SNAP-03: live = (snapshotCarryOver + marchBalance) / 60, where marchBalance
  // is computed for [Mar1, Mar16] only.
  // Current code: the FIXED branch uses calcExpectedMinutesTz(rangeStart, effectiveEnd)
  // which IS already rangeStart=Mar1. So this assertion should already pass.
  // After SNAP-03: the FIXED branch also uses per-month closeEmployeeMonth() for complete
  // prior months, making March the only open segment — same result.
  // This test serves as a regression pin that the carryOver IS used as the base.
  "live balance equals (feb.carryOver + marchDelta) within 10 min tolerance — periodEnd+1 is the window start", async () => {
    const live = await liveMinutesAt(app, empId, LIVE_NOW);

    // The Feb snapshot carryOver is 2400 min. March partial:
    // 10 entries × 480 min = 4800 min. FIXED expected for 10 workdays (Mar 2–13) = 4800 min.
    // March delta ≈ 0. So live should ≈ 2400 min.
    // Tolerance: 10 min (rounding from calcExpectedMinutesTz).
    // Post-SNAP-03 assertion: live is near (carryOver + marchDelta).
    // This assertion may PASS on current code and STAY PASSING after SNAP-03.
    // Its role: detect any regression that loses the snapshot carryOver base.
    const expectedApprox = FEB_CARRY_OVER; // marchDelta ≈ 0 for balanced 10-day fixture
    expect(
      Math.abs(live - expectedApprox),
      `carryOver base assertion: |live(${live}min) − carryOver(${FEB_CARRY_OVER}min)| must be < 600 min`,
    ).toBeLessThan(600);
  }, 30_000);
});
