/**
 * SALDO-V1816-03 + SALDO-V1816-04: SHIFT_BASED Model B + § 615 — four-path parity test.
 *
 * Asserts: close-1 == close-2 == recalc, and live (post-close) == snapshot.carryOver / 60.
 *
 * The four saldo paths share one calcShiftBasedSaldo helper (D-07). This test verifies
 * they produce identical results across 7 fixtures (A–G).
 *
 * Close method per fixture:
 *   A, B, E, F: cron auto-close (all workdays have entries → completeness gate satisfied)
 *   C, D, G:    manual API close (missing entries by design — cron completeness gate
 *               blocks auto-close; manual API has no such gate by design per CLAUDE.md)
 *
 * Together the 7 fixtures + cron-tested A/B prove all four paths are code-identical.
 *
 * V-03-A (live parity): live balance is checked AFTER closing February. At that point
 * updateOvertimeAccount runs over the March open range (LIVE_NOW = March 16, no March
 * shifts/entries). § 615: R=0, W=0, C_mar > 0 → max(0,0-C) - max(0,0-0) = 0.
 * Total = snapshotCarryOver/60 + 0 = carryOver/60. So live == snapshot.carryOver/60.
 *
 * Fixture arithmetic (Phase 76.22 RESEARCH.md § "Test fixtures"):
 *   Schedule: weeklyHours=38, Mon–Fri, SHIFT_BASED, breakOver6hOverride=0 (no breaks).
 *   February 2026: 20 Mon–Fri workdays (no NI holidays). C = round(38×60×20/5) = 9120 min.
 *
 *   A phantom-fix:       0 shifts, 20×456min entries → expectedMinutes=9120, balance=0
 *   B overtime:          20×495 shifts, W=9900        → balance=+780 (W>C)
 *   C rostered-not-worked: 5×450 shifts, W=1350       → balance=−900 (employee fault)
 *   D §615 never-rostered: R=0, W=0                  → balance=0  (NOT −9120 — Betriebsrisiko)
 *   E Ausfallprinzip:    5 leave days, 15×450 shifts, W=6750 → C_net=6840, balance=0
 *   F partial-month:     hireDate Feb 16 → 10 workdays, C=4560, 10×456 shifts, W=4560 → balance=0
 *   G cancelled-shift:   5 shifts (3 soft-deleted), 2 active R=900, W=900 → balance=0
 *
 * References: D-01, D-02, D-05, D-06, D-07 (CONTEXT.md), SALDO-V1816-03/04 (REQUIREMENTS.md).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { monthRangeUtc } from "../utils/timezone";
import { updateOvertimeAccount } from "../routes/time-entries";
import { recalculateSnapshots } from "../utils/recalculate-snapshots";
import bcrypt from "bcryptjs";

const TZ = "Europe/Berlin";
// February 2026 — 20 Mon–Fri workdays, no NI public holidays.
const YEAR = 2026;
const MONTH = 2; // February

const { start: FEB_START, end: FEB_END } = monthRangeUtc(YEAR, MONTH, TZ);

// March 16 — cron grace day (≥ 15) → cron targets February 2026.
const CRON_NOW = new Date("2026-03-16T06:00:00.000Z");
// Live check "now" — in March so we're past February. The live computation for
// March has no shifts/entries (R=0, W=0), so § 615 returns 0 for March → live total
// = snapshot.carryOver / 60 + 0 = carryOver / 60.
const LIVE_NOW = new Date("2026-03-16T10:00:00.000Z");

/** All Mon–Fri dates in Feb 2026 as "YYYY-MM-DD" strings */
const FEB_MON_FRI: string[] = [];
for (let d = 1; d <= 28; d++) {
  const date = new Date(`2026-02-${String(d).padStart(2, "0")}T00:00:00Z`);
  const dow = date.getUTCDay();
  if (dow >= 1 && dow <= 5) FEB_MON_FRI.push(date.toISOString().slice(0, 10));
}
// Feb 16–27 Mon–Fri only (10 workdays for Fixture F partial-month)
const FEB_FROM_16 = FEB_MON_FRI.filter((d) => d >= "2026-02-16");

interface FixtureEmployee {
  id: string;
  userId: string;
}

/**
 * Create an isolated test tenant + one SHIFT_BASED employee with zero-break overrides.
 * workSchedule validFrom is set to Jan 1 2026 so that getEffectiveSchedule(midMonth) always
 * finds the correct schedule even for Fixture F (hireDate Feb 16 < midFeb Feb 14).
 * effectiveStart in close-month still uses emp.hireDate for partial-month proration.
 */
