/**
 * leave-overtime-comp-shift-based.test.ts
 *
 * Phase 100 (OTC-04, Task 2) — end-to-end pin that a SHIFT_BASED OVERTIME_COMP request costs
 * the ROSTERED netto hours (Shift table), not the WorkSchedule per-day Soll fields, across the
 * gate (POST /leave/requests) and the preview (GET /leave/hours-preview) — the same function,
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
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { getHolidays, STATE_MAP } from "../utils/holidays";

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
const MONDAY_1 = nextNonHolidayMonday(14); // single rostered shift 09:00-15:00 -> 6.00h (flagship)
const MONDAY_2 = nextNonHolidayMonday(42); // shift created THEN soft-deleted -> 0h (D-06)
const MONDAY_3 = nextNonHolidayMonday(70); // no shift at all -> 0h (D-08)
const RANGE_4_MON = nextNonHolidayMonday(98); // two shifts Mon+Tue -> 13.50h (D-05); halfDay -> 3.00h (D-07)
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

describe("POST /leave/requests + GET /leave/hours-preview — SHIFT_BASED getScheduledHours (Phase 100 / OTC-04)", () => {
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
    // range collision would silently corrupt the D-05/D-06/D-08 assertions below.
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

    // mondayHours deliberately 8 — the divergence between this and the rostered 6h IS the
    // OTC-04 assertion. SHIFT_BASED ignores every per-Tag-Soll field on this row.
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

    // MONDAY_1: one rostered shift, 09:00-15:00 (360 brutto, exactly 6h -> break 0 -> 6.00h netto).
    await prisma.shift.create({
      data: {
        employeeId: shiftEmp.id,
        date: new Date(MONDAY_1 + "T00:00:00Z"),
        startTime: "09:00",
        endTime: "15:00",
      },
    });

    // MONDAY_2: a shift exists but is soft-deleted — must contribute 0 (D-06).
    const m2Shift = await prisma.shift.create({
      data: {
        employeeId: shiftEmp.id,
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

    // MONDAY_3: deliberately NO shift created — D-08.

    // RANGE_4: two shifts across Mon+Tue — Mon 09:00-15:00 (360 brutto -> 6.00h) + Tue
    // 06:00-14:00 (480 brutto, over 6h -> break 30 -> 7.50h) = 13.50h; halfDay uses the FIRST
    // (Monday's, orderBy date asc) shift's netto halved = 3.00h.
    await prisma.shift.create({
      data: {
        employeeId: shiftEmp.id,
        date: new Date(RANGE_4_MON + "T00:00:00Z"),
        startTime: "09:00",
        endTime: "15:00",
      },
    });
    await prisma.shift.create({
      data: {
        employeeId: shiftEmp.id,
        date: new Date(RANGE_4_TUE + "T00:00:00Z"),
        startTime: "06:00",
        endTime: "14:00",
      },
    });

    // SPLIT_SHIFT_DAY (WR-02): two shifts on the SAME calendar day, inserted with the LATE-time
    // shift FIRST and the EARLY-time shift SECOND — deliberately the reverse of `startTime asc` —
    // so the "first rostered shift" test below can only pass if the query's ORDER BY (not
    // insertion order) determines the pick. LATE: 14:00-21:00 = 420min brutto, >6h -> 30min break
    // -> 390min (6.50h) netto. EARLY: 06:00-10:00 = 240min brutto, <=6h -> no break -> 240min
    // (4.00h) netto. The two netto values are deliberately far apart so a wrong pick is unmissable.
    await prisma.shift.create({
      data: {
        employeeId: shiftEmp.id,
        date: new Date(SPLIT_SHIFT_DAY + "T00:00:00Z"),
        startTime: "14:00",
        endTime: "21:00",
      },
    });
    await prisma.shift.create({
      data: {
        employeeId: shiftEmp.id,
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

  it("flagship (D-05): one rostered 09:00-15:00 shift costs 6.00h on the gate, not the WorkSchedule's mondayHours=8 — proven via a deliberately-too-large request against a temporarily zeroed confirmed balance", async () => {
    await app.prisma.saldoSnapshot.update({
      where: { id: shiftSnapshotId },
      data: { carryOver: 0 },
    });
    try {
      const res = await postOvertimeComp(shiftEmpToken, MONDAY_1, MONDAY_1);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.requested).toBe(6);
      expect(body.available).toBe(0);
    } finally {
      await app.prisma.saldoSnapshot.update({
        where: { id: shiftSnapshotId },
        data: { carryOver: GENEROUS_CONFIRMED_MINUTES },
      });
    }
  });

  it("GET /leave/hours-preview returns the SAME 6.00h for the identical range — gate and preview agree (OTC-05)", async () => {
    const res = await hoursPreview(shiftEmpToken, MONDAY_1, MONDAY_1);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hours).toBe(6);
  });

  it("D-06: a soft-deleted shift contributes 0h and the request is NOT rejected for insufficient hours", async () => {
    const preview = await hoursPreview(shiftEmpToken, MONDAY_2, MONDAY_2);
    expect(JSON.parse(preview.body).hours).toBe(0);

    const res = await postOvertimeComp(shiftEmpToken, MONDAY_2, MONDAY_2);
    expect(res.statusCode).toBe(201);
  });

  it("D-08: no shift at all in the range costs 0h and the request is NOT rejected", async () => {
    const preview = await hoursPreview(shiftEmpToken, MONDAY_3, MONDAY_3);
    expect(JSON.parse(preview.body).hours).toBe(0);

    const res = await postOvertimeComp(shiftEmpToken, MONDAY_3, MONDAY_3);
    expect(res.statusCode).toBe(201);
  });

  it("D-05: two shifts in a 2-day range sum to 13.50h (the second shift's 480 brutto takes the 30min auto-break), accepted against the generous confirmed balance", async () => {
    const preview = await hoursPreview(shiftEmpToken, RANGE_4_MON, RANGE_4_TUE);
    expect(JSON.parse(preview.body).hours).toBe(13.5);

    const res = await postOvertimeComp(shiftEmpToken, RANGE_4_MON, RANGE_4_TUE);
    expect(res.statusCode).toBe(201);
  });

  it("D-07: halfDay over the same 2-day range costs half the FIRST rostered shift's netto — 3.00h, not half of 13.50h", async () => {
    const preview = await hoursPreview(shiftEmpToken, RANGE_4_MON, RANGE_4_TUE, true);
    expect(JSON.parse(preview.body).hours).toBe(3);
  });

  it("WR-02: same-day split shift picks the EARLY-time shift deterministically (2.00h), never the LATE-time one (3.25h), regardless of insertion order", async () => {
    // Both shifts share the same `date`; only `startTime asc` (the WR-02 fix) can break the tie.
    // The LATE shift (14:00-21:00, 6.50h netto) was inserted BEFORE the EARLY shift
    // (06:00-10:00, 4.00h netto) in beforeAll — a query relying on insertion/physical order would
    // be expected to surface the LATE shift first, giving the WRONG halfDay result (3.25h).
    const preview = await hoursPreview(shiftEmpToken, SPLIT_SHIFT_DAY, SPLIT_SHIFT_DAY, true);
    expect(preview.statusCode).toBe(200);
    expect(JSON.parse(preview.body).hours).toBe(2);

    const res = await postOvertimeComp(shiftEmpToken, SPLIT_SHIFT_DAY, SPLIT_SHIFT_DAY, true);
    expect(res.statusCode).toBe(201);
  });

  it("FIXED_SCHEDULE employee with an identical shift row present is unaffected — the per-day Soll (8h) still applies, the shift is ignored", async () => {
    const preview = await hoursPreview(fixedEmpToken, MONDAY_1, MONDAY_1);
    expect(preview.statusCode).toBe(200);
    expect(JSON.parse(preview.body).hours).toBe(8);
  });
});
