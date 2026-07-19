/**
 * SNAP-04: Bridge/zero snapshot preservation + idempotency + superseded:false filter.
 *
 * Wave 0 — RED-first scaffold. These tests MUST FAIL against current code.
 * They turn GREEN after the SNAP-02 backward backfill loop (plan 76.27-03).
 *
 * Bridge snapshots are opening-balance rows created to carry an initial balance
 * forward without recording actual work. They have:
 *   expectedMinutes = 0, workedMinutes = 0, balanceMinutes = 0, carryOver ≠ 0.
 * They must NEVER be superseded by the backfill loop — the idempotency check
 * (existingSnap → skip + thread carryOver) is the guard.
 *
 * Test cases:
 *
 * Case (a) — Bridge preservation:
 *   Seed a bridge snapshot for month M (expectedMinutes=0, workedMinutes=0,
 *   balanceMinutes=0, carryOver=X≠0, superseded=false). Invoke the cron backfill.
 *   Assert: bridge snapshot row unchanged (superseded still false, same id, same carryOver).
 *   Assert: NO new snapshot was created for month M (idempotency skipped it).
 *   Assert: month M+1 close uses X as its carryOverIn (bridge carryOver threaded correctly).
 *
 * Case (b) — Idempotency:
 *   Run the backfill twice (same invocation simulated by running cron twice at the same date).
 *   Assert: count of superseded=false rows per month stays 1 (no duplicates).
 *   Assert: no superseded=true rows were created by the second run (idempotent no-op).
 *
 * Why RED on current code:
 *   The current cron (auto-close-month.ts) does NOT have a backward loop. It only
 *   targets `prevMonth` and skips employees if N-1 is open (sequential guard). When
 *   an employee has a gap of 2+ months (bridge + open), the current cron cannot close
 *   the open month because the sequential guard blocks on the missing intermediate month.
 *   The tests assert that BOTH months get resolved by the backfill — the bridge is
 *   preserved (skipped) and the next real open month is closed. Current code does
 *   neither: bridge months are not detected as "existing active snapshot, skip+thread"
 *   because the backward loop doesn't exist yet.
 *
 *   Specifically: after the backfill, we assert a new MONTHLY snapshot exists for the
 *   month AFTER the bridge (with carryOver threading from the bridge). Current code
 *   cannot produce this snapshot because the sequential guard blocks it.
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

/** Fetch active MONTHLY snapshot for a specific month (superseded=false, B5 filter). */
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
      periodStart: periodStartWindow(start), // B5: always filter superseded=false
      superseded: false,
    },
  });
}

