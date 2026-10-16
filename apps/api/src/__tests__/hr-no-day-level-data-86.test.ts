/**
 * Phase 86b (Issue #86, D-02, DSGVO Art. 5 Abs. 1 lit. c) — a caller who holds `overtime:read` or
 * `month-close:read` but no `time-entry:read` reach over a person (the Personalabteilung template,
 * or any custom role shaped like it) reads that person's saldo and month-close state WITHOUT a
 * single per-day list. The decision lives in `dayDetailVisibility()`
 * (`contexts/working-time-account/api/day-detail-visibility.ts`); this file proves it against the
 * SHIPPED HR template row (never an ad-hoc role), with the admin and the person themself as
 * controls.
 *
 * Fixture dates are relative to "now" only. No person names (CLAUDE.md PII rule), synthetic
 * `@example.invalid` e-mails.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import { addDaysStr, dbDateStr, dowOf, monthStartUtc } from "./test-dates";

const PASSWORD = "test1234";

/** Clock times that appear nowhere else in a response body (UTC instants). */
const X_START = "08:13:00";
const X_END = "16:47:00";

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
  let employeeX: { id: string };
  let employeeHrM: { id: string };
  let hrToken: string;
  let hrMToken: string;

  const prevMonthStart = monthStartUtc(1);
  const prevMonthStartStr = dbDateStr(prevMonthStart);
  const prevYear = prevMonthStart.getUTCFullYear();
  const prevMonth = prevMonthStart.getUTCMonth() + 1;
  const monthQuery = `year=${prevYear}&month=${prevMonth}`;

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  async function createPerson(label: string, suffix: string, hireDate: Date) {
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
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        workDays: [1, 2, 3, 4, 5],
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
    opts: { withBreak?: boolean; start?: string; end?: string } = {},
  ) {
    const start = opts.start ?? "08:00:00";
    const end = opts.end ?? "16:00:00";
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(day),
        startTime: new Date(`${day}T${start}Z`),
        endTime: new Date(`${day}T${end}Z`),
        breakMinutes: opts.withBreak ? 30 : 0,
        source: "MANUAL",
      },
    });
    if (opts.withBreak) {
      await app.prisma.break.create({
        data: {
          timeEntryId: entry.id,
          startTime: new Date(`${day}T12:00:00Z`),
          endTime: new Date(`${day}T12:30:00Z`),
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
    // clock times (one with a Break).
    const x = await createPerson("x", suffix, hire);
    employeeX = x.employee;
    await homeOf(x.employee.id, salonA.id, hire);
    const days = firstWorkdays(prevMonthStartStr, 6);
    for (const [i, day] of days.entries()) {
      await closedEntry(x.employee.id, salonA.id, day, {
        start: X_START,
        end: X_END,
        withBreak: i === 0,
      });
    }

    // Y: another Stammsalon, so the HR + Mitarbeiter principal has a second foreign person.
    const y = await createPerson("y", suffix, hire);
    await homeOf(y.employee.id, salonB.id, hire);

    // HR-only: ONLY the shipped HR template row, TENANT scope.
    const hr = await createPerson("hr", suffix, hire);
    await assignSlot(hr.user.id, "HR");
    hrToken = await login(hr.user.email);

    // HR + Mitarbeiter: the HR row plus the system role EMPLOYEE, own closed entries last month.
    const hrM = await createPerson("hrm", suffix, hire);
    employeeHrM = hrM.employee;
    await assignSlot(hrM.user.id, "HR");
    await assignSlot(hrM.user.id, "EMPLOYEE");
    await homeOf(hrM.employee.id, salonA.id, hire);
    for (const day of firstWorkdays(prevMonthStartStr, 3)) {
      await closedEntry(hrM.employee.id, salonA.id, day);
    }
    hrMToken = await login(hrM.user.email);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

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

  async function monthSaldo(token: string, employeeId: string): Promise<MonthSaldoBody> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${employeeId}?${monthQuery}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as MonthSaldoBody;
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
});
