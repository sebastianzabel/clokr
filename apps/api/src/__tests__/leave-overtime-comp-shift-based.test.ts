/**
 * leave-overtime-comp-shift-based.test.ts
 *
 * Originally Phase 100 (OTC-04, Task 2): end-to-end pin that a SHIFT_BASED OVERTIME_COMP
 * request costs the ROSTERED netto hours (Shift table), not the WorkSchedule per-day Soll
 * fields. Superseded by the owner's 2026-09-23 decision on issue #293: the day now costs the
 * Ø-Methode day (the same figure the saldo itself uses to credit it), and the roster is no
 * longer read at all. This file now pins THAT invariant across the gate (POST
 * /leave/requests) and the preview (GET /leave/hours-preview) — the same function,
 * `getScheduledHours`, backs both.
 *
 * This file owns its own tenant + two-employee fixture (SHIFT_BASED + FIXED_SCHEDULE, same
 * tenant) rather than reusing another suite's — Phase 100's sibling files each build their own
 * for the same reason (see leave-overtime-comp-tolerance.test.ts's header note).
 *
 * Every date is computed from `new Date()` (never a hardcoded calendar literal) — documented
 * hardcoded-date time-bomb hazard, `.planning/STATE.md`. `hireDate` / `validFrom` fixture
 * columns use a computed PAST anchor (two full years before "now"), never a literal, so this
 * file carries zero hardcoded calendar-year strings — matching the stricter blanket rule this
 * task's own acceptance grep applies (unlike the pre-existing confirmed-check suite, which keeps
 * its past-anchored literals for a documented reason in its own header).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData, createTestSalon } from "./setup"; // Phase 325 (issue #325)
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { getHolidays, STATE_MAP } from "../contexts/platform/holidays";

/**
 * Next Monday at least `daysOut` days out (UTC arithmetic), advanced past any NI public
 * holiday in a bounded loop (own-year lookup, since a Dec->Jan boundary can straddle years) —
 * same construction as the sibling Phase-100 suites' `computeRequestMonday()`.
 */
function nextNonHolidayMonday(daysOut: number): string {
  const now = new Date();
  let candidate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysOut),
  );
  const daysUntilMonday = (8 - candidate.getUTCDay()) % 7;
  candidate = new Date(
    Date.UTC(
      candidate.getUTCFullYear(),
      candidate.getUTCMonth(),
      candidate.getUTCDate() + daysUntilMonday,
    ),
  );

  const MAX_HOLIDAY_ADVANCES = 10;
  for (let i = 0; i < MAX_HOLIDAY_ADVANCES; i++) {
    const iso = candidate.toISOString().slice(0, 10);
    const holidays = getHolidays(candidate.getUTCFullYear(), STATE_MAP.NIEDERSACHSEN);
    if (!holidays.some((h) => h.date === iso)) return iso;
    candidate = new Date(
      Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), candidate.getUTCDate() + 7),
    );
  }
  throw new Error(
    "nextNonHolidayMonday: exceeded MAX_HOLIDAY_ADVANCES without a non-holiday Monday",
  );
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Four widely-spaced anchors on the SAME employee's timeline — 28 days apart so no realistic
// holiday-skip can make any two collide; the beforeAll invariant below re-verifies this rather
// than trusting it silently.
//
// The fixture's Ø-Methode day (#293): weeklyHours 40 / workDays.length 5 (schema default
// [1,2,3,4,5], never overridden below) = 480min = 8.00h per contracted weekday. Every expected
// number from here on is derived from that one fact, not hardcoded independently of it.
const MONDAY_1 = nextNonHolidayMonday(14); // single rostered shift 09:00-15:00 -> 8.00h (flagship, roster now irrelevant)
const MONDAY_2 = nextNonHolidayMonday(42); // shift created THEN soft-deleted -> still 8.00h (D-06 reversed: roster is not read)
const MONDAY_3 = nextNonHolidayMonday(70); // no shift at all -> still 8.00h (D-08 reversed: an empty roster is no longer free)
const RANGE_4_MON = nextNonHolidayMonday(98); // two contracted weekdays Mon+Tue -> 16.00h (2 x Ø-Methode day); halfDay -> 8.00h
const RANGE_4_TUE = addDaysIso(RANGE_4_MON, 1);
// WR-02 (code review, 2026-08-21): SAME-DAY split shift, inserted LATE-time-first /
// EARLY-time-second — the reverse of `startTime asc` order — so a correct pick can only come
// from the ORDER BY tie-break, never from insertion/physical row order.
const SPLIT_SHIFT_DAY = nextNonHolidayMonday(126);

