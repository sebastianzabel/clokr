/**
 * Issue #840 (AC-4, AC-5, D-840-19/18/25) — `GET /leave/calendar` decides the detail level PER
 * PERSON by the reader's `leave-request:read:ZUGEWIESEN` reach (Stammsalon per day), and the range
 * form (`?from&to`) answers `{ entries, salons }`. The first block holds the tracer cases (840-01),
 * the second the AC-4 / AC-5 matrix, PENDING drop, merge, bounds (840-03).
 *
 * Fixture (fake clock 2026-06-15T10:00Z, installed BEFORE the app boots): tenant with salons A and
 * B; pA homed in A, pB homed in B; a Salonmanager of A (stored SALONS role assignment). pA has an
 * APPROVED row, pB an APPROVED and a PENDING row. No person names.
 *
 * Mutation proof (Phase 840-01, 2026-11-08) — recorded here, not re-run by CI; reverted with cp:
 * M1 `GET /leave/calendar`: the per-row decision forced to `true` (everyone sees everything) → red:
 *    "pB's APPROVED row reaches the Salonmanager of A as exactly the masked key set" and "pB's
 *    PENDING row is not in the answer of the Salonmanager of A", "the year/month form keeps its
 *    bare array with the same per-person rule" (3 failed | 5 passed).
 *
 * Mutation proof (Phase 840-03, 2026-11-08) — recorded here, not re-run by CI; reverted with cp:
 * M2 `leave-limits/redact.ts` `isPersonVisibleOnSomeDay`: the day walk looks only at the FIRST day
 *    (`day <= fromDay`) → red: "AC-5 SALONS: a row spanning a Stammsalon change is detailed if ANY
 *    in-window day is in reach" (pY, homed in B until the 14th and in A from the 15th, turns masked;
 *    1 failed | 24 passed).
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
  createAdminApiKey,
  removeFixtureApiKeys,
  grantSystemRole,
} from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";
import { leaveTypeFields } from "../contexts/absence/leave-type";

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
type RangeBody = { entries: Entry[]; salons: { salonId: string; name: string }[] };

describe("Issue #840 — the calendar read masks per person by reach", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let managerToken: string;
  const emp: Record<string, string> = {};
  const req: Record<string, string> = {};

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
        lastName: "Cal840",
        hireDate: new Date("2024-01-01"),
      },
    });
    return { user, employee };
  }

  function home(employeeId: string, salonId: string) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
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

  function get(token: string, qs: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/leave/calendar?${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function range(token: string, qs: string): Promise<RangeBody> {
    const res = await get(token, qs);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as RangeBody;
  }

  const leaveRows = (body: RangeBody) => body.entries.filter((e) => e.isHoliday !== true);
  const RANGE = "from=2026-06-01&to=2026-06-30";

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "cal840");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Nord" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Ost" });

    const manager = await createEmployee("manager");
    await home(manager.employee.id, salonA.id);
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

    emp.pA = (await createEmployee("pA")).employee.id;
    emp.pB = (await createEmployee("pB")).employee.id;
    await home(emp.pA, salonA.id);
    await home(emp.pB, salonB.id);

    await leave("pA", "pA", "2026-06-02", "2026-06-03", "APPROVED");
    await leave("pB", "pB", "2026-06-10", "2026-06-12", "APPROVED");
    await leave("pBPending", "pB", "2026-06-20", "2026-06-21", "PENDING");
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("leave-calendar-masking-840 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("the range form answers { entries, salons }", async () => {
    const body = await range(managerToken, RANGE);
    expect(Object.keys(body).sort()).toEqual(["entries", "salons"]);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.salons).toEqual([]);
  });

  it("pA (homed in the manager's salon) is detailed", async () => {
    const body = await range(managerToken, RANGE);
    const row = leaveRows(body).find((e) => e.employeeId === emp.pA);
    expect(row).toBeDefined();
    expect(row?.id).toBe(req.pA);
    expect(row?.status).toBe("APPROVED");
    expect(row?.typeCode).toBeTruthy();
  });

  it("pB's APPROVED row reaches the Salonmanager of A as exactly the masked key set", async () => {
    const body = await range(managerToken, RANGE);
    const rows = leaveRows(body).filter((e) => e.employeeId === emp.pB);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(MASKED_KEYS);
    expect(rows[0]).toMatchObject({
      startDate: "2026-06-10",
      endDate: "2026-06-12",
      isOwn: false,
      masked: true,
    });
  });

  it("pB's PENDING row is not in the answer of the Salonmanager of A", async () => {
    const body = await range(managerToken, RANGE);
    const pbRows = leaveRows(body).filter((e) => e.employeeId === emp.pB);
    expect(pbRows.map((e) => e.startDate)).toEqual(["2026-06-10"]);
    expect(JSON.stringify(body)).not.toContain(req.pBPending);
  });

  it("the whole-tenant admin sees all three rows in detail", async () => {
    const body = await range(data.adminToken, RANGE);
    const rows = leaveRows(body);
    expect(rows.map((e) => e.id).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [req.pA, req.pB, req.pBPending].sort((a, b) => a.localeCompare(b)),
    );
    for (const row of rows) expect(row.masked).toBeUndefined();
  });

  it("a validated salonId is named in the range answer", async () => {
    const body = await range(data.adminToken, `${RANGE}&salonId=${salonA.id}`);
    expect(body.salons).toHaveLength(1);
    expect(body.salons[0]).toMatchObject({ salonId: salonA.id, name: "Salon Nord" });
  });

  it("the year/month form keeps its bare array with the same per-person rule", async () => {
    const res = await get(managerToken, "year=2026&month=6");
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as Entry[];
    expect(Array.isArray(body)).toBe(true);
    const pb = body.filter((e) => e.employeeId === emp.pB && e.isHoliday !== true);
    expect(pb).toHaveLength(1);
    expect(Object.keys(pb[0]).sort()).toEqual(MASKED_KEYS);
  });

  it("a window of 367 days, from after to, and a lone bound are 400", async () => {
    expect((await get(data.adminToken, "from=2026-01-01&to=2027-01-02")).statusCode).toBe(400);
    expect((await get(data.adminToken, "from=2026-06-10&to=2026-06-01")).statusCode).toBe(400);
    expect((await get(data.adminToken, "from=2026-06-10")).statusCode).toBe(400);
    expect((await get(data.adminToken, "from=2026-02-30&to=2026-03-02")).statusCode).toBe(400);
    // 366 days inclusive is the largest accepted window.
    expect((await get(data.adminToken, "from=2026-01-01&to=2027-01-01")).statusCode).toBe(200);
  });
});

// ── AC-4 / AC-5 matrix (840-03) ───────────────────────────────────────────────────────────────

const DETAIL_KEYS = ["id", "status", "halfDay", "typeCode", "typeName", "section9", "section9Days"];
const byId = (a: string, b: string) => a.localeCompare(b);

describe("Issue #840 — AC-4 / AC-5 matrix of the calendar read", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let apiKeyToken: string;
  const emp: Record<string, string> = {};
  const req: Record<string, string> = {};
  const token: Record<string, string> = {};
  let sickTypeId: string;

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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

  async function person(label: string, homeSalon: string | null = null) {
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
        lastName: "Matrix840",
        hireDate: new Date("2024-01-01"),
      },
    });
    await grantSystemRole(app.prisma, {
      tenantId: data.tenant.id,
      userId: user.id,
      role: "EMPLOYEE",
    });
    emp[label] = employee.id;
    if (homeSalon !== null) await home(label, homeSalon, "2024-01-01", null);
    return { user, employee };
  }

  function home(label: string, salonId: string, from: string, until: string | null) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: emp[label],
        salonId,
        kind: "HOME",
        validFrom: new Date(`${from}T00:00:00Z`),
        validUntil: until === null ? null : new Date(`${until}T00:00:00Z`),
        weekdays: [],
      },
    });
  }

  async function leave(
    key: string,
    label: string,
    start: string,
    end: string,
    opts: { status?: "APPROVED" | "PENDING"; sick?: boolean; halfDay?: boolean } = {},
  ) {
    const row = await app.prisma.leaveRequest.create({
      data: {
        employeeId: emp[label],
        leaveTypeId: opts.sick === true ? sickTypeId : data.vacationType.id,
        startDate: new Date(`${start}T00:00:00Z`),
        endDate: new Date(`${end}T00:00:00Z`),
        days: 1,
        halfDay: opts.halfDay ?? false,
        status: opts.status ?? "APPROVED",
      },
    });
    req[key] = row.id;
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

  const rowsOf = (body: RangeBody, label: string) =>
    body.entries.filter((e) => e.isHoliday !== true && e.employeeId === emp[label]);
  const RANGE = "from=2026-06-01&to=2026-06-30";

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "mx840");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Nord" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Ost" });
    sickTypeId = (
      (await app.prisma.leaveType.findFirst({
        where: { tenantId: data.tenant.id, code: "SICK" },
      })) ??
      (await app.prisma.leaveType.create({
        data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
      }))
    ).id;

    // Readers.
    const mgr = await person("mgrA", salonA.id);
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: mgr.user.id,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds: [salonA.id],
        employeeIds: [],
      },
    });
    token.mgrA = await login(mgr.user.email);

    const persons = await person("persReader");
    const roleName = `Matrix840 ${uniqueSuffix("r")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name: roleName,
        nameKey: roleNameKey(roleName),
        permissions: normalizeRolePermissions(["leave-request:read:ZUGEWIESEN"]),
      },
    });
    // The named person (pB) is created below; the assignment is written once its id exists.

    const none = await person("empNone", salonA.id);
    token.empNone = await login(none.user.email);
    // The same reach (none) homed in the other salon: with no `scope` a no-reach caller is answered
    // as `scope=team` (WR-04), so a colleague of pS's salon reads pS masked.
    const noneB = await person("empNoneB", salonB.id);
    token.empNoneB = await login(noneB.user.email);

    // Subjects.
    await person("pA", salonA.id);
    await person("pB", salonB.id);
    await person("pX", salonA.id); // A until the 14th, B from the 15th
    await person("pY", salonB.id); // B until the 14th, A from the 15th
    await person("pS", salonB.id);
    await person("pM1", salonB.id);
    await person("pM2", salonB.id);
    await person("pM3", salonB.id);
    await person("pLong", salonB.id);
    // pX / pY: replace the open-ended HOME row by two rows that meet on the 15th.
    await app.prisma.employeeSalonAssignment.deleteMany({
      where: { employeeId: { in: [emp.pX, emp.pY] } },
    });
    await home("pX", salonA.id, "2024-01-01", "2026-06-14");
    await home("pX", salonB.id, "2026-06-15", null);
    await home("pY", salonB.id, "2024-01-01", "2026-06-14");
    await home("pY", salonA.id, "2026-06-15", null);

    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: persons.user.id,
        accessRoleId: role.id,
        scopeType: "PERSONS",
        salonIds: [],
        employeeIds: [emp.pB],
      },
    });
    token.persReader = await login(persons.user.email);

    // Rows.
    await leave("pA", "pA", "2026-06-02", "2026-06-03");
    await leave("pAPending", "pA", "2026-06-25", "2026-06-26", { status: "PENDING" });
    await leave("pB", "pB", "2026-06-10", "2026-06-12");
    await leave("pBPending", "pB", "2026-06-20", "2026-06-21", { status: "PENDING" });
    await leave("pX1", "pX", "2026-06-10", "2026-06-20");
    await leave("pX2", "pX", "2026-06-22", "2026-06-24");
    await leave("pY1", "pY", "2026-06-10", "2026-06-20");
    // merge cases (all homed in B, masked for the Salonmanager of A)
    await leave("pM1sick", "pM1", "2026-06-01", "2026-06-03", { sick: true });
    await leave("pM1vac", "pM1", "2026-06-04", "2026-06-05");
    await leave("pM2half", "pM2", "2026-06-08", "2026-06-08", { halfDay: true });
    await leave("pM2full", "pM2", "2026-06-09", "2026-06-10");
    await leave("pM3a", "pM3", "2026-06-15", "2026-06-16");
    await leave("pM3b", "pM3", "2026-06-18", "2026-06-19");
    // WR-03: a long absence (shape of a Mutterschutz) reaching far beyond the June windows
    await leave("pLong", "pLong", "2026-05-20", "2026-07-10");
    // § 9: pS vacation with a sick spell inside it and a CONFIRMED credit
    await leave("pSvac", "pS", "2026-06-23", "2026-06-26");
    await leave("pSsick", "pS", "2026-06-24", "2026-06-25", { sick: true });
    // the employee without reach: a half-day row and a § 9 pair of its own
    await leave("noneHalf", "empNone", "2026-06-29", "2026-06-29", { halfDay: true });
    await leave("noneVac", "empNone", "2026-06-16", "2026-06-19");
    await leave("noneSick", "empNone", "2026-06-17", "2026-06-18", { sick: true });
    for (const [label, vac, sick] of [
      ["pS", "pSvac", "pSsick"],
      ["empNone", "noneVac", "noneSick"],
    ] as const) {
      await app.prisma.section9Credit.create({
        data: {
          employeeId: emp[label],
          sickRequestId: req[sick],
          vacationRequestId: req[vac],
          overlapStart: new Date(label === "pS" ? "2026-06-24T00:00:00Z" : "2026-06-17T00:00:00Z"),
          overlapEnd: new Date(label === "pS" ? "2026-06-25T00:00:00Z" : "2026-06-18T00:00:00Z"),
          status: "CONFIRMED",
          creditedStart: new Date(label === "pS" ? "2026-06-24T00:00:00Z" : "2026-06-17T00:00:00Z"),
          creditedEnd: new Date(label === "pS" ? "2026-06-25T00:00:00Z" : "2026-06-18T00:00:00Z"),
          creditedDays: 2,
          attestSource: "EAU",
          reason: "AU liegt vor",
        },
      });
    }

    apiKeyToken = (
      await createAdminApiKey(app.prisma, {
        tenantId: data.tenant.id,
        createdBy: data.adminUser.id,
      })
    ).token;
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await removeFixtureApiKeys(app.prisma, data.tenant.id);
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("leave-calendar-masking-840 matrix cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("AC-4 — the detail level follows the reach", () => {
    it("AC-4 no reach: every foreign row is exactly the seven-key masked shape", async () => {
      const body = await range(token.empNone, RANGE);
      const foreign = body.entries.filter((e) => e.isHoliday !== true && e.isOwn !== true);
      expect(foreign.length).toBeGreaterThan(0);
      for (const row of foreign) {
        expect(Object.keys(row).sort()).toEqual(MASKED_KEYS);
        expect(row.masked).toBe(true);
      }
    });

    it("AC-4 no reach: a foreign § 9 vacation row carries no section9 / section9Days / id / type", async () => {
      const body = await range(token.empNoneB, RANGE);
      const rows = rowsOf(body, "pS");
      // vacation 23rd-26th and the sick spell inside it arrive as ONE masked range
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ startDate: "2026-06-23", endDate: "2026-06-26" });
      // (the answer also holds the employee's OWN rows with their markers, so look at pS only)
      const json = JSON.stringify(rows);
      for (const key of ["pSvac", "pSsick"]) expect(json).not.toContain(req[key]);
      expect(json).not.toContain("section9");
      expect(json).not.toContain("SICK");
    });

    it("AC-4 no reach: the employee's own rows are complete (half day, § 9 markers)", async () => {
      const body = await range(token.empNone, RANGE);
      const own = rowsOf(body, "empNone");
      expect(own.map((e) => String(e.id)).sort(byId)).toEqual(
        [req.noneHalf, req.noneVac, req.noneSick].sort(byId),
      );
      for (const row of own) {
        expect(Object.keys(row)).toEqual(expect.arrayContaining(DETAIL_KEYS));
        expect(row.isOwn).toBe(true);
        expect(row.masked).toBeUndefined();
      }
      const half = own.find((e) => e.id === req.noneHalf);
      expect(half?.halfDay).toBe(true);
      const vac = own.find((e) => e.id === req.noneVac);
      const sick = own.find((e) => e.id === req.noneSick);
      expect(vac?.section9).toBe("SUPERSEDED");
      expect(sick?.section9).toBe("CONFIRMED");
      expect(sick?.section9Days).toEqual(["2026-06-17", "2026-06-18"]);
    });

    it("AC-4 whole-tenant reach: the admin and an API key see every row in detail, PENDING included", async () => {
      for (const tok of [data.adminToken, apiKeyToken]) {
        const body = await range(tok, RANGE);
        const rows = body.entries.filter((e) => e.isHoliday !== true);
        expect(rows.length).toBe(Object.keys(req).length);
        expect(rows.map((e) => String(e.id)).sort(byId)).toEqual(Object.values(req).sort(byId));
        for (const row of rows) {
          expect(Object.keys(row)).toEqual(expect.arrayContaining(DETAIL_KEYS));
          expect(row.masked).toBeUndefined();
        }
        const pending = rows.find((e) => e.id === req.pBPending);
        expect(pending?.status).toBe("PENDING");
        const sick = rows.find((e) => e.id === req.pSsick);
        expect(sick?.section9).toBe("CONFIRMED");
        expect(sick?.typeCode).toBe("SICK");
      }
    });
  });

  describe("AC-5 — a SALONS reach and a PERSONS reach decide per person and per day", () => {
    it("AC-5 SALONS: a person homed in the manager's salon is detailed, one homed in the other is masked", async () => {
      const body = await range(token.mgrA, RANGE);
      const pa = rowsOf(body, "pA");
      expect(pa.find((e) => e.id === req.pA)?.status).toBe("APPROVED");
      const pb = rowsOf(body, "pB");
      expect(pb).toHaveLength(1);
      expect(Object.keys(pb[0]).sort()).toEqual(MASKED_KEYS);
    });

    it("AC-5 SALONS: a row spanning a Stammsalon change is detailed if ANY in-window day is in reach", async () => {
      const body = await range(token.mgrA, RANGE);
      // pX is homed in A on the 10th-14th of 10th-20th.
      const pxFirst = rowsOf(body, "pX").find((e) => e.id === req.pX1);
      expect(pxFirst?.status).toBe("APPROVED");
      expect(pxFirst?.masked).toBeUndefined();
      // pY is homed in B on the 10th-14th and in A from the 15th (the later days decide).
      const pyRows = rowsOf(body, "pY");
      expect(pyRows).toHaveLength(1);
      expect(pyRows[0].id).toBe(req.pY1);
      expect(pyRows[0].masked).toBeUndefined();
    });

    it("AC-5 SALONS: a row that lies only on days homed in B is masked", async () => {
      const body = await range(token.mgrA, RANGE);
      const pxRows = rowsOf(body, "pX").filter((e) => e.startDate === "2026-06-22");
      expect(pxRows).toHaveLength(1);
      expect(Object.keys(pxRows[0]).sort()).toEqual(MASKED_KEYS);
    });

    it("AC-5 SALONS: a window that clips the row to days in B only masks it", async () => {
      const body = await range(token.mgrA, "from=2026-06-15&to=2026-06-30");
      const pxRows = rowsOf(body, "pX").filter((e) => String(e.startDate) <= "2026-06-20");
      expect(pxRows).toHaveLength(1);
      expect(Object.keys(pxRows[0]).sort()).toEqual(MASKED_KEYS);
    });

    it("AC-5 PERSONS: the reader naming pB sees pB in detail on every day and pA masked", async () => {
      const body = await range(token.persReader, RANGE);
      const pb = rowsOf(body, "pB");
      expect(pb.map((e) => String(e.id)).sort(byId)).toEqual([req.pB, req.pBPending].sort(byId));
      for (const row of pb) expect(row.masked).toBeUndefined();
      const pa = rowsOf(body, "pA");
      expect(pa).toHaveLength(1);
      expect(Object.keys(pa[0]).sort()).toEqual(MASKED_KEYS);
    });
  });

  describe("PENDING drop", () => {
    it("a foreign PENDING row outside the reach is absent", async () => {
      const body = await range(token.mgrA, RANGE);
      expect(JSON.stringify(body)).not.toContain(req.pBPending);
      expect(rowsOf(body, "pB").map((e) => e.startDate)).toEqual(["2026-06-10"]);
    });

    it("a foreign PENDING row inside the reach is present with status PENDING", async () => {
      const body = await range(token.mgrA, RANGE);
      const pending = rowsOf(body, "pA").find((e) => e.id === req.pAPending);
      expect(pending?.status).toBe("PENDING");
    });
  });

  describe("merge of masked ranges", () => {
    it("two adjacent rows of one person arrive as ONE range (Mon-Wed SICK, Thu-Fri VACATION)", async () => {
      const body = await range(token.mgrA, RANGE);
      const rows = rowsOf(body, "pM1");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        startDate: "2026-06-01",
        endDate: "2026-06-05",
        masked: true,
      });
      const json = JSON.stringify(body);
      expect(json).not.toContain(req.pM1sick);
      expect(JSON.stringify(rows)).not.toContain("SICK");
    });

    it("a half-day row next to a full-day row merges", async () => {
      const body = await range(token.mgrA, RANGE);
      const rows = rowsOf(body, "pM2");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ startDate: "2026-06-08", endDate: "2026-06-10" });
      expect(rows[0]).not.toHaveProperty("halfDay");
    });

    it("a one-day gap keeps two ranges", async () => {
      const body = await range(token.mgrA, RANGE);
      const rows = rowsOf(body, "pM3");
      expect(rows.map((e) => [e.startDate, e.endDate])).toEqual([
        ["2026-06-15", "2026-06-16"],
        ["2026-06-18", "2026-06-19"],
      ]);
    });
  });

  describe("WR-04 - a caller without a read reach is answered as scope=team", () => {
    const names = (body: RangeBody) =>
      new Set(body.entries.filter((e) => e.isHoliday !== true).map((e) => String(e.employeeId)));

    it("an own-data caller without scope sees no person homed in another salon", async () => {
      const body = await range(token.empNone, RANGE);
      const seen = names(body);
      // empNone is homed in salon A: itself and pA (A) only. pB, pM*, pS, pLong live in B.
      expect(seen.has(emp.empNone)).toBe(true);
      expect(seen.has(emp.pA)).toBe(true);
      for (const label of ["pB", "pM1", "pM2", "pM3", "pS", "pLong"]) {
        expect(seen.has(emp[label]), label).toBe(false);
      }
    });

    it("it equals the answer to an explicit scope=team, for the range and the month form", async () => {
      const implicit = await range(token.empNone, RANGE);
      const explicit = await range(token.empNone, `${RANGE}&scope=team`);
      expect(implicit).toEqual(explicit);
      const monthImplicit = await get(token.empNone, "year=2026&month=6");
      const monthExplicit = await get(token.empNone, "year=2026&month=6&scope=team");
      expect(JSON.parse(monthImplicit.body)).toEqual(JSON.parse(monthExplicit.body));
    });

    it("the colleagues it still shows are masked, the caller's own rows complete", async () => {
      const body = await range(token.empNone, RANGE);
      for (const row of rowsOf(body, "pA")) expect(Object.keys(row).sort()).toEqual(MASKED_KEYS);
      expect(rowsOf(body, "empNone").every((e) => e.masked === undefined)).toBe(true);
    });

    it("a caller with a reach keeps the tenant-wide calendar", async () => {
      const seen = names(await range(token.mgrA, RANGE));
      expect(seen.has(emp.pB)).toBe(true);
      expect(seen.has(emp.pLong)).toBe(true);
      expect(names(await range(data.adminToken, RANGE)).has(emp.pB)).toBe(true);
    });

    it("an explicit scope=own still narrows to the caller", async () => {
      const seen = names(await range(token.empNone, `${RANGE}&scope=own`));
      expect([...seen]).toEqual([emp.empNone]);
    });
  });

  describe("WR-03 - a masked range never reaches beyond the window asked for", () => {
    it("the range form clips a long foreign absence to the window", async () => {
      const body = await range(token.mgrA, RANGE);
      const rows = rowsOf(body, "pLong");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        startDate: "2026-06-01",
        endDate: "2026-06-30",
        masked: true,
      });
      expect(JSON.stringify(body)).not.toContain("2026-05-20");
      expect(JSON.stringify(body)).not.toContain("2026-07-10");
    });

    it("the year/month form clips the same way", async () => {
      const res = await get(token.mgrA, "year=2026&month=6");
      expect(res.statusCode, res.body).toBe(200);
      const rows = (JSON.parse(res.body) as Entry[]).filter((e) => e.employeeId === emp.pLong);
      expect(rows.map((e) => [e.startDate, e.endDate])).toEqual([["2026-06-01", "2026-06-30"]]);
    });

    it("a window inside the absence answers exactly the window", async () => {
      const body = await range(token.mgrA, "from=2026-06-10&to=2026-06-12");
      const rows = rowsOf(body, "pLong");
      expect(rows.map((e) => [e.startDate, e.endDate])).toEqual([["2026-06-10", "2026-06-12"]]);
    });

    it("clipping happens before the merge: two ranges stay two when the clip leaves a gap", async () => {
      const body = await range(token.mgrA, "from=2026-06-16&to=2026-06-19");
      expect(rowsOf(body, "pM3").map((e) => [e.startDate, e.endDate])).toEqual([
        ["2026-06-16", "2026-06-16"],
        ["2026-06-18", "2026-06-19"],
      ]);
    });

    it("a detailed row keeps its real range", async () => {
      const body = await range(data.adminToken, RANGE);
      const rows = rowsOf(body, "pLong");
      expect(rows.map((e) => [e.startDate, e.endDate])).toEqual([["2026-05-20", "2026-07-10"]]);
    });
  });

  describe("the from / to bounds", () => {
    it("a window of 366 days is 200, one of 367 days is 400", async () => {
      expect((await get(data.adminToken, "from=2026-01-01&to=2027-01-01")).statusCode).toBe(200);
      expect((await get(data.adminToken, "from=2026-01-01&to=2027-01-02")).statusCode).toBe(400);
    });

    it("from after to, a lone bound and a malformed date are 400", async () => {
      expect((await get(data.adminToken, "from=2026-06-10&to=2026-06-01")).statusCode).toBe(400);
      expect((await get(data.adminToken, "from=2026-06-10")).statusCode).toBe(400);
      expect((await get(data.adminToken, "to=2026-06-10")).statusCode).toBe(400);
      expect((await get(data.adminToken, "from=2026-6-1&to=2026-06-10")).statusCode).toBe(400);
      expect((await get(data.adminToken, "from=2026-02-30&to=2026-03-02")).statusCode).toBe(400);
    });

    it("a malformed or out-of-range year / month is 400, not 500 (IN-07)", async () => {
      for (const qs of [
        "year=abc&month=6",
        "year=2026&month=abc",
        "year=2026&month=13",
        "year=2026&month=0",
        "year=1&month=6",
        "year=2026.5&month=6",
        "year=&month=6",
      ]) {
        const res = await get(data.adminToken, qs);
        expect(res.statusCode, `${qs}: ${res.body}`).toBe(400);
      }
      expect((await get(data.adminToken, "year=2026&month=12")).statusCode).toBe(200);
      expect((await get(data.adminToken, "year=2026")).statusCode).toBe(200);
    });

    it("without from / to the year / month form answers the bare array", async () => {
      const res = await get(data.adminToken, "year=2026&month=6");
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as Entry[];
      expect(Array.isArray(body)).toBe(true);
      expect(body.filter((e) => e.isHoliday !== true).length).toBeGreaterThan(0);
    });
  });
});
