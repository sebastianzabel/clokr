/**
 * Phase 88 plan 08 (AC-88-01/02/09/10, D-02/D-02a/D-03/D-03a/D-07/D-09) — the operator signs in with a
 * password and a second factor, and is a principal the tenant code never sees.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  seedOperator,
  cleanupTestData,
  type SeededOperator,
} from "./setup";

let app: FastifyInstance;
let data: Awaited<ReturnType<typeof seedTestData>>;
let addressCounter = 0;

/** Every request carries its own remote address so the per-route rate limits never interfere. */
function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.88.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url,
    payload: payload as object,
    headers: { "user-agent": "vitest-operator", ...headers },
    remoteAddress: uniqueAddress(),
  });
}

function get(url: string, token?: string) {
  return app.inject({
    method: "GET",
    url,
    headers: {
      "user-agent": "vitest-operator",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    remoteAddress: uniqueAddress(),
  });
}

async function login(operator: SeededOperator, password = operator.password) {
  return post("/api/v1/operator/auth/login", { email: operator.email, password });
}

/** Full two-step sign-in; returns the access token. `stepOffset` keeps repeated sign-ins replay-free. */
async function signIn(operator: SeededOperator, stepOffset = 0): Promise<string> {
  const first = await login(operator);
  expect(first.statusCode).toBe(200);
  const { challengeToken } = JSON.parse(first.body);
  const second = await post("/api/v1/operator/auth/verify", {
    challengeToken,
    code: operator.totpFor(stepOffset),
  });
  expect(second.statusCode).toBe(200);
  return JSON.parse(second.body).accessToken;
}

beforeAll(async () => {
  app = await getTestApp();
  data = await seedTestData(app);
});

afterAll(async () => {
  await cleanupTestData(app, data.tenant.id);
  await closeTestApp();
});

describe("operator sign-in tracer", () => {
  it("login -> verify with a TOTP code -> me, and writes an OPERATOR_LOGIN row with IP and user agent", async () => {
    const operator = await seedOperator(app, { displayName: "Tracer Operator" });

    const first = await login(operator);
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);
    expect(typeof firstBody.challengeToken).toBe("string");
    expect(firstBody.expiresIn).toBe(300);

    const second = await post("/api/v1/operator/auth/verify", {
      challengeToken: firstBody.challengeToken,
      code: operator.totpFor(0),
    });
    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.body);
    expect(secondBody.expiresIn).toBe(900);

    const decoded = app.jwt.operator!.decode(secondBody.accessToken) as Record<string, unknown>;
    expect(decoded.kind).toBe("operator");
    expect(decoded.typ).toBe("access");
    expect(decoded.sub).toBe(operator.id);

    const me = await get("/api/v1/operator/auth/me", secondBody.accessToken);
    expect(me.statusCode).toBe(200);
    const meBody = JSON.parse(me.body);
    expect(meBody.id).toBe(operator.id);
    expect(meBody.email).toBe(operator.email);
    expect(meBody.displayName).toBe("Tracer Operator");
    expect(meBody.lastLoginAt).toBeTruthy();
    expect(Object.keys(meBody).sort()).toEqual(["displayName", "email", "id", "lastLoginAt"]);

    const rows = await app.prisma.operatorAuditLog.findMany({
      where: { operatorId: operator.id, action: "OPERATOR_LOGIN" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].ipAddress).toBeTruthy();
    expect(rows[0].userAgent).toBe("vitest-operator");
  });

  it("answers 401 without a token", async () => {
    const res = await get("/api/v1/operator/auth/me");
    expect(res.statusCode).toBe(401);
  });

  it("refuses a tenant admin token with 403 and writes one TENANT_PRINCIPAL_REFUSED row", async () => {
    const res = await get("/api/v1/operator/auth/me", data.adminToken);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });

    const rows = await app.prisma.operatorAuditLog.findMany({
      where: { action: "TENANT_PRINCIPAL_REFUSED", subjectTenantId: data.tenant.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].operatorId).toBeNull();
    expect(JSON.stringify(rows[0].newValue)).toContain(data.adminUser.id);
  });

  it("does not accept an operator access token on a tenant route", async () => {
    const operator = await seedOperator(app);
    const token = await signIn(operator);
    const res = await get("/api/v1/employees", token);
    expect(res.statusCode).toBe(401);
  });
});
