/**
 * Issue #92 (Phase 92b-02, Task 1) — the create side of the travel write rule on the real POST
 * route and the migrated database: both salons tenant-bound through `resolveEntrySalon`, the reach
 * over the WHOLE day, recorded day breaks, the grant branch, the Zeitnachtrag refusal, the overlap
 * rule and the audit row.
 *
 * Fixture day (tenant time): 08:00-12:00 in salon A and 12:30-14:30 in salon B, written straight
 * through Prisma so each case starts from the same two anchors. Every case owns a day of its own
 * (three-day steps from twelve days ago, so the employee's retro window never matters for the
 * manager/admin cases). No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto, { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  soleAuditRow,
  auditRowsFor,
} from "./setup";
import { dowOf, nextWeekdayStr, pastDateStr, TEST_TZ, utcMidnight } from "./test-dates";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "test1234";

function at(dayStr: string, hhmm: string): string {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ).toISOString();
}

/** The n-th distinct weekday, three calendar days apart, starting twelve days ago. */
function dayN(n: number): string {
  return nextWeekdayStr(pastDateStr(12 + 3 * n));
}

describe("Issue #92 — creating a travel entry: salons, reach, day breaks, grant, Nachtrag, audit", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonInactive: { id: string };
  let dayCounter = 0;

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  async function managerOn(salonIds: string[], label: string): Promise<string> {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `${s}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: seed.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: "Scoped",
        lastName: "TravelTest",
        hireDate: new Date("2020-01-01"),
      },
    });
    const name = `Travel92 ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: seed.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions([
          "time-entry:create:ZUGEWIESEN",
          "time-entry:read:ZUGEWIESEN",
          "time-entry:update:ZUGEWIESEN",
        ]),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: "SALONS",
        salonIds,
        employeeIds: [],
      },
    });
    return login(user.email);
  }

  /** A fresh day with the two anchors A 08:00-12:00 (salon A) and B 12:30-14:30 (salon B). */
  async function anchoredDay(): Promise<string> {
    const day = dayN(dayCounter++);
    await app.prisma.timeEntry.createMany({
      data: [
        {
          employeeId: seed.employee.id,
          date: utcMidnight(day),
          startTime: new Date(at(day, "08:00")),
          endTime: new Date(at(day, "12:00")),
          source: "MANUAL",
          salonId: salonA.id,
        },
        {
          employeeId: seed.employee.id,
          date: utcMidnight(day),
          startTime: new Date(at(day, "12:30")),
          endTime: new Date(at(day, "14:30")),
          source: "MANUAL",
          salonId: salonB.id,
        },
      ],
    });
    return day;
  }

  const post = (token: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${token}` },
      payload: { employeeId: seed.employee.id, ...payload },
    });

  const travelBody = (day: string, from = "12:00", to = "12:30") => ({
    date: day,
    startTime: at(day, from),
    endTime: at(day, to),
    salonId: salonA.id,
    travelToSalonId: salonB.id,
  });

  const rowCount = (day: string) =>
    app.prisma.timeEntry.count({
      where: { employeeId: seed.employee.id, date: utcMidnight(day), deletedAt: null },
    });

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "trv92a");
    foreign = await seedTestData(app, "trv92b");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B" });
    salonInactive = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon X",
      isActive: false,
    });
  });

  afterAll(async () => {
    for (const tenantId of [seed.tenant.id, foreign.tenant.id]) {
      try {
        await cleanupTestData(app, tenantId);
      } catch {
        // best-effort cleanup
      }
    }
  });

  describe("salons go through resolveEntrySalon", () => {
    it("a destination of another tenant and an unknown destination answer byte-identically (404), nothing written", async () => {
      const day = await anchoredDay();
      const base = travelBody(day);
      const foreignDest = await post(seed.adminToken, {
        ...base,
        travelToSalonId: foreign.salonId,
      });
      const unknownDest = await post(seed.adminToken, { ...base, travelToSalonId: randomUUID() });
      expect(foreignDest.statusCode, foreignDest.body).toBe(404);
      expect(unknownDest.statusCode).toBe(foreignDest.statusCode);
      expect(unknownDest.body).toBe(foreignDest.body);
      expect(await rowCount(day)).toBe(2);
    });

    it("a departure salon of another tenant and an unknown departure salon answer byte-identically (404), nothing written", async () => {
      const day = await anchoredDay();
      const base = travelBody(day);
      const foreignFrom = await post(seed.adminToken, { ...base, salonId: foreign.salonId });
      const unknownFrom = await post(seed.adminToken, { ...base, salonId: randomUUID() });
      expect(foreignFrom.statusCode, foreignFrom.body).toBe(404);
      expect(unknownFrom.statusCode).toBe(foreignFrom.statusCode);
      expect(unknownFrom.body).toBe(foreignFrom.body);
      expect(await rowCount(day)).toBe(2);
    });

    it("a deactivated destination is a 400 SALON_INACTIVE, nothing written", async () => {
      const day = await anchoredDay();
      const res = await post(seed.adminToken, {
        ...travelBody(day),
        travelToSalonId: salonInactive.id,
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(JSON.parse(res.body).code).toBe("SALON_INACTIVE");
      expect(await rowCount(day)).toBe(2);
    });
  });

  describe("recorded day breaks (T4, D-09)", () => {
    it("a travel entry over a recorded break is refused; next to it it is accepted; no break can be recorded where it lies", async () => {
      const day = await anchoredDay();
      const dayBreak = (from: string, to: string) =>
        app.inject({
          method: "POST",
          url: "/api/v1/day-breaks",
          headers: { authorization: `Bearer ${seed.adminToken}` },
          payload: {
            employeeId: seed.employee.id,
            date: day,
            startTime: at(day, from),
            endTime: at(day, to),
          },
        });

      const recorded = await dayBreak("12:00", "12:20");
      expect(recorded.statusCode, recorded.body).toBe(201);

      const over = await post(seed.adminToken, travelBody(day, "12:00", "12:30"));
      expect(over.statusCode, over.body).toBe(409);
      expect(JSON.parse(over.body).code).toBe("TRAVEL_OVERLAPS_DAY_BREAK");
      expect(await rowCount(day)).toBe(2);

      const beside = await post(seed.adminToken, travelBody(day, "12:20", "12:30"));
      expect(beside.statusCode, beside.body).toBe(201);

      const refused = await dayBreak("12:20", "12:25");
      expect(refused.statusCode, refused.body).toBe(409);
    });
  });

  describe("reach over EVERY entry of the day (T-92b-08)", () => {
    it("a manager scoped on salon A only gets the unknown-employee answer of the route, byte-identical, no row, no audit", async () => {
      const day = await anchoredDay();
      const scoped = await managerOn([salonA.id], "trv92-a");
      const auditsBefore = await app.prisma.auditLog.count({
        where: { entity: "TimeEntry", action: "CREATE" },
      });

      const res = await post(scoped, travelBody(day));
      const unknownEmployee = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${scoped}` },
        payload: { ...travelBody(day), employeeId: randomUUID() },
      });
      expect(res.statusCode, res.body).toBe(404);
      expect(unknownEmployee.statusCode).toBe(404);
      expect(res.body).toBe(unknownEmployee.body);
      expect(await rowCount(day)).toBe(2);
      expect(
        await app.prisma.auditLog.count({ where: { entity: "TimeEntry", action: "CREATE" } }),
      ).toBe(auditsBefore);
    });

    it("a scoped manager answers identically whether or not an out-of-reach anchor exists (no oracle)", async () => {
      const withAnchors = await anchoredDay();
      const emptyDay = dayN(dayCounter++);
      const scoped = await managerOn([salonA.id], "trv92-o");
      const one = await post(scoped, travelBody(withAnchors));
      const two = await post(scoped, travelBody(emptyDay));
      expect(one.statusCode).toBe(two.statusCode);
      expect(one.body).toBe(two.body);
    });

    it("a manager whose reach covers both salons records the travel entry", async () => {
      const day = await anchoredDay();
      const both = await managerOn([salonA.id, salonB.id], "trv92-b");
      const res = await post(both, travelBody(day));
      expect(res.statusCode, res.body).toBe(201);
      expect(JSON.parse(res.body).entry.activityKind).toBe("TRAVEL");
    });

    it("a whole-tenant admin records the travel entry for the employee; the audit row carries both salons", async () => {
      const day = await anchoredDay();
      const res = await post(seed.adminToken, travelBody(day));
      expect(res.statusCode, res.body).toBe(201);
      const entry = JSON.parse(res.body).entry as {
        id: string;
        activityKind: string;
        salonId: string;
        travelToSalonId: string;
        source: string;
      };
      expect(entry.activityKind).toBe("TRAVEL");
      expect(entry.salonId).toBe(salonA.id);
      expect(entry.travelToSalonId).toBe(salonB.id);
      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "TimeEntry", entityId: entry.id, action: "CREATE" },
      });
      expect(audit.newValue).toMatchObject({
        activityKind: "TRAVEL",
        salonId: salonA.id,
        travelToSalonId: salonB.id,
      });
    });

    it("the person themself needs no reach", async () => {
      let day = "";
      for (let back = 1; day === "" && back <= 6; back++) {
        const candidate = pastDateStr(back);
        if (dowOf(candidate) >= 1 && dowOf(candidate) <= 5) day = candidate;
      }
      expect(day, "a weekday among the last six days").not.toBe("");
      const own = await app.prisma.timeEntry.findMany({
        where: { employeeId: seed.employee.id, date: utcMidnight(day), deletedAt: null },
      });
      expect(own, "the self day is untouched by the other cases").toHaveLength(0);
      await app.prisma.timeEntry.createMany({
        data: [
          {
            employeeId: seed.employee.id,
            date: utcMidnight(day),
            startTime: new Date(at(day, "08:00")),
            endTime: new Date(at(day, "12:00")),
            source: "MANUAL",
            salonId: salonA.id,
          },
          {
            employeeId: seed.employee.id,
            date: utcMidnight(day),
            startTime: new Date(at(day, "12:30")),
            endTime: new Date(at(day, "14:30")),
            source: "MANUAL",
            salonId: salonB.id,
          },
        ],
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: travelBody(day),
      });
      expect(res.statusCode, res.body).toBe(201);
    });
  });

  describe("the retro branches", () => {
    const oldDay = () => nextWeekdayStr(pastDateStr(200 + 3 * dayCounter++));

    async function anchoredOldDay(): Promise<string> {
      const day = oldDay();
      await app.prisma.timeEntry.createMany({
        data: [
          {
            employeeId: seed.employee.id,
            date: utcMidnight(day),
            startTime: new Date(at(day, "08:00")),
            endTime: new Date(at(day, "12:00")),
            source: "MANUAL",
            salonId: salonA.id,
          },
          {
            employeeId: seed.employee.id,
            date: utcMidnight(day),
            startTime: new Date(at(day, "12:30")),
            endTime: new Date(at(day, "14:30")),
            source: "MANUAL",
            salonId: salonB.id,
          },
        ],
      });
      return day;
    }

    it("with an APPROVED grant the travel entry is recorded as a correction and the grant is consumed", async () => {
      const day = await anchoredOldDay();
      const grant = await app.prisma.retroEntryRequest.create({
        data: {
          employeeId: seed.employee.id,
          targetDate: utcMidnight(day),
          reason: "Freigabe für den Test",
          status: "APPROVED",
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: { ...travelBody(day), grantId: grant.id },
      });
      expect(res.statusCode, res.body).toBe(201);
      const entry = JSON.parse(res.body).entry as { activityKind: string; source: string };
      expect(entry.activityKind).toBe("TRAVEL");
      expect(entry.source).toBe("CORRECTION");
      const after = await app.prisma.retroEntryRequest.findUniqueOrThrow({
        where: { id: grant.id },
      });
      expect(after.status).toBe("USED");
      expect(
        await auditRowsFor(app, "RetroEntryRequest", grant.id, "RETRO_ENTRY_APPROVED_USED"),
      ).toHaveLength(1);
    });

    it("a refused grant POST (no anchors) rolls the grant back", async () => {
      const day = oldDay();
      const grant = await app.prisma.retroEntryRequest.create({
        data: {
          employeeId: seed.employee.id,
          targetDate: utcMidnight(day),
          reason: "Freigabe für den Test",
          status: "APPROVED",
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: { ...travelBody(day), grantId: grant.id },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body).code).toBe("TRAVEL_NOT_BETWEEN_SALON_ENTRIES");
      const after = await app.prisma.retroEntryRequest.findUniqueOrThrow({
        where: { id: grant.id },
      });
      expect(after.status, "the rollback restores the grant").toBe("APPROVED");
      expect(await rowCount(day)).toBe(0);
    });

    it("as an entry-first Zeitnachtrag it is refused (409 TRAVEL_NOT_AS_RETRO_REQUEST) and writes nothing", async () => {
      const day = await anchoredOldDay();
      const requestsBefore = await app.prisma.retroEntryRequest.count({
        where: { employeeId: seed.employee.id },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: { ...travelBody(day), reason: "Fahrt vergessen zu erfassen" },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body).code).toBe("TRAVEL_NOT_AS_RETRO_REQUEST");
      expect(await rowCount(day)).toBe(2);
      expect(
        await app.prisma.retroEntryRequest.count({ where: { employeeId: seed.employee.id } }),
      ).toBe(requestsBefore);
    });
  });

  describe("the overlap rule of #70 applies unchanged", () => {
    it("a travel entry 11:50-12:30 overlaps the departure entry: the 70b overlap 409, no travel-specific code", async () => {
      const day = await anchoredDay();
      const res = await post(seed.adminToken, travelBody(day, "11:50", "12:30"));
      expect(res.statusCode, res.body).toBe(409);
      const body = JSON.parse(res.body) as { error: string; code?: string };
      expect(body.error).toMatch(/^Überschneidung mit bestehendem Eintrag vom /);
      expect(body.code).toBeUndefined();
      expect(await rowCount(day)).toBe(2);
    });
  });
});