async function createFixtureTenant(
  app: FastifyInstance,
  slug: string,
  hireDate: Date,
): Promise<{ tenantId: string; adminToken: string; employee: FixtureEmployee }> {
  const s = `parity-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`;
  const prisma = app.prisma;

  const tenant = await prisma.tenant.create({
    data: { name: `Parity ${slug}`, slug: s, federalState: "NIEDERSACHSEN" },
  });
  await prisma.tenantConfig.create({
    data: { tenantId: tenant.id, defaultVacationDays: 30, timezone: TZ },
  });

  // Admin user (required — cron iterates over tenant employees)
  const adminUser = await prisma.user.create({
    data: {
      email: `admin-${s}@parity.test`,
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
      lastName: "P.",
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

  // Fixture employee — SHIFT_BASED, zero break overrides so brutto == netto everywhere.
  const empUser = await prisma.user.create({
    data: {
      email: `emp-${s}@parity.test`,
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
      type: "SHIFT_BASED",
      weeklyHours: 38,
      // {day}Hours > 0 for Mon–Fri: avgWorkMinutesCore denominator = 5 (D-03)
      mondayHours: 7.6,
      tuesdayHours: 7.6,
      wednesdayHours: 7.6,
      thursdayHours: 7.6,
      fridayHours: 7.6,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [1, 2, 3, 4, 5],
      // validFrom BEFORE midMonth (Feb ~14): getEffectiveSchedule(midFeb) always finds this row.
      // effectiveStart in close-month uses emp.hireDate for partial-month proration (Fixture F).
      validFrom: new Date("2026-01-01T00:00:00Z"),
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

  // Dec-2025 zero snapshot anchors the carry-over chain so the live path's rangeStart
  // begins from Jan (not from the current month's first day). Without this anchor,
  // the live path would start from March 1 (current month) and miss January/February.
  const { start: decStart, end: decEnd } = monthRangeUtc(2025, 12, TZ);
  await prisma.saldoSnapshot.create({
    data: {
      employeeId: emp.id,
      periodType: "MONTHLY",
      periodStart: decStart,
      periodEnd: decEnd,
      workedMinutes: 0,
      expectedMinutes: 0,
      balanceMinutes: 0,
      carryOver: 0,
      closedAt: new Date(),
      closedBy: "test-seed",
    },
  });

  // Admin login token
  const loginRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: `admin-${s}@parity.test`, password: "test1234" },
  });
  const { accessToken: adminToken } = JSON.parse(loginRes.body);

  return { tenantId: tenant.id, adminToken, employee: { id: emp.id, userId: empUser.id } };
}

/** Seed a TimeEntry (type=WORK, breakMinutes=0) for a given date and net duration. */
async function seedEntry(app: FastifyInstance, empId: string, dateStr: string, netMinutes: number) {
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

/** Seed a Shift record. brutto = netMinutes (zero break override on employee). */
async function seedShift(
  app: FastifyInstance,
  empId: string,
  dateStr: string,
  netMinutes: number,
  deletedAt?: Date,
) {
  const totalH = Math.floor(netMinutes / 60);
  const totalM = netMinutes % 60;
  const endHHMM = `${String(8 + totalH).padStart(2, "0")}:${String(totalM).padStart(2, "0")}`;
  await app.prisma.shift.create({
    data: {
      employeeId: empId,
      date: new Date(dateStr + "T00:00:00Z"),
      startTime: "08:00",
      endTime: endHHMM,
      deletedAt: deletedAt ?? null,
    },
  });
}

/** Run the cron auto-close at a given ISO timestamp. */
async function runCronAt(app: FastifyInstance, iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
  try {
    await app.tryAutoCloseMonth();
  } finally {
    vi.useRealTimers();
  }
}

/**
 * Get live OvertimeAccount balance by calling updateOvertimeAccount at a frozen "now".
 * Returns balanceHours AFTER the function re-derives it from snapshots + open range.
 *
 * V-03-A: called AFTER closing February. The open range then covers March 1–16 only
 * (no March shifts/entries). § 615: R=0, W=0 → balance contribution = 0.
 * Total = snapshotCarryOver/60 + 0 = carryOver/60.
 */
async function liveBalanceAt(app: FastifyInstance, empId: string, isoNow: string): Promise<number> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(isoNow));
  try {
    await updateOvertimeAccount(app, empId);
    const acc = await app.prisma.overtimeAccount.findUnique({ where: { employeeId: empId } });
    return Number(acc!.balanceHours);
  } finally {
    vi.useRealTimers();
  }
}

/** Fetch the active February 2026 snapshot (superseded=false). */
async function fetchFebSnapshot(app: FastifyInstance, empId: string) {
  return app.prisma.saldoSnapshot.findFirst({
    where: {
      employeeId: empId,
      periodType: "MONTHLY",
      superseded: false,
      periodEnd: FEB_END,
    },
  });
}

/** POST /overtime/close-month. */
async function closeMonth(
  app: FastifyInstance,
  adminToken: string,
  empId: string,
  year: number,
  month: number,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/overtime/close-month",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { employeeId: empId, year, month },
  });
}

/** POST /overtime/unlock-month. */
async function unlockMonth(
  app: FastifyInstance,
  adminToken: string,
  empId: string,
  year: number,
  month: number,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/overtime/unlock-month",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { employeeId: empId, year, month, reason: "parity test re-close" },
  });
}

/**
 * Close January 2026 via manual API (required for Feb chain when hireDate <= Jan 31).
 * Uses LIVE_NOW so time-entry cutoff aligns with the test timestamp.
 */
async function closeJanManual(
  app: FastifyInstance,
  adminToken: string,
  empId: string,
  hireDate: Date,
) {
  if (hireDate > new Date("2026-01-31T23:59:59Z")) return; // hired in Feb → no Jan needed
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(LIVE_NOW);
  try {
    const res = await closeMonth(app, adminToken, empId, YEAR, 1);
    if (res.statusCode !== 201 && res.statusCode !== 400) {
      throw new Error(`closeJanManual failed: ${res.statusCode} ${res.body}`);
    }
  } finally {
    vi.useRealTimers();
  }
}

/**
 * Assert four-path parity (V-03-A/B/C):
 *   close2 == close1 (all 4 fields) — V-03-B: manual re-close == first close
 *   recalc == close1 (all 4 fields) — V-03-C: recalc reproduces close values
 *   live == close1.carryOver/60     — V-03-A: post-close live == running balance
 *
 * The live assertion uses carryOver (not balanceMinutes) to be robust against
 * fixtures with prior carry-over. For these fixtures, prior carry = 0, so both
 * are equal, but carryOver is the semantically correct value for the running balance.
 */
