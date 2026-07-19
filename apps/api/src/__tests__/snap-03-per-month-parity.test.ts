/**
 * SNAP-03: Per-month parity + prod-repro (+64h / +phantom-saldo bug).
 *
 * Wave 0 — RED-first scaffold. These tests MUST FAIL against current code.
 * They turn GREEN after the SNAP-03 per-month iteration refactor (plan 76.27-02).
 *
 * Describe A — "prod-repro (+phantom saldo)":
 *   SHIFT_BASED employee, May 2026 snapshot closed (carryOver=0). June 2026 is
 *   a complete open month where W > C_net with R=0 (employer never rostered →
 *   §615: max(0,W−C)−max(0,0−W) = W−C−0 = +2000). July 2026 (partial, today=Jul 19)
 *   has R=4800, W=2400, C=6000: §615 per-month = 0 − 2400 = −2400.
 *   Per-month total: +2000 − 2400 = −400 min (−6.7h) — neutral/negative.
 *   Lumped (current buggy code): W=10400, C=12000, R=4800 → max(0,10400−12000)−
 *   max(0,4800−10400) = 0 − 0 = 0. Artifact = +400 min (+6.7h).
 *   Larger prod scenarios amplify this to the observed +64h.
 *
 *   Assertion (RED against current code — lumped block at time-entries.ts:1884):
 *     liveBalanceMinutes <= 0     (neutral/negative)
 *     liveBalanceMinutes NOT > 120  (NOT the +400 or larger phantom artifact)
 *
 * Describe B — "parity-by-construction":
 *   Three sub-cases (SHIFT_BASED, FIXED, MONTHLY_HOURS). For each, build an open
 *   range fixture, then compute the reference total by calling closeEmployeeMonth()
 *   once per COMPLETE open month (threading effectiveCarryOverOut), plus an estimate
 *   for the current partial month. Assert live GET /overtime balance equals the
 *   reference sum within <5 min tolerance.
 *
 *   SHIFT_BASED sub-case is also RED because the lumped block diverges from the
 *   per-month sum. FIXED and MONTHLY_HOURS sub-cases may be CLOSER to parity today
 *   (MONTHLY_HOURS already iterates per-month; FIXED uses a single call) but the
 *   assertions capture the desired behaviour post-refactor.
 *
 * No PII — synthetic fixtures only (createFixtureTenant + unique slugs).
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Seed a TimeEntry with zero break (brutto = netto). */
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

/** Seed a Shift record (brutto = netMinutes because breakOver6h/9h override = 0). */
async function seedShift(
  app: FastifyInstance,
  empId: string,
  dateStr: string,
  netMinutes: number,
): Promise<void> {
  const totalH = Math.floor(netMinutes / 60);
  const totalM = netMinutes % 60;
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

/** Run updateOvertimeAccount at a frozen "now" and return balanceHours × 60 (minutes). */
async function liveBalanceMinutesAt(
  app: FastifyInstance,
  empId: string,
  isoNow: string,
): Promise<number> {
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

/**
 * Create an isolated test tenant with one employee of the given schedule type.
 * breakOver6hOverride=0 / breakOver9hOverride=0 so brutto == netto throughout.
 */
async function createIsolatedTenant(
  app: FastifyInstance,
  slug: string,
  scheduleData: Record<string, unknown>,
  hireDate: Date,
): Promise<{ tenantId: string; empId: string; adminToken: string }> {
  const s = `snap03-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`;
  const prisma = app.prisma;

  const tenant = await prisma.tenant.create({
    data: { name: `Snap03 ${slug}`, slug: s, federalState: "NIEDERSACHSEN" },
  });
  await prisma.tenantConfig.create({
    data: { tenantId: tenant.id, defaultVacationDays: 30, timezone: TZ },
  });

  const adminUser = await prisma.user.create({
    data: {
      email: `admin-${s}@snap03.test`,
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
      lastName: "S3",
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
      email: `emp-${s}@snap03.test`,
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
      validFrom: new Date("2026-01-01T00:00:00Z"),
      ...scheduleData,
    } as never,
  });
  await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

  const loginRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: `admin-${s}@snap03.test`, password: "test1234" },
  });
  const { accessToken: adminToken } = JSON.parse(loginRes.body);

  return { tenantId: tenant.id, empId: emp.id, adminToken };
}

/** Seed a MONTHLY SaldoSnapshot for a given month. */
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
      closedBy: "snap03-test-seed",
    },
  });
}

// Build holiday set for a given year (NI state)
function buildHolidaySet(year: number): Set<string> {
  return new Set<string>(getHolidays(year, STATE_MAP["NIEDERSACHSEN"] ?? "NI").map((h) => h.date));
}

// All Mon–Fri dates in [fromStr, toStr] as "YYYY-MM-DD"
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

