/**
 * Phase 75b (Issue #75), D-08..D-12, D-30 — the request-scoped permission resolver and its guards.
 *
 * The resolver answers from the database only: the caller's stored `RoleAssignment` rows in the
 * request tenant, or — only when there are none — the system role of the legacy `User.role`
 * column as one implicit TENANT assignment (the "Altrollen-Rückfall", D-08). API keys resolve to
 * the Admin or Manager system role by their `admin` scope (D-11, D-30). The legacy JWT role claim
 * is never read (D-12): the fake requests below carry a DELIBERATELY wrong `role` wherever that
 * matters, so a resolver that read it would fail.
 *
 * Most cases call the resolver with a minimal request object (`server`, `user`, `apiKeyScopes`)
 * against the real worker database; the guard cases additionally go through
 * `GET /api/v1/audit-logs`, the first route converted to a permission (AC-75-11), to pin the 401
 * and 403 bodies byte for byte.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import {
  effectiveGrants,
  hasPermission,
  permissionReach,
  requireAnyPermission,
  requirePermission,
  type EffectiveGrants,
} from "../request-permissions";
import { SYSTEM_ROLE_IDS, SYSTEM_ROLE_PERMISSIONS, type SystemRoleSlot } from "../system-roles";
import { roleNameKey } from "../access-role";
import type { PermissionKey } from "../permission-catalog";

type Seed = Awaited<ReturnType<typeof seedTestData>>;

function uniqueSuffix(label: string): string {
  return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function sorted(set: ReadonlySet<string>): string[] {
  return [...set].sort();
}

/** The two halves of a system role's permission set, sorted. */
function systemSets(slot: SystemRoleSlot): { zugewiesen: string[]; eigene: string[] } {
  const keys = SYSTEM_ROLE_PERMISSIONS[slot];
  return {
    zugewiesen: keys.filter((k) => k.endsWith(":ZUGEWIESEN")).sort(),
    eigene: keys.filter((k) => k.endsWith(":EIGENE")).sort(),
  };
}

function setsOf(grants: EffectiveGrants): { zugewiesen: string[]; eigene: string[] } {
  return { zugewiesen: sorted(grants.zugewiesen), eigene: sorted(grants.eigene) };
}

interface FakeUser {
  sub: string;
  role: Role;
  tenantId: string;
  employeeId?: string;
}

/** A minimal request as the resolver sees it after `requireAuth`. */
function fakeRequest(server: unknown, user: FakeUser, apiKeyScopes?: string[]): FastifyRequest {
  return {
    server,
    user,
    apiKeyScopes,
    headers: {},
    jwtVerify: async () => undefined,
  } as unknown as FastifyRequest;
}

interface FakeReply {
  sent: boolean;
  statusCode: number | null;
  body: unknown;
  code(n: number): FakeReply;
  send(body: unknown): FakeReply;
}

function fakeReply(): FakeReply {
  return {
    sent: false,
    statusCode: null,
    body: undefined,
    code(n: number) {
      this.statusCode = n;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      this.sent = true;
      return this;
    },
  };
}

