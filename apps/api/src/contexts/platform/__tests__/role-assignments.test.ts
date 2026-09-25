/**
 * Phase 74b Plan 02 (Issue #74) — integration tests for the role-assignment maintenance API,
 * `/api/v1/role-assignments`. Task 1 covers `GET /` and `POST /` (AK-74-1..AK-74-5); Task 2 adds
 * `GET/PATCH/DELETE /:id`.
 *
 * No person names in fixtures (CLAUDE.md PII rule) — every grantee is named after the scenario it
 * exercises.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { roleNameKey, normalizeRolePermissions } from "../access-role";
import { DEFAULT_SALON_OPENING_HOURS } from "../facade/salons";
import { SYSTEM_ROLE_IDS } from "../system-roles";
import type { FastifyInstance } from "fastify";
import type { RoleAssignment } from "@clokr/db";

/** Role-descriptive fixture user + employee — no person names (CLAUDE.md PII rule). */
async function createUserWithEmployee(app: FastifyInstance, tenantId: string, label: string) {
  const s = label + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const passwordHash = await bcrypt.hash("test1234", 10);
  const user = await app.prisma.user.create({
    data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `RA-${s}`.slice(0, 20),
      firstName: label,
      lastName: "Test",
      hireDate: new Date("2024-01-01"),
    },
  });
  return { user, employee };
}

async function createBareUser(app: FastifyInstance) {
  const s = "Bare-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const passwordHash = await bcrypt.hash("test1234", 10);
  return app.prisma.user.create({
    data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
  });
}

/** DSGVO-anonymized shape (CLAUDE.md): firstName "Gelöscht", lastName "GELÖSCHT-…", user inactive. */
async function createAnonymizedEmployee(app: FastifyInstance, tenantId: string) {
  const s = "Anon-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const passwordHash = await bcrypt.hash("test1234", 10);
  const user = await app.prisma.user.create({
    data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: false },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `AN-${s}`.slice(0, 20),
      firstName: "Gelöscht",
      lastName: `GELÖSCHT-${s}`,
      hireDate: new Date("2024-01-01"),
    },
  });
  return { user, employee };
}

async function createCustomerRole(app: FastifyInstance, tenantId: string, label: string) {
  const s = label + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return app.prisma.accessRole.create({
    data: {
      tenantId,
      name: s,
      nameKey: roleNameKey(s),
      permissions: normalizeRolePermissions(["time-entry:read:ZUGEWIESEN"]),
    },
  });
}

async function createSystemRole(app: FastifyInstance) {
  const s = "System-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return app.prisma.accessRole.create({
    data: {
      tenantId: null,
      name: s,
      nameKey: roleNameKey(s),
      permissions: normalizeRolePermissions(["role:read:ZUGEWIESEN"]),
    },
  });
}

async function createSalon(
  app: FastifyInstance,
  tenantId: string,
  name: string,
  isActive: boolean,
) {
  return app.prisma.salon.create({
    data: {
      tenantId,
      name,
      federalState: "NIEDERSACHSEN",
      openingHours: DEFAULT_SALON_OPENING_HOURS,
      isActive,
      ...(isActive ? {} : { deactivatedAt: new Date() }),
    },
  });
}