// ── Describe A: prod-repro (+phantom saldo) ───────────────────────────────────
//
// Fixture arithmetic (§615 non-linearity — R-clause saturation produces phantom):
//
//   The phantom requires W_total > R_total so max(0,R-W) is CLIPPED to 0 in the lump,
//   while per-month Month 1 has W_1=0 << R_1, making max(0,R_1-W_1)=R_1 POSITIVE (a deduction).
//   This deduction is "hidden" when lumped with Month 2's high W.
//
//   April 2026 snapshot closed (carryOver=0). rangeStart = May 1. currentMonth = July.
//   May (prior, complete): NO leave, NO entries (W=0). Roster: 20 shifts × 200 min = R=4000.
//     C_net_may = calcExpectedMinutesTz(38h/week Mon–Fri, May1..May31) ≈ 9120 min.
//     Per-month §615: max(0,0−9120) − max(0,4000−0) = 0 − 4000 = −4000 min.
//   June (prior, complete): NO leave, NO roster (R=0). Entries: 20 × 600 min = W=12000.
//     C_net_june = calcExpectedMinutesTz(38h/week, Jun1..Jun30) ≈ 9120 min.
//     Per-month §615: max(0,12000−9120) − max(0,0−12000) = +2880 − 0 = +2880 min.
//   Per-month priors sum: −4000 + 2880 = −1120 min.
//
//   Lumped [May+June] (current buggy code — time-entries.ts:1884):
//     W_lumped=12000, C_lumped=18240, R_lumped=4000.
//     max(0,12000−18240) − max(0,4000−12000) = 0 − 0 = 0 min.
//     The R-minus clause max(0,4000−12000) = 0 because W_lumped > R_lumped.
//     Per-month had max(0,4000−0) = 4000 in May (W_may=0). In the lump, W_total hides this.
//   Phantom artifact: 0 − (−1120) = +1120 min (lumped is MORE positive than per-month).
//   With carryOver=0 and July partial ≈ 0, live (lumped) ≈ 0 but reference ≈ −1120.
//   Parity assertion |live − reference| < 5 FAILS: |0 − (−1120)| = 1120 >> 5.
//
//   This test FAILS on current code (lumped block at time-entries.ts:1884).
//   It goes GREEN after the SNAP-03 per-month iteration refactor (plan 76.27-02).
// ─────────────────────────────────────────────────────────────────────────────
//
//   May 2026 snapshot: carryOver = 0, closed.
//   June 2026 (complete open month, no snapshot):
//     Employer rostered 16 shifts (R = 8000 min total).
//     Employee was on unpaid leave for all of June — NO entries (W = 0).
//     C_net = 0 (entire month is leave-credited, leave reduces Soll to 0).
//     Per-month §615: max(0,0−0) − max(0,8000−0) = 0 − 8000 = −8000 min.
//   July 2026 (partial, "today" = 2026-07-19):
//     Employer rostered 5 shifts, R = 2000 min.
//     Employee worked 10 entries, W = 12000 min (heavy overtime).
//     C_net for July Soll = 4000 min.
//     Per-month §615: max(0,12000−4000) − max(0,2000−12000) = 8000 − 0 = +8000 min.
//
//   ✓ Per-month total (carryOver=0 + June + July): 0 + (−8000) + 8000 = 0 min → neutral.
//
//   ✗ Lumped (current buggy code time-entries.ts:1884–1894):
//     The prior block lumps June: W_june=0, C_june=0, R_june=8000.
//     priorSaldo = max(0,0−0) − max(0,8000−0) = −8000 min (correct for June alone!).
//     Then July current-month: W=12000, C_july=4000, R=2000.
//     curBalance = max(0,12000−4000) − max(0,2000−12000) = +8000 min.
//     The bug is NOT in the two-month lump here — it's in how the prior block accumulates.
//     However: for schedules where C_net is 0 in June and large in July, the lumping of
//     C_net across months can cause max(0,W−C_lumped) to saturate differently.
//     THE KEY VARIANT: June has R=8000, W=0, C_net=8000 (not 0 — no leave this time).
//     July: W=12000, C=4000, R=1000.
//     Per-month: June: max(0,0−8000)−max(0,8000−0) = 0−8000 = −8000.
//               July: max(0,12000−4000)−max(0,1000−12000) = +8000 − 0 = +8000.
//               Total: 0.
//     Lumped (June→July via prior block): W_prior=0, C_prior=8000, R_prior=8000.
//               priorSaldo = max(0,0−8000)−max(0,8000−0) = 0 − 8000 = −8000 (same!).
//     The real phantom scenario: June has W=0, C=0 (full leave credit), R large.
//     §615: max(0,0−0) − max(0,R−0) = −R. Lumped with July → same math.
//     THE CORRECT PHANTOM: Needs C_net to be DIFFERENT per month such that max(0,W−C) clips.
//
//     FINAL FIXTURE (reproduces phantom):
//       June: W=0, C=0 (all leave), R=8000 → per-month §615: 0 − 8000 = −8000.
//       July: W=12000, C=4000, R=2000 → per-month §615: +8000 − 0 = +8000.
//       Per-month total: 0.
//       Lumped C_prior=0, R_prior=8000, W_prior=0:
//         priorSaldo = max(0,0−0) − max(0,8000−0) = −8000 (same as per-month!).
//       Since these are separate steps in the current code (prior block then current month),
//       the prior block for June alone always equals per-month for June (no lump with July).
//
//     The ACTUAL lumping that produces phantom: when rangeStart < currentMonthStart but
//     the prior block covers MULTIPLE prior months (not just one). Example:
//       April (prior): W=0, C=5000, R=0 → per-month: 0 − 0 = 0.
//       May (prior): W=0, C=5000, R=0 → per-month: 0 − 0 = 0.
//       June (prior): W=9000, C=3000, R=9000 → per-month: +6000 − 0 = +6000.
//       Per-month total for priors: 0 + 0 + +6000 = +6000.
//       Lumped Apr+May+Jun: W=9000, C=13000, R=9000.
//         max(0,9000−13000) − max(0,9000−9000) = 0 − 0 = 0.
//       Artifact = +6000 − 0 = +6000 (lumped is LESS positive). But current code computes
//       prior block over [rangeStart, currentMonthStart-1], which is the entire multi-month
//       prior range. The artifact goes POSITIVE when one month has high W that saturates
//       the max(0,W−C) clause in the lump but not per-month.
//
//     ACTUAL +PHANTOM fixture:
//       June (prior complete, W=high, C=low): W=9000, C=3000, R=9000.
//         per-month: max(0,9000−3000) − max(0,9000−9000) = +6000 − 0 = +6000.
//       July (current partial, low work): W=1000, C=9000, R=5000.
//         per-month: 0 − 4000 = −4000.
//       Per-month total: +6000 − 4000 = +2000.
//       Lumped PRIOR (June only, rangeStart=Jun1):
//         W_prior=9000, C_prior=3000, R_prior=9000.
//         priorSaldo = +6000 (correct). Then July: −4000. Total = +2000 (SAME).
//       Wait — the bug only appears when MULTIPLE prior open months are lumped.
//       rangeStart = Jun 1 means only June is in the prior block. For TWO prior months:
//       rangeStart = May 1 (May and June both prior, no May snapshot either).
//
//     TWO-PRIOR-MONTH +phantom fixture:
//       Last snapshot: April 2026, carryOver=0.
//       May (prior, open): W=9000, C=3000, R=9000 → per-month: +6000 − 0 = +6000.
//       June (prior, open): W=1000, C=9000, R=5000 → per-month: 0 − 4000 = −4000.
//       July (current partial): W=1000, C=9000, R=5000 → per-month: 0 − 4000 = −4000.
//       Per-month total: +6000 − 4000 − 4000 = −2000 (negative).
//       Lumped prior [May+June]: W=10000, C=12000, R=14000.
//         max(0,10000−12000) − max(0,14000−10000) = 0 − 4000 = −4000.
//       Prior artifact = −2000 (per-month May+June) vs −4000 (lumped) → lumped is MORE NEGATIVE!
//       The lumped makes the total MORE negative: −4000 − 4000 = −8000 (worse than −2000).
//
//     CORRECT phantom (lumped MORE POSITIVE):
//       Need: lumped gives a HIGHER (more positive) value than per-month.
//       max(0, W_total − C_total) > sum[max(0, W_i − C_i)]  — possible when:
//       W_total − C_total > 0  AND  some W_i − C_i < 0  (individual months cancel but total is positive)
//       Example: May: W=1000, C=5000 (W<C, per-month max(0,...)=0). June: W=9000, C=3000 (W>C, +6000).
//       Per-month R clause: May R=0 (§615 no roster), June R=9000.
//         May: max(0,1000−5000)−max(0,0−1000) = 0 − 0 = 0.
//         June: max(0,9000−3000)−max(0,9000−9000) = +6000 − 0 = +6000.
//         Per-month priors total: 0 + 6000 = +6000.
//       Lumped [May+June]: W=10000, C=8000, R=9000.
//         max(0,10000−8000)−max(0,9000−10000) = +2000 − 0 = +2000.
//       Lumped (+2000) < per-month (+6000) → lumped MORE NEGATIVE here, opposite.
//
//     The key insight from the RESEARCH doc (§1.4):
//     "max(0,W1+W2−C1−C2) ≠ max(0,W1−C1) + max(0,W2−C2)"
//     And specifically: lumped CAN be more positive when the R clause is clipped:
//       Month 1: W=0, C=1, R=100 → per-month: 0 − 100 = −100.
//       Month 2: W=200, C=1, R=100 → per-month: +199 − 0 = +199.
//       Per-month sum: −100 + 199 = +99.
//       Lumped: W=200, C=2, R=200 → max(0,200−2)−max(0,200−200) = 198 − 0 = +198.
//       Lumped (+198) > per-month (+99). ARTIFACT: +99 phantom.
//     ✓ THIS is the correct direction. The R clause max(0,R−W) is clipped to 0 in the lump
//       because W_total (200) >= R_total (200), even though month 1 had W=0 << R=100.
//
// FINAL FIXTURE (uses the confirmed phantom direction):
//   April 2026 snapshot closed (carryOver=0). May + June are BOTH open (2 prior months).
//   May (prior, open): W=0 (no entries), C=500 min, R=4800 min.
//     per-month §615: max(0,0−500) − max(0,4800−0) = 0 − 4800 = −4800 min.
//   June (prior, open): W=9600 min (heavy work), C=500 min (all leave), R=4800 min.
//     per-month §615: max(0,9600−500) − max(0,4800−9600) = +9100 − 0 = +9100 min.
//   Per-month priors sum: −4800 + 9100 = +4300 min.
//   Lumped [May+June]: W=9600, C=1000, R=9600.
//     max(0,9600−1000) − max(0,9600−9600) = +8600 − 0 = +8600 min.
//   Lumped (+8600) > per-month (+4300). Artifact = +4300 phantom minutes!
//   With carryOver=0 and July current-month near-neutral, live saldo under lumped code
//   will be ~+8600 min from priors alone — the positive phantom is confirmed.
//   Post-fix assertion: live saldo ≈ +4300 + July partial (small) — still large positive.
//   BUT we only assert: live must NOT be the even-larger lumped artifact.
//   Specifically: we assert live < per-month result (which is already large positive here).
//
//   BETTER: Use fixture where per-month sum = 0 / neutral but lumped = large positive.
//   From above: W_1=0, C_1=1, R_1=100; W_2=200, C_2=1, R_2=100 → lumped=+198, per-month=+99.
//   Scaled × 60: W_1=0, C_1=60, R_1=6000; W_2=12000, C_2=60, R_2=6000.
//   Per-month: (0 − 6000) + (12000-60 − 0) = −6000 + 11940 = +5940 min.
//   Lumped: W=12000, C=120, R=12000 → max(0,12000−120)−max(0,12000−12000) = +11880 − 0 = +11880.
//   Lumped (+11880) >> per-month (+5940). Artifact = +5940. Both positive, just lumped is more.
//   Assertion: live (lumped) NOT close to per-month; specifically |live − ref| > 1000 min.
//
//   For the test to be cleanly RED: assert live (lumped) is MUCH LARGER than the expected value.
//   Expected (per-month): ~+5940 min = ~+99h. Lumped: ~+11880 min = ~+198h. Diff = ~99h.
//   Post-fix: live should be ~+5940 min. The failing assertion is:
//     expect(|live - per_month_reference|).toBeLessThan(5) → RED because |11880 - 5940| = 5940.
//
//   Note: both are positive, but the test asserts PARITY (live == per_month_reference within 5 min).
//   This is cleaner than asserting sign direction only.
// ─────────────────────────────────────────────────────────────────────────────

