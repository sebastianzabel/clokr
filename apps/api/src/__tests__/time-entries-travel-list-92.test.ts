/**
 * Issue #92 (Phase 92b-03, AC-92-7, D-04) — `GET /time-entries` rows name both salons of a travel
 * entry.
 *
 * A travel entry carries `activityKind` TRAVEL, `salonId` (the DEPARTURE salon) and
 * `travelToSalonId` (the arrival salon, the control value). The list additionally serves the
 * display value `travelToSalonName`, produced by the same mechanism 70b-06 uses for `salonName`
 * (a select on the relation, flattened — no nested object and no extra id). Both are `null` on
 * every ordinary row, so the recorded neutrality bodies stay byte-identical.
 *
 * Fixture day (tenant time): A 08:00-12:00 salon A, T 12:00-12:30 travel A -> B, B 13:00-15:00
 * salon B. The arrival salon is deactivated in one case: the history still names it.
 *
 * Decision (recorded for the #92 comment): the arrival salon's NAME is shown to every reader of the
 * travel row. The row is inside the reader's reach, the pair is its content (AC-92-7), and a salon
 * name is tenant master data, not personal data — the same principle as naming a deactivated salon.
 *
 * No person names in fixtures. Every fixture id is a UUID.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { addDaysStr, mondayOfWeekStr, TEST_TZ } from "./test-dates";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";

type Row = Record<string, unknown> & {
  id: string;
  salonId: string;
  salonName: string;
  activityKind: string;
  travelToSalonId: string | null;
  travelToSalonName: string | null;
};

describe("Issue #92 — GET /time-entries rows of a travel entry name both salons", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string; name: string };
  let salonB: { id: string; name: string };
  let managerAToken: string;
  const ids: { a: string; t: string; b: string } = { a: "", t: "", b: "" };
  const day = addDaysStr(mondayOfWeekStr(), -11 * 7 + 2);
  const dateOf = new Date(`${day}T00:00:00Z`);
  const instant = (hhmm: string) => fromZonedTime(`${day}T${hhmm}:00`, TEST_TZ);

  async function get(url: string, token: string) {
    return app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function list(token: string, query = `from=${day}&to=${day}`): Promise<Row[]> {
    const res = await get(`/api/v1/time-entries?${query}`, token);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Row[];
  }

  const byId = (a: Row, b: Row) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1);

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "tl92");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon Alster" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon Elbe" });
    const base = { employeeId: seed.employee.id, date: dateOf, source: "MANUAL" as const };
    ids.a = (
      await app.prisma.timeEntry.create({
        data: {
          ...base,
          startTime: instant("08:00"),
          endTime: instant("12:00"),
          salonId: salonA.id,
        },
      })
    ).id;
    ids.t = (
      await app.prisma.timeEntry.create({
        data: {
          ...base,
          startTime: instant("12:00"),
          endTime: instant("12:30"),
          salonId: salonA.id,
          activityKind: "TRAVEL",
          travelToSalonId: salonB.id,
        },
      })
    ).id;
    ids.b = (
      await app.prisma.timeEntry.create({
        data: {
          ...base,
          startTime: instant("13:00"),
          endTime: instant("15:00"),
          salonId: salonB.id,
        },
      })
    ).id;

    // A salon manager whose reach is salon A only.
    const suffix = randomBytes(5).toString("hex");
    const user = await app.prisma.user.create({
      data: {
        email: `tl92-${suffix}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: seed.tenant.id,
        userId: user.id,
        employeeNumber: `TL92-${suffix}`.slice(0, 20),
        firstName: "Manager",
        lastName: "Reach",
        hireDate: new Date("2024-01-01T00:00:00Z"),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        userId: user.id,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds: [salonA.id],
        employeeIds: [],
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: user.email, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    managerAToken = (JSON.parse(login.body) as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("person view: the travel row names the departure and the arrival salon, the others carry null", async () => {
    const rows = (await list(seed.empToken)).sort(byId);
    expect(rows).toHaveLength(3);
    const t = rows.find((r) => r.id === ids.t)!;
    expect(t.activityKind).toBe("TRAVEL");
    expect(t.salonId).toBe(salonA.id);
    expect(t.salonName).toBe(salonA.name);
    expect(t.travelToSalonId).toBe(salonB.id);
    expect(t.travelToSalonName).toBe(salonB.name);
    for (const id of [ids.a, ids.b]) {
      const r = rows.find((x) => x.id === id)!;
      expect(r.activityKind).not.toBe("TRAVEL");
      expect(r.travelToSalonId).toBeNull();
      expect(r.travelToSalonName).toBeNull();
    }
  });

  it("the row key set is the 70b-06 one plus exactly travelToSalonId and travelToSalonName", async () => {
    const rows = await list(seed.empToken);
    const column = await app.prisma.timeEntry.findFirstOrThrow({ where: { id: ids.a } });
    // `Object.keys(column)` already holds every column of the row, `travelToSalonId` among them
    // (92b-01); the 70b-06 wire shape adds the three includes, the two derived display minutes and
    // `salonName`; this plan adds `travelToSalonName` and nothing else.
    const expected = [
      ...Object.keys(column),
      "employee",
      "breaks",
      "activityShares",
      "presenceMinutes",
      "workingMinutes",
      "salonName",
      "travelToSalonName",
    ].sort();
    for (const row of rows) {
      expect(row).not.toHaveProperty("salon");
      expect(row).not.toHaveProperty("travelToSalon");
      expect(Object.keys(row).sort()).toEqual(expected);
    }
    expect(Object.keys(column)).toContain("travelToSalonId");
  });

  it("a whole-tenant admin and the person see the same travel row fields", async () => {
    const own = (await list(seed.empToken)).find((r) => r.id === ids.t)!;
    const admin = (
      await list(seed.adminToken, `from=${day}&to=${day}&employeeId=${seed.employee.id}`)
    ).find((r) => r.id === ids.t)!;
    expect(admin).toEqual(own);
  });

  it("Salonansicht of A (manager SALONS [A]): the travel row is listed under its departure salon with both names", async () => {
    const rows = await list(managerAToken, `salonId=${salonA.id}&from=${day}&to=${day}`);
    expect(rows.map((r) => r.id).sort()).toEqual([ids.a, ids.t].sort());
    const t = rows.find((r) => r.id === ids.t)!;
    expect(t.salonId).toBe(salonA.id);
    expect(t.salonName).toBe(salonA.name);
    expect(t.travelToSalonId).toBe(salonB.id);
    expect(t.travelToSalonName).toBe(salonB.name);
  });

  it("Salonansicht of B lists B's entry and not the travel row", async () => {
    const rows = await list(seed.adminToken, `salonId=${salonB.id}&from=${day}&to=${day}`);
    expect(rows.map((r) => r.id)).toEqual([ids.b]);
    expect(rows[0].travelToSalonName).toBeNull();
  });

  it("the arrival salon's name stays after it is deactivated", async () => {
    await app.prisma.salon.update({ where: { id: salonB.id }, data: { isActive: false } });
    try {
      const t = (await list(seed.empToken)).find((r) => r.id === ids.t)!;
      expect(t.travelToSalonId).toBe(salonB.id);
      expect(t.travelToSalonName).toBe(salonB.name);
    } finally {
      await app.prisma.salon.update({ where: { id: salonB.id }, data: { isActive: true } });
    }
  });
});