function post(app: FastifyInstance, token: string, payload: unknown) {
  return app.inject({
    method: "POST",
    url: "/api/v1/role-assignments",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
}

describe("Role assignment maintenance API (Phase 74b, Issue #74)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let roleA: Awaited<ReturnType<typeof createCustomerRole>>;
  let roleA2: Awaited<ReturnType<typeof createCustomerRole>>;
  let roleB: Awaited<ReturnType<typeof createCustomerRole>>;
  let systemRole: Awaited<ReturnType<typeof createSystemRole>>;
  let salonA1: Awaited<ReturnType<typeof createSalon>>;
  let salonA2: Awaited<ReturnType<typeof createSalon>>;
  let salonA3Inactive: Awaited<ReturnType<typeof createSalon>>;
  let salonB1: Awaited<ReturnType<typeof createSalon>>;
  let bareUser: Awaited<ReturnType<typeof createBareUser>>;
  let anon: Awaited<ReturnType<typeof createAnonymizedEmployee>>;
  let granteeTenant: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let granteeSalonDedupe: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let granteePersonDedupe: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let personX: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let personY: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let granteeInactiveSalon: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let granteeDuplicate: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let granteeRace: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let granteeIgnoredTenant: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let granteeIdRoutes: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let granteeDeleteFlow: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let tenantBIdAssignment: RoleAssignment;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "74b-api-a");
    tenantB = await seedTestData(app, "74b-api-b");

    roleA = await createCustomerRole(app, tenantA.tenant.id, "RoleA");
    roleA2 = await createCustomerRole(app, tenantA.tenant.id, "RoleA2");
    roleB = await createCustomerRole(app, tenantB.tenant.id, "RoleB");
    systemRole = await createSystemRole(app);

    salonA1 = await createSalon(app, tenantA.tenant.id, "Salon A1", true);
    salonA2 = await createSalon(app, tenantA.tenant.id, "Salon A2", true);
    salonA3Inactive = await createSalon(app, tenantA.tenant.id, "Salon A3", false);
    salonB1 = await createSalon(app, tenantB.tenant.id, "Salon B1", true);

    bareUser = await createBareUser(app);
    anon = await createAnonymizedEmployee(app, tenantA.tenant.id);

    granteeTenant = await createUserWithEmployee(app, tenantA.tenant.id, "GranteeTenant");
    granteeSalonDedupe = await createUserWithEmployee(app, tenantA.tenant.id, "GranteeSalonDedupe");
    granteePersonDedupe = await createUserWithEmployee(
      app,
      tenantA.tenant.id,
      "GranteePersonDedupe",
    );
    personX = await createUserWithEmployee(app, tenantA.tenant.id, "PersonX");
    personY = await createUserWithEmployee(app, tenantA.tenant.id, "PersonY");
    granteeInactiveSalon = await createUserWithEmployee(
      app,
      tenantA.tenant.id,
      "GranteeInactiveSalon",
    );
    granteeDuplicate = await createUserWithEmployee(app, tenantA.tenant.id, "GranteeDuplicate");
    granteeRace = await createUserWithEmployee(app, tenantA.tenant.id, "GranteeRace");
    granteeIgnoredTenant = await createUserWithEmployee(
      app,
      tenantA.tenant.id,
      "GranteeIgnoredTenant",
    );
    granteeIdRoutes = await createUserWithEmployee(app, tenantA.tenant.id, "GranteeIdRoutes");
    granteeDeleteFlow = await createUserWithEmployee(app, tenantA.tenant.id, "GranteeDeleteFlow");

    tenantBIdAssignment = await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantB.tenant.id,
        userId: tenantB.empUser.id,
        accessRoleId: roleB.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantA failed:", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantB failed:", err);
    }
    await app.prisma.user.delete({ where: { id: bareUser.id } });
    await app.prisma.accessRole.delete({ where: { id: systemRole.id } });
    await closeTestApp();
  });

  it("(a) tracer: grants a TENANT-scope role and lists it, with exactly one CREATE audit", async () => {
    const auditCountBefore = await app.prisma.auditLog.count({
      where: { entity: "RoleAssignment", action: "CREATE" },
    });

    const res = await post(app, tenantA.adminToken, {
      userId: granteeTenant.user.id,
      accessRoleId: roleA.id,
      scope: { type: "TENANT" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      userId: granteeTenant.user.id,
      accessRoleId: roleA.id,
      roleName: roleA.name,
      isSystemRole: false,
      scope: { type: "TENANT" },
    });

    const row = await app.prisma.roleAssignment.findUnique({ where: { id: body.id } });
    expect(row?.tenantId).toBe(tenantA.tenant.id);
    expect(row?.salonIds).toEqual([]);
    expect(row?.employeeIds).toEqual([]);

    // Phase 75b (D-26): the grantee still relied on the legacy-role fallback (no stored
    // assignment), so the grant first stores that fallback as its own audited assignment — two
    // CREATE rows instead of one: the materialized Mitarbeiter row and the requested grant.
    const auditCountAfter = await app.prisma.auditLog.count({
      where: { entity: "RoleAssignment", action: "CREATE" },
    });
    expect(auditCountAfter - auditCountBefore).toBe(2);
    const materializedAudit = await app.prisma.auditLog.findFirst({
      where: {
        entity: "RoleAssignment",
        action: "CREATE",
        entityId: { not: body.id },
        newValue: { path: ["userId"], equals: granteeTenant.user.id },
      },
    });
    expect(materializedAudit?.newValue).toEqual({
      userId: granteeTenant.user.id,
      accessRoleId: SYSTEM_ROLE_IDS.EMPLOYEE,
      roleName: "Mitarbeiter",
      scopeType: "TENANT",
      salonIds: [],
      employeeIds: [],
      origin: "SYSTEM",
      reason: "Übernahme der Alt-Rolle (#75)",
      legacyRole: "EMPLOYEE",
    });
    const auditRow = await app.prisma.auditLog.findFirst({
      where: { entity: "RoleAssignment", action: "CREATE", entityId: body.id },
    });
    // Phase 75b (D-14/D-29): roleA grants a ZUGEWIESEN permission, so the derived compat role
    // moves from EMPLOYEE to MANAGER, recorded on the grant's CREATE row (the change's last row).
    expect(auditRow?.newValue).toEqual({
      userId: granteeTenant.user.id,
      accessRoleId: roleA.id,
      roleName: roleA.name,
      scopeType: "TENANT",
      salonIds: [],
      employeeIds: [],
      compatRole: { from: "EMPLOYEE", to: "MANAGER" },
    });

    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/role-assignments",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body) as Array<{ id: string }>;
    expect(list.some((a) => a.id === body.id)).toBe(true);
  });

  it("(b) SALONS scope given unsorted with a duplicate is stored de-duplicated and sorted", async () => {
    const expected = [...new Set([salonA2.id, salonA1.id, salonA1.id])].sort();
    const res = await post(app, tenantA.adminToken, {
      userId: granteeSalonDedupe.user.id,
      accessRoleId: roleA.id,
      scope: { type: "SALONS", salonIds: [salonA2.id, salonA1.id, salonA1.id] },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.scope).toEqual({ type: "SALONS", salonIds: expected });
    const row = await app.prisma.roleAssignment.findUnique({ where: { id: body.id } });
    expect(row?.salonIds).toEqual(expected);
  });

  it("(b) PERSONS scope given unsorted with a duplicate is stored de-duplicated and sorted", async () => {
    const expected = [
      ...new Set([personY.employee.id, personX.employee.id, personX.employee.id]),
    ].sort();
    const res = await post(app, tenantA.adminToken, {
      userId: granteePersonDedupe.user.id,
      accessRoleId: roleA.id,
      scope: {
        type: "PERSONS",
        employeeIds: [personY.employee.id, personX.employee.id, personX.employee.id],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.scope).toEqual({ type: "PERSONS", employeeIds: expected });
    const row = await app.prisma.roleAssignment.findUnique({ where: { id: body.id } });
    expect(row?.employeeIds).toEqual(expected);
  });

  it("(c) AK-74-2: empty scope arrays, a mixed shape and an unknown scope type are rejected with 400, nothing written or audited", async () => {
    const countBefore = await app.prisma.roleAssignment.count();
    const auditBefore = await app.prisma.auditLog.count({ where: { entity: "RoleAssignment" } });

    const cases = [
      {
        userId: granteeTenant.user.id,
        accessRoleId: roleA.id,
        scope: { type: "SALONS", salonIds: [] },
      },
      {
        userId: granteeTenant.user.id,
        accessRoleId: roleA.id,
        scope: { type: "PERSONS", employeeIds: [] },
      },
      {
        userId: granteeTenant.user.id,
        accessRoleId: roleA.id,
        scope: { type: "TENANT", salonIds: [salonA1.id] },
      },
      { userId: granteeTenant.user.id, accessRoleId: roleA.id, scope: { type: "REGION" } },
    ];

    for (const payload of cases) {
      const res = await post(app, tenantA.adminToken, payload);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("Validierungsfehler");
    }

    const countAfter = await app.prisma.roleAssignment.count();
    const auditAfter = await app.prisma.auditLog.count({ where: { entity: "RoleAssignment" } });
    expect(countAfter).toBe(countBefore);
    expect(auditAfter).toBe(auditBefore);
  });

  it("(d) AK-74-3: a foreign id and an unknown id answer the same 404 for each kind; system role and inactive own salon are assignable; a bare user, an anonymized user, and an anonymized employee in a PERSONS list are all 'not found'", async () => {
    const unknown = "00000000-0000-4000-8000-000000000001";

    for (const userId of [tenantB.empUser.id, unknown]) {
      const res = await post(app, tenantA.adminToken, {
        userId,
        accessRoleId: roleA.id,
        scope: { type: "TENANT" },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "Nutzer nicht gefunden" });
    }

    for (const accessRoleId of [roleB.id, unknown]) {
      const res = await post(app, tenantA.adminToken, {
        userId: granteeTenant.user.id,
        accessRoleId,
        scope: { type: "TENANT" },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "Rolle nicht gefunden" });
    }

    for (const salonId of [salonB1.id, unknown]) {
      const res = await post(app, tenantA.adminToken, {
        userId: granteeTenant.user.id,
        accessRoleId: roleA.id,
        scope: { type: "SALONS", salonIds: [salonId] },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "Salon nicht gefunden" });
    }

    for (const employeeId of [tenantB.employee.id, unknown]) {
      const res = await post(app, tenantA.adminToken, {
        userId: granteeTenant.user.id,
        accessRoleId: roleA.id,
        scope: { type: "PERSONS", employeeIds: [employeeId] },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });
    }

    const bareRes = await post(app, tenantA.adminToken, {
      userId: bareUser.id,
      accessRoleId: roleA.id,
      scope: { type: "TENANT" },
    });
    expect(bareRes.statusCode).toBe(404);
    expect(JSON.parse(bareRes.body)).toEqual({ error: "Nutzer nicht gefunden" });

    const anonUserRes = await post(app, tenantA.adminToken, {
      userId: anon.user.id,
      accessRoleId: roleA.id,
      scope: { type: "TENANT" },
    });
    expect(anonUserRes.statusCode).toBe(404);
    expect(JSON.parse(anonUserRes.body)).toEqual({ error: "Nutzer nicht gefunden" });

    const anonEmpRes = await post(app, tenantA.adminToken, {
      userId: granteeTenant.user.id,
      accessRoleId: roleA.id,
      scope: { type: "PERSONS", employeeIds: [anon.employee.id] },
    });
    expect(anonEmpRes.statusCode).toBe(404);
    expect(JSON.parse(anonEmpRes.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });

    const sysRes = await post(app, tenantA.adminToken, {
      userId: granteeTenant.user.id,
      accessRoleId: systemRole.id,
      scope: { type: "TENANT" },
    });
    expect(sysRes.statusCode).toBe(201);
    expect(JSON.parse(sysRes.body).isSystemRole).toBe(true);

    const inactiveRes = await post(app, tenantA.adminToken, {
      userId: granteeInactiveSalon.user.id,
      accessRoleId: roleA.id,
      scope: { type: "SALONS", salonIds: [salonA3Inactive.id] },
    });
    expect(inactiveRes.statusCode).toBe(201);
  });

  it("(e) D-04: a duplicate (user, role, scope type) answers 409; the same role with a different scope type is accepted; a concurrent duplicate race answers with exactly one 201 and one 409", async () => {
    const first = await post(app, tenantA.adminToken, {
      userId: granteeDuplicate.user.id,
      accessRoleId: roleA.id,
      scope: { type: "TENANT" },
    });
    expect(first.statusCode).toBe(201);

    const dup = await post(app, tenantA.adminToken, {
      userId: granteeDuplicate.user.id,
      accessRoleId: roleA.id,
      scope: { type: "TENANT" },
    });
    expect(dup.statusCode).toBe(409);
    expect(JSON.parse(dup.body)).toEqual({
      error: "Diese Rolle ist dem Nutzer mit diesem Scope-Typ bereits zugewiesen.",
    });

    const differentScopeType = await post(app, tenantA.adminToken, {
      userId: granteeDuplicate.user.id,
      accessRoleId: roleA.id,
      scope: { type: "SALONS", salonIds: [salonA1.id] },
    });
    expect(differentScopeType.statusCode).toBe(201);

    const raceUserId = granteeRace.user.id;
    const [r1, r2] = await Promise.all([
      post(app, tenantA.adminToken, {
        userId: raceUserId,
        accessRoleId: roleA.id,
        scope: { type: "TENANT" },
      }),
      post(app, tenantA.adminToken, {
        userId: raceUserId,
        accessRoleId: roleA.id,
        scope: { type: "TENANT" },
      }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it("(f) GET / lists only the caller's tenant's rows; ?userId= filters to that user", async () => {
    // Reuses the tenantB fixture assignment created in beforeAll (Task 2's T-100-09 target) — a
    // second create with the same (user, role, scopeType) would collide with the @@unique index.
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/role-assignments",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    const list = JSON.parse(res.body) as Array<{ id: string; userId: string }>;
    expect(list.some((a) => a.id === tenantBIdAssignment.id)).toBe(false);
    const dbCount = await app.prisma.roleAssignment.count({
      where: { tenantId: tenantA.tenant.id },
    });
    expect(list.length).toBe(dbCount);

    const filtered = await app.inject({
      method: "GET",
      url: `/api/v1/role-assignments?userId=${granteeTenant.user.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    const filteredList = JSON.parse(filtered.body) as Array<{ userId: string }>;
    expect(filteredList.length).toBeGreaterThan(0);
    expect(filteredList.every((a) => a.userId === granteeTenant.user.id)).toBe(true);
  });

  it("(g) a body tenantId is ignored — the row belongs to the caller's own tenant regardless", async () => {
    const res = await post(app, tenantA.adminToken, {
      userId: granteeIgnoredTenant.user.id,
      accessRoleId: roleA.id,
      scope: { type: "TENANT" },
      tenantId: tenantB.tenant.id,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const row = await app.prisma.roleAssignment.findUnique({ where: { id: body.id } });
    expect(row?.tenantId).toBe(tenantA.tenant.id);
  });

  it("(h) AK-74-5: requireRole(ADMIN) rejects an EMPLOYEE token on GET / and POST /", async () => {
    const getRes = await app.inject({
      method: "GET",
      url: "/api/v1/role-assignments",
      headers: { authorization: `Bearer ${tenantA.empToken}` },
    });
    expect(getRes.statusCode).toBe(403);

    const postRes = await post(app, tenantA.empToken, {
      userId: granteeTenant.user.id,
      accessRoleId: roleA.id,
      scope: { type: "TENANT" },
    });
    expect(postRes.statusCode).toBe(403);
  });

  // ── Task 2: GET/PATCH/DELETE /:id — sequential, sharing `assignmentId` across steps ──────────
  let assignmentId: string;

  it("(Task2-1) GET /:id: own assignment matches its GET / list item; a foreign assignment and an unknown id answer the same 404", async () => {
    const createRes = await post(app, tenantA.adminToken, {
      userId: granteeIdRoutes.user.id,
      accessRoleId: roleA.id,
      scope: { type: "TENANT" },
    });
    expect(createRes.statusCode).toBe(201);
    assignmentId = JSON.parse(createRes.body).id;

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/role-assignments/${assignmentId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.body);

    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/role-assignments",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    const listItem = (JSON.parse(listRes.body) as Array<{ id: string }>).find(
      (a) => a.id === assignmentId,
    );
    expect(getBody).toEqual(listItem);

    const unknown = "00000000-0000-4000-8000-000000000002";
    const foreignRes = await app.inject({
      method: "GET",
      url: `/api/v1/role-assignments/${tenantBIdAssignment.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    const unknownRes = await app.inject({
      method: "GET",
      url: `/api/v1/role-assignments/${unknown}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    expect(foreignRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(unknownRes.body);
    expect(JSON.parse(foreignRes.body)).toEqual({ error: "Rollenzuweisung nicht gefunden" });
  });

  it("(Task2-2) PATCH scope change: SALONS given unsorted with a duplicate is normalized and stored; exactly one UPDATE audit with full D-12 values", async () => {
    const auditBefore = await app.prisma.auditLog.count({
      where: { entity: "RoleAssignment", action: "UPDATE" },
    });
    const before = await app.prisma.roleAssignment.findUnique({
      where: { id: assignmentId },
      include: { accessRole: true },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${assignmentId}`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        scope: { type: "SALONS", salonIds: [salonA2.id, salonA1.id, salonA1.id] },
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const expectedSalonIds = [salonA1.id, salonA2.id].sort();
    expect(body.scope).toEqual({ type: "SALONS", salonIds: expectedSalonIds });

    const auditAfter = await app.prisma.auditLog.count({
      where: { entity: "RoleAssignment", action: "UPDATE" },
    });
    expect(auditAfter - auditBefore).toBe(1);
    const auditRow = await app.prisma.auditLog.findFirst({
      where: { entity: "RoleAssignment", action: "UPDATE", entityId: assignmentId },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow?.oldValue).toEqual({
      userId: before!.userId,
      accessRoleId: before!.accessRoleId,
      roleName: before!.accessRole.name,
      scopeType: before!.scopeType,
      salonIds: before!.salonIds,
      employeeIds: before!.employeeIds,
    });
    expect(auditRow?.newValue).toEqual({
      userId: before!.userId,
      accessRoleId: before!.accessRoleId,
      roleName: before!.accessRole.name,
      scopeType: "SALONS",
      salonIds: expectedSalonIds,
      employeeIds: [],
    });
  });

  it("(Task2-3) PATCH {} and an identical scope are no-ops: 200, updatedAt unchanged, no new UPDATE audit", async () => {
    const before = await app.prisma.roleAssignment.findUnique({ where: { id: assignmentId } });
    const auditBefore = await app.prisma.auditLog.count({
      where: { entity: "RoleAssignment", action: "UPDATE" },
    });

    const emptyRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${assignmentId}`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({}),
    });
    expect(emptyRes.statusCode).toBe(200);

    const sameScopeRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${assignmentId}`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        scope: { type: "SALONS", salonIds: [salonA1.id, salonA2.id] },
      }),
    });
    expect(sameScopeRes.statusCode).toBe(200);

    const after = await app.prisma.roleAssignment.findUnique({ where: { id: assignmentId } });
    expect(after?.updatedAt.toISOString()).toBe(before?.updatedAt.toISOString());

    const auditAfter = await app.prisma.auditLog.count({
      where: { entity: "RoleAssignment", action: "UPDATE" },
    });
    expect(auditAfter).toBe(auditBefore);
  });

  it("(Task2-4) PATCH accessRoleId to another own role changes roleName; a foreign role, a foreign salon and an empty salon list are rejected", async () => {
    const roleChangeRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${assignmentId}`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ accessRoleId: roleA2.id }),
    });
    expect(roleChangeRes.statusCode).toBe(200);
    expect(JSON.parse(roleChangeRes.body).roleName).toBe(roleA2.name);

    const foreignRoleRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${assignmentId}`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ accessRoleId: roleB.id }),
    });
    expect(foreignRoleRes.statusCode).toBe(404);
    expect(JSON.parse(foreignRoleRes.body)).toEqual({ error: "Rolle nicht gefunden" });

    const foreignSalonRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${assignmentId}`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ scope: { type: "SALONS", salonIds: [salonB1.id] } }),
    });
    expect(foreignSalonRes.statusCode).toBe(404);
    expect(JSON.parse(foreignSalonRes.body)).toEqual({ error: "Salon nicht gefunden" });

    const emptySalonRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${assignmentId}`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ scope: { type: "SALONS", salonIds: [] } }),
    });
    expect(emptySalonRes.statusCode).toBe(400);
  });

  it("(Task2-5) a PATCH that would create a duplicate (same user, role and scope type) answers 409; the row is unchanged", async () => {
    const other = await post(app, tenantA.adminToken, {
      userId: granteeIdRoutes.user.id,
      accessRoleId: roleA.id,
      scope: { type: "TENANT" },
    });
    expect(other.statusCode).toBe(201);

    const before = await app.prisma.roleAssignment.findUnique({ where: { id: assignmentId } });

    const dupRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${assignmentId}`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ accessRoleId: roleA.id, scope: { type: "TENANT" } }),
    });
    expect(dupRes.statusCode).toBe(409);
    expect(JSON.parse(dupRes.body)).toEqual({
      error: "Diese Rolle ist dem Nutzer mit diesem Scope-Typ bereits zugewiesen.",
    });

    const after = await app.prisma.roleAssignment.findUnique({ where: { id: assignmentId } });
    expect(after).toEqual(before);
  });

  it("(Task2-6) a PATCH body carrying userId is rejected with 400; the row's userId is unchanged", async () => {
    const before = await app.prisma.roleAssignment.findUnique({ where: { id: assignmentId } });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${assignmentId}`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ userId: granteeTenant.user.id }),
    });
    expect(res.statusCode).toBe(400);
    const after = await app.prisma.roleAssignment.findUnique({ where: { id: assignmentId } });
    expect(after?.userId).toBe(before?.userId);
  });

  it("(Task2-7) PATCH {} and DELETE on a foreign tenant's assignment and an unknown id answer the same 404, no audit, the foreign row unchanged", async () => {
    const unknown = "00000000-0000-4000-8000-000000000003";
    const auditBefore = await app.prisma.auditLog.count({ where: { entity: "RoleAssignment" } });

    const patchForeign = await app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${tenantBIdAssignment.id}`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({}),
    });
    const patchUnknown = await app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${unknown}`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({}),
    });
    expect(patchForeign.statusCode).toBe(404);
    expect(patchForeign.body).toBe(patchUnknown.body);

    const deleteForeign = await app.inject({
      method: "DELETE",
      url: `/api/v1/role-assignments/${tenantBIdAssignment.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    const deleteUnknown = await app.inject({
      method: "DELETE",
      url: `/api/v1/role-assignments/${unknown}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    expect(deleteForeign.statusCode).toBe(404);
    expect(deleteForeign.body).toBe(deleteUnknown.body);

    const auditAfter = await app.prisma.auditLog.count({ where: { entity: "RoleAssignment" } });
    expect(auditAfter).toBe(auditBefore);

    const stillExists = await app.prisma.roleAssignment.findUnique({
      where: { id: tenantBIdAssignment.id },
    });
    expect(stillExists).toEqual(tenantBIdAssignment);
  });

  it("(Task2-8) DELETE revokes an own assignment: 204 empty body, row gone, exactly one DELETE audit, GET /:id afterwards answers 404", async () => {
    const createRes = await post(app, tenantA.adminToken, {
      userId: granteeDeleteFlow.user.id,
      accessRoleId: roleA.id,
      scope: { type: "TENANT" },
    });
    const id = JSON.parse(createRes.body).id;
    const before = await app.prisma.roleAssignment.findUnique({
      where: { id },
      include: { accessRole: true },
    });

    const auditBefore = await app.prisma.auditLog.count({
      where: { entity: "RoleAssignment", action: "DELETE" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/role-assignments/${id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");

    const row = await app.prisma.roleAssignment.findUnique({ where: { id } });
    expect(row).toBeNull();

    const auditAfter = await app.prisma.auditLog.count({
      where: { entity: "RoleAssignment", action: "DELETE" },
    });
    expect(auditAfter - auditBefore).toBe(1);
    const auditRow = await app.prisma.auditLog.findFirst({
      where: { entity: "RoleAssignment", action: "DELETE", entityId: id },
    });
    expect(auditRow?.oldValue).toEqual({
      userId: before!.userId,
      accessRoleId: before!.accessRoleId,
      roleName: before!.accessRole.name,
      scopeType: before!.scopeType,
      salonIds: before!.salonIds,
      employeeIds: before!.employeeIds,
    });

    const getAfter = await app.inject({
      method: "GET",
      url: `/api/v1/role-assignments/${id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    expect(getAfter.statusCode).toBe(404);
  });

  it("(Task2-9) AK-74-5: the ADMIN role guard rejects an EMPLOYEE token on GET/PATCH/DELETE /:id", async () => {
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/role-assignments/${assignmentId}`,
      headers: { authorization: `Bearer ${tenantA.empToken}` },
    });
    expect(getRes.statusCode).toBe(403);

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${assignmentId}`,
      headers: { authorization: `Bearer ${tenantA.empToken}`, "content-type": "application/json" },
      payload: "{}",
    });
    expect(patchRes.statusCode).toBe(403);

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/role-assignments/${assignmentId}`,
      headers: { authorization: `Bearer ${tenantA.empToken}` },
    });
    expect(deleteRes.statusCode).toBe(403);
  });

  it("(Task2-10) a PATCH that changes only the role does not re-validate the stored scope: a person list whose employee was anonymized since still allows the role change", async () => {
    // The stored scope was valid when written; the employee in it was anonymized afterwards. A
    // role-only change must not answer "Mitarbeiter nicht gefunden" for a list it did not touch.
    const stored = await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: granteeDeleteFlow.user.id,
        accessRoleId: roleA.id,
        scopeType: "PERSONS",
        salonIds: [],
        employeeIds: [anon.employee.id],
      },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${stored.id}`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ accessRoleId: roleA2.id }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.roleName).toBe(roleA2.name);
    expect(body.scope).toEqual({ type: "PERSONS", employeeIds: [anon.employee.id] });

    // Once the person list IS part of the write, it is validated: swap to a live employee (200),
    // then try to put the anonymized one back — "not found" (D-08).
    const resend = await app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${stored.id}`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ scope: { type: "PERSONS", employeeIds: [personX.employee.id] } }),
    });
    expect(resend.statusCode).toBe(200);
    const swapBack = await app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${stored.id}`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ scope: { type: "PERSONS", employeeIds: [anon.employee.id] } }),
    });
    expect(swapBack.statusCode).toBe(404);
    expect(JSON.parse(swapBack.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });
  });
});
