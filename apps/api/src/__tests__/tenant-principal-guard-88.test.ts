/**
 * Phase 88 plan 09 (AC-88-03, AC-88-08, D-02, D-05, D-05a) — the tenant guard `requireAuth` never hands
 * an operator tenant data, and cuts off a deactivated tenant on every credential type it owns.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  seedOperator,
  cleanupTestData,
  reissueTokenNow,
  type SeededOperator,
} from "./setup";
import { signOperatorToken } from "../contexts/platform/operator-auth";
import { deactivateTenant, reactivateTenant } from "../contexts/platform/tenant-status";
import { TENANT_STATUS_CACHE_TTL_MS } from "../contexts/platform/plugins/tenant-status";

let app: FastifyInstance;
let data: Awaited<ReturnType<typeof seedTestData>>;
let operator: SeededOperator;
let addressCounter = 0;

/** Every request carries its own remote address so the per-route rate limits never interfere. */
function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.89.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

function get(url: string, token?: string) {
  return app.inject({
    method: "GET",
    url,
    headers: {
      "user-agent": "vitest-guard",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    remoteAddress: uniqueAddress(),
  });
}

const request = { ip: "203.0.113.9", headers: { "user-agent": "vitest-guard" } };

async function deactivate() {
  const result = await app.prisma.$transaction((tx) =>
    deactivateTenant(tx, data.tenant.id, {
      operatorId: operator.id,
      reason: "Vertrag beendet",
      request,
    }),
  );
  expect(result.status).toBe("OK");
}

async function reactivate() {
  const result = await app.prisma.$transaction((tx) =>
    reactivateTenant(tx, data.tenant.id, { operatorId: operator.id, request }),
  );
  expect(result.status).toBe("OK");
}

async function refusalRows(sub: string, route: string) {
  const rows = await app.prisma.operatorAuditLog.findMany({
    where: { action: "OPERATOR_PRINCIPAL_REFUSED", entityId: route },
    orderBy: { createdAt: "asc" },
  });
  return rows.filter((row) => JSON.stringify(row.newValue).includes(sub));
}

/** A signed operator access token via the operator signer (a real one, as login would hand out). */
function operatorAccessToken(op: SeededOperator): string {
  return signOperatorToken(app, op.id, "access", op.tokenVersion);
}

beforeAll(async () => {
  app = await getTestApp();
  data = await seedTestData(app);
  operator = await seedOperator(app);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  const row = await app.prisma.tenant.findUnique({
    where: { id: data.tenant.id },
    select: { deactivatedAt: true },
  });
  if (row?.deactivatedAt) await reactivate();
  app.invalidateTenantState(data.tenant.id);
});

afterAll(async () => {
  await cleanupTestData(app, data.tenant.id);
  await closeTestApp();
});

describe("operator tokens on tenant routes", () => {
  it("refuses an operator access token with 403 and audits the route", async () => {
    const own = await seedOperator(app);
    const token = operatorAccessToken(own);

    const res = await get("/api/v1/employees", token);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });

    const rows = await refusalRows(own.id, "/api/v1/employees");
    expect(rows).toHaveLength(1);
    expect(rows[0].operatorId).toBe(own.id);

    const me = await get("/api/v1/me/context", token);
    expect(me.statusCode).toBe(403);
    expect(await refusalRows(own.id, "/api/v1/me/context")).toHaveLength(1);
  });

  it("refuses an operator-shaped payload that was signed with the TENANT secret", async () => {
    const forgedSub = `forged-${randomBytes(6).toString("hex")}`;
    const token = app.jwt.sign({
      sub: forgedSub,
      kind: "operator",
      aud: "clokr-operator",
      typ: "access",
      tenantId: data.tenant.id,
    } as never);

    const res = await get("/api/v1/employees", token);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(data.employee.lastName);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });

    const rows = await refusalRows(forgedSub, "/api/v1/employees");
    expect(rows).toHaveLength(1);
    // An unverified claim is never written into the operatorId foreign key.
    expect(rows[0].operatorId).toBeNull();
    expect(rows[0].subjectTenantId).toBe(data.tenant.id);
  });

  it("refuses a payload that carries only the operator audience", async () => {
    const token = app.jwt.sign({
      sub: data.adminUser.id,
      aud: "clokr-operator",
      tenantId: data.tenant.id,
    } as never);
    const res = await get("/api/v1/employees", token);
    expect(res.statusCode).toBe(403);
  });

  it("bounds the audit of 50 refused calls to one row", async () => {
    const own = await seedOperator(app);
    const token = operatorAccessToken(own);

    for (let i = 0; i < 50; i += 1) {
      const res = await get("/api/v1/employees", token);
      expect(res.statusCode).toBe(403);
    }

    const rows = await refusalRows(own.id, "/api/v1/employees");
    expect(rows.length).toBeLessThanOrEqual(1);
    expect(rows).toHaveLength(1);
  });

  it("keeps the 401 body for a token that verifies with neither secret", async () => {
    const res = await get("/api/v1/employees", "not-a-token");
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Unauthorized" });
  });
});

