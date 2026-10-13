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
import {
  deactivateOperatorAccount,
  resetOperatorMfa,
} from "../contexts/platform/operator-credentials";
import {
  isOperatorPayload,
  operatorTokenIsCurrent,
  signOperatorToken,
} from "../contexts/platform/operator-auth";

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

describe("a pending challenge dies with the reset", () => {
  it("refuses a stale challenge even with a valid code of the new secret, without counting a failure", async () => {
    const op = await seedOperator(app);
    const staleChallenge = await loginChallenge(op.email, op.password);
    const result = await reset(op);
    const newTotp = totpFromSecret(result.enrollment.secretBase32);

    const res = await verify(staleChallenge, newTotp(0));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Anmeldung fehlgeschlagen" });

    const rows = await app.prisma.operatorAuditLog.findMany({
      where: { action: "OPERATOR_MFA_FAILED", entityId: op.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].newValue).toMatchObject({ reason: "STALE_CHALLENGE" });
    const account = await app.prisma.operatorAccount.findUniqueOrThrow({ where: { id: op.id } });
    expect(account.failedLoginAttempts).toBe(0);
    expect(account.lastTotpStep).toBeNull();

    // Control: the SAME code is accepted on a fresh challenge, so the refusal came from the version.
    const fresh = await loginChallenge(op.email, op.password);
    const ok = await verify(fresh, newTotp(0));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(decodedVer((JSON.parse(ok.body) as { accessToken: string }).accessToken)).toBe(1);
  });
});

describe("deactivation revokes every issued token", () => {
  it("increments the version, 401s the issued token and audits old/new version", async () => {
    const op = await seedOperator(app);
    const token = await signIn(op, op.totpFor(0));
    expect((await get("/api/v1/operator/auth/me", token)).statusCode).toBe(200);

    expect(await deactivateOperatorAccount(app.prisma, { email: op.email, actor: ACTOR })).toEqual({
      status: "OK",
    });

    const res = await get("/api/v1/operator/auth/me", token);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Unauthorized" });
    expect(await storedVersion(op.id)).toBe(1);

    const rows = await app.prisma.operatorAuditLog.findMany({
      where: { action: "OPERATOR_DEACTIVATED", entityId: op.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].oldValue).toEqual({ isActive: true, tokenVersion: 0 });
    expect(rows[0].newValue).toMatchObject({
      isActive: false,
      sessionsRevoked: true,
      tokenVersion: 1,
    });
  });
});

describe("claim shapes", () => {
  function handSigned(sub: string, typ: "access" | "mfa-challenge", ver?: unknown): string {
    const payload: Record<string, unknown> = {
      sub,
      kind: "operator",
      aud: "clokr-operator",
      typ,
    };
    if (ver !== undefined) payload.ver = ver;
    return app.jwt.operator!.sign(payload as never, { expiresIn: "5m" });
  }

  it("accepts a hand-signed access token with the correct ver and refuses every other shape at the guard", async () => {
    const op = await seedOperator(app);
    expect(op.tokenVersion).toBe(0);
    expect(
      (await get("/api/v1/operator/auth/me", handSigned(op.id, "access", 0))).statusCode,
      "control",
    ).toBe(200);

    const shapes: Array<[string, unknown]> = [
      ["missing", undefined],
      ["string", "0"],
      ["fraction", 0.5],
      ["null", null],
      ["higher", 1],
    ];
    for (const [name, ver] of shapes) {
      const res = await get("/api/v1/operator/auth/me", handSigned(op.id, "access", ver));
      expect(res.statusCode, name).toBe(401);
      expect(JSON.parse(res.body), name).toEqual({ error: "Unauthorized" });
    }
  });

  it("refuses a lower ver once the stored version has moved on", async () => {
    const op = await seedOperator(app);
    await reset(op);
    expect(await storedVersion(op.id)).toBe(1);
    expect(
      (await get("/api/v1/operator/auth/me", handSigned(op.id, "access", 0))).statusCode,
      "lower",
    ).toBe(401);
    expect(
      (await get("/api/v1/operator/auth/me", handSigned(op.id, "access", 1))).statusCode,
      "control",
    ).toBe(200);
  });

  it("refuses a challenge without ver at /verify, and accepts the control with the same code", async () => {
    const op = await seedOperator(app);
    const code = op.totpFor(0);
    const noVer = await verify(handSigned(op.id, "mfa-challenge"), code);
    expect(noVer.statusCode).toBe(401);
    const control = await verify(handSigned(op.id, "mfa-challenge", 0), code);
    expect(control.statusCode, control.body).toBe(200);
  });
});

describe("helpers", () => {
  const complete = { sub: "x", kind: "operator", aud: "clokr-operator", typ: "access" };

  it("isOperatorPayload requires an integer ver", () => {
    expect(isOperatorPayload({ ...complete, ver: 0 }, "access")).toBe(true);
    expect(isOperatorPayload({ ...complete, ver: 7 }, "access")).toBe(true);
    for (const ver of [undefined, "0", 0.5, null, Number.NaN]) {
      expect(isOperatorPayload({ ...complete, ver }, "access"), String(ver)).toBe(false);
    }
  });

  it("operatorTokenIsCurrent is true only for an equal version on an active account", () => {
    expect(operatorTokenIsCurrent({ ver: 2 }, { isActive: true, tokenVersion: 2 })).toBe(true);
    expect(operatorTokenIsCurrent({ ver: 1 }, { isActive: true, tokenVersion: 2 })).toBe(false);
    expect(operatorTokenIsCurrent({ ver: 3 }, { isActive: true, tokenVersion: 2 })).toBe(false);
    expect(operatorTokenIsCurrent({ ver: 2 }, { isActive: false, tokenVersion: 2 })).toBe(false);
    expect(operatorTokenIsCurrent({ ver: 2 }, null)).toBe(false);
  });

  it("signOperatorToken throws for a non-integer version", () => {
    expect(() => signOperatorToken(app, "x", "access", 1.5)).toThrow();
    expect(() => signOperatorToken(app, "x", "access", Number.NaN)).toThrow();
    expect(() => signOperatorToken(app, "x", "access", 0)).not.toThrow();
  });
});

describe("the version bump and its audit row are one transaction", () => {
  // A BigInt in the actor cannot be serialised by the audit writer, so the audit write throws inside the
  // transaction after the account update: nothing may survive.
  const brokenActor = { type: "SCRIPT", user: 1n, host: "test" } as never;

  it("a failed audit write rolls the reset back", async () => {
    const op = await seedOperator(app);
    const token = await signIn(op, op.totpFor(0));
    const before = await app.prisma.operatorAccount.findUniqueOrThrow({ where: { id: op.id } });

    await expect(
      resetOperatorMfa(app.prisma, { email: op.email, actor: brokenActor }),
    ).rejects.toThrow();

    const after = await app.prisma.operatorAccount.findUniqueOrThrow({ where: { id: op.id } });
    expect(after.tokenVersion).toBe(0);
    expect(after.totpSecretEnc).toBe(before.totpSecretEnc);
    expect(
      await app.prisma.operatorAuditLog.count({
        where: { action: "OPERATOR_MFA_RESET", entityId: op.id },
      }),
    ).toBe(0);
    expect((await get("/api/v1/operator/auth/me", token)).statusCode).toBe(200);
  });

  it("a failed audit write rolls the deactivation back", async () => {
    const op = await seedOperator(app);
    await expect(
      deactivateOperatorAccount(app.prisma, { email: op.email, actor: brokenActor }),
    ).rejects.toThrow();

    const after = await app.prisma.operatorAccount.findUniqueOrThrow({ where: { id: op.id } });
    expect(after.isActive).toBe(true);
    expect(after.tokenVersion).toBe(0);
    expect(
      await app.prisma.operatorAuditLog.count({
        where: { action: "OPERATOR_DEACTIVATED", entityId: op.id },
      }),
    ).toBe(0);
  });
});
