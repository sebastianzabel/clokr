/**
 * Issue #557 (D-01..D-06) — an operator MFA reset (and a deactivation) ends every operator token that was
 * already issued for the account, at once.
 *
 * The mechanism under test: `OperatorAccount.tokenVersion` is carried as the claim `ver` in every operator
 * token. `requireOperator` compares it on every request and `/verify` compares it for the pending
 * second-factor challenge, both through `operatorTokenIsCurrent()`. A reset or a deactivation increments the
 * version in the same transaction that writes its audit row.
 *
 * Every refusal is paired with a positive control (the same token or code was valid just before), so a red
 * "401" can never be a token that was broken for another reason.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TOTP, Secret } from "otpauth";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedOperator, type SeededOperator } from "./setup";
import { resetOperatorMfa } from "../contexts/platform/operator-credentials";

let app: FastifyInstance;
let addressCounter = 0;

const ACTOR = { type: "SCRIPT", user: "vitest", host: "test" } as const;

/** Every request carries its own remote address so the per-route rate limits never interfere. */
function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.157.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

function post(url: string, payload: unknown) {
  return app.inject({
    method: "POST",
    url,
    payload: payload as object,
    headers: { "user-agent": "vitest-operator" },
    remoteAddress: uniqueAddress(),
  });
}

function get(url: string, token: string) {
  return app.inject({
    method: "GET",
    url,
    headers: { "user-agent": "vitest-operator", authorization: `Bearer ${token}` },
    remoteAddress: uniqueAddress(),
  });
}

function decodedVer(token: string): unknown {
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as {
    ver?: unknown;
  };
  return payload.ver;
}

async function loginChallenge(email: string, password: string): Promise<string> {
  const res = await post("/api/v1/operator/auth/login", { email, password });
  expect(res.statusCode, res.body).toBe(200);
  return (JSON.parse(res.body) as { challengeToken: string }).challengeToken;
}

async function verify(challengeToken: string, code: string) {
  return post("/api/v1/operator/auth/verify", { challengeToken, code });
}

async function signIn(op: { email: string; password: string }, code: string): Promise<string> {
  const challenge = await loginChallenge(op.email, op.password);
  const res = await verify(challenge, code);
  expect(res.statusCode, res.body).toBe(200);
  return (JSON.parse(res.body) as { accessToken: string }).accessToken;
}

/** The same TOTP construction as `seedOperator()`, for the secret an MFA reset just issued. */
function totpFromSecret(secretBase32: string): (stepOffset?: number) => string {
  const totp = new TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
  return (stepOffset = 0) => totp.generate({ timestamp: Date.now() + stepOffset * 30_000 });
}

async function reset(op: SeededOperator) {
  const result = await resetOperatorMfa(app.prisma, { email: op.email, actor: ACTOR });
  if (result.status !== "OK") throw new Error(`resetOperatorMfa: ${result.status}`);
  return result;
}

async function storedVersion(id: string): Promise<number> {
  const row = await app.prisma.operatorAccount.findUniqueOrThrow({
    where: { id },
    select: { tokenVersion: true },
  });
  return row.tokenVersion;
}

beforeAll(async () => {
  app = await getTestApp();
});

afterAll(async () => {
  await closeTestApp();
});

describe("MFA reset ends the issued access token (tracer)", () => {
  it("401s the same token on /me and /tenants after the reset, and a fresh sign-in carries the new ver", async () => {
    const op = await seedOperator(app);
    const token = await signIn(op, op.totpFor(0));
    expect(decodedVer(token)).toBe(0);

    // Control: right before the reset the token is good on two different operator routes.
    expect((await get("/api/v1/operator/auth/me", token)).statusCode).toBe(200);
    expect((await get("/api/v1/operator/tenants", token)).statusCode).toBe(200);

    const result = await reset(op);

    for (const url of ["/api/v1/operator/auth/me", "/api/v1/operator/tenants"]) {
      const res = await get(url, token);
      expect(res.statusCode, url).toBe(401);
      expect(JSON.parse(res.body), url).toEqual({ error: "Unauthorized" });
    }
    expect(await storedVersion(op.id)).toBe(1);

    const rows = await app.prisma.operatorAuditLog.findMany({
      where: { action: "OPERATOR_MFA_RESET", entityId: op.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].newValue).toMatchObject({ sessionsRevoked: true, tokenVersion: 1 });
    expect(rows[0].oldValue).toMatchObject({ tokenVersion: 0 });
    expect(JSON.stringify(rows[0])).not.toContain(result.enrollment.secretBase32);

    const newTotp = totpFromSecret(result.enrollment.secretBase32);
    const fresh = await signIn(op, newTotp(0));
    expect(decodedVer(fresh)).toBe(1);
    expect((await get("/api/v1/operator/auth/me", fresh)).statusCode).toBe(200);
  });
});
