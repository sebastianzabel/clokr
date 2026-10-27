/**
 * Issue #70 (Phase 70b-05, AC-70-3, D-05, D-14, T-70b-20) — splitting a day across two salons
 * changes no figure, for EVERY schedule type.
 *
 * The working-time account reads entries by day (one per-day minute map; the `sbClaimed` dedup
 * keys days, not rows), so a day booked as 08:00-12:00 in salon A plus 13:00-17:00 in salon B must
 * produce exactly the figures of one entry 08:00-17:00 with a 60 min break (working minutes: 480
 * either way). This file proves it behaviourally, as an A/B comparison inside ONE run — no pinned
 * result literals: per schedule type (`describe.each`) two twin employees with the identical
 * contract live in one tenant with salons A and B. Twin S books every day as ONE entry with a
 * positioned break, twin M books the same day as two entries in two salons with the gap recorded
 * as a DayBreak (so neither twin has a § 4 finding to explain a difference). Every surface is
 * captured twice per twin (stability) and the twins' captures are then compared after the twin's
 * own identity (id, number, name, e-mail) is replaced by a placeholder:
 *
 *  - live saldo (`GET /overtime/:id`) and `GET /overtime/month-saldo/:id` of the OPEN month, with
 *    roster entries beyond "today" (SHIFT_BASED roster proration), an approved leave day that also
 *    carries a roster shift and a second overlapping leave row (the `sbClaimed` dedup), and a
 *    statutory holiday on a contractual workday (MONTHLY_HOURS Ø method);
 *  - the same month after its end, still unclosed (`workedDays` of the whole month);
 *  - the stored Monatsabschluss (Ist, Soll, balance, carry-over) and the closed-month reads;
 *  - for FIXED_SCHEDULE additionally the monthly report (JSON and the PDF payload), the DATEV
 *    export of the employee, the dashboard, and `GET /time-entries/summary` (working minutes —
 *    presence and break minutes differ by design: one entry has a 9 h presence and a 60 min entry
 *    break, two entries have an 8 h presence and the break in the gap).
 *
 * Per-entry row lists are NOT compared: they hold one row per entry by design.
 *
 * The literal case of the issue: 4 h + 3 h in two salons is a day of 420 minutes, and the month's
 * Ist rises by exactly that.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import iconv from "iconv-lite";
import { fromZonedTime } from "date-fns-tz";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  configureDatevKanzlei,
  grantSystemRole,
  numericEmployeeNumber,
} from "./setup";
import { TEST_TZ } from "./test-dates";
import * as pdfUtils from "../composition/pdf";

// Wrap the REAL PDF generator so the test can read the data payload (same pattern as test 79/81).
vi.mock("../composition/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composition/pdf")>();
  return {
    ...actual,
    generateMonthlyReportPdf: vi.fn(actual.generateMonthlyReportPdf),
  };
});

// March 2026 is the month under test: it has no public holiday in Niedersachsen of its own, so the
// one holiday below is the fixture's choice.
const CLOCK_LIVE = new Date("2026-03-26T10:00:00.000Z"); // March is open; "yesterday" is the 25th
const CLOCK_SALDO = new Date("2026-04-15T10:00:00.000Z"); // March is over and still unclosed
const CLOCK_DASHBOARD = new Date("2026-03-20T20:00:00.000Z");

/** Days with entries (the 5th is leave, the 11th a holiday, the 25th a gap). */
const ENTRY_DAYS = [
  "2026-03-02",
  "2026-03-03",
  "2026-03-04",
  "2026-03-06",
  "2026-03-09",
  "2026-03-10",
  "2026-03-12",
  "2026-03-13",
  "2026-03-16",
  "2026-03-17",
  "2026-03-18",
  "2026-03-19",
  "2026-03-20",
  "2026-03-23",
  "2026-03-24",
];
const LEAVE_DAY = "2026-03-05";
const HOLIDAY_DAY = "2026-03-11";
const PASSWORD = "test1234";

