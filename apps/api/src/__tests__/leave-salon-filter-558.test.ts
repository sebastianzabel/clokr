/**
 * Issue #558 (D-01/D-02/D-08/D-09) — the leave reads of the team pages take an optional `salonId`.
 * Leave follows the Stammsalon per day through the ONE Abwesenheiten function
 * (`filterLeaveRowsToHomeSalon`); the salon only narrows; one validator (`resolveSalonInReach`),
 * one 404 body for every rejection cause (T-100-09).
 *
 * Fixture (fake clock 2026-06-15T10:00Z, installed BEFORE the app boots): tenant T with salons A, B
 * and an inactive salon I, a foreign tenant with salon F. pA is homed in A; pX in A until
 * 2026-06-14 and in B from 2026-06-15; the springer is homed in B with a DEPLOYMENT in A; pB is
 * homed in B; pY in A until 2026-06-30 and in B from 2026-07-01. No person names.
 *
 * Mutation proof (Phase 558, 2026-10-16) — recorded here, not re-run by CI; each change was
 * reverted with cp afterwards:
 * M1 `GET /leave/requests`: the rejected salon is no longer answered with 404 (the chosen salon is
 *    used as sent) → red: "a Salonmanager of A gets the rows of A within the own person reach; B
 *    is the same 404 as unknown", "the admin gets the identical 404 for a foreign, an unknown and
 *    an inactive salon", "a caller with only the own-data reach gets the same 404 (no divergent
 *    403)" (3 failed | 12 passed).
 * M2 the per-day attribution reduced to ONE day (the row's last day only) → red: "the admin's list
 *    under ?salonId=A holds the requests homed in A on one of their days", "the approval queue is
 *    filtered too …", "a Salonmanager of A gets the rows of A …", "June, salon A: leave of pA, pX,
 *    pY …" (4 failed | 11 passed).
 * M3 `GET /leave/calendar`: the shown-month window dropped from the filter → red: "July is clipped
 *    to July: pY (Stammsalon B from 1 July) is absent for A and present for B" (1 failed | 14
 *    passed).
 * M4 `GET /leave/section9`: the chosen salon is used as sent, the validator's rejection removed
 *    → red: "the manager of A asking for B, an unknown, a foreign or an inactive salon gets one
 *    404", "the admin gets the identical 404 for a foreign, an unknown and an inactive salon", "a
 *    caller with only the own-data reach gets the same 404 with a salon" (3 failed | 23 passed).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import { leaveTypeFields } from "../contexts/absence/leave-type";

const PASSWORD = "test1234";
const NOT_FOUND = '{"error":"Salon nicht gefunden"}';

describe("Issue #558 — leave reads follow the salon filter", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let single: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonI: { id: string };
  let salonF: { id: string };
  let managerToken: string;
  const emp: Record<string, string> = {};
  const req: Record<string, string> = {};

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string, tenantId: string) {
    const s = uniqueSuffix(label);
    const user = await app.prisma.user.create({
      data: {
        email: `${s}@example.invalid`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "Leave558",
        hireDate: new Date("2024-01-01"),
      },
    });
    return { user, employee };
  }

  function assignment(
    employeeId: string,
    salonId: string,
    kind: "HOME" | "DEPLOYMENT",
    validFrom: string,
    validUntil: string | null,
  ) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind,
        validFrom: new Date(`${validFrom}T00:00:00Z`),
        validUntil: validUntil ? new Date(`${validUntil}T00:00:00Z`) : null,
        weekdays: [],
      },
    });
  }

  function leave(
    key: string,
    employeeKey: string,
    start: string,
    end: string,
    status: "APPROVED" | "PENDING",
  ) {
    return app.prisma.leaveRequest
      .create({
        data: {
          employeeId: emp[employeeKey],
          leaveTypeId: data.vacationType.id,
          startDate: new Date(`${start}T00:00:00Z`),
          endDate: new Date(`${end}T00:00:00Z`),
          days: 1,
          status,
        },
      })
      .then((row) => {
        req[key] = row.id;
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

  function get(token: string, url: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }

  async function requestIds(token: string, qs: string): Promise<string[]> {
    const res = await get(token, `/api/v1/leave/requests${qs}`);
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { id: string }[]).map((r) => r.id);
  }

  type CalendarEntry = { id: string; isHoliday: boolean } & Record<string, unknown>;
  async function calendar(token: string, qs: string): Promise<CalendarEntry[]> {
    const res = await get(token, `/api/v1/leave/calendar?${qs}`);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as CalendarEntry[];
  }

  const sorted = (ids: string[]) => [...ids].sort((a, b) => a.localeCompare(b));
  const keys = (...names: string[]) => sorted(names.map((n) => req[n]));

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "lv558");
    foreign = await seedTestData(app, "lv558f");
    single = await seedTestData(app, "lv558s");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Nord" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Ost" });
    salonI = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Salon Alt",
      isActive: false,
    });
    salonF = await createTestSalon(app.prisma, foreign.tenant.id, { name: "Salon Fremd" });

    const manager = await createEmployee("manager", data.tenant.id);
    await assignment(manager.employee.id, salonA.id, "HOME", "2024-01-01", null);
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: manager.user.id,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds: [salonA.id],
        employeeIds: [],
      },
    });
    managerToken = await login(manager.user.email);

    for (const label of ["pA", "pX", "springer", "pB", "pY"]) {
      emp[label] = (await createEmployee(label, data.tenant.id)).employee.id;
    }
    await assignment(emp.pA, salonA.id, "HOME", "2024-01-01", null);
    await assignment(emp.pX, salonA.id, "HOME", "2024-01-01", "2026-06-14");
    await assignment(emp.pX, salonB.id, "HOME", "2026-06-15", null);
    await assignment(emp.springer, salonB.id, "HOME", "2024-01-01", null);
    await assignment(emp.springer, salonA.id, "DEPLOYMENT", "2026-06-01", "2026-12-31");
    await assignment(emp.pB, salonB.id, "HOME", "2024-01-01", null);
    await assignment(emp.pY, salonA.id, "HOME", "2024-01-01", "2026-06-30");
    await assignment(emp.pY, salonB.id, "HOME", "2026-07-01", null);

    await leave("pA", "pA", "2026-06-01", "2026-06-03", "APPROVED");
    await leave("pX", "pX", "2026-06-10", "2026-06-20", "APPROVED");
    await leave("springer", "springer", "2026-06-22", "2026-06-24", "APPROVED");
    await leave("pB", "pB", "2026-07-06", "2026-07-08", "APPROVED");
    await leave("pY", "pY", "2026-06-29", "2026-07-02", "APPROVED");
    await leave("pAPending", "pA", "2026-07-13", "2026-07-14", "PENDING");
    await leave("pBPending", "pB", "2026-07-20", "2026-07-21", "PENDING");

    // Single-salon tenant: the seed employee has no HOME row at all.
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: single.employee.id,
        leaveTypeId: single.vacationType.id,
        startDate: new Date("2026-06-08T00:00:00Z"),
        endDate: new Date("2026-06-09T00:00:00Z"),
        days: 2,
        status: "APPROVED",
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
      await cleanupTestData(app, single.tenant.id);
    } catch (err) {
      console.error("leave-salon-filter-558 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("GET /leave/requests", () => {
    it("the admin's list under ?salonId=A holds the requests homed in A on one of their days", async () => {
      const ids = await requestIds(data.adminToken, `?salonId=${salonA.id}`);
      expect(sorted(ids)).toEqual(keys("pA", "pAPending", "pX", "pY"));
    });

    it("under ?salonId=B the springer is listed (home salon B) — and never under A", async () => {
      const idsB = await requestIds(data.adminToken, `?salonId=${salonB.id}`);
      expect(sorted(idsB)).toEqual(keys("pX", "springer", "pB", "pBPending", "pY"));
      const idsA = await requestIds(data.adminToken, `?salonId=${salonA.id}`);
      expect(idsA).not.toContain(req.springer);
    });

    it("the approval queue is filtered too (status=PENDING) and ?year does not change the set", async () => {
      expect(await requestIds(data.adminToken, `?status=PENDING&salonId=${salonA.id}`)).toEqual([
        req.pAPending,
      ]);
      expect(sorted(await requestIds(data.adminToken, `?year=2026&salonId=${salonA.id}`))).toEqual(
        keys("pA", "pAPending", "pX", "pY"),
      );
    });

    it("a Salonmanager of A gets the rows of A within the own person reach; B is the same 404 as unknown", async () => {
      const ids = await requestIds(managerToken, `?salonId=${salonA.id}`);
      // pX is homed in B today (2026-06-15): outside the manager's person reach, so the salon
      // filter intersects with that reach and never widens it.
      expect(sorted(ids)).toEqual(keys("pA", "pAPending", "pY"));

      const unknown = await get(managerToken, `/api/v1/leave/requests?salonId=${randomUUID()}`);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.body).toBe(NOT_FOUND);
      for (const id of [salonB.id, salonF.id, salonI.id]) {
        const res = await get(managerToken, `/api/v1/leave/requests?salonId=${id}`);
        expect(res.statusCode).toBe(404);
        expect(res.body).toBe(unknown.body);
      }
    });

    it("the admin gets the identical 404 for a foreign, an unknown and an inactive salon", async () => {
      for (const id of [salonF.id, randomUUID(), salonI.id]) {
        const res = await get(data.adminToken, `/api/v1/leave/requests?salonId=${id}`);
        expect(res.statusCode).toBe(404);
        expect(res.body).toBe(NOT_FOUND);
      }
    });

    it("a caller with only the own-data reach gets the same 404 (no divergent 403)", async () => {
      const res = await get(data.empToken, `/api/v1/leave/requests?salonId=${salonA.id}`);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(NOT_FOUND);
    });

    it("without salonId every fixture row is listed and a malformed salonId is a 400", async () => {
      const ids = await requestIds(data.adminToken, "");
      expect(ids).toEqual(
        expect.arrayContaining(keys("pA", "pX", "springer", "pB", "pY", "pAPending", "pBPending")),
      );
      const bad = await get(data.adminToken, "/api/v1/leave/requests?salonId=bad");
      expect(bad.statusCode).toBe(400);
    });

    it("a filtered row has the same key set as the same row unfiltered", async () => {
      const full = (
        await (async () => {
          const res = await get(data.adminToken, "/api/v1/leave/requests");
          return JSON.parse(res.body) as Record<string, unknown>[];
        })()
      ).find((r) => r.id === req.pA);
      const filtered = (
        await (async () => {
          const res = await get(data.adminToken, `/api/v1/leave/requests?salonId=${salonA.id}`);
          return JSON.parse(res.body) as Record<string, unknown>[];
        })()
      ).find((r) => r.id === req.pA);
      expect(full).toBeDefined();
      expect(sorted(Object.keys(filtered ?? {}))).toEqual(sorted(Object.keys(full ?? {})));
    });

    it("a single-salon tenant's unfiltered list shows the request although no HOME row exists", async () => {
      const ids = await requestIds(single.adminToken, "");
      expect(ids).toHaveLength(1);
    });
  });

  describe("GET /leave/calendar", () => {
    const leaveOf = (entries: CalendarEntry[]) =>
      sorted(entries.filter((e) => !e.isHoliday).map((e) => e.id));

    it("June, salon A: leave of pA, pX, pY; holiday entries unchanged", async () => {
      const filtered = await calendar(data.adminToken, `year=2026&month=6&salonId=${salonA.id}`);
      expect(leaveOf(filtered)).toEqual(keys("pA", "pX", "pY"));
      const full = await calendar(data.adminToken, "year=2026&month=6");
      expect(filtered.filter((e) => e.isHoliday)).toEqual(full.filter((e) => e.isHoliday));
      expect(leaveOf(full)).toEqual(keys("pA", "pX", "springer", "pY"));
    });

    it("July is clipped to July: pY (Stammsalon B from 1 July) is absent for A and present for B", async () => {
      const a = await calendar(data.adminToken, `year=2026&month=7&salonId=${salonA.id}`);
      expect(leaveOf(a)).toEqual(keys("pAPending"));
      const b = await calendar(data.adminToken, `year=2026&month=7&salonId=${salonB.id}`);
      expect(leaveOf(b)).toEqual(keys("pB", "pBPending", "pY"));
    });

    it("a filtered entry has the same key set as the unfiltered one", async () => {
      const full = (await calendar(data.adminToken, "year=2026&month=6")).find(
        (e) => e.id === req.pA,
      );
      const filtered = (
        await calendar(data.adminToken, `year=2026&month=6&salonId=${salonA.id}`)
      ).find((e) => e.id === req.pA);
      expect(full).toBeDefined();
      expect(sorted(Object.keys(filtered ?? {}))).toEqual(sorted(Object.keys(full ?? {})));
    });

    it("the manager of A asking for B, an unknown, a foreign or an inactive salon gets one 404", async () => {
      for (const id of [salonB.id, randomUUID(), salonF.id, salonI.id]) {
        const res = await get(
          managerToken,
          `/api/v1/leave/calendar?year=2026&month=6&salonId=${id}`,
        );
        expect(res.statusCode).toBe(404);
        expect(res.body).toBe(NOT_FOUND);
      }
    });

    it("the own-data caller keeps the unfiltered 200 and gets the same 404 with a salon", async () => {
      const ok = await get(data.empToken, "/api/v1/leave/calendar?year=2026&month=6");
      expect(ok.statusCode).toBe(200);
      const res = await get(
        data.empToken,
        `/api/v1/leave/calendar?year=2026&month=6&salonId=${salonA.id}`,
      );
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(NOT_FOUND);
    });

    it("a malformed salonId is a 400", async () => {
      const res = await get(
        data.adminToken,
        "/api/v1/leave/calendar?year=2026&month=6&salonId=bad",
      );
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /leave/ical/team", () => {
    let absenceA: string;
    const uid = (kind: "leave" | "absence", id: string) => `UID:${kind}-${id}@clokr`;

    async function ical(token: string, qs = "") {
      const res = await get(token, `/api/v1/leave/ical/team${qs}`);
      return res;
    }

    beforeAll(async () => {
      // An imposed absence of pA in June (an Absence row, never a LeaveRequest).
      const absence = await app.prisma.absence.create({
        data: {
          employeeId: emp.pA,
          type: "VOCATIONAL_SCHOOL",
          startDate: new Date("2026-06-16T00:00:00Z"),
          endDate: new Date("2026-06-16T00:00:00Z"),
          days: 1,
          createdBy: data.adminUser.id,
        },
      });
      absenceA = absence.id;
    });

    it("?salonId=A keeps the events of pA, pX and pY and the absence of pA — none of the springer or pB", async () => {
      const res = await ical(data.adminToken, `?salonId=${salonA.id}`);
      expect(res.statusCode, res.body).toBe(200);
      for (const key of ["pA", "pX", "pY"]) {
        expect(res.body, key).toContain(uid("leave", req[key]));
      }
      expect(res.body).toContain(uid("absence", absenceA));
      for (const key of ["springer", "pB"]) {
        expect(res.body, key).not.toContain(uid("leave", req[key]));
      }
    });

    it("without salonId every fixture event is present", async () => {
      const res = await ical(data.adminToken);
      expect(res.statusCode, res.body).toBe(200);
      for (const key of ["pA", "pX", "springer", "pB", "pY"]) {
        expect(res.body, key).toContain(uid("leave", req[key]));
      }
      expect(res.body).toContain(uid("absence", absenceA));
    });

    it("the manager of A asking for B, an unknown, a foreign or an inactive salon gets one 404", async () => {
      for (const id of [salonB.id, randomUUID(), salonF.id, salonI.id]) {
        const res = await ical(managerToken, `?salonId=${id}`);
        expect(res.statusCode).toBe(404);
        expect(res.body).toBe(NOT_FOUND);
      }
    });

    it("the guard stays: a caller without the ZUGEWIESEN reach is refused (403), with or without a salon", async () => {
      expect((await ical(data.empToken)).statusCode).toBe(403);
      expect((await ical(data.empToken, `?salonId=${salonA.id}`)).statusCode).toBe(403);
    });

    it("a malformed salonId is a 400", async () => {
      expect((await ical(data.adminToken, "?salonId=bad")).statusCode).toBe(400);
    });
  });

  describe("GET /leave/section9", () => {
    let s9: Awaited<ReturnType<typeof seedTestData>>;
    let s9SalonA: { id: string };
    let s9SalonB: { id: string };
    let s9SalonI: { id: string };
    let s9ManagerToken: string;
    let creditA: string;
    let creditB: string;

    async function seedCase(label: string, salonId: string, overlapDay: string) {
      const { employee } = await createEmployee(label, s9.tenant.id);
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: s9.tenant.id,
          employeeId: employee.id,
          salonId,
          kind: "HOME",
          validFrom: new Date("2024-01-01T00:00:00Z"),
          weekdays: [],
        },
      });
      const sickType = await app.prisma.leaveType.findFirstOrThrow({
        where: { tenantId: s9.tenant.id, code: "SICK" },
      });
      const mk = (leaveTypeId: string) =>
        app.prisma.leaveRequest.create({
          data: {
            employeeId: employee.id,
            leaveTypeId,
            startDate: new Date(`${overlapDay}T00:00:00Z`),
            endDate: new Date(`${overlapDay}T00:00:00Z`),
            days: 1,
            status: "APPROVED",
          },
        });
      const sick = await mk(sickType.id);
      const vacation = await mk(s9.vacationType.id);
      const credit = await app.prisma.section9Credit.create({
        data: {
          employeeId: employee.id,
          sickRequestId: sick.id,
          vacationRequestId: vacation.id,
          overlapStart: new Date(`${overlapDay}T00:00:00Z`),
          overlapEnd: new Date(`${overlapDay}T00:00:00Z`),
        },
      });
      return credit.id;
    }

    async function cases(token: string, qs = ""): Promise<string[]> {
      const res = await get(token, `/api/v1/leave/section9${qs}`);
      expect(res.statusCode, res.body).toBe(200);
      return (JSON.parse(res.body) as { id: string }[]).map((r) => r.id);
    }

    beforeAll(async () => {
      // A tenant of its own: the extra sick requests must not enter the exact sets above.
      s9 = await seedTestData(app, "lv558s9");
      s9SalonA = await createTestSalon(app.prisma, s9.tenant.id, { name: "Salon Nord" });
      s9SalonB = await createTestSalon(app.prisma, s9.tenant.id, { name: "Salon Ost" });
      s9SalonI = await createTestSalon(app.prisma, s9.tenant.id, {
        name: "Salon Alt",
        isActive: false,
      });
      await app.prisma.leaveType.create({
        data: { tenantId: s9.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
      });
      creditA = await seedCase("c9A", s9SalonA.id, "2026-06-10");
      creditB = await seedCase("c9B", s9SalonB.id, "2026-07-08");

      const manager = await createEmployee("manager9", s9.tenant.id);
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: s9.tenant.id,
          employeeId: manager.employee.id,
          salonId: s9SalonA.id,
          kind: "HOME",
          validFrom: new Date("2024-01-01T00:00:00Z"),
          weekdays: [],
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: s9.tenant.id,
          userId: manager.user.id,
          accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
          scopeType: "SALONS",
          salonIds: [s9SalonA.id],
          employeeIds: [],
        },
      });
      s9ManagerToken = await login(manager.user.email);
    });

    afterAll(async () => {
      try {
        await app.prisma.section9Credit.deleteMany({
          where: { employee: { tenantId: s9.tenant.id } },
        });
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId: s9.tenant.id } });
        await cleanupTestData(app, s9.tenant.id);
      } catch (err) {
        console.error("leave-salon-filter-558 section9 cleanup failed:", err);
      }
    });

    it("the admin sees the case of A under A, the case of B under B and both without a salon", async () => {
      expect(await cases(s9.adminToken, `?salonId=${s9SalonA.id}`)).toEqual([creditA]);
      expect(await cases(s9.adminToken, `?salonId=${s9SalonB.id}`)).toEqual([creditB]);
      expect(sorted(await cases(s9.adminToken))).toEqual(sorted([creditA, creditB]));
    });

    it("a Salonmanager of A sees only the case of A, with or without a salon (reach of #644)", async () => {
      expect(await cases(s9ManagerToken)).toEqual([creditA]);
      expect(await cases(s9ManagerToken, `?salonId=${s9SalonA.id}`)).toEqual([creditA]);
    });

    it("the manager of A asking for B, an unknown, a foreign or an inactive salon gets one 404", async () => {
      for (const id of [s9SalonB.id, randomUUID(), salonF.id, s9SalonI.id]) {
        const res = await get(s9ManagerToken, `/api/v1/leave/section9?salonId=${id}`);
        expect(res.statusCode).toBe(404);
        expect(res.body).toBe(NOT_FOUND);
      }
    });

    it("the admin gets the identical 404 for a foreign, an unknown and an inactive salon", async () => {
      for (const id of [salonF.id, randomUUID(), s9SalonI.id]) {
        const res = await get(s9.adminToken, `/api/v1/leave/section9?salonId=${id}`);
        expect(res.statusCode).toBe(404);
        expect(res.body).toBe(NOT_FOUND);
      }
    });

    it("a caller with only the own-data reach gets the same 404 with a salon", async () => {
      const res = await get(s9.empToken, `/api/v1/leave/section9?salonId=${s9SalonA.id}`);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(NOT_FOUND);
    });

    it("a malformed salonId is a 400", async () => {
      const res = await get(s9.adminToken, "/api/v1/leave/section9?salonId=bad");
      expect(res.statusCode).toBe(400);
    });
  });
});
