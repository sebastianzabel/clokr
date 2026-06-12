// Phase 79 Plan 02 — GET /api/v1/work-events/mine + GET /api/v1/work-events tests.
//
// Plan reference: .planning/phases/79-workevent-api-endpoints-split-mine-vs-management/79-02-PLAN.md
//
// The headline acceptance test for this plan is the v1.8.12 cross-employee leak
// class REGRESSION (Test M2). Self-view derives strictly from req.user.employeeId;
// the management surface is structurally separate (different URL path, different
// preHandler). This makes the role-branched scoping pattern that caused the v1.8.12
// leak impossible by construction.
//
// REVISION (W1): Tests M9 + T9 cover the default 90-day window when no ?from/?to
// is supplied — past / in-window / beyond-window rows seeded; only the in-window
// row is returned.
//
// REVISION (W2): Tests M10 + T10 cover the half-window-400 regression. Passing
// exactly one of ?from or ?to returns HTTP 400 with the German message
// "from und to müssen zusammen angegeben werden".

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { WorkEventType } from "@clokr/db";

const HALF_WINDOW_ERROR_DE = "from und to müssen zusammen angegeben werden";

// Format a Date as YYYY-MM-DD using UTC components — Date columns are date-only,
// timezone-naive at the DB layer.
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcMidnightToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function offsetDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

