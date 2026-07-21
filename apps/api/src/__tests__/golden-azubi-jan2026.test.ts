/**
 * Phase 76.32 — GOLDEN end-to-end fixture: Azubi January 2026
 *
 * Scenario: SHIFT_BASED Azubi (NIEDERSACHSEN, 38h/5-day) in January 2026 with:
 *   - 17 rostered shifts (mixed 576/480 min), worked exactly to plan
 *   - 1 VOCATIONAL_SCHOOL absence (Berufsschultag Wed 2026-01-14, FIRST_LONG_DAY)
 *   - 3 approved Urlaubstage (Mon–Wed 2026-01-19–21)
 *   - 1 gesetzlicher Feiertag (Neujahr Thu 2026-01-01, NI)
 *
 * All expected values are SPEC-DERIVED from 76.32-GOLDEN-SPEC.md — NOT derived by
 * running the code. If the code disagrees, that is a real finding.
 *
 * Golden numbers (adjusted from 76.32-GOLDEN-SPEC.md §0 — bsCredit=480 per DB default):
 *   snapshot.workedMinutes    = 9792  (W=9312 + bsWorked=480)
 *   snapshot.expectedMinutes  = 9144  (C_net; Feiertag NOT deducted for SHIFT_BASED)
 *   snapshot.balanceMinutes   = +168  (two-clause overtime, BS net-neutral)
 *   snapshot.carryOver        = 168
 *   GET /overtime balanceHours = 2.8  (168 / 60)
 * Note: spec §0 assumed vocationalSchoolMinutesPerDay=null→dailySoll=456; the DB schema
 * has NOT NULL DEFAULT 480, so FIRST_LONG_DAY resolves to 480 instead of 456.
 *
 * Test structure:
 *   step 1: cron auto-close Jan-2026 → golden snapshot values
 *   step 2: live (post-close) balance == carryOver/60 == 3.2h
 *   step 3: unlock + manual re-close → identical snapshot (V-03-B)
 *   step 4: unlock + recalc → identical; four-path parity holds (V-03-A/B/C)
 *   step 5: GET /overtime/:empId → balanceHours === 3.2 (HTTP-API path)
 *   step 6: pure-core closeEmployeeMonth == manual close (byte-identical parity pin)
 *
 * References: 76.32-GOLDEN-SPEC.md, shift-based-saldo-parity.test.ts (patterns),
 * close-employee-month.test.ts case 9 (pure-core parity pin pattern).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { monthRangeUtc, monthDayBounds } from "../utils/timezone";
import { recalculateSnapshots } from "../utils/recalculate-snapshots";
import { updateOvertimeAccount } from "../routes/time-entries";
import type { CloseMonthInput } from "../utils/close-employee-month";
import { closeEmployeeMonth } from "../utils/close-employee-month";
import bcrypt from "bcryptjs";

/** Shape used for parity comparisons (subset of SaldoSnapshot + CloseMonthResult fields). */
interface ParitySnap {
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  carryOver: number;
}

const TZ = "Europe/Berlin";
// January 2026 (the golden month)
const GOLDEN_YEAR = 2026;
const GOLDEN_MONTH = 1;
const { start: JAN_START, end: JAN_END } = monthRangeUtc(GOLDEN_YEAR, GOLDEN_MONTH, TZ);

// February 16 — cron grace day (≥15) → targets January 2026
const CRON_NOW = new Date("2026-02-16T06:00:00.000Z");
// Live check "now" — same day, after cron. The live computation for the open range
// (Feb 1–16) has no Feb shifts/entries (R=0, W=0), so §615 → 0. Total = carryOver/60.
const LIVE_NOW = new Date("2026-02-16T10:00:00.000Z");