describe("SNAP-03-A — prod-repro: SHIFT_BASED Apr-snapshot + open May+June → lumped §615 produces phantom +saldo (MUST BE RED)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;

  // "today" = July 1 2026 (after June ends, so June is a "complete prior" month relative to July).
  // currentMonthStart = July 1, prior block covers [May1, June30].
  const LIVE_NOW = "2026-07-01T10:00:00.000Z";

  // May 2026 Mon–Fri dates (21 workdays)
  const MAY_WORKDAYS = monFriDates("2026-05-01", "2026-05-31");
  // June 2026 Mon–Fri dates (21 workdays)
  const JUNE_WORKDAYS = monFriDates("2026-06-01", "2026-06-30");

  // Reference per-month sum (computed inline in beforeAll, using closeEmployeeMonth).
  // This is the CORRECT answer that SNAP-03 per-month iteration should produce.
  let referencePerMonthSum = 0;

  beforeAll(async () => {
    app = await getTestApp();

    const fixture = await createIsolatedTenant(
      app,
      "a-prod-repro",
      {
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
      },
      new Date("2026-01-01T00:00:00Z"),
    );
    tenantId = fixture.tenantId;
    empId = fixture.empId;

    // April 2026 snapshot closed, carryOver=0. rangeStart = May 1.
    await seedMonthlySnapshot(app, empId, 2026, 4, 0, 0, 0, 0);

    // May 2026 (complete open, NO snapshot, NO leave, NO entries):
    //   R_may = 20 shifts × 200 min = 4000 min (active roster, coveredDates empty).
    //   W_may = 0 (no entries). C_net_may ≈ 9120 min (38h/week × 20 Mon–Fri days).
    //   Per-month §615: max(0,0−9120) − max(0,4000−0) = 0 − 4000 = −4000 min.
    for (const d of MAY_WORKDAYS) {
      await seedShift(app, empId, d, 200); // 20 × 200 = 4000 min roster
    }
    // NO entries for May → W_may = 0.

    // June 2026 (complete open, NO snapshot, NO shifts, entries only):
    //   R_june = 0 (no roster — employer never scheduled shifts in June).
    //   W_june = 20 entries × 600 min = 12000 min. C_net_june ≈ 9120 min.
    //   Per-month §615: max(0,12000−9120) − max(0,0−12000) = +2880 − 0 = +2880 min.
    for (const d of JUNE_WORKDAYS) {
      await seedEntry(app, empId, d, 600); // 20 × 600 = 12000 min worked
    }
    // NO shifts for June → R_june = 0.

    // July 2026 (current partial at LIVE_NOW = Jul 1): empty → 0 contribution.

    // Pre-compute reference using closeEmployeeMonth() (per-month ground truth):
    const schedule = await app.prisma.workSchedule.findFirst({ where: { employeeId: empId } });
    const emp = await app.prisma.employee.findUnique({ where: { id: empId } });
    const holidays2026 = buildHolidaySet(2026);

    // May reference
    const { start: mayStart, end: mayEnd } = monthRangeUtc(2026, 5, TZ);
    const { firstDay: mayFirstDay, lastDay: mayLastDay } = monthDayBounds(mayStart, mayEnd, TZ);
    const mayShifts = await app.prisma.shift.findMany({
      where: { employeeId: empId, deletedAt: null, date: { gte: mayFirstDay, lte: mayLastDay } },
      select: { date: true, startTime: true, endTime: true },
    });
    const mayResult = closeEmployeeMonth({
      employeeId: empId,
      monthStart: mayStart,
      monthEnd: mayEnd,
      monthFirstDay: mayFirstDay,
      monthLastDay: mayLastDay,
      tz: TZ,
      carryOverIn: 0,
      schedule: schedule as Record<string, unknown>,
      hireDate: emp!.hireDate,
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
      entries: [], // W_may = 0
      shifts: mayShifts,
      approvedLeave: [],
      absences: [],
      holidayDateStrings: holidays2026,
      tenantConfig: { defaultBreakOver6h: 0, defaultBreakOver9h: 0 },
    });

    // June reference (threads effectiveCarryOverOut from May)
    const { start: juneStart, end: juneEnd } = monthRangeUtc(2026, 6, TZ);
    const { firstDay: juneFirstDay, lastDay: juneLastDay } = monthDayBounds(juneStart, juneEnd, TZ);
    const juneEntries = await app.prisma.timeEntry.findMany({
      where: { employeeId: empId, deletedAt: null, date: { gte: juneFirstDay, lte: juneLastDay } },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });
    const juneResult = closeEmployeeMonth({
      employeeId: empId,
      monthStart: juneStart,
      monthEnd: juneEnd,
      monthFirstDay: juneFirstDay,
      monthLastDay: juneLastDay,
      tz: TZ,
      carryOverIn: mayResult.effectiveCarryOverOut, // thread: effectiveCarryOverOut from May (§2.3)
      schedule: schedule as Record<string, unknown>,
      hireDate: emp!.hireDate,
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
      entries: juneEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes ?? 0,
      })),
      shifts: [], // R_june = 0
      approvedLeave: [],
      absences: [],
      holidayDateStrings: holidays2026,
      tenantConfig: { defaultBreakOver6h: 0, defaultBreakOver9h: 0 },
    });

    // Reference total: carryOver(0) + May.balance + June.balance + July partial(0)
    // Per-month arithmetic: 0 + (−4000) + 2880 + 0 = −1120 min (≈ −18.7h)
    referencePerMonthSum = 0 + mayResult.balanceMinutes + juneResult.balanceMinutes;
    // Note: mayResult.balanceMinutes ≈ −4000 (§615 R-minus clause), juneResult ≈ +2880.
    // referencePerMonthSum ≈ −1120.
    //
    // Current lumped code (time-entries.ts:1884):
    //   W_lumped=12000, C_lumped=18240, R_lumped=4000 (but coveredDates empty so May shifts count).
    //   max(0,12000−18240) − max(0,4000−12000) = 0 − 0 = 0 min.
    //   Phantom = 0 − (−1120) = +1120 min (lumped is MORE POSITIVE than per-month).
    //   |live(0) − reference(−1120)| = 1120 >> 5 → RED assertion below.
  }, 300_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("SNAP-03-A cleanup:", err);
    }
    vi.useRealTimers();
  });

  it(// This test FAILS on current code: the lumped prior block (time-entries.ts:1884) computes
  // §615 over [May1, June30] as a single call. W_total=12000 > R_total=4000, so
  // max(0,4000−12000)=0 — the R-minus clause is suppressed, hiding the May underwork penalty.
  // Per-month: May alone has W_may=0 << R_may=4000, giving a −4000 deduction.
  // Phantom: lumped result ≈ 0, per-month reference ≈ −1120. |0 − (−1120)| = 1120 >> 5.
  // Goes GREEN after SNAP-03 per-month iteration refactor (plan 76.27-02).
  "live saldo == per-month reference within 5 min — NOT the lumped phantom (RED: |live − ref| ≈ 1120 min on current code)", async () => {
    const liveMin = await liveBalanceMinutesAt(app, empId, LIVE_NOW);

    // Post-SNAP-03: per-month iteration makes live == sum of sequential closeEmployeeMonth calls.
    // Current code (lumped block) produces a phantom: |live − reference| ≈ 1120 min.
    expect(
      Math.abs(liveMin - referencePerMonthSum),
      `prod-repro parity: |live(${liveMin}min) − reference(${referencePerMonthSum}min)| must be < 5 min after SNAP-03 (current lumped phantom ≈ +1120 min)`,
    ).toBeLessThan(5);

    // Fixture sanity: the per-month reference MUST be neutral/negative (never a large positive).
    // referencePerMonthSum ≈ −1120 min. If this fails, the fixture is wrong (not producing the bug).
    expect(referencePerMonthSum).toBeLessThanOrEqual(0);
    // After SNAP-03: live == reference ≈ −1120. Current code (lumped): live ≈ 0.
    // The parity assertion above is the primary RED signal; this clarifies the direction.
    expect(liveMin).not.toBeGreaterThan(referencePerMonthSum + 5); // live must not EXCEED reference by >5
  }, 120_000);
});