/** Tenant-local instant for `HH:MM` on `day`. */
function at(day: string, hhmm: string): Date {
  return fromZonedTime(`${day}T${hhmm}:00`, TEST_TZ);
}
function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Every weekday (Mon-Fri) of March 2026. */
function marchWeekdays(): string[] {
  const out: string[] = [];
  const cur = new Date("2026-03-01T00:00:00Z");
  while (cur.getUTCMonth() === 2) {
    const dow = cur.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

const SCHEDULE_TYPES = ["FIXED_SCHEDULE", "SHIFT_BASED", "MONTHLY_HOURS", "FLEXTIME"] as const;
type ScheduleType = (typeof SCHEDULE_TYPES)[number];

interface Twin {
  id: string;
  /** The row id of the twin's OvertimeAccount (`GET /overtime/:id` returns it as `id`). */
  accountId: string;
  userId: string;
  email: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
}

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (JSON.parse(res.body) as { accessToken: string }).accessToken;
}

/** The contract of a twin; identical for S and M of one schedule type. */
function scheduleData(type: ScheduleType, employeeId: string, validFrom: Date) {
  const weekdayHours = {
    mondayHours: 8,
    tuesdayHours: 8,
    wednesdayHours: 8,
    thursdayHours: 8,
    fridayHours: 8,
    saturdayHours: 0,
    sundayHours: 0,
  };
  switch (type) {
    case "FIXED_SCHEDULE":
    case "FLEXTIME":
      return {
        employeeId,
        type,
        weeklyHours: 40,
        ...weekdayHours,
        workDays: [1, 2, 3, 4, 5],
        validFrom,
      };
    case "MONTHLY_HOURS":
      // Prod shape: {day}Hours uniformly 0 (placeholder), `workDays` carries the contract.
      return {
        employeeId,
        type,
        weeklyHours: null,
        monthlyHours: 120,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom,
      };
    case "SHIFT_BASED":
      return {
        employeeId,
        type,
        weeklyHours: 40,
        ...weekdayHours,
        workDays: [1, 2, 3, 4, 5],
        contractWorkDaysPerWeek: 5,
        usualWorkDays: [1, 2, 3, 4, 5],
        validFrom,
      };
  }
}

describe.each(SCHEDULE_TYPES)(
  "Issue #70 (AC-70-3) — %s: a day split across two salons equals one entry",
  (scheduleType) => {
    let app: FastifyInstance;
    let tenantId: string;
    let adminEmail: string;
    let adminUserId: string;
    let salonA: string;
    let salonB: string;
    let single: Twin;
    let split: Twin;

    async function createTwin(
      label: string,
      leaveTypeId: string,
      leaveDays: number,
    ): Promise<Twin> {
      const prisma = app.prisma;
      const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const email = `eq70-${label}-${suffix}@test.de`;
      const user = await prisma.user.create({
        data: {
          email,
          passwordHash: await bcrypt.hash(PASSWORD, 10),
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const hireDate = new Date("2026-03-01T00:00:00Z");
      const employee = await prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: numericEmployeeNumber(),
          firstName: `Zwilling${label}`,
          lastName: `Prufling${label}`,
          hireDate,
        },
      });
      await grantSystemRole(prisma, { tenantId, userId: user.id, role: "EMPLOYEE" });
      await prisma.workSchedule.create({ data: scheduleData(scheduleType, employee.id, hireDate) });
      await prisma.employeeSalonAssignment.create({
        data: {
          tenantId,
          employeeId: employee.id,
          salonId: salonA,
          kind: "HOME",
          validFrom: hireDate,
          validUntil: null,
          weekdays: [],
        },
      });
      const account = await prisma.overtimeAccount.create({
        data: { employeeId: employee.id, balanceHours: 0 },
      });

      // The approved leave day, booked twice (two overlapping approved rows: the sbClaimed dedup).
      for (let i = 0; i < leaveDays; i++) {
        await prisma.leaveRequest.create({
          data: {
            employeeId: employee.id,
            leaveTypeId,
            startDate: dateOf(LEAVE_DAY),
            endDate: dateOf(LEAVE_DAY),
            days: 1,
            status: "APPROVED",
          },
        });
      }
      // The roster of a SHIFT_BASED twin: every weekday of March except the holiday, including
      // the leave day and the days after "today" of the open month (roster proration).
      if (scheduleType === "SHIFT_BASED") {
        for (const day of marchWeekdays()) {
          if (day === HOLIDAY_DAY) continue;
          await prisma.shift.create({
            data: {
              employeeId: employee.id,
              salonId: salonA,
              date: dateOf(day),
              startTime: "08:00",
              endTime: "16:00",
              label: "eq70",
            },
          });
        }
      }
      return {
        id: employee.id,
        accountId: account.id,
        userId: user.id,
        email,
        employeeNumber: employee.employeeNumber,
        firstName: employee.firstName,
        lastName: employee.lastName,
      };
    }

    /** Twin S: one entry 08:00-17:00, a positioned 60 min break 12:00-13:00. */
    async function bookSingleDay(employeeId: string, day: string) {
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId,
          salonId: salonA,
          date: dateOf(day),
          startTime: at(day, "08:00"),
          endTime: at(day, "17:00"),
          breakMinutes: 60,
          breakStatus: "CONFIRMED",
          type: "WORK",
          source: "MANUAL",
        },
      });
      await app.prisma.break.create({
        data: {
          timeEntryId: entry.id,
          startTime: at(day, "12:00"),
          endTime: at(day, "13:00"),
        },
      });
    }

    /** Twin M: 08:00-12:00 in A and 13:00-17:00 in B, the gap recorded as a DayBreak. */
    async function bookSplitDay(employeeId: string, day: string) {
      for (const [from, to, salonId] of [
        ["08:00", "12:00", salonA],
        ["13:00", "17:00", salonB],
      ] as const) {
        await app.prisma.timeEntry.create({
          data: {
            employeeId,
            salonId,
            date: dateOf(day),
            startTime: at(day, from),
            endTime: at(day, to),
            breakMinutes: 0,
            breakStatus: "CONFIRMED",
            type: "WORK",
            source: "MANUAL",
          },
        });
      }
      await app.prisma.dayBreak.create({
        data: {
          employeeId,
          date: dateOf(day),
          startTime: at(day, "12:00"),
          endTime: at(day, "13:00"),
          createdBy: adminUserId,
        },
      });
    }

    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(CLOCK_SALDO);
      app = await getTestApp();
      const seed = await seedTestData(app, `eq70-${scheduleType.toLowerCase()}`, {
        withDefaultSalon: false,
      });
      tenantId = seed.tenant.id;
      adminEmail = seed.adminUser.email;
      adminUserId = seed.adminUser.id;
      salonA = (await createTestSalon(app.prisma, tenantId, { name: "Salon A" })).id;
      salonB = (await createTestSalon(app.prisma, tenantId, { name: "Salon B" })).id;
      await configureDatevKanzlei(app, tenantId);
      // The statutory holiday of the month, in BOTH salons (it applies where the day is worked).
      for (const salonId of [salonA, salonB]) {
        await app.prisma.publicHoliday.create({
          data: {
            tenantId,
            salonId,
            date: dateOf(HOLIDAY_DAY),
            name: "Testfeiertag",
            federalState: "NIEDERSACHSEN",
            year: 2026,
          },
        });
      }
      single = await createTwin("s", seed.vacationType.id, 2);
      split = await createTwin("m", seed.vacationType.id, 2);
      for (const day of ENTRY_DAYS) {
        await bookSingleDay(single.id, day);
        await bookSplitDay(split.id, day);
      }
    }, 120_000);

    afterAll(async () => {
      vi.useRealTimers();
      try {
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("multi-entry-saldo-equality-70 cleanup failed:", err);
      }
      await closeTestApp();
    });

    async function get(token: string, url: string): Promise<unknown> {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, `${url} → ${res.body}`).toBe(200);
      return JSON.parse(res.body) as unknown;
    }

    /** The twin's identity replaced by a placeholder, so two twins' bodies can be compared. */
    function anonymise(body: unknown, twin: Twin): unknown {
      let text = JSON.stringify(body);
      for (const identity of [
        twin.id,
        twin.accountId,
        twin.userId,
        twin.email,
        twin.employeeNumber,
        twin.firstName,
        twin.lastName,
      ]) {
        text = text.split(identity).join("<TWIN>");
      }
      return JSON.parse(text) as unknown;
    }

    async function adminAt(clock: Date): Promise<string> {
      vi.setSystemTime(clock);
      return loginAs(app, adminEmail);
    }

    // ── Open month (CLOCK_LIVE) ───────────────────────────────────────────────────────────────
    async function captureOpenMonth(twin: Twin) {
      const admin = await adminAt(CLOCK_LIVE);
      const out: Record<string, unknown> = {
        balance: await get(admin, `/api/v1/overtime/${twin.id}`),
        monthSaldo: await get(admin, `/api/v1/overtime/month-saldo/${twin.id}?year=2026&month=3`),
      };
      return anonymise(out, twin) as Record<string, unknown>;
    }

    // ── Finished, still unclosed month (CLOCK_SALDO) ──────────────────────────────────────────
    async function captureFinishedMonth(twin: Twin) {
      const admin = await adminAt(CLOCK_SALDO);
      const out: Record<string, unknown> = {
        monthSaldo: await get(admin, `/api/v1/overtime/month-saldo/${twin.id}?year=2026&month=3`),
      };
      if (scheduleType === "FIXED_SCHEDULE") {
        out.reportMonthly = await get(
          admin,
          `/api/v1/reports/monthly?employeeId=${twin.id}&year=2026&month=3`,
        );
        const spy = vi.mocked(pdfUtils.generateMonthlyReportPdf);
        spy.mockClear();
        const pdf = await app.inject({
          method: "GET",
          url: `/api/v1/reports/monthly/pdf?employeeId=${twin.id}&year=2026&month=3`,
          headers: { authorization: `Bearer ${admin}` },
        });
        expect(pdf.statusCode).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);
        out.pdfPayload = withoutEntryRows(JSON.parse(JSON.stringify(spy.mock.calls[0][0])));
        const datev = await app.inject({
          method: "GET",
          url: `/api/v1/reports/datev/employee?employeeId=${twin.id}&year=2026&month=3`,
          headers: { authorization: `Bearer ${admin}` },
        });
        expect(datev.statusCode, datev.body).toBe(200);
        // Only the movement data: the header carries a generation timestamp.
        out.datevMovements = iconv.decode(datev.rawPayload, "win1252").split("[Bewegungsdaten]")[1];
        out.summary = pickWorking(
          await get(
            admin,
            `/api/v1/time-entries/summary?employeeId=${twin.id}&from=2026-03-01&to=2026-03-31`,
          ),
        );
      }
      return anonymise(out, twin) as Record<string, unknown>;
    }

    /**
     * The PDF payload lists one row per entry — one row per entry by design, so the row list is
     * not compared; what the rows add up to is (net minutes of the whole list).
     */
    function withoutEntryRows(payload: { entries?: Array<{ netMinutes: number }> }): unknown {
      const { entries, ...rest } = payload;
      expect(Array.isArray(entries), "the PDF payload lists the entries").toBe(true);
      const netMinutes = entries!.reduce((sum, e) => sum + e.netMinutes, 0);
      return { ...rest, entryNetMinutesTotal: netMinutes };
    }

    /**
     * Of the period summary only the working minutes (and the per-kind split of them) are the
     * figure: presence and break minutes differ by design between one entry with a break and two
     * entries with the break in the gap.
     */
    function pickWorking(summary: unknown): unknown {
      const s = summary as { workingMinutes: number; activityMinutes: unknown };
      return { workingMinutes: s.workingMinutes, activityMinutes: s.activityMinutes };
    }

    async function captureDashboard(twin: Twin) {
      vi.setSystemTime(CLOCK_DASHBOARD);
      const token = await loginAs(app, twin.email);
      const dashboard = (await get(token, "/api/v1/dashboard")) as {
        today?: { entries?: number };
      };
      // `today.entries` counts ENTRIES (one vs two) by design; the figure is `today.workedHours`.
      expect(typeof dashboard.today?.entries).toBe("number");
      delete dashboard.today!.entries;
      return anonymise(
        {
          dashboard,
          myWeek: await get(token, "/api/v1/dashboard/my-week?date=2026-03-18"),
        },
        twin,
      ) as Record<string, unknown>;
    }

    let openS: Record<string, unknown>;
    let openM: Record<string, unknown>;

    it("open month: live saldo and month saldo of the split twin equal the single twin's (stable twice)", async () => {
      openS = await captureOpenMonth(single);
      openM = await captureOpenMonth(split);
      expect(await captureOpenMonth(single)).toEqual(openS);
      expect(await captureOpenMonth(split)).toEqual(openM);

      // Non-vacuity: the fixture really carries working time, one worked day per entry day.
      const monthSaldo = openS.monthSaldo as {
        workedMinutes: number;
        expectedMinutes: number;
        workedDays?: number;
      };
      expect(monthSaldo.workedMinutes).toBe(ENTRY_DAYS.length * 480);
      expect(monthSaldo.workedDays).toBe(ENTRY_DAYS.length);
      expect(monthSaldo.expectedMinutes).toBeGreaterThan(0);

      for (const key of Object.keys(openS)) {
        expect(openM[key], `open-month surface ${key} differs between twins`).toEqual(openS[key]);
      }
    });

    it("finished, unclosed month: month saldo (workedDays of the whole month) and every report surface equal", async () => {
      const s = await captureFinishedMonth(single);
      const m = await captureFinishedMonth(split);
      expect(await captureFinishedMonth(single)).toEqual(s);
      expect(await captureFinishedMonth(split)).toEqual(m);

      const monthSaldo = s.monthSaldo as { workedMinutes: number; workedDays?: number };
      expect(monthSaldo.workedMinutes).toBe(ENTRY_DAYS.length * 480);
      expect(monthSaldo.workedDays).toBe(ENTRY_DAYS.length);

      expect(Object.keys(m).sort()).toEqual(Object.keys(s).sort());
      for (const key of Object.keys(s)) {
        expect(m[key], `finished-month surface ${key} differs between twins`).toEqual(s[key]);
      }
      if (scheduleType === "FIXED_SCHEDULE") {
        // The report and export surfaces really were captured (a missing key would pass above).
        for (const key of ["reportMonthly", "pdfPayload", "datevMovements", "summary"]) {
          expect(Object.keys(s), key).toContain(key);
        }
        expect((s.summary as { workingMinutes: number }).workingMinutes).toBe(
          ENTRY_DAYS.length * 480,
        );
        expect(String(s.datevMovements).length).toBeGreaterThan(0);
      }
    });

    if (scheduleType === "FIXED_SCHEDULE") {
      it("dashboard figures of the split twin equal the single twin's", async () => {
        const s = await captureDashboard(single);
        const m = await captureDashboard(split);
        expect(await captureDashboard(single)).toEqual(s);
        expect(await captureDashboard(split)).toEqual(m);
        expect(Object.keys(s)).toEqual(["dashboard", "myWeek"]);
        expect(m).toEqual(s);
      });
    }

    it("Monatsabschluss: the stored snapshot (Ist, Soll, balance, carry-over) and the closed-month reads equal", async () => {
      const admin = await adminAt(CLOCK_SALDO);
      for (const twin of [single, split]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/overtime/close-month",
          headers: { authorization: `Bearer ${admin}` },
          // Both twins have the same unrecorded workdays (the 25th, the 26th...); confirming
          // them is a precondition both share.
          payload: { employeeId: twin.id, year: 2026, month: 3, confirmGaps: true },
        });
        expect(res.statusCode, res.body).toBe(201);
      }
      const snapshot = async (employeeId: string) =>
        app.prisma.saldoSnapshot.findFirstOrThrow({
          where: { employeeId, periodType: "MONTHLY", superseded: false },
          select: {
            workedMinutes: true,
            expectedMinutes: true,
            balanceMinutes: true,
            carryOver: true,
          },
        });
      const stored = { s: await snapshot(single.id), m: await snapshot(split.id) };
      expect(stored.s.workedMinutes).toBe(ENTRY_DAYS.length * 480);
      expect(stored.s.expectedMinutes).toBeGreaterThan(0);
      expect(stored.m).toEqual(stored.s);

      const closedReads = async (twin: Twin) => {
        const token = await adminAt(CLOCK_SALDO);
        return anonymise(
          {
            balance: await get(token, `/api/v1/overtime/${twin.id}`),
            monthSaldo: await get(
              token,
              `/api/v1/overtime/month-saldo/${twin.id}?year=2026&month=3`,
            ),
          },
          twin,
        );
      };
      const closedS = await closedReads(single);
      expect(await closedReads(single)).toEqual(closedS);
      expect(await closedReads(split)).toEqual(closedS);
    });
  },
);