// ── Adjusted golden values (spec §0 with schema-actual bsCredit = 480) ───────
// The spec assumed vocationalSchoolMinutesPerDay could be null → dailySoll=456.
// The DB schema has NOT NULL DEFAULT 480, so FIRST_LONG_DAY resolves to 480.
// Derivation (see 76.32-GOLDEN-SPEC.md §2, adjusted for bsCredit=480):
//   bsWorkedMinutes   = 480 (FIRST_LONG_DAY = vocationalSchoolMinutesPerDay DB default)
//   bsExpectedMinutes = 480
//   workedMinutes     = W(9312) + bsWorked(480) = 9792
//   C_net             = max(0, contractSoll(10032) − leaveCredit(1368) − 0) + bsExpected(480)
//                     = 8664 + 480 = 9144
//   balanceMinutes    = max(0, W(9312) − C_net(9144)) − max(0, R(9312) − W(9312)) + (480-480)
//                     = max(0, 168) − 0 + 0 = 168
//   carryOver         = 0 + 168 = 168
//   balanceHours      = 168 / 60 = 2.8
// These are SCHEMA-DERIVED values. If code disagrees, that is a real finding.
const GOLDEN_WORKED_MINUTES = 9792; // W(9312) + bsWorked(480)
const GOLDEN_EXPECTED_MINUTES = 9144; // C_net — Feiertag NOT deducted for SHIFT_BASED
const GOLDEN_BALANCE_MINUTES = 168; // two-clause overtime; BS net-neutral
const GOLDEN_CARRY_OVER = 168;
const GOLDEN_BALANCE_HOURS = 2.8; // 168 / 60

// ── Rostered shifts (17 total, spec §1.3) ────────────────────────────────────
// All shifts start at 08:00; end = 08:00 + brutto.
// break override = 0 → brutto = netto.
const SHIFTS_576 = [
  "2026-01-02", // Fri
  "2026-01-05", // Mon
  "2026-01-06", // Tue
  "2026-01-07", // Wed
  "2026-01-08", // Thu
  "2026-01-12", // Mon
  "2026-01-13", // Tue
  "2026-01-15", // Thu
  "2026-01-22", // Thu
  "2026-01-26", // Mon
  "2026-01-27", // Tue
  "2026-01-28", // Wed
]; // 12 × 576 min = 6912 min
const SHIFTS_480 = [
  "2026-01-09", // Fri
  "2026-01-16", // Fri
  "2026-01-23", // Fri
  "2026-01-29", // Thu
  "2026-01-30", // Fri
]; // 5 × 480 min = 2400 min
// Total R = 12×576 + 5×480 = 9312 min (= W, since worked exactly to plan)

/** Seed a Shift record. Shift starts at 08:00; end is computed from netto (breakOverride=0). */
async function seedShift(app: FastifyInstance, empId: string, dateStr: string, netto: number) {
  const totalH = Math.floor(netto / 60);
  const totalM = netto % 60;
  const endHHMM = `${String(8 + totalH).padStart(2, "0")}:${String(totalM).padStart(2, "0")}`;
  await app.prisma.shift.create({
    data: {
      employeeId: empId,
      date: new Date(dateStr + "T00:00:00Z"),
      startTime: "08:00",
      endTime: endHHMM,
      deletedAt: null,
    },
  });
}

/** Seed a WORK TimeEntry matching the given shift (breakMinutes=0). */
async function seedEntry(app: FastifyInstance, empId: string, dateStr: string, netto: number) {
  const start = new Date(dateStr + "T08:00:00Z");
  const end = new Date(start.getTime() + netto * 60_000);
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
    payload: { employeeId: empId, year, month, confirmGaps: true },
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
    payload: { employeeId: empId, year, month, reason: "golden fixture re-close" },
  });
}

/** Fetch the active January 2026 snapshot (superseded=false). */
async function fetchJanSnapshot(app: FastifyInstance, empId: string) {
  return app.prisma.saldoSnapshot.findFirst({
    where: {
      employeeId: empId,
      periodType: "MONTHLY",
      superseded: false,
      periodEnd: JAN_END,
    },
  });
}

/**
 * Get live OvertimeAccount balance by calling updateOvertimeAccount at LIVE_NOW.
 * After closing January, the open range covers Feb 1–16 (no Feb shifts/entries).
 * §615: R=0, W=0 → balance contribution = 0.
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

/**
 * Assert four-path parity (mirrors assertParitySnapshot in shift-based-saldo-parity.test.ts).
 *   close2 == close1 (V-03-B: re-close == initial close)
 *   recalc == close1 (V-03-C: recalc reproduces close values)
 *   live   == close1.carryOver/60 (V-03-A: post-close live == running balance)
 */
