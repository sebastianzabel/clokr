/**
 * Phase 74b code review (74b-REVIEW.md) — regression tests for the review findings.
 *
 * Every race below is made deterministic instead of being left to timing: the test wraps
 * `app.prisma.$transaction` once and performs the "concurrent" write right before the route's own
 * transaction starts, i.e. after the route has parsed its request but before it takes the tenant
 * lock. That is exactly the window the findings describe.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import type { Prisma, RoleAssignment } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { roleNameKey, normalizeRolePermissions } from "../access-role";
import { DEFAULT_SALON_OPENING_HOURS } from "../facade/salons";
import { countGuardedPermissionHolders, userMayApply } from "../facade/role-assignments";

const TIME_ENTRY_READ = "time-entry:read:ZUGEWIESEN";

function uniqueSuffix(label: string): string {
  return label + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Role-descriptive fixture user + employee — no person names (CLAUDE.md PII rule). */
async function createUserWithEmployee(
  app: FastifyInstance,
  tenantId: string,
  label: string,
  employeeData: { firstName?: string; hireDate?: Date; exitDate?: Date } = {},
) {
  const s = uniqueSuffix(label);
  const passwordHash = await bcrypt.hash("test1234", 10);
  const user = await app.prisma.user.create({
    data: { email: `rvf-${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `RVF-${crypto.randomBytes(6).toString("hex")}`,
      firstName: employeeData.firstName ?? label,
      lastName: "Test",
      hireDate: employeeData.hireDate ?? new Date("2024-01-01"),
      exitDate: employeeData.exitDate,
    },
  });
  return { user, employee };
}

async function createRole(
  app: FastifyInstance,
  tenantId: string | null,
  label: string,
  permissions: string[],
) {
  const name = uniqueSuffix(label);
  return app.prisma.accessRole.create({
    data: {
      tenantId,
      name,
      nameKey: roleNameKey(name),
      permissions: normalizeRolePermissions(permissions),
    },
  });
}

type TransactionFn = (...args: unknown[]) => Promise<unknown>;
type InteractiveTransactionFn = (
  fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
  options?: unknown,
) => Promise<unknown>;

/** Reads a property off `target` and binds a function to it, so Prisma's `this` stays intact. */
function forward(target: object, prop: string | symbol): unknown {
  const value = (target as Record<string | symbol, unknown>)[prop];
  return typeof value === "function" ? value.bind(target) : value;
}

/**
 * A transaction client whose `<model>.<method>` runs `hook` first — e.g. the window between a
 * route's own check and its write, inside the route's transaction.
 */
function beforeDelegateCall(
  tx: Prisma.TransactionClient,
  model: "roleAssignment" | "accessRole",
  method: string,
  hook: () => Promise<unknown>,
): Prisma.TransactionClient {
  const delegate = new Proxy(tx[model], {
    get(target, prop) {
      const value = forward(target, prop);
      if (prop !== method) return value;
      return async (args: unknown) => {
        await hook();
        return (value as (a: unknown) => Promise<unknown>)(args);
      };
    },
  });
  return new Proxy(tx, {
    get(target, prop) {
      return prop === model ? delegate : forward(target, prop);
    },
  });
}

describe("Phase 74b review fixes", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let roleX: Awaited<ReturnType<typeof createRole>>;
  let roleY: Awaited<ReturnType<typeof createRole>>;
  let salonA1: { id: string };

  /**
   * Runs `concurrentWrite` once, right before the NEXT `app.prisma.$transaction` call of the code
   * under test starts — the "another request committed in between" window.
   */
  function beforeNextTransaction(concurrentWrite: () => Promise<unknown>) {
    const realTransaction = app.prisma.$transaction.bind(app.prisma) as unknown as TransactionFn;
    vi.spyOn(app.prisma, "$transaction").mockImplementationOnce((async (...args: unknown[]) => {
      await concurrentWrite();
      return realTransaction(...args);
    }) as never);
  }

  /** Hands the NEXT `app.prisma.$transaction` callback a client wrapped by `wrap`. */
  function wrapNextTransactionClient(
    wrap: (tx: Prisma.TransactionClient) => Prisma.TransactionClient,
  ) {
    const realTransaction = app.prisma.$transaction.bind(
      app.prisma,
    ) as unknown as InteractiveTransactionFn;
    vi.spyOn(app.prisma, "$transaction").mockImplementationOnce((async (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: unknown,
    ) => realTransaction((tx) => fn(wrap(tx)), options)) as never);
  }

  function postAssignment(payload: object) {
    return app.inject({
      method: "POST",
      url: "/api/v1/role-assignments",
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(payload),
    });
  }

  function assignTenant(userId: string, accessRoleId: string): Promise<RoleAssignment> {
    return app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId,
        accessRoleId,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
  }

  function narrowToSalon(assignmentId: string) {
    return app.prisma.roleAssignment.update({
      where: { id: assignmentId },
      data: { scopeType: "SALONS", salonIds: [salonA1.id], employeeIds: [] },
    });
  }

  function patchAssignment(id: string, payload: object) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${id}`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(payload),
    });
  }

  function assignmentAudits(entityId: string, action: string) {
    return app.prisma.auditLog.findMany({
      where: { entity: "RoleAssignment", entityId, action },
      orderBy: { createdAt: "asc" },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "74b-review-a");
    roleX = await createRole(app, tenantA.tenant.id, "RX", [TIME_ENTRY_READ]);
    roleY = await createRole(app, tenantA.tenant.id, "RY", [TIME_ENTRY_READ]);
    salonA1 = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Salon Review A1",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantA failed:", err);
    }
    await closeTestApp();
  });

  // ── WR-01: PATCH/DELETE read the assignment inside the guarded transaction ─────────────────────

  it("WR-01: a PATCH that changes only the role keeps a scope narrowed concurrently, and its audit oldValue is the narrowed state", async () => {
    const grantee = await createUserWithEmployee(app, tenantA.tenant.id, "Grantee");
    const assignment = await assignTenant(grantee.user.id, roleX.id);
    beforeNextTransaction(() => narrowToSalon(assignment.id));

    const res = await patchAssignment(assignment.id, { accessRoleId: roleY.id });

    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const stored = await app.prisma.roleAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(stored.accessRoleId).toBe(roleY.id);
    expect(stored.scopeType, "the concurrent narrowing was silently reverted").toBe("SALONS");
    expect(stored.salonIds).toEqual([salonA1.id]);
    const audits = await assignmentAudits(assignment.id, "UPDATE");
    expect(audits).toHaveLength(1);
    expect(audits[0].oldValue).toEqual({
      userId: grantee.user.id,
      accessRoleId: roleX.id,
      roleName: roleX.name,
      scopeType: "SALONS",
      salonIds: [salonA1.id],
      employeeIds: [],
    });
  });

  it("WR-01: a PATCH that asks for the scope a concurrent write already set is a no-op — nothing written, nothing audited", async () => {
    const grantee = await createUserWithEmployee(app, tenantA.tenant.id, "Grantee");
    const assignment = await assignTenant(grantee.user.id, roleX.id);
    let narrowed: RoleAssignment | null = null;
    beforeNextTransaction(async () => {
      narrowed = await narrowToSalon(assignment.id);
    });

    const res = await patchAssignment(assignment.id, {
      scope: { type: "SALONS", salonIds: [salonA1.id] },
    });

    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const stored = await app.prisma.roleAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(stored).toEqual(narrowed);
    expect(await assignmentAudits(assignment.id, "UPDATE")).toHaveLength(0);
  });

  it("WR-01: DELETE records the state the row had when it was deleted, not a state read before the lock", async () => {
    const grantee = await createUserWithEmployee(app, tenantA.tenant.id, "Grantee");
    const assignment = await assignTenant(grantee.user.id, roleX.id);
    beforeNextTransaction(() => narrowToSalon(assignment.id));

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/role-assignments/${assignment.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(res.statusCode, res.body.slice(0, 400)).toBe(204);
    const audits = await assignmentAudits(assignment.id, "DELETE");
    expect(audits).toHaveLength(1);
    expect(audits[0].oldValue).toMatchObject({ scopeType: "SALONS", salonIds: [salonA1.id] });
  });

  // ── WR-02: POST is serialised against anonymization and maps a vanished reference to 404 ──────

  it("WR-02: a grant racing the anonymization of its grantee answers 404 'Nutzer nicht gefunden' and leaves no assignment (D-22)", async () => {
    const grantee = await createUserWithEmployee(app, tenantA.tenant.id, "Grantee");
    beforeNextTransaction(async () => {
      const anonymized = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${grantee.employee.id}`,
        headers: { authorization: `Bearer ${tenantA.adminToken}` },
      });
      expect(anonymized.statusCode, anonymized.body.slice(0, 400)).toBe(204);
    });

    const res = await postAssignment({
      userId: grantee.user.id,
      accessRoleId: roleX.id,
      scope: { type: "TENANT" },
    });

    expect(res.statusCode, res.body.slice(0, 400)).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Nutzer nicht gefunden" });
    expect(
      await app.prisma.roleAssignment.count({ where: { userId: grantee.user.id } }),
      "an anonymized user holds a role assignment",
    ).toBe(0);
  });

  it("WR-02: a customer role deleted between the reference check and the insert answers 404 'Rolle nicht gefunden', not 500", async () => {
    const grantee = await createUserWithEmployee(app, tenantA.tenant.id, "Grantee");
    const doomedRole = await createRole(app, tenantA.tenant.id, "RDoomed", [TIME_ENTRY_READ]);
    wrapNextTransactionClient((tx) =>
      beforeDelegateCall(tx, "roleAssignment", "create", () =>
        app.prisma.accessRole.delete({ where: { id: doomedRole.id } }),
      ),
    );

    const res = await postAssignment({
      userId: grantee.user.id,
      accessRoleId: doomedRole.id,
      scope: { type: "TENANT" },
    });

    expect(res.statusCode, res.body.slice(0, 400)).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Rolle nicht gefunden" });
    expect(await app.prisma.roleAssignment.count({ where: { userId: grantee.user.id } })).toBe(0);
    expect(
      await app.prisma.auditLog.count({
        where: {
          entity: "RoleAssignment",
          action: "CREATE",
          newValue: { path: ["userId"], equals: grantee.user.id },
        },
      }),
    ).toBe(0);
  });

  // ── WR-03: DELETE /roles/:id maps only the assignment FK to 409; API-key actors audit cleanly ──

  const ROLE_ASSIGNED_DELETE_MESSAGE =
    "Die Rolle ist noch Nutzern zugewiesen und kann nicht gelöscht werden.";

  async function createAdminApiKey() {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { name: "Review WR-03 admin key", scopes: ["admin"] },
    });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    return JSON.parse(res.body) as { id: string; rawKey: string };
  }

  function sendAs(
    token: string,
    method: "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
  ) {
    return app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }

  it("WR-03: an ADMIN-scope API key can create, change, copy and delete an unassigned role; every AccessRole audit row has no userId and names the key", async () => {
    const key = await createAdminApiKey();

    const created = await sendAs(key.rawKey, "POST", "/api/v1/roles", {
      name: uniqueSuffix("Rolle per API-Key"),
      permissions: [TIME_ENTRY_READ],
    });
    expect(created.statusCode, created.body.slice(0, 400)).toBe(201);
    const roleId = (JSON.parse(created.body) as { id: string }).id;

    const patched = await sendAs(key.rawKey, "PATCH", `/api/v1/roles/${roleId}`, {
      name: uniqueSuffix("Rolle per API-Key geaendert"),
    });
    expect(patched.statusCode, patched.body.slice(0, 400)).toBe(200);

    const copied = await sendAs(key.rawKey, "POST", `/api/v1/roles/${roleId}/copy`, {});
    expect(copied.statusCode, copied.body.slice(0, 400)).toBe(201);
    const copyId = (JSON.parse(copied.body) as { id: string }).id;

    const deleted = await sendAs(key.rawKey, "DELETE", `/api/v1/roles/${roleId}`);
    expect(deleted.statusCode, "an unassigned role answered as 'still assigned'").toBe(204);

    for (const [action, entityId] of [
      ["CREATE", roleId],
      ["UPDATE", roleId],
      ["COPY", copyId],
      ["DELETE", roleId],
    ] as const) {
      const row = await app.prisma.auditLog.findFirst({
        where: { entity: "AccessRole", entityId, action },
      });
      expect(row, `${action} audit row`).not.toBeNull();
      expect(row?.userId, `${action} userId`).toBeNull();
      expect((row?.newValue as { actor?: unknown } | null)?.actor, `${action} actor`).toEqual({
        type: "API_KEY",
        apiKeyId: key.id,
      });
      expect(row?.ipAddress, `${action} ip`).not.toBeNull();
    }
  });

  it("WR-03: a P2003 on another foreign key while deleting a role is not answered as 'still assigned'", async () => {
    const role = await createRole(app, tenantA.tenant.id, "RAuditFk", [TIME_ENTRY_READ]);
    const realAudit = app.audit.bind(app);
    vi.spyOn(app, "audit").mockImplementation(async (entry) => {
      if (entry.entity === "AccessRole" && entry.entityId === role.id) {
        // The shape Prisma 7 + adapter-pg reports for a violated AuditLog.userId reference.
        throw Object.assign(new Error("foreign key violation (test)"), {
          code: "P2003",
          meta: {
            modelName: "AuditLog",
            driverAdapterError: {
              name: "DriverAdapterError",
              cause: {
                kind: "ForeignKeyConstraintViolation",
                constraint: { index: "AuditLog_userId_fkey" },
              },
            },
          },
        });
      }
      return realAudit(entry);
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/roles/${role.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(res.body).not.toContain(ROLE_ASSIGNED_DELETE_MESSAGE);
    expect(res.statusCode).toBe(500);
    expect(await app.prisma.accessRole.findUnique({ where: { id: role.id } })).not.toBeNull();
  });

  it("WR-03: an assignment created after the in-transaction count still turns the role delete into the 'still assigned' 409 via its foreign key", async () => {
    const role = await createRole(app, tenantA.tenant.id, "RLateAssign", [TIME_ENTRY_READ]);
    const grantee = await createUserWithEmployee(app, tenantA.tenant.id, "Grantee");
    wrapNextTransactionClient((tx) =>
      beforeDelegateCall(tx, "accessRole", "delete", () => assignTenant(grantee.user.id, role.id)),
    );

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/roles/${role.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(res.statusCode, res.body.slice(0, 400)).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: ROLE_ASSIGNED_DELETE_MESSAGE });
    expect(await app.prisma.accessRole.findUnique({ where: { id: role.id } })).not.toBeNull();
    expect(
      await app.prisma.auditLog.count({
        where: { entity: "AccessRole", entityId: role.id, action: "DELETE" },
      }),
    ).toBe(0);
  });

  // ── WR-06: deactivate / anonymize audits resolve the actor and carry the request ───────────────

  async function latestAudit(entity: string, entityId: string, action: string) {
    return app.prisma.auditLog.findFirst({
      where: { entity, entityId, action },
      orderBy: { createdAt: "desc" },
    });
  }

  it("WR-06: an ADMIN-scope API key can deactivate an employee; the UPDATE audit has no userId, names the key and carries the IP", async () => {
    const key = await createAdminApiKey();
    const person = await createUserWithEmployee(app, tenantA.tenant.id, "Deaktivierung");

    const res = await sendAs(
      key.rawKey,
      "PATCH",
      `/api/v1/employees/${person.employee.id}/deactivate`,
      {},
    );

    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const row = await latestAudit("Employee", person.employee.id, "UPDATE");
    expect(row?.userId).toBeNull();
    expect((row?.newValue as { actor?: unknown } | null)?.actor).toEqual({
      type: "API_KEY",
      apiKeyId: key.id,
    });
    expect(row?.ipAddress).not.toBeNull();
  });

  it("WR-06: a deactivation by a logged-in admin records the admin and the request IP", async () => {
    const person = await createUserWithEmployee(app, tenantA.tenant.id, "Deaktivierung");

    const res = await sendAs(
      tenantA.adminToken,
      "PATCH",
      `/api/v1/employees/${person.employee.id}/deactivate`,
      {},
    );

    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const row = await latestAudit("Employee", person.employee.id, "UPDATE");
    expect(row?.userId).toBe(tenantA.adminUser.id);
    expect(row?.ipAddress, "the deactivate audit carries no request IP").not.toBeNull();
  });

  it("WR-06: an ADMIN-scope API key can anonymize an employee holding an assignment; the per-assignment DELETE and the ANONYMIZE audit have no userId and name the key", async () => {
    const key = await createAdminApiKey();
    const person = await createUserWithEmployee(app, tenantA.tenant.id, "Anonymisierung");
    const assignment = await assignTenant(person.user.id, roleX.id);

    const res = await sendAs(key.rawKey, "DELETE", `/api/v1/employees/${person.employee.id}`);

    expect(res.statusCode, res.body.slice(0, 400)).toBe(204);
    const removal = await latestAudit("RoleAssignment", assignment.id, "DELETE");
    expect(removal?.userId).toBeNull();
    expect(removal?.newValue).toEqual({
      reason: "Anonymisierung",
      actor: { type: "API_KEY", apiKeyId: key.id },
    });
    expect(removal?.ipAddress).not.toBeNull();
    const anonymize = await latestAudit("Employee", person.employee.id, "ANONYMIZE");
    expect(anonymize?.userId).toBeNull();
    expect((anonymize?.newValue as { actor?: unknown } | null)?.actor).toEqual({
      type: "API_KEY",
      apiKeyId: key.id,
    });
  });

  // ── WR-04: hard delete removes remaining assignments explicitly, one DELETE audit each ─────────

  it("WR-04: hard-deleting a user who still holds an assignment writes one RoleAssignment DELETE audit per row instead of a silent cascade", async () => {
    // An anonymized-looking employee (anonymized first name, exit date past every retention
    // window) whose user still holds an assignment — the state WR-02 showed can arise, built
    // directly here because no route produces it any more.
    const person = await createUserWithEmployee(app, tenantA.tenant.id, "Endgueltig", {
      firstName: "Gelöscht",
      hireDate: new Date("2004-01-01"),
      exitDate: new Date("2010-01-01"),
    });
    const tenantWide = await assignTenant(person.user.id, roleX.id);
    const salonScoped = await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: person.user.id,
        accessRoleId: roleY.id,
        scopeType: "SALONS",
        salonIds: [salonA1.id],
        employeeIds: [],
      },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/employees/${person.employee.id}/hard-delete`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({}),
    });

    expect(res.statusCode, res.body.slice(0, 400)).toBe(204);
    expect(await app.prisma.user.findUnique({ where: { id: person.user.id } })).toBeNull();
    for (const [removed, roleName] of [
      [tenantWide, roleX.name],
      [salonScoped, roleY.name],
    ] as const) {
      const audits = await assignmentAudits(removed.id, "DELETE");
      expect(audits, `DELETE audit for ${removed.scopeType} assignment`).toHaveLength(1);
      expect(audits[0].oldValue).toEqual({
        userId: person.user.id,
        accessRoleId: removed.accessRoleId,
        roleName,
        scopeType: removed.scopeType,
        salonIds: removed.salonIds,
        employeeIds: removed.employeeIds,
      });
      expect(audits[0].newValue).toEqual({ reason: "Endgültige Löschung" });
      expect(audits[0].userId).toBe(tenantA.adminUser.id);
    }
  });

  // ── IN-02: a malformed stored assignment fails closed (deny), it never throws ──────────────────

  /** Writes a row that violates the D-03 shape invariant — reachable only via direct DB writes. */
  function writeMalformed(
    userId: string,
    accessRoleId: string,
    shape: {
      scopeType: "TENANT" | "SALONS" | "PERSONS";
      salonIds: string[];
      employeeIds: string[];
    },
  ) {
    return app.prisma.roleAssignment.create({
      data: { tenantId: tenantA.tenant.id, userId, accessRoleId, ...shape },
    });
  }

  it("IN-02: a SALONS row with an empty salon list denies for that row instead of throwing; the user's valid assignments still apply", async () => {
    const holder = await createUserWithEmployee(app, tenantA.tenant.id, "Fehlform");
    await writeMalformed(holder.user.id, roleX.id, {
      scopeType: "SALONS",
      salonIds: [],
      employeeIds: [],
    });

    await expect(
      userMayApply(app.prisma, tenantA.tenant.id, holder.user.id, TIME_ENTRY_READ, {
        salonId: salonA1.id,
      }),
    ).resolves.toBe(false);

    await assignTenant(holder.user.id, roleY.id);
    await expect(
      userMayApply(app.prisma, tenantA.tenant.id, holder.user.id, TIME_ENTRY_READ, {}),
    ).resolves.toBe(true);
  });

  it("IN-02: a PERSONS row with an empty person list denies instead of throwing", async () => {
    const holder = await createUserWithEmployee(app, tenantA.tenant.id, "Fehlform");
    const target = await createUserWithEmployee(app, tenantA.tenant.id, "Ziel");
    await writeMalformed(holder.user.id, roleX.id, {
      scopeType: "PERSONS",
      salonIds: [],
      employeeIds: [],
    });

    await expect(
      userMayApply(app.prisma, tenantA.tenant.id, holder.user.id, TIME_ENTRY_READ, {
        employeeId: target.employee.id,
      }),
    ).resolves.toBe(false);
  });

  it("IN-02: a TENANT row that also carries a salon list is malformed and grants nothing — neither a right nor holder status", async () => {
    const holder = await createUserWithEmployee(app, tenantA.tenant.id, "Fehlform");
    const roleManage = await createRole(app, tenantA.tenant.id, "RMFehlform", [
      "role:manage:ZUGEWIESEN",
      "role-assignment:manage:ZUGEWIESEN",
    ]);
    await writeMalformed(holder.user.id, roleManage.id, {
      scopeType: "TENANT",
      salonIds: [salonA1.id],
      employeeIds: [],
    });

    await expect(
      userMayApply(app.prisma, tenantA.tenant.id, holder.user.id, "role:manage:ZUGEWIESEN", {}),
    ).resolves.toBe(false);
    const holders = await countGuardedPermissionHolders(app.prisma, tenantA.tenant.id);
    expect(holders["role:manage:ZUGEWIESEN"]).toBe(0);
    expect(holders["role-assignment:manage:ZUGEWIESEN"]).toBe(0);
  });
});
