/**
 * Phase 88 plan 06 (AC-88-07/08/09, D-05/D-07/D-09) — a tenant is deactivated, never deleted, and every
 * credential path the platform owns refuses its users while it is.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
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
  TENANT_DEACTIVATED_ERROR,
  deactivateTenant,
  reactivateTenant,
  isTenantDeactivated,
  isTenantRowActive,
  ACTIVE_TENANT_WHERE,
} from "../contexts/platform/tenant-status";

let app: FastifyInstance;
let data: Awaited<ReturnType<typeof seedTestData>>;
let operator: SeededOperator;
let addressCounter = 0;

/** Every request carries its own remote address so the fixed per-route rate limits never interfere. */
function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.88.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url,
    payload: payload as object,
    headers,
    remoteAddress: uniqueAddress(),
  });
}

const request = { ip: "203.0.113.7", headers: { "user-agent": "vitest" } };

async function deactivate(reason = "Vertrag beendet") {
  return app.prisma.$transaction((tx) =>
    deactivateTenant(tx, data.tenant.id, { operatorId: operator.id, reason, request }),
  );
}

async function reactivate() {
  return app.prisma.$transaction((tx) =>
    reactivateTenant(tx, data.tenant.id, { operatorId: operator.id, request }),
  );
}

async function loginAs(email: string, password = "test1234") {
  return post("/api/v1/auth/login", { email, password });
}

async function tenantRowCounts() {
  const tenantId = data.tenant.id;
  const [employees, users, timeEntries, salons, configs, leaveRequests] = await Promise.all([
    app.prisma.employee.count({ where: { tenantId } }),
    app.prisma.user.count({ where: { employee: { tenantId } } }),
    app.prisma.timeEntry.count({ where: { employee: { tenantId } } }),
    app.prisma.salon.count({ where: { tenantId } }),
    app.prisma.tenantConfig.count({ where: { tenantId } }),
    app.prisma.leaveRequest.count({ where: { employee: { tenantId } } }),
  ]);
  return { employees, users, timeEntries, salons, configs, leaveRequests };
}

beforeAll(async () => {
  app = await getTestApp();
  data = await seedTestData(app, "td88");
  operator = await seedOperator(app);
});

afterAll(async () => {
  try {
    await cleanupTestData(app, data.tenant.id);
  } catch (err) {
    console.error("Test cleanup failed:", err);
  }
  await closeTestApp();
});

describe("tenant-status helpers", () => {
  it("ACTIVE_TENANT_WHERE is the one spelling of an active tenant", () => {
    expect(ACTIVE_TENANT_WHERE).toEqual({ deactivatedAt: null });
  });

  it("isTenantRowActive treats a missing row as active", () => {
    expect(isTenantRowActive(null)).toBe(true);
    expect(isTenantRowActive(undefined)).toBe(true);
    expect(isTenantRowActive({ deactivatedAt: null })).toBe(true);
    expect(isTenantRowActive({ deactivatedAt: new Date() })).toBe(false);
  });

  it("isTenantDeactivated answers false for blank and unknown tenant ids (#551 stays untouched, D-10)", async () => {
    expect(await isTenantDeactivated(app.prisma, "")).toBe(false);
    expect(await isTenantDeactivated(app.prisma, "   ")).toBe(false);
    expect(await isTenantDeactivated(app.prisma, null)).toBe(false);
    expect(await isTenantDeactivated(app.prisma, undefined)).toBe(false);
    expect(await isTenantDeactivated(app.prisma, "no-such-tenant-id")).toBe(false);
    expect(await isTenantDeactivated(app.prisma, data.tenant.id)).toBe(false);
  });
});

