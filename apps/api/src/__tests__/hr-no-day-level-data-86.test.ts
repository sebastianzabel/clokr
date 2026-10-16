/**
 * Phase 86b (Issue #86, D-02, DSGVO Art. 5 Abs. 1 lit. c) — a caller who holds `overtime:read` or
 * `month-close:read` but no `time-entry:read` reach over a person (the Personalabteilung template,
 * or any custom role shaped like it) reads that person's saldo and month-close state WITHOUT a
 * single per-day list. The decision lives in `dayDetailVisibility()`
 * (`contexts/working-time-account/api/day-detail-visibility.ts`); this file proves it against the
 * SHIPPED HR template row (never an ad-hoc role), with the admin and the person themself as
 * controls:
 *
 * - L1: `GET /overtime/month-saldo/:employeeId` (`days`)
 * - L2: `GET /overtime/close-month/status`, `/close-month/year-status`,
 *   `/close-month/deferred?detailed=true` (day arrays, counts stay)
 * - L3: the shift preview of the 409 `ORPHAN_SHIFTS_PENDING` of `PUT /settings/work/:employeeId`
 * - AC-4: no time-tracking route answers HR with a foreign person's entry (derived from source)
 * - a day-level detector over every other read the Personalabteilung reaches
 *
 * Fixture dates are relative to "now" only. No person names (CLAUDE.md PII rule), synthetic
 * `@example.invalid` e-mails.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import { deriveMatrixRoutes } from "./neutrality/route-derivation";
import {
  addDaysStr,
  dbDateStr,
  dowOf,
  futureDateStr,
  monthFirstAheadStr,
  monthStartUtc,
  todayStr,
} from "./test-dates";

const PASSWORD = "test1234";

/** Clock times that appear nowhere else in a response body (UTC instants, zero seconds). */
const X_START = "08:13:00";
const X_END = "16:47:00";
/** A planned shift time that appears nowhere else in a response body. */
const SHIFT_START = "09:17";

/** The first `count` Monday-to-Friday days of the month starting at `monthStart` (YYYY-MM-DD). */
function firstWorkdays(monthStart: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count && i < 28; i++) {
    const day = addDaysStr(monthStart, i);
    const dow = dowOf(day);
    if (dow >= 1 && dow <= 5) out.push(day);
  }
  return out;
}

