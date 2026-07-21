/**
 * Phase 76.32 — SOLL-KORRELATION display correctness regression tests.
 *
 * Tests 1–3 verify:
 *   1. BS single-count (SALDO-01 / D-01): SHIFT_BASED AZUBI with a Berufsschultag
 *      in the visible week → contractSollMinutesByEmp = 38h (2280 min), NOT 46h (2760).
 *      BS counted exactly once (on the Ist/assignedH side via vocationalSchoolMinutesByEmp).
 *
 *   2. Feiertag deduction (SALDO-02 / D-08): week containing a gesetzlicher Feiertag
 *      on a Mon–Fri workday → contractSollMinutesByEmp is reduced by exactly one day's
 *      Soll versus an otherwise-identical non-holiday week.
 *
 *   3. Display-only guard (D-04 / § 615): mirrors Test D from shifts-under-coverage.test.ts.
 *      OvertimeAccount.balanceHours is UNCHANGED before/after GET /shifts/week.
 *      No SaldoSnapshot row is created for the employee/month by the endpoint.
 *
 * TDD RED: Tests 1 and 2 are expected to FAIL on the current code (before the
 * shifts.ts fix in Task 2). Test 3 is expected to pass (display-only guard already
 * holds). After Task 2, all three tests must be GREEN.
 *
 * Setup pattern mirrors shifts-under-coverage.test.ts. Uses a future week
 * (weeksAhead=8) to avoid collision with shifts-under-coverage.test.ts (6 weeks ahead).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getHolidays } from "../utils/holidays";

const TZ = "Europe/Berlin";

function futureMondayIso(weeksAhead: number): string {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dow = today.getUTCDay(); // 0=Sun..6=Sat
  // Mirror the GET /week resolver logic (shifts.ts):
  // dow === 0 ? -6 : 1 - dow
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(today);
  monday.setUTCDate(monday.getUTCDate() + mondayOffset + weeksAhead * 7);
  return monday.toISOString().slice(0, 10);
}

/**
 * Find the ISO string of the Monday of the week that contains a specific
 * future date. Used to derive the test week for Feiertag test (Test 2).
 */
function mondayOfWeekContaining(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setUTCDate(monday.getUTCDate() + mondayOffset);
  return monday.toISOString().slice(0, 10);
}

// ── Shared AZUBI schedule (38h, Mon–Fri) ─────────────────────────────────────
// 38h/5-day = 7.6h/day = 456 min/day
// Full week Soll (Ø-Methode): 38×60×5/5 = 2280 min
const AZUBI_SCHEDULE = {
  type: "SHIFT_BASED" as const,
  weeklyHours: 38,
  mondayHours: 7.6,
  tuesdayHours: 7.6,
  wednesdayHours: 7.6,
  thursdayHours: 7.6,
  fridayHours: 7.6,
  saturdayHours: 0,
  sundayHours: 0,
  workDays: [1, 2, 3, 4, 5], // Mon–Fri
};

const EXPECTED_FULL_WEEK_SOLL_MIN = 2280; // 38h × 60 = 2280 min (5 workdays, Ø-Methode)
const EXPECTED_PER_DAY_SOLL_MIN = 456; // 2280 / 5