describe("deactivation core and the login refusal (tracer)", () => {
  it("login works before deactivation and leaves an open refresh token", async () => {
    const res = await loginAs(data.adminUser.email);
    expect(res.statusCode).toBe(200);
    const open = await app.prisma.refreshToken.count({
      where: { revokedAt: null, user: { employee: { tenantId: data.tenant.id } } },
    });
    expect(open).toBeGreaterThan(0);
  });

  it("deactivating a tenant that does not exist answers NOT_FOUND and writes no audit row", async () => {
    const before = await app.prisma.operatorAuditLog.count({
      where: { action: "TENANT_DEACTIVATED", subjectTenantId: "no-such-tenant-id" },
    });
    const result = await app.prisma.$transaction((tx) =>
      deactivateTenant(tx, "no-such-tenant-id", { operatorId: operator.id, reason: "x", request }),
    );
    expect(result.status).toBe("NOT_FOUND");
    const after = await app.prisma.operatorAuditLog.count({
      where: { action: "TENANT_DEACTIVATED", subjectTenantId: "no-such-tenant-id" },
    });
    expect(after).toBe(before);
  });

  it("reactivating an active tenant answers NOT_DEACTIVATED", async () => {
    const result = await reactivate();
    expect(result.status).toBe("NOT_DEACTIVATED");
  });

  it("deactivation sets the columns, revokes open refresh tokens and leaves the data intact", async () => {
    const countsBefore = await tenantRowCounts();
    expect(countsBefore.employees).toBeGreaterThan(0);

    const result = await deactivate("Vertrag beendet");
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.revokedRefreshTokens).toBeGreaterThan(0);

    const tenant = await app.prisma.tenant.findUniqueOrThrow({ where: { id: data.tenant.id } });
    expect(tenant.deactivatedAt).toBeInstanceOf(Date);
    expect(tenant.deactivatedReason).toBe("Vertrag beendet");
    expect(tenant.deactivatedByOperatorId).toBe(operator.id);

    const stillOpen = await app.prisma.refreshToken.count({
      where: { revokedAt: null, user: { employee: { tenantId: data.tenant.id } } },
    });
    expect(stillOpen).toBe(0);

    expect(await tenantRowCounts()).toEqual(countsBefore);
  });

  it("writes exactly one TENANT_DEACTIVATED operator audit row with subject, operator and values", async () => {
    const rows = await app.prisma.operatorAuditLog.findMany({
      where: { action: "TENANT_DEACTIVATED", subjectTenantId: data.tenant.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].operatorId).toBe(operator.id);
    expect(rows[0].entity).toBe("Tenant");
    expect(rows[0].entityId).toBe(data.tenant.id);
    expect(rows[0].oldValue).toEqual({ deactivatedAt: null });
    const newValue = rows[0].newValue as Record<string, unknown>;
    expect(newValue.reason).toBe("Vertrag beendet");
    expect(typeof newValue.deactivatedAt).toBe("string");
    expect(typeof newValue.revokedRefreshTokens).toBe("number");
  });

  it("deactivating twice answers ALREADY_DEACTIVATED and writes no second row", async () => {
    const result = await deactivate("noch einmal");
    expect(result.status).toBe("ALREADY_DEACTIVATED");
    const count = await app.prisma.operatorAuditLog.count({
      where: { action: "TENANT_DEACTIVATED", subjectTenantId: data.tenant.id },
    });
    expect(count).toBe(1);
  });

  it("login with the correct password is refused with 403 and the one German body", async () => {
    const res = await loginAs(data.adminUser.email);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual(TENANT_DEACTIVATED_ERROR);
    expect(res.body).not.toContain("accessToken");
  });

  it("login with a WRONG password keeps the unchanged 401 (no tenant-state oracle)", async () => {
    const res = await loginAs(data.adminUser.email, "definitely-wrong");
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Ungültige Anmeldedaten" });
  });

  it("a refused login is traceable in the tenant AuditLog as LOGIN_REFUSED", async () => {
    const rows = await app.prisma.auditLog.findMany({
      where: { action: "LOGIN_REFUSED", userId: data.adminUser.id },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].entity).toBe("User");
    expect(rows[0].entityId).toBe(data.adminUser.id);
    expect(rows[0].newValue).toEqual({ reason: "TENANT_DEACTIVATED" });
    expect(rows[0].ipAddress).toBeTruthy();
  });

  it("reactivation clears the columns, audits TENANT_REACTIVATED and restores login", async () => {
    const result = await reactivate();
    expect(result.status).toBe("OK");

    const tenant = await app.prisma.tenant.findUniqueOrThrow({ where: { id: data.tenant.id } });
    expect(tenant.deactivatedAt).toBeNull();
    expect(tenant.deactivatedReason).toBeNull();
    expect(tenant.deactivatedByOperatorId).toBeNull();

    const rows = await app.prisma.operatorAuditLog.findMany({
      where: { action: "TENANT_REACTIVATED", subjectTenantId: data.tenant.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].operatorId).toBe(operator.id);
    expect(rows[0].oldValue).toMatchObject({ deactivatedReason: "Vertrag beendet" });
    expect(rows[0].newValue).toEqual({ deactivatedAt: null });

    const res = await loginAs(data.adminUser.email);
    expect(res.statusCode).toBe(200);
  });
});

describe("token paths: verify-otp, resend-otp and refresh", () => {
  let sentCodes: string[] = [];
  let otpSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { twoFaEnabled: true },
    });
    otpSpy = vi.spyOn(app.mailer, "sendOtp").mockImplementation(async ({ code }) => {
      sentCodes.push(code);
    });
  });

  afterAll(async () => {
    otpSpy.mockRestore();
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { twoFaEnabled: false },
    });
  });

  it("verify-otp and resend-otp refuse a deactivated tenant and send nothing; sign-in works again after reactivation", async () => {
    sentCodes = [];
    const login = await loginAs(data.empUser.email);
    expect(login.statusCode).toBe(202);
    const { userId } = JSON.parse(login.body);
    expect(sentCodes).toHaveLength(1);
    const code = sentCodes[0];

    expect((await deactivate()).status).toBe("OK");
    otpSpy.mockClear();

    const verify = await post("/api/v1/auth/verify-otp", { userId, code });
    expect(verify.statusCode).toBe(403);
    expect(JSON.parse(verify.body)).toEqual(TENANT_DEACTIVATED_ERROR);
    expect(verify.body).not.toContain("accessToken");

    const resend = await post("/api/v1/auth/resend-otp", { userId });
    expect(resend.statusCode).toBe(403);
    expect(JSON.parse(resend.body)).toEqual(TENANT_DEACTIVATED_ERROR);
    expect(otpSpy).not.toHaveBeenCalled();

    expect((await reactivate()).status).toBe("OK");
    sentCodes = [];
    const again = await loginAs(data.empUser.email);
    expect(again.statusCode).toBe(202);
    const verified = await post("/api/v1/auth/verify-otp", {
      userId: JSON.parse(again.body).userId,
      code: sentCodes[0],
    });
    expect(verified.statusCode).toBe(200);
    expect(JSON.parse(verified.body).accessToken).toBeTruthy();

    const resent = await post("/api/v1/auth/resend-otp", { userId });
    expect(resent.statusCode).toBe(200);
  });

  it("refresh refuses a deactivated tenant before rotation and works again after reactivation", async () => {
    // Switch 2FA off for this case so the login hands out tokens directly.
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { twoFaEnabled: false },
    });
    const login = await loginAs(data.empUser.email);
    expect(login.statusCode).toBe(200);
    const { refreshToken } = JSON.parse(login.body);
    const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
    const rowsBefore = await app.prisma.refreshToken.count({
      where: { userId: data.empUser.id },
    });

    // Set the column directly (no revocation), to isolate the refresh check itself.
    await app.prisma.tenant.update({
      where: { id: data.tenant.id },
      data: { deactivatedAt: new Date() },
    });

    const refused = await post("/api/v1/auth/refresh", { refreshToken });
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body)).toEqual(TENANT_DEACTIVATED_ERROR);
    const stored = await app.prisma.refreshToken.findUniqueOrThrow({ where: { token: tokenHash } });
    expect(stored.revokedAt).toBeNull();
    expect(await app.prisma.refreshToken.count({ where: { userId: data.empUser.id } })).toBe(
      rowsBefore,
    );

    await app.prisma.tenant.update({
      where: { id: data.tenant.id },
      data: { deactivatedAt: null },
    });
    const ok = await post("/api/v1/auth/refresh", { refreshToken });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).accessToken).toBeTruthy();
  });
});

