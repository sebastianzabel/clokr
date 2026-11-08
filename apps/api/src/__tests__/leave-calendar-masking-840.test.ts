/**
 * Issue #840 (AC-4, AC-5, D-840-19/18/25) — `GET /leave/calendar` decides the detail level PER
 * PERSON by the reader's `leave-request:read:ZUGEWIESEN` reach (Stammsalon per day), and the range
 * form (`?from&to`) answers `{ entries, salons }`. Tracer cases; plan 840-03 completes the matrix.
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
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";

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
