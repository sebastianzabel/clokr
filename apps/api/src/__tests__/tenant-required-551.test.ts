/**
 * Issue #551 — a tenant principal without a tenant is refused in ONE place, before any permission.
 *
 * A User without an Employee (the legacy admin) carries `tenantId: ""`. Measured in 88-13: such a
 * token passed `requirePermission` through the legacy-role fallback, 40 routes answered 200 and 35
 * answered 500 and reached the database. Since #551:
 *
 * - `requireAuth` answers 403 `{ error, code: "TENANT_REQUIRED" }` for a verified token whose tenant
 *   id is blank, whitespace-only, absent or not a string — before any permission check and before
 *   any query (D-01),
 * - no credential path signs such a token (D-02, second describe),
 * - the permission resolver grants a blank tenant nothing (D-03),
 * - the blank rule lives once, in `isBlankTenantId()` (D-04).
 *
 * The "no query" claims are only meaningful next to a control that proves the same spies DO see a
 * query on the happy path; each describe carries one.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { JwtPayload } from "../middleware/auth";
import { isBlankTenantId, TENANT_REQUIRED_ERROR } from "../contexts/platform/tenant-status";
import {
  effectiveGrants,
  effectivePermissionKeysForUser,
} from "../contexts/platform/request-permissions";

let app: FastifyInstance;
let data: Awaited<ReturnType<typeof seedTestData>>;
let bareUser: { id: string; email: string };
let addressCounter = 0;

const PASSWORD = "test1234";

/** Every request carries its own remote address so the fixed per-route rate limits never interfere. */
function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.55.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

function signToken(payload: Record<string, unknown>): string {
  return app.jwt.sign(payload as unknown as JwtPayload);
}

function get(url: string, token: string) {
  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: uniqueAddress(),
  });
}

function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url,
    payload: payload as object,
    headers,
    remoteAddress: uniqueAddress(),
  });
}

function spyOnAccessQueries() {
  return {
    userFindUnique: vi.spyOn(app.prisma.user, "findUnique"),
    accessRoleFindUnique: vi.spyOn(app.prisma.accessRole, "findUnique"),
    tenantFindUnique: vi.spyOn(app.prisma.tenant, "findUnique"),
  };
}

