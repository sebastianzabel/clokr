/**
 * Phase 88 plan 08 (AC-88-01/02/09/10, D-02/D-02a/D-03/D-03a/D-07/D-09) — the operator signs in with a
 * password and a second factor, and is a principal the tenant code never sees.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  seedOperator,
  cleanupTestData,
  type SeededOperator,
} from "./setup";
import {
  deactivateOperatorAccount,
  hashOperatorEmail,
} from "../contexts/platform/operator-credentials";

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
    // Since plan 88-09 `requireAuth` answers an operator token with an explicit, audited 403.
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
  });
});

const actor = { type: "SCRIPT", user: "vitest", host: "test" } as const;

async function auditRows(operatorId: string, action: string) {
  return app.prisma.operatorAuditLog.findMany({
    where: { operatorId, action },
    orderBy: { createdAt: "asc" },
  });
}

async function challengeFor(operator: SeededOperator): Promise<string> {
  const res = await login(operator);
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body).challengeToken;
}

describe("operator sign-in hardening", () => {
  it("answers unknown email and wrong password identically, with one bcrypt comparison each", async () => {
    const operator = await seedOperator(app);
    const compare = vi.spyOn(bcrypt, "compare");
    try {
      const unknown = await post("/api/v1/operator/auth/login", {
        email: `nobody-${operator.id}@example.invalid`,
        password: "Some-Wrong-Passw0rd!x",
      });
      const callsAfterUnknown = compare.mock.calls.length;
      const wrong = await login(operator, "Some-Wrong-Passw0rd!x");
      const callsAfterWrong = compare.mock.calls.length;

      expect(unknown.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(unknown.body).toBe(wrong.body);
      expect(callsAfterUnknown).toBe(1);
      expect(callsAfterWrong - callsAfterUnknown).toBe(1);
    } finally {
      compare.mockRestore();
    }
  });

  it("locks after five wrong passwords: the sixth attempt with the right password is refused, one OPERATOR_LOCKED row", async () => {
    const operator = await seedOperator(app);
    for (let i = 0; i < 5; i++) {
      expect((await login(operator, "Some-Wrong-Passw0rd!x")).statusCode).toBe(401);
    }
    expect((await login(operator)).statusCode).toBe(401);
    expect(await auditRows(operator.id, "OPERATOR_LOCKED")).toHaveLength(1);
    const account = await app.prisma.operatorAccount.findUniqueOrThrow({
      where: { id: operator.id },
    });
    expect(account.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("counts wrong second-factor codes toward the same lock", async () => {
    const operator = await seedOperator(app);
    const challengeToken = await challengeFor(operator);
    for (let i = 0; i < 5; i++) {
      // Five steps ahead is outside the validation window, so the code is certainly wrong.
      const res = await post("/api/v1/operator/auth/verify", {
        challengeToken,
        code: operator.totpFor(5 + i),
      });
      expect(res.statusCode).toBe(401);
    }
    const right = await post("/api/v1/operator/auth/verify", {
      challengeToken,
      code: operator.totpFor(0),
    });
    expect(right.statusCode).toBe(401);
    expect(await auditRows(operator.id, "OPERATOR_LOCKED")).toHaveLength(1);
    expect(await auditRows(operator.id, "OPERATOR_MFA_FAILED")).toHaveLength(6);
  });

  it("refuses a TOTP code that was already used (replay), audited as REPLAY", async () => {
    const operator = await seedOperator(app);
    await signIn(operator, 0);
    const challengeToken = await challengeFor(operator);
    const replay = await post("/api/v1/operator/auth/verify", {
      challengeToken,
      code: operator.totpFor(0),
    });
    expect(replay.statusCode).toBe(401);
    const rows = await auditRows(operator.id, "OPERATOR_MFA_FAILED");
    expect(JSON.stringify(rows[0].newValue)).toContain("REPLAY");
  });

  it("lets exactly one of two parallel verifications with the same code succeed", async () => {
    const operator = await seedOperator(app);
    const challengeToken = await challengeFor(operator);
    const code = operator.totpFor(0);
    const results = await Promise.all([
      post("/api/v1/operator/auth/verify", { challengeToken, code }),
      post("/api/v1/operator/auth/verify", { challengeToken, code }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    expect(await auditRows(operator.id, "OPERATOR_LOGIN")).toHaveLength(1);
  });

  it("accepts a recovery code once and audits OPERATOR_RECOVERY_CODE_USED with the remaining count", async () => {
    const operator = await seedOperator(app);
    const challengeToken = await challengeFor(operator);
    const first = await post("/api/v1/operator/auth/verify", {
      challengeToken,
      recoveryCode: operator.recoveryCodes[0],
    });
    expect(first.statusCode).toBe(200);
    const used = await auditRows(operator.id, "OPERATOR_RECOVERY_CODE_USED");
    expect(used).toHaveLength(1);
    expect((used[0].newValue as { remaining: number }).remaining).toBe(9);

    const second = await post("/api/v1/operator/auth/verify", {
      challengeToken: await challengeFor(operator),
      recoveryCode: operator.recoveryCodes[0],
    });
    expect(second.statusCode).toBe(401);
  });

  it("never accepts a challenge token as an access token or an access token as a challenge", async () => {
    const operator = await seedOperator(app);
    const challengeToken = await challengeFor(operator);
    const asAccess = await get("/api/v1/operator/auth/me", challengeToken);
    expect(asAccess.statusCode).toBe(401);

    const accessToken = await signIn(operator, 1);
    const asChallenge = await post("/api/v1/operator/auth/verify", {
      challengeToken: accessToken,
      code: operator.totpFor(2),
    });
    expect(asChallenge.statusCode).toBe(401);
  });

  it("refuses a deactivated operator at login and with an already issued access token", async () => {
    const operator = await seedOperator(app);
    const token = await signIn(operator);
    expect((await get("/api/v1/operator/auth/me", token)).statusCode).toBe(200);

    expect(await deactivateOperatorAccount(app.prisma, { email: operator.email, actor })).toEqual({
      status: "OK",
    });
    expect((await login(operator)).statusCode).toBe(401);
    expect((await get("/api/v1/operator/auth/me", token)).statusCode).toBe(401);
  });

  it("stores a keyed hash of the typed address in OPERATOR_LOGIN_FAILED, never the address", async () => {
    const typed = `Typed-${Date.now()}@Example.invalid`;
    const res = await post("/api/v1/operator/auth/login", {
      email: typed,
      password: "Some-Wrong-Passw0rd!x",
    });
    expect(res.statusCode).toBe(401);
    const hash = hashOperatorEmail(typed);
    const rows = await app.prisma.operatorAuditLog.findMany({
      where: { action: "OPERATOR_LOGIN_FAILED", newValue: { path: ["emailHash"], equals: hash } },
    });
    expect(rows).toHaveLength(1);
    const dump = JSON.stringify(rows[0]).toLowerCase();
    expect(dump).not.toContain("typed-");
    expect(dump).not.toContain("example.invalid");
    expect(rows[0].ipAddress).toBeTruthy();
  });

  it("enforces the operator claims even when the signature verifies with the operator secret", async () => {
    const operator = await seedOperator(app);
    const signer = app.jwt.operator!;
    const noKind = signer.sign(
      { sub: operator.id, typ: "access", ver: operator.tokenVersion } as never,
      { expiresIn: "5m" },
    );
    const wrongAud = signer.sign(
      {
        sub: operator.id,
        kind: "operator",
        aud: "somebody-else",
        typ: "access",
        ver: operator.tokenVersion,
      } as never,
      { expiresIn: "5m" },
    );
    const noTyp = signer.sign(
      {
        sub: operator.id,
        kind: "operator",
        aud: "clokr-operator",
        ver: operator.tokenVersion,
      } as never,
      { expiresIn: "5m" },
    );
    // Each claim missing on its own, so none of the checks can hide behind another.
    const onlyKindMissing = signer.sign(
      {
        sub: operator.id,
        aud: "clokr-operator",
        typ: "access",
        ver: operator.tokenVersion,
      } as never,
      { expiresIn: "5m" },
    );
    const onlyAudMissing = signer.sign(
      { sub: operator.id, kind: "operator", typ: "access", ver: operator.tokenVersion } as never,
      { expiresIn: "5m" },
    );
    for (const token of [noKind, wrongAud, noTyp, onlyKindMissing, onlyAudMissing]) {
      expect((await get("/api/v1/operator/auth/me", token)).statusCode).toBe(401);
    }
  });

  it("bounds the refusal audit: 50 refused calls write one row, the next window carries the suppressed count", async () => {
    const principal = data.empUser.id;
    const where = {
      action: "TENANT_PRINCIPAL_REFUSED",
      newValue: { path: ["principalSub"], equals: principal },
    };
    for (let i = 0; i < 50; i++) {
      expect((await get("/api/v1/operator/auth/me", data.empToken)).statusCode).toBe(403);
    }
    expect(await app.prisma.operatorAuditLog.count({ where })).toBe(1);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      expect((await get("/api/v1/operator/auth/me", data.empToken)).statusCode).toBe(403);
    } finally {
      vi.useRealTimers();
    }
    const rows = await app.prisma.operatorAuditLog.findMany({
      where,
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect((rows[1].newValue as { suppressedRepeats: number }).suppressedRepeats).toBe(49);
  });

  it("keeps the operator code away from the tenant principal and gives every route a rate limit", () => {
    const dir = join(__dirname, "..", "contexts", "platform", "api", "operator");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toMatch(/\breq\.user\b/);
      expect(text, file).not.toMatch(/\.audit\(/);
      expect(text, file).not.toMatch(/accessContextFromRequest|employeeScopeFor/);
      expect(text, file).not.toMatch(/prisma\.(user|employee|auditLog)\b/);
      const routes = text.match(/\bapp\.(get|post|put|patch|delete)\(/g) ?? [];
      const limits = text.match(/config:\s*\w*rateLimit\w*/gi) ?? [];
      expect(routes.length, file).toBeGreaterThan(0);
      expect(limits.length, file).toBe(routes.length);
    }
  });
});