/** Create an isolated tenant with one FIXED_SCHEDULE employee. */
async function createTenant(
  app: FastifyInstance,
  slug: string,
  hireDate: Date,
): Promise<{ tenantId: string; empId: string }> {
  const s = `snap04-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`;
  const prisma = app.prisma;

  const tenant = await prisma.tenant.create({
    data: { name: `Snap04 ${slug}`, slug: s, federalState: "NIEDERSACHSEN" },
  });
  await prisma.tenantConfig.create({
    data: { tenantId: tenant.id, defaultVacationDays: 30, timezone: TZ },
  });

  const adminUser = await prisma.user.create({
    data: {
      email: `admin-${s}@snap04.test`,
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
      lastName: "S4",
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
      email: `emp-${s}@snap04.test`,
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

// ── Case (a): Bridge snapshot preservation ────────────────────────────────────
//
// Fixture:
//   hireDate = 2026-01-01. Employee: FIXED_SCHEDULE.
//   January 2026: bridge snapshot (E=0, W=0, B=0, carryOver=3000 min, superseded=false).
//   February 2026: open, has 20 entries × 480 min = 9600 min worked.
//     Expected (FIXED 40h/week × 20 workdays) ≈ 9600 min. Balance ≈ 0.
//   "today" = March 16 2026 (cron targets February as prevMonth).
//
// Expected backfill behaviour (after SNAP-02 loop):
//   1. Loop finds firstOpenMonth = February 2026 (January has active bridge snapshot).
//   2. Idempotency check for January: existingSnap (bridge) found → skip + thread carryOver=3000.
//   3. Close February: carryOverIn=3000, balance≈0 → Feb snapshot created with carryOver=3000.
//   4. Bridge January snapshot remains: superseded=false, same id, carryOver=3000.
//
// Why RED on current code:
//   Current cron only targets prevMonth=February. Sequential guard checks January — finds
//   the bridge snapshot (superseded=false, Jan periodStart) — so the guard PASSES (Jan active).
//   Cron DOES attempt to close February. BUT: Feb has 20 entries × 480 = 9600 min, and cron
//   checks completeness (all Mon–Fri covered). If completeness passes, Feb IS closed.
//   So the BRIDGE PRESERVATION test may actually PASS on current code for this case.
//
//   The RED assertions are:
//   (1) The next-month carryOver uses the BRIDGE's carryOver (3000) as base — this is correct
//       if the cron reads prevSnapshot.carryOver for Jan and gets 3000. May already work.
//   (2) The bridge snapshot itself is not touched (not superseded, same row) — correct if
//       the cron only creates new rows (not updates). Already correct.
//
//   TRUE RED comes from case where 2+ open months with bridge in between:
//   Bridge month = January. Gap month = February (open, no entries). Target = March (entries).
//   Current cron targets February (prevMonth of March cron run). Sequential guard checks Jan:
//   bridge exists → passes. Attempts Feb close. But Feb has NO entries → completeness fails.
//   Cron SKIPS Feb close → March stays open. The backfill loop should close Feb with gaps
//   (or when gap gate is relaxed), then close March.
//
// Adjusted fixture for confirmed RED:
//   January: bridge (carryOver=3000). February: open, ZERO entries (incomplete).
//   March: entries for all workdays (complete). "today" = April 16.
//   Assertion: after backfill cron (April 16), March has an active snapshot with carryOver
//   threading from the bridge through February.
//   Current code: cron targets March (prevMonth of April). Sequential guard checks Feb: no
//   active Feb snapshot → guard FAILS → March skipped. RED: no March snapshot exists.

describe("SNAP-04-A — bridge preservation: bridge snapshot preserved + carryOver threaded to next real close", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;
  let bridgeSnapId: string;

  const HIRE_DATE = new Date("2026-01-01T00:00:00Z");

  // Bridge Jan carryOver: 3000 min (+50h carry-in balance from before tracking start)
  const BRIDGE_CARRY_OVER = 3000;

  // March workdays: all Mon–Fri in March 2026 (22 workdays)
  const MARCH_WORKDAYS = (() => {
    const out: string[] = [];
    const cur = new Date("2026-03-02T00:00:00Z");
    const end = new Date("2026-03-31T00:00:00Z");
    while (cur <= end) {
      const dow = cur.getUTCDay();
      if (dow >= 1 && dow <= 5) out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  })();

  beforeAll(async () => {
    app = await getTestApp();
    const fixture = await createTenant(app, "bridge-pres", HIRE_DATE);
    tenantId = fixture.tenantId;
    empId = fixture.empId;

    // Seed January 2026 bridge snapshot:
    //   expectedMinutes=0, workedMinutes=0, balanceMinutes=0, carryOver=3000, superseded=false.
    //   This is the "opening balance" pattern (project_pretracking_saldo_pattern MEMORY).
    const { start: janStart, end: janEnd } = monthRangeUtc(2026, 1, TZ);
    const bridgeSnap = await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: empId,
        periodType: "MONTHLY",
        periodStart: janStart,
        periodEnd: janEnd,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: BRIDGE_CARRY_OVER, // non-zero — this is the key bridge invariant
        closedAt: new Date("2026-01-31T23:00:00Z"),
        closedBy: "snap04-bridge-seed",
        superseded: false,
      },
    });
    bridgeSnapId = bridgeSnap.id;

    // February 2026: open, ZERO entries (incomplete — cron completeness check will block close).
    // No entries seeded for February → Feb stays gapful.

    // March 2026: all Mon–Fri workdays have entries (complete).
    for (const d of MARCH_WORKDAYS) {
      await seedEntry(app, empId, d, 480);
    }
  }, 300_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("SNAP-04-A cleanup:", err);
    }
    vi.useRealTimers();
  });

  it(// RED on current code: sequential guard at auto-close-month.ts:138–169 checks whether
  // the month N-1 (February) has an active snapshot. February is open (no snapshot) →
  // guard FAILS → March is skipped → no March snapshot created.
  // After SNAP-02 backward loop: loop starts from firstOpenMonth=February, skips it
  // (incomplete, gap-block → break for now), but actually we need gap-gate relaxation
  // for this scenario. Without 76.28, the loop ALSO stalls at February gap.
  // HOWEVER: the assertion tests that AFTER the cron runs, a March snapshot exists with
  // carryOver chained from the bridge. Current code produces ZERO March snapshot → RED.
  // Note: this may require 76.28 gate relaxation to go fully green; the RED is confirmed
  // against the CURRENT code (no backward loop, sequential guard blocks March).
  "cron backfill creates March snapshot with carryOver threading from bridge January", async () => {
    // Run cron targeting March (prevMonth of April 16)
    await runCronAt(app, "2026-04-16T06:00:00.000Z");

    // Assert March snapshot exists and is active (superseded=false, B5 filter)
    const marchSnap = await fetchActiveMonthlySnapshot(app, empId, 2026, 3);
    expect(
      marchSnap,
      "March 2026 snapshot must exist after backfill (sequential guard blocked it on current code — RED)",
    ).not.toBeNull();

    // Assert carryOver chain: March snapshot should thread from bridge (Jan.carryOver=3000)
    // through February (balance≈0) → March.carryOver ≈ 3000 + marchBalance.
    if (marchSnap) {
      expect(
        marchSnap.carryOver,
        `March carryOver must be near bridge(${BRIDGE_CARRY_OVER}) + Feb(0) + March balance; superseded=false (B5)`,
      ).toBeGreaterThanOrEqual(BRIDGE_CARRY_OVER - 600); // ±600 min tolerance for March balance
    }
  }, 120_000);

  it(// Assert the bridge January snapshot was NOT superseded by the backfill.
  // Bridge snapshots must be preserved (skipped, not re-closed) — RESEARCH §3.3.
  "bridge January snapshot remains superseded=false after cron backfill (Pitfall B3)", async () => {
    const bridgeSnapAfter = await app.prisma.saldoSnapshot.findUnique({
      where: { id: bridgeSnapId },
    });

    expect(bridgeSnapAfter, "bridge snapshot must still exist (not hard-deleted)").not.toBeNull();
    expect(
      bridgeSnapAfter?.superseded,
      "bridge snapshot must still be superseded=false (not touched by backfill, Pitfall B3)",
    ).toBe(false);
    expect(
      bridgeSnapAfter?.carryOver,
      "bridge snapshot carryOver must be unchanged (still 3000 min)",
    ).toBe(BRIDGE_CARRY_OVER);
  }, 30_000);

  it(// Assert NO duplicate active snapshot was created for January (idempotency).
  // The backfill loop must detect the existing bridge and skip (not supersede-then-create).
  "no duplicate active January snapshot after backfill — idempotency: one active row per month (B5 filter)", async () => {
    const { start: janStart } = monthRangeUtc(2026, 1, TZ);
    const activeJanCount = await app.prisma.saldoSnapshot.count({
      where: {
        employeeId: empId,
        periodType: "MONTHLY",
        periodStart: periodStartWindow(janStart), // B5: always filter superseded=false
        superseded: false,
      },
    });

    expect(
      activeJanCount,
      "exactly 1 active January snapshot must exist (bridge preserved, no duplicate created)",
    ).toBe(1);
  }, 30_000);
});