function assertParitySnapshot(
  label: string,
  close1: {
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
    carryOver: number;
  },
  close2: {
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
    carryOver: number;
  },
  recalcSnap: {
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
    carryOver: number;
  },
  liveBalanceHours: number,
) {
  // V-03-B: close2 == close1
  expect(close2.workedMinutes, `${label} close2.workedMinutes == close1`).toBe(
    close1.workedMinutes,
  );
  expect(close2.expectedMinutes, `${label} close2.expectedMinutes == close1`).toBe(
    close1.expectedMinutes,
  );
  expect(close2.balanceMinutes, `${label} close2.balanceMinutes == close1`).toBe(
    close1.balanceMinutes,
  );
  expect(close2.carryOver, `${label} close2.carryOver == close1`).toBe(close1.carryOver);

  // V-03-C: recalc == close1
  expect(recalcSnap.workedMinutes, `${label} recalc.workedMinutes == close1`).toBe(
    close1.workedMinutes,
  );
  expect(recalcSnap.expectedMinutes, `${label} recalc.expectedMinutes == close1`).toBe(
    close1.expectedMinutes,
  );
  expect(recalcSnap.balanceMinutes, `${label} recalc.balanceMinutes == close1`).toBe(
    close1.balanceMinutes,
  );
  expect(recalcSnap.carryOver, `${label} recalc.carryOver == close1`).toBe(close1.carryOver);

  // V-03-A: live (post-close) == snapshot.carryOver/60
  // March open range: R=0, W=0 → § 615 contributes 0 → total = carryOver/60
  expect(liveBalanceHours, `${label} live == carryOver/60`).toBeCloseTo(close1.carryOver / 60, 1);
}