// ── Describe B.1: parity-by-construction (SHIFT_BASED) ───────────────────────

describe("SNAP-03-B1 — parity-by-construction: SHIFT_BASED live==Σcloses (<5min tolerance)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;

  const LIVE_NOW = "2026-07-19T10:00:00.000Z";
  const JUNE_WORKDAYS = monFriDates("2026-06-01", "2026-06-30");
  const JULY_PARTIAL_WORKDAYS = monFriDates("2026-07-01", "2026-07-18");
  const JULY_ALL_SHIFTS = monFriDates("2026-07-01", "2026-07-31");

  let referenceCarryOver = 0; // threads from May snapshot
  let juneSumMinutes = 0;

  beforeAll(async () => {
    app = await getTestApp();

    const fixture = await createIsolatedTenant(
      app,
      "b1-shift-parity",
      {
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
      },
      new Date("2026-01-01T00:00:00Z"),
    );
    tenantId = fixture.tenantId;
    empId = fixture.empId;

    // May 2026 snapshot: carryOver = 1200 min (non-zero to test threading)
    await seedMonthlySnapshot(app, empId, 2026, 5, 1200, 5000, 5000, 0);
    referenceCarryOver = 1200;

    // June: 15 shifts × 456 min, 15 entries × 456 min (balanced, balance=0 expected)
    for (const d of JUNE_WORKDAYS.slice(0, 15)) {
      await seedShift(app, empId, d, 456);
      await seedEntry(app, empId, d, 456);
    }

    // July: 12 shifts × 456 min, 10 entries × 456 min
    for (const d of JULY_ALL_SHIFTS.slice(0, 12)) {
      await seedShift(app, empId, d, 456);
    }
    for (const d of JULY_PARTIAL_WORKDAYS.slice(0, 10)) {
      await seedEntry(app, empId, d, 456);
    }

    // Compute reference sum via closeEmployeeMonth() for June (complete open month)
    const { start: juneStart, end: juneEnd } = monthRangeUtc(2026, 6, TZ);
    const { firstDay: juneFirstDay, lastDay: juneLastDay } = monthDayBounds(juneStart, juneEnd, TZ);

    const juneEntries = await app.prisma.timeEntry.findMany({
      where: {
        employeeId: empId,
        deletedAt: null,
        date: { gte: juneFirstDay, lte: juneLastDay },
      },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });
    const juneShifts = await app.prisma.shift.findMany({
      where: {
        employeeId: empId,
        deletedAt: null,
        date: { gte: juneFirstDay, lte: juneLastDay },
      },
      select: { date: true, startTime: true, endTime: true },
    });
    const schedule = await app.prisma.workSchedule.findFirst({
      where: { employeeId: empId },
    });
    const emp = await app.prisma.employee.findUnique({ where: { id: empId } });

    const junHolidays = buildHolidaySet(2026);

    const juneResult = closeEmployeeMonth({
      employeeId: empId,
      monthStart: juneStart,
      monthEnd: juneEnd,
      monthFirstDay: juneFirstDay,
      monthLastDay: juneLastDay,
      tz: TZ,
      carryOverIn: referenceCarryOver, // threads from May snapshot
      schedule: schedule as Record<string, unknown>,
      hireDate: emp!.hireDate,
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
      entries: juneEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes ?? 0,
      })),
      shifts: juneShifts,
      approvedLeave: [],
      absences: [],
      holidayDateStrings: junHolidays,
      tenantConfig: { defaultBreakOver6h: 0, defaultBreakOver9h: 0 },
    });

    // effectiveCarryOverOut from June feeds July (threading per §2.3 RESEARCH.md)
    juneSumMinutes = juneResult.balanceMinutes;
    referenceCarryOver = juneResult.effectiveCarryOverOut;
  }, 300_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("SNAP-03-B1 cleanup:", err);
    }
    vi.useRealTimers();
  });

  it(// This test is RED for SHIFT_BASED because the lumped prior block at :1884 diverges
  // from closeEmployeeMonth() for complete open months. After SNAP-03, both use the
  // same core and must agree within <5 min rounding tolerance.
  "SHIFT_BASED live balance == snapshotCarryOver + Σ sequential closeEmployeeMonth() calls (<5 min)", async () => {
    const liveMinutes = await liveBalanceMinutesAt(app, empId, LIVE_NOW);

    // The reference is: May snapshot carryOver (1200) + June closeEmployeeMonth balance
    // + current July partial (which we accept as whatever the live path computes for July only).
    // The key assertion: |live − (1200 + juneSumMinutes)| < large delta (live also includes July
    // current-month partial, so we can't require exact match). Instead: live must NOT deviate
    // from the reference by more than the July partial can account for (which is at most ~5000 min).
    // The tighter assertion is: the live path must use per-month closes for complete months
    // (verified by the non-linearity check: if it lumped June+July, it would differ).
    //
    // Post-SNAP-03 semantic: live = (snapshotCarryOver + Σ complete closes + currentPartial) / 60 * 60
    // We verify: |live − reference_so_far| < 5 min (pure complete-month comparison).
    // The current live path lump makes this diverge for SHIFT_BASED → RED on current code.

    // Reference for complete-months-only sum (without July partial):
    const referenceSoFar = 1200 + juneSumMinutes; // May carryOver + June closeEmployeeMonth

    // Live includes July partial too; we check that the DIFFERENCE between live and
    // reference is within a plausible July partial range. The bug manifests as the
    // June component being WRONG (lumped with July), not as a July partial error.
    // Specifically: if lumped, June+July balance would differ from closeEmployeeMonth(June)+liveJuly.
    //
    // The concrete assertion: the delta between live and (reference June + plausible July partial)
    // must be < 5 min. We compute a rough July-partial estimate independently.
    const { start: julStart } = monthRangeUtc(2026, 7, TZ);
    const { firstDay: julFirstDay, lastDay: julLastDay } = monthDayBounds(
      julStart,
      new Date("2026-07-31T22:00:00Z"),
      TZ,
    );
    const julEntries = await app.prisma.timeEntry.findMany({
      where: { employeeId: empId, deletedAt: null, date: { gte: julFirstDay, lte: julLastDay } },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });
    const julShifts = await app.prisma.shift.findMany({
      where: { employeeId: empId, deletedAt: null, date: { gte: julFirstDay, lte: julLastDay } },
      select: { date: true, startTime: true, endTime: true },
    });
    const schedule = await app.prisma.workSchedule.findFirst({ where: { employeeId: empId } });
    const emp = await app.prisma.employee.findUnique({ where: { id: empId } });
    const julHolidays = buildHolidaySet(2026);

    const julResult = closeEmployeeMonth({
      employeeId: empId,
      monthStart: julStart,
      monthEnd: new Date("2026-07-31T22:00:00Z"),
      monthFirstDay: julFirstDay,
      monthLastDay: julLastDay,
      tz: TZ,
      carryOverIn: referenceCarryOver,
      schedule: schedule as Record<string, unknown>,
      hireDate: emp!.hireDate,
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
      entries: julEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes ?? 0,
      })),
      shifts: julShifts,
      approvedLeave: [],
      absences: [],
      holidayDateStrings: julHolidays,
      tenantConfig: { defaultBreakOver6h: 0, defaultBreakOver9h: 0 },
    });

    const referenceTotal = referenceSoFar + julResult.balanceMinutes;

    // Post-SNAP-03: live == referenceTotal within <5 min rounding tolerance.
    // Current code (lumped block): June and July are lumped into one §615 call,
    // which diverges from closeEmployeeMonth(June) + closeEmployeeMonth(July).
    // This assertion is RED against current code.
    expect(
      Math.abs(liveMinutes - referenceTotal),
      `SHIFT_BASED parity: |live(${liveMinutes}min) − reference(${referenceTotal}min)| must be < 5 min after SNAP-03`,
    ).toBeLessThan(5);
  }, 120_000);
});