describe("Issue #70 (AC-70-3) — the literal case: 4 h in salon A + 3 h in salon B is a day of 420 minutes", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminEmail: string;
  let employeeId: string;
  let salonA: string;
  let salonB: string;
  const BASELINE_DAY = "2026-03-02";
  const SPLIT_DAY = "2026-03-17";

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CLOCK_SALDO);
    app = await getTestApp();
    const seed = await seedTestData(app, "eq70-lit", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminEmail = seed.adminUser.email;
    salonA = (await createTestSalon(app.prisma, tenantId, { name: "Salon A" })).id;
    salonB = (await createTestSalon(app.prisma, tenantId, { name: "Salon B" })).id;
    // The fixture's own employee: FIXED_SCHEDULE 40 h, Mo-Fr, hired before the month.
    employeeId = seed.employee.id;
    // A baseline day so the month is not empty: one plain 08:00-16:00 entry.
    await app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId: salonA,
        date: dateOf(BASELINE_DAY),
        startTime: at(BASELINE_DAY, "08:00"),
        endTime: at(BASELINE_DAY, "16:00"),
        breakMinutes: 0,
        breakStatus: "CONFIRMED",
        type: "WORK",
        source: "MANUAL",
      },
    });
  }, 120_000);

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("multi-entry-saldo-equality-70 literal-case cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("the day counts 420 working minutes in the summary and raises the month's Ist by exactly 420", async () => {
    vi.setSystemTime(CLOCK_SALDO);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: adminEmail, password: PASSWORD },
    });
    const admin = (JSON.parse(res.body) as { accessToken: string }).accessToken;
    const read = async (url: string) => {
      const r = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${admin}` },
      });
      expect(r.statusCode, `${url} → ${r.body}`).toBe(200);
      return JSON.parse(r.body) as { workedMinutes: number; workingMinutes: number };
    };
    const monthIst = async () =>
      (await read(`/api/v1/overtime/month-saldo/${employeeId}?year=2026&month=3`)).workedMinutes;

    const before = await monthIst();
    expect(before).toBe(480);

    for (const [from, to, salonId] of [
      ["08:00", "12:00", salonA],
      ["13:00", "16:00", salonB],
    ] as const) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId,
          salonId,
          date: dateOf(SPLIT_DAY),
          startTime: at(SPLIT_DAY, from),
          endTime: at(SPLIT_DAY, to),
          breakMinutes: 0,
          breakStatus: "CONFIRMED",
          type: "WORK",
          source: "MANUAL",
        },
      });
    }

    const day = await read(
      `/api/v1/time-entries/summary?employeeId=${employeeId}&from=${SPLIT_DAY}&to=${SPLIT_DAY}`,
    );
    expect(day.workingMinutes).toBe(420);
    expect(await monthIst()).toBe(before + 420);
  });
});
