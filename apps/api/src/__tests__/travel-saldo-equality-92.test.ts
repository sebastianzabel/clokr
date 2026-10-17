/**
 * Issue #92 (Phase 92b-04, AC-92-2, D-02, D-07, T-92b-21) — a recorded trip between two salons
 * counts EXACTLY like an ordinary entry of the same times in the departure salon, on every figure
 * surface.
 *
 * A trip is working time (§ 2 Abs. 1 ArbZG; BAG 5 AZR 168/16, the same footing as set-up time in
 * #81): its minutes belong in the saldo, the reports and the ArbZG day sums like any other entry.
 * This file proves it behaviourally, as an A/B comparison inside ONE run — no pinned result
 * literals: two twin employees with the identical FIXED_SCHEDULE contract live in one tenant with
 * salons A and B. On every test day
 *
 *   twin S books  A 08:00-12:00 (salon A), X 12:00-12:30 (salon A, an ORDINARY entry), B 12:30-16:30 (salon B)
 *   twin M books  A 08:00-12:00 (salon A), T 12:00-12:30 (a TRAVEL entry A -> B),      B 12:30-16:30 (salon B)
 *
 * The B entry carries the same recorded break in both twins (a trip cannot hold a break, the CHECK
 * of 92b-01), except on one deliberate finding day without any break, so the equality of the ArbZG
 * warnings is not vacuous. Every row is written through the real `POST /time-entries` route (the
 * trip through the travel validator), nothing is written to a saldo table. Every surface is captured
 * twice per twin (stability); the twins' captures are then compared after the twin's own identity
 * (id, number, name, e-mail) is replaced by a placeholder:
 *
 *  - live saldo (`GET /overtime/:id`) and `GET /overtime/month-saldo/:id` of the OPEN month;
 *  - the same month after its end, still unclosed;
 *  - the monthly report (JSON and the PDF payload), the DATEV export of the employee, the dashboard;
 *  - `GET /time-entries/summary`: working, presence and break minutes and the entry count;
 *  - `checkArbZG` warning codes per test day and the day-break checks (the unchanged day kernel);
 *  - the stored Monatsabschluss (Ist, Soll, balance, carry-over) and the closed-month reads.
 *
 * The one intended difference is asserted, not excluded silently: `activityMinutes.TRAVEL` is 30 per
 * day for the travel twin and 0 for the ordinary twin, whose half hour is UNSPECIFIED instead; the
 * four values still add up to the same working minutes.
 *
 * Per-entry row lists are NOT compared: the trip carries kind TRAVEL and an arrival salon by design.
 * Sibling of `activity-kind-saldo-equality-81.test.ts` and `multi-entry-saldo-equality-70.test.ts`
 * (cited, never imported or edited); the isolation proof is `travel-saldo-isolation-92.test.ts`.
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
} from "./setup";
import { TEST_TZ } from "./test-dates";
import * as pdfUtils from "../composition/pdf";
import { checkArbZG } from "../contexts/time-tracking/arbzg";

// Wrap the REAL PDF generator so the test can read the data payload (same pattern as tests 79/81/70).
vi.mock("../composition/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composition/pdf")>();
  return {
    ...actual,
    generateMonthlyReportPdf: vi.fn(actual.generateMonthlyReportPdf),
  };
});

// March 2026 is the month under test (no statutory holiday of its own in Niedersachsen).
const CLOCK_LIVE = new Date("2026-03-26T10:00:00.000Z"); // March is open; "yesterday" is the 25th
const CLOCK_SALDO = new Date("2026-04-15T10:00:00.000Z"); // March is over and still unclosed
const CLOCK_DASHBOARD = new Date("2026-03-20T20:00:00.000Z");

/** Days with a recorded break in the B entry (a clean § 4 day: 30 min after 8 h of work). */
const CLEAN_DAYS = [
  "2026-03-02",
  "2026-03-03",
  "2026-03-04",
  "2026-03-05",
  "2026-03-06",
  "2026-03-09",
  "2026-03-10",
  "2026-03-11",
];
/** One day without any break: 8.5 h of work, both twins carry the same § 4 finding. */
const FINDING_DAY = "2026-03-12";
const TEST_DAYS = [...CLEAN_DAYS, FINDING_DAY];
const PASSWORD = "test1234";

