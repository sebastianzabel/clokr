import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Auth API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "au");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
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
});