describe("GET /api/v1/work-events/mine (Plan 79-02 Task 1)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Second employee in the SAME tenant — used to verify /mine never leaks
  // rows that belong to a different employee. This is the v1.8.12 LEAK CLASS
  // regression scaffolding (Test M2).
  let otherEmployeeId: string;
  let otherUserId: string;

  // Third employee whose rows should never appear in any self-view either —
  // additional witness in Test M2.
  let thirdEmployeeId: string;
  let thirdUserId: string;

  // ADMIN-without-Employee user — used in Test M5 to verify the empty-array path
  // when req.user.employeeId is undefined.
  let lonelyAdminToken: string;
  let lonelyAdminUserId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "we-get");

    // Second employee in the same tenant.
    const otherUser = await app.prisma.user.create({
      data: {
        email: `other-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    otherUserId = otherUser.id;
    const otherEmp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: otherUser.id,
        employeeNumber: `OTHER-${Date.now()}`,
        firstName: "Other",
        lastName: "Person",
        hireDate: new Date("2024-01-01"),
      },
    });
    otherEmployeeId = otherEmp.id;

    // Third employee in the same tenant.
    const thirdUser = await app.prisma.user.create({
      data: {
        email: `third-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    thirdUserId = thirdUser.id;
    const thirdEmp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: thirdUser.id,
        employeeNumber: `THIRD-${Date.now()}`,
        firstName: "Third",
        lastName: "Person",
        hireDate: new Date("2024-01-01"),
      },
    });
    thirdEmployeeId = thirdEmp.id;

    // ADMIN user with NO Employee row. Verifies Test M5: req.user.employeeId
    // undefined ⇒ /mine returns 200 + [].
    const lonelyEmail = `lonely-admin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.de`;
    const lonelyUser = await app.prisma.user.create({
      data: {
        email: lonelyEmail,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    lonelyAdminUserId = lonelyUser.id;
    const lonelyLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: lonelyEmail, password: "test1234" },
    });
    lonelyAdminToken = JSON.parse(lonelyLogin.body).accessToken;
  });

  afterAll(async () => {
    try {
      // Drop ALL WorkEvent rows for the three employees we seeded — Restrict
      // cascade would otherwise block employee.deleteMany in cleanupTestData.
      await app.prisma.workEvent.deleteMany({
        where: {
          employeeId: {
            in: [data.adminEmployee.id, data.employee.id, otherEmployeeId, thirdEmployeeId],
          },
        },
      });
      // Drop the extra employee rows we created outside of seedTestData.
      await app.prisma.employee.deleteMany({
        where: { id: { in: [otherEmployeeId, thirdEmployeeId] } },
      });
      await app.prisma.user.deleteMany({
        where: { id: { in: [otherUserId, thirdUserId, lonelyAdminUserId] } },
      });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("work-events-get test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    // Clean slate for each test — only touch the four employees we own.
    await app.prisma.workEvent.deleteMany({
      where: {
        employeeId: {
          in: [data.adminEmployee.id, data.employee.id, otherEmployeeId, thirdEmployeeId],
        },
      },
    });
  });

  // ── Test M1: EMPLOYEE self-view returns ONLY their rows ──────────────────────
  it("M1: EMPLOYEE with own rows → /mine returns 200 with only their rows", async () => {
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 7));

    await app.prisma.workEvent.create({
      data: {
        employeeId: data.employee.id,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: new Date(date + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events/mine",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].employeeId).toBe(data.employee.id);
  });

  // ── Test M2: v1.8.12 LEAK CLASS REGRESSION ──────────────────────────────────
  // REGRESSION: v1.8.12 cross-employee leak class — admin self-view must never
  // leak other employees' rows. This test seeds the ADMIN's own employee plus 2
  // otherEmployee rows; /mine must return ONLY the admin's row.
  it("M2: ADMIN with own Employee row → /mine returns ONLY admin's rows (REGRESSION v1.8.12 leak class)", async () => {
    const today = utcMidnightToday();
    const inWindow = fmtDate(offsetDays(today, 14));

    // Admin's own row.
    await app.prisma.workEvent.create({
      data: {
        employeeId: data.adminEmployee.id,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: new Date(inWindow + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });
    // Other employees' rows — these MUST NOT leak into the admin's /mine view.
    await app.prisma.workEvent.create({
      data: {
        employeeId: otherEmployeeId,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: new Date(inWindow + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });
    await app.prisma.workEvent.create({
      data: {
        employeeId: thirdEmployeeId,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: new Date(inWindow + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events/mine",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
    // Structural assertion: NO row may belong to anyone other than the caller.
    expect(body.every((r: { employeeId: string }) => r.employeeId === data.adminEmployee.id)).toBe(
      true,
    );
    // Witness assertion: rows from otherEmployeeId / thirdEmployeeId are NOT present.
    expect(body.some((r: { employeeId: string }) => r.employeeId === otherEmployeeId)).toBe(false);
    expect(body.some((r: { employeeId: string }) => r.employeeId === thirdEmployeeId)).toBe(false);
  });

  // ── Test M3: MANAGER self-view ───────────────────────────────────────────────
  it("M3: MANAGER → /mine returns ONLY manager's own rows", async () => {
    // Seed a MANAGER user with an employee row in the same tenant.
    const mgrEmail = `mgr-mine-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.de`;
    const mgrUser = await app.prisma.user.create({
      data: {
        email: mgrEmail,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "MANAGER",
        isActive: true,
      },
    });
    const mgrEmp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: mgrUser.id,
        employeeNumber: `MGR-${Date.now()}`,
        firstName: "Mgr",
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    const mgrLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: mgrEmail, password: "test1234" },
    });
    const mgrToken = JSON.parse(mgrLogin.body).accessToken;

    const today = utcMidnightToday();
    const inWindow = fmtDate(offsetDays(today, 21));
    await app.prisma.workEvent.create({
      data: {
        employeeId: mgrEmp.id,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: new Date(inWindow + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });
    await app.prisma.workEvent.create({
      data: {
        employeeId: data.employee.id,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: new Date(inWindow + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events/mine",
      headers: { authorization: `Bearer ${mgrToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
    expect(body[0].employeeId).toBe(mgrEmp.id);

    // Cleanup the manager fixture.
    await app.prisma.workEvent.deleteMany({ where: { employeeId: mgrEmp.id } });
    await app.prisma.employee.delete({ where: { id: mgrEmp.id } });
    await app.prisma.refreshToken.deleteMany({ where: { userId: mgrUser.id } });
    await app.prisma.user.delete({ where: { id: mgrUser.id } });
  });

  // ── Test M4: ?employeeId= query param is IGNORED on /mine ────────────────────
  it("M4: /mine with ?employeeId=<other> ignores the param — still self-scoped", async () => {
    const today = utcMidnightToday();
    const inWindow = fmtDate(offsetDays(today, 10));

    await app.prisma.workEvent.create({
      data: {
        employeeId: data.employee.id,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: new Date(inWindow + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });
    await app.prisma.workEvent.create({
      data: {
        employeeId: otherEmployeeId,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: new Date(inWindow + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/work-events/mine?employeeId=${otherEmployeeId}`,
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Self-scope wins — the query param is IGNORED.
    expect(body.every((r: { employeeId: string }) => r.employeeId === data.employee.id)).toBe(true);
    expect(body.some((r: { employeeId: string }) => r.employeeId === otherEmployeeId)).toBe(false);
  });

  // ── Test M5: User without linked Employee row → 200 + [] ────────────────────
  it("M5: ADMIN without Employee row → /mine returns 200 + []", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events/mine",
      headers: { authorization: `Bearer ${lonelyAdminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  // ── Test M6: Date-range filter ───────────────────────────────────────────────
  it("M6: /mine with ?from=2099-06-01&to=2099-06-30 filters to the window", async () => {
    await app.prisma.workEvent.create({
      data: {
        employeeId: data.employee.id,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: new Date("2099-05-15T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });
    await app.prisma.workEvent.create({
      data: {
        employeeId: data.employee.id,
        type: WorkEventType.FIELD_SERVICE,
        source: "MANUAL",
        date: new Date("2099-06-15T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });
    await app.prisma.workEvent.create({
      data: {
        employeeId: data.employee.id,
        type: WorkEventType.TRAINING,
        source: "MANUAL",
        date: new Date("2099-07-15T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events/mine?from=2099-06-01&to=2099-06-30",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
    expect(body[0].date).toBe("2099-06-15");
  });

  // ── Test M7: Soft-deleted rows excluded ──────────────────────────────────────
  it("M7: Soft-deleted rows (deletedAt set) are excluded", async () => {
    const today = utcMidnightToday();
    const inWindow = fmtDate(offsetDays(today, 5));

    await app.prisma.workEvent.create({
      data: {
        employeeId: data.employee.id,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: new Date(inWindow + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });
    await app.prisma.workEvent.create({
      data: {
        employeeId: data.employee.id,
        type: WorkEventType.FIELD_SERVICE,
        source: "MANUAL",
        date: new Date(inWindow + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
        deletedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events/mine",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
    expect(body[0].type).toBe(WorkEventType.VOCATIONAL_SCHOOL);
  });

  // ── Test M8: Unauthenticated → 401 (locks the contract) ─────────────────────
  it("M8: unauthenticated /mine request returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events/mine",
    });
    expect(res.statusCode).toBe(401);
  });

  // ── Test M9 (REVISION W1): Default 90-day window regression ─────────────────
  // Seeds past / in-window / beyond-window rows for the caller. Asserts exactly
  // the in-window row (today+30d) is returned when no ?from/?to is supplied,
  // proving the default-window is [today, today+90].
  it("M9: /mine with NO ?from/?to returns only today..today+90 rows (default-window regression)", async () => {
    const today = utcMidnightToday();
    const past = fmtDate(offsetDays(today, -30));
    const inWindow = fmtDate(offsetDays(today, 30));
    const beyond = fmtDate(offsetDays(today, 120));

    await app.prisma.workEvent.create({
      data: {
        employeeId: data.employee.id,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: new Date(past + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });
    await app.prisma.workEvent.create({
      data: {
        employeeId: data.employee.id,
        type: WorkEventType.FIELD_SERVICE,
        source: "MANUAL",
        date: new Date(inWindow + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });
    await app.prisma.workEvent.create({
      data: {
        employeeId: data.employee.id,
        type: WorkEventType.TRAINING,
        source: "MANUAL",
        date: new Date(beyond + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events/mine",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
    expect(body[0].date).toBe(inWindow);
  });

  // ── Test M10 (REVISION W2): Half-window 400 + German message ───────────────
  it("M10a: /mine with ?from only (no ?to) → 400 + German message", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events/mine?from=2099-06-01",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe(HALF_WINDOW_ERROR_DE);
  });

  it("M10b: /mine with ?to only (no ?from) → 400 + German message", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events/mine?to=2099-06-30",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe(HALF_WINDOW_ERROR_DE);
  });
});

describe("GET /api/v1/work-events (Plan 79-02 Task 2)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let dataTenantB: Awaited<ReturnType<typeof seedTestData>>;

  let managerToken: string;
  let managerEmployeeId: string;
  let managerUserId: string;

  // Additional employees in tenant A used by the multi-row tests.
  let e1Id: string;
  let e1UserId: string;
  let e2Id: string;
  let e2UserId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "we-get-tenant-a");
    dataTenantB = await seedTestData(app, "we-get-tenant-b");

    // MANAGER user in tenant A.
    const mgrEmail = `mgr-mgmt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.de`;
    const mgrUser = await app.prisma.user.create({
      data: {
        email: mgrEmail,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "MANAGER",
        isActive: true,
      },
    });
    managerUserId = mgrUser.id;
    const mgrEmp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: mgrUser.id,
        employeeNumber: `MGR-MGMT-${Date.now()}`,
        firstName: "Mgr",
        lastName: "Mgmt",
        hireDate: new Date("2024-01-01"),
      },
    });
    managerEmployeeId = mgrEmp.id;
    const mgrLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: mgrEmail, password: "test1234" },
    });
    managerToken = JSON.parse(mgrLogin.body).accessToken;

    // Two extra employees in tenant A.
    const e1User = await app.prisma.user.create({
      data: {
        email: `e1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    e1UserId = e1User.id;
    const e1Emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: e1User.id,
        employeeNumber: `E1-${Date.now()}`,
        firstName: "Eins",
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    e1Id = e1Emp.id;

    const e2User = await app.prisma.user.create({
      data: {
        email: `e2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    e2UserId = e2User.id;
    const e2Emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: e2User.id,
        employeeNumber: `E2-${Date.now()}`,
        firstName: "Zwei",
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    e2Id = e2Emp.id;
  });

  afterAll(async () => {
    try {
      const allEmpIds = [
        data.adminEmployee.id,
        data.employee.id,
        managerEmployeeId,
        e1Id,
        e2Id,
        dataTenantB.adminEmployee.id,
        dataTenantB.employee.id,
      ];
      await app.prisma.workEvent.deleteMany({
        where: { employeeId: { in: allEmpIds } },
      });
      await app.prisma.employee.deleteMany({
        where: { id: { in: [managerEmployeeId, e1Id, e2Id] } },
      });
      await app.prisma.refreshToken.deleteMany({
        where: { userId: { in: [managerUserId, e1UserId, e2UserId] } },
      });
      await app.prisma.user.deleteMany({
        where: { id: { in: [managerUserId, e1UserId, e2UserId] } },
      });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, dataTenantB.tenant.id);
    } catch (err) {
      console.error("work-events-get (management) test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    const allEmpIds = [
      data.adminEmployee.id,
      data.employee.id,
      managerEmployeeId,
      e1Id,
      e2Id,
      dataTenantB.adminEmployee.id,
      dataTenantB.employee.id,
    ];
    await app.prisma.workEvent.deleteMany({
      where: { employeeId: { in: allEmpIds } },
    });
  });

  // ── Test T1: ADMIN tenant-wide list ─────────────────────────────────────────
  it("T1: ADMIN → /work-events returns all rows in the caller's tenant", async () => {
    const today = utcMidnightToday();
    const d = fmtDate(offsetDays(today, 14));

    await app.prisma.workEvent.createMany({
      data: [
        {
          employeeId: e1Id,
          type: WorkEventType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date(d + "T00:00:00.000Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: e2Id,
          type: WorkEventType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date(d + "T00:00:00.000Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: data.employee.id,
          type: WorkEventType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date(d + "T00:00:00.000Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(3);
  });

  // ── Test T2: MANAGER tenant-wide list ───────────────────────────────────────
  it("T2: MANAGER → /work-events returns all rows in the caller's tenant", async () => {
    const today = utcMidnightToday();
    const d = fmtDate(offsetDays(today, 14));
    await app.prisma.workEvent.createMany({
      data: [
        {
          employeeId: e1Id,
          type: WorkEventType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date(d + "T00:00:00.000Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: e2Id,
          type: WorkEventType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date(d + "T00:00:00.000Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: data.employee.id,
          type: WorkEventType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date(d + "T00:00:00.000Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(3);
  });

  // ── Test T3: EMPLOYEE → 403 (THE STRUCTURAL SEPARATION TEST) ───────────────
  it("T3: EMPLOYEE → /work-events returns 403 Forbidden (reply.statusCode === 403)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Forbidden");
  });

  // ── Test T4: ?employeeId= filter ────────────────────────────────────────────
  it("T4: ADMIN with ?employeeId=e1 → returns only e1's rows", async () => {
    const today = utcMidnightToday();
    const d = fmtDate(offsetDays(today, 14));
    await app.prisma.workEvent.createMany({
      data: [
        {
          employeeId: e1Id,
          type: WorkEventType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date(d + "T00:00:00.000Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: e2Id,
          type: WorkEventType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date(d + "T00:00:00.000Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/work-events?employeeId=${e1Id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
    expect(body[0].employeeId).toBe(e1Id);
  });

  // ── Test T5: Cross-tenant isolation — tenant A admin cannot see tenant B ───
  it("T5: ADMIN of tenant A → /work-events does NOT return tenant B rows (cross-tenant isolation)", async () => {
    const today = utcMidnightToday();
    const d = fmtDate(offsetDays(today, 14));

    await app.prisma.workEvent.create({
      data: {
        employeeId: e1Id,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: new Date(d + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });
    await app.prisma.workEvent.create({
      data: {
        employeeId: dataTenantB.employee.id,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: new Date(d + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(
      body.every((r: { employeeId: string }) => r.employeeId !== dataTenantB.employee.id),
    ).toBe(true);
    expect(body.some((r: { employeeId: string }) => r.employeeId === e1Id)).toBe(true);
  });

  // ── Test T6: Date-range filter (mirror of M6) ───────────────────────────────
  it("T6: ADMIN with ?from=2099-06-01&to=2099-06-30 filters to the window", async () => {
    await app.prisma.workEvent.createMany({
      data: [
        {
          employeeId: e1Id,
          type: WorkEventType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2099-05-15T00:00:00.000Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: e1Id,
          type: WorkEventType.FIELD_SERVICE,
          source: "MANUAL",
          date: new Date("2099-06-15T00:00:00.000Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: e1Id,
          type: WorkEventType.TRAINING,
          source: "MANUAL",
          date: new Date("2099-07-15T00:00:00.000Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events?from=2099-06-01&to=2099-06-30",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
    expect(body[0].date).toBe("2099-06-15");
  });

  // ── Test T7: Soft-deleted excluded (mirror of M7) ───────────────────────────
  it("T7: ADMIN — soft-deleted rows are excluded", async () => {
    const today = utcMidnightToday();
    const d = fmtDate(offsetDays(today, 14));

    await app.prisma.workEvent.create({
      data: {
        employeeId: e1Id,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: new Date(d + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });
    await app.prisma.workEvent.create({
      data: {
        employeeId: e1Id,
        type: WorkEventType.FIELD_SERVICE,
        source: "MANUAL",
        date: new Date(d + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
        deletedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
    expect(body[0].type).toBe(WorkEventType.VOCATIONAL_SCHOOL);
  });

  // ── Test T8: Response includes employee sub-object ──────────────────────────
  it("T8: management response includes employee {firstName, lastName, employeeNumber} sub-object", async () => {
    const today = utcMidnightToday();
    const d = fmtDate(offsetDays(today, 14));
    await app.prisma.workEvent.create({
      data: {
        employeeId: e1Id,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: new Date(d + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
    expect(body[0].employee).toBeTruthy();
    expect(typeof body[0].employee.firstName).toBe("string");
    expect(typeof body[0].employee.lastName).toBe("string");
    expect(typeof body[0].employee.employeeNumber).toBe("string");
  });

  // ── Test T9 (REVISION W1): Default 90-day window regression ─────────────────
  it("T9: ADMIN with NO ?from/?to returns only today..today+90 rows (default-window regression)", async () => {
    const today = utcMidnightToday();
    const past = fmtDate(offsetDays(today, -30));
    const inWindow = fmtDate(offsetDays(today, 30));
    const beyond = fmtDate(offsetDays(today, 120));

    await app.prisma.workEvent.createMany({
      data: [
        {
          employeeId: e1Id,
          type: WorkEventType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date(past + "T00:00:00.000Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: e1Id,
          type: WorkEventType.FIELD_SERVICE,
          source: "MANUAL",
          date: new Date(inWindow + "T00:00:00.000Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: e1Id,
          type: WorkEventType.TRAINING,
          source: "MANUAL",
          date: new Date(beyond + "T00:00:00.000Z"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
    expect(body[0].date).toBe(inWindow);
  });

  // ── Test T10 (REVISION W2): Half-window 400 + German message ───────────────
  it("T10a: ADMIN — /work-events with ?from only → 400 + German message", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events?from=2099-06-01",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe(HALF_WINDOW_ERROR_DE);
  });

  it("T10b: ADMIN — /work-events with ?to only → 400 + German message", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events?to=2099-06-30",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe(HALF_WINDOW_ERROR_DE);
  });
});
