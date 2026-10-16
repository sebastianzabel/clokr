/**
 * Issue #87 (Phase 87b-03), D-02/D-03/D-04/D-11 — what the clock shows about the salon is decided
 * on the server, in ONE function (`clockSalonChoice`), and served by ONE read route,
 * `GET /api/v1/time-entries/clock-salon`. The web renders this answer and computes no rule.
 *
 * This file proves the route-level read answer: the pattern salon is preselected, whether a
 * choice is offered at all, the active salons (ids and names only) when it is, and the salon a
 * day's existing entry is fixed to.
 *
 * Mutation proofs (recorded here, not re-run by CI), all on contexts/time-tracking/clock-salon-choice.ts:
 * - M1, disabling the day-entry branch (rule step 1), turns red: the D-04 running/finished/
 *   deactivated case (still true after Amendment 2026-10-16 below);
 * - M2, dropping the active-id filter on the assignment salons, turns red: "AC-6: HOME A + a running
 *   DEPLOYMENT on a deactivated salon -> no choice";
 * - M3, forcing the multi-salon rule to true, turns red: the single-salon AC-6 case, the single-salon
 *   D-04 case and the final key/foreign-salon sweep.
 *
 * Amendment 2026-10-16 (Issue #70, Phase 70b-06, D-02/D-11): a FINISHED day no longer answers "no
 * choice". It names the salon a plain re-clock continues (`fixedSalon`) and, in a multi-salon tenant,
 * offers the other active salons (a second-salon entry); only a RUNNING day still offers nothing. The
 * D-04 case below is amended for exactly that; the running expectation is unchanged. The full
 * booked-day matrix lives in `clock-salon-choice-70.test.ts`.
 *
 * No person names in fixtures. Every fixture id is a UUID.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  grantSystemRole,
  removeFixtureRoleAssignments,
} from "./setup";
import { addDaysStr, mondayOfWeekStr, TEST_TZ } from "./test-dates";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

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

describe("Issue #87 — GET /time-entries/clock-salon (read path)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string; name: string };
  let salonB: { id: string; name: string };
  let single: Awaited<ReturnType<typeof seedTestData>>;
  // Every 200 body the matrix saw, for the shape and the no-foreign-salon assertions at the end.
  const seenBodies: ChoiceBody[] = [];

  // A past Monday far enough back that no other file's fixtures matter; Thursday = Monday + 3.
  const baseMonday = addDaysStr(mondayOfWeekStr(), -10 * 7);
  const thursday = addDaysStr(baseMonday, 3);

  /** GET /clock-salon at `hhmm` of `dayStr` (tenant time) with the given token. */
  async function choice(dayStr: string, hhmm: string, token?: string, query = "") {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(dayStr, hhmm));
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries/clock-salon${query}`,
        headers: token === "" ? {} : { authorization: `Bearer ${token ?? seed.empToken}` },
      });
      if (res.statusCode === 200) seenBodies.push(JSON.parse(res.body) as ChoiceBody);
      return res;
    } finally {
      vi.useRealTimers();
    }
  }

  /** The 200 body of {@link choice}. */
  async function answer(dayStr: string, hhmm: string, token?: string): Promise<ChoiceBody> {
    const res = await choice(dayStr, hhmm, token);
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as ChoiceBody;
  }

  /** POST /clock-in or /:id/clock-out at `hhmm` of `dayStr` (tenant time). */
  async function post(url: string, dayStr: string, hhmm: string, token: string, payload: object) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(dayStr, hhmm));
    try {
      return await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    } finally {
      vi.useRealTimers();
    }
  }

  /** A fresh person of `tenantId` with an own user, so every case owns its assignment rows. */
  async function createPerson(
    tenantId: string,
    label: string,
    role: "EMPLOYEE" | "MANAGER" = "EMPLOYEE",
  ) {
    const s = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
    const user = await app.prisma.user.create({
      data: {
        email: `csc87-${label}-${s}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role,
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `C87-${s}`.slice(0, 20),
        firstName: label,
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    await grantSystemRole(app.prisma, { tenantId, userId: user.id, role });
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
    validFrom: string,
    validUntil: string | null,
    weekdays: number[] = [],
  ) {
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId,
        kind,
        validFrom: new Date(validFrom),
        validUntil: validUntil ? new Date(validUntil) : null,
        weekdays,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "csc87");
    single = await seedTestData(app, "csc87-single");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon Nord" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon Ost" });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonB.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [3], // Thursday
      },
    });
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

  /** The tenant's active salons as the route must list them: name (de), then id. */
  async function expectedActiveSalons(tenantId: string): Promise<SalonItem[]> {
    const rows = await app.prisma.salon.findMany({ where: { tenantId, isActive: true } });
    return rows
      .map((s) => ({ id: s.id, name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name, "de") || (a.id < b.id ? -1 : 1));
  }

  it("tracer: HOME A + Thursday DEPLOYMENT B -> B preselected, choice offered with all active salons", async () => {
    const res = await choice(thursday, "09:00");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      offerChoice: true,
      preselectedSalonId: salonB.id,
      salons: await expectedActiveSalons(seed.tenant.id),
      fixedSalon: null,
    } satisfies ChoiceBody);
  });

  it("the Monday of the same week preselects the HOME salon A", async () => {
    const res = await choice(baseMonday, "09:00");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ChoiceBody;
    expect(body.preselectedSalonId).toBe(salonA.id);
    expect(body.offerChoice).toBe(true);
    expect(body.salons).toHaveLength(3);
  });

  // ── AC-6: nothing to choose ──

  it("AC-6: HOME A only -> no choice, A preselected, no salon list", async () => {
    const p = await createPerson(seed.tenant.id, "homeonly");
    await assign(seed.tenant.id, p.employee.id, salonA.id, "HOME", "2020-01-01", null);
    expect(await answer(thursday, "09:00", p.token)).toEqual({
      offerChoice: false,
      preselectedSalonId: salonA.id,
      salons: [],
      fixedSalon: null,
    });
  });

  it("AC-6: a single-active-salon tenant never offers a choice and names no salon", async () => {
    const p = await createPerson(single.tenant.id, "singlesalon");
    await assign(single.tenant.id, p.employee.id, single.salonId, "HOME", "2020-01-01", null);
    expect(await answer(thursday, "09:00", p.token)).toEqual({
      offerChoice: false,
      preselectedSalonId: null,
      salons: [],
      fixedSalon: null,
    });
  });

  it("AC-6: HOME A + a DEPLOYMENT B that ended before today -> no choice", async () => {
    const p = await createPerson(seed.tenant.id, "ended");
    await assign(seed.tenant.id, p.employee.id, salonA.id, "HOME", "2020-01-01", null);
    await assign(
      seed.tenant.id,
      p.employee.id,
      salonB.id,
      "DEPLOYMENT",
      "2020-01-01",
      "2020-12-31",
      [3],
    );
    const body = await answer(thursday, "09:00", p.token);
    expect(body.offerChoice).toBe(false);
    expect(body.preselectedSalonId).toBe(salonA.id);
    expect(body.salons).toEqual([]);
  });

  it("AC-6: HOME A + a VOIDED DEPLOYMENT B -> no choice", async () => {
    const p = await createPerson(seed.tenant.id, "voided");
    await assign(seed.tenant.id, p.employee.id, salonA.id, "HOME", "2020-01-01", null);
    // validUntil before validFrom (voided), validUntil still in the future of `thursday`.
    await assign(
      seed.tenant.id,
      p.employee.id,
      salonB.id,
      "DEPLOYMENT",
      addDaysStr(thursday, 10),
      addDaysStr(thursday, 5),
      [3],
    );
    const body = await answer(thursday, "09:00", p.token);
    expect(body.offerChoice).toBe(false);
    expect(body.preselectedSalonId).toBe(salonA.id);
    expect(body.salons).toEqual([]);
  });

  it("AC-6: HOME A + a FUTURE DEPLOYMENT B -> a choice is offered, A stays preselected", async () => {
    const p = await createPerson(seed.tenant.id, "future");
    await assign(seed.tenant.id, p.employee.id, salonA.id, "HOME", "2020-01-01", null);
    await assign(
      seed.tenant.id,
      p.employee.id,
      salonB.id,
      "DEPLOYMENT",
      addDaysStr(thursday, 14),
      null,
      [3],
    );
    const body = await answer(thursday, "09:00", p.token);
    expect(body.offerChoice).toBe(true);
    expect(body.preselectedSalonId).toBe(salonA.id);
    expect(body.salons).toEqual(await expectedActiveSalons(seed.tenant.id));
  });

  it("AC-6: HOME A + a running DEPLOYMENT on a deactivated salon -> no choice (nothing to clock into there)", async () => {
    // The Unterbau ends deployments when a salon is deactivated through its API; this row exists
    // only because the salon is deactivated directly, to pin that such a row offers nothing.
    const x = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon Abgemeldet" });
    const p = await createPerson(seed.tenant.id, "deactdeploy");
    await assign(seed.tenant.id, p.employee.id, salonA.id, "HOME", "2020-01-01", null);
    await assign(seed.tenant.id, p.employee.id, x.id, "DEPLOYMENT", "2020-01-01", null, [1]);
    await app.prisma.salon.update({ where: { id: x.id }, data: { isActive: false } });
    const body = await answer(thursday, "09:00", p.token);
    expect(body.offerChoice).toBe(false);
    expect(body.preselectedSalonId).toBe(salonA.id);
    expect(body.salons).toEqual([]);
  });

  // ── AC-7: no pattern ──

  it("AC-7: no assignment at all -> choice with null preselection; the clock-in then books the chosen salon", async () => {
    const p = await createPerson(seed.tenant.id, "noassign");
    expect(await answer(thursday, "09:00", p.token)).toEqual({
      offerChoice: true,
      preselectedSalonId: null,
      salons: await expectedActiveSalons(seed.tenant.id),
      fixedSalon: null,
    });
    const res = await post("/api/v1/time-entries/clock-in", thursday, "09:05", p.token, {
      source: "MOBILE",
      salonId: salonB.id,
    });
    expect(res.statusCode).toBe(200);
    const entryId = (JSON.parse(res.body) as { resolution: { entry: { id: string } } }).resolution
      .entry.id;
    const row = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(row.salonId).toBe(salonB.id);
  });

  it("AC-7: a pattern salon that was deactivated is never preselected and never listed", async () => {
    const x = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon Stillgelegt" });
    const p = await createPerson(seed.tenant.id, "deactpattern");
    await assign(seed.tenant.id, p.employee.id, x.id, "HOME", "2020-01-01", null);
    await app.prisma.salon.update({ where: { id: x.id }, data: { isActive: false } });
    const body = await answer(thursday, "09:00", p.token);
    expect(body.offerChoice).toBe(true);
    expect(body.preselectedSalonId).toBeNull();
    expect(body.salons.map((salon) => salon.id)).not.toContain(x.id);
    expect(body.salons).toEqual(await expectedActiveSalons(seed.tenant.id));
  });

  // ── D-04: a booked day names its fixed salon ──

  it("D-04: a running entry fixes the salon; the pattern and the list disappear; finished and deactivated keep it and (#70) offer the others", async () => {
    const c = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon West" });
    const p = await createPerson(seed.tenant.id, "dayfixed");
    await assign(seed.tenant.id, p.employee.id, salonA.id, "HOME", "2020-01-01", null);
    await assign(seed.tenant.id, p.employee.id, salonB.id, "DEPLOYMENT", "2020-01-01", null, [3]);

    const inRes = await post("/api/v1/time-entries/clock-in", thursday, "09:00", p.token, {
      source: "MOBILE",
      salonId: c.id,
    });
    expect(inRes.statusCode).toBe(200);
    const entryId = (JSON.parse(inRes.body) as { resolution: { entry: { id: string } } }).resolution
      .entry.id;
    const fixed = {
      offerChoice: false,
      preselectedSalonId: null,
      salons: [],
      fixedSalon: { id: c.id, name: c.name },
    };

    // Running (open) entry.
    expect(await answer(thursday, "09:30", p.token)).toEqual(fixed);

    // Finished entry (Amendment #70): the same fixed salon, plus the other active salons offered.
    const outRes = await post(
      `/api/v1/time-entries/${entryId}/clock-out`,
      thursday,
      "12:00",
      p.token,
      {},
    );
    expect(outRes.statusCode).toBe(200);
    const finished = (salons: SalonItem[]) => ({
      offerChoice: true,
      preselectedSalonId: salonB.id, // the Thursday DEPLOYMENT salon, which is among the offered
      salons,
      fixedSalon: { id: c.id, name: c.name },
    });
    const others = (await expectedActiveSalons(seed.tenant.id)).filter((s) => s.id !== c.id);
    expect(await answer(thursday, "12:30", p.token)).toEqual(finished(others));

    // The salon is deactivated afterwards: the entry's history still names it.
    await app.prisma.salon.update({ where: { id: c.id }, data: { isActive: false } });
    expect(await answer(thursday, "13:00", p.token)).toEqual(
      finished(await expectedActiveSalons(seed.tenant.id)),
    );
  });

  it("D-04: in a single-salon tenant an existing entry names no salon (#64)", async () => {
    const p = await createPerson(single.tenant.id, "singleentry");
    const inRes = await post("/api/v1/time-entries/clock-in", thursday, "09:00", p.token, {
      source: "MOBILE",
    });
    expect(inRes.statusCode).toBe(200);
    expect(await answer(thursday, "09:30", p.token)).toEqual({
      offerChoice: false,
      preselectedSalonId: null,
      salons: [],
      fixedSalon: null,
    });
  });

  // ── D-03: own clock only, permission-gated ──

  it("D-03: no token -> 401", async () => {
    const res = await choice(thursday, "09:00", "");
    expect(res.statusCode).toBe(401);
  });

  it("D-03: a caller holding neither reach of time-entry:create -> 403 Forbidden", async () => {
    const p = await createPerson(seed.tenant.id, "kunde");
    // This person's only stored assignment is the custom role below; the login in createPerson ran
    // while the system-role row existed.
    await removeFixtureRoleAssignments(app.prisma, [p.user.id]);
    const name = `Kundenrolle ${randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: seed.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(["role:read:ZUGEWIESEN"]),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        userId: p.user.id,
        accessRoleId: role.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    const res = await choice(thursday, "09:00", p.token);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
  });

  it("D-03: an API key (no employee) -> 400 Mitarbeiter nicht gefunden", async () => {
    const raw = `clk_${randomBytes(24).toString("hex")}`;
    await app.prisma.apiKey.create({
      data: {
        tenantId: seed.tenant.id,
        name: `csc87-${randomBytes(3).toString("hex")}`,
        keyHash: createHash("sha256").update(raw).digest("hex"),
        keyPrefix: raw.slice(0, 8),
        scopes: ["admin"],
        createdBy: seed.adminUser.id,
      },
    });
    const res = await choice(thursday, "09:00", raw);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });
  });

  it("D-03: a manager gets their OWN clock; a ?employeeId= query for another person is ignored", async () => {
    const manager = await createPerson(seed.tenant.id, "mgr", "MANAGER");
    const other = await createPerson(seed.tenant.id, "othermgr");
    await assign(seed.tenant.id, other.employee.id, salonA.id, "HOME", "2020-01-01", null);
    const res = await choice(thursday, "09:00", manager.token, `?employeeId=${other.employee.id}`);
    expect(res.statusCode).toBe(200);
    // The manager has no assignment: null preselection, choice offered. The other person's HOME A
    // would have answered { preselectedSalonId: A, offerChoice: false }.
    expect(JSON.parse(res.body)).toEqual({
      offerChoice: true,
      preselectedSalonId: null,
      salons: await expectedActiveSalons(seed.tenant.id),
      fixedSalon: null,
    });
  });

  // ── Shape and order ──

  it("the active salons are ordered by name (de) then id, Ä sorts with A", async () => {
    await createTestSalon(app.prisma, seed.tenant.id, { name: "Zebra Salon" });
    await createTestSalon(app.prisma, seed.tenant.id, { name: "Mitte Salon" });
    await createTestSalon(app.prisma, seed.tenant.id, { name: "Ärztehaus Salon" });
    const p = await createPerson(seed.tenant.id, "ordering");
    const body = await answer(thursday, "09:00", p.token);
    expect(body.salons).toEqual(await expectedActiveSalons(seed.tenant.id));
    const names = body.salons.map((salon) => salon.name);
    expect(names.indexOf("Ärztehaus Salon")).toBeLessThan(names.indexOf("Mitte Salon"));
    expect(names.indexOf("Mitte Salon")).toBeLessThan(names.indexOf("Zebra Salon"));
    // Ä is no code-unit-order outlier: it comes before "Salon Nord", not after "Zebra Salon".
    expect(names.indexOf("Ärztehaus Salon")).toBeLessThan(names.indexOf("Salon Nord"));
  });

  it("every 200 body has exactly the contract keys, items only id and name, and no foreign salon", async () => {
    expect(seenBodies.length).toBeGreaterThan(10);
    const foreignSalonId = single.salonId;
    for (const body of seenBodies) {
      expect(Object.keys(body).sort()).toEqual([
        "fixedSalon",
        "offerChoice",
        "preselectedSalonId",
        "salons",
      ]);
      for (const salon of body.salons) expect(Object.keys(salon).sort()).toEqual(["id", "name"]);
      if (body.fixedSalon) expect(Object.keys(body.fixedSalon).sort()).toEqual(["id", "name"]);
      // The single-salon tenant's answers are the only ones that may name its salon; none is a
      // multi-salon tenant answer, and none ever lists it.
      expect(body.salons.map((salon) => salon.id)).not.toContain(foreignSalonId);
      if (body.preselectedSalonId) expect(body.preselectedSalonId).not.toBe(foreignSalonId);
    }
    // A positive control: some answer did list salons, so the loop above checked something.
    expect(seenBodies.some((body) => body.salons.length > 0)).toBe(true);
  });
});