// ── Case (b): Idempotency — double backfill creates no extra rows ─────────────
//
// Fixture:
//   hireDate = 2026-01-01. Employee: FIXED_SCHEDULE.
//   December 2025: seed snapshot (closed, carryOver=0). This anchors rangeStart to Jan 1.
//   January 2026: all Mon–Fri entries (complete). Active snapshot will be created by first cron.
//   February 2026: all Mon–Fri entries (complete). Active snapshot will be created by first cron.
//   "today" = March 16 2026.
//
//   Run cron twice at 2026-03-16 (both target February as prevMonth).
//   After first run: Feb snapshot created (1 active row for Feb).
//   After second run: Feb already has active snapshot → idempotency check → skip → no new row.
//   Assert: count of superseded=false rows for Feb = 1 (still, after second run).
//   Assert: count of superseded=true rows for Feb = 0 (second run didn't supersede and recreate).

describe("SNAP-04-B — idempotency: double backfill run creates no additional active snapshots", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;

  const HIRE_DATE = new Date("2026-01-01T00:00:00Z");

  // January Mon–Fri workdays
  const JAN_WORKDAYS = (() => {
    const out: string[] = [];
    const cur = new Date("2026-01-02T00:00:00Z");
    const end = new Date("2026-01-31T00:00:00Z");
    while (cur <= end) {
      const dow = cur.getUTCDay();
      if (dow >= 1 && dow <= 5) out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  })();

  // February Mon–Fri workdays
  const FEB_WORKDAYS = (() => {
    const out: string[] = [];
    const cur = new Date("2026-02-02T00:00:00Z");
    const end = new Date("2026-02-28T00:00:00Z");
    while (cur <= end) {
      const dow = cur.getUTCDay();
      if (dow >= 1 && dow <= 5) out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  })();

  // Active snapshot counts after first and second cron runs
  let activeCountAfterFirst = 0;
  let activeCountAfterSecond = 0;

  beforeAll(async () => {
    app = await getTestApp();
    const fixture = await createTenant(app, "idempotency", HIRE_DATE);
    tenantId = fixture.tenantId;
    empId = fixture.empId;

    // Dec 2025 snapshot anchors the chain (rangeStart = Jan 1 2026)
    const { start: decStart, end: decEnd } = monthRangeUtc(2025, 12, TZ);
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: empId,
        periodType: "MONTHLY",
        periodStart: decStart,
        periodEnd: decEnd,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date("2026-01-01T06:00:00Z"),
        closedBy: "snap04-b-seed",
      },
    });

    // January: complete entries
    for (const d of JAN_WORKDAYS) {
      await seedEntry(app, empId, d, 480);
    }

    // February: complete entries
    for (const d of FEB_WORKDAYS) {
      await seedEntry(app, empId, d, 480);
    }

    // Run cron FIRST time (targets February as prevMonth of March 16)
    await runCronAt(app, "2026-03-16T06:00:00.000Z");
    activeCountAfterFirst = await countActiveMonthlySnapshots(app, empId);

    // Run cron SECOND time (same date — idempotency check)
    await runCronAt(app, "2026-03-16T06:00:00.000Z");
    activeCountAfterSecond = await countActiveMonthlySnapshots(app, empId);
  }, 300_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("SNAP-04-B cleanup:", err);
    }
    vi.useRealTimers();
  });

  it(// After first cron run: January (via sequential guard pass from Dec snapshot) and
  // February should both have active snapshots. Active count = Dec(1) + Jan(1) + Feb(1) = 3.
  // Note: Dec snapshot was seeded manually, not by cron. Jan and Feb closed by cron.
  // Current code: sequential guard checks Jan. Dec snapshot exists → guard passes → Jan...
  // wait, the cron targets Feb as prevMonth. Sequential guard checks Jan (N-1 of Feb):
  // Dec snapshot exists → Jan has no active snapshot? No — the guard checks N-1=January.
  // If January has no active snapshot, the guard FAILS and February is skipped.
  // So the cron first needs to close January (target=Jan prevMonth of Feb cron at March 16?
  // No — cron at March 16 targets February (prevMonth = February for a March date).
  // Guard checks January: Jan has no snapshot (only Dec was seeded) → guard FAILS → Feb skipped.
  // RED: after first cron run, activeCount might only be 1 (just Dec, no Jan or Feb closed).
  // The backward loop (SNAP-02) would close Jan then Feb sequentially.
  "after first cron run: active monthly snapshot count is ≥ 3 (Dec + Jan + Feb all closed)", async () => {
    // Current code (no backward loop): only Dec seeded manually, cron skips Feb because Jan
    // has no snapshot. activeCountAfterFirst = 1 (just Dec). RED.
    // After SNAP-02: backward loop closes Jan then Feb → activeCount = 3. GREEN.
    expect(
      activeCountAfterFirst,
      `active snapshot count after first cron run must be ≥ 3 (Dec+Jan+Feb); current code skips Jan+Feb → RED`,
    ).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it(// After SECOND cron run at same date: count must NOT increase (idempotency).
  // Each month should still have exactly 1 active snapshot (no duplicates).
  "after second cron run at same date: active count unchanged — idempotent re-run skips existing snapshots", async () => {
    // Idempotency: second run finds existing active snapshots → skips → no new rows.
    expect(
      activeCountAfterSecond,
      `active snapshot count must be identical after second cron run (idempotency). Before: ${activeCountAfterFirst}, After: ${activeCountAfterSecond}`,
    ).toBe(activeCountAfterFirst);
  }, 30_000);

  it(// Superseded count for February must be 0 after second run.
  // If idempotency is broken, second run would supersede the existing Feb snapshot and create
  // a new one → one superseded=true row and one superseded=false row.
  "no superseded=true February snapshot after second cron run — second run did NOT re-close (B5 filter)", async () => {
    const { start: febStart } = monthRangeUtc(2026, 2, TZ);
    const supersededFebCount = await app.prisma.saldoSnapshot.count({
      where: {
        employeeId: empId,
        periodType: "MONTHLY",
        periodStart: periodStartWindow(febStart),
        superseded: true, // explicitly checking for superseded rows
      },
    });

    // If idempotency works: 0 superseded Feb rows.
    // If broken: ≥1 superseded Feb row (second run superseded the first close).
    expect(
      supersededFebCount,
      "superseded=true February snapshot count must be 0 — second cron run must not re-close an already-closed month",
    ).toBe(0);
  }, 30_000);

  it(// Explicit: each month (Dec, Jan, Feb) has exactly 1 active snapshot (B5: superseded=false).
  // This is the minimal correctness invariant for the idempotency guarantee.
  "each closed month (Dec, Jan, Feb) has exactly 1 active snapshot — superseded=false count per month = 1", async () => {
    for (const [year, month, label] of [
      [2025, 12, "December 2025"] as const,
      [2026, 1, "January 2026"] as const,
      [2026, 2, "February 2026"] as const,
    ]) {
      const { start } = monthRangeUtc(year, month, TZ);
      const activeCount = await app.prisma.saldoSnapshot.count({
        where: {
          employeeId: empId,
          periodType: "MONTHLY",
          periodStart: periodStartWindow(start),
          superseded: false, // B5: always filter superseded=false in assertions
        },
      });
      expect(
        activeCount,
        `${label}: exactly 1 active (superseded=false) snapshot expected after idempotency test`,
      ).toBe(1);
    }
  }, 30_000);
});
