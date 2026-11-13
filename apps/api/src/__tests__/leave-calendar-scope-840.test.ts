/**
 * Issue #840 (D-840-18/23/24/25, AC-3) — the personal scopes of `GET /leave/calendar`:
 * `scope=own` answers only the caller's own rows, `scope=team` only the persons homed in one of the
 * caller's own Stammsalons on a window day (all masked, whatever the caller's reach) plus the
 * caller; a validated `salonId` brings the salon's own holidays and `salons` names the salon in
 * view with its opening hours.
 *
 * Fixture (fake clock 2026-06-15T10:00Z, installed BEFORE the app boots): tenant with the default
 * salon plus salons A and B (three active salons), a second tenant with exactly one salon.
 *   eA     employee homed in A, own APPROVED (4th-5th) and PENDING (8th) rows
 *   pA     homed in A, APPROVED 2nd-3rd
 *   pB     homed in B, APPROVED 10th-12th
 *   pMove  homed in A until the 14th, in B from the 15th, APPROVED 10th-20th
 *   eFree  employee without any HOME assignment, own APPROVED row
 *   eTwo   employee homed in A until the 14th and in B from the 15th
 *   admin  whole-tenant admin, homed in A
 * Manual holidays: 17th for A, 18th for B. No person names.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  grantSystemRole,
} from "./setup";

const PASSWORD = "test1234";
const MASKED_KEYS = [
  "employeeId",
  "endDate",
  "firstName",
  "isOwn",
  "lastName",
  "masked",
  "startDate",
];

type Entry = Record<string, unknown> & { isHoliday?: boolean };
type RangeBody = {
  entries: Entry[];
  salons: { salonId: string; name: string; openingHours: unknown }[];
};

describe("Issue #840 — personal scopes, salon holidays and the salons field", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string; openingHours: unknown };
  let salonB: { id: string };
  const emp: Record<string, string> = {};
  const req: Record<string, string> = {};
  const token: Record<string, string> = {};

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string) {
    const s = uniqueSuffix(label);
    const user = await app.prisma.user.create({
      data: {
        email: `${s}@example.invalid`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "Scope840",
        hireDate: new Date("2024-01-01"),
      },
    });
    await grantSystemRole(app.prisma, {
      tenantId: data.tenant.id,
      userId: user.id,
      role: "EMPLOYEE",
    });
    emp[label] = employee.id;
    token[label] = await login(user.email);
    return employee;
  }

  function home(employeeId: string, salonId: string, from: string, until: string | null) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date(`${from}T00:00:00Z`),
        validUntil: until === null ? null : new Date(`${until}T00:00:00Z`),
        weekdays: [],
      },
    });
  }

  function leave(key: string, employeeKey: string, start: string, end: string, status: string) {
    return app.prisma.leaveRequest
      .create({
        data: {
          employeeId: emp[employeeKey],
          leaveTypeId: data.vacationType.id,
          startDate: new Date(`${start}T00:00:00Z`),
          endDate: new Date(`${end}T00:00:00Z`),
          days: 1,
          status: status as "APPROVED" | "PENDING",
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

  function get(tok: string, qs: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/leave/calendar?${qs}`,
      headers: { authorization: `Bearer ${tok}` },
    });
  }

  async function range(tok: string, qs: string): Promise<RangeBody> {
    const res = await get(tok, qs);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as RangeBody;
  }

  const leaveRows = (body: RangeBody) => body.entries.filter((e) => e.isHoliday !== true);
  const holidayNames = (body: RangeBody) =>
    body.entries.filter((e) => e.isHoliday === true).map((e) => String(e.typeName));
  const persons = (body: RangeBody) =>
    leaveRows(body)
      .map((e) => String(e.employeeId))
      .sort((a, b) => a.localeCompare(b));
  const RANGE = "from=2026-06-01&to=2026-06-30";

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "scope840");
    one = await seedTestData(app, "scope840-one");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Nord" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Ost" });

    await home(data.adminEmployee.id, salonA.id, "2024-01-01", null);

    await createEmployee("eA");
    await createEmployee("pA");
    await createEmployee("pB");
    await createEmployee("pMove");
    await createEmployee("eFree");
    await createEmployee("eTwo");
    await home(emp.eA, salonA.id, "2024-01-01", null);
    await home(emp.pA, salonA.id, "2024-01-01", null);
    await home(emp.pB, salonB.id, "2024-01-01", null);
    await home(emp.pMove, salonA.id, "2024-01-01", "2026-06-14");
    await home(emp.pMove, salonB.id, "2026-06-15", null);
    await home(emp.eTwo, salonA.id, "2024-01-01", "2026-06-14");
    await home(emp.eTwo, salonB.id, "2026-06-15", null);

    await leave("eA", "eA", "2026-06-04", "2026-06-05", "APPROVED");
    await leave("eAPending", "eA", "2026-06-08", "2026-06-08", "PENDING");
    await leave("pA", "pA", "2026-06-02", "2026-06-03", "APPROVED");
    await leave("pB", "pB", "2026-06-10", "2026-06-12", "APPROVED");
    await leave("pMove", "pMove", "2026-06-10", "2026-06-20", "APPROVED");
    await leave("eFree", "eFree", "2026-06-22", "2026-06-23", "APPROVED");

    for (const [salon, day, name] of [
      [salonA.id, "2026-06-17", "Feiertag Nord"],
      [salonB.id, "2026-06-18", "Feiertag Ost"],
    ] as const) {
      await app.prisma.publicHoliday.create({
        data: {
          tenantId: data.tenant.id,
          salonId: salon,
          date: new Date(`${day}T00:00:00Z`),
          name,
          federalState: "BERLIN",
          year: 2026,
        },
      });
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, one.tenant.id);
    } catch (err) {
      console.error("leave-calendar-scope-840 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("scope=own", () => {
    it("answers only the caller's own rows, detailed, incl. a PENDING one", async () => {
      const body = await range(token.eA, `${RANGE}&scope=own`);
      const rows = leaveRows(body);
      expect(rows.map((e) => e.id).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
        [req.eA, req.eAPending].sort((a, b) => a.localeCompare(b)),
      );
      for (const row of rows) {
        expect(row.isOwn).toBe(true);
        expect(row.masked).toBeUndefined();
        expect(row.typeCode).toBeTruthy();
      }
    });

    it("carries no colleague row, masked or not, but still the holiday items", async () => {
      const body = await range(token.eA, `${RANGE}&scope=own`);
      expect(persons(body).every((id) => id === emp.eA)).toBe(true);
      expect(JSON.stringify(body)).not.toContain(req.pA);
      expect(JSON.stringify(body)).not.toContain(emp.pB);
      expect(holidayNames(body).length).toBeGreaterThan(0);
    });

    it("the whole-tenant admin gets nothing of anyone else either", async () => {
      const body = await range(data.adminToken, `${RANGE}&scope=own`);
      expect(leaveRows(body)).toEqual([]);
    });
  });

  describe("scope=team", () => {
    it("an employee homed in A: colleagues of A masked, a person homed only in B absent, own row detailed", async () => {
      const body = await range(token.eA, `${RANGE}&scope=team`);
      const pa = leaveRows(body).filter((e) => e.employeeId === emp.pA);
      expect(pa).toHaveLength(1);
      expect(Object.keys(pa[0]).sort()).toEqual(MASKED_KEYS);
      expect(pa[0]).toMatchObject({ startDate: "2026-06-02", endDate: "2026-06-03", masked: true });

      expect(leaveRows(body).filter((e) => e.employeeId === emp.pB)).toEqual([]);

      const own = leaveRows(body).filter((e) => e.employeeId === emp.eA);
      expect(own.map((e) => e.id).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
        [req.eA, req.eAPending].sort((a, b) => a.localeCompare(b)),
      );
      for (const row of own) expect(row.masked).toBeUndefined();
    });

    it("the whole-tenant admin homed in A still gets the colleagues of A masked (E-03)", async () => {
      const body = await range(data.adminToken, `${RANGE}&scope=team`);
      const pa = leaveRows(body).filter((e) => e.employeeId === emp.pA);
      expect(pa).toHaveLength(1);
      expect(Object.keys(pa[0]).sort()).toEqual(MASKED_KEYS);
      expect(leaveRows(body).filter((e) => e.employeeId === emp.pB)).toEqual([]);
      for (const row of leaveRows(body)) expect(row.masked).toBe(true);
      expect(JSON.stringify(body)).not.toContain(req.pA);
    });

    it("a caller without any HOME assignment gets only the own rows", async () => {
      const body = await range(token.eFree, `${RANGE}&scope=team`);
      const rows = leaveRows(body);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(req.eFree);
      expect(rows[0].masked).toBeUndefined();
      expect(body.salons).toEqual([]);
    });

    it("a person who moves from A to B inside the window is in the team of an A employee", async () => {
      const body = await range(token.eA, `${RANGE}&scope=team`);
      const rows = leaveRows(body).filter((e) => e.employeeId === emp.pMove);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        startDate: "2026-06-10",
        endDate: "2026-06-20",
        masked: true,
      });
    });

    it("a window after the move leaves the moved person out of the A team", async () => {
      const body = await range(token.eA, "from=2026-06-15&to=2026-06-30&scope=team");
      expect(leaveRows(body).filter((e) => e.employeeId === emp.pMove)).toEqual([]);
    });

    it("a caller with two HOME salons in the window gets both teams and no single salon", async () => {
      const body = await range(token.eTwo, `${RANGE}&scope=team`);
      const ids = persons(body);
      expect(ids).toContain(emp.pA);
      expect(ids).toContain(emp.pB);
      expect(body.salons).toEqual([]);
    });

    it("the year/month form honours the scope too", async () => {
      const res = await get(token.eA, "year=2026&month=6&scope=own");
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as Entry[];
      expect(Array.isArray(body)).toBe(true);
      expect(body.filter((e) => e.isHoliday !== true).every((e) => e.employeeId === emp.eA)).toBe(
        true,
      );
    });
  });

  describe("scope and salonId", () => {
    it("scope=team together with salonId is 400, as is an unknown scope", async () => {
      expect((await get(token.eA, `${RANGE}&scope=team&salonId=${salonA.id}`)).statusCode).toBe(
        400,
      );
      expect((await get(token.eA, `${RANGE}&scope=own&salonId=${salonA.id}`)).statusCode).toBe(400);
      expect((await get(token.eA, `${RANGE}&scope=foo`)).statusCode).toBe(400);
    });
  });

  describe("the holidays of the salon in view", () => {
    it("a validated salonId brings that salon's own holidays", async () => {
      const inA = await range(data.adminToken, `${RANGE}&salonId=${salonA.id}`);
      expect(holidayNames(inA)).toContain("Feiertag Nord");
      expect(holidayNames(inA)).not.toContain("Feiertag Ost");

      const inB = await range(data.adminToken, `${RANGE}&salonId=${salonB.id}`);
      expect(holidayNames(inB)).toContain("Feiertag Ost");
      expect(holidayNames(inB)).not.toContain("Feiertag Nord");
    });

    it("the holiday item keeps its shape", async () => {
      const inA = await range(data.adminToken, `${RANGE}&salonId=${salonA.id}`);
      const item = inA.entries.find((e) => e.typeName === "Feiertag Nord");
      expect(item).toMatchObject({
        id: "holiday-2026-06-17",
        isHoliday: true,
        typeCode: "HOLIDAY",
        startDate: "2026-06-17",
        endDate: "2026-06-17",
        halfDay: false,
        status: "APPROVED",
      });
    });

    it("without salonId the requester's work-location holidays stay (admin homed in A)", async () => {
      const body = await range(data.adminToken, RANGE);
      expect(holidayNames(body)).not.toContain("Feiertag Ost");
    });
  });

  describe("the salons field of the range form", () => {
    it("a validated salonId names exactly that salon with its opening hours", async () => {
      const body = await range(data.adminToken, `${RANGE}&salonId=${salonA.id}`);
      expect(body.salons).toHaveLength(1);
      expect(body.salons[0]).toMatchObject({ salonId: salonA.id, name: "Salon Nord" });
      expect(body.salons[0].openingHours).toEqual(salonA.openingHours);
    });

    it("scope=team and scope=own name the caller's single Stammsalon", async () => {
      for (const scope of ["team", "own"]) {
        const body = await range(token.eA, `${RANGE}&scope=${scope}`);
        expect(body.salons).toHaveLength(1);
        expect(body.salons[0]).toMatchObject({ salonId: salonA.id, name: "Salon Nord" });
      }
    });

    it("no salonId and no scope in a tenant with several active salons is empty", async () => {
      const body = await range(data.adminToken, RANGE);
      expect(body.salons).toEqual([]);
    });

    it("a tenant with exactly one active salon always names it", async () => {
      const body = await range(one.adminToken, RANGE);
      expect(body.salons).toHaveLength(1);
      expect(body.salons[0].salonId).toBe(one.salonId);
      const scoped = await range(one.adminToken, `${RANGE}&scope=team`);
      expect(scoped.salons).toHaveLength(1);
      expect(scoped.salons[0].salonId).toBe(one.salonId);
    });
  });
});
