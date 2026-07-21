/**
 * SNAP-40: SaldoSnapshot as live-recompute basis (Issue #6, SALDO-10, D-06).
 *
 * This spec CODIFIES an already-correct invariant (RESEARCH: HIGH confidence — the
 * live recompute base is ALREADY `lastSnapshot` at time-entries.ts:1844-1847). It
 * does NOT force any production behaviour: no GET-time SaldoSnapshot write, no new
 * base lookup. The four describes pin the D-06 correctness + audit-proof invariants
 * so any future regression fails loudly:
 *
 *   1. Self-healing parity — a MISSING intermediate monthly snapshot self-heals to the
 *      per-month closeEmployeeMonth reference (no drift, no lost history).
 *   2. Bounded-window steady state — prior month closed → the open window is the current
 *      partial month only; a pre-snapshot-month entry does NOT move the live balance.
 *   3. Read-idempotency (D-03, audit-proof) — updateOvertimeAccount does NOT write a
 *      SaldoSnapshot; the row count is byte-unchanged after a live recompute.
 *   4. Reopen base resolution (76.33, SC#3) — when the latest snapshot is superseded, the
 *      base falls back to the previous non-superseded snapshot (NOT reopen→0, NOT the
 *      superseded row).
 *
 * The reference in every parity describe calls the SAME closeEmployeeMonth core the live
 * path calls (no bespoke math), filters holidays per-month (Pitfall 6), threads
 * effectiveCarryOverOut (Pitfall 3), and keeps the employee non-exempt (Pitfall 4).
 *
 * No PII — synthetic slugs only. DO NOT modify any production file (the invariant is
 * proven, not forced — D-07: never weaken an assertion; investigate a red as a real bug).
 *
 * Helpers are COPIED VERBATIM from snap-01-open-window.test.ts (seedEntry, liveMinutesAt,
 * createTenant) and snap-03-per-month-parity.test.ts (seedMonthlySnapshot, buildHolidaySet,
 * filterHolidaySet, monFriDates + imports getHolidays/STATE_MAP) — they are per-file
 * module-scoped helpers, not shared exports.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { monthRangeUtc, monthDayBounds, dateStrInTz } from "../utils/timezone";
import { updateOvertimeAccount } from "../routes/time-entries";
import { closeEmployeeMonth } from "../utils/close-employee-month";
import { getHolidays, STATE_MAP } from "../utils/holidays";

const TZ = "Europe/Berlin";

// ── Helpers (copied verbatim from snap-01 / snap-03) ──────────────────────────

/** Seed a TimeEntry (type=WORK, zero break) for a given date and net duration. (snap-01) */
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

/** Run updateOvertimeAccount at a frozen "now" and return balanceHours × 60 (minutes). (snap-01) */
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