/** Tenant-local instant for `HH:MM` on `day`, as an ISO string. */
function at(day: string, hhmm: string): string {
  return fromZonedTime(`${day}T${hhmm}:00`, TEST_TZ).toISOString();
}

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

describe("Issue #92 (AC-92-2) — a travel entry equals an ordinary entry of the same times on every figure", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminEmail: string;
  let adminToken: string;
  let salonA: string;
  let salonB: string;
  let ordinary: Twin;
  let travel: Twin;

  async function createTwin(label: string): Promise<Twin> {
    const prisma = app.prisma;
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const email = `eq92-${label}-${suffix}@test.de`;
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
        employeeNumber: `EQ92-${label}-${suffix}`.slice(0, 30),
        firstName: `Zwilling${label}`,
        lastName: `Prufling${label}`,
        hireDate,
      },
    });
    await grantSystemRole(prisma, { tenantId, userId: user.id, role: "EMPLOYEE" });
    await prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
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
        validFrom: hireDate,
      },
    });
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

  async function postEntry(
    employeeId: string,
    day: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { employeeId, date: day, ...payload },
    });
    expect(res.statusCode, `${day} ${JSON.stringify(payload)} → ${res.body}`).toBe(201);
  }

  /** The B entry: 12:30-16:30 in salon B, with a recorded 30 min break on a clean day. */
  function arrivalEntry(day: string): Record<string, unknown> {
    const base = { startTime: at(day, "12:30"), endTime: at(day, "16:30"), salonId: salonB };
    if (day === FINDING_DAY) return base;
    return {
      ...base,
      breakMinutes: 30,
      breaks: [{ startTime: at(day, "14:00"), endTime: at(day, "14:30") }],
    };
  }

  async function bookDay(twin: Twin, day: string, asTravel: boolean): Promise<void> {
    await postEntry(twin.id, day, {
      startTime: at(day, "08:00"),
      endTime: at(day, "12:00"),
      salonId: salonA,
    });
    if (!asTravel) {
      await postEntry(twin.id, day, {
        startTime: at(day, "12:00"),
        endTime: at(day, "12:30"),
        salonId: salonA,
      });
    }
    await postEntry(twin.id, day, arrivalEntry(day));
    if (asTravel) {
      // The trip last: its anchors (A directly before, B directly after) must already exist.
      await postEntry(twin.id, day, {
        startTime: at(day, "12:00"),
        endTime: at(day, "12:30"),
        salonId: salonA,
        travelToSalonId: salonB,
      });
    }
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CLOCK_SALDO);
    app = await getTestApp();
    const seed = await seedTestData(app, "eq92", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminEmail = seed.adminUser.email;
    salonA = (await createTestSalon(app.prisma, tenantId, { name: "Salon A" })).id;
    salonB = (await createTestSalon(app.prisma, tenantId, { name: "Salon B" })).id;
    await configureDatevKanzlei(app, tenantId);
    ordinary = await createTwin("s");
    travel = await createTwin("m");
    adminToken = await loginAs(app, adminEmail);
    for (const day of TEST_DAYS) {
      await bookDay(ordinary, day, false);
      await bookDay(travel, day, true);
    }
  }, 240_000);

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("travel-saldo-equality-92 cleanup failed:", err);
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

  /**
   * The PDF payload lists one row per entry — the rows differ by design (a trip row carries its
   * kind), so the row list is not compared; what the rows add up to is.
   */
  function withoutEntryRows(payload: { entries?: Array<{ netMinutes: number }> }): unknown {
    const { entries, ...rest } = payload;
    expect(Array.isArray(entries), "the PDF payload lists the entries").toBe(true);
    const netMinutes = entries!.reduce((sum, e) => sum + e.netMinutes, 0);
    return { ...rest, entryNetMinutesTotal: netMinutes };
  }

  /**
   * The day check lists the day's entries with their row ids — different rows in the two twins by
   * construction. Everything else of the check (times, salons, gaps, sums, findings) is compared.
   */
  function withoutRowIds(body: unknown): unknown {
    const check = body as { days: Array<{ entries?: Array<Record<string, unknown>> }> };
    expect(Array.isArray(check.days), "the day check lists days").toBe(true);
    return {
      ...check,
      days: check.days.map((day) => ({
        ...day,
        ...(day.entries ? { entries: day.entries.map(({ id: _id, ...entry }) => entry) } : {}),
      })),
    };
  }

  type Summary = {
    workingMinutes: number;
    presenceMinutes: number;
    breakMinutes: number;
    entryCount: number;
    activityMinutes: Record<string, number>;
  };

  async function summaryOf(token: string, twin: Twin): Promise<Summary> {
    return (await get(
      token,
      `/api/v1/time-entries/summary?employeeId=${twin.id}&from=2026-03-01&to=2026-03-31`,
    )) as Summary;
  }

  // ── Open month (CLOCK_LIVE) ───────────────────────────────────────────────────────────────
  async function captureOpenMonth(twin: Twin) {
    const admin = await adminAt(CLOCK_LIVE);
    return anonymise(
      {
        balance: await get(admin, `/api/v1/overtime/${twin.id}`),
        monthSaldo: await get(admin, `/api/v1/overtime/month-saldo/${twin.id}?year=2026&month=3`),
      },
      twin,
    ) as Record<string, unknown>;
  }

  // ── Finished, still unclosed month (CLOCK_SALDO) ──────────────────────────────────────────
  async function captureFinishedMonth(twin: Twin) {
    const admin = await adminAt(CLOCK_SALDO);
    const out: Record<string, unknown> = {
      monthSaldo: await get(admin, `/api/v1/overtime/month-saldo/${twin.id}?year=2026&month=3`),
      reportMonthly: await get(
        admin,
        `/api/v1/reports/monthly?employeeId=${twin.id}&year=2026&month=3`,
      ),
    };
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
    const { activityMinutes: _kinds, ...figures } = await summaryOf(admin, twin);
    out.summaryFigures = figures;
    // The ArbZG warnings of every test day and the unchanged day kernel's checks.
    for (const day of TEST_DAYS) {
      const warnings = await checkArbZG(app.prisma, twin.id, new Date(`${day}T00:00:00Z`));
      out[`arbzgCodes:${day}`] = warnings.map((w) => w.code).sort();
    }
    out.dayBreakChecks = withoutRowIds(
      await get(
        admin,
        `/api/v1/day-breaks/checks?employeeId=${twin.id}&from=2026-03-01&to=2026-03-31`,
      ),
    );
    return anonymise(out, twin) as Record<string, unknown>;
  }

  async function captureDashboard(twin: Twin) {
    vi.setSystemTime(CLOCK_DASHBOARD);
    const token = await loginAs(app, twin.email);
    return anonymise(
      {
        dashboard: await get(token, "/api/v1/dashboard"),
        myWeek: await get(token, "/api/v1/dashboard/my-week?date=2026-03-12"),
      },
      twin,
    ) as Record<string, unknown>;
  }

  it("fixture: the travel twin holds one trip per day, the ordinary twin none, and the day checks ran", async () => {
    const trips = await app.prisma.timeEntry.count({
      where: { employeeId: travel.id, activityKind: "TRAVEL", deletedAt: null },
    });
    expect(trips).toBe(TEST_DAYS.length);
    expect(
      await app.prisma.timeEntry.count({
        where: { employeeId: ordinary.id, activityKind: "TRAVEL", deletedAt: null },
      }),
    ).toBe(0);
    // Both twins hold three entries per day.
    for (const twin of [ordinary, travel]) {
      expect(
        await app.prisma.timeEntry.count({ where: { employeeId: twin.id, deletedAt: null } }),
      ).toBe(TEST_DAYS.length * 3);
    }
  });

  it("open month: live saldo and month saldo of the travel twin equal the ordinary twin's (stable twice)", async () => {
    const s = await captureOpenMonth(ordinary);
    const m = await captureOpenMonth(travel);
    expect(await captureOpenMonth(ordinary)).toEqual(s);
    expect(await captureOpenMonth(travel)).toEqual(m);

    // Non-vacuity: the fixture really carries working time, one worked day per test day.
    const monthSaldo = s.monthSaldo as { workedMinutes: number; workedDays?: number };
    expect(monthSaldo.workedMinutes).toBe(CLEAN_DAYS.length * 480 + 510);
    expect(monthSaldo.workedDays).toBe(TEST_DAYS.length);

    expect(Object.keys(m).sort()).toEqual(Object.keys(s).sort());
    for (const key of Object.keys(s)) {
      expect(m[key], `open-month surface ${key} differs between the twins`).toEqual(s[key]);
    }
  });

  it("finished, unclosed month: month saldo, reports, DATEV, summary figures, ArbZG codes and day checks equal", async () => {
    const s = await captureFinishedMonth(ordinary);
    const m = await captureFinishedMonth(travel);
    expect(await captureFinishedMonth(ordinary)).toEqual(s);
    expect(await captureFinishedMonth(travel)).toEqual(m);

    expect(Object.keys(m).sort()).toEqual(Object.keys(s).sort());
    for (const key of Object.keys(s)) {
      expect(m[key], `finished-month surface ${key} differs between the twins`).toEqual(s[key]);
    }

    // The surfaces really were captured (a missing key would pass above).
    for (const key of [
      "monthSaldo",
      "reportMonthly",
      "pdfPayload",
      "datevMovements",
      "summaryFigures",
    ]) {
      expect(Object.keys(s), key).toContain(key);
    }
    expect(String(s.datevMovements).length).toBeGreaterThan(0);
    const figures = s.summaryFigures as Summary;
    expect(figures.workingMinutes).toBe(CLEAN_DAYS.length * 480 + 510);
    expect(figures.entryCount).toBe(TEST_DAYS.length * 3);
    // Non-vacuity of the ArbZG comparison: the finding day carries a warning in both twins, a clean day none.
    expect(s[`arbzgCodes:${FINDING_DAY}`] as string[]).toContain("BREAK_TOO_SHORT");
    expect(s[`arbzgCodes:${CLEAN_DAYS[0]}`]).toEqual([]);
  });

  it("dashboard figures of the travel twin equal the ordinary twin's", async () => {
    const s = await captureDashboard(ordinary);
    const m = await captureDashboard(travel);
    expect(await captureDashboard(ordinary)).toEqual(s);
    expect(await captureDashboard(travel)).toEqual(m);
    expect(Object.keys(s)).toEqual(["dashboard", "myWeek"]);
    expect(m).toEqual(s);
  });

  it("the one intended difference: the half hour is TRAVEL for the travel twin and UNSPECIFIED for the ordinary one", async () => {
    const admin = await adminAt(CLOCK_SALDO);
    const s = await summaryOf(admin, ordinary);
    const m = await summaryOf(admin, travel);
    const tripMinutes = TEST_DAYS.length * 30;

    expect(s.workingMinutes).toBe(m.workingMinutes);
    expect(s.presenceMinutes).toBe(m.presenceMinutes);
    expect(s.breakMinutes).toBe(m.breakMinutes);
    expect(s.entryCount).toBe(m.entryCount);

    // Nothing is classified in this fixture, so everything but the trip is UNSPECIFIED.
    expect(s.activityMinutes).toEqual({
      PRODUCTIVE: 0,
      SETUP_CLEANING: 0,
      TRAVEL: 0,
      UNSPECIFIED: s.workingMinutes,
    });
    expect(m.activityMinutes).toEqual({
      PRODUCTIVE: 0,
      SETUP_CLEANING: 0,
      TRAVEL: tripMinutes,
      UNSPECIFIED: m.workingMinutes - tripMinutes,
    });
    expect(Object.values(m.activityMinutes).reduce((sum, v) => sum + v, 0)).toBe(m.workingMinutes);
  });

  it("Monatsabschluss: the stored snapshot (Ist, Soll, balance, carry-over) and the closed-month reads equal", async () => {
    const admin = await adminAt(CLOCK_SALDO);
    for (const twin of [ordinary, travel]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${admin}` },
        // Both twins have the same unrecorded workdays; confirming them is a shared precondition.
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
    const stored = { s: await snapshot(ordinary.id), m: await snapshot(travel.id) };
    expect(stored.s.workedMinutes).toBe(CLEAN_DAYS.length * 480 + 510);
    expect(stored.s.expectedMinutes).toBeGreaterThan(0);
    expect(stored.m).toEqual(stored.s);

    const closedReads = async (twin: Twin) => {
      const token = await adminAt(CLOCK_SALDO);
      return anonymise(
        {
          balance: await get(token, `/api/v1/overtime/${twin.id}`),
          monthSaldo: await get(token, `/api/v1/overtime/month-saldo/${twin.id}?year=2026&month=3`),
        },
        twin,
      );
    };
    const closedS = await closedReads(ordinary);
    expect(await closedReads(ordinary)).toEqual(closedS);
    expect(await closedReads(travel)).toEqual(closedS);
  });
});
