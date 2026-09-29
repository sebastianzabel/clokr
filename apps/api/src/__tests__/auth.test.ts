import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import type { FastifyInstance } from "fastify";

describe("Auth API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "au");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("POST /api/v1/auth/login", () => {
    it("returns tokens for valid credentials", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: data.adminUser.email, password: "test1234" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.accessToken).toBeDefined();
      expect(body.refreshToken).toBeDefined();
      expect(body.user.role).toBe("ADMIN");
    });

    it("rejects invalid password", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: data.adminUser.email, password: "wrongpassword" },
      });

      expect(res.statusCode).toBe(401);
    });

    it("rejects non-existent user", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "nobody@nowhere.de", password: "test1234" },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/v1/auth/refresh", () => {
    it("rotates refresh token", async () => {
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: data.adminUser.email, password: "test1234" },
      });
      const { refreshToken } = JSON.parse(loginRes.body);

      const refreshRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken },
      });

      expect(refreshRes.statusCode).toBe(200);
      const body = JSON.parse(refreshRes.body);
      expect(body.accessToken).toBeDefined();
      expect(body.refreshToken).toBeDefined();
      expect(body.refreshToken).not.toBe(refreshToken);
    });

    it("rejects reused (revoked) refresh token", async () => {
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: data.empUser.email, password: "test1234" },
      });
      const { refreshToken } = JSON.parse(loginRes.body);

      // First refresh (uses and revokes the token)
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken },
      });

      // Second refresh with same token should fail
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken },
      });

      expect(res.statusCode).toBe(401);
    });

    // Phase 408 (Issue #408, regression of #378): the refresh response carries the caller's
    // CURRENT effective permissions, computed by the same function login/verify-otp already use —
    // this is RED against unfixed auth.ts (today's /refresh response has no `permissions` key).
    it("D-01/D-10: returns permissions deep-equal to login's, non-empty, and no `user` object", async () => {
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: data.adminUser.email, password: "test1234" },
      });
      const loginBody = JSON.parse(loginRes.body);
      const { refreshToken } = loginBody;

      const refreshRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken },
      });

      expect(refreshRes.statusCode).toBe(200);
      const refreshBody = JSON.parse(refreshRes.body);
      expect(Array.isArray(refreshBody.permissions)).toBe(true);
      // Length check FIRST — two empty lists must never satisfy the deep-equal below.
      expect(refreshBody.permissions.length).toBeGreaterThan(0);
      expect(refreshBody.permissions).toEqual(loginBody.user.permissions);
      expect(refreshBody.user).toBeUndefined();
    });

    // AK-1 freshness: a role assignment granted AFTER login shows up in the very next refresh
    // response — the list is recomputed per refresh, never echoed from login.
    it("AK-1: a role assignment granted after login is reflected in the next refresh", async () => {
      const suffix = `au408-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const passwordHash = await bcrypt.hash("test1234", 10);
      const user = await app.prisma.user.create({
        data: { email: `${suffix}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
      });
      await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          employeeNumber: suffix.toUpperCase().slice(0, 20),
          firstName: "Refresh",
          lastName: "PermissionsTest",
          hireDate: new Date("2024-01-01"),
        },
      });

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: `${suffix}@test.de`, password: "test1234" },
      });
      expect(loginRes.statusCode).toBe(200);
      const loginBody = JSON.parse(loginRes.body);
      expect(loginBody.user.permissions).not.toContain("leave-request:read:ZUGEWIESEN");

      const salon = await createTestSalon(app.prisma, data.tenant.id, {
        name: "Refresh Permissions Test Salon",
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
          scopeType: "SALONS",
          salonIds: [salon.id],
          employeeIds: [],
        },
      });

      const refreshRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken: loginBody.refreshToken },
      });
      expect(refreshRes.statusCode).toBe(200);
      const refreshBody = JSON.parse(refreshRes.body);
      expect(refreshBody.permissions).toContain("leave-request:read:ZUGEWIESEN");
      expect(refreshBody.permissions).toContain("time-entry:read:ZUGEWIESEN");
    });
  });

  describe("Protected routes", () => {
    it("rejects request without token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/employees",
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe("COMPLIANCE: Auth flow completeness", () => {
    it("login with valid credentials returns tokens", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: data.adminUser.email, password: "test1234" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.accessToken).toBeDefined();
      expect(body.refreshToken).toBeDefined();
    });

    it("login with wrong password returns 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: data.adminUser.email, password: "totally-wrong-password" },
      });

      expect(res.statusCode).toBe(401);
    });

    it("refresh token returns new access token", async () => {
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: data.adminUser.email, password: "test1234" },
      });
      const { refreshToken } = JSON.parse(loginRes.body);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.accessToken).toBeDefined();
    });

    it("invalid JWT returns 401 on protected endpoint", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/employees",
        headers: { authorization: "Bearer invalid.token.here" },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe("COMPLIANCE: Role-based access gates", () => {
    it("EMPLOYEE cannot access admin endpoints", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.empToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it("ADMIN can access admin endpoints", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
    });
  });
});
