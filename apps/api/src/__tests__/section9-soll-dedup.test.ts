/**
 * Phase 104 Plan 02 (D-15) — day-based Soll deduplication integration coverage.
 *
 * Pins the "a calendar day covered by two APPROVED leave/absence rows reduces
 * Soll exactly once" invariant inside closeEmployeeMonth() — the ONE shared
 * saldo core (RESEARCH.md "Tier 1 — the ONE shared saldo-affecting core") that
 * every one of the six saldo call sites (month-saldo.ts, overtime.ts,
 * auto-close-month.ts, recalculate-snapshots.ts, time-entries.ts×2) routes
 * through. Also pins OPEN-01's half-day-vs-full-day resolution and the
 * v1.8.27/v1.8.28 BS subtract-then-recredit symmetry, and confirms
 * non-overlapping figures stay byte-identical.
 *
 * Fixtures write overlapping APPROVED LeaveRequest/Absence rows DIRECTLY via
 * Prisma — the route-level overlap guard (leave.ts:220-229) that has silently
 * protected this Soll math from ever seeing an overlap is deliberately
 * bypassed here (Wave 0 of Phase 104; plan 104-05 opens that guard for real
 * traffic, at which point every § 9 BUrlG record makes the overlap the NORMAL
 * case). No test in this file goes through the leave-request creation route.
 *
 * All fixtures use August 2026 (no public holidays in the tested ranges, no
 * DST transition) so holidayDateStrings can stay an empty Set throughout.
 *
 * References: 104-02-PLAN.md, 104-RESEARCH.md "The D-15 Soll-Dedup Surface"
 * and "Pitfall 5", close-employee-month.ts (the four reduce blocks).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { monthRangeUtc, monthDayBounds } from "../contexts/working-time-account/timezone";
import type { CloseMonthInput } from "../contexts/working-time-account/close-employee-month";
import { closeEmployeeMonth } from "../contexts/working-time-account/close-employee-month";

const TZ = "Europe/Berlin";

// FIXED_SCHEDULE Mo-Fr 8h (weeklyHours=40) — no workDays field set, so the
// {day}Hours>0 fallback determines contracted workdays (Mo-Fr).
const FIXED_MO_FR_8H: Record<string, unknown> = {
  type: "FIXED_SCHEDULE",
  weeklyHours: 40,
  monthlyHours: null,
  sundayHours: 0,
  mondayHours: 8,
  tuesdayHours: 8,
  wednesdayHours: 8,
  thursdayHours: 8,
  fridayHours: 8,
  saturdayHours: 0,
};

// Same shape as FIXED_MO_FR_8H but SHIFT_BASED, so the Ø-Methode
// (avgWorkMinutesCore) produces byte-identical per-day credit (480 min).
const SHIFT_MO_FR_8H: Record<string, unknown> = { ...FIXED_MO_FR_8H, type: "SHIFT_BASED" };

// A.S.-style SHIFT_BASED schedule: weeklyHours=38, Di-Fr 9.5h, Mo/Sa/So 0h.
// Used for the BS-symmetry (Integration 4) and no-overlap (Integration 5)
// cases, which need a schedule where Monday is NOT a contracted workday.
const SHIFT_AS_TUE_FRI: Record<string, unknown> = {
  type: "SHIFT_BASED",
  weeklyHours: 38,
  monthlyHours: null,
  sundayHours: 0,
  mondayHours: 0,
  tuesdayHours: 9.5,
  wednesdayHours: 9.5,
  thursdayHours: 9.5,
  fridayHours: 9.5,
  saturdayHours: 0,
};

const { start: AUG_START, end: AUG_END } = monthRangeUtc(2026, 8, TZ);
const { firstDay: AUG_FIRST, lastDay: AUG_LAST } = monthDayBounds(AUG_START, AUG_END, TZ);
const EMPLOYEE_HIRE_DATE = new Date("2026-01-01T00:00:00Z");

describe("§9 BUrlG (D-15) — day-based Soll dedup in closeEmployeeMonth", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "s9dedup");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("section9-soll-dedup cleanup:", err);
    }
  });

  /** Creates a fresh employee (own user, no WorkSchedule row needed — the
   * schedule is passed directly into closeEmployeeMonth() below) under the
   * shared tenant. */
  async function createEmployee(): Promise<string> {
    const s = `s9-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `S9-${s}`,
        firstName: "Dedup",
        lastName: s,
        hireDate: EMPLOYEE_HIRE_DATE,
      },
    });
    return emp.id;
  }

  /** APPROVED LeaveRequest written directly via Prisma — bypasses leave.ts's
   * overlap guard (:220-229) entirely; no call to the API creation route. */
  async function createApprovedLeave(
    employeeId: string,
    startDateStr: string,
    endDateStr: string,
    opts?: { halfDay?: boolean },
  ) {
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(startDateStr + "T00:00:00Z"),
        endDate: new Date(endDateStr + "T00:00:00Z"),
        days: 1,
        halfDay: Boolean(opts?.halfDay),
        deletedAt: null,
      },
    });
  }

  async function createBsAbsence(employeeId: string, dateStr: string) {
    await app.prisma.absence.create({
      data: {
        employeeId,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: new Date(dateStr + "T00:00:00Z"),
        endDate: new Date(dateStr + "T00:00:00Z"),
        days: 1,
        createdBy: data.adminUser.id,
      },
    });
  }

  /** Builds a CloseMonthInput for August 2026 from the given schedule literal
   * plus this employee's real Prisma-fetched approvedLeave/absences rows. */
  async function buildAugustInput(
    employeeId: string,
    schedule: Record<string, unknown>,
  ): Promise<CloseMonthInput> {
    const approvedLeave = await app.prisma.leaveRequest.findMany({
      where: { employeeId, status: "APPROVED", deletedAt: null },
      select: { startDate: true, endDate: true, halfDay: true },
    });
    const absences = await app.prisma.absence.findMany({
      where: { employeeId, deletedAt: null },
      select: {
        startDate: true,
        endDate: true,
        type: true,
        source: true,
        halfDay: true,
        unterrichtsMinutes: true,
      },
    });
    return {
      employeeId,
      monthStart: AUG_START,
      monthEnd: AUG_END,
      monthFirstDay: AUG_FIRST,
      monthLastDay: AUG_LAST,
      tz: TZ,
      carryOverIn: 0,
      schedule,
      hireDate: EMPLOYEE_HIRE_DATE,
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: null,
      breakOver9hOverride: null,
      entries: [],
      shifts: [],
      approvedLeave: approvedLeave as CloseMonthInput["approvedLeave"],
      absences: absences as CloseMonthInput["absences"],
      holidayDateStrings: new Set<string>(),
      tenantConfig: null,
      employeeSlots: null,
      patternSlots: null,
      patternUnterrichtsMinutenByDow: null,
    };
  }

  it("Integration 1 (FIXED_SCHEDULE): overlapping VACATION Mo-Fr + SICK Mi-Do reduce Soll by 5 days, not 7", async () => {
    const empId = await createEmployee();
    await createApprovedLeave(empId, "2026-08-03", "2026-08-07"); // VACATION Mo-Fr
    await createApprovedLeave(empId, "2026-08-05", "2026-08-06"); // SICK Mi-Do (overlap)

    const input = await buildAugustInput(empId, FIXED_MO_FR_8H);
    const result = closeEmployeeMonth(input);

    // RED before 104-02 Task 2: today this returns 6720 (contractSoll 10080 minus
    // the doubled 7×480=3360, since Mi/Do are deducted by BOTH requests) because
    // the Soll is summed per REQUEST, not per DAY. Expected 7680 (contractSoll
    // 10080 minus the correct 5×480=2400 — Mo,Di,Mi,Do,Fr counted exactly once).
    expect(result.expectedMinutes).toBe(7680);
  });

  it("Integration 2 (SHIFT_BASED): same overlap shape — sbLeaveCredit counts Wed/Thu once", async () => {
    const empId = await createEmployee();
    await createApprovedLeave(empId, "2026-08-03", "2026-08-07");
    await createApprovedLeave(empId, "2026-08-05", "2026-08-06");

    const input = await buildAugustInput(empId, SHIFT_MO_FR_8H);
    const result = closeEmployeeMonth(input);

    // RED before 104-02 Task 2: today this returns 6720 (C_net = contractSoll
    // 10080 minus the doubled sbLeaveCredit 3360) via avgWorkMinutesCore. Expected
    // 7680 (contractSoll 10080 minus the correct sbLeaveCredit 2400 — the § 615
    // clause is unaffected, this is purely the C_net input to it).
    expect(result.expectedMinutes).toBe(7680);
  });

  it("Integration 3 (half-day, OPEN-01): half-day VACATION overlapped by full-day SICK reduces the FULL day", async () => {
    const empId = await createEmployee();
    await createApprovedLeave(empId, "2026-08-05", "2026-08-05", { halfDay: true }); // VACATION Mi half-day
    await createApprovedLeave(empId, "2026-08-05", "2026-08-06"); // SICK Mi-Do full-day

    const input = await buildAugustInput(empId, FIXED_MO_FR_8H);
    const result = closeEmployeeMonth(input);

    // RED before 104-02 Task 2: today this returns 8880 (contractSoll 10080 minus
    // 240 [half-day Mi] + 960 [full-day Mi-Do] = 1200) — Mittwoch is only
    // half-credited even though the employee was sick all day. Expected 9120
    // (contractSoll 10080 minus 960 — Mi AND Do both count as a FULL day; a
    // person sick all day did not work half a day. D-15's processing-order rule
    // — full-day rows claim before half-day rows — is what makes this the FULL
    // day and not the half-day that survives the dedup.)
    expect(result.expectedMinutes).toBe(9120);
  });

  it("Integration 4 (BS symmetry, v1.8.27/v1.8.28, superseded by Issue #448 D-03): a BS PATTERN absence overlapping a SICK request now wins (no double reduction)", async () => {
    const empId = await createEmployee();
    await createApprovedLeave(empId, "2026-08-04", "2026-08-04"); // SICK Di, same day as BS
    await createBsAbsence(empId, "2026-08-04"); // VOCATIONAL_SCHOOL / PATTERN, same day

    const input = await buildAugustInput(empId, SHIFT_AS_TUE_FRI);
    const result = closeEmployeeMonth(input);

    // measured against HEAD d672fecd on 2026-08-24 (unmodified close-employee-
    // month.ts, before any 104-02 Task 2 change): expectedMinutes=8550,
    // workedMinutes=570, balanceMinutes=0. The isBsAbsence() carve-out (D-15)
    // means the BS row neither claims a day nor is excluded by the SICK
    // request's claimed day, so this figure stayed byte-identical through
    // Task 2 and through Issue #429 below.
    //
    // Issue #429, plan 429-02 (justified, intended effect — NOT a regression):
    // SHIFT_AS_TUE_FRI sets neither `workDays` nor `contractWorkDaysPerWeek`, and this
    // fixture's `tenantConfig` is `null` (no `defaultWorkDays` either), so
    // `contractWorkDaysPerWeekFrom()`'s chain bottoms out at its final default of 5.
    // Before #429, the SHIFT_BASED approvedLeave (SICK) row's credit came from
    // `avgWorkMinutesCore`'s OWN fallback — count of `{day}Hours > 0` = 4 (Tue-Fri) — giving
    // round(38*60*1/4) = 570 for the one-day SICK row. #429 replaces that leave credit with
    // `shiftBasedLeaveCreditByDate()`, which resolves the divisor via the SAME chain
    // Abwesenheiten's entitlement side already used (Phase 107 D-04) — here landing on 5, not
    // 4 — giving round(38*60*1/5) = 456: 114 minutes less subtracted, so expectedMinutes rose
    // by exactly 114 (8550 -> 8664). The BS absence loop (sbAbsenceCredit, untouched by that
    // plan) still used `avgWorkMinutesCore`'s divisor of 4, so `workedMinutes`/`balanceMinutes`
    // were unaffected — a pure Soll-side (`expectedMinutes`) shift, unifying the leave-credit
    // divisor with entitlement instead of leaving them silently diverged.
    //
    // Issue #448 (D-03, owner decision 01.10.2026; Phase 448 plan 01, commit 2fdaf288)
    // superseded the "unaffected by dedup" premise this test's ORIGINAL name asserted: D-03
    // requires "a day reduces Soll exactly once" for ANY approved-leave type overlapping a
    // Berufsschultag, not only VACATION — close-employee-month.ts's SHIFT_BASED
    // `approvedLeave` credit loop (the SAME loop this SICK row goes through) now skips any
    // date present in `bsDatesInMonth` (see that loop's own Issue #448 D-03 comment block).
    // The 456-minute SICK leave credit computed above is therefore no longer subtracted from
    // Soll for 2026-08-04 — only the BS absence credit still reduces it — so expectedMinutes
    // rises by exactly that 456 (8664 -> 9120). `workedMinutes`/`balanceMinutes` are untouched
    // (the leave-credit loop never touches worked minutes), confirming this is again a pure
    // Soll-side shift, now unifying the BS-vs-leave precedence rule instead of the divisor.
    expect(result.expectedMinutes).toBe(9120);
    expect(result.workedMinutes).toBe(570);
    expect(result.balanceMinutes).toBe(0);
  });

  it("Integration 5 (no-overlap parity): three non-overlapping ranges are byte-identical to HEAD", async () => {
    const empId = await createEmployee();
    await createApprovedLeave(empId, "2026-08-03", "2026-08-03"); // Mon — not a workday for this schedule
    await createApprovedLeave(empId, "2026-08-11", "2026-08-11"); // Tue
    await app.prisma.absence.create({
      data: {
        employeeId: empId,
        type: "SICK",
        source: "MANUAL",
        startDate: new Date("2026-08-18T00:00:00Z"),
        endDate: new Date("2026-08-18T00:00:00Z"),
        days: 1,
        createdBy: data.adminUser.id,
      },
    });

    const input = await buildAugustInput(empId, SHIFT_AS_TUE_FRI);
    const result = closeEmployeeMonth(input);

    // measured against HEAD d672fecd on 2026-08-24: expectedMinutes=7980,
    // workedMinutes=0, balanceMinutes=0. No two rows share a day, so dedup is a
    // structural no-op — this must stay byte-identical after Task 2, pinning
    // that a refactor of the non-overlap path did not change anything.
    //
    // Issue #429, plan 429-02 (justified, intended effect — NOT a regression):
    // this fixture is the exact bug class #429 fixes, hit incidentally by an unrelated
    // pre-existing test. The Mon 2026-08-03 VACATION row falls on a day SHIFT_AS_TUE_FRI gives
    // 0 `{day}Hours` (Monday is not one of its Tue-Fri contract days). Before #429, the leave
    // credit came from `avgWorkMinutesCore`, whose `workdaysInRange` counts ONLY
    // `{day}Hours > 0` days — Monday contributes 0 workdays in range, so this row credited
    // exactly 0 regardless of divisor (the reported "credits zero for a day outside the
    // schedule's per-day hours" bug). #429's `shiftBasedLeaveCreditByDate()` no longer asks
    // "is this a contracted {day}Hours day" — it asks `leaveDaysPerWeek()` "how many of this
    // ISO week's Mo-Sat leave days does the CONTRACT (contractWorkDaysPerWeekFrom, here 5 —
    // same fallback-chain gap as Integration 4 above) cost", so the lone Monday fragment now
    // correctly costs 1 day = round(38*60*1/5) = 456 minutes where it cost 0 before. The
    // Tue 2026-08-11 VACATION row's own credit ALSO moves, from the old
    // avgWorkMinutesCore-divisor-4 570 to the new contract-divisor-5 456 (same fallback-chain
    // shift as Integration 4). Combined leave-credit delta: (456-0) + (456-570) = +342 minutes
    // subtracted from Soll, so expectedMinutes falls by exactly 342 (7980 -> 7638). The
    // separate SICK ABSENCE row (08-18, sbAbsenceCredit loop, untouched by this plan) is
    // unaffected, so workedMinutes/balanceMinutes stay 0.
    expect(result.expectedMinutes).toBe(7638);
    expect(result.workedMinutes).toBe(0);
    expect(result.balanceMinutes).toBe(0);
  });
});
