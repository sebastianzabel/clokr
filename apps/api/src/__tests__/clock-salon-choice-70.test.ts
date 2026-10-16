/**
 * Issue #70 (Phase 70b-06, D-02/D-11) — the clock-salon answer on a booked day.
 *
 * `clockSalonChoice()` stays the ONE place of the clock-salon decision (#87 D-11). Since #70 a
 * finished day no longer pins the employee to the salon of its entry: a re-clock without a salon
 * continues the latest-ending entry (`fixedSalon`), and in a multi-salon tenant a SECOND salon may
 * be chosen (it starts a new entry). A running day offers nothing — the open entry names the salon.
 *
 * Proved here through the real route `GET /time-entries/clock-salon` with a fake Date, per case a
 * fresh person (own assignments, own entries):
 * - finished day, one entry in A → fixedSalon A, the other active salons offered, the pattern
 *   salon preselected when it is one of them;
 * - finished day, entries in A then B → fixedSalon B (latest end), A offered again;
 * - running entry → fixedSalon only, no offer, no salon list (Art. 5 Abs. 1 lit. c DSGVO);
 * - assignments naming only the salon of the finished entry → no offer;
 * - finished entry in a deactivated salon → still named, every active salon offered;
 * - single-salon tenant → nothing offered on any day state, no salon named;
 * - a day without entries → the #87 answer unchanged.
 *
 * Mutation proofs (recorded here, not re-run by CI), all on contexts/time-tracking/clock-salon-choice.ts:
 * - M1, dropping the finished-day offer (answering `fixedSalon` only), turns red: the finished-day cases;
 * - M2, offering on a running day, turns red: "running entry → no offer";
 * - M3, not excluding the fixed salon from the offered list, turns red: the finished-day cases.
 *
 * No person names in fixtures. Every fixture id is a UUID.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  grantSystemRole,
} from "./setup";
import { addDaysStr, mondayOfWeekStr, TEST_TZ } from "./test-dates";

const PASSWORD = "test1234";

/** Tenant-local instant for `HH:MM` on `dayStr`. */
function instant(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

type SalonItem = { id: string; name: string };
type ChoiceBody = {
  offerChoice: boolean;
  preselectedSalonId: string | null;
  salons: SalonItem[];
  fixedSalon: SalonItem | null;
};

describe("Issue #70 — GET /time-entries/clock-salon on a booked day", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let single: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: SalonItem;
  let salonB: SalonItem;
  let salonC: SalonItem;
  let salonD: SalonItem; // deactivated in beforeAll

  // A past Monday far enough back that no other file's fixtures matter; Thursday = Monday + 3.
  const baseMonday = addDaysStr(mondayOfWeekStr(), -12 * 7);
  const thursday = addDaysStr(baseMonday, 3);
  const dateOf = (dayStr: string) => new Date(`${dayStr}T00:00:00Z`);

  async function answer(dayStr: string, hhmm: string, token: string): Promise<ChoiceBody> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(dayStr, hhmm));
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/time-entries/clock-salon",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      return JSON.parse(res.body) as ChoiceBody;
    } finally {
      vi.useRealTimers();
    }
  }

  /** The `{ id, name }` the answer carries; createTestSalon returns the whole row. */
  const pick = (salon: { id: string; name: string }): SalonItem => ({
    id: salon.id,
    name: salon.name,
  });

  async function createPerson(tenantId: string, label: string) {
    const s = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
    const user = await app.prisma.user.create({
      data: {
        email: `csc70-${label}-${s}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `C70-${s}`.slice(0, 20),
        firstName: label,
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    await grantSystemRole(app.prisma, { tenantId, userId: user.id, role: "EMPLOYEE" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: user.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const token = (JSON.parse(res.body) as { accessToken: string }).accessToken;
    return { user, employee, token };
  }

  async function assign(
    tenantId: string,
    employeeId: string,
    salonId: string,
    kind: "HOME" | "DEPLOYMENT",
    weekdays: number[] = [],
  ) {
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId,
        kind,
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays,
      },
    });
  }

  /** A closed (or, with `to` null, open) entry `from`-`to` of `dayStr` booked to `salonId`. */
  function entry(
    employeeId: string,
    dayStr: string,
    salonId: string,
    from: string,
    to: string | null,
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: dateOf(dayStr),
        startTime: instant(dayStr, from),
        endTime: to === null ? null : instant(dayStr, to),
        source: "MOBILE",
        breakMinutes: 0,
        salonId,
      },
    });
  }

  /** The tenant's active salons except `excludeId`, as the route must list them (name de, then id). */
  async function activeExcept(tenantId: string, excludeId: string): Promise<SalonItem[]> {
    const rows = await app.prisma.salon.findMany({ where: { tenantId, isActive: true } });
    return rows
      .filter((s) => s.id !== excludeId)
      .map((s) => ({ id: s.id, name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name, "de") || (a.id < b.id ? -1 : 1));
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "csc70");
    single = await seedTestData(app, "csc70-single");
    salonA = pick(await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon Alster" }));
    salonB = pick(await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon Elbe" }));
    salonC = pick(await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon Isar" }));
    salonD = pick(await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon Donau" }));
    await app.prisma.salon.update({ where: { id: salonD.id }, data: { isActive: false } });
  });

  afterAll(async () => {
    for (const tenantId of [seed.tenant.id, single.tenant.id]) {
      try {
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("tracer: a finished entry in A fixes A, offers every other active salon and preselects the pattern salon", async () => {
    const p = await createPerson(seed.tenant.id, "finished");
    await assign(seed.tenant.id, p.employee.id, salonA.id, "HOME");
    await assign(seed.tenant.id, p.employee.id, salonB.id, "DEPLOYMENT", [3]); // Thursday (0 = Monday)
    await entry(p.employee.id, thursday, salonA.id, "08:00", "12:00");
    const body = await answer(thursday, "13:00", p.token);
    expect(body.fixedSalon).toEqual(salonA);
    expect(body.offerChoice).toBe(true);
    expect(body.salons).toEqual(await activeExcept(seed.tenant.id, salonA.id));
    expect(body.salons.map((s) => s.id)).not.toContain(salonA.id);
    expect(body.salons.map((s) => s.id)).toEqual(expect.arrayContaining([salonB.id, salonC.id]));
    // The pattern salon of a Thursday is the DEPLOYMENT salon B, which is one of the offered salons.
    expect(body.preselectedSalonId).toBe(salonB.id);
  });

  it("the pattern salon is preselected when it is offered, and never when it is the fixed salon", async () => {
    // Pattern = HOME B on every weekday; the finished entry is in A → B is offered and preselected.
    const p = await createPerson(seed.tenant.id, "patternoffered");
    await assign(seed.tenant.id, p.employee.id, salonB.id, "HOME");
    await entry(p.employee.id, thursday, salonA.id, "08:00", "12:00");
    const offered = await answer(thursday, "13:00", p.token);
    expect(offered.fixedSalon).toEqual(salonA);
    expect(offered.offerChoice).toBe(true);
    expect(offered.preselectedSalonId).toBe(salonB.id);
    expect(offered.salons).toEqual(await activeExcept(seed.tenant.id, salonA.id));

    // Pattern = HOME A and the entry is in A → the pattern salon is the fixed one, nothing to preselect.
    const q = await createPerson(seed.tenant.id, "patternfixed");
    await assign(seed.tenant.id, q.employee.id, salonA.id, "HOME");
    await assign(seed.tenant.id, q.employee.id, salonC.id, "DEPLOYMENT", [0, 1, 2, 3, 4, 5, 6]);
    await entry(q.employee.id, thursday, salonC.id, "08:00", "12:00");
    const fixedIsPattern = await answer(thursday, "13:00", q.token);
    expect(fixedIsPattern.fixedSalon).toEqual(salonC);
    expect(fixedIsPattern.preselectedSalonId).toBeNull();
    expect(fixedIsPattern.offerChoice).toBe(true);
  });

  it("two entries A then B: the salon of the latest-ending entry is fixed and A is offered again", async () => {
    const p = await createPerson(seed.tenant.id, "twoentries");
    await assign(seed.tenant.id, p.employee.id, salonA.id, "HOME");
    await entry(p.employee.id, thursday, salonA.id, "07:00", "11:00");
    await entry(p.employee.id, thursday, salonB.id, "11:30", "15:00");
    const body = await answer(thursday, "16:00", p.token);
    expect(body.fixedSalon).toEqual(salonB);
    expect(body.offerChoice).toBe(true);
    expect(body.salons).toEqual(await activeExcept(seed.tenant.id, salonB.id));
    expect(body.salons.map((s) => s.id)).toContain(salonA.id);
    expect(body.preselectedSalonId).toBe(salonA.id);
  });

  it("a running entry fixes its salon and offers nothing: no choice, no salon list", async () => {
    const p = await createPerson(seed.tenant.id, "running");
    await assign(seed.tenant.id, p.employee.id, salonA.id, "HOME");
    await assign(seed.tenant.id, p.employee.id, salonC.id, "DEPLOYMENT", [0, 1, 2, 3, 4, 5, 6]);
    await entry(p.employee.id, thursday, salonA.id, "07:00", "11:00");
    await entry(p.employee.id, thursday, salonB.id, "11:30", null);
    expect(await answer(thursday, "12:00", p.token)).toEqual({
      offerChoice: false,
      preselectedSalonId: null,
      salons: [],
      fixedSalon: salonB,
    } satisfies ChoiceBody);
  });

  it("assignments naming only the salon of the finished entry offer nothing (no salon list)", async () => {
    const p = await createPerson(seed.tenant.id, "onlya");
    await assign(seed.tenant.id, p.employee.id, salonA.id, "HOME");
    await entry(p.employee.id, thursday, salonA.id, "08:00", "12:00");
    expect(await answer(thursday, "13:00", p.token)).toEqual({
      offerChoice: false,
      preselectedSalonId: null,
      salons: [],
      fixedSalon: salonA,
    } satisfies ChoiceBody);
  });

  it("a finished entry in a deactivated salon still names it and offers every active salon", async () => {
    const p = await createPerson(seed.tenant.id, "deactivated");
    await assign(seed.tenant.id, p.employee.id, salonA.id, "HOME");
    await entry(p.employee.id, thursday, salonD.id, "08:00", "12:00");
    const body = await answer(thursday, "13:00", p.token);
    expect(body.fixedSalon).toEqual(salonD);
    expect(body.offerChoice).toBe(true);
    expect(body.salons).toEqual(await activeExcept(seed.tenant.id, salonD.id));
    expect(body.salons.map((s) => s.id)).not.toContain(salonD.id);
    expect(body.salons.map((s) => s.id)).toEqual(
      expect.arrayContaining([salonA.id, salonB.id, salonC.id]),
    );
  });

  it("a single-salon tenant offers nothing and names no salon on every day state", async () => {
    const p = await createPerson(single.tenant.id, "singlesalon");
    const nothing = {
      offerChoice: false,
      preselectedSalonId: null,
      salons: [],
      fixedSalon: null,
    } satisfies ChoiceBody;
    expect(await answer(thursday, "07:00", p.token)).toEqual(nothing); // no entry
    await entry(p.employee.id, thursday, single.salonId, "08:00", "10:00");
    expect(await answer(thursday, "10:30", p.token)).toEqual(nothing); // finished
    await entry(p.employee.id, thursday, single.salonId, "11:00", null);
    expect(await answer(thursday, "11:30", p.token)).toEqual(nothing); // running
  });

  it("a day without entries answers exactly as before (#87): pattern preselected, all active salons, no fixed salon", async () => {
    const p = await createPerson(seed.tenant.id, "noentry");
    await assign(seed.tenant.id, p.employee.id, salonA.id, "HOME");
    await assign(seed.tenant.id, p.employee.id, salonB.id, "DEPLOYMENT", [3]); // Thursday (0 = Monday)
    const body = await answer(thursday, "09:00", p.token);
    expect(body.fixedSalon).toBeNull();
    expect(body.offerChoice).toBe(true);
    expect(body.preselectedSalonId).toBe(salonB.id);
    const all = await app.prisma.salon.findMany({
      where: { tenantId: seed.tenant.id, isActive: true },
    });
    expect(body.salons.map((s) => s.id).sort()).toEqual(all.map((s) => s.id).sort());
  });

  it("every answer has exactly the four contract keys and items only id and name", async () => {
    const p = await createPerson(seed.tenant.id, "shape");
    await assign(seed.tenant.id, p.employee.id, salonA.id, "HOME");
    await entry(p.employee.id, thursday, salonB.id, "08:00", "12:00");
    const body = await answer(thursday, "13:00", p.token);
    expect(Object.keys(body).sort()).toEqual([
      "fixedSalon",
      "offerChoice",
      "preselectedSalonId",
      "salons",
    ]);
    expect(body.salons.length).toBeGreaterThan(0);
    for (const salon of body.salons) expect(Object.keys(salon).sort()).toEqual(["id", "name"]);
    expect(Object.keys(body.fixedSalon!).sort()).toEqual(["id", "name"]);
    // No salon of the other tenant is ever listed.
    expect(body.salons.map((s) => s.id)).not.toContain(single.salonId);
  });
});
