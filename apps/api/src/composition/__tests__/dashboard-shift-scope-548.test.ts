/**
 * Issue #548 — `GET /api/v1/dashboard/team-week` shows only the shifts a scoped caller may see.
 *
 * The shift rule of Phase 91b D-11 (`isShiftInScope`): a shift is in scope through its OWN salon or
 * through a person in the reach, never through the Stammsalon of its employee. The week grid read
 * the shifts of the Stammsalon persons without a `salonId`, so a Salonmanager of A saw the planned
 * times, label and colour of an A-homed person's salon-B shift, plus a "Fehlt"/"Geplant" signal
 * derived from it. Springers listed only through an in-scope entry (Phase 85b D-04) got no shift at
 * all, not even those of the caller's own salon.
 *
 * 548-D1: a day whose only shift is out of scope is indistinguishable from a day without a shift
 * (shift null, no SHIFT_BASED workday, no due time, status from entries/leave/absence/holiday
 * only). No marker is added: hiding a shift can only remove an obligation signal and never create
 * a false "Fehlt", unlike hidden worked time (`workedElsewhere`, 85b D-05). `expectedHours` stays
 * the contract value, which is identical with or without a shift and so discloses nothing.
 *
 * 548-D4: a row listed only through an in-scope entry gets its in-scope shifts, never an
 * out-of-scope one, and is never "missing": the reasons a planned person may be away (leave,
 * sickness, Berufsschule, work in another salon) are held by the Stammsalon and withheld, so
 * "Fehlt" would be a claim the response cannot back. An in-scope shift that is not yet due gives
 * "scheduled".
 *
 * Fixture (week Mon 2026-06-15 to Sun 2026-06-21, fake clock Wed 2026-06-17T10:00Z, Date only).
 * Salon A = the seeded salon, salon B = a second one. SHIFT_BASED contract for P, P2 and S.
 *  - MA: Salonmanager, SALONS [A].  MP: Salonmanager, PERSONS [P].
 *  - P (homed in A): B shift Mon 08-16; Tue B 07-11 AND A 13-18; B shift Fri 10-18.
 *  - P2 (homed in A, control): no shift.
 *  - S (homed in B, entry-only Springer for MA): Mon entry in A 08-12; A shift Mon 08-12; Tue B
 *    07-11 and A 13-18; Thu B 09-17 only; Fri A 10-18.
 * No person names.
 *
 * Mutation proofs (Issue #548, 2026-10-13) — recorded here, not re-run by CI; each change was
 * reverted with `cp` from a backup after the red names below were observed:
 * RED first (before the fix): cases 1, 2, 3, 4 and 8 failed (the manager saw the B shifts; S had no
 * shift at all); cases 5, 6 and 7 passed already.
 * M1 the shift filter dropped -> red on cases 1, 2, 3, 4 and 8.
 * M2 the predicate replaced by a salon-only check (wholeTenant or reach.salonIds) -> red on case 5
 *    (the PERSONS reach loses P's B shifts).
 * M3 the full list kept for the day signals and only the returned `shift` object nulled for
 *    out-of-scope rows -> red on cases 1, 2, 3, 4 and 8 (Monday reads a workday and "missing",
 *    Friday "scheduled"; case 2 because the earliest, out-of-scope shift is the one nulled).
 * M4 the shift read fed the Stammsalon ids again (widening dropped) -> red on case 8.
 * M5 `hasShift: shift !== null` for entry-only rows too -> red on case 8 (Tuesday reads "missing").
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
import { SYSTEM_ROLE_IDS } from "../../contexts/platform";

const PASSWORD = "test1234";
const WEEK_URL = "/api/v1/dashboard/team-week?date=2026-06-17";

type ShiftView = {
  startTime: string;
  endTime: string;
  label: string | null;
  color: string | null;
} | null;
type Day = {
  date: string;
  status: string;
  workedHours: number;
  reason: string | null;
  leaveTypeCode: string | null;
  absenceType: string | null;
  shift: ShiftView;
  isWorkday: boolean;
  expectedHours: number;
  workedElsewhere?: boolean;
};
type Row = { id: string; name: string; employeeNumber: string | null; days: Day[] };
type Week = { weekDays: string[]; salonId?: string; team: Row[] };

const MON = "2026-06-15";
const TUE = "2026-06-16";
const THU = "2026-06-18";
const FRI = "2026-06-19";

function uniqueSuffix(label: string): string {
  return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

describe("Issue #548 — team-week shows only in-scope shifts", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  let maToken: string;
  let mpToken: string;
  const ids = { P: "", P2: "", S: "" };

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
        lastName: `${label}-Ss548`,
        hireDate: new Date("2024-01-01T00:00:00Z"),
      },
    });
    return { user, employee };
  }

  async function shiftBasedContract(employeeId: string) {
    await app.prisma.workSchedule.create({
      data: {
        employeeId,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        contractWorkDaysPerWeek: 5,
        validFrom: new Date("2024-01-01T00:00:00Z"),
      },
    });
  }

  function home(tenantId: string, employeeId: string, salonId: string) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
      },
    });
  }

  function shift(
    employeeId: string,
    salonId: string,
    date: string,
    start: string,
    end: string,
    label: string,
  ) {
    return app.prisma.shift.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: start,
        endTime: end,
        label,
      },
    });
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
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
  /** Asserts the row and the day exist, so no case runs against undefined. */
  function dayOf(body: Week, id: string, date: string): Day {
    const row = rowOf(body, id);
    expect(row, `row ${id}`).toBeDefined();
    const day = row?.days.find((d) => d.date === date);
    expect(day, `day ${date} of ${id}`).toBeDefined();
    return day as Day;
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-17T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "ss548");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Ss548 B" })).id;
    const tenantId = data.tenant.id;

    const ma = await createPerson(tenantId, "ManagerA");
    await home(tenantId, ma.employee.id, salonA);
    await app.prisma.roleAssignment.create({
      data: {
        tenantId,
        userId: ma.user.id,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds: [salonA],
        employeeIds: [],
      },
    });
    maToken = await login(ma.user.email);

    const p = await createPerson(tenantId, "P");
    ids.P = p.employee.id;
    await home(tenantId, p.employee.id, salonA);
    await shiftBasedContract(p.employee.id);

    const mp = await createPerson(tenantId, "ManagerP");
    await app.prisma.roleAssignment.create({
      data: {
        tenantId,
        userId: mp.user.id,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "PERSONS",
        salonIds: [],
        employeeIds: [p.employee.id],
      },
    });
    mpToken = await login(mp.user.email);

    await shift(p.employee.id, salonB, MON, "08:00", "16:00", "B-Schicht");
    await shift(p.employee.id, salonB, TUE, "07:00", "11:00", "B-Schicht");
    await shift(p.employee.id, salonA, TUE, "13:00", "18:00", "A-Schicht");
    await shift(p.employee.id, salonB, FRI, "10:00", "18:00", "B-Schicht");

    const p2 = await createPerson(tenantId, "P2");
    ids.P2 = p2.employee.id;
    await home(tenantId, p2.employee.id, salonA);
    await shiftBasedContract(p2.employee.id);

    // S: the entry-only Springer for MA (homed in B, one in-scope entry in A on Monday).
    const s = await createPerson(tenantId, "S");
    ids.S = s.employee.id;
    await home(tenantId, s.employee.id, salonB);
    await shiftBasedContract(s.employee.id);
    await app.prisma.timeEntry.create({
      data: {
        employeeId: s.employee.id,
        salonId: salonA,
        date: new Date(`${MON}T00:00:00Z`),
        startTime: new Date(`${MON}T08:00:00Z`),
        endTime: new Date(`${MON}T12:00:00Z`),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
      },
    });
    await shift(s.employee.id, salonA, MON, "08:00", "12:00", "A-Schicht");
    await shift(s.employee.id, salonB, TUE, "07:00", "11:00", "B-Schicht");
    await shift(s.employee.id, salonA, TUE, "13:00", "18:00", "A-Schicht");
    await shift(s.employee.id, salonB, THU, "09:00", "17:00", "B-Schicht");
    await shift(s.employee.id, salonA, FRI, "10:00", "18:00", "A-Schicht");
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("dashboard-shift-scope-548 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("Salonmanager of A, person homed in A with salon-B shifts", () => {
    it("1. Monday (only a B shift): the day equals a control person's day without a shift", async () => {
      const body = await week(maToken);
      const p = dayOf(body, ids.P, MON);
      expect(p.shift).toBeNull();
      expect(p.isWorkday).toBe(false);
      expect(p.status).toBe("none");
      expect(p.reason).toBeNull();
      expect(p.workedHours).toBe(0);
      expect(p.expectedHours).toBe(8);
      expect(p).toEqual(dayOf(body, ids.P2, MON));
    });

    it("2. Tuesday (B 07:00 and A 13:00): only the A shift is shown, even though B starts earlier", async () => {
      const p = dayOf(await week(maToken), ids.P, TUE);
      expect(p.shift).toEqual({
        startTime: "13:00",
        endTime: "18:00",
        label: "A-Schicht",
        color: null,
      });
      expect(p.isWorkday).toBe(true);
      expect(p.status).toBe("missing");
    });

    it("3. Friday (future, only a B shift): no shift, no workday, no scheduled signal", async () => {
      const body = await week(maToken);
      const p = dayOf(body, ids.P, FRI);
      expect(p.shift).toBeNull();
      expect(p.isWorkday).toBe(false);
      expect(p.status).toBe("none");
      expect(p).toEqual(dayOf(body, ids.P2, FRI));
    });

    it("4. filtered on A: the same values as without the filter", async () => {
      const body = await week(maToken, salonA);
      expect(dayOf(body, ids.P, MON)).toMatchObject({
        shift: null,
        isWorkday: false,
        status: "none",
      });
      expect(dayOf(body, ids.P, TUE)).toMatchObject({
        shift: { startTime: "13:00", label: "A-Schicht" },
        isWorkday: true,
        status: "missing",
      });
      expect(dayOf(body, ids.P, FRI)).toMatchObject({
        shift: null,
        isWorkday: false,
        status: "none",
      });
      expect(dayOf(body, ids.P, MON)).toEqual(dayOf(body, ids.P2, MON));
    });
  });

  describe("person-scoped reach", () => {
    it("5. PERSONS [P] sees P's shifts in every salon", async () => {
      const body = await week(mpToken);
      expect(dayOf(body, ids.P, MON)).toMatchObject({
        shift: { startTime: "08:00", endTime: "16:00", label: "B-Schicht", color: null },
        isWorkday: true,
        status: "missing",
      });
      expect(dayOf(body, ids.P, TUE).shift?.startTime).toBe("07:00");
      expect(dayOf(body, ids.P, FRI)).toMatchObject({
        shift: { startTime: "10:00", label: "B-Schicht" },
        status: "scheduled",
      });
    });
  });

  describe("whole-tenant caller", () => {
    it("6. the tenant admin sees every shift, the earliest first, and no workedElsewhere key", async () => {
      const body = await week(data.adminToken);
      expect(dayOf(body, ids.P, MON)).toMatchObject({
        shift: { startTime: "08:00", label: "B-Schicht" },
        isWorkday: true,
        status: "missing",
      });
      expect(dayOf(body, ids.P, TUE).shift?.startTime).toBe("07:00");
      expect(dayOf(body, ids.P, FRI)).toMatchObject({
        shift: { startTime: "10:00", label: "B-Schicht" },
        status: "scheduled",
      });
      for (const d of rowOf(body, ids.P)?.days ?? []) expect("workedElsewhere" in d).toBe(false);
    });

    it("7. the tenant admin filtered on A still sees P's Monday B shift", async () => {
      const body = await week(data.adminToken, salonA);
      expect(dayOf(body, ids.P, MON)).toMatchObject({
        shift: { startTime: "08:00", label: "B-Schicht" },
        isWorkday: true,
      });
    });
  });

  describe("entry-only Springer (Phase 85b D-04)", () => {
    it("8. S gets the in-scope shifts only, withheld planning data, and is never missing", async () => {
      const body = await week(maToken);
      const row = rowOf(body, ids.S);
      expect(row, "row S").toBeDefined();
      expect(row?.employeeNumber).toBeNull();
      for (const d of row?.days ?? []) {
        expect(d.isWorkday, d.date).toBe(false);
        expect(d.expectedHours, d.date).toBe(0);
        expect(d.status, d.date).not.toBe("missing");
        expect(d.status, d.date).not.toBe("absent");
      }
      const mon = dayOf(body, ids.S, MON);
      expect(mon.shift).toEqual({
        startTime: "08:00",
        endTime: "12:00",
        label: "A-Schicht",
        color: null,
      });
      expect(mon.status).toBe("present");
      expect(mon.workedHours).toBe(4);
      const tue = dayOf(body, ids.S, TUE);
      expect(tue.shift).toEqual({
        startTime: "13:00",
        endTime: "18:00",
        label: "A-Schicht",
        color: null,
      });
      expect(tue.status).toBe("none");
      const thu = dayOf(body, ids.S, THU);
      expect(thu.shift).toBeNull();
      expect(thu.status).toBe("none");
      const fri = dayOf(body, ids.S, FRI);
      expect(fri.shift).toEqual({
        startTime: "10:00",
        endTime: "18:00",
        label: "A-Schicht",
        color: null,
      });
      expect(fri.status).toBe("scheduled");

      // Same with the salon filter on A.
      const filtered = await week(maToken, salonA);
      expect(dayOf(filtered, ids.S, TUE).shift?.startTime).toBe("13:00");
      expect(dayOf(filtered, ids.S, THU).shift).toBeNull();

      // Whole-tenant contrast: the admin sees the B shifts and the contract-derived signals.
      const admin = await week(data.adminToken);
      expect(rowOf(admin, ids.S)?.employeeNumber).not.toBeNull();
      expect(dayOf(admin, ids.S, TUE).shift?.startTime).toBe("07:00");
      expect(dayOf(admin, ids.S, TUE).status).toBe("missing");
      expect(dayOf(admin, ids.S, THU).shift?.startTime).toBe("09:00");
      expect(dayOf(admin, ids.S, THU).status).toBe("scheduled");
    });
  });
});