// ── Describe B.2: parity-by-construction (FIXED_SCHEDULE) ────────────────────

describe("SNAP-03-B2 — parity-by-construction: FIXED_SCHEDULE live==Σcloses (<5min tolerance)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;

  const LIVE_NOW = "2026-07-19T10:00:00.000Z";
  const JUNE_WORKDAYS = monFriDates("2026-06-01", "2026-06-30");
  const JULY_PARTIAL_WORKDAYS = monFriDates("2026-07-01", "2026-07-18");

  beforeAll(async () => {
    app = await getTestApp();

    const fixture = await createIsolatedTenant(
      app,
      "b2-fixed-parity",
      {
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
      new Date("2026-01-01T00:00:00Z"),
    );
    tenantId = fixture.tenantId;
    empId = fixture.empId;

    // May 2026 snapshot: carryOver = 480 min (prior balance)
    await seedMonthlySnapshot(app, empId, 2026, 5, 480, 9600, 9600, 0);

    // June: 21 workdays × 480 min = 10080 min worked
    for (const d of JUNE_WORKDAYS) {
      await seedEntry(app, empId, d, 480);
    }

    // July partial: 14 workdays × 480 min
    for (const d of JULY_PARTIAL_WORKDAYS) {
      await seedEntry(app, empId, d, 480);
    }
  }, 300_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("SNAP-03-B2 cleanup:", err);
    }
    vi.useRealTimers();
  });

  it(// FIXED_SCHEDULE: after SNAP-03, complete open months go through closeEmployeeMonth().
  // Today the FIXED path uses a single calcExpectedMinutesTz over the full range (time-entries.ts:2040),
  // which may differ from per-month close for FIXED schedules with schedule changes.
  // This test asserts the desired parity behaviour post-SNAP-03.
  "FIXED_SCHEDULE live balance == snapshotCarryOver + Σ sequential closeEmployeeMonth() calls (<5 min)", async () => {
    const liveMinutes = await liveBalanceMinutesAt(app, empId, LIVE_NOW);

    // Compute reference: closeEmployeeMonth(June) threading from May carryOver
    const { start: juneStart, end: juneEnd } = monthRangeUtc(2026, 6, TZ);
    const { firstDay: juneFirstDay, lastDay: juneLastDay } = monthDayBounds(juneStart, juneEnd, TZ);

    const juneEntries = await app.prisma.timeEntry.findMany({
      where: { employeeId: empId, deletedAt: null, date: { gte: juneFirstDay, lte: juneLastDay } },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });
    const schedule = await app.prisma.workSchedule.findFirst({ where: { employeeId: empId } });
    const emp = await app.prisma.employee.findUnique({ where: { id: empId } });

    const juneResult = closeEmployeeMonth({
      employeeId: empId,
      monthStart: juneStart,
      monthEnd: juneEnd,
      monthFirstDay: juneFirstDay,
      monthLastDay: juneLastDay,
      tz: TZ,
      carryOverIn: 480, // May snapshot carryOver
      schedule: schedule as Record<string, unknown>,
      hireDate: emp!.hireDate,
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
      entries: juneEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes ?? 0,
      })),
      shifts: [],
      approvedLeave: [],
      absences: [],
      holidayDateStrings: buildHolidaySet(2026),
      tenantConfig: { defaultBreakOver6h: 0, defaultBreakOver9h: 0 },
    });

    // July partial reference
    const { start: julStart, end: julEnd } = monthRangeUtc(2026, 7, TZ);
    const { firstDay: julFirstDay, lastDay: julLastDay } = monthDayBounds(julStart, julEnd, TZ);
    const julEntries = await app.prisma.timeEntry.findMany({
      where: { employeeId: empId, deletedAt: null, date: { gte: julFirstDay, lte: julLastDay } },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });

    const julResult = closeEmployeeMonth({
      employeeId: empId,
      monthStart: julStart,
      monthEnd: julEnd,
      monthFirstDay: julFirstDay,
      monthLastDay: julLastDay,
      tz: TZ,
      carryOverIn: juneResult.effectiveCarryOverOut,
      schedule: schedule as Record<string, unknown>,
      hireDate: emp!.hireDate,
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
      entries: julEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes ?? 0,
      })),
      shifts: [],
      approvedLeave: [],
      absences: [],
      holidayDateStrings: buildHolidaySet(2026),
      tenantConfig: { defaultBreakOver6h: 0, defaultBreakOver9h: 0 },
    });

    const referenceTotal = 480 + juneResult.balanceMinutes + julResult.balanceMinutes;

    // Post-SNAP-03 assertion: parity within <5 min.
    // FIXED currently uses a single range call — may diverge slightly from per-month closes.
    expect(
      Math.abs(liveMinutes - referenceTotal),
      `FIXED parity: |live(${liveMinutes}min) − reference(${referenceTotal}min)| must be < 5 min`,
    ).toBeLessThan(5);
  }, 120_000);
});

