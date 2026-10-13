/**
 * Issue #84 (AC-5; D-02, D-16) — a manipulated `salonId` on the dashboard's team endpoints yields
 * no foreign data. The salon filter of the web is presentation only (DSGVO Art. 32, #82 D-05): the
 * server validates it on every endpoint and it can only NARROW what the caller may already see.
 * "Manipulated" means the frontend sends a `salonId` it should not have — a salon outside the
 * caller's reach, a salon of another tenant, an own salon that has been deactivated, or an id that
 * exists nowhere — and the server must not care what the frontend believes.
 *
 * Endpoints under test: `GET /dashboard/team-week`, `GET /dashboard/team-trend` and
 * `GET /dashboard/team-upcoming-leave`.
 *
 * Fixture: tenant T with the active salons A and B and the deactivated salon C; Salonmanager M
 * holds SALONS [A]. E is homed in B on purpose, so that B's data is truly foreign to M: E has time
 * in B this week, an approved sick leave last month and an approved vacation next month. S is a
 * Springer homed in B with ONE entry in A: the widening probe — had the filter been allowed to add
 * people by entry, M filtered on A would list S, although S is outside M's reach. The tenant-wide
 * admin sends the same requests as the control: the data exists, the absence for M is the scope,
 * not an empty fixture. The foreign tenant F has its own salon and its own owner.
 *
 * Mutation proof (Phase 84, 2026-10-12) — recorded here, not re-run by CI; each change was
 * reverted with `cp` from a backup after the red names below were observed:
 * M1 the validator skips the scoped-reach check → red on all three "the Salonmanager gets
 *    byte-identical 404s for a salon out of reach, …" tests (salon B answered 200).
 * M2 the validator looks the salon up without the tenant (`salon.findFirst` by id) → red on the
 *    three "the tenant admin gets the same 404 for a foreign salon, …" tests and on "a foreign
 *    tenant's owner cannot select the tenant's salon either" (the foreign salon answered 200).
 * M3 the validator drops the `isActive` check → red on the three "the tenant admin gets the same
 *    404 for a foreign salon, an unknown id and a deactivated salon" tests (salon C answered 200).
 * M4 team-week narrows by Stammsalon only (ignores the entry) → red in
 *    dashboard-team-salon-filter-84 on "salon A: rows by entry or Stammsalon, …" and "salon B: the
 *    same person shows the other day's hours …" (V missing), and here on "control: the tenant
 *    admin filtered on A sees the Springer S by his A entry".
 *
 * Amendment 2026-10-13 (Phase 85b, Issue #85 D-04): the widening probe is reversed on purpose —
 * per-entry scope adds a Springer by an in-scope entry with only those hours (Phase 84 left this
 * until #85). The salon filter still never widens the reach: S is listed because the reach covers
 * S's A entry, not because of the filter. E (homed in B, entries only in B) stays invisible on
 * every endpoint; the trend and upcoming-leave assertions below are unchanged by this amendment.
 *
 * Harness: fake clock Wed 2026-06-17T10:00Z (Date only) installed BEFORE the app boots. The week
 * under test is Mon 2026-06-15 to Sun 2026-06-21. No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";
const E_LABEL = "Probe84E";
const S_LABEL = "Probe84S";

const ENDPOINTS = [
  { name: "team-week", url: "/api/v1/dashboard/team-week?date=2026-06-17" },
  { name: "team-trend", url: "/api/v1/dashboard/team-trend?months=6" },
  { name: "team-upcoming-leave", url: "/api/v1/dashboard/team-upcoming-leave" },
] as const;

type Endpoint = (typeof ENDPOINTS)[number];

describe("Issue #84 — a manipulated salon filter yields no foreign data", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  let salonC: string;
  let salonF: string;
  let employeeE: { id: string };
  let employeeS: { id: string };
  let managerToken: string;

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string, tenantId: string) {
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
        lastName: "Man84",
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

  function entry(employeeId: string, salonId: string, date: string, end: string) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T08:00:00Z`),
        endTime: new Date(`${date}T${end}:00Z`),
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
    days: number,
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId,
        startDate: new Date(`${start}T00:00:00Z`),
        endDate: new Date(`${end}T00:00:00Z`),
        days,
        status: "APPROVED",
      },
    });
  }

  function get(token: string, endpoint: Endpoint, salonId?: string) {
    const sep = endpoint.url.includes("?") ? "&" : "?";
    const url = salonId ? `${endpoint.url}${sep}salonId=${salonId}` : endpoint.url;
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-17T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "man84t");
    foreign = await seedTestData(app, "man84f");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Man84 B" })).id;
    salonC = (
      await createTestSalon(app.prisma, data.tenant.id, { name: "Man84 C", isActive: false })
    ).id;
    salonF = foreign.salonId;

    const tenantId = data.tenant.id;
    const sick = await app.prisma.leaveType.create({
      data: { tenantId, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });

    const manager = await createEmployee("Manager84", tenantId);
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

    // E: Stammsalon B, time in B this week, sick last month, vacation next month.
    const e = await createEmployee(E_LABEL, tenantId);
    employeeE = e.employee;
    await home(tenantId, employeeE.id, salonB);
    await entry(employeeE.id, salonB, "2026-06-15", "14:00"); // 360 min
    await leave(employeeE.id, sick.id, "2026-05-12", "2026-05-13", 2);
    await leave(employeeE.id, data.vacationType.id, "2026-07-06", "2026-07-07", 2);

    // S: the Springer, Stammsalon B, one entry in A.
    const sPerson = await createEmployee(S_LABEL, tenantId);
    employeeS = sPerson.employee;
    await home(tenantId, employeeS.id, salonB);
    await entry(employeeS.id, salonA, "2026-06-16", "12:00"); // 240 min in A

    // The foreign tenant has people and a salon of its own; none of it may meet T's people.
    const ef = await createEmployee("Foreign84", foreign.tenant.id);
    await home(foreign.tenant.id, ef.employee.id, salonF);
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("dashboard-salon-manipulation-84 cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── The control: the data exists (anti-vacuity) ───────────────────────────────────────────

  it("control: the tenant admin filtered on B sees E on all three endpoints", async () => {
    const week = await get(data.adminToken, ENDPOINTS[0], salonB);
    expect(week.statusCode, week.body).toBe(200);
    const row = (
      JSON.parse(week.body) as {
        team: Array<{ id: string; days: Array<{ date: string; workedHours: number }> }>;
      }
    ).team.find((r) => r.id === employeeE.id);
    expect(row, "E is listed under B").toBeDefined();
    expect(row?.days.find((d) => d.date === "2026-06-15")?.workedHours).toBe(6);

    const trend = await get(data.adminToken, ENDPOINTS[1], salonB);
    expect(trend.statusCode, trend.body).toBe(200);
    const months = (
      JSON.parse(trend.body) as {
        months: Array<{ month: string; workedMinutes: number; sickDays: number }>;
      }
    ).months;
    expect(months.find((m) => m.month === "2026-06")?.workedMinutes).toBe(360);
    expect(months.find((m) => m.month === "2026-05")?.sickDays).toBe(2);

    const upcoming = await get(data.adminToken, ENDPOINTS[2], salonB);
    expect(upcoming.statusCode, upcoming.body).toBe(200);
    const items = (JSON.parse(upcoming.body) as { items: Array<{ employeeId: string }> }).items;
    expect(items.map((i) => i.employeeId)).toContain(employeeE.id);
  });

  it("control: the tenant admin filtered on A sees the Springer S by his A entry", async () => {
    const week = await get(data.adminToken, ENDPOINTS[0], salonA);
    expect(week.statusCode, week.body).toBe(200);
    const ids = (JSON.parse(week.body) as { team: Array<{ id: string }> }).team.map((r) => r.id);
    expect(ids).toContain(employeeS.id);
    expect(ids).not.toContain(employeeE.id);
  });

  // ── Rejections: one status, one body, whatever the cause ──────────────────────────────────

  for (const endpoint of ENDPOINTS) {
    it(`${endpoint.name}: the Salonmanager gets byte-identical 404s for a salon out of reach, a foreign salon, a deactivated salon and an unknown id`, async () => {
      const responses = [];
      for (const salonId of [salonB, salonC, salonF, randomUUID()]) {
        responses.push(await get(managerToken, endpoint, salonId));
      }
      for (const res of responses) expect(res.statusCode, res.body).toBe(404);
      const bodies = new Set(responses.map((r) => r.body));
      expect(bodies.size).toBe(1);
      expect([...bodies][0]).toBe('{"error":"Salon nicht gefunden"}');
    });

    it(`${endpoint.name}: the Salonmanager's own salon answers 200, a malformed id answers 400`, async () => {
      const own = await get(managerToken, endpoint, salonA);
      expect(own.statusCode, own.body).toBe(200);
      const malformed = await get(managerToken, endpoint, "not-a-uuid");
      expect(malformed.statusCode, malformed.body).toBe(400);
    });

    it(`${endpoint.name}: the tenant admin gets the same 404 for a foreign salon, an unknown id and a deactivated salon`, async () => {
      const responses = [];
      for (const salonId of [salonF, randomUUID(), salonC]) {
        responses.push(await get(data.adminToken, endpoint, salonId));
      }
      for (const res of responses) expect(res.statusCode, res.body).toBe(404);
      expect(new Set(responses.map((r) => r.body)).size).toBe(1);
      const ok = await get(data.adminToken, endpoint, salonB);
      expect(ok.statusCode, ok.body).toBe(200);
    });
  }

  // ── The filter never widens a reach ───────────────────────────────────────────────────────

  it("the Salonmanager filtered on A sees S by the A entry (4 h on 16.06, nothing else) and nothing of E", async () => {
    const week = await get(managerToken, ENDPOINTS[0], salonA);
    expect(week.statusCode, week.body).toBe(200);
    const rows = (
      JSON.parse(week.body) as {
        team: Array<{
          id: string;
          employeeNumber: string | null;
          days: Array<{ date: string; workedHours: number; workedElsewhere?: boolean }>;
        }>;
      }
    ).team;
    expect(rows.map((r) => r.id)).not.toContain(employeeE.id);
    expect(week.body).not.toContain(E_LABEL);
    // Per-entry scope (see the header amendment, D-04): S is homed in B, but the reach covers S's entry in
    // A, so S is listed with exactly those 4 hours and no other figure.
    const s = rows.find((r) => r.id === employeeS.id);
    expect(s, "S is listed by the in-scope entry").toBeDefined();
    expect(s?.employeeNumber).toBeNull();
    for (const d of s?.days ?? []) {
      expect(d.workedHours, d.date).toBe(d.date === "2026-06-16" ? 4 : 0);
      expect(d.workedElsewhere, d.date).toBe(false);
    }

    const trend = await get(managerToken, ENDPOINTS[1], salonA);
    expect(trend.statusCode, trend.body).toBe(200);
    for (const m of (
      JSON.parse(trend.body) as { months: Array<{ workedMinutes: number; sickDays: number }> }
    ).months) {
      expect(m.workedMinutes).toBe(0);
      expect(m.sickDays).toBe(0);
    }

    const upcoming = await get(managerToken, ENDPOINTS[2], salonA);
    expect(upcoming.statusCode, upcoming.body).toBe(200);
    expect((JSON.parse(upcoming.body) as { items: unknown[] }).items).toEqual([]);
  });

  it("the Salonmanager unfiltered sees nothing of E either (the reach, not the filter, is the boundary)", async () => {
    for (const endpoint of ENDPOINTS) {
      const res = await get(managerToken, endpoint);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body, endpoint.name).not.toContain(E_LABEL);
      expect(res.body, endpoint.name).not.toContain(employeeE.id);
    }
  });

  // ── Another tenant's owner ────────────────────────────────────────────────────────────────

  it("a foreign tenant's owner sees none of the tenant's people, salons or figures", async () => {
    for (const endpoint of ENDPOINTS) {
      const res = await get(foreign.adminToken, endpoint);
      expect(res.statusCode, `${endpoint.name} ${res.body}`).toBe(200);
      for (const needle of [E_LABEL, S_LABEL, employeeE.id, employeeS.id, salonA, salonB, salonC]) {
        expect(res.body, `${endpoint.name} must not contain ${needle}`).not.toContain(needle);
      }
    }
    const trend = await get(foreign.adminToken, ENDPOINTS[1]);
    for (const m of (
      JSON.parse(trend.body) as { months: Array<{ workedMinutes: number; sickDays: number }> }
    ).months) {
      expect(m.workedMinutes).toBe(0);
      expect(m.sickDays).toBe(0);
    }
    const upcoming = await get(foreign.adminToken, ENDPOINTS[2]);
    expect((JSON.parse(upcoming.body) as { items: unknown[] }).items).toEqual([]);
  });

  it("a foreign tenant's owner cannot select the tenant's salon either", async () => {
    for (const endpoint of ENDPOINTS) {
      const res = await get(foreign.adminToken, endpoint, salonB);
      expect(res.statusCode, `${endpoint.name} ${res.body}`).toBe(404);
      expect(res.body).toBe('{"error":"Salon nicht gefunden"}');
    }
  });
});
