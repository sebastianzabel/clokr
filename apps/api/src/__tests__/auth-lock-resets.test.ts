import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Auth Lock Reset Regression (v1.8.5 hotfix)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "alr");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("Bug 1: POST /reset-password clears lock state", () => {
    it("clears failedLoginAttempts, lockedUntil, lastFailedLoginAt on successful reset", async () => {
      // 1. Lock the user manually (simulate prod state)
      const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
      await app.prisma.user.update({
        where: { id: data.empUser.id },
        data: {
          failedLoginAttempts: 5,
          lockedUntil,
          lastFailedLoginAt: new Date(),
        },
      });

      // 2. Insert a fresh, valid OtpToken (mirrors what /forgot-password would create)
      const rawToken = "test-raw-token-" + Math.random().toString(36).slice(2);
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");
      await app.prisma.otpToken.create({
        data: {
          userId: data.empUser.id,
          code: tokenHash,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      // 3. Hit /reset-password — must include a policy-compliant new password
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/reset-password",
        payload: { token: rawToken, password: "NewPass!1234567" },
      });
      expect(res.statusCode).toBe(200);

      // 4. Assert lock fields cleared
      const u = await app.prisma.user.findUnique({ where: { id: data.empUser.id } });
      expect(u?.failedLoginAttempts).toBe(0);
      expect(u?.lockedUntil).toBeNull();
      expect(u?.lastFailedLoginAt).toBeNull();
    });

    it("allows immediate login with new password after reset", async () => {
      // Login with the password set above — must return 200, not 423
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: data.empUser.email, password: "NewPass!1234567" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.accessToken).toBeDefined();
    });
  });

  describe("Bug 2: POST /login after lock-expiry does not instantly re-lock", () => {
    it("treats first wrong password after expired lock as attempt 1, not (prior+1)", async () => {
      // Pre-condition: user has stale failedLoginAttempts=5, lockedUntil already expired
      await app.prisma.user.update({
        where: { id: data.adminUser.id },
        data: {
          failedLoginAttempts: 5,
          lockedUntil: new Date(Date.now() - 1000), // 1s ago — expired
          lastFailedLoginAt: new Date(Date.now() - 60_000),
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: data.adminUser.email, password: "definitely-wrong" },
      });

      // Must return 401 (bad credentials) — NOT 423 (re-locked)
      expect(res.statusCode).toBe(401);

      // Counter must be 1, not 6; lockedUntil must NOT be set
      const u = await app.prisma.user.findUnique({ where: { id: data.adminUser.id } });
      expect(u?.failedLoginAttempts).toBe(1);
      expect(u?.lockedUntil).toBeNull();
    });

    it("still returns 423 while a lock is active (regression guard)", async () => {
      const futureLock = new Date(Date.now() + 10 * 60 * 1000);
      await app.prisma.user.update({
        where: { id: data.adminUser.id },
        data: { failedLoginAttempts: 5, lockedUntil: futureLock },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: data.adminUser.email, password: "anything" },
      });
      expect(res.statusCode).toBe(423);
    });

    it("still locks when threshold reached on consecutive typos (regression guard)", async () => {
      // Reset to 4 attempts, no active lock — one more typo must lock
      await app.prisma.user.update({
        where: { id: data.adminUser.id },
        data: { failedLoginAttempts: 4, lockedUntil: null, lastFailedLoginAt: null },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: data.adminUser.email, password: "still-wrong" },
      });
      expect(res.statusCode).toBe(401);

      const u = await app.prisma.user.findUnique({ where: { id: data.adminUser.id } });
      expect(u?.failedLoginAttempts).toBe(5);
      expect(u?.lockedUntil).not.toBeNull();
      expect(u?.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

      // Cleanup: unlock so afterAll's cascading deletes aren't blocked
      await app.prisma.user.update({
        where: { id: data.adminUser.id },
        data: { failedLoginAttempts: 0, lockedUntil: null, lastFailedLoginAt: null },
      });
    });
  });
});