// ────────────────────────────────────────────────────────────────────────────
// Fixture A: Phantom-overtime fix — 0 shifts, 20×456min entries, expectedMinutes=9120, balance=0
// SALDO-V1816-01 / D-01 / V-01-B  (cron-close — all 20 entry days satisfy completeness gate)
// ────────────────────────────────────────────────────────────────────────────
describe("Fixture A — phantom-overtime fix: 0 shifts, W=9120, balance=0 (SALDO-V1816-01, D-01)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let empId: string;
  let close1Snap: {
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
    carryOver: number;
  };

  // 20 entries × 456 min netto = 9120 min = C. 0 shifts → R=0. balance = max(0,9120-9120) - 0 = 0.
  // All 20 workdays have entries → cron completeness gate is satisfied.
  const ENTRY_NETTO = 456; // 7h36m

  beforeAll(async () => {
    app = await getTestApp();
    const fixture = await createFixtureTenant(app, "fixa", new Date("2026-01-01T00:00:00Z"));
    tenantId = fixture.tenantId;
    adminToken = fixture.adminToken;
    empId = fixture.employee.id;

    // No shifts (R=0) — phantom-overtime scenario from v1.8.15 prod.
    // Employee works all 20 Mon–Fri days so cron completeness gate is satisfied.
    for (const d of FEB_MON_FRI) {
      await seedEntry(app, empId, d, ENTRY_NETTO);
    }
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Fixture A cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("step 1: cron closes Jan then Feb → expectedMinutes=9120, balance=0 (V-01-B, V-04-A)", async () => {
    await closeJanManual(app, adminToken, empId, new Date("2026-01-01T00:00:00Z"));
    await runCronAt(app, CRON_NOW.toISOString());

    const snap = await fetchFebSnapshot(app, empId);
    expect(snap, "Feb snapshot must exist after cron close").not.toBeNull();
    // V-04-A: expectedMinutes = C_net = 9120 (contract Soll, NOT Σ shifts = 0)
    expect(snap!.expectedMinutes, "expectedMinutes == C (not R)").toBe(9120);
    // D-01: balance = max(0,9120-9120) - max(0,0-9120) = 0 - 0 = 0 (phantom fix)
    expect(snap!.balanceMinutes, "balance=0 — phantom overtime eliminated").toBe(0);
    close1Snap = {
      workedMinutes: snap!.workedMinutes,
      expectedMinutes: snap!.expectedMinutes,
      balanceMinutes: snap!.balanceMinutes,
      carryOver: snap!.carryOver,
    };
  }, 120_000);

  it("step 2: live (post-close) balance == carryOver/60 == 0 (V-03-A)", async () => {
    // updateOvertimeAccount: rangeStart=Mar1, no March data, §615→0. Total = 0/60 + 0 = 0.
    const live = await liveBalanceAt(app, empId, LIVE_NOW.toISOString());
    expect(live).toBeCloseTo(0, 1);
    expect(live).toBeCloseTo(close1Snap.carryOver / 60, 1);
  }, 30_000);

  it("step 3: unlock + manual re-close produces identical snapshot values (V-03-B)", async () => {
    const unlock = await unlockMonth(app, adminToken, empId, YEAR, MONTH);
    expect(unlock.statusCode).toBe(200);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    let res;
    try {
      res = await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }
    expect(res.statusCode, `manual close: ${res.body}`).toBe(201);
    const snap = await fetchFebSnapshot(app, empId);
    expect(snap!.expectedMinutes).toBe(close1Snap.expectedMinutes);
    expect(snap!.balanceMinutes).toBe(close1Snap.balanceMinutes);
    expect(snap!.carryOver).toBe(close1Snap.carryOver);
  }, 60_000);

  it("step 4: unlock + recalc reproduces identical values; four-path parity holds (V-03-A/B/C)", async () => {
    const unlock = await unlockMonth(app, adminToken, empId, YEAR, MONTH);
    expect(unlock.statusCode).toBe(200);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    try {
      await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }

    // Capture close2 snapshot BEFORE recalc so V-03-B really tests close2 vs close1.
    const close2Snap = await fetchFebSnapshot(app, empId);
    expect(close2Snap, "Feb snapshot after second close").not.toBeNull();

    await recalculateSnapshots(app, empId, FEB_START);
    // Capture recalcSnap AFTER recalc — distinct object from close2Snap.
    const recalcSnap = await fetchFebSnapshot(app, empId);
    expect(recalcSnap, "Feb snapshot after recalc").not.toBeNull();
    const live = await liveBalanceAt(app, empId, LIVE_NOW.toISOString());

    assertParitySnapshot(
      "Fixture A",
      close1Snap,
      {
        workedMinutes: close2Snap!.workedMinutes,
        expectedMinutes: close2Snap!.expectedMinutes,
        balanceMinutes: close2Snap!.balanceMinutes,
        carryOver: close2Snap!.carryOver,
      },
      {
        workedMinutes: recalcSnap!.workedMinutes,
        expectedMinutes: recalcSnap!.expectedMinutes,
        balanceMinutes: recalcSnap!.balanceMinutes,
        carryOver: recalcSnap!.carryOver,
      },
      live,
    );
    expect(recalcSnap!.expectedMinutes).toBe(9120);
    expect(recalcSnap!.balanceMinutes).toBe(0);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────────────
// Fixture B: Overtime — 20 shifts, W=9900, balance=+780
// SALDO-V1816-04 / D-01  (cron-close — all 20 workdays have entries)
// ────────────────────────────────────────────────────────────────────────────
describe("Fixture B — overtime: 20 shifts×495min, W=9900, balance=+780 (SALDO-V1816-04, D-01)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let empId: string;
  let close1Snap: {
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
    carryOver: number;
  };

  // C=9120, R=W=20×495=9900. balance = max(0,9900−9120) − max(0,9900−9900) = 780.
  const SHIFT_NETTO = 495; // 8h15m

  beforeAll(async () => {
    app = await getTestApp();
    const fixture = await createFixtureTenant(app, "fixb", new Date("2026-01-01T00:00:00Z"));
    tenantId = fixture.tenantId;
    adminToken = fixture.adminToken;
    empId = fixture.employee.id;

    for (const d of FEB_MON_FRI) {
      await seedShift(app, empId, d, SHIFT_NETTO);
      await seedEntry(app, empId, d, SHIFT_NETTO);
    }
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Fixture B cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("step 1: cron closes Jan then Feb → snapshot balance=+780, expectedMinutes=9120 (V-04-B)", async () => {
    await closeJanManual(app, adminToken, empId, new Date("2026-01-01T00:00:00Z"));
    await runCronAt(app, CRON_NOW.toISOString());

    const snap = await fetchFebSnapshot(app, empId);
    expect(snap, "Feb snapshot must exist after cron close").not.toBeNull();
    expect(snap!.expectedMinutes).toBe(9120); // C_net stored (not R=9900)
    expect(snap!.balanceMinutes).toBe(780); // V-04-B: W>C → overtime
    close1Snap = {
      workedMinutes: snap!.workedMinutes,
      expectedMinutes: snap!.expectedMinutes,
      balanceMinutes: snap!.balanceMinutes,
      carryOver: snap!.carryOver,
    };
  }, 120_000);

  it("step 2: live (post-close) == carryOver/60 == +13h (V-03-A)", async () => {
    // After close: OvertimeAccount.balanceHours = carryOver/60 = 780/60 = 13h.
    // updateOvertimeAccount: rangeStart=Mar1, R=0, W=0, §615→0. Total = 780/60 + 0 = 13h.
    const live = await liveBalanceAt(app, empId, LIVE_NOW.toISOString());
    expect(live).toBeCloseTo(780 / 60, 1);
    expect(live).toBeCloseTo(close1Snap.carryOver / 60, 1);
  }, 30_000);

  it("step 3: unlock + manual re-close == cron (V-03-B)", async () => {
    await unlockMonth(app, adminToken, empId, YEAR, MONTH);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    let res;
    try {
      res = await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }
    expect(res.statusCode, `manual close: ${res.body}`).toBe(201);
    const snap = await fetchFebSnapshot(app, empId);
    expect(snap!.expectedMinutes).toBe(close1Snap.expectedMinutes);
    expect(snap!.balanceMinutes).toBe(close1Snap.balanceMinutes);
    expect(snap!.carryOver).toBe(close1Snap.carryOver);
  }, 60_000);

  it("step 4: unlock + recalc == cron; four-path parity holds (V-03-A/B/C)", async () => {
    await unlockMonth(app, adminToken, empId, YEAR, MONTH);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    try {
      await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }

    // Capture close2 snapshot BEFORE recalc so V-03-B really tests close2 vs close1.
    const close2Snap = await fetchFebSnapshot(app, empId);
    expect(close2Snap, "Feb snapshot after second close").not.toBeNull();

    await recalculateSnapshots(app, empId, FEB_START);
    // Capture recalcSnap AFTER recalc — distinct object from close2Snap.
    const recalcSnap = await fetchFebSnapshot(app, empId);
    expect(recalcSnap, "Feb snapshot after recalc").not.toBeNull();
    const live = await liveBalanceAt(app, empId, LIVE_NOW.toISOString());

    assertParitySnapshot(
      "Fixture B",
      close1Snap,
      {
        workedMinutes: close2Snap!.workedMinutes,
        expectedMinutes: close2Snap!.expectedMinutes,
        balanceMinutes: close2Snap!.balanceMinutes,
        carryOver: close2Snap!.carryOver,
      },
      {
        workedMinutes: recalcSnap!.workedMinutes,
        expectedMinutes: recalcSnap!.expectedMinutes,
        balanceMinutes: recalcSnap!.balanceMinutes,
        carryOver: recalcSnap!.carryOver,
      },
      live,
    );
    expect(recalcSnap!.expectedMinutes).toBe(9120);
    expect(recalcSnap!.balanceMinutes).toBe(780);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────────────
// Fixture C: Rostered-but-not-worked — undertime, balance=−900
// SALDO-V1816-04 / D-01 (employee-fault shortfall)
// Manual close — cron completeness gate blocks auto-close (only 3 of 20 workdays have entries)
// ────────────────────────────────────────────────────────────────────────────
describe("Fixture C — rostered-not-worked: R=2250, W=1350, balance=−900 (SALDO-V1816-04, D-01)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let empId: string;
  let close1Snap: {
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
    carryOver: number;
  };

  // 5 shifts × 450 min, employee works only 3 (no-shows on Feb 5, 6).
  // R=2250, W=1350. balance = max(0,1350−9120) − max(0,2250−1350) = 0 − 900 = −900.
  const SHIFT_NETTO = 450;
  const SHIFT_DAYS = FEB_MON_FRI.slice(0, 5); // Feb 2–6
  const WORKED_DAYS = SHIFT_DAYS.slice(0, 3); // Feb 2, 3, 4 worked; Feb 5, 6 no-show

  beforeAll(async () => {
    app = await getTestApp();
    const fixture = await createFixtureTenant(app, "fixc", new Date("2026-01-01T00:00:00Z"));
    tenantId = fixture.tenantId;
    adminToken = fixture.adminToken;
    empId = fixture.employee.id;

    for (const d of SHIFT_DAYS) await seedShift(app, empId, d, SHIFT_NETTO);
    for (const d of WORKED_DAYS) await seedEntry(app, empId, d, SHIFT_NETTO);
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Fixture C cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("step 1: manual close Jan then Feb → snapshot balance=−900, expectedMinutes=9120 (V-04-C)", async () => {
    await closeJanManual(app, adminToken, empId, new Date("2026-01-01T00:00:00Z"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    let res;
    try {
      res = await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }
    expect(res.statusCode, `close Feb: ${res.body}`).toBe(201);

    const snap = await fetchFebSnapshot(app, empId);
    expect(snap, "Feb snapshot must exist after manual close").not.toBeNull();
    expect(snap!.expectedMinutes).toBe(9120); // C_net (not R=2250)
    expect(snap!.balanceMinutes).toBe(-900);
    close1Snap = {
      workedMinutes: snap!.workedMinutes,
      expectedMinutes: snap!.expectedMinutes,
      balanceMinutes: snap!.balanceMinutes,
      carryOver: snap!.carryOver,
    };
  }, 120_000);

  it("step 2: live (post-close) == carryOver/60 == −15h (V-03-A, employee fault undertime)", async () => {
    const live = await liveBalanceAt(app, empId, LIVE_NOW.toISOString());
    expect(live).toBeCloseTo(-900 / 60, 1);
    expect(live).toBeCloseTo(close1Snap.carryOver / 60, 1);
  }, 30_000);

  it("step 3: unlock + manual re-close produces identical values", async () => {
    const unlock = await unlockMonth(app, adminToken, empId, YEAR, MONTH);
    expect(unlock.statusCode).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    let res;
    try {
      res = await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }
    expect(res.statusCode, `re-close: ${res.body}`).toBe(201);
    const snap = await fetchFebSnapshot(app, empId);
    expect(snap!.expectedMinutes).toBe(close1Snap.expectedMinutes);
    expect(snap!.balanceMinutes).toBe(close1Snap.balanceMinutes);
  }, 60_000);

  it("step 4: unlock + recalc reproduces identical values; parity holds", async () => {
    const unlock = await unlockMonth(app, adminToken, empId, YEAR, MONTH);
    expect(unlock.statusCode).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    try {
      await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }

    // Capture close2 snapshot BEFORE recalc so V-03-B really tests close2 vs close1.
    const close2Snap = await fetchFebSnapshot(app, empId);
    expect(close2Snap, "Feb snapshot after second close").not.toBeNull();

    await recalculateSnapshots(app, empId, FEB_START);
    // Capture recalcSnap AFTER recalc — distinct object from close2Snap.
    const recalcSnap = await fetchFebSnapshot(app, empId);
    expect(recalcSnap, "Feb snapshot after recalc").not.toBeNull();
    const live = await liveBalanceAt(app, empId, LIVE_NOW.toISOString());

    assertParitySnapshot(
      "Fixture C",
      close1Snap,
      {
        workedMinutes: close2Snap!.workedMinutes,
        expectedMinutes: close2Snap!.expectedMinutes,
        balanceMinutes: close2Snap!.balanceMinutes,
        carryOver: close2Snap!.carryOver,
      },
      {
        workedMinutes: recalcSnap!.workedMinutes,
        expectedMinutes: recalcSnap!.expectedMinutes,
        balanceMinutes: recalcSnap!.balanceMinutes,
        carryOver: recalcSnap!.carryOver,
      },
      live,
    );
    expect(recalcSnap!.balanceMinutes).toBe(-900);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────────────
// Fixture D: § 615 contracted-but-never-rostered — balance=0 (NOT −9120)
// SALDO-V1816-02 / D-02 (Annahmeverzug — Betriebsrisiko)
// Manual close — cron completeness gate blocks auto-close (no entries for any workday)
// ────────────────────────────────────────────────────────────────────────────
describe("Fixture D — §615: R=0, W=0, balance=0 NOT −9120 (SALDO-V1816-02, D-02)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let empId: string;
  let close1Snap: {
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
    carryOver: number;
  };

  beforeAll(async () => {
    app = await getTestApp();
    const fixture = await createFixtureTenant(app, "fixd", new Date("2026-01-01T00:00:00Z"));
    tenantId = fixture.tenantId;
    adminToken = fixture.adminToken;
    empId = fixture.employee.id;
    // No shifts, no entries — employer never rostered this employee in February.
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Fixture D cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("step 1: manual close Jan then Feb → balance=0, expectedMinutes=9120 (V-04-D)", async () => {
    await closeJanManual(app, adminToken, empId, new Date("2026-01-01T00:00:00Z"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    let res;
    try {
      res = await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }
    expect(res.statusCode, `close Feb: ${res.body}`).toBe(201);

    const snap = await fetchFebSnapshot(app, empId);
    expect(snap, "Feb snapshot must exist after manual close").not.toBeNull();
    expect(snap!.expectedMinutes).toBe(9120);
    expect(snap!.balanceMinutes).toBe(0); // NOT −9120 (§615 Betriebsrisiko)
    close1Snap = {
      workedMinutes: snap!.workedMinutes,
      expectedMinutes: snap!.expectedMinutes,
      balanceMinutes: snap!.balanceMinutes,
      carryOver: snap!.carryOver,
    };
  }, 120_000);

  it("step 2: live (post-close) == carryOver/60 == 0 (V-03-A, §615 — NOT −152h)", async () => {
    const live = await liveBalanceAt(app, empId, LIVE_NOW.toISOString());
    expect(live).toBeCloseTo(0, 1);
    expect(live).toBeCloseTo(close1Snap.carryOver / 60, 1);
  }, 30_000);

  it("step 3: unlock + manual re-close == initial close (V-02-A confirmed idempotent)", async () => {
    await unlockMonth(app, adminToken, empId, YEAR, MONTH);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    let res;
    try {
      res = await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }
    expect(res.statusCode).toBe(201);
    const snap = await fetchFebSnapshot(app, empId);
    expect(snap!.balanceMinutes).toBe(0);
    expect(snap!.expectedMinutes).toBe(9120);
  }, 60_000);

  it("step 4: unlock + recalc → §615 guard preserved in all paths (V-02-C, V-03-C)", async () => {
    await unlockMonth(app, adminToken, empId, YEAR, MONTH);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    try {
      await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }

    // Capture close2 snapshot BEFORE recalc so V-03-B really tests close2 vs close1.
    const close2Snap = await fetchFebSnapshot(app, empId);
    expect(close2Snap, "Feb snapshot after second close").not.toBeNull();

    await recalculateSnapshots(app, empId, FEB_START);
    // Capture recalcSnap AFTER recalc — distinct object from close2Snap.
    const recalcSnap = await fetchFebSnapshot(app, empId);
    expect(recalcSnap, "Feb snapshot after recalc").not.toBeNull();
    const live = await liveBalanceAt(app, empId, LIVE_NOW.toISOString());

    assertParitySnapshot(
      "Fixture D",
      close1Snap,
      {
        workedMinutes: close2Snap!.workedMinutes,
        expectedMinutes: close2Snap!.expectedMinutes,
        balanceMinutes: close2Snap!.balanceMinutes,
        carryOver: close2Snap!.carryOver,
      },
      {
        workedMinutes: recalcSnap!.workedMinutes,
        expectedMinutes: recalcSnap!.expectedMinutes,
        balanceMinutes: recalcSnap!.balanceMinutes,
        carryOver: recalcSnap!.carryOver,
      },
      live,
    );
    expect(recalcSnap!.expectedMinutes).toBe(9120);
    expect(recalcSnap!.balanceMinutes).toBe(0);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────────────
// Fixture E: Ausfallprinzip — 5 leave days, C_net=6840, balance=0
// SALDO-V1816-04 / D-06 (leave credited via Ausfallprinzip, never minus)
// Cron-close — all 20 workdays covered (15 entries + 5 leave days)
// ────────────────────────────────────────────────────────────────────────────
describe("Fixture E — Ausfallprinzip: 5 leave days, C_net=6840, balance=0 (SALDO-V1816-04, D-06)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let empId: string;
  let close1Snap: {
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
    carryOver: number;
  };

  // Leave Feb 2–6 (5 Mon–Fri). leaveCredit = round(38×60×5/5) = 2280. C_net = 9120−2280 = 6840.
  // 15 shifts on Feb 9–27 × 450 min each → R=6750. Employee works all 15 → W=6750.
  // balance = max(0,6750−6840) − max(0,6750−6750) = 0. (employer gap = §615)
  const LEAVE_START = new Date("2026-02-02T00:00:00Z");
  const LEAVE_END = new Date("2026-02-06T00:00:00Z");
  const SHIFT_DAYS = FEB_MON_FRI.slice(5); // Feb 9 onwards (15 days)
  const SHIFT_NETTO = 450;

  beforeAll(async () => {
    app = await getTestApp();
    const fixture = await createFixtureTenant(app, "fixe", new Date("2026-01-01T00:00:00Z"));
    tenantId = fixture.tenantId;
    adminToken = fixture.adminToken;
    empId = fixture.employee.id;

    const lt = await app.prisma.leaveType.create({
      data: { tenantId, name: "Urlaub E", isPaid: true, requiresApproval: false },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: lt.id,
        startDate: LEAVE_START,
        endDate: LEAVE_END,
        days: 5,
        status: "APPROVED",
      },
    });

    for (const d of SHIFT_DAYS) {
      await seedShift(app, empId, d, SHIFT_NETTO);
      await seedEntry(app, empId, d, SHIFT_NETTO);
    }
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Fixture E cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("step 1: cron closes Jan then Feb → expectedMinutes=6840, balance=0 (V-04-E)", async () => {
    await closeJanManual(app, adminToken, empId, new Date("2026-01-01T00:00:00Z"));
    await runCronAt(app, CRON_NOW.toISOString());

    const snap = await fetchFebSnapshot(app, empId);
    expect(snap, "Feb snapshot must exist after cron close").not.toBeNull();
    expect(snap!.expectedMinutes).toBe(6840); // C_net net of leave credit
    expect(snap!.balanceMinutes).toBe(0);
    close1Snap = {
      workedMinutes: snap!.workedMinutes,
      expectedMinutes: snap!.expectedMinutes,
      balanceMinutes: snap!.balanceMinutes,
      carryOver: snap!.carryOver,
    };
  }, 120_000);

  it("step 2: live (post-close) == carryOver/60 == 0 (V-03-A)", async () => {
    const live = await liveBalanceAt(app, empId, LIVE_NOW.toISOString());
    expect(live).toBeCloseTo(0, 1);
    expect(live).toBeCloseTo(close1Snap.carryOver / 60, 1);
  }, 30_000);

  it("step 3: unlock + manual re-close == cron", async () => {
    await unlockMonth(app, adminToken, empId, YEAR, MONTH);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    let res;
    try {
      res = await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }
    expect(res.statusCode, `re-close: ${res.body}`).toBe(201);
    const snap = await fetchFebSnapshot(app, empId);
    expect(snap!.expectedMinutes).toBe(6840);
    expect(snap!.balanceMinutes).toBe(0);
  }, 60_000);

  it("step 4: recalc == cron; Ausfallprinzip parity holds (V-03-C, V-02-D)", async () => {
    await unlockMonth(app, adminToken, empId, YEAR, MONTH);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    try {
      await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }

    // Capture close2 snapshot BEFORE recalc so V-03-B really tests close2 vs close1.
    const close2Snap = await fetchFebSnapshot(app, empId);
    expect(close2Snap, "Feb snapshot after second close").not.toBeNull();

    await recalculateSnapshots(app, empId, FEB_START);
    // Capture recalcSnap AFTER recalc — distinct object from close2Snap.
    const recalcSnap = await fetchFebSnapshot(app, empId);
    expect(recalcSnap, "Feb snapshot after recalc").not.toBeNull();
    const live = await liveBalanceAt(app, empId, LIVE_NOW.toISOString());

    assertParitySnapshot(
      "Fixture E",
      close1Snap,
      {
        workedMinutes: close2Snap!.workedMinutes,
        expectedMinutes: close2Snap!.expectedMinutes,
        balanceMinutes: close2Snap!.balanceMinutes,
        carryOver: close2Snap!.carryOver,
      },
      {
        workedMinutes: recalcSnap!.workedMinutes,
        expectedMinutes: recalcSnap!.expectedMinutes,
        balanceMinutes: recalcSnap!.balanceMinutes,
        carryOver: recalcSnap!.carryOver,
      },
      live,
    );
    expect(recalcSnap!.expectedMinutes).toBe(6840);
    expect(recalcSnap!.balanceMinutes).toBe(0);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────────────
// Fixture F: Partial-month — hireDate Feb 16, 10 workdays, expectedMinutes=4560
// SALDO-V1816-04 / D-06 (effectiveStart proration via Ø-Methode)
// Cron-close — all 10 workdays from Feb 16 have entries (completeness gate satisfied)
// ────────────────────────────────────────────────────────────────────────────
describe("Fixture F — partial-month: hireDate Feb 16, C=4560, balance=0 (SALDO-V1816-04, D-06)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let empId: string;
  let close1Snap: {
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
    carryOver: number;
  };

  // hireDate Feb 16. effectiveStart = Feb 16. 10 Mon–Fri workdays (Feb 16–27).
  // C = round(38×60×10/5) = 4560 min. 10 shifts × 456 min = R=W=4560. balance=0.
  const HIRE_DATE = new Date("2026-02-16T00:00:00Z");
  const SHIFT_NETTO = 456; // 7h36m

  beforeAll(async () => {
    app = await getTestApp();
    const fixture = await createFixtureTenant(app, "fixf", HIRE_DATE);
    tenantId = fixture.tenantId;
    adminToken = fixture.adminToken;
    empId = fixture.employee.id;

    for (const d of FEB_FROM_16) {
      await seedShift(app, empId, d, SHIFT_NETTO);
      await seedEntry(app, empId, d, SHIFT_NETTO);
    }
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Fixture F cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("step 1: cron closes Feb (no Jan needed — hired mid-Feb) → expectedMinutes=4560 (V-04-F)", async () => {
    // Fixture F hired Feb 16 — no prior month snapshot needed for Feb close.
    await runCronAt(app, CRON_NOW.toISOString());

    const snap = await fetchFebSnapshot(app, empId);
    expect(snap, "Feb snapshot must exist after cron close").not.toBeNull();
    expect(snap!.expectedMinutes).toBe(4560); // prorated C_net (10 workdays × 38h/5)
    expect(snap!.balanceMinutes).toBe(0);
    close1Snap = {
      workedMinutes: snap!.workedMinutes,
      expectedMinutes: snap!.expectedMinutes,
      balanceMinutes: snap!.balanceMinutes,
      carryOver: snap!.carryOver,
    };
  }, 120_000);

  it("step 2: live (post-close) == carryOver/60 == 0 (V-03-A)", async () => {
    const live = await liveBalanceAt(app, empId, LIVE_NOW.toISOString());
    expect(live).toBeCloseTo(0, 1);
    expect(live).toBeCloseTo(close1Snap.carryOver / 60, 1);
  }, 30_000);

  it("step 3: unlock + manual re-close == cron", async () => {
    await unlockMonth(app, adminToken, empId, YEAR, MONTH);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    let res;
    try {
      res = await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }
    expect(res.statusCode, `re-close: ${res.body}`).toBe(201);
    const snap = await fetchFebSnapshot(app, empId);
    expect(snap!.expectedMinutes).toBe(4560);
    expect(snap!.balanceMinutes).toBe(0);
  }, 60_000);

  it("step 4: recalc == cron; proration parity holds (V-03-C)", async () => {
    await unlockMonth(app, adminToken, empId, YEAR, MONTH);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    try {
      await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }

    // Capture close2 snapshot BEFORE recalc so V-03-B really tests close2 vs close1.
    const close2Snap = await fetchFebSnapshot(app, empId);
    expect(close2Snap, "Feb snapshot after second close").not.toBeNull();

    await recalculateSnapshots(app, empId, FEB_START);
    // Capture recalcSnap AFTER recalc — distinct object from close2Snap.
    const recalcSnap = await fetchFebSnapshot(app, empId);
    expect(recalcSnap, "Feb snapshot after recalc").not.toBeNull();
    const live = await liveBalanceAt(app, empId, LIVE_NOW.toISOString());

    assertParitySnapshot(
      "Fixture F",
      close1Snap,
      {
        workedMinutes: close2Snap!.workedMinutes,
        expectedMinutes: close2Snap!.expectedMinutes,
        balanceMinutes: close2Snap!.balanceMinutes,
        carryOver: close2Snap!.carryOver,
      },
      {
        workedMinutes: recalcSnap!.workedMinutes,
        expectedMinutes: recalcSnap!.expectedMinutes,
        balanceMinutes: recalcSnap!.balanceMinutes,
        carryOver: recalcSnap!.carryOver,
      },
      live,
    );
    expect(recalcSnap!.expectedMinutes).toBe(4560);
    expect(recalcSnap!.balanceMinutes).toBe(0);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────────────
// Fixture G: Cancelled-shift guard — 3 of 5 shifts soft-deleted, R=900, balance=0
// SALDO-V1816-02 / D-02, D-05 (cancelled shifts not in R, no employee minus)
// Manual close — cron completeness gate blocks (only 2 of 20 workdays have entries)
// ────────────────────────────────────────────────────────────────────────────
describe("Fixture G — cancelled-shift guard: 3 soft-deleted, R=900, W=900, balance=0 (D-02, D-05)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let empId: string;
  let close1Snap: {
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
    carryOver: number;
  };

  // 5 shifts × 450 min, 3 soft-deleted (Feb 2, 3, 4 — employer cancelled).
  // Active R = 2 × 450 = 900. Employee works Feb 5, 6 → W=900. C=9120.
  // balance = max(0,900−9120) − max(0,900−900) = 0. (employer cancelled 3 shifts = §615)
  const ALL_SHIFT_DAYS = FEB_MON_FRI.slice(0, 5); // Feb 2–6
  const DELETED_DAYS = ALL_SHIFT_DAYS.slice(0, 3); // Feb 2, 3, 4 (employer cancelled)
  const ACTIVE_DAYS = ALL_SHIFT_DAYS.slice(3); // Feb 5, 6 (still active)
  const SHIFT_NETTO = 450;

  beforeAll(async () => {
    app = await getTestApp();
    const fixture = await createFixtureTenant(app, "fixg", new Date("2026-01-01T00:00:00Z"));
    tenantId = fixture.tenantId;
    adminToken = fixture.adminToken;
    empId = fixture.employee.id;

    const DELETED_AT = new Date("2026-01-25T10:00:00Z");
    for (const d of DELETED_DAYS) {
      await seedShift(app, empId, d, SHIFT_NETTO, DELETED_AT); // employer-cancelled
    }
    for (const d of ACTIVE_DAYS) {
      await seedShift(app, empId, d, SHIFT_NETTO); // still active
      await seedEntry(app, empId, d, SHIFT_NETTO); // employee worked
    }
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Fixture G cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("step 1: manual close Jan then Feb → balance=0; soft-deleted shifts NOT in R (V-04-G)", async () => {
    await closeJanManual(app, adminToken, empId, new Date("2026-01-01T00:00:00Z"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    let res;
    try {
      res = await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }
    expect(res.statusCode, `close Feb: ${res.body}`).toBe(201);

    const snap = await fetchFebSnapshot(app, empId);
    expect(snap, "Feb snapshot must exist after manual close").not.toBeNull();
    expect(snap!.expectedMinutes).toBe(9120); // C_net (not R=900)
    expect(snap!.balanceMinutes).toBe(0); // employer cancelled 3 shifts → no employee minus
    close1Snap = {
      workedMinutes: snap!.workedMinutes,
      expectedMinutes: snap!.expectedMinutes,
      balanceMinutes: snap!.balanceMinutes,
      carryOver: snap!.carryOver,
    };
  }, 120_000);

  it("step 2: live (post-close) == carryOver/60 == 0 (V-03-A, cancelled shifts excluded)", async () => {
    const live = await liveBalanceAt(app, empId, LIVE_NOW.toISOString());
    expect(live).toBeCloseTo(0, 1);
    expect(live).toBeCloseTo(close1Snap.carryOver / 60, 1);
  }, 30_000);

  it("step 3: unlock + manual re-close == initial close", async () => {
    await unlockMonth(app, adminToken, empId, YEAR, MONTH);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    let res;
    try {
      res = await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }
    expect(res.statusCode).toBe(201);
    const snap = await fetchFebSnapshot(app, empId);
    expect(snap!.balanceMinutes).toBe(0);
    expect(snap!.expectedMinutes).toBe(9120);
  }, 60_000);

  it("step 4: recalc → cancelled-shift guard holds in all paths (V-02-B, V-03-C)", async () => {
    await unlockMonth(app, adminToken, empId, YEAR, MONTH);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    try {
      await closeMonth(app, adminToken, empId, YEAR, MONTH);
    } finally {
      vi.useRealTimers();
    }

    // Capture close2 snapshot BEFORE recalc so V-03-B really tests close2 vs close1.
    const close2Snap = await fetchFebSnapshot(app, empId);
    expect(close2Snap, "Feb snapshot after second close").not.toBeNull();

    await recalculateSnapshots(app, empId, FEB_START);
    // Capture recalcSnap AFTER recalc — distinct object from close2Snap.
    const recalcSnap = await fetchFebSnapshot(app, empId);
    expect(recalcSnap, "Feb snapshot after recalc").not.toBeNull();
    const live = await liveBalanceAt(app, empId, LIVE_NOW.toISOString());

    assertParitySnapshot(
      "Fixture G",
      close1Snap,
      {
        workedMinutes: close2Snap!.workedMinutes,
        expectedMinutes: close2Snap!.expectedMinutes,
        balanceMinutes: close2Snap!.balanceMinutes,
        carryOver: close2Snap!.carryOver,
      },
      {
        workedMinutes: recalcSnap!.workedMinutes,
        expectedMinutes: recalcSnap!.expectedMinutes,
        balanceMinutes: recalcSnap!.balanceMinutes,
        carryOver: recalcSnap!.carryOver,
      },
      live,
    );
    expect(recalcSnap!.expectedMinutes).toBe(9120);
    expect(recalcSnap!.balanceMinutes).toBe(0);
  }, 60_000);
});
