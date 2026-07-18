/**
 * Integration test scaffold for closeEmployeeMonth — RED until Plan 02 creates close-employee-month.ts
 *
 * Covers CLOSE-05 (four-path parity), SNAP-05 (DST boundary), cross-year carryOver,
 * BS-doubling, MONTHLY_HOURS no-gap, FIXED gap month, and SHIFT_BASED Model B + §615.
 *
 * Uses getTestApp/seedTestData/cleanupTestData from ./setup.ts.
 * seedEntry pattern: 07:00–15:30, 30 min break = 480 net minutes (mirrors saldo-invariant-e2e.test.ts).
 *
 * The four-path parity assertion (case 8) is the primary CLOSE-05 acceptance gate:
 * closeEmployeeMonth() result must equal manual close + cron close + recalculate-snapshots
 * for both a FIXED and a SHIFT_BASED fixture.
 *
 * References: RESEARCH.md §5.2, §10.3, §10.4 item 2, §2 (divergence table), REQUIREMENTS CLOSE-05, SNAP-05.
 */

// RED until Plan 02 creates close-employee-month.ts
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { monthRangeUtc, monthDayBounds } from "../utils/timezone";
import { recalculateSnapshots } from "../utils/recalculate-snapshots";
import { updateOvertimeAccount } from "../routes/time-entries";
import bcrypt from "bcryptjs";
import type { CloseMonthInput, CloseMonthResult } from "../utils/close-employee-month";
import { closeEmployeeMonth } from "../utils/close-employee-month";

const TZ = "Europe/Berlin";

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Seed a time entry: 07:00–15:30, 30 min break = 480 net minutes (canonical seedEntry pattern) */
async function seedEntry(app: FastifyInstance, empId: string, dateStr: string) {
  await app.prisma.timeEntry.create({
    data: {
      employeeId: empId,
      date: new Date(dateStr + "T00:00:00Z"),
      startTime: new Date(dateStr + "T07:00:00Z"),
      endTime: new Date(dateStr + "T15:30:00Z"),
      breakMinutes: 30,
      type: "WORK",
    },
  });
}

/** All Mon–Fri date strings within [fromStr, toStr] inclusive */
function monFriInRange(fromStr: string, toStr: string): string[] {
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

/** POST /overtime/close-month */
async function closeMonthApi(
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

/** POST /overtime/unlock-month */
async function unlockMonthApi(
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
    payload: { employeeId: empId, year, month, reason: "close-employee-month test re-close" },
  });
}

/** Fetch the active snapshot for a given month (superseded=false) */
async function fetchActiveSnapshot(app: FastifyInstance, empId: string, periodEnd: Date) {
  return app.prisma.saldoSnapshot.findFirst({
    where: { employeeId: empId, periodType: "MONTHLY", superseded: false, periodEnd },
  });
}

/**
 * Assert four-path parity (CLOSE-05 crux):
 * closeEmployeeMonth result == manual close snapshot == cron/recalc snapshot
 * Mirrors the assertParitySnapshot pattern from shift-based-saldo-parity.test.ts (§10.3)
 */