/** Create an isolated tenant with one FIXED_SCHEDULE 40h/week employee. (snap-01) */
async function createTenant(
  app: FastifyInstance,
  slug: string,
  hireDate: Date,
): Promise<{ tenantId: string; empId: string }> {
  const s = `snap40-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`;
  const prisma = app.prisma;

  const tenant = await prisma.tenant.create({
    data: { name: `Snap40 ${slug}`, slug: s, federalState: "NIEDERSACHSEN" },
  });
  await prisma.tenantConfig.create({
    data: { tenantId: tenant.id, defaultVacationDays: 30, timezone: TZ },
  });

  const adminUser = await prisma.user.create({
    data: {
      email: `admin-${s}@snap40.test`,
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
      lastName: "S40",
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
      email: `emp-${s}@snap40.test`,
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

/** Seed a MONTHLY SaldoSnapshot for a given month. (snap-03) */
async function seedMonthlySnapshot(
  app: FastifyInstance,
  empId: string,
  year: number,
  month: number,
  carryOver: number,
  workedMinutes = 0,
  expectedMinutes = 0,
  balanceMinutes = 0,
): Promise<void> {
  const { start, end } = monthRangeUtc(year, month, TZ);
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
      closedAt: new Date(),
      closedBy: "snap40-test-seed",
    },
  });
}

// Build holiday set for a given year (NI state). (snap-03)
function buildHolidaySet(year: number): Set<string> {
  return new Set<string>(getHolidays(year, STATE_MAP["NIEDERSACHSEN"] ?? "NI").map((h) => h.date));
}

/**
 * Filter a holiday set to only those dates within [fromStr, toStr] (inclusive, YYYY-MM-DD).
 * The live path filters per-month before passing to closeEmployeeMonth(); references must
 * do the same, else all annual holidays are subtracted from every month's expected. (snap-03)
 */
function filterHolidaySet(holidays: Set<string>, fromStr: string, toStr: string): Set<string> {
  return new Set([...holidays].filter((d) => d >= fromStr && d <= toStr));
}

// All Mon–Fri dates in [fromStr, toStr] as "YYYY-MM-DD". (snap-03)
function monFriDates(fromStr: string, toStr: string): string[] {
  const out: string[] = [];
  const cur = new Date(fromStr + "T00:00:00Z");
  const end = new Date(toStr + "T00:00:00Z");
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Describe 1: self-healing parity — missing intermediate March snapshot self-heals
// to the per-month closeEmployeeMonth reference.
// ─────────────────────────────────────────────────────────────────────────────

describe("SNAP-40 — self-healing parity: missing intermediate snapshot lands on hireDate-iteration reference", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;

  const HIRE_DATE = new Date("2026-01-01T00:00:00Z");
  // Grace day >= 15 so the current partial month (April) is stable; Apr-16 has no entry
  // → cutoff = yesterday (Apr-15) per Pitfall 2.
  const LIVE_NOW = "2026-04-16T10:00:00.000Z";
  const FEB_CARRY_OVER = 2400;

  const MARCH_ENTRIES = monFriDates("2026-03-01", "2026-03-31");
  const APRIL_PARTIAL_ENTRIES = monFriDates("2026-04-01", "2026-04-15");

  // Reference (built in beforeAll via closeEmployeeMonth per open month).
  let reference = 0;

  beforeAll(async () => {
    app = await getTestApp();
    const fixture = await createTenant(app, "self-heal", HIRE_DATE);
    tenantId = fixture.tenantId;
    empId = fixture.empId;

    // Feb 2026 MONTHLY snapshot (carryOver=2400, superseded defaults false). rangeStart = Mar 1.
    await seedMonthlySnapshot(app, empId, 2026, 2, FEB_CARRY_OVER, 9600, 9600, 0);

    // March 2026 entries — NO March snapshot (the intermediate gap that must self-heal).
    for (const d of MARCH_ENTRIES) {
      await seedEntry(app, empId, d, 480);
    }
    // April 2026 partial entries (Apr 1–15).
    for (const d of APRIL_PARTIAL_ENTRIES) {
      await seedEntry(app, empId, d, 480);
    }

    // ── Reference: per-month closeEmployeeMonth iteration (the ground truth the live
    //    path itself calls), threading effectiveCarryOverOut March → April-partial.
    const schedule = await app.prisma.workSchedule.findFirst({ where: { employeeId: empId } });
    const emp = await app.prisma.employee.findUnique({ where: { id: empId } });

    // March (complete open month)
    const { start: marStart, end: marEnd } = monthRangeUtc(2026, 3, TZ);
    const { firstDay: marFirstDay, lastDay: marLastDay } = monthDayBounds(marStart, marEnd, TZ);
    const marFirstStr = dateStrInTz(marFirstDay, TZ);
    const marLastStr = dateStrInTz(marLastDay, TZ);
    const marEntries = await app.prisma.timeEntry.findMany({
      where: { employeeId: empId, deletedAt: null, date: { gte: marFirstDay, lte: marLastDay } },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });
    const marchResult = closeEmployeeMonth({
      employeeId: empId,
      monthStart: marStart,
      monthEnd: marEnd,
      monthFirstDay: marFirstDay,
      monthLastDay: marLastDay,
      tz: TZ,
      carryOverIn: FEB_CARRY_OVER,
      schedule: schedule as Record<string, unknown>,
      hireDate: emp!.hireDate,
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
      entries: marEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes ?? 0,
      })),
      shifts: [],
      approvedLeave: [],
      absences: [],
      holidayDateStrings: filterHolidaySet(buildHolidaySet(2026), marFirstStr, marLastStr),
      tenantConfig: { defaultBreakOver6h: 0, defaultBreakOver9h: 0 },
    });

    // April (current partial month — cutoff = Apr-15, since Apr-16 has no entry per Pitfall 2)
    const { start: aprStart, end: aprEnd } = monthRangeUtc(2026, 4, TZ);
    const { firstDay: aprFirstDay } = monthDayBounds(aprStart, aprEnd, TZ);
    const aprFirstStr = dateStrInTz(aprFirstDay, TZ);
    const effectiveEnd = new Date("2026-04-15T00:00:00Z");
    const aprEntries = await app.prisma.timeEntry.findMany({
      where: { employeeId: empId, deletedAt: null, date: { gte: aprFirstDay, lte: effectiveEnd } },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });
    // Non-SHIFT partial month: production passes monthEnd = effectiveEnd (time-entries.ts:2299
    // `partialMonthEnd = scheduleType === "SHIFT_BASED" ? currentMonthRange.end : effectiveEnd`),
    // so calcExpectedMinutesTz (close-employee-month.ts:584) covers ONLY the open window
    // [Apr-1, Apr-15]. Using the full-month aprEnd here would inflate expected → reference drift.
    const aprilResult = closeEmployeeMonth({
      employeeId: empId,
      monthStart: aprStart,
      monthEnd: effectiveEnd,
      monthFirstDay: aprFirstDay,
      monthLastDay: effectiveEnd,
      tz: TZ,
      carryOverIn: marchResult.effectiveCarryOverOut,
      schedule: schedule as Record<string, unknown>,
      hireDate: emp!.hireDate,
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
      entries: aprEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes ?? 0,
      })),
      shifts: [],
      approvedLeave: [],
      absences: [],
      holidayDateStrings: filterHolidaySet(buildHolidaySet(2026), aprFirstStr, "2026-04-15"),
      tenantConfig: { defaultBreakOver6h: 0, defaultBreakOver9h: 0 },
    });

    // Displayed base = snapshotCarryOver + Σ open-month balances (SNAP-01 convention).
    reference = FEB_CARRY_OVER + marchResult.balanceMinutes + aprilResult.balanceMinutes;
  }, 300_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("SNAP-40 self-heal cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("missing-intermediate March snapshot self-heals to the per-month closeEmployeeMonth reference (<5 min)", async () => {
    const live = await liveMinutesAt(app, empId, LIVE_NOW);
    expect(
      Math.abs(live - reference),
      `self-heal parity: live=${live} ref=${reference}`,
    ).toBeLessThan(5);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Describe 2: bounded-window steady state — prior month closed → the open window is
// the current partial month only; a pre-snapshot-month entry does NOT move the balance.
// ─────────────────────────────────────────────────────────────────────────────

describe("SNAP-40 — bounded-window steady state: prior month closed → open window = current partial month", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;

  const HIRE_DATE = new Date("2026-01-01T00:00:00Z");
  const LIVE_NOW = "2026-04-16T10:00:00.000Z";
  const MARCH_CARRY_OVER = 1200;
  const APRIL_PARTIAL_ENTRIES = monFriDates("2026-04-01", "2026-04-15");

  // Reference = snapshotCarryOver + single current-partial close (bounded window = current month).
  let reference = 0;
  // Live balance recorded BEFORE the pre-snapshot-month probe entry.
  let liveBefore = 0;

  beforeAll(async () => {
    app = await getTestApp();
    const fixture = await createTenant(app, "bounded", HIRE_DATE);
    tenantId = fixture.tenantId;
    empId = fixture.empId;

    // March 2026 snapshot → the prior month is CLOSED (rangeStart = Apr 1, completeOpenMonths empty).
    await seedMonthlySnapshot(app, empId, 2026, 3, MARCH_CARRY_OVER, 9600, 9600, 0);

    // April 2026 partial entries (Apr 1–15).
    for (const d of APRIL_PARTIAL_ENTRIES) {
      await seedEntry(app, empId, d, 480);
    }

    // Reference: ONLY the current partial April close runs (prior month closed). monthEnd =
    // effectiveEnd (non-SHIFT partial-window, time-entries.ts:2299) so expected covers Apr 1–15.
    const schedule = await app.prisma.workSchedule.findFirst({ where: { employeeId: empId } });
    const emp = await app.prisma.employee.findUnique({ where: { id: empId } });
    const { start: aprStart, end: aprEnd } = monthRangeUtc(2026, 4, TZ);
    const { firstDay: aprFirstDay } = monthDayBounds(aprStart, aprEnd, TZ);
    const aprFirstStr = dateStrInTz(aprFirstDay, TZ);
    const effectiveEnd = new Date("2026-04-15T00:00:00Z");
    const aprEntries = await app.prisma.timeEntry.findMany({
      where: { employeeId: empId, deletedAt: null, date: { gte: aprFirstDay, lte: effectiveEnd } },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });
    const aprilResult = closeEmployeeMonth({
      employeeId: empId,
      monthStart: aprStart,
      monthEnd: effectiveEnd,
      monthFirstDay: aprFirstDay,
      monthLastDay: effectiveEnd,
      tz: TZ,
      carryOverIn: MARCH_CARRY_OVER,
      schedule: schedule as Record<string, unknown>,
      hireDate: emp!.hireDate,
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
      entries: aprEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes ?? 0,
      })),
      shifts: [],
      approvedLeave: [],
      absences: [],
      holidayDateStrings: filterHolidaySet(buildHolidaySet(2026), aprFirstStr, "2026-04-15"),
      tenantConfig: { defaultBreakOver6h: 0, defaultBreakOver9h: 0 },
    });
    reference = MARCH_CARRY_OVER + aprilResult.balanceMinutes;

    // Record the live balance before the pre-snapshot-month probe.
    liveBefore = await liveMinutesAt(app, empId, LIVE_NOW);
  }, 300_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("SNAP-40 bounded-window cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("live == snapshotCarryOver + single current-partial close (bounded window = current month only, <5 min)", async () => {
    expect(
      Math.abs(liveBefore - reference),
      `bounded window: live=${liveBefore} ref=${reference}`,
    ).toBeLessThan(5);
  }, 30_000);

  it("seeding a pre-snapshot-month entry (Feb, before March snapshot) does NOT move the live balance", async () => {
    // Feb-14 2026 is a Saturday — not in any Mon–Fri seed set, so no one-entry-per-day conflict
    // (CLAUDE.md). It falls BEFORE the March snapshot boundary → invisible to the live window.
    await seedEntry(app, empId, "2026-02-14", 480);
    const liveAfter = await liveMinutesAt(app, empId, LIVE_NOW);
    expect(
      Math.abs(liveAfter - liveBefore),
      `pre-snapshot Feb entry must not move balance: before=${liveBefore} after=${liveAfter}`,
    ).toBeLessThan(5);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Describe 3: read-idempotency — updateOvertimeAccount does NOT write a SaldoSnapshot
// (D-03, audit-proof). The SaldoSnapshot row count is byte-unchanged after a recompute.
// ─────────────────────────────────────────────────────────────────────────────

describe("SNAP-40 — read-idempotency: updateOvertimeAccount does NOT write a SaldoSnapshot (D-03, audit-proof)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;

  const HIRE_DATE = new Date("2026-01-01T00:00:00Z");
  const APRIL_PARTIAL_ENTRIES = monFriDates("2026-04-01", "2026-04-15");

  beforeAll(async () => {
    app = await getTestApp();
    const fixture = await createTenant(app, "read-idem", HIRE_DATE);
    tenantId = fixture.tenantId;
    empId = fixture.empId;

    // March snapshot (prior month closed) + April partial entries — a normal live-recompute setup.
    await seedMonthlySnapshot(app, empId, 2026, 3, 1200, 9600, 9600, 0);
    for (const d of APRIL_PARTIAL_ENTRIES) {
      await seedEntry(app, empId, d, 480);
    }
  }, 300_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("SNAP-40 read-idempotency cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("SaldoSnapshot row count is unchanged after a live recompute — GET is side-effect-free", async () => {
    const before = await app.prisma.saldoSnapshot.count({ where: { employeeId: empId } });
    await liveMinutesAt(app, empId, "2026-04-16T10:00:00.000Z"); // drives updateOvertimeAccount
    const after = await app.prisma.saldoSnapshot.count({ where: { employeeId: empId } });
    expect(after).toBe(before);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Describe 4: reopen base resolution (76.33, SC#3) — superseded latest snapshot → the
// base falls back to the previous non-superseded snapshot (NOT reopen→0, NOT the
// superseded row). The SALDO-09 reopen→0 regression must stay fixed.
// ─────────────────────────────────────────────────────────────────────────────

describe("SNAP-40 — reopen base resolution (76.33, SC#3): superseded latest snapshot → base falls back to previous non-superseded", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;

  const HIRE_DATE = new Date("2026-01-01T00:00:00Z");
  const LIVE_NOW = "2026-04-16T10:00:00.000Z";
  const FEB_CARRY_OVER = 2400;
  const MARCH_CARRY_OVER = 3600;
  const MARCH_ENTRIES = monFriDates("2026-03-01", "2026-03-31");
  const APRIL_PARTIAL_ENTRIES = monFriDates("2026-04-01", "2026-04-15");

  // Reference: base = Feb snapshot (latest non-superseded) → open range spans March + April-partial.
  let reference = 0;

  beforeAll(async () => {
    app = await getTestApp();
    const fixture = await createTenant(app, "reopen-base", HIRE_DATE);
    tenantId = fixture.tenantId;
    empId = fixture.empId;

    // Feb snapshot (superseded=false) — the correct base after March is reopened.
    await seedMonthlySnapshot(app, empId, 2026, 2, FEB_CARRY_OVER, 9600, 9600, 0);
    // March snapshot, then mark it superseded=true (simulating a 76.33 unlock/reopen of March).
    await seedMonthlySnapshot(app, empId, 2026, 3, MARCH_CARRY_OVER, 9600, 9600, 0);
    // SaldoSnapshot has NO Prisma composite unique key (Phase 76.21 replaced @@unique with a
    // partial unique index via raw SQL) → use updateMany keyed on employeeId+periodStart.
    const { start: marStartUtc } = monthRangeUtc(2026, 3, TZ);
    await app.prisma.saldoSnapshot.updateMany({
      where: { employeeId: empId, periodType: "MONTHLY", periodStart: marStartUtc },
      data: { superseded: true, supersededReason: "test-reopen" },
    });

    // March entries (the reopened month) + April partial entries.
    for (const d of MARCH_ENTRIES) {
      await seedEntry(app, empId, d, 480);
    }
    for (const d of APRIL_PARTIAL_ENTRIES) {
      await seedEntry(app, empId, d, 480);
    }

    // Reference: base = Feb carryOver → March (complete open) + April (partial) closes, threaded.
    const schedule = await app.prisma.workSchedule.findFirst({ where: { employeeId: empId } });
    const emp = await app.prisma.employee.findUnique({ where: { id: empId } });

    const { start: marStart, end: marEnd } = monthRangeUtc(2026, 3, TZ);
    const { firstDay: marFirstDay, lastDay: marLastDay } = monthDayBounds(marStart, marEnd, TZ);
    const marFirstStr = dateStrInTz(marFirstDay, TZ);
    const marLastStr = dateStrInTz(marLastDay, TZ);
    const marEntries = await app.prisma.timeEntry.findMany({
      where: { employeeId: empId, deletedAt: null, date: { gte: marFirstDay, lte: marLastDay } },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });
    const marchResult = closeEmployeeMonth({
      employeeId: empId,
      monthStart: marStart,
      monthEnd: marEnd,
      monthFirstDay: marFirstDay,
      monthLastDay: marLastDay,
      tz: TZ,
      carryOverIn: FEB_CARRY_OVER,
      schedule: schedule as Record<string, unknown>,
      hireDate: emp!.hireDate,
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
      entries: marEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes ?? 0,
      })),
      shifts: [],
      approvedLeave: [],
      absences: [],
      holidayDateStrings: filterHolidaySet(buildHolidaySet(2026), marFirstStr, marLastStr),
      tenantConfig: { defaultBreakOver6h: 0, defaultBreakOver9h: 0 },
    });

    const { start: aprStart, end: aprEnd } = monthRangeUtc(2026, 4, TZ);
    const { firstDay: aprFirstDay } = monthDayBounds(aprStart, aprEnd, TZ);
    const aprFirstStr = dateStrInTz(aprFirstDay, TZ);
    const effectiveEnd = new Date("2026-04-15T00:00:00Z");
    const aprEntries = await app.prisma.timeEntry.findMany({
      where: { employeeId: empId, deletedAt: null, date: { gte: aprFirstDay, lte: effectiveEnd } },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });
    const aprilResult = closeEmployeeMonth({
      employeeId: empId,
      monthStart: aprStart,
      monthEnd: effectiveEnd,
      monthFirstDay: aprFirstDay,
      monthLastDay: effectiveEnd,
      tz: TZ,
      carryOverIn: marchResult.effectiveCarryOverOut,
      schedule: schedule as Record<string, unknown>,
      hireDate: emp!.hireDate,
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
      entries: aprEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes ?? 0,
      })),
      shifts: [],
      approvedLeave: [],
      absences: [],
      holidayDateStrings: filterHolidaySet(buildHolidaySet(2026), aprFirstStr, "2026-04-15"),
      tenantConfig: { defaultBreakOver6h: 0, defaultBreakOver9h: 0 },
    });

    reference = FEB_CARRY_OVER + marchResult.balanceMinutes + aprilResult.balanceMinutes;
  }, 300_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("SNAP-40 reopen-base cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("superseded latest snapshot → live base = previous non-superseded (March re-included), not reopen→0 (<5 min)", async () => {
    const live = await liveMinutesAt(app, empId, LIVE_NOW);
    expect(Math.abs(live - reference), `reopen base: live=${live} ref=${reference}`).toBeLessThan(
      5,
    );

    // It must NOT anchor on the superseded March snapshot (which would give ~MARCH_CARRY_OVER +
    // April-only, excluding the reopened March range). Guard against that regression.
    const superSededMarchAnchor = MARCH_CARRY_OVER; // + April-only would be near this, not `reference`
    expect(
      Math.abs(live - superSededMarchAnchor),
      `reopen must NOT anchor on superseded March snapshot: live=${live} supersededAnchor≈${superSededMarchAnchor}`,
    ).toBeGreaterThan(5);
  }, 30_000);
});