describe("request-permissions — resolver, guards and checks (Phase 75b, D-08..D-12, D-30)", () => {
  let app: FastifyInstance;
  let tA: Seed;
  let tB: Seed;
  const createdUserIds: string[] = [];

  /** A user with an Employee in `tenantId`, legacy column `role`, no stored assignment. */
  async function createUser(tenantId: string, role: Role, label: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash("test1234", 10);
    const user = await app.prisma.user.create({
      data: { email: `rp-${s}@test.de`, passwordHash, role, isActive: true },
    });
    createdUserIds.push(user.id);
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `RP-${s}`.slice(0, 20),
        firstName: label,
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    return { user, employee, email: user.email };
  }

  async function assign(
    tenantId: string,
    userId: string,
    accessRoleId: string,
    scope: {
      scopeType: "TENANT" | "SALONS" | "PERSONS";
      salonIds?: string[];
      employeeIds?: string[];
    },
  ) {
    await app.prisma.roleAssignment.create({
      data: {
        tenantId,
        userId,
        accessRoleId,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: scope.employeeIds ?? [],
      },
    });
  }

  async function customerRole(tenantId: string, label: string, permissions: PermissionKey[]) {
    const name = `Rolle ${uniqueSuffix(label)}`;
    return app.prisma.accessRole.create({
      data: { tenantId, name, nameKey: roleNameKey(name), permissions },
    });
  }

  function requestFor(
    user: { id: string; role: Role },
    employee: { id: string; tenantId: string },
    claimRole: Role = user.role,
  ): FastifyRequest {
    return fakeRequest(app, {
      sub: user.id,
      role: claimRole,
      tenantId: employee.tenantId,
      employeeId: employee.id,
    });
  }

  async function createApiKey(tenantId: string, createdBy: string, scopes: string[]) {
    const raw = `clk_${randomBytes(24).toString("hex")}`;
    const row = await app.prisma.apiKey.create({
      data: {
        tenantId,
        name: `rp-key-${uniqueSuffix("k")}`,
        keyHash: createHash("sha256").update(raw).digest("hex"),
        keyPrefix: raw.slice(0, 8),
        scopes,
        createdBy,
      },
    });
    return { raw, id: row.id };
  }

  let loginCounter = 0;
  async function loginToken(email: string): Promise<string> {
    loginCounter += 1;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "test1234" },
      remoteAddress: `10.75.5.${loginCounter}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body).accessToken as string;
  }

  beforeAll(async () => {
    app = await getTestApp();
    tA = await seedTestData(app, "rp-a");
    tB = await seedTestData(app, "rp-b");
  });

  afterAll(async () => {
    for (const seed of [tA, tB]) {
      try {
        await app.prisma.apiKey.deleteMany({ where: { tenantId: seed.tenant.id } });
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId: seed.tenant.id } });
        await app.prisma.accessRole.deleteMany({ where: { tenantId: seed.tenant.id } });
        await cleanupTestData(app, seed.tenant.id);
      } catch (err) {
        console.error("Cleanup failed:", err);
      }
    }
    await closeTestApp();
  });

  // ── D-08 fallback ────────────────────────────────────────────────────────────

  it.each([
    ["EMPLOYEE", "EMPLOYEE"],
    ["MANAGER", "MANAGER"],
    ["ADMIN", "ADMIN"],
  ] as const)(
    "a legacy %s without stored assignments gets exactly the %s system role's sets",
    async (role, slot) => {
      const { user, employee } = await createUser(tA.tenant.id, role, `fb-${role}`);
      const grants = await effectiveGrants(requestFor(user, employee));
      expect(setsOf(grants)).toEqual(systemSets(slot));
      expect(grants.ownEmployeeId).toBe(employee.id);
    },
  );

  it("a legacy EMPLOYEE with a stored TENANT Manager assignment gets the Manager set — the column is ignored", async () => {
    const { user, employee } = await createUser(tA.tenant.id, "EMPLOYEE", "stored-mgr");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.MANAGER, { scopeType: "TENANT" });
    const grants = await effectiveGrants(requestFor(user, employee));
    expect(setsOf(grants)).toEqual(systemSets("MANAGER"));
  });

  it("the JWT role claim is never read: a stored Mitarbeiter assignment wins over an ADMIN claim", async () => {
    const { user, employee } = await createUser(tA.tenant.id, "ADMIN", "claim");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.EMPLOYEE, { scopeType: "TENANT" });
    const grants = await effectiveGrants(requestFor(user, employee, "ADMIN"));
    expect(setsOf(grants)).toEqual(systemSets("EMPLOYEE"));
  });

  // ── D-09 scopes ──────────────────────────────────────────────────────────────

  it("a SALONS assignment on a role with ZUGEWIESEN keys yields no tenant-wide key, only its EIGENE keys (D-09)", async () => {
    const { user, employee } = await createUser(tA.tenant.id, "ADMIN", "salons");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.MANAGER, {
      scopeType: "SALONS",
      salonIds: [tA.salonId],
    });
    const grants = await effectiveGrants(requestFor(user, employee));
    expect(sorted(grants.zugewiesen)).toEqual([]);
    expect(sorted(grants.eigene)).toEqual(systemSets("MANAGER").eigene);
  });

  it("a PERSONS assignment on a customer role yields only its EIGENE keys (D-09)", async () => {
    const { user, employee } = await createUser(tA.tenant.id, "ADMIN", "persons");
    const role = await customerRole(tA.tenant.id, "persons", [
      "time-entry:read:EIGENE",
      "time-entry:read:ZUGEWIESEN",
      "audit-log:read:ZUGEWIESEN",
    ]);
    await assign(tA.tenant.id, user.id, role.id, {
      scopeType: "PERSONS",
      employeeIds: [tA.employee.id],
    });
    const grants = await effectiveGrants(requestFor(user, employee));
    expect(sorted(grants.zugewiesen)).toEqual([]);
    expect(sorted(grants.eigene)).toEqual(["time-entry:read:EIGENE"]);
  });

  it("a TENANT customer role contributes its ZUGEWIESEN and EIGENE keys", async () => {
    const { user, employee } = await createUser(tA.tenant.id, "EMPLOYEE", "customer");
    const role = await customerRole(tA.tenant.id, "customer", [
      "audit-log:read:ZUGEWIESEN",
      "time-entry:read:EIGENE",
    ]);
    await assign(tA.tenant.id, user.id, role.id, { scopeType: "TENANT" });
    const grants = await effectiveGrants(requestFor(user, employee));
    expect(sorted(grants.zugewiesen)).toEqual(["audit-log:read:ZUGEWIESEN"]);
    expect(sorted(grants.eigene)).toEqual(["time-entry:read:EIGENE"]);
  });

  // ── D-05 (Phase 91b, Issue #91): zugewiesenAnyScope admits PERSON-relation ZUGEWIESEN
  // for a SALONS/PERSONS holder, keeps MANDANT-relation ZUGEWIESEN closed ─────────────

  it("a SALONS-only holder passes hasPermission/requirePermission for a PERSON-relation ZUGEWIESEN key, still fails a MANDANT-relation one", async () => {
    const { user, employee } = await createUser(tA.tenant.id, "EMPLOYEE", "d05-salons");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.MANAGER, {
      scopeType: "SALONS",
      salonIds: [tA.salonId],
    });
    const req = requestFor(user, employee);
    expect(await hasPermission(req, "time-entry:read:ZUGEWIESEN")).toBe(true);

    const req2 = requestFor(user, employee);
    const admitted = fakeReply();
    await requirePermission("time-entry:read:ZUGEWIESEN")(
      req2,
      admitted as unknown as FastifyReply,
    );
    expect(admitted.sent).toBe(false);

    const req3 = requestFor(user, employee);
    const denied = fakeReply();
    await requirePermission("shift-config:manage:ZUGEWIESEN")(
      req3,
      denied as unknown as FastifyReply,
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toEqual({ error: "Forbidden" });
  });

  it("a PERSONS-only holder passes hasPermission for a PERSON-relation ZUGEWIESEN key, still fails a MANDANT-relation one", async () => {
    const { user, employee } = await createUser(tA.tenant.id, "EMPLOYEE", "d05-persons");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.MANAGER, {
      scopeType: "PERSONS",
      employeeIds: [tA.employee.id],
    });
    const req = requestFor(user, employee);
    expect(await hasPermission(req, "time-entry:read:ZUGEWIESEN")).toBe(true);
    const req2 = requestFor(user, employee);
    expect(await hasPermission(req2, "shift-config:manage:ZUGEWIESEN")).toBe(false);
  });

  it("a TENANT holder is unaffected: both PERSON and MANDANT ZUGEWIESEN keys their role grants stay true", async () => {
    const req = requestFor(tA.adminUser, tA.adminEmployee);
    expect(await hasPermission(req, "time-entry:read:ZUGEWIESEN")).toBe(true);
    const req2 = requestFor(tA.adminUser, tA.adminEmployee);
    expect(await hasPermission(req2, "shift-config:manage:ZUGEWIESEN")).toBe(true);
  });

  it("EIGENE keys are unaffected by the relation branch", async () => {
    const { user, employee } = await createUser(tA.tenant.id, "EMPLOYEE", "d05-eigene");
    const req = requestFor(user, employee);
    expect(await hasPermission(req, "time-entry:read:EIGENE")).toBe(true);
  });

  // ── fail closed ──────────────────────────────────────────────────────────────

  it("a malformed stored row (TENANT with salon ids) contributes nothing and suppresses the fallback", async () => {
    const { user, employee } = await createUser(tA.tenant.id, "ADMIN", "malformed");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.ADMIN, {
      scopeType: "TENANT",
      salonIds: [tA.salonId],
    });
    const grants = await effectiveGrants(requestFor(user, employee));
    expect(setsOf(grants)).toEqual({ zugewiesen: [], eigene: [] });
  });

  it("a foreign tenant's customer role contributes nothing (and suppresses the fallback)", async () => {
    const { user, employee } = await createUser(tA.tenant.id, "ADMIN", "foreign-role");
    const foreign = await customerRole(tB.tenant.id, "foreign", [
      "audit-log:read:ZUGEWIESEN",
      "time-entry:read:EIGENE",
    ]);
    await assign(tA.tenant.id, user.id, foreign.id, { scopeType: "TENANT" });
    const grants = await effectiveGrants(requestFor(user, employee));
    expect(setsOf(grants)).toEqual({ zugewiesen: [], eigene: [] });
  });

  it("an assignment in another tenant is ignored and the fallback applies", async () => {
    const { user, employee } = await createUser(tA.tenant.id, "EMPLOYEE", "other-tenant");
    await assign(tB.tenant.id, user.id, SYSTEM_ROLE_IDS.ADMIN, { scopeType: "TENANT" });
    const grants = await effectiveGrants(requestFor(user, employee));
    expect(setsOf(grants)).toEqual(systemSets("EMPLOYEE"));
  });

  it("a deleted user (no User row) holds nothing", async () => {
    const grants = await effectiveGrants(
      fakeRequest(app, {
        sub: "00000000-0000-4000-8000-0000000dead1",
        role: "ADMIN",
        tenantId: tA.tenant.id,
        employeeId: tA.adminEmployee.id,
      }),
    );
    expect(setsOf(grants)).toEqual({ zugewiesen: [], eigene: [] });
  });

  it("a user without Employee (tenant '') falls back to the column's system role", async () => {
    const s = uniqueSuffix("no-emp");
    const user = await app.prisma.user.create({
      data: { email: `rp-${s}@test.de`, passwordHash: "x", role: "MANAGER", isActive: true },
    });
    createdUserIds.push(user.id);
    try {
      const grants = await effectiveGrants(
        fakeRequest(app, { sub: user.id, role: "MANAGER", tenantId: "" }),
      );
      expect(setsOf(grants)).toEqual(systemSets("MANAGER"));
      expect(grants.ownEmployeeId).toBeUndefined();
    } finally {
      await app.prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("a missing system role row makes the resolver throw — never a silent grant or deny", async () => {
    const { user, employee } = await createUser(tA.tenant.id, "MANAGER", "missing-role");
    const server = {
      prisma: {
        user: app.prisma.user,
        accessRole: { findUnique: async () => null },
      },
    };
    const req = fakeRequest(server, {
      sub: user.id,
      role: "MANAGER",
      tenantId: employee.tenantId,
      employeeId: employee.id,
    });
    await expect(effectiveGrants(req)).rejects.toThrow(/system role/i);
    const keyReq = fakeRequest(server, { sub: "apikey:x", role: "ADMIN", tenantId: tA.tenant.id }, [
      "admin",
    ]);
    await expect(effectiveGrants(keyReq)).rejects.toThrow(/system role/i);
  });

  // ── D-11 / D-30 API keys ─────────────────────────────────────────────────────

  it("an API key with scope admin resolves to the full Admin set, ownEmployeeId undefined — even with a MANAGER-shaped role", async () => {
    const req = fakeRequest(
      app,
      { sub: "apikey:rp-admin", role: "EMPLOYEE", tenantId: tA.tenant.id },
      ["read:employees", "admin"],
    );
    const grants = await effectiveGrants(req);
    expect(setsOf(grants)).toEqual(systemSets("ADMIN"));
    expect(grants.ownEmployeeId).toBeUndefined();
  });

  it("any other API key resolves to the full Manager set (EIGENE included), ownEmployeeId undefined", async () => {
    const req = fakeRequest(
      app,
      { sub: "apikey:rp-plain", role: "ADMIN", tenantId: tA.tenant.id },
      ["read:employees"],
    );
    const grants = await effectiveGrants(req);
    expect(setsOf(grants)).toEqual(systemSets("MANAGER"));
    expect(grants.ownEmployeeId).toBeUndefined();
  });

  // ── memo ─────────────────────────────────────────────────────────────────────

  it("two checks on one request cause one resolver query (WeakMap memo); a new request queries again", async () => {
    const { user, employee } = await createUser(tA.tenant.id, "EMPLOYEE", "memo");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.MANAGER, { scopeType: "TENANT" });
    let userQueries = 0;
    const server = {
      prisma: {
        user: {
          findUnique: (args: Parameters<typeof app.prisma.user.findUnique>[0]) => {
            userQueries += 1;
            return app.prisma.user.findUnique(args);
          },
        },
        accessRole: app.prisma.accessRole,
      },
    };
    const claims = {
      sub: user.id,
      role: "EMPLOYEE" as Role,
      tenantId: employee.tenantId,
      employeeId: employee.id,
    };
    const req = fakeRequest(server, claims);
    expect(await hasPermission(req, "time-entry:read:ZUGEWIESEN")).toBe(true);
    expect(await hasPermission(req, "audit-log:read:ZUGEWIESEN")).toBe(false);
    expect(await permissionReach(req, "employee:read")).toBe("ZUGEWIESEN");
    expect(userQueries).toBe(1);
    await hasPermission(fakeRequest(server, claims), "time-entry:read:ZUGEWIESEN");
    expect(userQueries).toBe(2);
  });

  // ── checks ───────────────────────────────────────────────────────────────────

  it("hasPermission answers ZUGEWIESEN keys from the tenant-wide set and EIGENE keys from the own set", async () => {
    const { user, employee } = await createUser(tA.tenant.id, "EMPLOYEE", "has");
    const req = requestFor(user, employee);
    expect(await hasPermission(req, "time-entry:read:EIGENE")).toBe(true);
    expect(await hasPermission(req, "time-entry:read:ZUGEWIESEN")).toBe(false);
  });

  it("permissionReach: ZUGEWIESEN for Manager, EIGENE for Mitarbeiter, null for a role holding neither", async () => {
    const mgr = await createUser(tA.tenant.id, "MANAGER", "reach-m");
    const emp = await createUser(tA.tenant.id, "EMPLOYEE", "reach-e");
    const none = await createUser(tA.tenant.id, "EMPLOYEE", "reach-n");
    const auditOnly = await customerRole(tA.tenant.id, "audit-only", ["audit-log:read:ZUGEWIESEN"]);
    await assign(tA.tenant.id, none.user.id, auditOnly.id, { scopeType: "TENANT" });
    expect(await permissionReach(requestFor(mgr.user, mgr.employee), "employee:read")).toBe(
      "ZUGEWIESEN",
    );
    expect(await permissionReach(requestFor(emp.user, emp.employee), "employee:read")).toBe(
      "EIGENE",
    );
    expect(await permissionReach(requestFor(none.user, none.employee), "employee:read")).toBeNull();
  });

  it("an unknown catalog key throws — at call time for checks, at creation for guards", async () => {
    const req = requestFor(tA.adminUser, tA.adminEmployee);
    await expect(hasPermission(req, "audit-log:fly:ZUGEWIESEN" as PermissionKey)).rejects.toThrow(
      /unknown permission/i,
    );
    await expect(permissionReach(req, "employee:fly")).rejects.toThrow(/unknown permission/i);
    expect(() => requirePermission("audit-log:fly:ZUGEWIESEN" as PermissionKey)).toThrow(
      /unknown permission/i,
    );
    expect(() =>
      requireAnyPermission("audit-log:read:ZUGEWIESEN", "audit-log:fly:EIGENE" as PermissionKey),
    ).toThrow(/unknown permission/i);
    expect(() => requireAnyPermission()).toThrow(/at least one/i);
  });

  // ── guards ───────────────────────────────────────────────────────────────────

  it("requireAnyPermission admits a caller holding any of its keys and answers 403 Forbidden otherwise", async () => {
    const { user, employee } = await createUser(tA.tenant.id, "EMPLOYEE", "any");
    const admitted = fakeReply();
    await requireAnyPermission("audit-log:read:ZUGEWIESEN", "time-entry:read:EIGENE")(
      requestFor(user, employee),
      admitted as unknown as FastifyReply,
    );
    expect(admitted.sent).toBe(false);

    const denied = fakeReply();
    await requireAnyPermission("audit-log:read:ZUGEWIESEN", "time-entry:read:ZUGEWIESEN")(
      requestFor(user, employee),
      denied as unknown as FastifyReply,
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toEqual({ error: "Forbidden" });
  });

  describe("GET /api/v1/audit-logs asks for audit-log:read:ZUGEWIESEN (AC-75-11)", () => {
    it("no token → 401 with the byte-identical body", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/audit-logs" });
      expect(res.statusCode).toBe(401);
      expect(res.body).toBe('{"error":"Unauthorized"}');
    });

    it('EMPLOYEE → 403 with exactly {"error":"Forbidden"}, on both routes', async () => {
      for (const url of ["/api/v1/audit-logs", "/api/v1/audit-logs/some-id"]) {
        const res = await app.inject({
          method: "GET",
          url,
          headers: { authorization: `Bearer ${tA.empToken}` },
        });
        expect(res.statusCode, url).toBe(403);
        expect(res.body, url).toBe('{"error":"Forbidden"}');
      }
    });

    it("MANAGER → 403", async () => {
      const { email } = await createUser(tA.tenant.id, "MANAGER", "http-m");
      const token = await loginToken(email);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/audit-logs",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('{"error":"Forbidden"}');
    });

    it("ADMIN → 200", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/audit-logs",
        headers: { authorization: `Bearer ${tA.adminToken}` },
      });
      expect(res.statusCode, res.body).toBe(200);
    });

    it("API key with admin scope → 200; plain API key → 403", async () => {
      const adminKey = await createApiKey(tA.tenant.id, tA.adminUser.id, ["admin"]);
      const plainKey = await createApiKey(tA.tenant.id, tA.adminUser.id, ["read:employees"]);
      const ok = await app.inject({
        method: "GET",
        url: "/api/v1/audit-logs",
        headers: { authorization: `Bearer ${adminKey.raw}` },
      });
      expect(ok.statusCode, ok.body).toBe(200);
      const denied = await app.inject({
        method: "GET",
        url: "/api/v1/audit-logs",
        headers: { authorization: `Bearer ${plainKey.raw}` },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.body).toBe('{"error":"Forbidden"}');
    });
  });
});