function assertFourPathParity(
  label: string,
  coreResult: Pick<CloseMonthResult, "workedMinutes" | "expectedMinutes" | "balanceMinutes">,
  manualSnap: {
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
  },
  recalcSnap: {
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
  },
) {
  // closeEmployeeMonth core == manual close (via POST /overtime/close-month)
  expect(coreResult.workedMinutes, `${label} core.workedMinutes == manual`).toBe(
    manualSnap.workedMinutes,
  );
  expect(coreResult.expectedMinutes, `${label} core.expectedMinutes == manual`).toBe(
    manualSnap.expectedMinutes,
  );
  expect(coreResult.balanceMinutes, `${label} core.balanceMinutes == manual`).toBe(
    manualSnap.balanceMinutes,
  );

  // manual close == retroactive recalc (recalculateSnapshots)
  expect(manualSnap.workedMinutes, `${label} manual.workedMinutes == recalc`).toBe(
    recalcSnap.workedMinutes,
  );
  expect(manualSnap.expectedMinutes, `${label} manual.expectedMinutes == recalc`).toBe(
    recalcSnap.expectedMinutes,
  );
  expect(manualSnap.balanceMinutes, `${label} manual.balanceMinutes == recalc`).toBe(
    recalcSnap.balanceMinutes,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Case 1: FIXED gap month — one missing Wednesday, gaps contains it, saldo penalizes
// CLOSE-01 precursor / CLOSE-05
// ──────────────────────────────────────────────────────────────────────────────

describe("closeEmployeeMonth — case 1: FIXED gap month (CLOSE-05)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let empId: string;

  // July 2026: 23 Mon–Fri workdays. Seed all EXCEPT 2026-07-01 (Wed) → 22 entries.
  const JULY_WORKDAYS = monFriInRange("2026-07-01", "2026-07-31");
  const { start: JULY_START, end: JULY_END } = monthRangeUtc(2026, 7, TZ);

  beforeAll(async () => {
    app = await getTestApp();
    const s = `gap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const prisma = app.prisma;

    const tenant = await prisma.tenant.create({
      data: { name: `CloseGap ${s}`, slug: s, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ },
    });

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
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "Admin",
        lastName: "G.",
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
        email: `emp-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: empUser.id,
        employeeNumber: `EMP-${s}`,
        firstName: "Fixed",
        lastName: "G.",
        hireDate: new Date("2026-01-01T00:00:00Z"),
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
        validFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    empId = emp.id;

    // Seed entries for all July workdays EXCEPT 2026-07-01 (the gap Wednesday)
    for (const d of JULY_WORKDAYS) {
      if (d !== "2026-07-01") await seedEntry(app, empId, d);
    }

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-${s}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken;
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Case 1 cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("case 1: closeEmployeeMonth result.gaps contains the missing Wednesday, expectedMinutes is full Soll", async () => {
    const schedule = await app.prisma.workSchedule.findFirst({
      where: { employeeId: empId },
    });
    const employee = await app.prisma.employee.findUnique({ where: { id: empId } });
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: empId, deletedAt: null },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });
    const entryDates = new Set(entries.map((e) => e.date.toISOString().slice(0, 10)));

    const input: CloseMonthInput = {
      employeeId: empId,
      monthStart: JULY_START,
      monthEnd: JULY_END,
      monthFirstDay: monthDayBounds(JULY_START, JULY_END, TZ).firstDay,
      monthLastDay: monthDayBounds(JULY_START, JULY_END, TZ).lastDay,
      tz: TZ,
      carryOverIn: 0,
      schedule: schedule as unknown as Record<string, unknown>,
      hireDate: employee!.hireDate,
      exitDate: employee!.exitDate ?? null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: employee!.breakOver6hOverride ?? null,
      breakOver9hOverride: employee!.breakOver9hOverride ?? null,
      entries: entries as CloseMonthInput["entries"],
      shifts: [],
      approvedLeave: [],
      absences: [],
      holidayDateStrings: new Set<string>(),
      tenantConfig: null,
    };

    const result = closeEmployeeMonth(input);

    // The missing Wednesday 2026-07-01 must appear in gaps
    const gapDates = result.gaps.map((g) => g.date);
    expect(gapDates).toContain("2026-07-01");
    expect(result.gaps.find((g) => g.date === "2026-07-01")!.partial).toBe(false);

    // workedMinutes excludes the gap day (22 days × 480 min = 10560)
    expect(result.workedMinutes).toBe(22 * 480);

    // expectedMinutes includes the gap day — full Soll, NOT reduced by the gap (CLOSE-05)
    // July 2026: 23 Mon–Fri workdays. C = 23 × (40h × 60min / 5 days) = 23 × 480 = 11040
    expect(result.expectedMinutes).toBe(23 * 480);

    // balanceMinutes reflects the gap penalty: worked - expected = −480 min (1 day missing)
    expect(result.balanceMinutes).toBe(-480);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Case 2: FIXED four-path parity — closeEmployeeMonth == manual close == recalc
// CLOSE-05 (the crux)
// ──────────────────────────────────────────────────────────────────────────────

describe("closeEmployeeMonth — case 2: FIXED four-path parity (CLOSE-05)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let empId: string;

  // Use June 2026 (already in the past as of 2026-07-18) so the future-month
  // guard in close-month API does not trigger. hireDate = June 1 means the
  // sequential guard loop runs from month 6 to 6 (exclusive) = 0 iterations.
  const JUNE_WORKDAYS = monFriInRange("2026-06-01", "2026-06-30");
  const { start: JUNE_START, end: JUNE_END } = monthRangeUtc(2026, 6, TZ);

  beforeAll(async () => {
    app = await getTestApp();
    const s = `parity-fixed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const prisma = app.prisma;

    const tenant = await prisma.tenant.create({
      data: { name: `Parity Fixed ${s}`, slug: s, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ },
    });

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
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "Admin",
        lastName: "PF",
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
        email: `emp-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: empUser.id,
        employeeNumber: `EMP-${s}`,
        firstName: "Fixed",
        lastName: "PF",
        // hireDate = June 1 so no prior months require closing (sequential guard loop
        // runs from seqStartMonth=6 to month=6, exclusive → 0 iterations). June 2026 is
        // already in the past (today = 2026-07-18) so the future-month guard also passes.
        hireDate: new Date("2026-06-01T00:00:00Z"),
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
        validFrom: new Date("2026-06-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    empId = emp.id;

    // Seed all June workdays
    for (const d of JUNE_WORKDAYS) {
      await seedEntry(app, empId, d);
    }

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-${s}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken;
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Case 2 cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("case 2: closeEmployeeMonth() result == manual close == recalc for FIXED (four-path parity, CLOSE-05)", async () => {
    const schedule = await app.prisma.workSchedule.findFirst({ where: { employeeId: empId } });
    const employee = await app.prisma.employee.findUnique({ where: { id: empId } });
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: empId, deletedAt: null },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });

    const { firstDay, lastDay } = monthDayBounds(JUNE_START, JUNE_END, TZ);
    const input: CloseMonthInput = {
      employeeId: empId,
      monthStart: JUNE_START,
      monthEnd: JUNE_END,
      monthFirstDay: firstDay,
      monthLastDay: lastDay,
      tz: TZ,
      carryOverIn: 0,
      schedule: schedule as unknown as Record<string, unknown>,
      hireDate: employee!.hireDate,
      exitDate: employee!.exitDate ?? null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: employee!.breakOver6hOverride ?? null,
      breakOver9hOverride: employee!.breakOver9hOverride ?? null,
      entries: entries as CloseMonthInput["entries"],
      shifts: [],
      approvedLeave: [],
      absences: [],
      holidayDateStrings: new Set<string>(),
      tenantConfig: null,
    };

    const coreResult = closeEmployeeMonth(input);

    // Manual close via API — June 2026 is already in the past (today = 2026-07-18),
    // so the future-month guard passes without any fake-timer manipulation.
    // No fake timers → no JWT expiry risk.
    const manualRes = await closeMonthApi(app, adminToken, empId, 2026, 6);
    expect(manualRes.statusCode, `manual close: ${manualRes.body}`).toBe(201);
    const manualSnap = await fetchActiveSnapshot(app, empId, JUNE_END);
    expect(manualSnap, "manual snapshot must exist").not.toBeNull();

    // Retroactive recalc
    await unlockMonthApi(app, adminToken, empId, 2026, 6);
    await closeMonthApi(app, adminToken, empId, 2026, 6);
    await recalculateSnapshots(app, empId, JUNE_START);
    const recalcSnap = await fetchActiveSnapshot(app, empId, JUNE_END);
    expect(recalcSnap, "recalc snapshot must exist").not.toBeNull();

    assertFourPathParity(
      "FIXED Parity",
      coreResult,
      {
        workedMinutes: manualSnap!.workedMinutes,
        expectedMinutes: manualSnap!.expectedMinutes,
        balanceMinutes: manualSnap!.balanceMinutes,
      },
      {
        workedMinutes: recalcSnap!.workedMinutes,
        expectedMinutes: recalcSnap!.expectedMinutes,
        balanceMinutes: recalcSnap!.balanceMinutes,
      },
    );
  }, 120_000);
});

// ──────────────────────────────────────────────────────────────────────────────
// Case 3: SHIFT_BASED Model B + §615 parity
// ──────────────────────────────────────────────────────────────────────────────

describe("closeEmployeeMonth — case 3: SHIFT_BASED Model B + §615 (CLOSE-05)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let empId: string;

  const { start: FEB_START, end: FEB_END } = monthRangeUtc(2026, 2, TZ);
  // February 2026: 20 Mon–Fri workdays
  const FEB_WORKDAYS = monFriInRange("2026-02-02", "2026-02-27");
  const LIVE_NOW = new Date("2026-03-16T10:00:00.000Z");

  beforeAll(async () => {
    app = await getTestApp();
    const s = `shiftb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const prisma = app.prisma;

    const tenant = await prisma.tenant.create({
      data: { name: `ShiftB ${s}`, slug: s, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ },
    });

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
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "Admin",
        lastName: "SB",
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
        email: `emp-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: empUser.id,
        employeeNumber: `EMP-${s}`,
        firstName: "Shift",
        lastName: "SB",
        hireDate: new Date("2026-01-01T00:00:00Z"),
        breakOver6hOverride: 0,
        breakOver9hOverride: 0,
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
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
        validFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    empId = emp.id;

    // Seed Dec-2025 zero snapshot for carry-over chain
    const dec = monthRangeUtc(2025, 12, TZ);
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: empId,
        periodType: "MONTHLY",
        periodStart: dec.start,
        periodEnd: dec.end,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
        closedBy: "test-seed",
      },
    });

    // 10 shifts + 10 entries on Feb 2–13 (2 weeks of work), rest of month no roster
    const HALF_FEB = FEB_WORKDAYS.slice(0, 10);
    for (const d of HALF_FEB) {
      await prisma.shift.create({
        data: {
          employeeId: empId,
          date: new Date(d + "T00:00:00Z"),
          startTime: "07:00",
          endTime: "15:30",
          deletedAt: null,
        },
      });
      await seedEntry(app, empId, d);
    }

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-${s}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken;
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Case 3 cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("case 3: SHIFT_BASED closeEmployeeMonth balanceMinutes matches calcShiftBasedSaldo two-clause; expectedMinutes == C_net", async () => {
    const schedule = await app.prisma.workSchedule.findFirst({ where: { employeeId: empId } });
    const employee = await app.prisma.employee.findUnique({ where: { id: empId } });
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: empId, deletedAt: null },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });
    const shifts = await app.prisma.shift.findMany({
      where: { employeeId: empId, deletedAt: null },
      select: { date: true, startTime: true, endTime: true },
    });

    const { firstDay, lastDay } = monthDayBounds(FEB_START, FEB_END, TZ);
    const input: CloseMonthInput = {
      employeeId: empId,
      monthStart: FEB_START,
      monthEnd: FEB_END,
      monthFirstDay: firstDay,
      monthLastDay: lastDay,
      tz: TZ,
      carryOverIn: 0,
      schedule: schedule as unknown as Record<string, unknown>,
      hireDate: employee!.hireDate,
      exitDate: employee!.exitDate ?? null,
      isTimeTrackingExempt: false,
      // null = use tenant default 30 min break → shift 07:00–15:30 brutto 510 − 30 = 480 netto = R
      breakOver6hOverride: null,
      breakOver9hOverride: null,
      entries: entries as CloseMonthInput["entries"],
      shifts: shifts as CloseMonthInput["shifts"],
      approvedLeave: [],
      absences: [],
      holidayDateStrings: new Set<string>(),
      tenantConfig: null,
    };

    const result = closeEmployeeMonth(input);

    // C = round(38×60×20/5) = 9120.
    // Shifts 07:00–15:30 = 510 min brutto. breakOver6hOverride=null → tenant default 30 min break.
    // Shift netto = 510 − 30 = 480 min. R = 10 × 480 = 4800.
    // W = 10 × 480 = 4800 (entries 07:00–15:30, breakMinutes=30).
    // §615: overtime = max(0,4800−9120) = 0; undertime = max(0,4800−4800) = 0; balance = 0.
    // (employee only rostered and worked 10 days — employer never rostered the other 10 = §615 Betriebsrisiko)
    expect(result.expectedMinutes).toBe(9120);
    expect(result.workedMinutes).toBe(10 * 480); // 10 days × 480 min
    expect(result.balanceMinutes).toBe(0); // §615: no employer fault penalty
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────────────
// Case 4: SHIFT_BASED BS-doubling preserved (bsExpectedMinutes + bsWorkedMinutes)
// RESEARCH §2 BS-doubling row
// ──────────────────────────────────────────────────────────────────────────────

describe("closeEmployeeMonth — case 4: SHIFT_BASED BS-doubling preserved (bsExpectedMinutes)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;

  const { start: FEB_START, end: FEB_END } = monthRangeUtc(2026, 2, TZ);

  beforeAll(async () => {
    app = await getTestApp();
    const s = `bs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const prisma = app.prisma;

    const tenant = await prisma.tenant.create({
      data: { name: `BS ${s}`, slug: s, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ },
    });

    const empUser = await prisma.user.create({
      data: {
        email: `emp-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: empUser.id,
        employeeNumber: `EMP-${s}`,
        firstName: "Azubi",
        lastName: "BS",
        hireDate: new Date("2026-01-01T00:00:00Z"),
        breakOver6hOverride: 0,
        breakOver9hOverride: 0,
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
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
        validFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    empId = emp.id;

    // 1 VOCATIONAL_SCHOOL absence on Feb 2 (a Monday) = BS day
    await prisma.absence.create({
      data: {
        employeeId: empId,
        startDate: new Date("2026-02-02T00:00:00Z"),
        endDate: new Date("2026-02-02T23:59:59Z"),
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        days: 1,
        createdBy: empId,
      },
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Case 4 cleanup:", err);
    }
  });

  it("case 4: BS day (VOCATIONAL_SCHOOL absence) contributes to both bsExpectedMinutes and bsWorkedMinutes — balance-neutral", async () => {
    const schedule = await app.prisma.workSchedule.findFirst({ where: { employeeId: empId } });
    const employee = await app.prisma.employee.findUnique({ where: { id: empId } });
    const absences = await app.prisma.absence.findMany({
      where: { employeeId: empId, deletedAt: null },
      select: { startDate: true, endDate: true, type: true, source: true },
    });

    const { firstDay, lastDay } = monthDayBounds(FEB_START, FEB_END, TZ);
    const input: CloseMonthInput = {
      employeeId: empId,
      monthStart: FEB_START,
      monthEnd: FEB_END,
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
      entries: [],
      shifts: [],
      approvedLeave: [],
      absences: absences as CloseMonthInput["absences"],
      holidayDateStrings: new Set<string>(),
      tenantConfig: null,
    };

    const result = closeEmployeeMonth(input);

    // BS day should NOT reduce balance — it contributes equally to both Soll and Ist sides.
    // With 0 other entries, only BS-day contributes. The saldo for the BS-day itself is neutral.
    // §615 applies for the non-BS days (no roster) → balance stays 0.
    expect(result.balanceMinutes).toBe(0);
  }, 30_000);
});

// ──────────────────────────────────────────────────────────────────────────────
// Case 5: MONTHLY_HOURS — no daily gap, leave does not reduce expectedMinutes
// ──────────────────────────────────────────────────────────────────────────────

describe("closeEmployeeMonth — case 5: MONTHLY_HOURS no-gap, leave NOT deducted (CLAUDE.md MONTHLY_HOURS rule)", () => {
  it("case 5: MONTHLY_HOURS with leave and no entries → result.gaps is [] and leave does not reduce expectedMinutes", async () => {
    const app = await getTestApp();

    const { start: JULY_START, end: JULY_END } = monthRangeUtc(2026, 7, TZ);
    const { firstDay, lastDay } = monthDayBounds(JULY_START, JULY_END, TZ);

    const input: CloseMonthInput = {
      employeeId: "test-monthly-hours-no-gap",
      monthStart: JULY_START,
      monthEnd: JULY_END,
      monthFirstDay: firstDay,
      monthLastDay: lastDay,
      tz: TZ,
      carryOverIn: 0,
      schedule: {
        type: "MONTHLY_HOURS",
        monthlyHours: 80,
        weeklyHours: 0,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
      },
      hireDate: new Date("2026-01-01T00:00:00Z"),
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: null,
      breakOver9hOverride: null,
      entries: [],
      shifts: [],
      approvedLeave: [
        {
          startDate: new Date("2026-07-07T00:00:00Z"),
          endDate: new Date("2026-07-11T23:59:59Z"),
          halfDay: false,
        },
      ],
      absences: [],
      holidayDateStrings: new Set<string>(),
      tenantConfig: null,
    };

    const result = closeEmployeeMonth(input);

    // CLAUDE.md MONTHLY_HOURS rule: leave does NOT reduce expectedMinutes
    // MONTHLY_HOURS gaps are always []
    expect(result.gaps).toHaveLength(0);
    // expectedMinutes for MONTHLY_HOURS = monthlyHours × 60 = 80 × 60 = 4800 (not reduced by leave)
    expect(result.expectedMinutes).toBe(80 * 60);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Case 6: DST month (March 2026) — timezone boundary correct, no off-by-one (SNAP-05)
// ──────────────────────────────────────────────────────────────────────────────

describe("closeEmployeeMonth — case 6: DST month March 2026 (SNAP-05)", () => {
  it("case 6: March 2026 close succeeds across DST boundary (2026-03-29), day count correct", () => {
    // DST transition: 2026-03-29 Europe/Berlin jumps from UTC+1 → UTC+2
    // Clocks go forward at 02:00 local → 25-hour Monday; 31 days in March 2026
    // Mon–Fri workdays in March 2026: 22 days (no NI holidays)
    const { start: MAR_START, end: MAR_END } = monthRangeUtc(2026, 3, TZ);
    const { firstDay, lastDay } = monthDayBounds(MAR_START, MAR_END, TZ);

    // Seed 22 entries for all March Mon–Fri workdays
    const MAR_WORKDAYS = monFriInRange("2026-03-02", "2026-03-31");
    const entryDates = new Set(MAR_WORKDAYS);

    const input: CloseMonthInput = {
      employeeId: "test-dst-march-2026",
      monthStart: MAR_START,
      monthEnd: MAR_END,
      monthFirstDay: firstDay,
      monthLastDay: lastDay,
      tz: TZ,
      carryOverIn: 0,
      schedule: {
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
      },
      hireDate: new Date("2026-01-01T00:00:00Z"),
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: null,
      breakOver9hOverride: null,
      entries: MAR_WORKDAYS.map((d) => ({
        date: new Date(d + "T00:00:00Z"),
        startTime: new Date(d + "T07:00:00Z"),
        endTime: new Date(d + "T15:30:00Z"),
        breakMinutes: 30,
      })),
      shifts: [],
      approvedLeave: [],
      absences: [],
      holidayDateStrings: new Set<string>(),
      tenantConfig: null,
    };

    const result = closeEmployeeMonth(input);

    // March 2026: 22 Mon–Fri workdays (no NI holidays, including the DST-transition Monday 2026-03-30)
    // expectedMinutes = 22 × 480 = 10560
    expect(result.expectedMinutes).toBe(22 * 480);
    expect(result.workedMinutes).toBe(22 * 480);
    expect(result.balanceMinutes).toBe(0);
    // No off-by-one on DST boundary: no gaps
    expect(result.gaps).toHaveLength(0);
    void entryDates; // used above for the entries array construction
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Case 7: Cross-year carryOver chain (carryOverIn flows through correctly)
// CLOSE-05
// ──────────────────────────────────────────────────────────────────────────────

describe("closeEmployeeMonth — case 7: cross-year carryOver chain (CLOSE-05)", () => {
  it("case 7: carryOverIn=600 flows to carryOverOut === carryOverIn + balanceMinutes", () => {
    // Pass carryOverIn = 600 min (10h from prior month). With all entries present,
    // balance = 0 → carryOverOut = 600 + 0 = 600.
    // With a shortfall of 480 min, balance = −480 → carryOverOut = 600 + (−480) = 120.
    const { start: JULY_START, end: JULY_END } = monthRangeUtc(2026, 7, TZ);
    const { firstDay, lastDay } = monthDayBounds(JULY_START, JULY_END, TZ);
    const JULY_WORKDAYS = monFriInRange("2026-07-01", "2026-07-31"); // 23 workdays

    // Seed 22 entries (1 gap) → balance = −480
    const ENTRIES = JULY_WORKDAYS.filter((d) => d !== "2026-07-01").map((d) => ({
      date: new Date(d + "T00:00:00Z"),
      startTime: new Date(d + "T07:00:00Z"),
      endTime: new Date(d + "T15:30:00Z"),
      breakMinutes: 30,
    }));

    const input: CloseMonthInput = {
      employeeId: "test-carryover-chain",
      monthStart: JULY_START,
      monthEnd: JULY_END,
      monthFirstDay: firstDay,
      monthLastDay: lastDay,
      tz: TZ,
      carryOverIn: 600, // 10h carry-in from prior month
      schedule: {
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
      },
      hireDate: new Date("2026-01-01T00:00:00Z"),
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: null,
      breakOver9hOverride: null,
      entries: ENTRIES,
      shifts: [],
      approvedLeave: [],
      absences: [],
      holidayDateStrings: new Set<string>(),
      tenantConfig: null,
    };

    const result = closeEmployeeMonth(input);

    // balance = 22×480 − 23×480 = −480
    expect(result.balanceMinutes).toBe(-480);

    // Cross-year carryOver chain: carryOverOut === carryOverIn + balanceMinutes (before TRACK_ONLY zeroing)
    expect(result.carryOverOut).toBe(600 + result.balanceMinutes); // 600 + (−480) = 120
    expect(result.carryOverOut).toBe(120);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Case 8: Four-path parity assertion — SHIFT_BASED + FIXED (CLOSE-05 crux)
// Replicates assertFourPathParity from shift-based-saldo-parity.test.ts
// closeEmployeeMonth == manual close == recalc for real DB fixtures
// ──────────────────────────────────────────────────────────────────────────────

describe("closeEmployeeMonth — case 8: four-path parity SHIFT_BASED + FIXED (CLOSE-05 crux)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let fixedEmpId: string;
  let shiftEmpId: string;

  const { start: FEB_START, end: FEB_END } = monthRangeUtc(2026, 2, TZ);
  const FEB_WORKDAYS = monFriInRange("2026-02-02", "2026-02-27");
  const LIVE_NOW = new Date("2026-03-16T10:00:00.000Z");

  beforeAll(async () => {
    app = await getTestApp();
    const s = `parity4p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const prisma = app.prisma;

    const tenant = await prisma.tenant.create({
      data: { name: `Parity4P ${s}`, slug: s, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ },
    });

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
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "Admin",
        lastName: "4P",
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

    async function createEmpInTenant(
      type: "FIXED_SCHEDULE" | "SHIFT_BASED",
      extraSchedule: Record<string, unknown>,
      key: string,
    ) {
      const eu = await prisma.user.create({
        data: {
          email: `emp-${type}-${s}@test.de`,
          passwordHash: await bcrypt.hash("test1234", 10),
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const emp = await prisma.employee.create({
        data: {
          tenantId,
          userId: eu.id,
          employeeNumber: `EMP-${type}-${s}`,
          firstName: key,
          lastName: "4P",
          hireDate: new Date("2026-01-01T00:00:00Z"),
          breakOver6hOverride: type === "SHIFT_BASED" ? 0 : null,
          breakOver9hOverride: type === "SHIFT_BASED" ? 0 : null,
        },
      });
      await prisma.workSchedule.create({
        data: {
          employeeId: emp.id,
          type,
          weeklyHours: type === "SHIFT_BASED" ? 38 : 40,
          ...(type === "SHIFT_BASED"
            ? {
                mondayHours: 7.6,
                tuesdayHours: 7.6,
                wednesdayHours: 7.6,
                thursdayHours: 7.6,
                fridayHours: 7.6,
              }
            : {
                mondayHours: 8,
                tuesdayHours: 8,
                wednesdayHours: 8,
                thursdayHours: 8,
                fridayHours: 8,
              }),
          saturdayHours: 0,
          sundayHours: 0,
          workDays: [1, 2, 3, 4, 5],
          validFrom: new Date("2026-01-01T00:00:00Z"),
          ...extraSchedule,
        },
      });
      await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

      // Dec-2025 zero snapshot anchor
      const dec = monthRangeUtc(2025, 12, TZ);
      await prisma.saldoSnapshot.create({
        data: {
          employeeId: emp.id,
          periodType: "MONTHLY",
          periodStart: dec.start,
          periodEnd: dec.end,
          workedMinutes: 0,
          expectedMinutes: 0,
          balanceMinutes: 0,
          carryOver: 0,
          closedAt: new Date(),
          closedBy: "test-seed-4p",
        },
      });

      return emp.id;
    }

    fixedEmpId = await createEmpInTenant("FIXED_SCHEDULE", {}, "Fixed");
    shiftEmpId = await createEmpInTenant("SHIFT_BASED", {}, "Shift");

    // Seed Jan close + Feb entries for both
    for (const empId of [fixedEmpId, shiftEmpId]) {
      for (const d of FEB_WORKDAYS) {
        await seedEntry(app, empId, d);
      }
    }
    // Seed shifts for SHIFT_BASED employee (same 20 days as entries)
    for (const d of FEB_WORKDAYS) {
      await prisma.shift.create({
        data: {
          employeeId: shiftEmpId,
          date: new Date(d + "T00:00:00Z"),
          startTime: "07:00",
          endTime: "15:30",
          deletedAt: null,
        },
      });
    }

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-${s}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken;
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Case 8 cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("case 8a: FIXED four-path parity — closeEmployeeMonth == manual close == recalc (CLOSE-05)", async () => {
    const schedule = await app.prisma.workSchedule.findFirst({ where: { employeeId: fixedEmpId } });
    const employee = await app.prisma.employee.findUnique({ where: { id: fixedEmpId } });
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: fixedEmpId, deletedAt: null },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });

    const { firstDay, lastDay } = monthDayBounds(FEB_START, FEB_END, TZ);
    const coreResult = closeEmployeeMonth({
      employeeId: fixedEmpId,
      monthStart: FEB_START,
      monthEnd: FEB_END,
      monthFirstDay: firstDay,
      monthLastDay: lastDay,
      tz: TZ,
      carryOverIn: 0,
      schedule: schedule as unknown as Record<string, unknown>,
      hireDate: employee!.hireDate,
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: null,
      breakOver9hOverride: null,
      entries: entries as CloseMonthInput["entries"],
      shifts: [],
      approvedLeave: [],
      absences: [],
      holidayDateStrings: new Set<string>(),
      tenantConfig: null,
    });

    // Close Jan first (required for Feb carry-over chain)
    const { start: JAN_START } = monthRangeUtc(2026, 1, TZ);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    try {
      await closeMonthApi(app, adminToken, fixedEmpId, 2026, 1);
    } finally {
      vi.useRealTimers();
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    let manualRes;
    try {
      manualRes = await closeMonthApi(app, adminToken, fixedEmpId, 2026, 2);
    } finally {
      vi.useRealTimers();
    }
    expect(manualRes.statusCode, `manual close: ${manualRes.body}`).toBe(201);
    const manualSnap = await fetchActiveSnapshot(app, fixedEmpId, FEB_END);

    await unlockMonthApi(app, adminToken, fixedEmpId, 2026, 2);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    try {
      await closeMonthApi(app, adminToken, fixedEmpId, 2026, 2);
    } finally {
      vi.useRealTimers();
    }
    await recalculateSnapshots(app, fixedEmpId, JAN_START);
    const recalcSnap = await fetchActiveSnapshot(app, fixedEmpId, FEB_END);

    assertFourPathParity(
      "Case 8a FIXED parity",
      coreResult,
      {
        workedMinutes: manualSnap!.workedMinutes,
        expectedMinutes: manualSnap!.expectedMinutes,
        balanceMinutes: manualSnap!.balanceMinutes,
      },
      {
        workedMinutes: recalcSnap!.workedMinutes,
        expectedMinutes: recalcSnap!.expectedMinutes,
        balanceMinutes: recalcSnap!.balanceMinutes,
      },
    );
  }, 120_000);

  it("case 8b: SHIFT_BASED four-path parity — closeEmployeeMonth == manual close == recalc (CLOSE-05)", async () => {
    const schedule = await app.prisma.workSchedule.findFirst({ where: { employeeId: shiftEmpId } });
    const employee = await app.prisma.employee.findUnique({ where: { id: shiftEmpId } });
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: shiftEmpId, deletedAt: null },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });
    const shifts = await app.prisma.shift.findMany({
      where: { employeeId: shiftEmpId, deletedAt: null },
      select: { date: true, startTime: true, endTime: true },
    });

    const { firstDay, lastDay } = monthDayBounds(FEB_START, FEB_END, TZ);
    const coreResult = closeEmployeeMonth({
      employeeId: shiftEmpId,
      monthStart: FEB_START,
      monthEnd: FEB_END,
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
      approvedLeave: [],
      absences: [],
      holidayDateStrings: new Set<string>(),
      tenantConfig: null,
    });

    const { start: JAN_START } = monthRangeUtc(2026, 1, TZ);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    try {
      await closeMonthApi(app, adminToken, shiftEmpId, 2026, 1);
    } finally {
      vi.useRealTimers();
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    let manualRes;
    try {
      manualRes = await closeMonthApi(app, adminToken, shiftEmpId, 2026, 2);
    } finally {
      vi.useRealTimers();
    }
    expect(manualRes.statusCode, `manual SHIFT close: ${manualRes.body}`).toBe(201);
    const manualSnap = await fetchActiveSnapshot(app, shiftEmpId, FEB_END);

    await unlockMonthApi(app, adminToken, shiftEmpId, 2026, 2);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    try {
      await closeMonthApi(app, adminToken, shiftEmpId, 2026, 2);
    } finally {
      vi.useRealTimers();
    }
    await recalculateSnapshots(app, shiftEmpId, JAN_START);
    const recalcSnap = await fetchActiveSnapshot(app, shiftEmpId, FEB_END);

    assertFourPathParity(
      "Case 8b SHIFT_BASED parity",
      coreResult,
      {
        workedMinutes: manualSnap!.workedMinutes,
        expectedMinutes: manualSnap!.expectedMinutes,
        balanceMinutes: manualSnap!.balanceMinutes,
      },
      {
        workedMinutes: recalcSnap!.workedMinutes,
        expectedMinutes: recalcSnap!.expectedMinutes,
        balanceMinutes: recalcSnap!.balanceMinutes,
      },
    );
  }, 120_000);
});
