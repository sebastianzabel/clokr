/**
 * Issue #85 (Phase 85b-03, D-08) — the server side of the Salonansicht: `GET /time-entries?salonId=`
 * returns every in-scope entry RECORDED in that salon over at most 31 days, for every person. The
 * entry decides (per-entry rule since Phase 91b), the person does not: a Springer homed in B who
 * worked in A shows up in A's view, and an entry recorded in B never shows up in A's view, not even
 * one of a person homed in A. The person view (`?employeeId=` without `salonId`) stays as it was.
 *
 * Fixture (June 2026): salons A and B, plus C (deactivated later) and F (a foreign tenant's salon).
 * H is homed in A with two entries in A and one in B. S is a Springer homed in B with one entry in
 * A and one in B. E is homed in B with entries only in B. MA holds SALONS [A], MB SALONS [B], MAC
 * SALONS [A, C]; the tenant admin is the whole-tenant control. No person names in fixtures.
 *
 * Mutation proof (Phase 85b-03, 2026-10-13) — recorded here, not re-run by CI; each change was
 * reverted with `cp` from a backup (cmp clean) after the red names below were observed:
 * M1 resolveSalonInReach drops the scoped-reach membership line → red on "MA: a salon out of
 *    reach, a deactivated salon, a foreign tenant's salon and an unknown id answer byte-identical
 *    404s" (salon B answered 200).
 * M2 the salon branch drops the `salonId` condition from the where → red on "the salon view of A
 *    never contains an entry recorded in another salon" (H's B entry appeared).
 * M3 the salon branch falls back to the caller's own employeeId → red on "MA, salonId A: every
 *    entry recorded in A, of all persons, ordered by date then name".
 *
 * Harness: no fake clock needed — every request names an explicit window.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import crypto, { randomUUID } from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS, normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "test1234";

interface ListItem {
  id: string;
  salonId: string;
  date: string;
  employeeId: string;
  employee: { firstName: string; lastName: string };
  workingMinutes: number | null;
  presenceMinutes: number | null;
  breaks: unknown[];
  activityShares: unknown[];
}

describe("Issue #85 (Phase 85b-03) — GET /time-entries?salonId, the Salonansicht", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  let salonC: string;
  let salonF: string;
  let empH: { id: string };
  let empS: { id: string };
  let empE: { id: string };
  let tokenMA: string;
  let tokenMB: string;
  let tokenMAC: string;
  let tokenPersons: string;
  let tokenPlain: string;
  const entryIds: Record<string, string> = {};

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string, lastName: string, tenantId: string) {
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
        lastName,
        hireDate: new Date("2024-01-01T00:00:00Z"),
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

  async function entry(key: string, employeeId: string, salonId: string, date: string) {
    const row = await app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T08:00:00Z`),
        endTime: new Date(`${date}T16:00:00Z`),
        breakMinutes: 30,
        type: "WORK",
        source: "MANUAL",
      },
    });
    entryIds[key] = row.id;
    return row;
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

  async function salonManager(label: string, salonIds: string[]): Promise<string> {
    const m = await createEmployee(label, "Mgr85", data.tenant.id);
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: m.user.id,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds,
        employeeIds: [],
      },
    });
    return login(m.user.email);
  }

  function list(token: string, query: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/time-entries?${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  function ids(res: { body: string }): string[] {
    return (JSON.parse(res.body) as ListItem[]).map((e) => e.id);
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sv85t");
    foreign = await seedTestData(app, "sv85f");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "SV85 B" })).id;
    salonC = (await createTestSalon(app.prisma, data.tenant.id, { name: "SV85 C" })).id;
    salonF = foreign.salonId;
    const tenantId = data.tenant.id;

    // Names sort H < S < E on purpose (last name), so the order assertion has a real tie-break.
    const h = await createEmployee("Hh", "Aa85", tenantId);
    empH = h.employee;
    await home(tenantId, empH.id, salonA);
    const s = await createEmployee("Ss", "Bb85", tenantId);
    empS = s.employee;
    await home(tenantId, empS.id, salonB);
    const e = await createEmployee("Ee", "Cc85", tenantId);
    empE = e.employee;
    await home(tenantId, empE.id, salonB);

    await entry("H_A1", empH.id, salonA, "2026-06-03");
    await entry("H_A2", empH.id, salonA, "2026-06-04");
    await entry("H_B", empH.id, salonB, "2026-06-10");
    await entry("S_A", empS.id, salonA, "2026-06-03");
    await entry("S_B", empS.id, salonB, "2026-06-11");
    await entry("E_B1", empE.id, salonB, "2026-06-05");
    await entry("E_B2", empE.id, salonB, "2026-06-12");

    tokenMA = await salonManager("MgrA", [salonA]);
    tokenMB = await salonManager("MgrB", [salonB]);
    tokenMAC = await salonManager("MgrAC", [salonA, salonC]);

    // A custom role holding time-entry:read:ZUGEWIESEN scoped to PERSONS [S]: no salon in reach.
    const persons = await createEmployee("MgrP", "Mgr85", tenantId);
    const roleName = `Persons ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId,
        name: roleName,
        nameKey: roleNameKey(roleName),
        permissions: normalizeRolePermissions(["time-entry:read:ZUGEWIESEN"]),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId,
        userId: persons.user.id,
        accessRoleId: role.id,
        scopeType: "PERSONS",
        salonIds: [],
        employeeIds: [empS.id],
      },
    });
    tokenPersons = await login(persons.user.email);

    const plain = await createEmployee("Plain", "Pl85", tenantId);
    await app.prisma.roleAssignment.create({
      data: {
        tenantId,
        userId: plain.user.id,
        accessRoleId: SYSTEM_ROLE_IDS.EMPLOYEE,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    tokenPlain = await login(plain.user.email);

    // Salon C is deactivated only after the manager MAC (reach [A, C]) was created.
    await app.prisma.salon.update({
      where: { id: salonC },
      data: { isActive: false, deactivatedAt: new Date() },
    });
  });

  afterAll(async () => {
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("time-entries-salon-view-85 cleanup failed:", err);
    }
    await closeTestApp();
  });

  const WINDOW = "from=2026-06-01&to=2026-06-30";

  // ── Task 1: the salon view ────────────────────────────────────────────────────────────────

  it("MA, salonId A: every entry recorded in A, of all persons, ordered by date then name", async () => {
    const res = await list(tokenMA, `salonId=${salonA}&${WINDOW}`);
    expect(res.statusCode, res.body).toBe(200);
    const items = JSON.parse(res.body) as ListItem[];
    // 06-03: H (Aa85) before S (Bb85); then 06-04: H.
    expect(items.map((i) => i.id)).toEqual([entryIds.H_A1, entryIds.S_A, entryIds.H_A2]);
    for (const item of items) {
      expect(item.salonId).toBe(salonA);
      expect(typeof item.employee.firstName).toBe("string");
      expect(typeof item.employee.lastName).toBe("string");
      expect(item.workingMinutes).toBe(450);
      expect(item.presenceMinutes).toBe(480);
      expect(Array.isArray(item.breaks)).toBe(true);
      expect(Array.isArray(item.activityShares)).toBe(true);
    }
  });

  it("the tenant admin, salonId A: the same id set (control: whole-tenant reach)", async () => {
    const res = await list(data.adminToken, `salonId=${salonA}&${WINDOW}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(ids(res)).toEqual([entryIds.H_A1, entryIds.S_A, entryIds.H_A2]);
  });

  it("MB, salonId B: every entry recorded in B — H, the Springer S and E", async () => {
    const res = await list(tokenMB, `salonId=${salonB}&${WINDOW}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(ids(res)).toEqual([entryIds.E_B1, entryIds.H_B, entryIds.S_B, entryIds.E_B2]);
  });

  it("the salon view of A never contains an entry recorded in another salon", async () => {
    const res = await list(tokenMA, `salonId=${salonA}&${WINDOW}`);
    expect(res.statusCode, res.body).toBe(200);
    const got = ids(res);
    // H is homed in A, but his B entry is recorded in B.
    expect(got).not.toContain(entryIds.H_B);
    expect(got).not.toContain(entryIds.S_B);
    expect(got).not.toContain(entryIds.E_B1);
  });

  it("the person view is unchanged: MA with employeeId H sees all three of H's entries (Stammsalon rule)", async () => {
    const res = await list(tokenMA, `${WINDOW}&employeeId=${empH.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect([...ids(res)].sort((a, b) => a.localeCompare(b))).toEqual(
      [entryIds.H_A1, entryIds.H_A2, entryIds.H_B].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("the person view is unchanged: MA with employeeId S sees only S's A entry", async () => {
    const res = await list(tokenMA, `${WINDOW}&employeeId=${empS.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(ids(res)).toEqual([entryIds.S_A]);
  });

  it("MA, employeeId S and salonId A: the intersection, only S's A entry", async () => {
    const res = await list(tokenMA, `salonId=${salonA}&${WINDOW}&employeeId=${empS.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(ids(res)).toEqual([entryIds.S_A]);
  });

  // ── Task 2: rejections ────────────────────────────────────────────────────────────────────

  it("a plain employee (EIGENE reach) with salonId gets 403", async () => {
    const res = await list(tokenPlain, `salonId=${salonA}&${WINDOW}`);
    expect(res.statusCode, res.body).toBe(403);
  });

  it("MA: a missing from or to answers 400 with the German window message", async () => {
    const noFrom = await list(tokenMA, `salonId=${salonA}&to=2026-06-30`);
    const noTo = await list(tokenMA, `salonId=${salonA}&from=2026-06-01`);
    const neither = await list(tokenMA, `salonId=${salonA}`);
    for (const res of [noFrom, noTo, neither]) {
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toContain("Start- und Enddatum erforderlich");
    }
  });

  it("MA: from after to answers 400", async () => {
    const res = await list(tokenMA, `salonId=${salonA}&from=2026-06-10&to=2026-06-09`);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain("Startdatum darf nicht nach dem Enddatum liegen");
  });

  it("MA: 32 inclusive days answer 400, 31 inclusive days answer 200", async () => {
    const tooLong = await list(tokenMA, `salonId=${salonA}&from=2026-06-01&to=2026-07-02`);
    expect(tooLong.statusCode, tooLong.body).toBe(400);
    expect(tooLong.body).toContain("höchstens 31 Tage");
    const ok = await list(tokenMA, `salonId=${salonA}&from=2026-06-01&to=2026-07-01`);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("MA: a malformed salonId answers 400", async () => {
    const res = await list(tokenMA, `salonId=not-a-uuid&${WINDOW}`);
    expect(res.statusCode, res.body).toBe(400);
  });

  it("MA: a salon out of reach, a deactivated salon, a foreign tenant's salon and an unknown id answer byte-identical 404s", async () => {
    const responses = [];
    for (const salonId of [salonB, salonC, salonF, randomUUID()]) {
      responses.push(await list(tokenMAC, `salonId=${salonId}&${WINDOW}`));
    }
    for (const res of responses) expect(res.statusCode, res.body).toBe(404);
    const bodies = new Set(responses.map((r) => r.body));
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toBe('{"error":"Salon nicht gefunden"}');
    // The control: salon A is in MAC's reach and active.
    const ok = await list(tokenMAC, `salonId=${salonA}&${WINDOW}`);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("the tenant admin: a foreign salon, an unknown id and a deactivated salon answer the same 404; salon B answers 200", async () => {
    const responses = [];
    for (const salonId of [salonF, randomUUID(), salonC]) {
      responses.push(await list(data.adminToken, `salonId=${salonId}&${WINDOW}`));
    }
    for (const res of responses) expect(res.statusCode, res.body).toBe(404);
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
    const ok = await list(data.adminToken, `salonId=${salonB}&${WINDOW}`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ids(ok).length).toBe(4);
  });

  it("a PERSONS-only reach names no salon: salon A answers the same 404", async () => {
    const res = await list(tokenPersons, `salonId=${salonA}&${WINDOW}`);
    expect(res.statusCode, res.body).toBe(404);
    expect(res.body).toBe('{"error":"Salon nicht gefunden"}');
  });

  it("a foreign tenant's admin with this tenant's salon A gets the same 404 and no entry of this tenant", async () => {
    const res = await list(foreign.adminToken, `salonId=${salonA}&${WINDOW}`);
    expect(res.statusCode, res.body).toBe(404);
    expect(res.body).toBe('{"error":"Salon nicht gefunden"}');
    for (const id of Object.values(entryIds)) expect(res.body).not.toContain(id);
  });
});