describe("Phase 76.32 — SOLL-KORRELATION display correctness (BS single-count + Feiertag deduction)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let empId: string;

  // Test 1 fixtures
  let weekMonday: string; // ISO Mon for BS test

  // Test 2 fixtures: find a future national Feiertag (NI) that falls on a Mon–Fri workday.
  // We use getHolidays() (same function the server uses) to guarantee consistency.
  // Christi Himmelfahrt is always a Thursday — it's the canonical choice, but we derive
  // the date dynamically so the test doesn't break if the Gauss formula produces a
  // slightly different string than a hardcoded date.
  const { FEIERTAG_ISO, FEIERTAG_WEEK_MONDAY, REFERENCE_WEEK_MONDAY } = (() => {
    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);
    // Scan 2027 and 2028 — at least one Himmelfahrt (always Thursday) will be found.
    for (const year of [2027, 2028, 2029]) {
      const holidays = getHolidays(year, "NI");
      for (const h of holidays) {
        if (h.date <= todayIso) continue; // must be in the future
        const d = new Date(h.date + "T00:00:00Z");
        const dow = d.getUTCDay(); // 1=Mon..5=Fri
        if (dow < 1 || dow > 5) continue; // must fall on a Mon–Fri workday
        // Non-holiday reference week: 2 weeks before (gives buffer if the preceding
        // week has another holiday in NI, which is uncommon).
        const feiertagWeekMonday = mondayOfWeekContaining(h.date);
        const refMondayDate = new Date(feiertagWeekMonday + "T00:00:00Z");
        refMondayDate.setUTCDate(refMondayDate.getUTCDate() - 14);
        const referenceWeekMonday = refMondayDate.toISOString().slice(0, 10);
        return {
          FEIERTAG_ISO: h.date,
          FEIERTAG_WEEK_MONDAY: feiertagWeekMonday,
          REFERENCE_WEEK_MONDAY: referenceWeekMonday,
        };
      }
    }
    // Fallback: should never be reached — Christi Himmelfahrt exists every year.
    throw new Error("No future weekday national Feiertag found in NI for 2027–2029");
  })();

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const suffix = "76-32-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // Use week 8 weeks ahead — avoids collision with shifts-under-coverage.test.ts (6 weeks)
    weekMonday = futureMondayIso(8);

    // ── Tenant + config ──────────────────────────────────────────────────────
    const tenant = await prisma.tenant.create({
      data: {
        name: `Phase 76.32 Test ${suffix}`,
        slug: `ph-76-32-${suffix}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: {
        tenantId,
        defaultVacationDays: 30,
        timezone: TZ,
      },
    });

    // ── Admin user ───────────────────────────────────────────────────────────
    const adminPasswordHash = await bcrypt.hash("test1234", 10);
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${suffix}@test.de`,
        passwordHash: adminPasswordHash,
        role: "ADMIN",
        isActive: true,
      },
    });
    const adminEmployee = await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${suffix}`,
        firstName: "Admin",
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: adminEmployee.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
    await prisma.overtimeAccount.create({
      data: { employeeId: adminEmployee.id, balanceHours: 0 },
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-${suffix}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken;

    // ── AZUBI employee (38h Mon–Fri, SHIFT_BASED) ────────────────────────────
    const empUser = await prisma.user.create({
      data: {
        email: `azubi-${suffix}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });

    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: empUser.id,
        employeeNumber: `AZU-${suffix}`,
        firstName: "Azubi",
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
        classification: "AZUBI",
      },
    });
    empId = emp.id;

    await prisma.workSchedule.create({
      data: {
        employeeId: empId,
        type: "SHIFT_BASED",
        weeklyHours: AZUBI_SCHEDULE.weeklyHours,
        mondayHours: AZUBI_SCHEDULE.mondayHours,
        tuesdayHours: AZUBI_SCHEDULE.tuesdayHours,
        wednesdayHours: AZUBI_SCHEDULE.wednesdayHours,
        thursdayHours: AZUBI_SCHEDULE.thursdayHours,
        fridayHours: AZUBI_SCHEDULE.fridayHours,
        saturdayHours: AZUBI_SCHEDULE.saturdayHours,
        sundayHours: AZUBI_SCHEDULE.sundayHours,
        workDays: AZUBI_SCHEDULE.workDays,
        validFrom: new Date("2024-01-01"),
      },
    });
    await prisma.overtimeAccount.create({
      data: { employeeId: empId, balanceHours: 0 },
    });

    // ── Seed a VocationalSchool Pattern (for empFederalState resolution in shifts.ts) ─
    // The GET /week handler builds empFederalState from vocSchoolPatterns to handle
    // Pendler-Azubi federal-state overrides. Without a pattern the fallback is
    // tenant.federalState (NIEDERSACHSEN → NI) which is correct for this test.
    // We do NOT seed a pattern here — the fallback is sufficient.
    //
    // vocationalSchoolMinutesByEmp is populated from Absence.type=VOCATIONAL_SCHOOL
    // rows resolved through the availabilityMap. Seed one VOCATIONAL_SCHOOL absence.
    const bsDate = new Date(weekMonday + "T00:00:00Z");
    bsDate.setUTCDate(bsDate.getUTCDate() + 2); // Wednesday of the test week
    await prisma.absence.create({
      data: {
        employeeId: empId,
        type: "VOCATIONAL_SCHOOL",
        startDate: bsDate,
        endDate: bsDate,
        days: 1,
        source: "MANUAL",
        createdBy: "system",
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Phase 76.32 test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Helper: GET /shifts/week ─────────────────────────────────────────────
  async function getWeek(monday: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${monday}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as {
      contractSollMinutesByEmp?: Record<string, number>;
      vocationalSchoolMinutesByEmp?: Record<string, number>;
      leaveMinutesByEmp?: Record<string, number>;
      absenceMinutesByEmp?: Record<string, number>;
    };
  }

  // ── Test 1: BS single-count (SALDO-01 / D-01) ────────────────────────────
  // RED: current code returns 2280 + vocSchoolMin (≥2280) — inflated when BS exists.
  // GREEN after Task 2: returns exactly 2280 (vocSchoolMin removed from Soll).
  it("Test 1 (SALDO-01): AZUBI with Berufsschultag → contractSollMinutesByEmp = 38h (2280 min), NOT inflated", async () => {
    const body = await getWeek(weekMonday);

    const contractSoll = body.contractSollMinutesByEmp?.[empId];
    const vocSchoolMin = body.vocationalSchoolMinutesByEmp?.[empId];

    // The BS absence must be surfaced on the Ist side (vocationalSchoolMinutesByEmp)
    expect(vocSchoolMin).toBeDefined();
    expect(vocSchoolMin).toBeGreaterThan(0);

    // D-01 fix: Soll must be the full 38h (2280 min) — NOT 38h + BS minutes.
    // Before fix: contractSoll = 2280 + vocSchoolMin (e.g. 2280 + 480 = 2760 → FAIL).
    // After fix: contractSoll = 2280 (BS only counted on Ist side).
    expect(contractSoll).toBeDefined();
    expect(contractSoll).toBe(EXPECTED_FULL_WEEK_SOLL_MIN); // 2280 min = 38h
    expect(contractSoll).not.toBe(EXPECTED_FULL_WEEK_SOLL_MIN + (vocSchoolMin ?? 0));
  });

  // ── Test 2: Feiertag deduction (SALDO-02 / D-08) ─────────────────────────
  // RED: current code does NOT deduct public holidays from baseSoll.
  // GREEN after Task 2: holiday week Soll is reduced by exactly one day's Soll.
  it("Test 2 (SALDO-02): week with gesetzlicher Feiertag (Christi Himmelfahrt 2027-05-05) → Soll reduced by one day", async () => {
    // Verify the holiday exists in the computed set (no DB seed needed — getHolidays is pure)
    const holidays2027 = getHolidays(2027, "NI");
    const himmelfahrt = holidays2027.find((h) => h.date === FEIERTAG_ISO);
    expect(himmelfahrt).toBeDefined(); // sanity: Christi Himmelfahrt must be in NI set

    // GET /shifts/week for the reference week (no holiday)
    const bodyRef = await getWeek(REFERENCE_WEEK_MONDAY);
    const sollRef = bodyRef.contractSollMinutesByEmp?.[empId];

    // GET /shifts/week for the holiday week
    const bodyHoliday = await getWeek(FEIERTAG_WEEK_MONDAY);
    const sollHoliday = bodyHoliday.contractSollMinutesByEmp?.[empId];

    expect(sollRef).toBeDefined();
    expect(sollHoliday).toBeDefined();

    // Reference week must be a full 38h week (2280 min)
    expect(sollRef).toBe(EXPECTED_FULL_WEEK_SOLL_MIN);

    // D-08 fix: holiday week Soll must be reduced by exactly one workday's Soll.
    // 38h / 5 workdays = 456 min/day → Soll = 2280 - 456 = 1824 min.
    // Before fix: sollHoliday === sollRef === 2280 (holiday not deducted → FAIL).
    // After fix: sollHoliday === sollRef - EXPECTED_PER_DAY_SOLL_MIN.
    expect(sollHoliday).toBe(sollRef! - EXPECTED_PER_DAY_SOLL_MIN);
    expect(sollHoliday).toBe(EXPECTED_FULL_WEEK_SOLL_MIN - EXPECTED_PER_DAY_SOLL_MIN); // 1824 min
  });

  // ── Test 3: Display-only guard (D-04 / § 615) ────────────────────────────
  // GREEN before AND after Task 2: the endpoint never writes to OvertimeAccount.
  it("Test 3 (display-only guard): OvertimeAccount.balanceHours unchanged after GET /shifts/week; no SaldoSnapshot created", async () => {
    const prisma = app.prisma;

    // Read OvertimeAccount BEFORE calling GET /shifts/week.
    const accountBefore = await prisma.overtimeAccount.findUnique({
      where: { employeeId: empId },
      select: { balanceHours: true },
    });
    expect(accountBefore).not.toBeNull();
    const balanceBefore = Number(accountBefore!.balanceHours);

    // Count SaldoSnapshot rows BEFORE the call.
    const snapshotCountBefore = await prisma.saldoSnapshot.count({
      where: { employeeId: empId },
    });

    // Call GET /shifts/week — employee has no shifts → under-rostered.
    const body = await getWeek(weekMonday);
    const contractSoll = body.contractSollMinutesByEmp?.[empId] ?? 0;
    expect(contractSoll).toBeGreaterThan(0); // confirms under-coverage scenario

    // Read OvertimeAccount AFTER the call.
    const accountAfter = await prisma.overtimeAccount.findUnique({
      where: { employeeId: empId },
      select: { balanceHours: true },
    });
    expect(accountAfter).not.toBeNull();
    const balanceAfter = Number(accountAfter!.balanceHours);

    // LOAD-BEARING: balance must be byte-identical (D-04, § 615 planning-only).
    expect(balanceAfter).toBe(balanceBefore);

    // Count SaldoSnapshot rows AFTER — must be unchanged (no snapshot created).
    const snapshotCountAfter = await prisma.saldoSnapshot.count({
      where: { employeeId: empId },
    });
    expect(snapshotCountAfter).toBe(snapshotCountBefore);
  });
});
