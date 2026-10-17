/**
 * Issue #587 (AC-587-1, D-587-1/D-587-2) — the dashboard's team week and the attendance list
 * resolve a person's day status through the SAME function, with the SAME inputs, so for one
 * person and one day they cannot contradict each other any more.
 *
 * Before #587 `GET /dashboard/today-attendance` hard-coded "today is never future" and read no
 * shifts and no PENDING leave, so a FIXED_SCHEDULE person at 12:00 with no shift read "Fehlt"
 * there and "Geplant" in `GET /dashboard/team-week`, and a SHIFT_BASED person past a shift start
 * read "—" in the list and "Fehlt" in the week.
 *
 * One tenant (Europe/Berlin), `Date` faked at non-midnight instants. Persons come from
 * `createPopulationPerson`; no names, no real e-mails.
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
  reissueTokenNow,
} from "../../__tests__/setup";
import { createPopulationPerson } from "../../__tests__/population-fixtures-613";
import { SYSTEM_ROLE_IDS } from "../../contexts/platform";
import { DISPLAY_NAME } from "../../contexts/absence";

const WED = "2026-06-17";
const WEEK_URL = `/api/v1/dashboard/team-week?date=${WED}`;
const HIRE = new Date("2025-01-01T00:00:00Z");
const PASSWORD = "test1234";
// 07:00 and 12:00 local (Europe/Berlin, CEST = UTC+2) on Wed 2026-06-17.
const AT_0700 = "2026-06-17T05:00:00Z";
const AT_1200 = "2026-06-17T10:00:00Z";
const day = (s: string) => new Date(`${s}T00:00:00Z`);

type Cell = {
  date: string;
  status: string;
  reason: string | null;
  isWorkday: boolean;
  expectedHours: number;
};
type Week = { team: Array<{ id: string; employeeNumber: string | null; days: Cell[] }> };
type Att = {
  date: string;
  employees: Array<{
    id: string;
    employeeNumber: string | null;
    status: string;
    reason: string | null;
    expectedStart?: string | null;
    lateMinutes?: number | null;
  }>;
};

describe("Issue #587 — one day status for the team week and the attendance list", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let salonB = "";
  let maToken = "";
  let vacationTypeName = "";
  const ids = {
    FX: "",
    FXS: "",
    SB1: "",
    SB2: "",
    SB0: "",
    FL: "",
    MH: "",
    PD: "",
    BS: "",
    HO: "",
    PR: "",
    CI: "",
    SP: "",
    X: "",
    INV: "",
    CC: "",
  };
  /** Every status any answer of this file contained (the matrix must reach all eight). */
  const observed = new Set<string>();

  /** Both answers inside ONE faked-clock window. */
  async function bothAt(
    token: string,
    clock: string,
    weekUrl = WEEK_URL,
  ): Promise<{ week: Week; att: Att }> {
    vi.useFakeTimers({ now: new Date(clock), toFake: ["Date"] });
    try {
      const t = reissueTokenNow(app, token);
      const headers = { authorization: `Bearer ${t}` };
      const w = await app.inject({ method: "GET", url: weekUrl, headers });
      expect(w.statusCode, w.body).toBe(200);
      const a = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/today-attendance",
        headers,
      });
      expect(a.statusCode, a.body).toBe(200);
      return { week: JSON.parse(w.body) as Week, att: JSON.parse(a.body) as Att };
    } finally {
      vi.useRealTimers();
    }
  }

  function cellOf(week: Week, id: string, date: string): Cell {
    const row = week.team.find((r) => r.id === id);
    expect(row, `team-week row ${id}`).toBeDefined();
    const cell = row?.days.find((c) => c.date === date);
    expect(cell, `team-week cell ${date} of ${id}`).toBeDefined();
    return cell as Cell;
  }

  function rowOf(att: Att, id: string) {
    const row = att.employees.find((r) => r.id === id);
    expect(row, `attendance row ${id}`).toBeDefined();
    return row as Att["employees"][number];
  }

  async function person(tag: string, salonId: string, opts: { passwordHash?: string } = {}) {
    return createPopulationPerson(app, {
      tenantId: d.tenant.id,
      salonId,
      tag,
      hireDate: HIRE,
      ...opts,
    });
  }

  function setSchedule(employeeId: string, data: Record<string, unknown>) {
    return app.prisma.workSchedule.updateMany({ where: { employeeId }, data });
  }

  function shiftBased(employeeId: string) {
    return setSchedule(employeeId, {
      type: "SHIFT_BASED",
      contractWorkDaysPerWeek: 5,
      usualWorkDays: [1, 2, 3, 4, 5],
    });
  }

  function shift(employeeId: string, salonId: string, start: string, end: string, date = WED) {
    return app.prisma.shift.create({
      data: {
        employeeId,
        salonId,
        date: day(date),
        startTime: start,
        endTime: end,
        label: "ds587",
      },
    });
  }

  function entry(
    employeeId: string,
    salonId: string,
    start: string,
    end: string | null,
    isInvalid = false,
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: day(WED),
        startTime: new Date(`${WED}T${start}:00Z`),
        endTime: end ? new Date(`${WED}T${end}:00Z`) : null,
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
        isInvalid,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "ds587");
    const tenantId = d.tenant.id;
    salonB = (await createTestSalon(app.prisma, tenantId, { name: "Ds587 B" })).id;
    const salonA = d.salonId;
    const vacationType = await app.prisma.leaveType.findFirstOrThrow({
      where: { tenantId, code: "VACATION" },
    });
    vacationTypeName = vacationType.name;
    const leave = (employeeId: string, status: "APPROVED" | "PENDING") =>
      app.prisma.leaveRequest.create({
        data: {
          employeeId,
          leaveTypeId: vacationType.id,
          startDate: day(WED),
          endDate: day(WED),
          days: 1,
          status,
          ...(status === "APPROVED" ? { reviewedBy: d.adminUser.id, reviewedAt: new Date() } : {}),
        },
      });

    ids.FX = (await person("fx", salonA)).employeeId;

    ids.FXS = (await person("fxs", salonA)).employeeId;
    await shift(ids.FXS, salonA, "08:00", "16:00");

    ids.SB1 = (await person("sb1", salonA)).employeeId;
    await shiftBased(ids.SB1);
    await shift(ids.SB1, salonA, "09:00", "17:00");

    ids.SB2 = (await person("sb2", salonA)).employeeId;
    await shiftBased(ids.SB2);
    await shift(ids.SB2, salonA, "14:00", "20:00");

    ids.SB0 = (await person("sb0", salonA)).employeeId;
    await shiftBased(ids.SB0);

    ids.FL = (await person("fl", salonA)).employeeId;
    await setSchedule(ids.FL, { type: "FLEXTIME" });

    ids.MH = (await person("mh", salonA)).employeeId;
    await setSchedule(ids.MH, { type: "MONTHLY_HOURS", monthlyHours: 40, weeklyHours: null });

    ids.PD = (await person("pd", salonA)).employeeId;
    await leave(ids.PD, "PENDING");

    // BS: a Berufsschule day AND an approved vacation on the same day - the school day displaces
    // the vacation classification (Issue #448, D-05).
    ids.BS = (await person("bs", salonA)).employeeId;
    await leave(ids.BS, "APPROVED");
    await app.prisma.absence.create({
      data: {
        employeeId: ids.BS,
        type: "VOCATIONAL_SCHOOL",
        source: "MANUAL",
        startDate: day(WED),
        endDate: day(WED),
        days: 1,
        createdBy: "system",
      },
    });

    // HO: homed in salon B, which has a manual holiday today.
    ids.HO = (await person("ho", salonB)).employeeId;
    await app.prisma.publicHoliday.create({
      data: {
        tenantId,
        salonId: salonB,
        date: day(WED),
        name: "Hausfeiertag ds587",
        federalState: "NIEDERSACHSEN",
        year: 2026,
      },
    });

    ids.PR = (await person("pr", salonA)).employeeId;
    await entry(ids.PR, salonA, "06:00", "09:00");

    ids.CI = (await person("ci", salonA)).employeeId;
    await entry(ids.CI, salonA, "06:00", null);

    // ── Salonmanager of A and the persons that make a scoped answer differ ──────────────────
    const ma = await person("ma", salonA, { passwordHash: await bcrypt.hash(PASSWORD, 4) });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId,
        userId: ma.userId,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds: [salonA],
        employeeIds: [],
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: ma.email, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    maToken = (JSON.parse(login.body) as { accessToken: string }).accessToken;

    // SP: a Springer homed in B with a closed entry today in A.
    ids.SP = (await person("sp", salonB)).employeeId;
    await entry(ids.SP, salonA, "06:00", "09:00");

    // X: homed in A, SHIFT_BASED, today's only shift lies in B.
    ids.X = (await person("x", salonA)).employeeId;
    await shiftBased(ids.X);
    await shift(ids.X, salonB, "08:00", "12:00");

    // INV: homed in B, an INVALID entry today in A and an A shift at 08:00.
    ids.INV = (await person("inv", salonB)).employeeId;
    await entry(ids.INV, salonA, "06:00", "09:00", true);
    await shift(ids.INV, salonA, "08:00", "16:00");

    // CC: a FIXED Mon-Fri contract from 2025-01-01 and a Wed-Fri contract with 6 h days from
    // 2026-07-01 (a month-first contract change).
    ids.CC = (await person("cc", salonA)).employeeId;
    await app.prisma.workSchedule.create({
      data: {
        employeeId: ids.CC,
        type: "FIXED_SCHEDULE",
        weeklyHours: 18,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 6,
        thursdayHours: 6,
        fridayHours: 6,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [3, 4, 5],
        validFrom: new Date("2026-06-30T22:00:00Z"), // 2026-07-01 00:00 Europe/Berlin
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: d.tenant.id } });
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("day-status-parity-587 cleanup failed:", err);
    }
    await closeTestApp();
  });

  /** Records the statuses of both answers and asserts the per-person equality of the listed rows. */
  function expectParity(week: Week, att: Att, date = att.date): void {
    expect(att.employees.length, "the attendance list is not empty").toBeGreaterThan(0);
    for (const row of att.employees) {
      const cell = cellOf(week, row.id, date);
      expect({ status: row.status, reason: row.reason }, `person ${row.id}`).toEqual({
        status: cell.status,
        reason: cell.reason,
      });
      observed.add(row.status);
      observed.add(cell.status);
    }
  }

  describe("tracer", () => {
    it("a FIXED_SCHEDULE person at 12:00 without a shift or entry reads scheduled in both views", async () => {
      const { week, att } = await bothAt(d.adminToken, AT_1200);
      const cell = cellOf(week, ids.FX, WED);
      expect(cell.status).toBe("scheduled");
      expect(rowOf(att, ids.FX)).toMatchObject({ status: "scheduled", reason: cell.reason });
    });

    it("a SHIFT_BASED person past the shift start reads missing in both views", async () => {
      const { week, att } = await bothAt(d.adminToken, AT_1200);
      const cell = cellOf(week, ids.SB1, WED);
      expect(cell.status).toBe("missing");
      expect(rowOf(att, ids.SB1)).toMatchObject({ status: "missing", reason: cell.reason });
    });

    it("every attendance row has the status and reason of its person's today cell", async () => {
      const { week, att } = await bothAt(d.adminToken, AT_1200);
      expectParity(week, att);
    });
  });

  describe("matrix (tenant admin)", () => {
    // person -> [status at 07:00, status at 12:00]
    const EXPECTED: Array<[keyof typeof ids, string, string]> = [
      ["FX", "scheduled", "scheduled"],
      ["FXS", "scheduled", "missing"],
      ["SB1", "scheduled", "missing"],
      ["SB2", "scheduled", "scheduled"],
      ["SB0", "none", "none"],
      ["FL", "none", "none"],
      ["MH", "none", "none"],
      ["PD", "requested", "requested"],
      ["BS", "absent", "absent"],
      ["HO", "holiday", "holiday"],
      ["PR", "present", "present"],
      ["CI", "clocked_in", "clocked_in"],
    ];

    for (const [clock, at, idx] of [
      ["07:00", AT_0700, 1],
      ["12:00", AT_1200, 2],
    ] as const) {
      it(`every attendance row equals its team-week cell at ${clock}`, async () => {
        const { week, att } = await bothAt(d.adminToken, at);
        expectParity(week, att);
      });

      it(`every fixture person has its expected status at ${clock}`, async () => {
        const { week, att } = await bothAt(d.adminToken, at);
        for (const entryOf of EXPECTED) {
          const id = ids[entryOf[0]];
          expect(rowOf(att, id).status, `${entryOf[0]} attendance`).toBe(entryOf[idx]);
          expect(cellOf(week, id, WED).status, `${entryOf[0]} team week`).toBe(entryOf[idx]);
        }
      });
    }

    it("a pending vacation names the leave type; the Berufsschule day displaces an approved vacation", async () => {
      const { week, att } = await bothAt(d.adminToken, AT_1200);
      expect(rowOf(att, ids.PD).reason).toBe(`Antrag: ${vacationTypeName}`);
      expect(cellOf(week, ids.PD, WED).reason).toBe(`Antrag: ${vacationTypeName}`);
      expect(rowOf(att, ids.BS).reason).toBe(DISPLAY_NAME.VOCATIONAL_SCHOOL);
      expect(cellOf(week, ids.BS, WED).reason).toBe(DISPLAY_NAME.VOCATIONAL_SCHOOL);
      expect(rowOf(att, ids.HO).reason).toBe("Hausfeiertag ds587");
    });
  });

  describe("Salonmanager (SALONS [A])", () => {
    it("every attendance row equals the manager's own team-week cell", async () => {
      for (const at of [AT_0700, AT_1200]) {
        const { week, att } = await bothAt(maToken, at);
        expectParity(week, att);
      }
    });

    it("the Springer with an in-scope entry is listed in both answers as present, without a number", async () => {
      const { week, att } = await bothAt(maToken, AT_1200);
      expect(rowOf(att, ids.SP)).toMatchObject({ status: "present", employeeNumber: null });
      expect(cellOf(week, ids.SP, WED).status).toBe("present");
      expect(week.team.find((r) => r.id === ids.SP)?.employeeNumber).toBeNull();
    });

    it("a shift outside the reach reads like no shift for the manager and as missing for the admin", async () => {
      const manager = await bothAt(maToken, AT_1200);
      expect(rowOf(manager.att, ids.X).status).toBe("none");
      expect(cellOf(manager.week, ids.X, WED).status).toBe("none");
      const admin = await bothAt(d.adminToken, AT_1200);
      expect(rowOf(admin.att, ids.X).status).toBe("missing");
      expect(cellOf(admin.week, ids.X, WED).status).toBe("missing");
    });

    it("a person listed only through an invalid entry is never missing and reads equally in both answers", async () => {
      const { week, att } = await bothAt(maToken, AT_1200);
      // Measured (2026-10-17): the Unterbau's in-scope id set DOES contain the invalid row, so INV
      // is listed in both answers. The invalid entry is ignored by the status (D-08), the row is
      // entry-only (no contract of its own) and its due in-scope shift never makes it "missing"
      // (Issue #548): both answers read "none".
      expect(rowOf(att, ids.INV).status).toBe("none");
      expect(cellOf(week, ids.INV, WED).status).toBe("none");
      expect(rowOf(att, ids.INV).employeeNumber).toBeNull();
    });
  });

  describe("contract change (P-02)", () => {
    const TUE_URL = "/api/v1/dashboard/team-week?date=2026-06-30";
    const AT_TUE = "2026-06-30T10:00:00Z";

    it("the days before a month-first contract change are judged by the contract valid on them", async () => {
      const { week, att } = await bothAt(d.adminToken, AT_TUE, TUE_URL);
      expect(rowOf(att, ids.CC).status).toBe("scheduled");
      expect(cellOf(week, ids.CC, "2026-06-30").status).toBe("scheduled");
      const monday = cellOf(week, ids.CC, "2026-06-29");
      expect(monday).toMatchObject({ status: "missing", isWorkday: true, expectedHours: 8 });
      const july = cellOf(week, ids.CC, "2026-07-01");
      expect(july).toMatchObject({ status: "scheduled", isWorkday: true, expectedHours: 6 });
      expectParity(week, att);
    });
  });

  describe("expected time and lateness (D-587-3)", () => {
    const timing = (att: Att, id: string) => {
      const row = rowOf(att, id);
      return {
        status: row.status,
        expectedStart: row.expectedStart,
        lateMinutes: row.lateMinutes,
      };
    };

    it("at 12:00 a missing shift row names its start and the minutes late", async () => {
      const { att } = await bothAt(d.adminToken, AT_1200);
      expect(timing(att, ids.SB1)).toEqual({
        status: "missing",
        expectedStart: "09:00",
        lateMinutes: 180,
      });
      expect(timing(att, ids.FXS)).toEqual({
        status: "missing",
        expectedStart: "08:00",
        lateMinutes: 240,
      });
      expect(timing(att, ids.SB2)).toEqual({
        status: "scheduled",
        expectedStart: "14:00",
        lateMinutes: null,
      });
      expect(timing(att, ids.FX)).toEqual({
        status: "scheduled",
        expectedStart: null,
        lateMinutes: null,
      });
    });

    it("at 07:00 a shift that has not started reads scheduled with its start and is not late", async () => {
      const { att } = await bothAt(d.adminToken, AT_0700);
      expect(timing(att, ids.SB1)).toEqual({
        status: "scheduled",
        expectedStart: "09:00",
        lateMinutes: null,
      });
    });

    it("a shift outside the reach is neither named nor counted late for the Salonmanager", async () => {
      const manager = await bothAt(maToken, AT_1200);
      expect(timing(manager.att, ids.X)).toEqual({
        status: "none",
        expectedStart: null,
        lateMinutes: null,
      });
      const admin = await bothAt(d.adminToken, AT_1200);
      expect(timing(admin.att, ids.X)).toEqual({
        status: "missing",
        expectedStart: "08:00",
        lateMinutes: 240,
      });
    });

    it("the team-week cells keep the frozen key set: neither expectedStart nor lateMinutes", async () => {
      const { week } = await bothAt(d.adminToken, AT_1200);
      for (const id of [ids.SB1, ids.FXS, ids.SB2, ids.FX, ids.X]) {
        const cell = cellOf(week, id, WED) as unknown as Record<string, unknown>;
        expect(Object.keys(cell), `cell of ${id}`).not.toContain("expectedStart");
        expect(Object.keys(cell), `cell of ${id}`).not.toContain("lateMinutes");
      }
    });
  });

  describe("coverage", () => {
    it("the matrix reached all eight statuses", () => {
      expect([...observed].sort((a, b) => a.localeCompare(b))).toEqual(
        [
          "absent",
          "clocked_in",
          "holiday",
          "missing",
          "none",
          "present",
          "requested",
          "scheduled",
        ].sort((a, b) => a.localeCompare(b)),
      );
    });
  });
});