async function createApiKey(tenantId: string, createdBy: string, scopes: string[]) {
  const raw = `clk_${randomBytes(24).toString("hex")}`;
  await app.prisma.apiKey.create({
    data: {
      tenantId,
      name: `tenant-required-551-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      keyHash: createHash("sha256").update(raw).digest("hex"),
      keyPrefix: raw.slice(0, 8),
      scopes,
      createdBy,
    },
  });
  return raw;
}

beforeAll(async () => {
  app = await getTestApp();
  data = await seedTestData(app, "tr551");
  const email = `bare-551-${Date.now().toString(36)}@test.local`;
  const created = await app.prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      role: "ADMIN",
      isActive: true,
    },
  });
  bareUser = { id: created.id, email };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  try {
    await app.prisma.auditLog.deleteMany({ where: { userId: bareUser.id } });
    await app.prisma.auditLog.deleteMany({ where: { entityId: bareUser.id } });
    await app.prisma.refreshToken.deleteMany({ where: { userId: bareUser.id } });
    await app.prisma.otpToken.deleteMany({ where: { userId: bareUser.id } });
    await app.prisma.user.delete({ where: { id: bareUser.id } });
    await cleanupTestData(app, data.tenant.id);
  } catch (err) {
    console.error("Test cleanup failed:", err);
  }
  await closeTestApp();
});

describe("isBlankTenantId — the one blank-tenant rule (D-04)", () => {
  it.each([
    ["empty string", ""],
    ["spaces", "   "],
    ["tab and newline", "\t\n "],
    ["undefined", undefined],
    ["null", null],
    ["zero", 0],
    ["a number", 42],
    ["an object", {}],
    ["an array", []],
  ])("is true for %s", (_name, value) => {
    expect(isBlankTenantId(value)).toBe(true);
  });

  it.each([
    ["a short id", "t"],
    ["an id with surrounding spaces", " t "],
    ["a uuid", "3f2b8f0e-6c3a-4a53-9a4e-0f9d8c7b6a51"],
  ])("is false for %s", (_name, value) => {
    expect(isBlankTenantId(value)).toBe(false);
  });
});

describe("requireAuth refuses a tenant token without a tenant (D-01)", () => {
  const blankCases: Array<{ name: string; claims: Record<string, unknown> }> = [
    { name: "empty tenantId", claims: { tenantId: "" } },
    { name: "whitespace-only tenantId", claims: { tenantId: "   " } },
    { name: "tenantId key absent", claims: {} },
    { name: "numeric tenantId", claims: { tenantId: 42 } },
  ];
  const routes = [
    { name: "requireAuth only", url: "/api/v1/me/context" },
    { name: "requirePermission", url: "/api/v1/audit-logs" },
  ];

  for (const route of routes) {
    for (const { name, claims } of blankCases) {
      it(`answers 403 TENANT_REQUIRED without any query on ${route.name} (${name})`, async () => {
        const token = signToken({ sub: bareUser.id, role: "ADMIN", ...claims });
        const spies = spyOnAccessQueries();

        const res = await get(route.url, token);

        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body)).toEqual(TENANT_REQUIRED_ERROR);
        expect(spies.userFindUnique).not.toHaveBeenCalled();
        expect(spies.accessRoleFindUnique).not.toHaveBeenCalled();
        expect(spies.tenantFindUnique).not.toHaveBeenCalled();
      });
    }
  }

  it("control: a real admin token on the same permission route answers 200 and the spies see queries", async () => {
    const spies = spyOnAccessQueries();

    const res = await get("/api/v1/audit-logs", data.adminToken);

    expect(res.statusCode).toBe(200);
    expect(spies.userFindUnique).toHaveBeenCalled();
  });

  it("the refusal body is exactly the shared constant (code is the control value)", () => {
    expect(TENANT_REQUIRED_ERROR.code).toBe("TENANT_REQUIRED");
    expect(typeof TENANT_REQUIRED_ERROR.error).toBe("string");
  });
});

describe("an API key with a blank stored tenant is refused too (defence in depth)", () => {
  it("answers 403 TENANT_REQUIRED and never writes lastUsedAt", async () => {
    const raw = `clk_${randomBytes(24).toString("hex")}`;
    const findUnique = vi.spyOn(app.prisma.apiKey, "findUnique").mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000551",
      tenantId: "",
      name: "blank-tenant-key",
      keyHash: createHash("sha256").update(raw).digest("hex"),
      keyPrefix: raw.slice(0, 8),
      scopes: ["admin"],
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      createdBy: bareUser.id,
      createdAt: new Date(),
    } as never);
    const update = vi.spyOn(app.prisma.apiKey, "update");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/audit-logs",
      headers: { authorization: `Bearer ${raw}` },
      remoteAddress: uniqueAddress(),
    });

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual(TENANT_REQUIRED_ERROR);
    expect(update).not.toHaveBeenCalled();
  });

  it("control: a real key of the fixture tenant is served and writes lastUsedAt", async () => {
    const raw = await createApiKey(data.tenant.id, data.adminUser.id, ["admin"]);
    const update = vi.spyOn(app.prisma.apiKey, "update");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/audit-logs",
      headers: { authorization: `Bearer ${raw}` },
      remoteAddress: uniqueAddress(),
    });

    expect(res.statusCode).toBe(200);
    expect(update).toHaveBeenCalled();
  });
});

describe("the resolver grants a blank tenant nothing (D-03)", () => {
  function fakeRequest(overrides: Record<string, unknown>): FastifyRequest {
    return {
      server: app,
      user: { sub: bareUser.id, role: "ADMIN", tenantId: "" },
      ...overrides,
    } as unknown as FastifyRequest;
  }

  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
  ])(
    "effectiveGrants of a real bare user with a %s tenant is empty, with no fallback",
    async (_n, tenantId) => {
      const grants = await effectiveGrants(
        fakeRequest({ user: { sub: bareUser.id, role: "ADMIN", tenantId } }),
      );

      expect(grants.zugewiesen.size).toBe(0);
      expect(grants.zugewiesenAnyScope.size).toBe(0);
      expect(grants.eigene.size).toBe(0);
      expect(grants.ownEmployeeId).toBeUndefined();
    },
  );

  it("effectiveGrants issues no query for a blank tenant", async () => {
    const spies = spyOnAccessQueries();

    await effectiveGrants(fakeRequest({}));

    expect(spies.userFindUnique).not.toHaveBeenCalled();
    expect(spies.accessRoleFindUnique).not.toHaveBeenCalled();
  });

  it("an API-key request with a blank tenant holds nothing either", async () => {
    const grants = await effectiveGrants(
      fakeRequest({
        user: { sub: "apikey:x", role: "ADMIN", tenantId: "" },
        apiKeyScopes: ["admin"],
      }),
    );

    expect(grants.zugewiesen.size).toBe(0);
    expect(grants.zugewiesenAnyScope.size).toBe(0);
    expect(grants.eigene.size).toBe(0);
  });

  it("effectivePermissionKeysForUser returns [] for a blank tenant", async () => {
    expect(await effectivePermissionKeysForUser(app.prisma, bareUser.id, "")).toEqual([]);
    expect(await effectivePermissionKeysForUser(app.prisma, bareUser.id, "  ")).toEqual([]);
  });

  it("control: the same user with a real tenant id still resolves through the query", async () => {
    const spies = spyOnAccessQueries();

    await effectivePermissionKeysForUser(app.prisma, data.adminUser.id, data.tenant.id);

    expect(spies.userFindUnique).toHaveBeenCalled();
  });
});