describe("deactivated tenants", () => {
  it("refuses an access token issued before the deactivation, and serves it again after reactivation", async () => {
    const before = await get("/api/v1/employees", data.adminToken);
    expect(before.statusCode).toBe(200);

    await deactivate();
    app.invalidateTenantState(data.tenant.id);

    const refused = await get("/api/v1/employees", data.adminToken);
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body)).toEqual(app.tenantDeactivatedError);
    expect(JSON.parse(refused.body).code).toBe("TENANT_DEACTIVATED");

    await reactivate();
    app.invalidateTenantState(data.tenant.id);

    const after = await get("/api/v1/employees", data.adminToken);
    expect(after.statusCode).toBe(200);
  });

  it("refuses an API key of a deactivated tenant", async () => {
    const rawKey = `clk_${randomBytes(24).toString("hex")}`;
    await app.prisma.apiKey.create({
      data: {
        tenantId: data.tenant.id,
        name: "guard-88",
        keyHash: createHash("sha256").update(rawKey).digest("hex"),
        keyPrefix: rawKey.slice(0, 8),
        scopes: ["admin"],
        createdBy: data.adminUser.id,
      },
    });
    try {
      expect((await get("/api/v1/employees", rawKey)).statusCode).toBe(200);

      await deactivate();
      app.invalidateTenantState(data.tenant.id);

      const refused = await get("/api/v1/employees", rawKey);
      expect(refused.statusCode).toBe(403);
      expect(JSON.parse(refused.body).code).toBe("TENANT_DEACTIVATED");
    } finally {
      await reactivate().catch(() => undefined);
      await app.prisma.apiKey.deleteMany({
        where: { keyHash: createHash("sha256").update(rawKey).digest("hex") },
      });
    }
  });

  it("serves a stale answer within the cache bound without invalidation, and refuses after it", async () => {
    // Prime the cache with "active".
    expect((await get("/api/v1/employees", data.adminToken)).statusCode).toBe(200);

    await deactivate();

    const stale = await get("/api/v1/employees", data.adminToken);
    expect(stale.statusCode).toBe(200);

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + TENANT_STATUS_CACHE_TTL_MS + 1_000 });
    const token = reissueTokenNow(app, data.adminToken);
    const refused = await get("/api/v1/employees", token);
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body).code).toBe("TENANT_DEACTIVATED");
  });

  it("looks the tenant up once per cache window, not once per request", async () => {
    app.invalidateTenantState(data.tenant.id);
    const spy = vi.spyOn(app.prisma.tenant, "findUnique");
    for (let i = 0; i < 5; i += 1) {
      expect((await get("/api/v1/employees", data.adminToken)).statusCode).toBe(200);
    }
    const lookups = spy.mock.calls.filter(
      ([args]) =>
        (args as { where?: { id?: string }; select?: Record<string, unknown> }).where?.id ===
          data.tenant.id &&
        JSON.stringify((args as { select?: unknown }).select) ===
          JSON.stringify({ deactivatedAt: true }),
    );
    expect(lookups).toHaveLength(1);
  });

  it("never looks up a blank tenant id", async () => {
    const spy = vi.spyOn(app.prisma.tenant, "findUnique");
    expect(await app.tenantIsActive("")).toBe(true);
    expect(await app.tenantIsActive("   ")).toBe(true);
    expect(await app.tenantIsActive(undefined)).toBe(true);
    expect(await app.tenantIsActive(null)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("counts an unknown tenant as active", async () => {
    expect(await app.tenantIsActive("00000000-0000-4000-8000-000000000000")).toBe(true);
  });
});
