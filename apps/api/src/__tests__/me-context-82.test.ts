/**
 * Issue #82 (D-01, D-02, D-03) — `GET /api/v1/me/context` tells the logged-in caller its tenant and
 * the ACTIVE salons it can reach: its managed reach (role assignments, legacy-role fallback) united
 * with its own current and future salon assignments. The body carries ids and names only (Art. 5
 * Abs. 1 lit. c DSGVO); `isMultiSalon` is the #64 definition (more than one active salon).
 *
 * The context is presentation only — every endpoint keeps deciding access itself (D-05); the proof
 * that a manipulated context yields no foreign data is `salon-context-manipulation-82.test.ts`.
 *
 * Harness copied from `time-entries-activity-summary-81.test.ts`: fake clock 2026-06-15T10:00Z
 * installed BEFORE the app boots. No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import crypto, { createHash, randomBytes, randomUUID } from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import type { JwtPayload } from "../middleware/auth";
import { SYSTEM_ROLE_IDS, normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "test1234";
const BODY_KEYS = ["homeSalonId", "isMultiSalon", "salons", "tenant"];

type ContextBody = {
  tenant: { id: string; name: string };
  isMultiSalon: boolean;
  homeSalonId: string | null;
  salons: { id: string; name: string }[];
};

describe("Issue #82 — GET /api/v1/me/context", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let single: Awaited<ReturnType<typeof seedTestData>>;
  let ordering: Awaited<ReturnType<typeof seedTestData>> | null = null;
  let salonA: { id: string; name: string };
  let salonB: { id: string; name: string };
  let salonC: { id: string; name: string };
  let salonI: { id: string; name: string };
  let salonD: { id: string; name: string };
  let foreignSalon: { id: string };

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(
    label: string,
    role: "ADMIN" | "MANAGER" | "EMPLOYEE" = "EMPLOYEE",
    tenantId = data.tenant.id,
  ) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role, isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "Ctx82",
        hireDate: new Date("2024-01-01"),
      },
    });
    return { user, employee };
  }

  function assign(
    userId: string,
    accessRoleId: string,
    scope: {
      scopeType: "TENANT" | "SALONS" | "PERSONS";
      salonIds?: string[];
      employeeIds?: string[];
    },
  ) {
    return app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId,
        accessRoleId,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: scope.employeeIds ?? [],
      },
    });
  }

  function salonAssignment(
    employeeId: string,
    salonId: string,
    kind: "HOME" | "DEPLOYMENT",
    validFrom: string,
    validUntil: string | null = null,
  ) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind,
        validFrom: new Date(`${validFrom}T00:00:00Z`),
        validUntil: validUntil === null ? null : new Date(`${validUntil}T00:00:00Z`),
      },
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

  function context(authorization?: string) {
    return app.inject({
      method: "GET",
      url: "/api/v1/me/context",
      headers: authorization ? { authorization } : {},
    });
  }

  async function contextBody(token: string): Promise<ContextBody> {
    const res = await context(`Bearer ${token}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as ContextBody;
    // D-02: data minimisation — exactly these keys, nothing else.
    expect(Object.keys(body).sort()).toEqual(BODY_KEYS);
    expect(Object.keys(body.tenant).sort()).toEqual(["id", "name"]);
    for (const salon of body.salons) expect(Object.keys(salon).sort()).toEqual(["id", "name"]);
    return body;
  }

  const ids = (body: ContextBody) => body.salons.map((s) => s.id).sort();
  const byName = (list: { id: string; name: string }[]) =>
    [...list]
      .sort((a, b) => a.name.localeCompare(b.name, "de") || (a.id < b.id ? -1 : 1))
      .map((s) => ({ id: s.id, name: s.name }));

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "ctx82");
    foreign = await seedTestData(app, "ctx82f");
    single = await seedTestData(app, "ctx82s");
    salonD = { id: data.salonId, name: data.tenant.name };
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Nord" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Ost" });
    salonC = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Süd" });
    salonI = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Salon Alt",
      isActive: false,
    });
    foreignSalon = { id: foreign.salonId };
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      // RoleAssignment.accessRole is Restrict: assignments go first, main tenant before foreign.
      for (const t of [data, single, ordering, foreign]) {
        if (!t) continue;
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId: t.tenant.id } });
        await app.prisma.apiKey.deleteMany({ where: { tenantId: t.tenant.id } });
        await app.prisma.accessRole.deleteMany({ where: { tenantId: t.tenant.id } });
      }
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, single.tenant.id);
      if (ordering) await cleanupTestData(app, ordering.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("me-context-82 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("tracer: a SALONS-scoped Salonmanager with HOME A gets exactly its tenant and salon A", async () => {
    const { user, employee } = await createEmployee("tracer");
    await salonAssignment(employee.id, salonA.id, "HOME", "2024-01-01");
    await assign(user.id, SYSTEM_ROLE_IDS.SALON_MANAGER, {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });

    const body = await contextBody(await login(user.email));
    expect(body).toEqual({
      tenant: { id: data.tenant.id, name: data.tenant.name },
      isMultiSalon: true,
      homeSalonId: salonA.id,
      salons: [{ id: salonA.id, name: "Salon Nord" }],
    });
  });

  it("legacy-role fallback admin (no stored assignment) reaches every active salon, never the inactive one", async () => {
    const body = await contextBody(data.adminToken);
    expect(body.salons).toEqual(byName([salonA, salonB, salonC, salonD]));
    expect(ids(body)).not.toContain(salonI.id);
    expect(body.homeSalonId).toBeNull();
    expect(body.isMultiSalon).toBe(true);
  });

  it("a stored TENANT assignment on a system template reaches every active salon", async () => {
    const { user } = await createEmployee("tenantHr");
    await assign(user.id, SYSTEM_ROLE_IDS.HR, { scopeType: "TENANT" });
    const body = await contextBody(await login(user.email));
    expect(ids(body)).toEqual([salonA.id, salonB.id, salonC.id, salonD.id].sort());
  });

  it("a PERSONS-only assignment reaches no salon", async () => {
    const { employee: target } = await createEmployee("personsTarget");
    const { user } = await createEmployee("personsTrainer");
    await assign(user.id, SYSTEM_ROLE_IDS.TRAINER, {
      scopeType: "PERSONS",
      employeeIds: [target.id],
    });
    const body = await contextBody(await login(user.email));
    expect(body.salons).toEqual([]);
    expect(body.homeSalonId).toBeNull();
    expect(body.isMultiSalon).toBe(true);
  });

  it("an employee reaches the salons of its current and future assignments only", async () => {
    const { user, employee } = await createEmployee("ownReach");
    await salonAssignment(employee.id, salonA.id, "HOME", "2024-01-01");
    await salonAssignment(employee.id, salonB.id, "DEPLOYMENT", "2026-01-01", "2026-12-31");
    await salonAssignment(employee.id, salonD.id, "DEPLOYMENT", "2026-09-01");
    // Ended before today, voided (end before start), and on an inactive salon: never reachable.
    await salonAssignment(employee.id, salonC.id, "DEPLOYMENT", "2026-01-01", "2026-05-31");
    await salonAssignment(employee.id, salonC.id, "DEPLOYMENT", "2026-07-01", "2026-06-30");
    await salonAssignment(employee.id, salonI.id, "DEPLOYMENT", "2026-01-01");

    const body = await contextBody(await login(user.email));
    expect(ids(body)).toEqual([salonA.id, salonB.id, salonD.id].sort());
    expect(body.homeSalonId).toBe(salonA.id);
  });

  it("an employee whose only assignment is HOME on an inactive salon reaches nothing", async () => {
    const { user, employee } = await createEmployee("inactiveHome");
    await salonAssignment(employee.id, salonI.id, "HOME", "2024-01-01");
    const body = await contextBody(await login(user.email));
    expect(body.salons).toEqual([]);
    expect(body.homeSalonId).toBeNull();
  });

  it("a foreign tenant's salon id inside a stored SALONS list never appears", async () => {
    const { user } = await createEmployee("foreignInList");
    await assign(user.id, SYSTEM_ROLE_IDS.SALON_MANAGER, {
      scopeType: "SALONS",
      salonIds: [salonA.id, foreignSalon.id],
    });
    const body = await contextBody(await login(user.email));
    expect(ids(body)).toEqual([salonA.id]);
  });

  it("a custom role holding only EIGENE keys at TENANT scope reaches only own salons", async () => {
    const { user, employee } = await createEmployee("eigeneOnly", "ADMIN");
    await salonAssignment(employee.id, salonB.id, "HOME", "2024-01-01");
    const name = `Ctx82 ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(["time-entry:read:EIGENE"]),
      },
    });
    // One stored row disables the legacy fallback, even for User.role ADMIN.
    await assign(user.id, role.id, { scopeType: "TENANT" });
    const body = await contextBody(await login(user.email));
    expect(ids(body)).toEqual([salonB.id]);
    expect(body.homeSalonId).toBe(salonB.id);
  });

  it("a valid JWT for a nonexistent user answers 404 Benutzer nicht gefunden", async () => {
    const payload: JwtPayload = {
      sub: randomUUID(),
      role: "EMPLOYEE",
      tenantId: data.tenant.id,
      employeeId: undefined,
    };
    const res = await context(`Bearer ${app.jwt.sign(payload)}`);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Benutzer nicht gefunden" });
  });

  it("a valid JWT of an existing user with an unknown tenant answers 404 Mandant nicht gefunden", async () => {
    const payload: JwtPayload = {
      sub: data.empUser.id,
      role: "EMPLOYEE",
      tenantId: randomUUID(),
      employeeId: undefined,
    };
    const res = await context(`Bearer ${app.jwt.sign(payload)}`);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Mandant nicht gefunden" });
  });

  it("an API key answers 400 and no token answers 401", async () => {
    const raw = `clk_${randomBytes(24).toString("hex")}`;
    await app.prisma.apiKey.create({
      data: {
        tenantId: data.tenant.id,
        name: uniqueSuffix("ctx82key"),
        keyHash: createHash("sha256").update(raw).digest("hex"),
        keyPrefix: raw.slice(0, 8),
        scopes: ["admin"],
        createdBy: data.adminUser.id,
      },
    });
    const res = await context(`Bearer ${raw}`);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "API-Keys haben keinen Benutzerkontext" });

    const anonymous = await context();
    expect(anonymous.statusCode).toBe(401);
  });

  it("a single-salon tenant is not multisalon and lists its one salon", async () => {
    const body = await contextBody(single.adminToken);
    expect(body).toEqual({
      tenant: { id: single.tenant.id, name: single.tenant.name },
      isMultiSalon: false,
      homeSalonId: null,
      salons: [{ id: single.salonId, name: single.tenant.name }],
    });
  });

  it("orders salons by German name collation, then by id", async () => {
    ordering = await seedTestData(app, "ctx82o");
    const t = ordering.tenant.id;
    const zeta = await createTestSalon(app.prisma, t, { name: "Zeta Salon" });
    const umlaut = await createTestSalon(app.prisma, t, { name: "Ärzte Salon" });
    const twinOne = await createTestSalon(app.prisma, t, { name: "Mitte Salon" });
    const twinTwo = await createTestSalon(app.prisma, t, { name: "Mitte Salon" });
    const [firstTwin, secondTwin] = [twinOne, twinTwo].sort((a, b) => (a.id < b.id ? -1 : 1));

    const body = await contextBody(ordering.adminToken);
    const expectedNames = [
      "Ärzte Salon",
      "Mitte Salon",
      "Mitte Salon",
      ordering.tenant.name,
      "Zeta Salon",
    ]
      .slice()
      .sort((a, b) => a.localeCompare(b, "de"));
    expect(body.salons.map((s) => s.name)).toEqual(expectedNames);
    // "Ärzte" sorts with A, never after Z (a byte comparison would put it last).
    expect(body.salons[0].id).toBe(umlaut.id);
    expect(body.salons[body.salons.length - 1].id).toBe(zeta.id);
    const twins = body.salons.filter((s) => s.name === "Mitte Salon").map((s) => s.id);
    expect(twins).toEqual([firstTwin.id, secondTwin.id]);
  });
});
