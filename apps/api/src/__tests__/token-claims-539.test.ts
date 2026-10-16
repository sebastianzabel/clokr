/**
 * Issue #539 (D-05, D-13) - no token carries a `role` claim any more.
 *
 * Since Release A permissions come only from stored role assignments, and no reader looks at the
 * legacy role: the access and refresh tokens of login, verify-otp and refresh hold
 * `{ sub, tenantId, employeeId }` (+ `jti` on a refresh token) and the sign-in body's `user` object
 * has no `role`. A token issued before the deploy still carries the claim; it keeps verifying and
 * the claim is ignored - the grants are exactly the stored assignments' (T-539-35). The API-key
 * principal has no role either.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { JwtPayload } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

const PASSWORD = "test1234";

describe("Issue #539 - tokens and principals carry no role", () => {
  let app: FastifyInstance;
  let plain: Awaited<ReturnType<typeof seedTestData>>;
  let twoFa: Awaited<ReturnType<typeof seedTestData>>;
  const otpCodes: string[] = [];
  let originalSendOtp: FastifyInstance["mailer"]["sendOtp"];
  let addressCounter = 0;

  /** Every request carries its own remote address so the per-route rate limits never interfere. */
  function uniqueAddress(): string {
    addressCounter += 1;
    return `10.54.${Math.floor(addressCounter / 250) % 250}.${(addressCounter % 250) + 1}`;
  }

  function post(url: string, payload: object) {
    return app.inject({ method: "POST", url, payload, remoteAddress: uniqueAddress() });
  }

  function claims(token: string): Record<string, unknown> {
    return app.jwt.decode(token) as Record<string, unknown>;
  }

  beforeAll(async () => {
    app = await getTestApp();
    plain = await seedTestData(app, "claims-539");
    twoFa = await seedTestData(app, "claims-539-otp");
    await app.prisma.tenantConfig.update({
      where: { tenantId: twoFa.tenant.id },
      data: { twoFaEnabled: true },
    });
    originalSendOtp = app.mailer.sendOtp;
    app.mailer.sendOtp = async (params) => {
      otpCodes.push(params.code);
    };
  });

  afterAll(async () => {
    app.mailer.sendOtp = originalSendOtp;
    for (const s of [plain, twoFa]) {
      try {
        await cleanupTestData(app, s.tenant.id);
      } catch (err) {
        console.error("Cleanup failed:", err);
      }
    }
    await closeTestApp();
  });

  it("login: access and refresh token have no role claim, the body's user has no role", async () => {
    const res = await post("/api/v1/auth/login", {
      email: plain.empUser.email,
      password: PASSWORD,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    for (const token of [body.accessToken, body.refreshToken]) {
      const c = claims(token);
      expect(Object.keys(c)).not.toContain("role");
      expect(c.sub).toBe(plain.empUser.id);
      expect(c.tenantId).toBe(plain.tenant.id);
      expect(c.employeeId).toBe(plain.employee.id);
    }
    expect(Object.keys(body.user)).not.toContain("role");
    // Non-vacuity: the rest of the body is still there.
    expect(Array.isArray(body.user.permissions)).toBe(true);
    expect(body.user.permissions.length).toBeGreaterThan(0);
    expect(body.user.id).toBe(plain.empUser.id);
  });

  it("verify-otp: the tokens have no role claim, the body's user has no role", async () => {
    const before = otpCodes.length;
    const first = await post("/api/v1/auth/login", {
      email: twoFa.empUser.email,
      password: PASSWORD,
    });
    expect(first.statusCode, first.body).toBe(202);
    expect(otpCodes.length).toBe(before + 1);
    const res = await post("/api/v1/auth/verify-otp", {
      userId: JSON.parse(first.body).userId,
      code: otpCodes[otpCodes.length - 1],
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    for (const token of [body.accessToken, body.refreshToken]) {
      expect(Object.keys(claims(token))).not.toContain("role");
      expect(claims(token).tenantId).toBe(twoFa.tenant.id);
    }
    expect(Object.keys(body.user)).not.toContain("role");
    expect(body.user.permissions.length).toBeGreaterThan(0);
  });

  it("refresh: the new access and refresh tokens have no role claim", async () => {
    const login = await post("/api/v1/auth/login", {
      email: plain.empUser.email,
      password: PASSWORD,
    });
    const refreshToken = JSON.parse(login.body).refreshToken as string;
    const res = await post("/api/v1/auth/refresh", { refreshToken });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    for (const token of [body.accessToken, body.refreshToken]) {
      const c = claims(token);
      expect(Object.keys(c)).not.toContain("role");
      expect(c.sub).toBe(plain.empUser.id);
      expect(c.employeeId).toBe(plain.employee.id);
    }
  });

  describe("a token issued before the deploy still carries a role claim", () => {
    function legacyToken(role: string): string {
      return app.jwt.sign({
        sub: plain.empUser.id,
        role,
        tenantId: plain.tenant.id,
        employeeId: plain.employee.id,
      } as unknown as JwtPayload);
    }

    it("is accepted and grants exactly the stored rows: own data 200, an admin route 403 despite role ADMIN", async () => {
      const headers = { authorization: `Bearer ${legacyToken("ADMIN")}` };
      const own = await app.inject({ method: "GET", url: "/api/v1/time-entries", headers });
      expect(own.statusCode, own.body).toBe(200);
      const adminRoute = await app.inject({ method: "GET", url: "/api/v1/employees", headers });
      expect(adminRoute.statusCode).toBe(403);
      // Control: the genuine admin token of the same tenant reaches that route.
      const control = await app.inject({
        method: "GET",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${plain.adminToken}` },
      });
      expect(control.statusCode, control.body).toBe(200);
    });

    it("an old refresh token with a role claim renews, and the renewed tokens carry none", async () => {
      const legacyRefresh = app.jwt.sign(
        {
          sub: plain.empUser.id,
          role: "ADMIN",
          tenantId: plain.tenant.id,
          employeeId: plain.employee.id,
          jti: "legacy-539",
        } as unknown as JwtPayload,
        { expiresIn: "1d" },
      );
      await app.prisma.refreshToken.create({
        data: {
          token: createHash("sha256").update(legacyRefresh).digest("hex"),
          userId: plain.empUser.id,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      const res = await post("/api/v1/auth/refresh", { refreshToken: legacyRefresh });
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body);
      expect(Object.keys(claims(body.accessToken))).not.toContain("role");
      expect(Object.keys(claims(body.refreshToken))).not.toContain("role");
    });
  });

  it("the API-key principal has no role (admin-scope key and plain key alike)", async () => {
    for (const scopes of [["admin"], ["time-entries:read"]]) {
      const raw = `clk_${randomBytes(24).toString("hex")}`;
      const row = await app.prisma.apiKey.create({
        data: {
          tenantId: plain.tenant.id,
          name: `claims-539-${scopes[0]}`,
          keyHash: createHash("sha256").update(raw).digest("hex"),
          keyPrefix: raw.slice(0, 8),
          scopes,
          createdBy: plain.adminUser.id,
        },
      });
      const req = {
        headers: { authorization: `Bearer ${raw}` },
        server: app,
      } as unknown as FastifyRequest;
      const reply = {
        code: () => {
          throw new Error("requireAuth refused a valid API key");
        },
      } as never;
      await requireAuth(req, reply);
      expect(req.user).toEqual({ sub: `apikey:${row.id}`, tenantId: plain.tenant.id });
      expect(Object.keys(req.user)).not.toContain("role");
      expect(req.apiKeyScopes).toEqual(scopes);
    }
  });
});
