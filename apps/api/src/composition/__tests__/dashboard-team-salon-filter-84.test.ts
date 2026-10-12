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
} from "./../../__tests__/setup";
import { leaveTypeFields } from "../../contexts/absence/leave-type";

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
});