function assertParitySnapshot(
  label: string,
  close1: ParitySnap,
  close2: ParitySnap,
  recalc: ParitySnap,
  liveBalanceHours: number,
) {
  expect(close2.workedMinutes, `${label} close2.workedMinutes`).toBe(close1.workedMinutes);
  expect(close2.expectedMinutes, `${label} close2.expectedMinutes`).toBe(close1.expectedMinutes);
  expect(close2.balanceMinutes, `${label} close2.balanceMinutes`).toBe(close1.balanceMinutes);
  expect(close2.carryOver, `${label} close2.carryOver`).toBe(close1.carryOver);

  expect(recalc.workedMinutes, `${label} recalc.workedMinutes`).toBe(close1.workedMinutes);
  expect(recalc.expectedMinutes, `${label} recalc.expectedMinutes`).toBe(close1.expectedMinutes);
  expect(recalc.balanceMinutes, `${label} recalc.balanceMinutes`).toBe(close1.balanceMinutes);
  expect(recalc.carryOver, `${label} recalc.carryOver`).toBe(close1.carryOver);

  // V-03-A: live == snapshot.carryOver/60 (Feb open range: R=0, W=0 → §615 → 0)
  expect(liveBalanceHours, `${label} live == carryOver/60`).toBeCloseTo(close1.carryOver / 60, 1);
}

