/**
 * Issue #85 (D-04/D-05) — the dashboard's week grid (`GET /api/v1/dashboard/team-week`) follows
 * the per-entry rule for scoped callers. The entry decides: the population is the Stammsalon
 * persons (Stichtag = week end, as before) PLUS every active person with at least one IN-SCOPE
 * entry in the week; hours of every row come only from in-scope entries; planning data (leave,
 * absence, shift, holiday, contract) is read only for Stammsalon persons, so a Springer who is
 * listed by an entry carries no workday, no expected hours and no employee number, and a day
 * without an in-scope entry is "none", never "missing" or "absent". A day with valid time outside
 * the reach is a neutral `workedElsewhere`, never an hour and never a live clock-in.
 *
 * Amendment of Phase 84: `dashboard-salon-manipulation-84.test.ts` asserted that a Springer homed
 * in B with an entry in A is NOT listed for the Salonmanager of A (Phase 84 left this until #85).
 * That assertion is reversed on purpose there and recorded in that file's header.
 *
 * Whole-tenant callers run the unchanged statements: the control cases here and the frozen 84
 * pins prove the response stays byte-identical (no `workedElsewhere` key without a salon filter).
 *
 * Amendment (Issue #548, 2026-10-13): since #548, in-scope shifts (`isShiftInScope`) are read for
 * entry-only persons too, so "planning data ... shift ..." above now holds for contract, leave,
 * absence and holiday only. This file's fixture creates no shifts, so its assertions are
 * unchanged; see dashboard-shift-scope-548.test.ts.
 *
 * Fixture: tenant with the active salons A and B. Q is homed in B until Tue and in A from Wed
 * (Stammsalon A at the week end): Mon 5 h in B and an OPEN entry Tue in B are outside the reach of
 * the Salonmanager of A, Wed 2 h in A is inside. A1 is homed in A (Mon 6 h in A). S is a Springer
 * homed in B (Mon 08:00-12:00 in A, Tue 6 h in B, Wed an OPEN entry in B, approved vacation Thu, a
 * FIXED Mon-Fri contract). E is homed in B (Mon 4 h in B). MA is a Salonmanager with SALONS [A].
 * No person names. Fake clock Wed 2026-06-17T10:00Z (Date only), installed before the app boots;
 * the week under test is Mon 2026-06-15 to Sun 2026-06-21.
 *
 * Mutation proofs (Phase 85b, 2026-10-13) — recorded here, not re-run by CI; each change was
 * reverted with `cp` from a backup after the red names below were observed:
 * M1 hours and presence from `timeEntries` instead of the in-scope rows for scoped callers → red
 *    on "lists the Springer S by the in-scope entry, …", "shows no hours of the other salon, …"
 *    and "filtered on A: rows A1, Q and S, …".
 * M2 the stand-in of hidden time left OPEN (endTime null) → red on "shows no hours of the other
 *    salon, a neutral worked-elsewhere mark, and never a live clock-in" and on "filtered on A:
 *    rows A1, Q and S, …" (Q Tue read "clocked_in").
 * M3 the schedules read over the whole population instead of the Stammsalon persons → red on
 *    "lists the Springer S by the in-scope entry, …" (S got a contract: workday, expected hours)
 *    and on "filtered on A: rows A1, Q and S, …".
 *
 * Today-attendance and team-trend (Phase 85b plan 05, 2026-10-13): RED observed first, with the
 * committed dashboard.ts of the previous commit, on the three trend cases (the "team-trend (D-06)"
 * June figure, the filtered figure and the second-tenant case). Mutation proofs of the trend:
 * M1 the account Ist is used for every Stammsalon person (coverage ignored) → red on "Salonmanager
 *    of A: June = account Ist of A1 (360) + …" (Q's 300 B-minutes appear) and on the second-tenant
 *    June case (300 instead of 100).
 * M2 persons listed only by an in-scope entry are dropped from the trend → red on "Salonmanager of
 *    A: June = …" (S's 240 missing) and on "filtered on A: A1 (360) + S (240); …".
 * M3 the sick days are counted over the entry-only persons too → red on "sick days of a scoped
 *    caller stay over the Stammsalon persons: S never adds one".
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "./../../__tests__/setup";
import crypto from "crypto";
import { leaveTypeFields } from "../../contexts/absence/leave-type";
import { saldoSnapshotPeriodBounds } from "../../__tests__/test-dates";
import { normalizeRolePermissions, roleNameKey, SYSTEM_ROLE_IDS } from "../../contexts/platform";

const PASSWORD = "test1234";
const WEEK_URL = "/api/v1/dashboard/team-week?date=2026-06-17";

type Day = {
  date: string;
  status: string;
  workedHours: number;
  reason: string | null;
  leaveTypeCode: string | null;
  absenceType: string | null;
  shift: unknown;
  isWorkday: boolean;
  expectedHours: number;
  workedElsewhere?: boolean;
};
type Row = { id: string; name: string; employeeNumber: string | null; days: Day[] };
type Week = { weekDays: string[]; salonId?: string; team: Row[] };

function uniqueSuffix(label: string): string {
  return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

describe("Issue #85 — team-week per entry", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  let managerToken: string;
  const ids: Record<"A1" | "S" | "E" | "Q", string> = { A1: "", S: "", E: "", Q: "" };
  // S2 is kept out of `ids` on purpose: the week-grid cases above list fixture persons from `ids`.
  let s2Id = "";

  async function createPerson(tenantId: string, label: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: `${label}-Es85`,
        hireDate: new Date("2024-01-01T00:00:00Z"),
      },
    });
    await app.prisma.workSchedule.create({
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
        validFrom: new Date("2024-01-01T00:00:00Z"),
      },
    });
    return { user, employee };
  }

  function home(
    tenantId: string,
    employeeId: string,
    salonId: string,
    from = "2024-01-01",
    until: string | null = null,
  ) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date(`${from}T00:00:00Z`),
        validUntil: until ? new Date(`${until}T00:00:00Z`) : null,
      },
    });
  }

  function entry(
    employeeId: string,
    salonId: string,
    date: string,
    start: string,
    end: string | null,
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T${start}:00Z`),
        endTime: end ? new Date(`${date}T${end}:00Z`) : null,
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
      },
    });
  }

  async function week(token: string, salonId?: string): Promise<Week> {
    const url = salonId ? `${WEEK_URL}&salonId=${salonId}` : WEEK_URL;
    const res = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Week;
  }

  const rowOf = (body: Week, id: string) => body.team.find((r) => r.id === id);
  const dayOf = (row: Row | undefined, date: string) => row?.days.find((d) => d.date === date);
  const fixtureIds = (body: Week) =>
    Object.entries(ids)
      .filter(([, id]) => body.team.some((r) => r.id === id))
      .map(([key]) => key)
      .sort();
  const withoutElsewhere = (d: Day | undefined) => {
    const { workedElsewhere: _unused, ...rest } = d ?? ({} as Day);
    void _unused;
    return rest;
  };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-17T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "es85t");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Es85 B" })).id;
    const tenantId = data.tenant.id;
    const vacation = data.vacationType;

    const manager = await createPerson(tenantId, "Manager85");
    await home(tenantId, manager.employee.id, salonA);
    await app.prisma.roleAssignment.create({
      data: {
        tenantId,
        userId: manager.user.id,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds: [salonA],
        employeeIds: [],
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: manager.user.email, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    managerToken = (JSON.parse(login.body) as { accessToken: string }).accessToken;

    // A1: homed in A, Mon 6 h in A.
    const a1 = await createPerson(tenantId, "A1");
    ids.A1 = a1.employee.id;
    await home(tenantId, a1.employee.id, salonA);
    await entry(a1.employee.id, salonA, "2026-06-15", "08:00", "14:00");

    // S: the Springer, homed in B. Mon 4 h in A, Tue 6 h in B, Wed an OPEN entry in B (today),
    // approved vacation Thu.
    const s = await createPerson(tenantId, "S");
    ids.S = s.employee.id;
    await home(tenantId, s.employee.id, salonB);
    await entry(s.employee.id, salonA, "2026-06-15", "08:00", "12:00");
    await entry(s.employee.id, salonB, "2026-06-16", "08:00", "14:00");
    await entry(s.employee.id, salonB, "2026-06-17", "06:00", null);
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: s.employee.id,
        leaveTypeId: vacation.id,
        startDate: new Date("2026-06-18T00:00:00Z"),
        endDate: new Date("2026-06-18T00:00:00Z"),
        days: 1,
        status: "APPROVED",
      },
    });

    // An approved SICK day of S (Fri 05.06): S is homed in B, so it is never a sick day of the
    // Salonmanager of A (leave belongs to the Stammsalon), while the tenant admin counts it.
    const sick = await app.prisma.leaveType.create({
      data: { tenantId, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: s.employee.id,
        leaveTypeId: sick.id,
        startDate: new Date("2026-06-05T00:00:00Z"),
        endDate: new Date("2026-06-05T00:00:00Z"),
        days: 1,
        status: "APPROVED",
      },
    });

    // Q: homed in B until Tue 16.06, in A from Wed 17.06. Mon and Tue (an OPEN entry) in B, Wed in A.
    const q = await createPerson(tenantId, "Q");
    ids.Q = q.employee.id;
    await home(tenantId, q.employee.id, salonB, "2024-01-01", "2026-06-16");
    await home(tenantId, q.employee.id, salonA, "2026-06-17");
    await entry(q.employee.id, salonB, "2026-06-15", "09:00", "14:00");
    await entry(q.employee.id, salonB, "2026-06-16", "08:00", null);
    await entry(q.employee.id, salonA, "2026-06-17", "07:00", "09:00");

    // S2: a second Springer homed in B with a closed entry TODAY (Wed 17.06) in A, an approved
    // vacation tomorrow and the same FIXED Mon-Fri contract.
    const s2 = await createPerson(tenantId, "S2");
    s2Id = s2.employee.id;
    await home(tenantId, s2.employee.id, salonB);
    await entry(s2.employee.id, salonA, "2026-06-17", "06:00", "09:00");
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: s2.employee.id,
        leaveTypeId: vacation.id,
        startDate: new Date("2026-06-18T00:00:00Z"),
        endDate: new Date("2026-06-18T00:00:00Z"),
        days: 1,
        status: "APPROVED",
      },
    });

    // E: homed in B, entries only in B: never visible to the Salonmanager of A.
    const e = await createPerson(tenantId, "E");
    ids.E = e.employee.id;
    await home(tenantId, e.employee.id, salonB);
    await entry(e.employee.id, salonB, "2026-06-15", "08:00", "12:00");
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("dashboard-entry-scope-85 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("population and hours of a scoped caller", () => {
    it("lists the Springer S by the in-scope entry, with exactly the A hours and no planning data", async () => {
      const body = await week(managerToken);
      expect(fixtureIds(body)).toEqual(["A1", "Q", "S"]);
      const s = rowOf(body, ids.S);
      expect(s?.employeeNumber).toBeNull();
      expect(dayOf(s, "2026-06-15")?.workedHours).toBe(4);
      expect(dayOf(s, "2026-06-15")?.status).toBe("present");
      for (const date of ["2026-06-16", "2026-06-17", "2026-06-18"]) {
        const d = dayOf(s, date);
        expect(d?.workedHours, date).toBe(0);
        expect(d?.status, date).toBe("none");
        expect(d?.reason, date).toBeNull();
        expect(d?.leaveTypeCode, date).toBeNull();
      }
      for (const d of s?.days ?? []) {
        expect(d.isWorkday, d.date).toBe(false);
        expect(d.expectedHours, d.date).toBe(0);
        expect(d.shift, d.date).toBeNull();
        expect(d.absenceType, d.date).toBeNull();
        // Population-only: no out-of-scope time is ever read, so the mark is never true.
        expect(d.workedElsewhere, d.date).toBe(false);
      }
    });

    it("E (homed in B, entries only in B) stays invisible", async () => {
      const res = await app.inject({
        method: "GET",
        url: WEEK_URL,
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(res.body).not.toContain(ids.E);
    });

    it("the Stammsalon person A1 equals the tenant admin's values plus the workedElsewhere key", async () => {
      const mine = rowOf(await week(managerToken), ids.A1);
      const admin = rowOf(await week(data.adminToken), ids.A1);
      expect(mine?.employeeNumber).toBe(admin?.employeeNumber);
      expect(mine?.days).toHaveLength(7);
      for (const d of mine?.days ?? []) {
        expect(d.workedElsewhere).toBe(false);
        expect(withoutElsewhere(d)).toEqual(withoutElsewhere(dayOf(admin, d.date)));
      }
    });

    it("control: the tenant admin sees everyone with all hours and no workedElsewhere key", async () => {
      const body = await week(data.adminToken);
      expect(fixtureIds(body)).toEqual(["A1", "E", "Q", "S"]);
      expect(dayOf(rowOf(body, ids.S), "2026-06-16")?.workedHours).toBe(6);
      expect(dayOf(rowOf(body, ids.S), "2026-06-17")?.status).toBe("clocked_in");
      expect(dayOf(rowOf(body, ids.S), "2026-06-18")?.status).toBe("absent");
      for (const row of body.team) {
        for (const d of row.days) expect("workedElsewhere" in d).toBe(false);
      }
    });
  });

  describe("a Stammsalon person with time outside the reach", () => {
    it("shows no hours of the other salon, a neutral worked-elsewhere mark, and never a live clock-in", async () => {
      const q = rowOf(await week(managerToken), ids.Q);
      const mon = dayOf(q, "2026-06-15");
      expect(mon?.workedHours).toBe(0);
      expect(mon?.workedElsewhere).toBe(true);
      expect(mon?.status).toBe("present");
      const tue = dayOf(q, "2026-06-16");
      expect(tue?.workedHours).toBe(0);
      expect(tue?.workedElsewhere).toBe(true);
      expect(tue?.status).toBe("present");
      const wed = dayOf(q, "2026-06-17");
      expect(wed?.workedHours).toBe(2);
      expect(wed?.workedElsewhere).toBe(false);
    });

    it("filtered on A: rows A1, Q and S, S shows only the A hours, no day shows a minute of B", async () => {
      const body = await week(managerToken, salonA);
      expect(body.salonId).toBe(salonA);
      expect(fixtureIds(body)).toEqual(["A1", "Q", "S"]);
      const s = rowOf(body, ids.S);
      expect(dayOf(s, "2026-06-15")?.workedHours).toBe(4);
      for (const date of ["2026-06-16", "2026-06-17"]) {
        expect(dayOf(s, date)?.workedHours, date).toBe(0);
        expect(dayOf(s, date)?.status, date).toBe("none");
        expect(dayOf(s, date)?.workedElsewhere, date).toBe(false);
      }
      const q = rowOf(body, ids.Q);
      expect(dayOf(q, "2026-06-15")?.workedHours).toBe(0);
      expect(dayOf(q, "2026-06-15")?.workedElsewhere).toBe(true);
      expect(dayOf(q, "2026-06-16")?.status).toBe("present");
      expect(dayOf(q, "2026-06-17")?.workedHours).toBe(2);
      expect(rowOf(body, ids.E)).toBeUndefined();
    });
  });

  describe("today-attendance (D-04)", () => {
    type Attendance = {
      date: string;
      employees: {
        id: string;
        name: string;
        employeeNumber: string | null;
        status: string;
        reason: string | null;
      }[];
      summary: {
        present: number;
        absent: number;
        clockedIn: number;
        missing: number;
        holiday: number;
      };
    };

    async function attendance(token: string): Promise<Attendance> {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/today-attendance",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      return JSON.parse(res.body) as Attendance;
    }
    const allIds = () => ({ ...ids, S2: s2Id });
    const listed = (body: Attendance) =>
      Object.entries(allIds())
        .filter(([, id]) => body.employees.some((r) => r.id === id))
        .map(([key]) => key)
        .sort();

    it("lists S2 by the in-scope entry today, status from that entry only, no planning data", async () => {
      const body = await attendance(managerToken);
      expect(body.date).toBe("2026-06-17");
      const s2 = body.employees.find((r) => r.id === s2Id);
      expect(s2?.status).toBe("present");
      expect(s2?.reason).toBeNull();
      expect(s2?.employeeNumber).toBeNull();
    });

    it("does not list S (only today's entry is an open one in B) nor E", async () => {
      const body = await attendance(managerToken);
      expect(listed(body)).toEqual(["A1", "Q", "S2"]);
      expect(JSON.stringify(body)).not.toContain(ids.S);
      expect(JSON.stringify(body)).not.toContain(ids.E);
    });

    it("the Stammsalon person A1 has the same status as for the tenant admin", async () => {
      const mine = (await attendance(managerToken)).employees.find((r) => r.id === ids.A1);
      const admin = (await attendance(data.adminToken)).employees.find((r) => r.id === ids.A1);
      expect(mine).toEqual(admin);
    });

    it("the summary counters equal the counts of the manager's own rows", async () => {
      const body = await attendance(managerToken);
      const count = (status: string) => body.employees.filter((r) => r.status === status).length;
      expect(body.summary).toEqual({
        present: count("present"),
        absent: count("absent"),
        clockedIn: count("clocked_in"),
        missing: count("missing"),
        holiday: count("holiday"),
      });
      expect(count("present")).toBeGreaterThanOrEqual(2);
    });

    it("control: the tenant admin sees every person with the unchanged statuses", async () => {
      const body = await attendance(data.adminToken);
      expect(listed(body)).toEqual(["A1", "E", "Q", "S", "S2"]);
      expect(body.employees.find((r) => r.id === ids.S)?.status).toBe("clocked_in");
      expect(body.employees.find((r) => r.id === s2Id)?.status).toBe("present");
      expect(body.employees.find((r) => r.id === s2Id)?.employeeNumber).not.toBeNull();
    });
  });

  describe("team-trend (D-06)", () => {
    type TrendMonth = {
      month: string;
      workedMinutes: number;
      shouldMinutes: number | null;
      sickDays: number;
    };
    type Trend = {
      salonId: string | null;
      workedBasis: string;
      sollUnavailableReason: string | null;
      months: TrendMonth[];
    };

    async function trend(token: string, salonId?: string): Promise<Trend> {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/dashboard/team-trend${salonId ? `?salonId=${salonId}` : ""}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      return JSON.parse(res.body) as Trend;
    }
    const june = (t: Trend) => t.months.find((m) => m.month === "2026-06");

    it("Salonmanager of A: June = account Ist of A1 (360) + in-scope sum of S (240) + Q uncovered (0 through yesterday)", async () => {
      const body = await trend(managerToken);
      expect(body.workedBasis).toBe("SCOPE_ENTRIES");
      expect(body.sollUnavailableReason).toBe("NO_PERMISSION");
      expect(body.months).toHaveLength(6);
      expect(june(body)?.workedMinutes).toBe(600);
      // No month carries S's 360 B-minutes, Q's 300 B-minutes or any other minute.
      expect(body.months.reduce((sum, m) => sum + m.workedMinutes, 0)).toBe(600);
      for (const m of body.months) expect(m.shouldMinutes, m.month).toBeNull();
    });

    it("sick days of a scoped caller stay over the Stammsalon persons: S never adds one", async () => {
      const mine = await trend(managerToken);
      expect(mine.months.reduce((sum, m) => sum + m.sickDays, 0)).toBe(0);
      const admin = await trend(data.adminToken);
      expect(june(admin)?.sickDays).toBe(1);
    });

    it("control: the tenant admin keeps the account Ist incl. the B minutes, equal to the monthly report", async () => {
      const body = await trend(data.adminToken);
      expect(body.workedBasis).toBe("ACCOUNT");
      expect(body.sollUnavailableReason).toBeNull();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/monthly?year=2026&month=6",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      const rows = (JSON.parse(res.body) as { rows: { workedHours: number }[] }).rows;
      const reported = Math.round(rows.reduce((sum, r) => sum + r.workedHours * 60, 0));
      expect(june(body)?.workedMinutes).toBe(reported);
      // Non-vacuous: more than the manager's visible 600 (E 240, S 360 in B, Q 300 in B).
      expect(reported).toBeGreaterThan(600);
    });

    it("filtered on A: A1 (360) + S (240); today's entries of S2 and Q never count (#438)", async () => {
      const body = await trend(managerToken, salonA);
      expect(body.salonId).toBe(salonA);
      expect(body.workedBasis).toBe("SALON_ENTRIES");
      expect(june(body)?.workedMinutes).toBe(600);
      for (const m of body.months) expect(m.shouldMinutes, m.month).toBeNull();
    });
  });

  describe("team-trend (D-06) — a Stammsalon change inside the month and a closed month", () => {
    type Month = {
      month: string;
      workedMinutes: number;
      shouldMinutes: number | null;
      sickDays: number;
    };
    let data2: Awaited<ReturnType<typeof seedTestData>>;
    let callerToken: string;

    async function login(email: string): Promise<string> {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: PASSWORD },
      });
      expect(res.statusCode, res.body).toBe(200);
      return (JSON.parse(res.body) as { accessToken: string }).accessToken;
    }

    beforeAll(async () => {
      data2 = await seedTestData(app, "es85c");
      const tenantId = data2.tenant.id;
      const a = data2.salonId;
      const b = (await createTestSalon(app.prisma, tenantId, { name: "Es85 C-B" })).id;

      // Q2: homed in B until 09.06 and in A from 10.06; 200 minutes in B on 08.06 (out of the
      // reach of A) and 100 minutes in A on 12.06.
      const q2 = await createPerson(tenantId, "Q2");
      await home(tenantId, q2.employee.id, b, "2024-01-01", "2026-06-09");
      await home(tenantId, q2.employee.id, a, "2026-06-10");
      await entry(q2.employee.id, b, "2026-06-08", "08:00", "11:20");
      await entry(q2.employee.id, a, "2026-06-12", "08:00", "09:40");

      // P2: homed in A, every entry in A, a closed March whose snapshot differs from the entry.
      const p2 = await createPerson(tenantId, "P2");
      await home(tenantId, p2.employee.id, a);
      await entry(p2.employee.id, a, "2026-03-10", "08:00", "12:00");
      const march = saldoSnapshotPeriodBounds(new Date("2026-03-15T00:00:00.000Z"));
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: p2.employee.id,
          periodType: "MONTHLY",
          periodStart: march.start,
          periodEnd: march.end,
          workedMinutes: 9660,
          expectedMinutes: 9600,
          balanceMinutes: 60,
          carryOver: 60,
          closedAt: new Date("2026-04-02T08:00:00Z"),
          closedBy: "test-system",
          superseded: false,
        },
      });

      // Caller C: team-overview, report and overtime reach over SALONS [A].
      const caller = await createPerson(tenantId, "Caller");
      const name = `Es85 ${crypto.randomBytes(3).toString("hex")}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId,
          name,
          nameKey: roleNameKey(name),
          permissions: normalizeRolePermissions([
            "team-overview:read:ZUGEWIESEN",
            "report:read:ZUGEWIESEN",
            "overtime:read:ZUGEWIESEN",
          ]),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId,
          userId: caller.user.id,
          accessRoleId: role.id,
          scopeType: "SALONS",
          salonIds: [a],
          employeeIds: [],
        },
      });
      callerToken = await login(caller.user.email);
    });

    afterAll(async () => {
      try {
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data2.tenant.id } });
        await app.prisma.accessRole.deleteMany({ where: { tenantId: data2.tenant.id } });
        await cleanupTestData(app, data2.tenant.id);
      } catch (err) {
        console.error("dashboard-entry-scope-85 (second tenant) cleanup failed:", err);
      }
    });

    it("June is the in-scope sum (100, not the account's 300); March keeps the account Ist of the fully covered person; Soll is withheld with the SCOPE_ENTRIES reason", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/team-trend",
        headers: { authorization: `Bearer ${callerToken}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as {
        workedBasis: string;
        sollUnavailableReason: string | null;
        months: Month[];
      };
      expect(body.workedBasis).toBe("SCOPE_ENTRIES");
      expect(body.sollUnavailableReason).toBe("SCOPE_ENTRIES");
      for (const m of body.months) expect(m.shouldMinutes, m.month).toBeNull();
      expect(body.months.find((m) => m.month === "2026-06")?.workedMinutes).toBe(100);
      // P2 is fully covered: the closed March is the snapshot value, not the 240 entry minutes.
      expect(body.months.find((m) => m.month === "2026-03")?.workedMinutes).toBe(9660);
    });
  });
});
