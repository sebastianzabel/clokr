/**
 * Issue #70 (Phase 70b-02, D-10, D-13) — every manual writer answers an overlap with a clean 409,
 * and the wording follows the caller's reach.
 *
 * With several entries per day the conflicting entry may lie in a salon the caller cannot see, so
 * "Überschneidung mit bestehendem Eintrag vom 15.10.2026 (07:00 – 11:00)" would disclose hours
 * outside the caller's `time-entry:read` reach (DSGVO Art. 5 Abs. 1 lit. c). `overlapMessageForCaller`
 * is the ONE place deciding the wording: detailed for the person themself, for a whole-tenant reader
 * and for a reader whose reach contains the conflicting entry; otherwise the neutral text.
 *
 * Fixture: salons A and B, the employee has NO Stammsalon (so no home-salon branch widens a scope),
 * one entry X (07:00-11:00, salon B) that a manager scoped on salon A cannot see, and one entry Y
 * (13:00-15:00, salon A) that the PUT cases try to move onto X.
 *
 * Every writer branch is covered: plain POST, POST with a grant, entry-first Nachtrag, PUT, PUT with
 * a grant (the revalidate route shares the wording function and is covered by its own tests). A
 * refused write leaves no TimeEntry row, no RetroEntryRequest row and the grant APPROVED.
 *
 * Mutation proof (recorded in the 70b-02 SUMMARY, restored by `cp`): making
 * `overlapMessageForCaller` always return the detailed text turns the two scoped-manager cases red.
 *
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { nextWeekdayStr, pastDateStr, TEST_TZ } from "./test-dates";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "test1234";
const NEUTRAL = "Überschneidung mit einem bestehenden Eintrag dieses Tages.";

function at(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

describe("Issue #70 — overlap answers are a clean 409 whose wording follows the caller's reach", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let scopedToken: string;
  let day: string;
  let oldDay: string;
  let entryX: { id: string };
  let entryY: { id: string };
  let detailed: string;

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  async function createManagerOnSalonA(): Promise<string> {
    const s = `ovl70-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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
        lastName: "OverlapTest",
        hireDate: new Date("2020-01-01"),
      },
    });
    const name = `Overlap70 ${crypto.randomBytes(3).toString("hex")}`;
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
        salonIds: [salonA.id],
        employeeIds: [],
      },
    });
    return login(user.email);
  }

  const post = (token: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${token}` },
      payload: { employeeId: seed.employee.id, ...payload },
    });
  const put = (token: string, id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: "Korrektur nach Rückfrage", ...payload },
    });
  const entryCount = (date: string) =>
    app.prisma.timeEntry.count({
      where: { employeeId: seed.employee.id, date: new Date(`${date}T00:00:00Z`), deletedAt: null },
    });

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "ovl70");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B" });
    scopedToken = await createManagerOnSalonA();

    day = nextWeekdayStr(pastDateStr(6));
    oldDay = nextWeekdayStr(pastDateStr(200));
    const [y, m, d] = day.split("-");
    detailed = `Überschneidung mit bestehendem Eintrag vom ${d}.${m}.${y} (07:00 – 11:00)`;

    entryX = await app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: new Date(`${day}T00:00:00Z`),
        startTime: at(day, "07:00"),
        endTime: at(day, "11:00"),
        source: "MANUAL",
        salonId: salonB.id,
      },
    });
    entryY = await app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: new Date(`${day}T00:00:00Z`),
        startTime: at(day, "13:00"),
        endTime: at(day, "15:00"),
        source: "MANUAL",
        salonId: salonA.id,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch {
      // best-effort cleanup
    }
  });

  describe("POST — the wording by caller", () => {
    const overlapping = () => ({
      date: day,
      startTime: at(day, "09:00").toISOString(),
      endTime: at(day, "10:00").toISOString(),
      salonId: salonA.id,
    });

    it("a manager scoped on salon A, conflict in salon B (outside the reach): exactly the neutral text", async () => {
      const res = await post(scopedToken, overlapping());
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body).error).toBe(NEUTRAL);
    });

    it("a whole-tenant admin gets date and times", async () => {
      const res = await post(seed.adminToken, overlapping());
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body).error).toBe(detailed);
    });

    it("the person themself gets date and times", async () => {
      const { employeeId: _ignored, ...own } = { employeeId: 0, ...overlapping() };
      void _ignored;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: own,
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body).error).toBe(detailed);
    });

    it("a manager whose reach CONTAINS the conflicting entry gets date and times", async () => {
      // The conflict with entry Y (salon A, 13:00-15:00) lies inside the salon-A manager's reach.
      const res = await post(scopedToken, {
        date: day,
        startTime: at(day, "14:00").toISOString(),
        endTime: at(day, "16:00").toISOString(),
        salonId: salonA.id,
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body).error).toBe(
        `Überschneidung mit bestehendem Eintrag vom ${day.split("-").reverse().join(".")} (13:00 – 15:00)`,
      );
    });

    it("every refused POST leaves the day untouched", async () => {
      expect(await entryCount(day)).toBe(2);
    });
  });

  describe("PUT — the same wording through the update route", () => {
    // Move entry Y (13:00-15:00, salon A) onto X (07:00-11:00, salon B).
    const move = () => ({
      startTime: at(day, "09:00").toISOString(),
      endTime: at(day, "12:00").toISOString(),
    });

    it("a manager scoped on salon A: the neutral text", async () => {
      const res = await put(scopedToken, entryY.id, move());
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body).error).toBe(NEUTRAL);
    });

    it("a whole-tenant admin gets date and times", async () => {
      const res = await put(seed.adminToken, entryY.id, move());
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body).error).toBe(detailed);
    });

    it("the person themself gets date and times", async () => {
      const res = await put(seed.empToken, entryY.id, move());
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body).error).toBe(detailed);
    });

    it("a refused PUT changes nothing (times, breaks, source)", async () => {
      const y = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entryY.id } });
      expect(y.startTime.toISOString()).toBe(at(day, "13:00").toISOString());
      expect(y.endTime?.toISOString()).toBe(at(day, "15:00").toISOString());
      expect(y.source).toBe("MANUAL");
    });
  });

  describe("the grant, Nachtrag and grant-PUT branches: an overlapping write is a 409 and writes nothing", () => {
    let blocker: { id: string };

    beforeAll(async () => {
      blocker = await app.prisma.timeEntry.create({
        data: {
          employeeId: seed.employee.id,
          date: new Date(`${oldDay}T00:00:00Z`),
          startTime: at(oldDay, "08:00"),
          endTime: at(oldDay, "12:00"),
          source: "MANUAL",
          salonId: salonA.id,
        },
      });
    });

    it("entry-first Nachtrag: 409, no RetroEntryRequest, no entry", async () => {
      const before = await entryCount(oldDay);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: {
          date: oldDay,
          startTime: at(oldDay, "10:00").toISOString(),
          endTime: at(oldDay, "13:00").toISOString(),
          reason: "Vergessen zu erfassen",
          salonId: salonA.id,
        },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body).error).toMatch(/^Überschneidung mit bestehendem Eintrag vom /);
      expect(await entryCount(oldDay)).toBe(before);
      expect(
        await app.prisma.retroEntryRequest.count({ where: { employeeId: seed.employee.id } }),
      ).toBe(0);
    });

    it("POST with a grant: 409, the grant stays APPROVED, no entry", async () => {
      const grant = await app.prisma.retroEntryRequest.create({
        data: {
          employeeId: seed.employee.id,
          targetDate: new Date(`${oldDay}T00:00:00Z`),
          reason: "Freigabe für den Test",
          status: "APPROVED",
        },
      });
      const before = await entryCount(oldDay);
      const res = await post(seed.adminToken, {
        date: oldDay,
        startTime: at(oldDay, "11:00").toISOString(),
        endTime: at(oldDay, "13:00").toISOString(),
        grantId: grant.id,
        salonId: salonA.id,
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(await entryCount(oldDay)).toBe(before);
      const after = await app.prisma.retroEntryRequest.findUniqueOrThrow({
        where: { id: grant.id },
      });
      expect(after.status, "the rollback restores the grant").toBe("APPROVED");
    });

    it("PUT with a grant: 409, the grant stays APPROVED, the entry keeps its times", async () => {
      const second = await app.prisma.timeEntry.create({
        data: {
          employeeId: seed.employee.id,
          date: new Date(`${oldDay}T00:00:00Z`),
          startTime: at(oldDay, "14:00"),
          endTime: at(oldDay, "16:00"),
          source: "MANUAL",
          salonId: salonA.id,
        },
      });
      const grant = await app.prisma.retroEntryRequest.create({
        data: {
          employeeId: seed.employee.id,
          targetDate: new Date(`${oldDay}T00:00:00Z`),
          reason: "Freigabe für den Test",
          status: "APPROVED",
        },
      });
      const res = await put(seed.empToken, second.id, {
        startTime: at(oldDay, "09:00").toISOString(),
        endTime: at(oldDay, "11:00").toISOString(),
        grantId: grant.id,
      });
      expect(res.statusCode, res.body).toBe(409);
      const after = await app.prisma.retroEntryRequest.findUniqueOrThrow({
        where: { id: grant.id },
      });
      expect(after.status).toBe("APPROVED");
      const entry = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: second.id } });
      expect(entry.startTime.toISOString()).toBe(at(oldDay, "14:00").toISOString());
      void blocker;
    });
  });

  describe("concurrent writers of one employee queue on the Employee row lock (T-70b-05)", () => {
    const RACES = 6;
    const detailedPrefix = /^Überschneidung mit bestehendem Eintrag vom /;

    it("two POSTs onto the same interval: one 201, one 409 with the DETAILED text (the in-transaction re-check, not the database fallback), never 500", async () => {
      for (let i = 0; i < RACES; i++) {
        const raceDay = pastDateStr(30 + i);
        const body = (from: string, to: string) => ({
          date: raceDay,
          startTime: at(raceDay, from).toISOString(),
          endTime: at(raceDay, to).toISOString(),
          salonId: salonA.id,
        });
        // The whole-tenant admin writes for the employee (exempt from the retro window, wholeTenant
        // reach: every conflict text is the detailed one, so a neutral text can only come from the
        // database fallback).
        const [a, b] = await Promise.all([
          post(seed.adminToken, body("08:00", "12:00")),
          post(seed.adminToken, body("10:00", "14:00")),
        ]);
        expect([a.statusCode, b.statusCode].sort(), `${a.body} / ${b.body}`).toEqual([201, 409]);
        const loser = a.statusCode === 409 ? a : b;
        expect(JSON.parse(loser.body).error).toMatch(detailedPrefix);
      }
    });

    it("two PUTs moving different entries onto the same free interval: one 200, one 409 with the detailed text, never 500", async () => {
      for (let i = 0; i < RACES; i++) {
        const raceDay = pastDateStr(50 + i);
        const mk = (from: string, to: string) =>
          app.prisma.timeEntry.create({
            data: {
              employeeId: seed.employee.id,
              date: new Date(`${raceDay}T00:00:00Z`),
              startTime: at(raceDay, from),
              endTime: at(raceDay, to),
              source: "MANUAL",
              salonId: salonA.id,
            },
          });
        const p = await mk("06:00", "07:00");
        const q = await mk("16:00", "17:00");
        const target = {
          startTime: at(raceDay, "09:00").toISOString(),
          endTime: at(raceDay, "11:00").toISOString(),
        };
        const [a, b] = await Promise.all([
          put(seed.adminToken, p.id, target),
          put(seed.adminToken, q.id, target),
        ]);
        expect([a.statusCode, b.statusCode].sort(), `${a.body} / ${b.body}`).toEqual([200, 409]);
        const loser = a.statusCode === 409 ? a : b;
        expect(JSON.parse(loser.body).error).toMatch(detailedPrefix);
      }
    });
  });
});