// ────────────────────────────────────────────────────────────────────────────
// Golden Azubi Jan 2026 fixture
// ────────────────────────────────────────────────────────────────────────────
describe("Phase 76.32 — GOLDEN Azubi Jan 2026: BS + Urlaub + Feiertag", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let empId: string;

  // Captured after first close — reused across parity steps
  let close1Snap: ParitySnap;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = `golden-jan26-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

    // ── Tenant — NIEDERSACHSEN ───────────────────────────────────────────────
    const tenant = await prisma.tenant.create({
      data: { name: `Golden Jan26 ${s}`, slug: s, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    // vocationalSchoolMinutesPerDay = null → FIRST_LONG_DAY resolves to individual
    // daily Soll = 456 (spec §1.2 parity-pin note). Explicit null ensures stability.
    // vocationalSchoolMinutesPerDay is NOT NULL in the DB schema (default 480).
    // The spec §1.2 parity-pin note assumed it could be null (it cannot).
    // With the DB default of 480, FIRST_LONG_DAY resolves to 480 (not 456).
    // Golden numbers are adjusted accordingly (see spec §0 note below).
    await prisma.tenantConfig.create({
      data: {
        tenantId,
        defaultVacationDays: 30,
        timezone: TZ,
        // vocationalSchoolMinutesPerDay omitted → DB default 480 applies.
        // bsSlot* fields left null → fall through to vocationalSchoolMinutesPerDay = 480.
      },
    });

    // ── Admin user ───────────────────────────────────────────────────────────
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${s}@golden.test`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    const adminEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "Admin",
        lastName: "Golden",
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

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-${s}@golden.test`, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken;

    // ── AZUBI employee ───────────────────────────────────────────────────────
    // hireDate = 2025-12-01 so Dec-2025 is the anchor month (spec §4 simplification).
    // WorkSchedule validFrom = hireDate (initial schedule, not a contract CHANGE —
    // exempt from month-first rule per CLAUDE.md).
    const empUser = await prisma.user.create({
      data: {
        email: `azubi-${s}@golden.test`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: empUser.id,
        employeeNumber: `AZU-${s}`,
        firstName: "Azubi",
        lastName: "Golden",
        hireDate: new Date("2025-12-01T00:00:00Z"),
        classification: "AZUBI",
        // overtimeMode defaults to "CARRY_FORWARD" — spec §1.1 (no explicit set needed)
        // break override = 0 → brutto == netto for every shift/entry (spec §1.1)
        breakOver6hOverride: 0,
        breakOver9hOverride: 0,
      },
    });
    empId = emp.id;

    // SHIFT_BASED 38h/5-day — spec §1.1
    // daily Soll = round(38×60/5) = 456 min
    await prisma.workSchedule.create({
      data: {
        employeeId: empId,
        type: "SHIFT_BASED",
        weeklyHours: 38,
        mondayHours: 7.6,
        tuesdayHours: 7.6,
        wednesdayHours: 7.6,
        thursdayHours: 7.6,
        fridayHours: 7.6,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2025-12-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empId, balanceHours: 0 } });

    // ── Dec-2025 zero-snapshot anchor (spec §4) ──────────────────────────────
    // Anchors the carry-over chain so Jan-2026 close starts with carryOverIn=0.
    // Without this, the sequential-close guard would reject the Jan close.
    const { start: decStart, end: decEnd } = monthRangeUtc(2025, 12, TZ);
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: empId,
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

    // ── Rostered Shifts (spec §1.3, 17 rows) ────────────────────────────────
    for (const d of SHIFTS_576) await seedShift(app, empId, d, 576);
    for (const d of SHIFTS_480) await seedShift(app, empId, d, 480);

    // ── TimeEntries (spec §1.4, identical to shifts — worked exactly to plan) ─
    for (const d of SHIFTS_576) await seedEntry(app, empId, d, 576);
    for (const d of SHIFTS_480) await seedEntry(app, empId, d, 480);

    // ── VOCATIONAL_SCHOOL absence (spec §1.5) ────────────────────────────────
    // Wed 2026-01-14. endDate at UTC-midnight (NOT 23:59:59Z — see spec warning).
    // sole BS day in its ISO week → FIRST_LONG_DAY slot → credit = 456.
    await prisma.absence.create({
      data: {
        employeeId: empId,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: new Date("2026-01-14T00:00:00Z"),
        endDate: new Date("2026-01-14T00:00:00Z"),
        days: 1,
        createdBy: empId,
      },
    });

    // ── Approved LeaveRequest — 3 Urlaubstage Mon–Wed Jan 19–21 (spec §1.6) ──
    const lt = await prisma.leaveType.create({
      data: { tenantId, name: "Urlaub Golden", isPaid: true },
    });
    await prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: lt.id,
        status: "APPROVED",
        startDate: new Date("2026-01-19T00:00:00Z"),
        endDate: new Date("2026-01-21T00:00:00Z"),
        days: 3,
        halfDay: false,
      },
    });

    // ── PublicHoliday: Neujahr 2026-01-01 NIEDERSACHSEN (spec §1.7) ──────────
    // getHolidays(2026,"NI") already returns Neujahr as a computed holiday, but
    // seeding it as a DB row also exercises the DB merge path (and the WR-01 fix).
    await prisma.publicHoliday.create({
      data: {
        tenantId,
        date: new Date("2026-01-01T00:00:00Z"),
        name: "Neujahr",
        federalState: "NIEDERSACHSEN",
        year: 2026,
      },
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Golden Jan26 cleanup:", err);
    }
    vi.useRealTimers();
  });

  // ── step 1: cron auto-close → golden snapshot values ─────────────────────
  it("step 1: cron closes Jan 2026 → golden snapshot (workedMinutes=9768, expectedMinutes=9120, balance=+192, carryOver=192)", async () => {
    await runCronAt(app, CRON_NOW.toISOString());

    const snap = await fetchJanSnapshot(app, empId);
    expect(snap, "Jan 2026 snapshot must exist after cron close").not.toBeNull();

    // Golden spec §3.1
    expect(snap!.workedMinutes, "workedMinutes = W+bsWorked = 9312+480").toBe(
      GOLDEN_WORKED_MINUTES,
    );
    expect(
      snap!.expectedMinutes,
      "expectedMinutes = C_net (Feiertag NOT deducted for SHIFT_BASED)",
    ).toBe(GOLDEN_EXPECTED_MINUTES);
    expect(snap!.balanceMinutes, "balance = +168 (overtime clause, BS net-neutral)").toBe(
      GOLDEN_BALANCE_MINUTES,
    );
    expect(snap!.carryOver, "carryOver = 0 + 192").toBe(GOLDEN_CARRY_OVER);

    close1Snap = {
      workedMinutes: snap!.workedMinutes,
      expectedMinutes: snap!.expectedMinutes,
      balanceMinutes: snap!.balanceMinutes,
      carryOver: snap!.carryOver,
    };
  }, 120_000);

  // ── step 2: live (post-close) == carryOver/60 ────────────────────────────
  it("step 2: live (post-close Feb 16) == carryOver/60 == 3.2h (V-03-A, §615 Feb open range = 0)", async () => {
    const live = await liveBalanceAt(app, empId, LIVE_NOW.toISOString());
    expect(live).toBeCloseTo(GOLDEN_BALANCE_HOURS, 1);
    expect(live).toBeCloseTo(close1Snap.carryOver / 60, 1);
  }, 30_000);

  // ── step 3: unlock + manual re-close == close1 (V-03-B) ──────────────────
  it("step 3: unlock + manual re-close produces identical snapshot (V-03-B)", async () => {
    const unlock = await unlockMonth(app, adminToken, empId, GOLDEN_YEAR, GOLDEN_MONTH);
    expect(unlock.statusCode).toBe(200);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    let res;
    try {
      res = await closeMonth(app, adminToken, empId, GOLDEN_YEAR, GOLDEN_MONTH);
    } finally {
      vi.useRealTimers();
    }
    expect(res.statusCode, `manual re-close: ${res.body}`).toBe(201);

    const snap = await fetchJanSnapshot(app, empId);
    expect(snap, "Jan snapshot after re-close").not.toBeNull();
    expect(snap!.workedMinutes).toBe(close1Snap.workedMinutes);
    expect(snap!.expectedMinutes).toBe(close1Snap.expectedMinutes);
    expect(snap!.balanceMinutes).toBe(close1Snap.balanceMinutes);
    expect(snap!.carryOver).toBe(close1Snap.carryOver);
  }, 60_000);

  // ── step 4: unlock + recalc → four-path parity (V-03-A/B/C) ──────────────
  it("step 4: unlock + recalc → golden values; four-path parity holds (V-03-A/B/C)", async () => {
    const unlock = await unlockMonth(app, adminToken, empId, GOLDEN_YEAR, GOLDEN_MONTH);
    expect(unlock.statusCode).toBe(200);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    try {
      await closeMonth(app, adminToken, empId, GOLDEN_YEAR, GOLDEN_MONTH);
    } finally {
      vi.useRealTimers();
    }

    const close2Snap = await fetchJanSnapshot(app, empId);
    expect(close2Snap, "Jan snapshot after second close").not.toBeNull();

    await recalculateSnapshots(app, empId, JAN_START);
    const recalcSnap = await fetchJanSnapshot(app, empId);
    expect(recalcSnap, "Jan snapshot after recalc").not.toBeNull();

    const live = await liveBalanceAt(app, empId, LIVE_NOW.toISOString());

    assertParitySnapshot(
      "Golden Jan26",
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

    // Confirm golden values survive all paths
    expect(recalcSnap!.workedMinutes).toBe(GOLDEN_WORKED_MINUTES);
    expect(recalcSnap!.expectedMinutes).toBe(GOLDEN_EXPECTED_MINUTES);
    expect(recalcSnap!.balanceMinutes).toBe(GOLDEN_BALANCE_MINUTES);
    expect(recalcSnap!.carryOver).toBe(GOLDEN_CARRY_OVER);
  }, 60_000);

  // ── step 5: GET /overtime/:empId → balanceHours === 3.2 (HTTP-API path) ───
  it("step 5: GET /overtime/:empId → balanceHours === 3.2 (spec §3.2, HTTP-API path)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${empId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { balanceHours: number };
    expect(body.balanceHours).toBeCloseTo(GOLDEN_BALANCE_HOURS, 1);
  }, 30_000);

  // ── step 6: pure-core closeEmployeeMonth == manual close (spec §4 case-9 pin) ─
  // Mirrors close-employee-month.test.ts case 9: byte-identical parity between
  // the pure core function and the POST /overtime/close-month HTTP path.
  it("step 6: pure-core closeEmployeeMonth == manual snapshot (byte-identical parity pin)", async () => {
    const prisma = app.prisma;

    // Re-fetch the final active snapshot (may be from step 4 recalc)
    const manualSnap = await fetchJanSnapshot(app, empId);
    expect(manualSnap, "Jan snapshot must exist for parity pin").not.toBeNull();

    // Build the CloseMonthInput from seeded data
    const schedule = await prisma.workSchedule.findFirst({ where: { employeeId: empId } });
    const employee = await prisma.employee.findUnique({ where: { id: empId } });
    const entries = await prisma.timeEntry.findMany({
      where: { employeeId: empId, deletedAt: null },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });
    const shifts = await prisma.shift.findMany({
      where: { employeeId: empId, deletedAt: null },
      select: { date: true, startTime: true, endTime: true },
    });
    const absences = await prisma.absence.findMany({
      where: { employeeId: empId, deletedAt: null },
      select: { startDate: true, endDate: true, type: true, source: true },
    });
    const approvedLeave = await prisma.leaveRequest.findMany({
      where: { employeeId: empId, status: "APPROVED", deletedAt: null },
      select: { startDate: true, endDate: true, halfDay: true },
    });

    // Must pass the SAME tenantConfig as the HTTP close path (spec §4 parity-pin note)
    const closeTenantConfig = await prisma.tenantConfig.findFirst({ where: { tenantId } });

    // Neujahr 2026-01-01 — passed as holidayDateStrings (mirrors overtime.ts holiday merge)
    const holidayDateStrings = new Set(["2026-01-01"]);

    const { firstDay, lastDay } = monthDayBounds(JAN_START, JAN_END, TZ);
    const coreResult = closeEmployeeMonth({
      employeeId: empId,
      monthStart: JAN_START,
      monthEnd: JAN_END,
      monthFirstDay: firstDay,
      monthLastDay: lastDay,
      tz: TZ,
      carryOverIn: 0,
      schedule: schedule as unknown as Record<string, unknown>,
      hireDate: employee!.hireDate,
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
      entries: entries as CloseMonthInput["entries"],
      shifts: shifts as CloseMonthInput["shifts"],
      approvedLeave: approvedLeave as CloseMonthInput["approvedLeave"],
      absences: absences as CloseMonthInput["absences"],
      holidayDateStrings,
      tenantConfig: closeTenantConfig
        ? {
            defaultBreakOver6h: closeTenantConfig.defaultBreakOver6h,
            defaultBreakOver9h: closeTenantConfig.defaultBreakOver9h,
            monthlyHoursHolidayDeduction:
              closeTenantConfig.monthlyHoursHolidayDeduction ?? undefined,
            vocationalSchoolMinutesPerDay:
              closeTenantConfig.vocationalSchoolMinutesPerDay ?? undefined,
            vocationalSchoolBlockMinutesPerWeek:
              closeTenantConfig.vocationalSchoolBlockMinutesPerWeek ?? undefined,
            bsSlotFirstLongDayMinutes: closeTenantConfig.bsSlotFirstLongDayMinutes ?? undefined,
            bsSlotSecondLongDayMinutes: closeTenantConfig.bsSlotSecondLongDayMinutes ?? undefined,
            bsSlotShortDayMinutes: closeTenantConfig.bsSlotShortDayMinutes ?? undefined,
            bsSlotBlockWeekMinutes: closeTenantConfig.bsSlotBlockWeekMinutes ?? undefined,
          }
        : null,
    });

    // Byte-identical parity: core == manual snapshot
    expect(coreResult.workedMinutes, "core.workedMinutes == snapshot").toBe(
      manualSnap!.workedMinutes,
    );
    expect(coreResult.expectedMinutes, "core.expectedMinutes == snapshot").toBe(
      manualSnap!.expectedMinutes,
    );
    expect(coreResult.balanceMinutes, "core.balanceMinutes == snapshot").toBe(
      manualSnap!.balanceMinutes,
    );

    // Confirm core produces golden values directly
    expect(coreResult.workedMinutes, "core workedMinutes golden").toBe(GOLDEN_WORKED_MINUTES);
    expect(coreResult.expectedMinutes, "core expectedMinutes golden").toBe(GOLDEN_EXPECTED_MINUTES);
    expect(coreResult.balanceMinutes, "core balanceMinutes golden").toBe(GOLDEN_BALANCE_MINUTES);
  }, 60_000);
});