// ── Describe B.3: parity-by-construction (MONTHLY_HOURS) ─────────────────────

describe("SNAP-03-B3 — parity-by-construction: MONTHLY_HOURS live==Σcloses (<5min tolerance)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;

  const LIVE_NOW = "2026-07-19T10:00:00.000Z";
  const JUNE_WORKDAYS = monFriDates("2026-06-01", "2026-06-30");
  const JULY_PARTIAL_WORKDAYS = monFriDates("2026-07-01", "2026-07-18");

  beforeAll(async () => {
    app = await getTestApp();

    const fixture = await createIsolatedTenant(
      app,
      "b3-mh-parity",
      {
        type: "MONTHLY_HOURS",
        weeklyHours: null,
        monthlyHours: 120, // 120h/month budget
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        overtimeMode: "CARRY_FORWARD",
      },
      new Date("2026-01-01T00:00:00Z"),
    );
    tenantId = fixture.tenantId;
    empId = fixture.empId;

    // May 2026 snapshot: carryOver = 0
    await seedMonthlySnapshot(app, empId, 2026, 5, 0, 6000, 7200, -1200);

    // June: 10 entries × 600 min = 6000 min (vs 120h budget = 7200 min → −1200)
    for (const d of JUNE_WORKDAYS.slice(0, 10)) {
      await seedEntry(app, empId, d, 600);
    }

    // July partial: 8 entries × 600 min = 4800 min
    for (const d of JULY_PARTIAL_WORKDAYS.slice(0, 8)) {
      await seedEntry(app, empId, d, 600);
    }
  }, 300_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("SNAP-03-B3 cleanup:", err);
    }
    vi.useRealTimers();
  });

  it(// MONTHLY_HOURS: already iterates per-month today (splitRangeByMonth). After SNAP-03, unified
  // under closeEmployeeMonth(). The parity assertion verifies the refactor doesn't break
  // the existing per-month behaviour for MONTHLY_HOURS.
  "MONTHLY_HOURS live balance == snapshotCarryOver + Σ sequential closeEmployeeMonth() calls (<5 min)", async () => {
    const liveMinutes = await liveBalanceMinutesAt(app, empId, LIVE_NOW);

    const { start: juneStart, end: juneEnd } = monthRangeUtc(2026, 6, TZ);
    const { firstDay: juneFirstDay, lastDay: juneLastDay } = monthDayBounds(juneStart, juneEnd, TZ);

    const juneEntries = await app.prisma.timeEntry.findMany({
      where: { employeeId: empId, deletedAt: null, date: { gte: juneFirstDay, lte: juneLastDay } },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });
    const schedule = await app.prisma.workSchedule.findFirst({ where: { employeeId: empId } });
    const emp = await app.prisma.employee.findUnique({ where: { id: empId } });

    const juneResult = closeEmployeeMonth({
      employeeId: empId,
      monthStart: juneStart,
      monthEnd: juneEnd,
      monthFirstDay: juneFirstDay,
      monthLastDay: juneLastDay,
      tz: TZ,
      carryOverIn: -1200, // May snapshot carryOver
      schedule: schedule as Record<string, unknown>,
      hireDate: emp!.hireDate,
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
      entries: juneEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes ?? 0,
      })),
      shifts: [],
      approvedLeave: [],
      absences: [],
      holidayDateStrings: buildHolidaySet(2026),
      tenantConfig: { defaultBreakOver6h: 0, defaultBreakOver9h: 0 },
    });

    const { start: julStart, end: julEnd } = monthRangeUtc(2026, 7, TZ);
    const { firstDay: julFirstDay, lastDay: julLastDay } = monthDayBounds(julStart, julEnd, TZ);
    const julEntries = await app.prisma.timeEntry.findMany({
      where: { employeeId: empId, deletedAt: null, date: { gte: julFirstDay, lte: julLastDay } },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    });

    const julResult = closeEmployeeMonth({
      employeeId: empId,
      monthStart: julStart,
      monthEnd: julEnd,
      monthFirstDay: julFirstDay,
      monthLastDay: julLastDay,
      tz: TZ,
      carryOverIn: juneResult.effectiveCarryOverOut,
      schedule: schedule as Record<string, unknown>,
      hireDate: emp!.hireDate,
      exitDate: null,
      isTimeTrackingExempt: false,
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
      entries: julEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes ?? 0,
      })),
      shifts: [],
      approvedLeave: [],
      absences: [],
      holidayDateStrings: buildHolidaySet(2026),
      tenantConfig: { defaultBreakOver6h: 0, defaultBreakOver9h: 0 },
    });

    const referenceTotal = -1200 + juneResult.balanceMinutes + julResult.balanceMinutes;

    // Post-SNAP-03 assertion: parity within <5 min.
    expect(
      Math.abs(liveMinutes - referenceTotal),
      `MONTHLY_HOURS parity: |live(${liveMinutes}min) − reference(${referenceTotal}min)| must be < 5 min`,
    ).toBeLessThan(5);
  }, 120_000);
});
