/**
 * Issue #658 — `POST /api/v1/time-entries` narrows a `time-entry:create:ZUGEWIESEN` caller who
 * creates an entry for ANOTHER person to their reach (Stammsalon at the entry date / person list).
 * A person outside the reach answers exactly like an unknown employeeId (404, same body), nothing
 * is written and no audit row exists. In-reach, whole-tenant and own entries are unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  grantSystemRole,
} from "./setup";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";
import { addDaysStr, mondayOfWeekStr } from "./test-dates";

const PASSWORD = "test1234";

describe("Issue #658 — POST /time-entries is narrowed to the create reach", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  const people: Record<string, { id: string; number: string; userId: string; email: string }> = {};
  let scopedToken = "";

  const day = addDaysStr(mondayOfWeekStr(), -3);

  function create(token: string, employeeId?: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        ...(employeeId ? { employeeId } : {}),
        date: day,
        startTime: `${day}T08:00:00.000Z`,
        endTime: `${day}T16:00:00.000Z`,
        breakMinutes: 30,
        ...extra,
      },
    });
  }

  async function entryCount(employeeId: string) {
    return app.prisma.timeEntry.count({ where: { employeeId } });
  }

  async function auditCount(employeeId: string) {
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId },
      select: { id: true },
    });
    return app.prisma.auditLog.count({
      where: { entity: "TimeEntry", entityId: { in: entries.map((e) => e.id) } },
    });
  }

  async function person(label: string, salonId: string) {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `${s}@test.de`;
    const user = await app.prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const number = s.toUpperCase().slice(0, 20);
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: number,
        firstName: label,
        lastName: "Reach658",
        hireDate: new Date("2020-01-01"),
      },
    });
    await grantSystemRole(app.prisma, {
      tenantId: data.tenant.id,
      userId: user.id,
      role: "EMPLOYEE",
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: employee.id,
        salonId,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    people[label] = { id: employee.id, number, userId: user.id, email };
    return people[label];
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cr658");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "CR658 Salon A" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "CR658 Salon B" });
    await person("pa", salonA.id);
    await person("pb", salonB.id);
    const mgr = await person("mgr", salonA.id);

    const name = `Cr658 ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions([
          "time-entry:create:ZUGEWIESEN",
          "retro-request:create:ZUGEWIESEN",
        ]),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: mgr.userId,
        accessRoleId: role.id,
        scopeType: "SALONS",
        salonIds: [salonA.id],
        employeeIds: [],
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: mgr.email, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    scopedToken = (JSON.parse(login.body) as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("answers a salon B person exactly like an unknown id and writes nothing", async () => {
    const foreign = await create(scopedToken, people.pb.id);
    const unknown = await create(scopedToken, crypto.randomUUID());
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.body).toBe(unknown.body);
    expect(JSON.parse(foreign.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });
    expect(await entryCount(people.pb.id)).toBe(0);
    expect(await auditCount(people.pb.id)).toBe(0);
  });

  it("creates for a salon A person", async () => {
    const res = await create(scopedToken, people.pa.id);
    expect(res.statusCode).toBe(201);
    expect(await entryCount(people.pa.id)).toBe(1);
  });

  it("follows the per-entry rule: an entry recorded in the caller's own salon is in reach", async () => {
    const other = await person("spr", salonB.id);
    const inOwnSalon = await create(scopedToken, other.id, { salonId: salonA.id });
    expect(inOwnSalon.statusCode).toBe(201);
    const third = await person("spr2", salonB.id);
    const inForeignSalon = await create(scopedToken, third.id, { salonId: salonB.id });
    expect(inForeignSalon.statusCode).toBe(404);
    expect(JSON.parse(inForeignSalon.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });
    expect(await entryCount(third.id)).toBe(0);
  });

  it("lets a whole-tenant admin create for both salons", async () => {
    const a = await create(data.adminToken, people.pb.id);
    expect(a.statusCode).toBe(201);
    expect(await entryCount(people.pb.id)).toBe(1);
  });

  it("lets an employee create their own entry", async () => {
    const res = await create(data.empToken);
    expect(res.statusCode).toBe(201);
  });

  describe("POST /time-entries/clock-in on behalf", () => {
    function clockIn(token: string, payload: Record<string, unknown>) {
      return app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    }

    it("answers a salon B person exactly like an unknown id (employeeId), writes nothing", async () => {
      const p = await person("ci-b", salonB.id);
      const foreign = await clockIn(scopedToken, { employeeId: p.id, source: "MANUAL" });
      const unknown = await clockIn(scopedToken, {
        employeeId: crypto.randomUUID(),
        source: "MANUAL",
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(unknown.body);
      expect(await entryCount(p.id)).toBe(0);
      expect(await auditCount(p.id)).toBe(0);
    });

    it("answers a salon B card exactly like an unknown card (nfcCardId)", async () => {
      const p = await person("ci-nfc", salonB.id);
      const card = `NFC658-${crypto.randomBytes(4).toString("hex")}`;
      await app.prisma.employee.update({ where: { id: p.id }, data: { nfcCardId: card } });
      const foreign = await clockIn(scopedToken, { nfcCardId: card, source: "MANUAL" });
      const unknown = await clockIn(scopedToken, { nfcCardId: "NOSUCH-658", source: "MANUAL" });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(unknown.body);
      expect(await entryCount(p.id)).toBe(0);
    });

    it("clocks in a salon A person, a whole-tenant admin clocks in a salon B person", async () => {
      const a = await person("ci-a", salonA.id);
      expect((await clockIn(scopedToken, { employeeId: a.id, source: "MANUAL" })).statusCode).toBe(
        200,
      );
      const b = await person("ci-b2", salonB.id);
      expect(
        (await clockIn(data.adminToken, { employeeId: b.id, source: "MANUAL" })).statusCode,
      ).toBe(200);
    });

    it("lets the scoped manager clock in themselves", async () => {
      const res = await clockIn(scopedToken, { source: "MANUAL" });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("POST /retro-entry-requests on behalf", () => {
    function retro(token: string, employeeId: string) {
      return app.inject({
        method: "POST",
        url: "/api/v1/retro-entry-requests",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          employeeId,
          targetDate: day,
          reason: "Nachtrag 658",
          startTime: "08:00",
          endTime: "16:00",
        },
      });
    }

    it("answers a salon B person exactly like an unknown id and writes nothing", async () => {
      const p = await person("rr-b", salonB.id);
      const foreign = await retro(scopedToken, p.id);
      const unknown = await retro(scopedToken, crypto.randomUUID());
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(unknown.body);
      expect(await app.prisma.retroEntryRequest.count({ where: { employeeId: p.id } })).toBe(0);
    });

    it("accepts a salon A person", async () => {
      const p = await person("rr-a", salonA.id);
      expect((await retro(scopedToken, p.id)).statusCode).toBe(201);
    });
  });
});
