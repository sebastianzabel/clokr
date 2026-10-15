/**
 * Phase 88 plan 08 (D-02a, T-88-39) — without OPERATOR_JWT_SECRET the operator surface does not exist:
 * its routes answer 404, the tenant side is unchanged and a missing second JWT registration breaks nothing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

describe("operator surface off (OPERATOR_JWT_SECRET unset)", () => {
  const original = process.env.OPERATOR_JWT_SECRET;
  let app: FastifyInstance;

  beforeAll(async () => {
    delete process.env.OPERATOR_JWT_SECRET;
    vi.resetModules();
    const { buildApp } = await import("../app");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (original === undefined) delete process.env.OPERATOR_JWT_SECRET;
    else process.env.OPERATOR_JWT_SECRET = original;
    vi.resetModules();
  });

  it("does not register the operator auth routes", async () => {
    for (const [method, url] of [
      ["POST", "/api/v1/operator/auth/login"],
      ["POST", "/api/v1/operator/auth/verify"],
      ["GET", "/api/v1/operator/auth/me"],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === "POST" ? {} : undefined });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it("does not register the operator dashboard route (Issue #90)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/operator/dashboard" });
    expect(res.statusCode).toBe(404);
  });

  it("does not register the operator support routes (Issue #93)", async () => {
    const tenantId = randomUUID();
    const grant = await app.inject({
      method: "POST",
      url: `/api/v1/operator/tenants/${tenantId}/support-access`,
      payload: { reason: "Support ticket: surface off" },
    });
    expect(grant.statusCode).toBe(404);
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/operator/tenants/${tenantId}/support/employees`,
    });
    expect(read.statusCode).toBe(404);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/operator/tenants/${tenantId}/support-access`,
    });
    expect(list.statusCode).toBe(404);
    const end = await app.inject({
      method: "POST",
      url: `/api/v1/operator/tenants/${tenantId}/support-access/${randomUUID()}/end`,
    });
    expect(end.statusCode).toBe(404);
    const month = await app.inject({
      method: "GET",
      url: `/api/v1/operator/tenants/${tenantId}/support/employees/${randomUUID()}/month?month=2026-03`,
    });
    expect(month.statusCode).toBe(404);
    const contracts = await app.inject({
      method: "GET",
      url: `/api/v1/operator/tenants/${tenantId}/support/employees/${randomUUID()}/contracts`,
    });
    expect(contracts.statusCode).toBe(404);
    const auditLog = await app.inject({
      method: "GET",
      url: `/api/v1/operator/tenants/${tenantId}/support/audit-log?from=2026-03-01&to=2026-03-10`,
    });
    expect(auditLog.statusCode).toBe(404);
  });

  it("keeps the tenant's support-access routes registered: 401 without a token, never 404 (Issue #93)", async () => {
    for (const [method, url] of [
      ["GET", "/api/v1/support-accesses"],
      ["GET", `/api/v1/support-accesses/${randomUUID()}`],
      ["POST", `/api/v1/support-accesses/${randomUUID()}/end`],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("keeps the tenant routes working and requireAuth answers 401, not a crash", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nobody@example.invalid", password: "wrong-password-1" },
    });
    expect(login.statusCode).toBe(401);
    const protectedRoute = await app.inject({ method: "GET", url: "/api/v1/employees" });
    expect(protectedRoute.statusCode).toBe(401);
    expect(app.jwt.operator).toBeUndefined();
  });
});
