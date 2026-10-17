/**
 * Issue #542 (CTX-1, CTX-2; P-01..P-04, D-542-1) — `GET /api/v1/reports/monthly?salonId=`.
 *
 * A chosen salon narrows the monthly report to the persons who recorded time in it or are homed
 * in it on at least one day of the month; Ist follows the ENTRY's salon through tenant-local
 * yesterday, sick days follow the Stammsalon per day, and everything that is a contract figure of
 * the person (Soll, Saldo, Überstunden, the priced leave counts) is withheld with a reason. The
 * unfiltered answer carries none of the additive keys.
 *
 * Fixture (tenant Europe/Berlin, `Date` faked to 2026-07-15T10:00Z, report month June 2026 — fully
 * past): salon A is the seeded salon, B a second one. No person names; synthetic mails.
 *   PA homed A: closed entries in A on 1.-3.6. (3 x 8 h) and in B on 4.6. (4 h), one approved
 *               vacation day on 12.6.
 *   PB homed B: B entries on 9.6. and 10.6. (8 h each), one A entry on 8.6. (4 h)
 *   PX homed B until 15.6., A from 16.6.: approved sick leave 10.-20.6. without attest (11 days:
 *               6 in B, 5 in A), B entries on 1.6./2.6. (8 h each), A entries on 22.6./23.6. (8 h each)
 *   PN homed B: entries only in B (8 h on 5.6.)
 * The mutation proofs M1..M5 (validation after the read, no `countsDay`, Ist over every salon,
 * membership without the caller's scope, today counted) are recorded in the docblock of
 * report-salon-filter-source-542.test.ts with the red tests of each.
 *
 * PX additionally has an approved vacation on 18.-19.6. and a CONFIRMED section 9 credit for 18.6.
 * (a day homed in A); PA has closed A entries on 14.7. and 15.7. for the running-month case.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { createPopulationPerson } from "./population-fixtures-613";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { normalizeRolePermissions, roleNameKey, SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";

type Row = Record<string, unknown> & {
  employeeId: string;
  workedHours: number;
  sickDays: number;
};
type Report = Record<string, unknown> & { rows: Row[] };

const FAKE_NOW = "2026-07-15T10:00:00.000Z";
const WITHHELD_KEYS = [
  "shouldHours",
  "overtimeHours",
  "overtimeConfirmed",
  "balanceAdjustmentHours",
  "vacationDays",
  "overtimeCompDays",
  "specialLeaveDays",
  "educationDays",
  "unpaidDays",
  "maternityDays",
  "parentalDays",
  "totalAbsenceDays",
] as const;
const ADDITIVE_KEYS = [
  "salonId",
  "workedBasis",
  "sollUnavailableReason",
  "leaveDaysUnavailableReason",
] as const;

describe("Issue #542 — monthly report salon filter", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  let inactiveSalon: string;
  const ids = {} as Record<"PA" | "PB" | "PX" | "PN", string>;
  let scopedToken: string;
  let personsToken: string;
  let hrToken: string;

  function entry(employeeId: string, salonId: string, date: string, start: string, end: string) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T${start}:00Z`),
        endTime: new Date(`${date}T${end}:00Z`),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
      },
    });
  }

  function get(url: string, token = data.adminToken) {
    return app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function report(query: string, token = data.adminToken): Promise<Report> {
    const res = await get(`/api/v1/reports/monthly?${query}`, token);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Report;
  }

  const rowOf = (r: Report, id: string): Row => {
    const row = r.rows.find((x) => x.employeeId === id);
    if (!row) throw new Error(`row ${id} missing`);
    return row;
  };
  const idSet = (r: Report) => r.rows.map((x) => x.employeeId).sort((a, b) => a.localeCompare(b));
  const sorted = (xs: string[]) => [...xs].sort((a, b) => a.localeCompare(b));

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FAKE_NOW));
    app = await getTestApp();
    data = await seedTestData(app, "rsf542");
    foreign = await seedTestData(app, "rsf542f");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Filter542 B" })).id;
    inactiveSalon = (
      await createTestSalon(app.prisma, data.tenant.id, { name: "Filter542 off", isActive: false })
    ).id;

    const hire = new Date("2025-01-01T00:00:00Z");
    const mk = async (tag: "PA" | "PB" | "PX" | "PN", salonId: string) => {
      const p = await createPopulationPerson(app, {
        tenantId: data.tenant.id,
        salonId,
        tag,
        hireDate: hire,
      });
      ids[tag] = p.employeeId;
      return p;
    };
    await mk("PA", salonA);
    await mk("PB", salonB);
    await mk("PX", salonB);
    await mk("PN", salonB);

    // PX changes Stammsalon at mid-month: the first HOME row ends on 15.6., the second starts 16.6.
    await app.prisma.employeeSalonAssignment.updateMany({
      where: { employeeId: ids.PX, kind: "HOME" },
      data: { validUntil: new Date("2026-06-15T00:00:00Z") },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: ids.PX,
        salonId: salonA,
        kind: "HOME",
        validFrom: new Date("2026-06-16T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });

    for (const d of ["2026-06-01", "2026-06-02", "2026-06-03"]) {
      await entry(ids.PA, salonA, d, "08:00", "16:00");
    }
    await entry(ids.PA, salonB, "2026-06-04", "08:00", "12:00");
    await entry(ids.PB, salonA, "2026-06-08", "08:00", "12:00");
    await entry(ids.PB, salonB, "2026-06-09", "08:00", "16:00");
    await entry(ids.PB, salonB, "2026-06-10", "08:00", "16:00");
    await entry(ids.PX, salonB, "2026-06-01", "08:00", "16:00");
    await entry(ids.PX, salonB, "2026-06-02", "08:00", "16:00");
    await entry(ids.PX, salonA, "2026-06-22", "08:00", "16:00");
    await entry(ids.PX, salonA, "2026-06-23", "08:00", "16:00");
    await entry(ids.PN, salonB, "2026-06-05", "08:00", "16:00");

    const sick = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: ids.PX,
        leaveTypeId: sick.id,
        startDate: new Date("2026-06-10T00:00:00Z"),
        endDate: new Date("2026-06-20T00:00:00Z"),
        days: 7,
        status: "APPROVED",
        attestPresent: false,
      },
    });
    const sickRequest = await app.prisma.leaveRequest.findFirstOrThrow({
      where: { employeeId: ids.PX, leaveTypeId: sick.id },
    });
    const vacationPx = await app.prisma.leaveRequest.create({
      data: {
        employeeId: ids.PX,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-06-18T00:00:00Z"),
        endDate: new Date("2026-06-19T00:00:00Z"),
        days: 2,
        status: "APPROVED",
      },
    });
    await app.prisma.section9Credit.create({
      data: {
        employeeId: ids.PX,
        sickRequestId: sickRequest.id,
        vacationRequestId: vacationPx.id,
        overlapStart: new Date("2026-06-18T00:00:00Z"),
        overlapEnd: new Date("2026-06-19T00:00:00Z"),
        status: "CONFIRMED",
        creditedStart: new Date("2026-06-18T00:00:00Z"),
        creditedEnd: new Date("2026-06-18T00:00:00Z"),
        creditedDays: 1,
        attestSource: "EAU",
        attestValidFrom: new Date("2026-06-18T00:00:00Z"),
        attestValidTo: new Date("2026-06-18T00:00:00Z"),
        reason: "fixture",
      },
    });
    await entry(ids.PA, salonA, "2026-07-14", "08:00", "16:00");
    await entry(ids.PA, salonA, "2026-07-15", "08:00", "16:00");
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: ids.PA,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-06-12T00:00:00Z"),
        endDate: new Date("2026-06-12T00:00:00Z"),
        days: 1,
        status: "APPROVED",
      },
    });

    // Callers. Each is an employee of its own without a Stammsalon (in nobody's reach).
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const caller = async (
      tag: string,
      assignment:
        | { accessRoleId: string; scopeType: "TENANT" }
        | {
            permissions: string[];
            scopeType: "SALONS" | "PERSONS";
            salonIds?: string[];
            employeeIds?: string[];
          },
    ): Promise<string> => {
      const suffix = `${tag}-${randomBytes(3).toString("hex")}`;
      const user = await app.prisma.user.create({
        data: {
          email: `rsf542-${suffix}@example.invalid`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          employeeNumber: `RSF${suffix}`.toUpperCase().slice(0, 20),
          firstName: "Fixture",
          lastName: "ReportsSalonFilter542",
          hireDate: new Date("2024-01-01"),
        },
      });
      let accessRoleId: string;
      if ("accessRoleId" in assignment) {
        accessRoleId = assignment.accessRoleId;
      } else {
        const name = `Filter542 ${suffix}`;
        const role = await app.prisma.accessRole.create({
          data: {
            tenantId: data.tenant.id,
            name,
            nameKey: roleNameKey(name),
            permissions: normalizeRolePermissions(assignment.permissions),
          },
        });
        accessRoleId = role.id;
      }
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          accessRoleId,
          scopeType: assignment.scopeType,
          salonIds: "salonIds" in assignment ? (assignment.salonIds ?? []) : [],
          employeeIds: "employeeIds" in assignment ? (assignment.employeeIds ?? []) : [],
        },
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: user.email, password: PASSWORD },
      });
      expect(login.statusCode, login.body).toBe(200);
      return (JSON.parse(login.body) as { accessToken: string }).accessToken;
    };
    scopedToken = await caller("scoped", {
      permissions: ["report:read:ZUGEWIESEN"],
      scopeType: "SALONS",
      salonIds: [salonA],
    });
    personsToken = await caller("persons", {
      permissions: ["report:read:ZUGEWIESEN"],
      scopeType: "PERSONS",
      employeeIds: [ids.PA],
    });
    hrToken = await caller("hr", { accessRoleId: SYSTEM_ROLE_IDS.HR, scopeType: "TENANT" });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("tracer", () => {
    it("salon A lists the persons with an A entry or an A home day, with entry-salon Ist and Stammsalon sick days", async () => {
      const r = await report(`year=2026&month=6&salonId=${salonA}`);
      expect(idSet(r)).toEqual(sorted([ids.PA, ids.PB, ids.PX]));
      expect(rowOf(r, ids.PA).workedHours).toBe(24);
      expect(rowOf(r, ids.PB).workedHours).toBe(4);
      expect(rowOf(r, ids.PX).workedHours).toBe(16);
      expect(rowOf(r, ids.PX).sickDays).toBe(5);
      expect(rowOf(r, ids.PA).sickDays).toBe(0);
      expect(rowOf(r, ids.PB).sickDays).toBe(0);
    });

    it("withholds the contract figures with their reasons and adds exactly four keys", async () => {
      const filtered = await report(`year=2026&month=6&salonId=${salonA}`);
      const plain = await report(`year=2026&month=6`);
      for (const row of filtered.rows) {
        for (const k of WITHHELD_KEYS) expect(row[k], `${k}`).toBeNull();
        expect(Object.keys(row).sort((a, b) => a.localeCompare(b))).toEqual(
          Object.keys(plain.rows[0]).sort((a, b) => a.localeCompare(b)),
        );
      }
      expect(filtered.salonId).toBe(salonA);
      expect(filtered.workedBasis).toBe("SALON_ENTRIES");
      expect(filtered.sollUnavailableReason).toBe("SALON_FILTER");
      expect(filtered.leaveDaysUnavailableReason).toBe("SALON_FILTER");
    });

    it("salon B lists its persons and counts the other half of the sick leave", async () => {
      const r = await report(`year=2026&month=6&salonId=${salonB}`);
      expect(idSet(r)).toEqual(sorted([ids.PA, ids.PB, ids.PX, ids.PN]));
      expect(rowOf(r, ids.PX).sickDays).toBe(6);
      expect(rowOf(r, ids.PX).workedHours).toBe(16);
      expect(rowOf(r, ids.PA).workedHours).toBe(4);
      expect(rowOf(r, ids.PB).workedHours).toBe(16);
      expect(rowOf(r, ids.PN).workedHours).toBe(8);
    });

    it("the unfiltered answer carries none of the additive keys and keeps the contract figures", async () => {
      const r = await report(`year=2026&month=6`);
      for (const k of ADDITIVE_KEYS) expect(k in r, k).toBe(false);
      expect(rowOf(r, ids.PX).sickDays).toBe(11);
      expect(rowOf(r, ids.PA).vacationDays).toBe(1);
      expect(typeof rowOf(r, ids.PA).shouldHours).toBe("number");
    });

    it("answers the one 404 for a foreign, unknown and inactive salon, equal to the dashboard's", async () => {
      const urls = [
        `/api/v1/reports/monthly?year=2026&month=6&salonId=${foreign.salonId}`,
        `/api/v1/reports/monthly?year=2026&month=6&salonId=${randomUUID()}`,
        `/api/v1/reports/monthly?year=2026&month=6&salonId=${inactiveSalon}`,
      ];
      const bodies: string[] = [];
      for (const url of urls) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(404);
        bodies.push(res.body);
      }
      expect(new Set(bodies).size).toBe(1);
      const dash = await get(`/api/v1/dashboard/team-week?salonId=${foreign.salonId}`);
      expect(dash.statusCode).toBe(404);
      expect(bodies[0]).toBe(dash.body);
      expect(bodies[0]).toBe('{"error":"Salon nicht gefunden"}');
    });

    it("answers 400 for a malformed salon id", async () => {
      const res = await get(`/api/v1/reports/monthly?year=2026&month=6&salonId=not-a-uuid`);
      expect(res.statusCode, res.body).toBe(400);
    });
  });

  describe("never widens", () => {
    it("a SALONS-scoped caller's filtered rows are a subset of its unfiltered rows", async () => {
      const plain = await report(`year=2026&month=6`, scopedToken);
      const filtered = await report(`year=2026&month=6&salonId=${salonA}`, scopedToken);
      expect(idSet(plain)).toEqual(sorted([ids.PA, ids.PX]));
      expect(idSet(filtered)).toEqual(sorted([ids.PA, ids.PX]));
      for (const id of idSet(filtered)) expect(idSet(plain)).toContain(id);
      // PB is homed in B with an entry in A: reachable through neither the scope nor the filter.
      expect(idSet(filtered)).not.toContain(ids.PB);
      expect(idSet(plain)).not.toContain(ids.PB);
    });

    it("a salon outside the caller's reach answers the one 404", async () => {
      const outside = await get(
        `/api/v1/reports/monthly?year=2026&month=6&salonId=${salonB}`,
        scopedToken,
      );
      const foreignRes = await get(
        `/api/v1/reports/monthly?year=2026&month=6&salonId=${foreign.salonId}`,
        scopedToken,
      );
      expect(outside.statusCode).toBe(404);
      expect(outside.body).toBe(foreignRes.body);
      expect(outside.body).toBe('{"error":"Salon nicht gefunden"}');
    });

    it("a PERSONS-only reach is refused with the same 404 for every salon, and still lists its person unfiltered", async () => {
      const a = await get(
        `/api/v1/reports/monthly?year=2026&month=6&salonId=${salonA}`,
        personsToken,
      );
      const b = await get(
        `/api/v1/reports/monthly?year=2026&month=6&salonId=${salonB}`,
        personsToken,
      );
      expect(a.statusCode).toBe(404);
      expect(b.statusCode).toBe(404);
      expect(a.body).toBe(b.body);
      expect(a.body).toBe('{"error":"Salon nicht gefunden"}');
      const plain = await report(`year=2026&month=6`, personsToken);
      expect(idSet(plain)).toEqual([ids.PA]);
    });
  });

  describe("sums", () => {
    it("Ist and sick days of salon A plus salon B equal the unfiltered figures per person", async () => {
      const plain = await report(`year=2026&month=6`);
      const a = await report(`year=2026&month=6&salonId=${salonA}`);
      const b = await report(`year=2026&month=6&salonId=${salonB}`);
      const figure = (r: Report, id: string, key: "workedHours" | "sickDays") =>
        r.rows.find((x) => x.employeeId === id)?.[key] ?? 0;
      for (const id of [ids.PA, ids.PB, ids.PX, ids.PN]) {
        expect(figure(a, id, "workedHours") + figure(b, id, "workedHours"), `Ist ${id}`).toBe(
          figure(plain, id, "workedHours"),
        );
        expect(figure(a, id, "sickDays") + figure(b, id, "sickDays"), `sick ${id}`).toBe(
          figure(plain, id, "sickDays"),
        );
      }
    });
  });

  describe("running month", () => {
    it("today never counts toward the salon Ist", async () => {
      const r = await report(`year=2026&month=7&salonId=${salonA}`);
      expect(rowOf(r, ids.PA).workedHours).toBe(8);
    });
  });

  describe("section 9", () => {
    it("a credited day counts for the salon the Stammsalon names on that day", async () => {
      const a = await report(`year=2026&month=6&salonId=${salonA}`);
      expect(rowOf(a, ids.PX).section9DaysThisMonth).toBe(1);
      expect(typeof a.section9Note).toBe("string");
      const b = await report(`year=2026&month=6&salonId=${salonB}`);
      expect(rowOf(b, ids.PX).section9DaysThisMonth).toBe(0);
      expect(b.section9Note).toBeUndefined();
    });
  });

  describe("aggregates only", () => {
    it("the HR answer under a filter has the unfiltered key paths plus exactly the four additive keys", async () => {
      const plainRes = await get(`/api/v1/reports/monthly?year=2026&month=6`, hrToken);
      const filteredRes = await get(
        `/api/v1/reports/monthly?year=2026&month=6&salonId=${salonA}`,
        hrToken,
      );
      expect(plainRes.statusCode, plainRes.body).toBe(200);
      expect(filteredRes.statusCode, filteredRes.body).toBe(200);
      const plainPaths = keyPaths(JSON.parse(plainRes.body));
      const filteredPaths = keyPaths(JSON.parse(filteredRes.body));
      const added = [...filteredPaths].filter((p) => !plainPaths.has(p));
      expect(added.sort((x, y) => x.localeCompare(y))).toEqual(
        ADDITIVE_KEYS.map((k) => `$.${k}`).sort((x, y) => x.localeCompare(y)),
      );
      expect([...plainPaths].filter((p) => !filteredPaths.has(p))).toEqual([]);
    });
  });
});

describe("Issue #542 — one 404 for all four places", () => {
  // The four places of the issue: the monthly JSON, today's attendance, the Saldenübersicht and the
  // Monatsexport. An inadmissible salon - foreign tenant, unknown id, deactivated, or outside the
  // caller's reach on the endpoint's own permission - answers one and the same body everywhere, so
  // no place is a salon-membership oracle (T-100-09, #85 D-13). Clock 2026-07-15T10:00Z (past).
  const NOW = "2026-07-15T10:00:00.000Z";
  const PLACES = [
    "/api/v1/reports/monthly?year=2026&month=6",
    "/api/v1/dashboard/today-attendance?",
    "/api/v1/dashboard/overtime-overview?",
    "/api/v1/reports/monthly-export/pdf?year=2026&month=6",
  ] as const;
  const NOT_FOUND = '{"error":"Salon nicht gefunden"}';
  let app: FastifyInstance;
  let own: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;
  let salonB = "";
  let inactiveSalon = "";
  let restrictedToken = "";

  const urlWith = (place: string, salonId: string) =>
    `${place}${place.endsWith("?") ? "" : "&"}salonId=${salonId}`;
  const get = (url: string, token: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    app = await getTestApp();
    own = await seedTestData(app, "on542");
    other = await seedTestData(app, "on542f");
    salonB = (await createTestSalon(app.prisma, own.tenant.id, { name: "On542 B" })).id;
    inactiveSalon = (
      await createTestSalon(app.prisma, own.tenant.id, { name: "On542 off", isActive: false })
    ).id;

    // One caller holding each of the four permissions the places require, every one narrowed to
    // salon A (the seeded salon): the restricted reach of the endpoint's OWN permission.
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const suffix = randomBytes(3).toString("hex");
    const user = await app.prisma.user.create({
      data: {
        email: `on542-${suffix}@example.invalid`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: own.tenant.id,
        userId: user.id,
        employeeNumber: `ON${suffix}`.toUpperCase(),
        firstName: "Fixture",
        lastName: "OneNotFound542",
        hireDate: new Date("2024-01-01"),
      },
    });
    for (const permission of [
      "report:read:ZUGEWIESEN",
      "team-overview:read:ZUGEWIESEN",
      "overtime:read:ZUGEWIESEN",
      "report:export:ZUGEWIESEN",
    ]) {
      const name = `On542 ${permission} ${suffix}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId: own.tenant.id,
          name,
          nameKey: roleNameKey(name),
          permissions: normalizeRolePermissions([permission]),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: own.tenant.id,
          userId: user.id,
          accessRoleId: role.id,
          scopeType: "SALONS",
          salonIds: [own.salonId],
          employeeIds: [],
        },
      });
    }
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: user.email, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    restrictedToken = (JSON.parse(login.body) as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    vi.useRealTimers();
    for (const tenantId of [own?.tenant.id, other?.tenant.id]) {
      if (!tenantId) continue;
      try {
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId } });
        await app.prisma.accessRole.deleteMany({ where: { tenantId } });
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("reports-salon-filter-542 (404) cleanup failed:", err);
      }
    }
  });

  it("answers the tenant admin with one byte-identical 404 for a foreign, unknown and inactive salon on all four places", async () => {
    const bodies: string[] = [];
    for (const salonId of [other.salonId, randomUUID(), inactiveSalon]) {
      for (const place of PLACES) {
        const res = await get(urlWith(place, salonId), own.adminToken);
        expect(res.statusCode, `${place} ${salonId}`).toBe(404);
        expect(String(res.headers["content-type"]), `${place} content type`).toContain(
          "application/json",
        );
        bodies.push(res.body);
      }
    }
    expect(bodies).toHaveLength(12);
    for (const body of bodies) expect(body).toBe(NOT_FOUND);
  });

  it("answers a caller whose reach on each endpoint's own permission excludes salon B with the same body", async () => {
    const bodies: string[] = [];
    for (const place of PLACES) {
      const res = await get(urlWith(place, salonB), restrictedToken);
      expect(res.statusCode, place).toBe(404);
      bodies.push(res.body);
    }
    for (const body of bodies) expect(body).toBe(NOT_FOUND);
    // the same caller is admitted for its own salon on all four places (the 404 is the reach, not a stub)
    for (const place of PLACES) {
      const res = await get(urlWith(place, own.salonId), restrictedToken);
      expect(res.statusCode, `${place} own salon`).toBe(200);
    }
  });
});

/** The JSON key paths of a body, array indices collapsed to `[]` (idiom of reports-hr-86). */
function keyPaths(value: unknown, prefix = "$", out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    out.add(`${prefix}[]`);
    for (const el of value) keyPaths(el, `${prefix}[]`, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.add(`${prefix}.${k}`);
      keyPaths(v, `${prefix}.${k}`, out);
    }
  }
  return out;
}