const GENEROUS_CONFIRMED_MINUTES = 6000; // 100:00 -- comfortably covers every accepted case below
// Deliberately generous legacy value (mirrors the sibling tolerance suite's STALE_BALANCE_HOURS):
// an accidental fail-safe read must be VISIBLE as an unexpected 201, never mask a wrong-source bug.
const STALE_BALANCE_HOURS = 999;
// Computed past anchor for hireDate/validFrom fixture columns — two full years before "now",
// always in the past (never expires), carries no literal calendar-year string.
const PAST_ANCHOR = new Date(Date.UTC(new Date().getUTCFullYear() - 2, 0, 1));

describe("POST /leave/requests + GET /leave/hours-preview — SHIFT_BASED getScheduledHours (issue #293)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let shiftEmpToken: string;
  let fixedEmpToken: string;
  let shiftSnapshotId: string;
  let monday2ShiftId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;

    // Self-verifying invariant: the four anchors must be strictly increasing, or a downstream
    // range collision would silently corrupt the assertions below.
    const anchors = [MONDAY_1, MONDAY_2, MONDAY_3, RANGE_4_MON, SPLIT_SHIFT_DAY];
    for (let i = 1; i < anchors.length; i++) {
      if (anchors[i] <= anchors[i - 1]) {
        throw new Error(`fixture anchors not strictly increasing: ${anchors.join(", ")}`);
      }
    }

    const suffix = "shb-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `SHB ${suffix}`, slug: `shb-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    const salonId = (await createTestSalon(prisma, tenantId)).id; // Phase 325 (issue #325)
    // TenantConfig created EXPLICITLY (not auto-created for a hand-rolled tenant.create()), so
    // the break defaults (30/45) come from a real row — not the code's own
    // `cfg?.defaultBreakOver6h ?? 30` fallback for a MISSING row.
    await prisma.tenantConfig.create({ data: { tenantId } });

    const passwordHash = await bcrypt.hash("test1234", 10);

    // ── SHIFT_BASED employee ────────────────────────────────────────────────
    const shiftUser = await prisma.user.create({
      data: {
        email: `shb-shift-${suffix}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const shiftEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: shiftUser.id,
        employeeNumber: `SHB-S-${suffix}`,
        firstName: "SHB",
        lastName: "Shift",
        hireDate: PAST_ANCHOR,
      },
    });

    // mondayHours deliberately 8 (SHIFT_BASED ignores every per-Tag-Soll field — it happens to
    // equal the Ø-Methode day for this fixture, but that is coincidence, not the source of the
    // 8.00h the assertions below check). workDays is left at the schema default [1,2,3,4,5], so
    // the Ø-Methode day = weeklyHours 40 / workDays.length 5 = 8.00h for any Mon-Fri day (#293).
    await prisma.workSchedule.create({
      data: {
        employeeId: shiftEmp.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        mondayHours: 8,
        validFrom: PAST_ANCHOR,
      },
    });

    const closedYear = new Date().getUTCFullYear() - 1;
    const shiftSnapshot = await prisma.saldoSnapshot.create({
      data: {
        employeeId: shiftEmp.id,
        periodType: "MONTHLY",
        periodStart: new Date(Date.UTC(closedYear, 6, 1)),
        periodEnd: new Date(Date.UTC(closedYear, 6, 31)),
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: GENEROUS_CONFIRMED_MINUTES,
        closedAt: new Date(Date.UTC(closedYear, 7, 1, 6, 0, 0)),
        superseded: false,
      },
    });
    shiftSnapshotId = shiftSnapshot.id;

    await prisma.overtimeAccount.create({
      data: { employeeId: shiftEmp.id, balanceHours: STALE_BALANCE_HOURS },
    });

    // MONDAY_1: one rostered shift, 09:00-15:00 (6.00h netto). Kept deliberately DIFFERENT from
    // the 8.00h Ø-Methode day this now costs (#293) — the gap proves the roster is not read.
    await prisma.shift.create({
      data: {
        employeeId: shiftEmp.id,
        salonId, // Phase 325 (issue #325)
        date: new Date(MONDAY_1 + "T00:00:00Z"),
        startTime: "09:00",
        endTime: "15:00",
      },
    });

    // MONDAY_2: a shift exists but is soft-deleted — must NOT change the cost (D-06, now
    // trivially true because the branch never reads the Shift table any more).
    const m2Shift = await prisma.shift.create({
      data: {
        employeeId: shiftEmp.id,
        salonId, // Phase 325 (issue #325)
        date: new Date(MONDAY_2 + "T00:00:00Z"),
        startTime: "09:00",
        endTime: "15:00",
      },
    });
    monday2ShiftId = m2Shift.id;
    await prisma.shift.update({
      where: { id: monday2ShiftId },
      data: { deletedAt: new Date(), deletedReason: "TEST_SOFT_DELETE" },
    });

    // MONDAY_3: deliberately NO shift created — D-08's "empty roster costs nothing" is REVERSED
    // by #293: the day still costs the Ø-Methode day.

    // RANGE_4: two shifts across Mon+Tue, deliberately at netto values that do NOT sum to the
    // 16.00h (2 x Ø-Methode day) the range now costs — Mon 09:00-15:00 (6.00h netto) + Tue
    // 06:00-14:00 (7.50h netto) = 13.50h roster sum, proving the range total is no longer the
    // roster's. halfDay uses calcLeaveAbsenceMinutesTz's own halfDay option on the whole range,
    // not "the first shift" — 8.00h (half of 16.00h).
    await prisma.shift.create({
      data: {
        employeeId: shiftEmp.id,
        salonId, // Phase 325 (issue #325)
        date: new Date(RANGE_4_MON + "T00:00:00Z"),
        startTime: "09:00",
        endTime: "15:00",
      },
    });
    await prisma.shift.create({
      data: {
        employeeId: shiftEmp.id,
        salonId, // Phase 325 (issue #325)
        date: new Date(RANGE_4_TUE + "T00:00:00Z"),
        startTime: "06:00",
        endTime: "14:00",
      },
    });

    // SPLIT_SHIFT_DAY (WR-02, now superseded): two shifts on the SAME calendar day, inserted
    // with the LATE-time shift FIRST and the EARLY-time shift SECOND — deliberately the reverse
    // of `startTime asc`. The determinism property WR-02 fixed is superseded by a STRONGER one
    // (#293): the roster is not read at all, so insertion order cannot matter regardless of
    // which shift a query might have picked.
    await prisma.shift.create({
      data: {
        employeeId: shiftEmp.id,
        salonId, // Phase 325 (issue #325)
        date: new Date(SPLIT_SHIFT_DAY + "T00:00:00Z"),
        startTime: "14:00",
        endTime: "21:00",
      },
    });
    await prisma.shift.create({
      data: {
        employeeId: shiftEmp.id,
        salonId, // Phase 325 (issue #325)
        date: new Date(SPLIT_SHIFT_DAY + "T00:00:00Z"),
        startTime: "06:00",
        endTime: "10:00",
      },
    });

    const shiftLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `shb-shift-${suffix}@test.de`, password: "test1234" },
    });
    shiftEmpToken = JSON.parse(shiftLogin.body).accessToken;

    // ── FIXED_SCHEDULE employee (no-regression control) ─────────────────────
    const fixedUser = await prisma.user.create({
      data: {
        email: `shb-fixed-${suffix}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const fixedEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: fixedUser.id,
        employeeNumber: `SHB-F-${suffix}`,
        firstName: "SHB",
        lastName: "Fixed",
        hireDate: PAST_ANCHOR,
      },
    });

    await prisma.workSchedule.create({
      data: {
        employeeId: fixedEmp.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 8,
        mondayHours: 8,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1],
        validFrom: PAST_ANCHOR,
      },
    });

    // Identical shift row on the SAME date as MONDAY_1, under the FIXED_SCHEDULE employee —
    // must be completely ignored; the per-day Soll (8h) still applies.
    await prisma.shift.create({
      data: {
        employeeId: fixedEmp.id,
        salonId, // Phase 325 (issue #325)
        date: new Date(MONDAY_1 + "T00:00:00Z"),
        startTime: "09:00",
        endTime: "15:00",
      },
    });

    const fixedLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `shb-fixed-${suffix}@test.de`, password: "test1234" },
    });
    fixedEmpToken = JSON.parse(fixedLogin.body).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("leave-overtime-comp-shift-based cleanup failed:", err);
    }
  });

  async function hoursPreview(token: string, startDate: string, endDate: string, halfDay = false) {
    return app.inject({
      method: "GET",
      url: `/api/v1/leave/hours-preview?startDate=${startDate}&endDate=${endDate}&halfDay=${halfDay}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function postOvertimeComp(
    token: string,
    startDate: string,
    endDate: string,
    halfDay = false,
  ) {
    return app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "OVERTIME_COMP", startDate, endDate, halfDay },
    });
  }

  it("flagship (#293): one rostered 09:00-15:00 shift costs the 8.00h Ø-Methode day on the gate, NOT the roster's 6.00h — proven via a deliberately-too-large request against a temporarily zeroed confirmed balance", async () => {
    await app.prisma.saldoSnapshot.update({
      where: { id: shiftSnapshotId },
      data: { carryOver: 0 },
    });
    try {
      const res = await postOvertimeComp(shiftEmpToken, MONDAY_1, MONDAY_1);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.requested).toBe(8);
      expect(body.available).toBe(0);
    } finally {
      await app.prisma.saldoSnapshot.update({
        where: { id: shiftSnapshotId },
        data: { carryOver: GENEROUS_CONFIRMED_MINUTES },
      });
    }
  });

  it("GET /leave/hours-preview returns the SAME 8.00h for the identical range — gate and preview agree (OTC-05); minutesNeeded is the exact-minute counterpart (WR-03)", async () => {
    const res = await hoursPreview(shiftEmpToken, MONDAY_1, MONDAY_1);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hours).toBe(8);
    // WR-03 (code review) — minutesNeeded is Math.round(hours * 60), the SAME formula
    // the POST /requests OVERTIME_COMP gate uses for neededMinutes. The client compares
    // against this exact integer instead of reconstructing it from the rounded `hours`.
    expect(body.minutesNeeded).toBe(480);
  });

  it("D-06 REVERSED (#293): a soft-deleted shift does NOT change the cost — still the 8.00h Ø-Methode day, because the roster is not read at all", async () => {
    const preview = await hoursPreview(shiftEmpToken, MONDAY_2, MONDAY_2);
    expect(JSON.parse(preview.body).hours).toBe(8);

    const res = await postOvertimeComp(shiftEmpToken, MONDAY_2, MONDAY_2);
    expect(res.statusCode).toBe(201);
  });

  it("D-08 REVERSED (#293): no shift at all in the range still costs the 8.00h Ø-Methode day — an empty roster is no longer free", async () => {
    const preview = await hoursPreview(shiftEmpToken, MONDAY_3, MONDAY_3);
    expect(JSON.parse(preview.body).hours).toBe(8);

    const res = await postOvertimeComp(shiftEmpToken, MONDAY_3, MONDAY_3);
    expect(res.statusCode).toBe(201);
  });

  it("D-05 REVERSED (#293): two contracted weekdays in a 2-day range cost 16.00h (2 x the 8.00h Ø-Methode day), NOT the roster's 13.50h sum", async () => {
    const preview = await hoursPreview(shiftEmpToken, RANGE_4_MON, RANGE_4_TUE);
    expect(JSON.parse(preview.body).hours).toBe(16);

    const res = await postOvertimeComp(shiftEmpToken, RANGE_4_MON, RANGE_4_TUE);
    expect(res.statusCode).toBe(201);
  });

  it("D-07 REVERSED (#293): halfDay over the same 2-day range costs half the RANGE's Ø-Methode total — 8.00h (WR-03: minutesNeeded 480), not half the first shift's netto", async () => {
    const preview = await hoursPreview(shiftEmpToken, RANGE_4_MON, RANGE_4_TUE, true);
    const body = JSON.parse(preview.body);
    expect(body.hours).toBe(8);
    expect(body.minutesNeeded).toBe(480);
  });

  it("WR-02 SUPERSEDED (#293): same-day split shift costs 4.00h (half the 8.00h Ø-Methode day) regardless of which shift was inserted first — the roster is not read, so insertion order cannot matter", async () => {
    // Both shifts share the same `date`; under the old rule only `startTime asc` (the WR-02
    // fix) could break the tie. Under #293 the tie is moot: the branch never queries the Shift
    // table, so the LATE-time-first insertion order below is deliberately left as-is to prove
    // it no longer has any effect on the result.
    const preview = await hoursPreview(shiftEmpToken, SPLIT_SHIFT_DAY, SPLIT_SHIFT_DAY, true);
    expect(preview.statusCode).toBe(200);
    const previewBody = JSON.parse(preview.body);
    expect(previewBody.hours).toBe(4);
    expect(previewBody.minutesNeeded).toBe(240); // WR-03: exact-minute counterpart

    const res = await postOvertimeComp(shiftEmpToken, SPLIT_SHIFT_DAY, SPLIT_SHIFT_DAY, true);
    expect(res.statusCode).toBe(201);
  });

  it("FIXED_SCHEDULE employee with an identical shift row present is unaffected — the per-day Soll (8h) still applies, the shift is ignored", async () => {
    const preview = await hoursPreview(fixedEmpToken, MONDAY_1, MONDAY_1);
    expect(preview.statusCode).toBe(200);
    expect(JSON.parse(preview.body).hours).toBe(8);
  });
});
