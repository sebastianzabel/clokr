/**
 * Issue #84 (AC-2, AC-3, AC-4, AC-6; D-03, D-04, D-06, D-08, D-15, D-18) — the salon filter of the
 * dashboard's week grid (`GET /api/v1/dashboard/team-week`) and of its leave list
 * (`GET /api/v1/dashboard/team-upcoming-leave`).
 *
 * What the team-week describe proves:
 * - Unfiltered, a person who worked in two salons is ONE row with the hours of both days, and the
 *   body carries neither a `salonId` key nor a `workedElsewhere` key (the 84-01 frozen pin proves
 *   the rest of the unfiltered response byte for byte).
 * - Filtered on a salon, membership follows the entry OR the Stammsalon on at least one week day,
 *   hours follow the entry's salon, and a day with valid time in another salon is flagged
 *   `workedElsewhere` instead of being shown as missing.
 * - Presence and everything around it (status, reason, leave, absence, shift, workday, expected
 *   hours) is identical in the filtered and the unfiltered response: the filter only removes rows
 *   and re-attributes hours, because presence and holidays use ALL of a person's entries (D-15).
 *
 * The team-upcoming-leave describe proves the list the dashboard card now reads instead of the
 * general leave list: calendar-day correct "today" (a leave ending today is listed), at most eight
 * approved requests, the Stammsalon of the remaining days under a filter, and the same reach rule
 * as the other team endpoints.
 *
 * No person names in fixtures. Fake clock Thu 2026-06-11T10:00:00Z (Date only), installed before
 * the app boots, so the tenant-local today is 2026-06-11 and the week under test is Mon
 * 2026-06-08 to Sun 2026-06-14.
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
} from "./../../__tests__/setup";
import { leaveTypeFields } from "../../contexts/absence/leave-type";
import { SYSTEM_ROLE_IDS } from "../../contexts/platform";

const PASSWORD = "test1234";
const WEEK_URL = "/api/v1/dashboard/team-week?date=2026-06-11";

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
type Row = { id: string; name: string; days: Day[] };
type Week = { weekDays: string[]; salonId?: string; team: Row[] };

const COMPARED_FIELDS = [
  "status",
  "reason",
  "leaveTypeCode",
  "absenceType",
  "shift",
  "isWorkday",
  "expectedHours",
] as const;

function uniqueSuffix(label: string): string {
  return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

describe("Issue #84 — dashboard team views with a salon filter", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-11T10:00:00.000Z"));
    app = await getTestApp();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await closeTestApp();
  });

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
        lastName: `${label}-Tf84`,
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

  function leave(
    employeeId: string,
    leaveTypeId: string,
    start: string,
    end: string,
    extra: Record<string, unknown> = {},
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId,
        startDate: new Date(`${start}T00:00:00Z`),
        endDate: new Date(`${end}T00:00:00Z`),
        days: 1,
        status: "APPROVED",
        ...extra,
      } as never,
    });
  }

  function get(token: string | null, url: string) {
    return app.inject({
      method: "GET",
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  async function week(token: string, salonId?: string): Promise<Week> {
    const res = await get(token, salonId ? `${WEEK_URL}&salonId=${salonId}` : WEEK_URL);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Week;
  }

  // ── Task 1 — team-week ────────────────────────────────────────────────────────────────────

  describe("team-week", () => {
    let data: Awaited<ReturnType<typeof seedTestData>>;
    let salonA: string;
    let salonB: string;
    let salonC: string;
    const ids: Record<"P" | "Q" | "S" | "V" | "W" | "U", string> = {
      P: "",
      Q: "",
      S: "",
      V: "",
      W: "",
      U: "",
    };

    beforeAll(async () => {
      data = await seedTestData(app, "tf84w");
      salonA = data.salonId;
      salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Tf84 B" })).id;
      salonC = (await createTestSalon(app.prisma, data.tenant.id, { name: "Tf84 C" })).id;
      const tenantId = data.tenant.id;
      const sick = await app.prisma.leaveType.create({
        data: { tenantId, ...leaveTypeFields("SICK"), color: "#EF4444" },
      });

      // P: Stammsalon A, Mon 6 h in A, Tue 3 h in B (the Springer of the rule).
      const p = await createPerson(tenantId, "P");
      ids.P = p.employee.id;
      await home(tenantId, p.employee.id, salonA);
      await entry(p.employee.id, salonA, "2026-06-08", "08:00", "14:00");
      await entry(p.employee.id, salonB, "2026-06-09", "08:00", "11:00");

      // Q: Stammsalon B, Wed 4 h in B.
      const q = await createPerson(tenantId, "Q");
      ids.Q = q.employee.id;
      await home(tenantId, q.employee.id, salonB);
      await entry(q.employee.id, salonB, "2026-06-10", "08:00", "12:00");

      // S: Stammsalon A, no entry, approved sick leave on Wednesday.
      const sPerson = await createPerson(tenantId, "S");
      ids.S = sPerson.employee.id;
      await home(tenantId, sPerson.employee.id, salonA);
      await leave(sPerson.employee.id, sick.id, "2026-06-10", "2026-06-10");

      // V: Stammsalon B, one entry Mon in A (listed under A by the entry alone).
      const v = await createPerson(tenantId, "V");
      ids.V = v.employee.id;
      await home(tenantId, v.employee.id, salonB);
      await entry(v.employee.id, salonA, "2026-06-08", "09:00", "12:00");

      // W: Stammsalon A until Tuesday, B from Wednesday, no entries at all.
      const w = await createPerson(tenantId, "W");
      ids.W = w.employee.id;
      await home(tenantId, w.employee.id, salonA, "2024-01-01", "2026-06-09");
      await home(tenantId, w.employee.id, salonB, "2026-06-10");

      // U: Stammsalon C, an entry Mon in C (belongs to neither A nor B).
      const u = await createPerson(tenantId, "U");
      ids.U = u.employee.id;
      await home(tenantId, u.employee.id, salonC);
      await entry(u.employee.id, salonC, "2026-06-08", "08:00", "12:00");
    });

    afterAll(async () => {
      try {
        await cleanupTestData(app, data.tenant.id);
      } catch (err) {
        console.error("dashboard-team-salon-filter-84 cleanup failed:", err);
      }
    });

    const rowOf = (body: Week, id: string) => body.team.find((r) => r.id === id);
    const dayOf = (row: Row | undefined, date: string) => row?.days.find((d) => d.date === date);
    const idsIn = (body: Week) =>
      Object.entries(ids)
        .filter(([, id]) => body.team.some((r) => r.id === id))
        .map(([key]) => key)
        .sort();

    it("unfiltered: a person who worked in two salons is one row with both days; no filter keys", async () => {
      const body = await week(data.adminToken);
      expect(body.team.filter((r) => r.id === ids.P)).toHaveLength(1);
      const p = rowOf(body, ids.P);
      expect(dayOf(p, "2026-06-08")?.workedHours).toBe(6);
      expect(dayOf(p, "2026-06-09")?.workedHours).toBe(3);
      expect(idsIn(body)).toEqual(["P", "Q", "S", "U", "V", "W"]);
      expect("salonId" in body).toBe(false);
      for (const row of body.team) {
        for (const d of row.days) expect("workedElsewhere" in d).toBe(false);
      }
    });

    it("salon A: rows by entry or Stammsalon, salon-A hours only, a Springer is not missing", async () => {
      const body = await week(data.adminToken, salonA);
      expect(body.salonId).toBe(salonA);
      // V by its A entry, W by Stammsalon A on Monday and Tuesday; neither Q nor U.
      expect(idsIn(body)).toEqual(["P", "S", "V", "W"]);
      const p = rowOf(body, ids.P);
      expect(dayOf(p, "2026-06-08")?.workedHours).toBe(6);
      expect(dayOf(p, "2026-06-08")?.workedElsewhere).toBe(false);
      expect(dayOf(p, "2026-06-09")?.workedHours).toBe(0);
      expect(dayOf(p, "2026-06-09")?.workedElsewhere).toBe(true);
      expect(dayOf(p, "2026-06-09")?.status).not.toBe("missing");
      expect(dayOf(rowOf(body, ids.V), "2026-06-08")?.workedHours).toBe(3);
      const sWed = dayOf(rowOf(body, ids.S), "2026-06-10");
      expect(sWed?.status).toBe("absent");
      expect(sWed?.leaveTypeCode).toBe("SICK");
      for (const row of body.team) {
        for (const d of row.days) expect(typeof d.workedElsewhere).toBe("boolean");
      }
    });

    it("salon B: the same person shows the other day's hours and Monday as worked elsewhere", async () => {
      const body = await week(data.adminToken, salonB);
      expect(body.salonId).toBe(salonB);
      expect(idsIn(body)).toEqual(["P", "Q", "V", "W"]);
      const p = rowOf(body, ids.P);
      expect(dayOf(p, "2026-06-08")?.workedHours).toBe(0);
      expect(dayOf(p, "2026-06-08")?.workedElsewhere).toBe(true);
      expect(dayOf(p, "2026-06-09")?.workedHours).toBe(3);
      const v = rowOf(body, ids.V);
      expect(dayOf(v, "2026-06-08")?.workedHours).toBe(0);
      expect(dayOf(v, "2026-06-08")?.workedElsewhere).toBe(true);
      expect(dayOf(rowOf(body, ids.Q), "2026-06-10")?.workedHours).toBe(4);
      expect(rowOf(body, ids.S)).toBeUndefined();
    });

    it("D-15: presence, leave, absence, shift and workday fields equal the unfiltered values", async () => {
      const unfiltered = await week(data.adminToken);
      for (const salon of [salonA, salonB]) {
        const filtered = await week(data.adminToken, salon);
        expect(filtered.team.length).toBeGreaterThan(0);
        for (const row of filtered.team) {
          const base = rowOf(unfiltered, row.id);
          expect(base, `row ${row.id} exists unfiltered`).toBeDefined();
          expect(row.days).toHaveLength(base!.days.length);
          for (const [i, d] of row.days.entries()) {
            for (const field of COMPARED_FIELDS) {
              expect(d[field], `${row.id} ${d.date} ${field}`).toEqual(base!.days[i][field]);
            }
          }
        }
      }
    });

    it("keeps the unfiltered row order (last name ascending) under a filter", async () => {
      const unfiltered = await week(data.adminToken);
      const filtered = await week(data.adminToken, salonB);
      const order = unfiltered.team.map((r) => r.id).filter((id) => rowOf(filtered, id));
      expect(filtered.team.map((r) => r.id)).toEqual(order);
    });

    it("answers 404 for an unknown salon and 400 for a malformed one", async () => {
      const unknown = await get(
        data.adminToken,
        `${WEEK_URL}&salonId=00000000-0000-4000-8000-000000000000`,
      );
      expect(unknown.statusCode).toBe(404);
      expect(JSON.parse(unknown.body)).toEqual({ error: "Salon nicht gefunden" });
      const malformed = await get(data.adminToken, `${WEEK_URL}&salonId=not-a-uuid`);
      expect(malformed.statusCode).toBe(400);
    });
  });

  // ── Task 2 — team-upcoming-leave ──────────────────────────────────────────────────────────

  describe("team-upcoming-leave", () => {
    type Item = {
      id: string;
      employeeId: string;
      employeeName: string;
      startDate: string;
      endDate: string;
      days: number;
      leaveTypeName: string;
      leaveTypeCode: string | null;
    };
    type Upcoming = { salonId: string | null; items: Item[] };

    let data: Awaited<ReturnType<typeof seedTestData>>;
    let salonA: string;
    let salonB: string;
    let managerToken: string;
    let xToday = "";
    let xJuly = "";
    let yId = "";
    let zId = "";
    let zEmployee = "";
    let xEmployee = "";

    async function upcoming(token: string | null, salonId?: string) {
      return get(
        token,
        salonId
          ? `/api/v1/dashboard/team-upcoming-leave?salonId=${salonId}`
          : "/api/v1/dashboard/team-upcoming-leave",
      );
    }
    async function items(token: string, salonId?: string): Promise<Upcoming> {
      const res = await upcoming(token, salonId);
      expect(res.statusCode, res.body).toBe(200);
      return JSON.parse(res.body) as Upcoming;
    }

    beforeAll(async () => {
      data = await seedTestData(app, "tf84u");
      salonA = data.salonId;
      salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Tf84u B" })).id;
      const tenantId = data.tenant.id;
      const vacation = data.vacationType.id;

      // X: Stammsalon A. One vacation that ends today and one in July.
      const x = await createPerson(tenantId, "X");
      xEmployee = x.employee.id;
      await home(tenantId, x.employee.id, salonA);
      xToday = (await leave(x.employee.id, vacation, "2026-06-11", "2026-06-11")).id;
      xJuly = (await leave(x.employee.id, vacation, "2026-07-01", "2026-07-03", { days: 3 })).id;
      // Never listed: pending, soft-deleted, ended yesterday.
      await leave(x.employee.id, vacation, "2026-08-01", "2026-08-01", { status: "PENDING" });
      await leave(x.employee.id, vacation, "2026-08-03", "2026-08-03", { deletedAt: new Date() });
      await leave(x.employee.id, vacation, "2026-06-10", "2026-06-10");

      // Y: Stammsalon B.
      const y = await createPerson(tenantId, "Y");
      await home(tenantId, y.employee.id, salonB);
      yId = (await leave(y.employee.id, vacation, "2026-06-20", "2026-06-22", { days: 3 })).id;

      // Z: Stammsalon A until 30.06., B from 01.07.; the request spans the change.
      const z = await createPerson(tenantId, "Z");
      zEmployee = z.employee.id;
      await home(tenantId, z.employee.id, salonA, "2024-01-01", "2026-06-30");
      await home(tenantId, z.employee.id, salonB, "2026-07-01");
      zId = (await leave(z.employee.id, vacation, "2026-06-29", "2026-07-02", { days: 4 })).id;

      // A Salonmanager of A (an employee of its own with no Stammsalon: not in anyone's reach).
      const manager = await createPerson(tenantId, "M");
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
      managerToken = (JSON.parse(login.body) as { accessToken: string }).accessToken;
    });

    afterAll(async () => {
      try {
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
        await cleanupTestData(app, data.tenant.id);
      } catch (err) {
        console.error("dashboard-team-salon-filter-84 upcoming cleanup failed:", err);
      }
    });

    it("unfiltered: ends-today included, ordered by start date, exact item shape, salonId null", async () => {
      const body = await items(data.adminToken);
      expect(body.salonId).toBeNull();
      expect(body.items.map((i) => i.id)).toEqual([xToday, yId, zId, xJuly]);
      expect(Object.keys(body.items[0]).sort()).toEqual(
        [
          "days",
          "employeeId",
          "employeeName",
          "endDate",
          "id",
          "leaveTypeCode",
          "leaveTypeName",
          "startDate",
        ].sort(),
      );
      expect(body.items[0]).toMatchObject({
        employeeId: xEmployee,
        employeeName: "X X-Tf84",
        startDate: "2026-06-11",
        endDate: "2026-06-11",
        days: 1,
        leaveTypeCode: "VACATION",
      });
      expect(body.items[3].days).toBe(3);
    });

    it("unfiltered equals the old leave list at midday (same ids, same order)", async () => {
      const old = await get(
        data.adminToken,
        "/api/v1/leave/requests?status=APPROVED&upcoming=true",
      );
      expect(old.statusCode, old.body).toBe(200);
      const oldIds = (JSON.parse(old.body) as Array<{ id: string }>).map((r) => r.id);
      const mine = (await items(data.adminToken)).items.map((i) => i.id);
      expect(oldIds).toContain(xToday);
      expect(mine).toEqual(oldIds);
    });

    it("the tenant-local day decides, not the UTC date (D-18)", async () => {
      // 22:30 UTC on 11.06. is 00:30 on 12.06. in the tenant time zone: the request that ended on
      // 11.06. is no longer upcoming. The old list compares the UTC date and still returns it.
      vi.setSystemTime(new Date("2026-06-11T22:30:00.000Z"));
      try {
        const token = reissueTokenNow(app, data.adminToken);
        const old = await get(token, "/api/v1/leave/requests?status=APPROVED&upcoming=true");
        expect(old.statusCode, old.body).toBe(200);
        const oldIds = (JSON.parse(old.body) as Array<{ id: string }>).map((r) => r.id);
        const mine = (await items(token)).items.map((i) => i.id);
        expect(oldIds).toContain(xToday);
        expect(mine).not.toContain(xToday);
        expect(mine).toEqual([yId, zId, xJuly]);
      } finally {
        vi.setSystemTime(new Date("2026-06-11T10:00:00.000Z"));
      }
    });

    it("salon A keeps the Stammsalon A person and the request spanning the change", async () => {
      const body = await items(data.adminToken, salonA);
      expect(body.salonId).toBe(salonA);
      expect(body.items.map((i) => i.id)).toEqual([xToday, zId, xJuly]);
    });

    it("salon B keeps the other person and the request spanning the change", async () => {
      const body = await items(data.adminToken, salonB);
      expect(body.items.map((i) => i.id)).toEqual([yId, zId]);
    });

    it("a Salonmanager of A sees only persons homed in A today", async () => {
      const body = await items(managerToken);
      expect(body.items.map((i) => i.id)).toEqual([xToday, zId, xJuly]);
      expect(body.items.some((i) => i.id === yId)).toBe(false);
    });

    it("plain employee 403, no token 401", async () => {
      expect((await upcoming(data.empToken)).statusCode).toBe(403);
      expect((await upcoming(null)).statusCode).toBe(401);
    });

    it("answers at most eight items, the eight earliest, after the filter", async () => {
      const vacation = data.vacationType.id;
      // Ten further requests of X (Stammsalon A) in September, one day each.
      for (let day = 1; day <= 10; day++) {
        const d = `2026-09-${String(day).padStart(2, "0")}`;
        await leave(xEmployee, vacation, d, d);
      }
      const all = await items(data.adminToken);
      expect(all.items).toHaveLength(8);
      const starts = all.items.map((i) => i.startDate);
      expect(starts).toEqual([...starts].sort());
      expect(all.items.map((i) => i.id).slice(0, 4)).toEqual([xToday, yId, zId, xJuly]);
      const filtered = await items(data.adminToken, salonA);
      expect(filtered.items).toHaveLength(8);
      expect(filtered.items.map((i) => i.id).slice(0, 3)).toEqual([xToday, zId, xJuly]);
      expect(
        filtered.items.every((i) => i.employeeId === xEmployee || i.employeeId === zEmployee),
      ).toBe(true);
    });
  });
});