describe("credential paths: forgot/reset/change-password and invitation accept", () => {
  const NEW_PASSWORD = "NewPass!1234567";

  function hashed(raw: string) {
    return createHash("sha256").update(raw).digest("hex");
  }

  async function passwordHashOf(userId: string) {
    return (await app.prisma.user.findUniqueOrThrow({ where: { id: userId } })).passwordHash;
  }

  async function issueResetToken(userId: string) {
    const raw = "reset-" + Math.random().toString(36).slice(2);
    await app.prisma.otpToken.create({
      data: { userId, code: hashed(raw), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    return raw;
  }

  it("forgot-password answers success for a deactivated tenant but sends no mail and stores no token", async () => {
    const resetSpy = vi.spyOn(app.mailer, "sendPasswordReset").mockResolvedValue(undefined);
    try {
      expect((await deactivate()).status).toBe("OK");
      const before = await app.prisma.otpToken.count({ where: { userId: data.empUser.id } });

      const res = await post("/api/v1/auth/forgot-password", { email: data.empUser.email });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ success: true });
      expect(resetSpy).not.toHaveBeenCalled();
      expect(await app.prisma.otpToken.count({ where: { userId: data.empUser.id } })).toBe(before);

      expect((await reactivate()).status).toBe("OK");
      const again = await post("/api/v1/auth/forgot-password", { email: data.empUser.email });
      expect(again.statusCode).toBe(200);
      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(await app.prisma.otpToken.count({ where: { userId: data.empUser.id } })).toBe(
        before + 1,
      );
    } finally {
      resetSpy.mockRestore();
    }
  });

  it("change-password with a still signature-valid access token is refused and the hash stays", async () => {
    const login = await loginAs(data.empUser.email);
    expect(login.statusCode).toBe(200);
    const { accessToken } = JSON.parse(login.body);
    const hashBefore = await passwordHashOf(data.empUser.id);

    expect((await deactivate()).status).toBe("OK");
    const refused = await post(
      "/api/v1/auth/change-password",
      { currentPassword: "test1234", newPassword: NEW_PASSWORD },
      { authorization: `Bearer ${accessToken}` },
    );
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body)).toEqual(TENANT_DEACTIVATED_ERROR);
    expect(await passwordHashOf(data.empUser.id)).toBe(hashBefore);

    expect((await reactivate()).status).toBe("OK");
    const ok = await post(
      "/api/v1/auth/change-password",
      { currentPassword: "test1234", newPassword: NEW_PASSWORD },
      { authorization: `Bearer ${accessToken}` },
    );
    expect(ok.statusCode).toBe(200);
    expect(await passwordHashOf(data.empUser.id)).not.toBe(hashBefore);
  });

  it("reset-password with a token issued before the deactivation is refused and the hash stays", async () => {
    const raw = await issueResetToken(data.adminUser.id);
    const hashBefore = await passwordHashOf(data.adminUser.id);

    expect((await deactivate()).status).toBe("OK");
    const refused = await post("/api/v1/auth/reset-password", {
      token: raw,
      password: NEW_PASSWORD,
    });
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body)).toEqual(TENANT_DEACTIVATED_ERROR);
    expect(await passwordHashOf(data.adminUser.id)).toBe(hashBefore);

    expect((await reactivate()).status).toBe("OK");
    const ok = await post("/api/v1/auth/reset-password", { token: raw, password: NEW_PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect(await passwordHashOf(data.adminUser.id)).not.toBe(hashBefore);
  });

  it("invitation accept for a deactivated tenant is refused; the user stays inactive and the invitation unused", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `invitee-${suffix}@test.de`,
        passwordHash: "PENDING",
        role: "EMPLOYEE",
        isActive: false,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `INV-${suffix}`,
        firstName: "Ina",
        lastName: "Eingeladen",
        hireDate: new Date("2024-01-01"),
      },
    });
    const rawToken = "invite-" + suffix;
    const invitation = await app.prisma.invitation.create({
      data: {
        token: hashed(rawToken),
        employeeId: employee.id,
        email: user.email,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    expect((await deactivate()).status).toBe("OK");
    const refused = await post("/api/v1/invitations/accept", {
      token: rawToken,
      password: NEW_PASSWORD,
    });
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body)).toEqual(TENANT_DEACTIVATED_ERROR);
    const userAfter = await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userAfter.isActive).toBe(false);
    expect(userAfter.passwordHash).toBe("PENDING");
    const invitationAfter = await app.prisma.invitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    expect(invitationAfter.acceptedAt).toBeNull();

    expect((await reactivate()).status).toBe("OK");
    const ok = await post("/api/v1/invitations/accept", {
      token: rawToken,
      password: NEW_PASSWORD,
    });
    expect(ok.statusCode).toBe(200);
    const activated = await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(activated.isActive).toBe(true);
  });
});
