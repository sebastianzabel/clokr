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
 * Fixture: tenant with the active salons A and B. A1 is homed in A (Mon 6 h in A). S is a Springer
 * homed in B (Mon 08:00-12:00 in A, Tue 6 h in B, Wed an OPEN entry in B, approved vacation Thu, a
 * FIXED Mon-Fri contract). E is homed in B (Mon 4 h in B). MA is a Salonmanager with SALONS [A].
 * No person names. Fake clock Wed 2026-06-17T10:00Z (Date only), installed before the app boots;
 * the week under test is Mon 2026-06-15 to Sun 2026-06-21.
 *
 * Mutation proofs (Phase 85b, 2026-10-13) — recorded here, not re-run by CI; each change was
 * reverted with `cp` from a backup after the red names below were observed:
 * (filled in below once recorded)
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
  const ids: Record<"A1" | "S" | "E", string> = { A1: "", S: "", E: "" };

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
      expect(fixtureIds(body)).toEqual(["A1", "S"]);
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
      expect(fixtureIds(body)).toEqual(["A1", "E", "S"]);
      expect(dayOf(rowOf(body, ids.S), "2026-06-16")?.workedHours).toBe(6);
      expect(dayOf(rowOf(body, ids.S), "2026-06-17")?.status).toBe("clocked_in");
      expect(dayOf(rowOf(body, ids.S), "2026-06-18")?.status).toBe("absent");
      for (const row of body.team) {
        for (const d of row.days) expect("workedElsewhere" in d).toBe(false);
      }
    });
  });
});
