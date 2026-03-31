import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Password Policy (BSI)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "pw");

    // Set strict password policy
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: {
        passwordMinLength: 12,
        passwordRequireUpper: true,
        passwordRequireLower: true,
        passwordRequireDigit: true,
        passwordRequireSpecial: true,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("rejects weak password on employee creation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        email: `weak-pw-${Date.now()}@test.de`,
        firstName: "Test",
        lastName: "Weak",
        employeeNumber: `PW1-${Date.now()}`,
        hireDate: "2026-01-01T00:00:00Z",
        password: "onlylower1234", // passes Zod min(8) but fails BSI policy (no uppercase, no special)
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBeTruthy(); // Policy violation (missing uppercase/special)
  });

  it("accepts strong password on employee creation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        email: `strong-pw-${Date.now()}-${Math.random().toString(36).slice(2)}@test.de`,
        employeeNumber: `PW2-${Date.now()}`,
        firstName: "Test",
        lastName: "Strong",
        hireDate: "2026-01-01T00:00:00Z",
        password: "Str0ng!PassWord#42xx", // 20 chars, satisfies even 16-char policy from previous test
      },
    });

    // 201 = created, 409 = email conflict (acceptable in test env)
    if (![201, 409].includes(res.statusCode)) {
      console.error("Unexpected status:", res.statusCode, res.body);
    }
    expect([201, 409]).toContain(res.statusCode);
    if (res.statusCode === 201) {
      expect(JSON.parse(res.body).id).toBeTruthy();
    }
  });

  it("returns password policy from public endpoint", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/password-policy",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.passwordMinLength).toBeGreaterThanOrEqual(8);
    expect(typeof body.passwordRequireUpper).toBe("boolean");
    expect(typeof body.passwordRequireSpecial).toBe("boolean");
  });

  it("saves password policy via security settings", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/security",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { passwordMinLength: 16, passwordRequireSpecial: false },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.passwordMinLength).toBe(16);
    expect(body.passwordRequireSpecial).toBe(false);
  });
});