describe("Issue #86 (Phase 86b), D-02 — day lists only within time-entry:read reach", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let personX: Awaited<ReturnType<typeof createPerson>>;
  let personX2: Awaited<ReturnType<typeof createPerson>>;
  let personHr: Awaited<ReturnType<typeof createPerson>>;
  let personHrM: Awaited<ReturnType<typeof createPerson>>;
  let employeeX: { id: string; employeeNumber: string };
  let employeeHrM: { id: string };
  let hrToken: string;
  let hrMToken: string;
  /** Ids of X's rows the AC-4 sweep targets. */
  let xEntryId: string;
  let xOpenEntryId: string;
  let xDayBreakId: string;
  let xAckId: string;
  let xRetroId: string;
  /** A workday of the previous month on which X has no entry. */
  let xFreeDay: string;
  let prevWindow: { from: string; to: string };

  const prevMonthStart = monthStartUtc(1);
  const prevMonthStartStr = dbDateStr(prevMonthStart);
  const prevYear = prevMonthStart.getUTCFullYear();
  const prevMonth = prevMonthStart.getUTCMonth() + 1;
  const monthQuery = `year=${prevYear}&month=${prevMonth}`;
  const thisYear = Number(todayStr().slice(0, 4));
  /** X is hired on 1 January two years ago: January of last year is overdue, unclosed and gappy. */
  const xHire = new Date(`${thisYear - 2}-01-01T00:00:00Z`);
  /** The year whose first month year-status lists with missing days. */
  const olderYear = thisYear - 1;

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  async function createPerson(
    label: string,
    suffix: string,
    hireDate: Date,
    schedule: { type: "FIXED_SCHEDULE" | "SHIFT_BASED" } = { type: "FIXED_SCHEDULE" },
  ) {
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@example.invalid`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `${label}${suffix}`.toUpperCase().slice(0, 20),
        firstName: "Fixture",
        lastName: `Hr86${label}`,
        hireDate,
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: schedule.type,
        weeklyHours: 40,
        workDays: [1, 2, 3, 4, 5],
        ...(schedule.type === "SHIFT_BASED"
          ? { contractWorkDaysPerWeek: 5, usualWorkDays: [1, 2, 3, 4, 5] }
          : {}),
        validFrom: hireDate,
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: 0 },
    });
    return { user, employee };
  }

  async function assignSlot(userId: string, slot: keyof typeof SYSTEM_ROLE_IDS) {
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId,
        accessRoleId: SYSTEM_ROLE_IDS[slot],
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
  }

  async function homeOf(employeeId: string, salonId: string, validFrom: Date) {
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom,
        validUntil: null,
        weekdays: [],
      },
    });
  }

  async function closedEntry(
    employeeId: string,
    salonId: string,
    day: string,
    opts: {
      breakFrom?: string;
      breakTo?: string;
      start?: string;
      end?: string;
    } = {},
  ) {
    const start = opts.start ?? "08:00:00";
    const end = opts.end ?? "16:00:00";
    const hasBreak = opts.breakFrom !== undefined && opts.breakTo !== undefined;
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(day),
        startTime: new Date(`${day}T${start}Z`),
        endTime: new Date(`${day}T${end}Z`),
        breakMinutes: hasBreak ? 30 : 0,
        source: "MANUAL",
      },
    });
    if (hasBreak) {
      await app.prisma.break.create({
        data: {
          timeEntryId: entry.id,
          startTime: new Date(`${day}T${opts.breakFrom}Z`),
          endTime: new Date(`${day}T${opts.breakTo}Z`),
        },
      });
    }
    return entry;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "hrnd86");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "HRND Salon A" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "HRND Salon B" });
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const hire = monthStartUtc(4);

    // X: Stammsalon A, closed WORK entries on some workdays of the previous month at unusual
    // clock times (one with a Break), one more day whose only Break touches the first start
    // (an unacknowledged § 4 Satz 2/3 finding), and workdays without an entry.
    personX = await createPerson("x", suffix, xHire);
    employeeX = personX.employee;
    await homeOf(employeeX.id, salonA.id, xHire);
    const days = firstWorkdays(prevMonthStartStr, 10);
    const firstEntry = await closedEntry(employeeX.id, salonA.id, days[0], {
      start: X_START,
      end: X_END,
      breakFrom: "12:00:00",
      breakTo: "12:30:00",
    });
    xEntryId = firstEntry.id;
    for (const day of days.slice(1, 6)) {
      await closedEntry(employeeX.id, salonA.id, day, { start: X_START, end: X_END });
    }
    await closedEntry(employeeX.id, salonA.id, days[6], {
      start: X_START,
      end: X_END,
      breakFrom: X_START,
      breakTo: "08:43:00",
    });
    // An OPEN entry of X, so the clock-out probe reaches the ownership check instead of "not open".
    const openEntry = await app.prisma.timeEntry.create({
      data: {
        employeeId: employeeX.id,
        salonId: salonA.id,
        date: new Date(days[8]),
        startTime: new Date(`${days[8]}T${X_START}Z`),
        endTime: null,
        source: "MANUAL",
      },
    });
    xOpenEntryId = openEntry.id;
    xFreeDay = days[9];
    prevWindow = { from: prevMonthStartStr, to: addDaysStr(prevMonthStartStr, 27) };

    // Rows of X the sweep targets by id.
    xDayBreakId = (
      await app.prisma.dayBreak.create({
        data: {
          employeeId: employeeX.id,
          date: new Date(days[1]),
          startTime: new Date(`${days[1]}T10:00:00Z`),
          endTime: new Date(`${days[1]}T10:20:00Z`),
          createdBy: data.adminUser.id,
        },
      })
    ).id;
    xAckId = (
      await app.prisma.dayBreakAck.create({
        data: {
          employeeId: employeeX.id,
          date: new Date(days[2]),
          reason: "Fixture acknowledgement",
          snapshot: {},
          acknowledgedBy: data.adminUser.id,
        },
      })
    ).id;
    xRetroId = (
      await app.prisma.retroEntryRequest.create({
        data: {
          employeeId: employeeX.id,
          targetDate: new Date(xFreeDay),
          reason: "Fixture retro request",
          startTime: "08:00",
          endTime: "16:00",
        },
      })
    ).id;

    // X2: SHIFT_BASED, two future shifts in salon A (the orphan-shift preview of L3).
    personX2 = await createPerson("x2", suffix, xHire, { type: "SHIFT_BASED" });
    await homeOf(personX2.employee.id, salonA.id, xHire);
    for (const day of [futureDateStr(3), futureDateStr(4)]) {
      await app.prisma.shift.create({
        data: {
          employeeId: personX2.employee.id,
          salonId: salonA.id,
          date: new Date(day),
          startTime: SHIFT_START,
          endTime: "17:00",
        },
      });
    }

    // Y: another Stammsalon.
    const y = await createPerson("y", suffix, hire);
    await homeOf(y.employee.id, salonB.id, hire);

    // HR-only: ONLY the shipped HR template row, TENANT scope.
    personHr = await createPerson("hr", suffix, hire);
    await assignSlot(personHr.user.id, "HR");
    hrToken = await login(personHr.user.email);

    // HR + Mitarbeiter: the HR row plus the system role EMPLOYEE, own closed entries last month.
    personHrM = await createPerson("hrm", suffix, hire);
    employeeHrM = personHrM.employee;
    await assignSlot(personHrM.user.id, "HR");
    await assignSlot(personHrM.user.id, "EMPLOYEE");
    await homeOf(employeeHrM.id, salonA.id, hire);
    for (const day of firstWorkdays(prevMonthStartStr, 3)) {
      await closedEntry(employeeHrM.id, salonA.id, day);
    }
    hrMToken = await login(personHrM.user.email);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function get(token: string, url: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function getJson<T>(token: string, url: string): Promise<T> {
    const res = await get(token, url);
    expect(res.statusCode, `${url}: ${res.body.slice(0, 200)}`).toBe(200);
    return JSON.parse(res.body) as T;
  }

  // ── L1 ──────────────────────────────────────────────────────────────────────────────────────

  type MonthSaldoBody = {
    days: { date: string; cumulativeSaldoMinutes: number }[];
    dayDetailsWithheld: boolean;
    [key: string]: unknown;
  };

  /** The body minus the two fields the redaction is allowed to change. */
  function withoutDayFields(body: MonthSaldoBody): Record<string, unknown> {
    const rest: Record<string, unknown> = { ...body };
    delete rest.days;
    delete rest.dayDetailsWithheld;
    return rest;
  }

  function monthSaldo(token: string, employeeId: string): Promise<MonthSaldoBody> {
    return getJson<MonthSaldoBody>(token, `/overtime/month-saldo/${employeeId}?${monthQuery}`);
  }

  describe("L1 — GET /overtime/month-saldo/:employeeId", () => {
    it("admin control: the day series is present and not withheld", async () => {
      const body = await monthSaldo(data.adminToken, employeeX.id);
      expect(body.days.length).toBeGreaterThan(0);
      expect(body.dayDetailsWithheld).toBe(false);
    });

    it("HR-only: days is [] and withheld, every other field equals the admin's", async () => {
      const admin = await monthSaldo(data.adminToken, employeeX.id);
      const hr = await monthSaldo(hrToken, employeeX.id);
      expect(hr.days).toEqual([]);
      expect(hr.dayDetailsWithheld).toBe(true);
      const adminRest = withoutDayFields(admin);
      const hrRest = withoutDayFields(hr);
      expect(hrRest).toEqual(adminRest);
      expect(Object.keys(hrRest).sort()).toEqual(Object.keys(adminRest).sort());
    });

    it("HR + Mitarbeiter: own employee keeps the day series, X's is withheld", async () => {
      const own = await monthSaldo(hrMToken, employeeHrM.id);
      expect(own.days.length).toBeGreaterThan(0);
      expect(own.dayDetailsWithheld).toBe(false);

      const foreign = await monthSaldo(hrMToken, employeeX.id);
      expect(foreign.days).toEqual([]);
      expect(foreign.dayDetailsWithheld).toBe(true);
    });
  });

  // ── L2 ──────────────────────────────────────────────────────────────────────────────────────

  type StatusRow = {
    employeeId: string;
    status: string;
    missingDates?: string[];
    unconfirmedBreakDays?: string[];
    breakFindingDays?: string[];
    karenzOverrunDays?: string[];
    missingDateCount: number;
    unconfirmedBreakDayCount: number;
    breakFindingDayCount: number;
    karenzOverrunDayCount: number;
    dayDetailsWithheld: boolean;
  };
  type StatusBody = { year: number; month: number; employees: StatusRow[] };

  const STATUS_ARRAYS = [
    ["missingDates", "missingDateCount"],
    ["unconfirmedBreakDays", "unconfirmedBreakDayCount"],
    ["breakFindingDays", "breakFindingDayCount"],
    ["karenzOverrunDays", "karenzOverrunDayCount"],
  ] as const;

  describe("L2 — GET /overtime/close-month/status", () => {
    it("admin: counts equal the lengths of the day arrays, nothing withheld", async () => {
      const admin = await getJson<StatusBody>(
        data.adminToken,
        `/overtime/close-month/status?${monthQuery}`,
      );
      const rowX = admin.employees.find((r) => r.employeeId === employeeX.id);
      expect(rowX).toBeDefined();
      expect(rowX?.status).toBe("missing");
      expect(rowX?.missingDates?.length).toBeGreaterThan(0);
      for (const row of admin.employees) {
        expect(row.dayDetailsWithheld).toBe(false);
        for (const [arr, count] of STATUS_ARRAYS) {
          expect(row[count], `${arr} of ${row.employeeId}`).toBe((row[arr] ?? []).length);
        }
      }
    });

    it("the fixture produces an unacknowledged break finding day for X (non-vacuity)", async () => {
      const admin = await getJson<StatusBody>(
        data.adminToken,
        `/overtime/close-month/status?${monthQuery}`,
      );
      const rowX = admin.employees.find((r) => r.employeeId === employeeX.id);
      expect(rowX?.breakFindingDays?.length ?? 0).toBeGreaterThan(0);
    });

    it("HR-only: same status and counts as the admin, every day array empty", async () => {
      const admin = await getJson<StatusBody>(
        data.adminToken,
        `/overtime/close-month/status?${monthQuery}`,
      );
      const hr = await getJson<StatusBody>(hrToken, `/overtime/close-month/status?${monthQuery}`);
      expect(hr.employees.map((r) => r.employeeId)).toEqual(
        admin.employees.map((r) => r.employeeId),
      );
      for (const adminRow of admin.employees) {
        const hrRow = hr.employees.find((r) => r.employeeId === adminRow.employeeId);
        expect(hrRow?.status).toBe(adminRow.status);
        expect(hrRow?.dayDetailsWithheld).toBe(true);
        for (const [arr, count] of STATUS_ARRAYS) {
          expect(hrRow?.[arr] ?? []).toEqual([]);
          expect(hrRow?.[count], `${count} of ${adminRow.employeeId}`).toBe(
            (adminRow[arr] ?? []).length,
          );
        }
      }
    });

    it("HR + Mitarbeiter: the own row keeps its arrays, X's row is redacted", async () => {
      const admin = await getJson<StatusBody>(
        data.adminToken,
        `/overtime/close-month/status?${monthQuery}`,
      );
      const hrM = await getJson<StatusBody>(hrMToken, `/overtime/close-month/status?${monthQuery}`);
      const adminOwn = admin.employees.find((r) => r.employeeId === employeeHrM.id);
      const hrMOwn = hrM.employees.find((r) => r.employeeId === employeeHrM.id);
      expect(hrMOwn?.dayDetailsWithheld).toBe(false);
      expect(hrMOwn?.missingDates).toEqual(adminOwn?.missingDates);
      const hrMX = hrM.employees.find((r) => r.employeeId === employeeX.id);
      expect(hrMX?.dayDetailsWithheld).toBe(true);
      expect(hrMX?.missingDates ?? []).toEqual([]);
    });
  });

  type YearStatusBody = {
    year: number;
    months: {
      month: number;
      status: string;
      missing?: {
        employeeName: string;
        employeeNumber: string;
        missingDates: string[];
        missingDateCount: number;
        dayDetailsWithheld: boolean;
      }[];
    }[];
  };

  describe("L2 — GET /overtime/close-month/year-status", () => {
    it("admin lists X's missing days; HR gets the same month entry with an empty list and the count", async () => {
      const admin = await getJson<YearStatusBody>(
        data.adminToken,
        `/overtime/close-month/year-status?year=${olderYear}`,
      );
      const hr = await getJson<YearStatusBody>(
        hrToken,
        `/overtime/close-month/year-status?year=${olderYear}`,
      );
      const adminMonth = admin.months.find((m) => m.missing !== undefined);
      expect(adminMonth, "a month with missing days (non-vacuity)").toBeDefined();
      const adminX = adminMonth?.missing?.find(
        (e) => e.employeeNumber === employeeX.employeeNumber,
      );
      expect(adminX?.missingDates.length).toBeGreaterThan(0);
      expect(adminX?.missingDateCount).toBe(adminX?.missingDates.length);
      expect(adminX?.dayDetailsWithheld).toBe(false);

      const hrMonth = hr.months.find((m) => m.month === adminMonth?.month);
      expect(hrMonth?.status).toBe(adminMonth?.status);
      expect(hrMonth?.missing?.length).toBe(adminMonth?.missing?.length);
      for (const adminEntry of adminMonth?.missing ?? []) {
        const hrEntry = hrMonth?.missing?.find(
          (e) => e.employeeNumber === adminEntry.employeeNumber,
        );
        expect(hrEntry?.missingDates).toEqual([]);
        expect(hrEntry?.dayDetailsWithheld).toBe(true);
        expect(hrEntry?.missingDateCount).toBe(adminEntry.missingDates.length);
      }
    });
  });

  type DeferredBody = {
    gapCount: number;
    employeeCount: number;
    employees: {
      employeeId: string;
      gapDates: string[];
      gapCount: number;
      dayDetailsWithheld: boolean;
    }[];
  } & Record<string, unknown>;

  describe("L2 — GET /overtime/close-month/deferred?detailed=true", () => {
    it("HR: gapDates empty, gapCount equal to the admin's and above zero", async () => {
      const admin = await getJson<DeferredBody>(
        data.adminToken,
        "/overtime/close-month/deferred?detailed=true",
      );
      const hr = await getJson<DeferredBody>(
        hrToken,
        "/overtime/close-month/deferred?detailed=true",
      );
      const adminX = admin.employees.find((e) => e.employeeId === employeeX.id);
      expect(adminX?.gapDates.length).toBeGreaterThan(0);
      expect(adminX?.dayDetailsWithheld).toBe(false);
      const hrX = hr.employees.find((e) => e.employeeId === employeeX.id);
      expect(hrX?.gapDates).toEqual([]);
      expect(hrX?.dayDetailsWithheld).toBe(true);
      expect(hrX?.gapCount).toBe(adminX?.gapCount);
      expect(hrX?.gapCount).toBeGreaterThan(0);
      expect(hr.gapCount).toBe(admin.gapCount);
      expect(hr.employeeCount).toBe(admin.employeeCount);
      for (const adminEmp of admin.employees) {
        const hrEmp = hr.employees.find((e) => e.employeeId === adminEmp.employeeId);
        expect(hrEmp?.gapDates).toEqual([]);
        expect(hrEmp?.gapCount).toBe(adminEmp.gapCount);
      }
    });
  });

  // ── L3 ──────────────────────────────────────────────────────────────────────────────────────

  describe("L3 — the orphan-shift preview of PUT /settings/work/:employeeId", () => {
    function toFixed(token: string) {
      return app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${personX2.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "FIXED_SCHEDULE", weeklyHours: 40, validFrom: monthFirstAheadStr(1) },
      });
    }

    it("HR: 409 keeps pendingShifts, the preview is empty and carries no planned time; nothing is written", async () => {
      const schedulesBefore = await app.prisma.workSchedule.count({
        where: { employeeId: personX2.employee.id },
      });
      const shiftsBefore = await app.prisma.shift.count({
        where: { employeeId: personX2.employee.id },
      });

      const admin = await toFixed(data.adminToken);
      expect(admin.statusCode).toBe(409);
      const adminBody = JSON.parse(admin.body);
      expect(adminBody.code).toBe("ORPHAN_SHIFTS_PENDING");
      expect(adminBody.pendingShifts).toBe(2);
      expect(adminBody.shiftPreview).toHaveLength(2);

      const hr = await toFixed(hrToken);
      expect(hr.statusCode).toBe(409);
      const hrBody = JSON.parse(hr.body);
      expect(hrBody.code).toBe("ORPHAN_SHIFTS_PENDING");
      expect(hrBody.pendingShifts).toBe(2);
      expect(hrBody.shiftPreview).toEqual([]);
      expect(hr.body).not.toContain(SHIFT_START);

      expect(
        await app.prisma.workSchedule.count({ where: { employeeId: personX2.employee.id } }),
      ).toBe(schedulesBefore);
      expect(await app.prisma.shift.count({ where: { employeeId: personX2.employee.id } })).toBe(
        shiftsBefore,
      );
    });

    it("L4: lastLoginAt stays readable for HR (no working-time data)", async () => {
      const res = await get(hrToken, "/employees");
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('"lastLoginAt"');
    });
  });

  // ── AC-4 ────────────────────────────────────────────────────────────────────────────────────

  type Probe = {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    payload?: unknown;
  };
  const REASON = "Fixture reason for the sweep";

  /** One probe per derived route, aimed at X's ids. Built lazily — ids exist only after setup. */
  function probes(): Record<string, Probe> {
    const range = `from=${prevWindow.from}&to=${prevWindow.to}`;
    const day0 = firstWorkdays(prevMonthStartStr, 1)[0];
    return {
      "DELETE /api/v1/day-breaks/:id": {
        method: "DELETE",
        url: `/api/v1/day-breaks/${xDayBreakId}`,
        payload: { reason: REASON },
      },
      "DELETE /api/v1/day-breaks/acks/:id": {
        method: "DELETE",
        url: `/api/v1/day-breaks/acks/${xAckId}`,
        payload: { reason: REASON },
      },
      "DELETE /api/v1/retro-entry-requests/:id": {
        method: "DELETE",
        url: `/api/v1/retro-entry-requests/${xRetroId}`,
      },
      "DELETE /api/v1/time-entries/:id": {
        method: "DELETE",
        url: `/api/v1/time-entries/${xEntryId}`,
        payload: { reason: REASON },
      },
      "GET /api/v1/day-breaks/checks": {
        method: "GET",
        url: `/api/v1/day-breaks/checks?employeeId=${employeeX.id}&${range}`,
      },
      "GET /api/v1/retro-entry-requests": { method: "GET", url: "/api/v1/retro-entry-requests" },
      "GET /api/v1/time-entries": {
        method: "GET",
        url: `/api/v1/time-entries?employeeId=${employeeX.id}&${range}`,
      },
      "GET /api/v1/time-entries/clock-salon": {
        method: "GET",
        url: "/api/v1/time-entries/clock-salon",
      },
      "GET /api/v1/time-entries/summary": {
        method: "GET",
        url: `/api/v1/time-entries/summary?employeeId=${employeeX.id}&${range}`,
      },
      "PATCH /api/v1/retro-entry-requests/:id/review": {
        method: "PATCH",
        url: `/api/v1/retro-entry-requests/${xRetroId}/review`,
        payload: { status: "APPROVED" },
      },
      "PATCH /api/v1/time-entries/:id/break-status": {
        method: "PATCH",
        url: `/api/v1/time-entries/${xEntryId}/break-status`,
        payload: { action: "confirm" },
      },
      "PATCH /api/v1/time-entries/:id/revalidate": {
        method: "PATCH",
        url: `/api/v1/time-entries/${xEntryId}/revalidate`,
        payload: {},
      },
      "POST /api/v1/day-breaks": {
        method: "POST",
        url: "/api/v1/day-breaks",
        payload: {
          employeeId: employeeX.id,
          date: day0,
          startTime: `${day0}T10:00:00.000Z`,
          endTime: `${day0}T10:20:00.000Z`,
        },
      },
      "POST /api/v1/day-breaks/acks": {
        method: "POST",
        url: "/api/v1/day-breaks/acks",
        payload: { employeeId: employeeX.id, date: day0, reason: REASON },
      },
      "POST /api/v1/day-breaks/preview": {
        method: "POST",
        url: "/api/v1/day-breaks/preview",
        payload: {
          employeeId: employeeX.id,
          date: day0,
          entryId: xEntryId,
          startTime: `${day0}T08:00:00.000Z`,
          endTime: `${day0}T16:00:00.000Z`,
          breaks: [],
        },
      },
      "POST /api/v1/retro-entry-requests": {
        method: "POST",
        url: "/api/v1/retro-entry-requests",
        payload: {
          employeeId: employeeX.id,
          targetDate: xFreeDay,
          reason: REASON,
          startTime: "08:00",
          endTime: "16:00",
        },
      },
      "POST /api/v1/time-entries": {
        method: "POST",
        url: "/api/v1/time-entries",
        payload: {
          employeeId: employeeX.id,
          date: xFreeDay,
          startTime: `${xFreeDay}T08:00:00.000Z`,
          endTime: `${xFreeDay}T16:00:00.000Z`,
        },
      },
      "POST /api/v1/time-entries/:id/breaks": {
        method: "POST",
        url: `/api/v1/time-entries/${xEntryId}/breaks`,
        payload: {
          startTime: `${day0}T13:00:00.000Z`,
          endTime: `${day0}T13:15:00.000Z`,
        },
      },
      "POST /api/v1/time-entries/:id/clock-out": {
        method: "POST",
        url: `/api/v1/time-entries/${xOpenEntryId}/clock-out`,
        payload: {},
      },
      "POST /api/v1/time-entries/clock-in": {
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        payload: { employeeId: employeeX.id },
      },
      "POST /api/v1/time-entries/nfc-punch": {
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        payload: { nfcCardId: "fixture-card" },
      },
      "PUT /api/v1/time-entries/:id": {
        method: "PUT",
        url: `/api/v1/time-entries/${xEntryId}`,
        payload: { note: "fixture" },
      },
    };
  }

  /**
   * Routes whose answer may be neither 403 nor 404, each with the measured reason and a check of
   * the answer. None of them can name X: either the route has no person parameter, or it ignores
   * the parameter for a caller without the ZUGEWIESEN reach and acts for the caller's own person.
   */
  const ALLOWED: Record<
    string,
    {
      reason: string;
      check: (res: { statusCode: number; body: string }, ownId: string) => string[];
    }
  > = {
    "GET /api/v1/time-entries/clock-salon": {
      reason: "own clock only: no person parameter, the answer concerns the caller's own clock-in",
      check: () => [],
    },
    "POST /api/v1/time-entries/nfc-punch": {
      reason: "terminal-authenticated by a device key: a user token is no device key, answered 401",
      check: (res) => (res.statusCode === 401 ? [] : [`expected 401, got ${res.statusCode}`]),
    },
    "POST /api/v1/retro-entry-requests": {
      reason:
        "a caller without retro-request:create:ZUGEWIESEN silently submits for their own person " +
        "and the employeeId of the body is ignored (#75 D-13); the created row is the caller's own",
      check: (res, ownId) => {
        if (res.statusCode !== 201)
          return [`expected 201 for the own person, got ${res.statusCode}`];
        const created = JSON.parse(res.body) as { employeeId?: string };
        return created.employeeId === ownId
          ? []
          : [`created for ${created.employeeId}, not the caller`];
      },
    },
  };

  const SWEPT_PREFIXES = [
    "/api/v1/time-entries",
    "/api/v1/day-breaks",
    "/api/v1/retro-entry-requests",
  ];
  const sweptRoutes = () =>
    deriveMatrixRoutes().filter((r) => SWEPT_PREFIXES.some((p) => r.split(" ")[1].startsWith(p)));

  describe("AC-4 — no time-tracking route answers HR with a foreign person's entry", () => {
    it("the probe map equals the derived route set, both directions", () => {
      const derived = sweptRoutes();
      expect(derived.length).toBeGreaterThan(0);
      const mapped = Object.keys(probes());
      expect(mapped.filter((r) => !derived.includes(r))).toEqual([]);
      expect(derived.filter((r) => !mapped.includes(r))).toEqual([]);
      expect(Object.keys(ALLOWED).filter((r) => !derived.includes(r))).toEqual([]);
    });

    it("admin control: sees X's entry and a positive working-time sum", async () => {
      const list = await get(
        data.adminToken,
        `/time-entries?employeeId=${employeeX.id}&from=${prevWindow.from}&to=${prevWindow.to}`,
      );
      expect(list.statusCode).toBe(200);
      expect(list.body).toContain(xEntryId);
      const summary = await getJson<{ workingMinutes: number }>(
        data.adminToken,
        `/time-entries/summary?employeeId=${employeeX.id}&from=${prevWindow.from}&to=${prevWindow.to}`,
      );
      expect(summary.workingMinutes).toBeGreaterThan(0);
    });

    it("HR-only and HR + Mitarbeiter get 403/404 (or an allowed reason) on every route, see nothing of X, write nothing of X", async () => {
      const snapshot = async () => ({
        entries: await app.prisma.timeEntry.findMany({
          where: { employeeId: employeeX.id },
          select: { id: true, updatedAt: true, deletedAt: true, isLocked: true },
          orderBy: { id: "asc" },
        }),
        breaks: await app.prisma.break.count({
          where: { timeEntry: { employeeId: employeeX.id } },
        }),
        dayBreaks: await app.prisma.dayBreak.findMany({
          where: { employeeId: employeeX.id },
          select: { id: true, deletedAt: true },
          orderBy: { id: "asc" },
        }),
        acks: await app.prisma.dayBreakAck.findMany({
          where: { employeeId: employeeX.id },
          select: { id: true, deletedAt: true },
          orderBy: { id: "asc" },
        }),
        retro: await app.prisma.retroEntryRequest.findMany({
          where: { employeeId: employeeX.id },
          select: { id: true, status: true, deletedAt: true, updatedAt: true },
          orderBy: { id: "asc" },
        }),
      });
      const before = await snapshot();
      const table: string[] = [];
      const violations: string[] = [];

      for (const [route, probe] of Object.entries(probes())) {
        for (const [actor, token, ownId] of [
          ["HR-only", hrToken, personHr.employee.id],
          ["HR+M", hrMToken, employeeHrM.id],
        ] as const) {
          const res = await app.inject({
            method: probe.method,
            url: probe.url,
            headers: { authorization: `Bearer ${token}` },
            ...(probe.payload !== undefined ? { payload: probe.payload as object } : {}),
          });
          table.push(`${actor} | ${route} | ${res.statusCode}`);
          const label = `${actor} ${route} (${res.statusCode})`;
          const refused = res.statusCode === 403 || res.statusCode === 404;
          const allowed = ALLOWED[route];
          if (!refused) {
            if (!allowed)
              violations.push(`${label}: neither refused nor allowed: ${res.body.slice(0, 160)}`);
            else if (res.statusCode !== 401 || route !== "POST /api/v1/time-entries/nfc-punch") {
              // 401 is the terminal route's own answer; every other allowed answer is checked.
              violations.push(...allowed.check(res, ownId).map((m) => `${label}: ${m}`));
            }
          }
          if (res.statusCode === 400) violations.push(`${label}: the probe body is not valid`);
          for (const secret of [xEntryId, xOpenEntryId, X_START, X_END]) {
            if (res.body.includes(secret)) violations.push(`${label}: body contains ${secret}`);
          }
        }
      }
      console.warn(`AC-4 sweep (${table.length} probes):\n${table.join("\n")}`);
      expect(violations).toEqual([]);

      expect(await snapshot()).toEqual(before);
      const xRowIds = [
        ...before.entries.map((e) => e.id),
        ...before.dayBreaks.map((d) => d.id),
        ...before.acks.map((a) => a.id),
        ...before.retro.map((r) => r.id),
      ];
      const writes = await app.prisma.auditLog.findMany({
        where: {
          userId: { in: [personHr.user.id, personHrM.user.id] },
          entityId: { in: xRowIds },
          action: { in: ["CREATE", "UPDATE", "DELETE"] },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect(writes).toEqual([]);
    });
  });

  // ── detector sweep ──────────────────────────────────────────────────────────────────────────

  /** Reads of the Personalabteilung that carry per-day structures by design and are not swept. */
  const EXCLUDED_READS: Record<string, string> = {
    "leave requests, leave calendar":
      "Abwesenheiten, keine Tageszeiten; vom Template seit 76b gelesen",
    "Berufsschule absences": "Abwesenheiten, keine Tageszeiten; vom Template seit 76b gelesen",
  };

  /** Keys whose clock-time strings are master data, not attendance (opening hours of a salon). */
  const MASTER_DATA_KEYS = new Set(["openingHours"]);

  describe("detector sweep — no other read of the Personalabteilung carries a day-level structure", () => {
    it("the detector finds the day series the redaction removes (positive control)", async () => {
      const admin = await monthSaldo(data.adminToken, employeeX.id);
      expect(findDayLevelStructures(admin).length).toBeGreaterThan(0);
      expect(findDayLevelStructures(await monthSaldo(hrToken, employeeX.id))).toEqual([]);
    });

    it("names its exclusions with a reason", () => {
      expect(Object.keys(EXCLUDED_READS).length).toBeGreaterThan(0);
      for (const reason of Object.values(EXCLUDED_READS)) expect(reason.length).toBeGreaterThan(10);
    });

    it("HR responses of the account, master-data and dashboard reads are day-free", async () => {
      const urls = [
        "/employees",
        `/employees/${employeeX.id}`,
        `/settings/work/${employeeX.id}`,
        `/settings/work/${employeeX.id}/history`,
        `/settings/vacation/${employeeX.id}?year=${thisYear}`,
        `/overtime/${employeeX.id}`,
        `/overtime/snapshots/${employeeX.id}`,
        `/overtime/month-saldo/${employeeX.id}?${monthQuery}`,
        `/overtime/close-month/status?${monthQuery}`,
        `/overtime/close-month/year-status?year=${olderYear}`,
        "/overtime/close-month/deferred?detailed=true",
        "/dashboard",
        "/dashboard/overtime-trend",
        `/employees/${employeeX.id}/salon-assignments`,
        "/salons",
      ];
      for (const url of urls) {
        const body = await getJson<unknown>(hrToken, url);
        expect(findDayLevelStructures(body, "$", MASTER_DATA_KEYS), url).toEqual([]);
      }
    });
  });
});

// ── the day-level detector (a local copy of reports-hr-86's; the two files stay independent) ──

const DAY_LEVEL_KEYS = new Set([
  "days",
  "entries",
  "breaks",
  "startTime",
  "endTime",
  "clockIn",
  "clockOut",
  "missingDates",
  "gapDates",
  "unconfirmedBreakDays",
  "breakFindingDays",
  "karenzOverrunDays",
]);
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_TIME = /^\d{1,2}:\d{2}(:\d{2})?$/;

/**
 * Reports every per-day structure of a JSON body: an array whose elements are calendar-day strings
 * or objects carrying a `date` key, a string shaped like a clock time `HH:MM`, and any key named
 * like a day list or a clock/break field. Keys in `masterDataKeys` are skipped with their subtree
 * (master data such as the opening hours of a salon, not attendance). A day-list key that holds an
 * EMPTY array is the redaction itself and a number is a count (both kept by the redaction); neither is a finding. Empty result = day-free.
 */
function findDayLevelStructures(
  value: unknown,
  path = "$",
  masterDataKeys: ReadonlySet<string> = new Set(),
): string[] {
  const findings: string[] = [];
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((el) => typeof el === "string" && CALENDAR_DAY.test(el))) {
      findings.push(`${path}: array of calendar days`);
    }
    value.forEach((el, i) => {
      if (el !== null && typeof el === "object" && !Array.isArray(el) && "date" in el) {
        findings.push(`${path}[${i}]: element carries a date key`);
      }
      findings.push(...findDayLevelStructures(el, `${path}[${i}]`, masterDataKeys));
    });
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (masterDataKeys.has(k)) continue;
      // A day-list key holding a count (`today.entries: 3`) or an empty list is no structure.
      const structured = Array.isArray(v) ? v.length > 0 : v !== null && typeof v === "object";
      if (DAY_LEVEL_KEYS.has(k) && structured) findings.push(`${path}.${k}: day-level key "${k}"`);
      findings.push(...findDayLevelStructures(v, `${path}.${k}`, masterDataKeys));
    }
  } else if (typeof value === "string" && CLOCK_TIME.test(value)) {
    findings.push(`${path}: clock time "${value}"`);
  }
  return findings;
}
