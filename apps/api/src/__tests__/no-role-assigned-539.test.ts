/**
 * Issue #539 (D-14) - a sign-in without any effective permission is refused, not let into an empty app.
 *
 * Since the legacy-role fallback is gone, an active user who holds no stored role assignment (or only
 * an assignment of a role without permissions) resolves to an empty permission set: every request
 * would answer 403. Instead the three credential paths refuse with 403
 * `{ error, code: "NO_ROLE_ASSIGNED" }`, in the same positions as the #551 `TENANT_REQUIRED` refusal:
 *
 * - `POST /auth/login`: after the password matched (a wrong password keeps the unchanged 401) and
 *   before any OTP is created or mailed; audited as `LOGIN_REFUSED` with reason `NO_ROLE_ASSIGNED`,
 * - `POST /auth/verify-otp`: before any token is issued,
 * - `POST /auth/refresh`: before the rotation, so the stored token stays exactly as it was.
 *
 * `code` is the control value; the German text is display only.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  grantSystemRole,
  removeFixtureRoleAssignments,
  auditRowsFor,
} from "./setup";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";
import {
  NO_ROLE_ASSIGNED_ERROR,
  effectivePermissionKeysForUser,
} from "../contexts/platform/request-permissions";

const PASSWORD = "test1234";
const WRONG_PASSWORD = "definitely-wrong-1";

describe("Issue #539 - NO_ROLE_ASSIGNED at login, verify-otp and refresh", () => {
  let app: FastifyInstance;
  let plain: Awaited<ReturnType<typeof seedTestData>>;
  let twoFa: Awaited<ReturnType<typeof seedTestData>>;
  let addressCounter = 0;

  /** Every request carries its own remote address so the fixed per-route rate limits never interfere. */
  function uniqueAddress(): string {
    const n = addressCounter++;
    return `10.53.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
  }

  function post(url: string, payload: object, headers: Record<string, string> = {}) {
    return app.inject({
      method: "POST",
      url,
      payload,
      headers,
      remoteAddress: uniqueAddress(),
    });
  }

  async function createPerson(
    tenant: Awaited<ReturnType<typeof seedTestData>>,
    label: string,
    stored?: "ADMIN" | "MANAGER" | "EMPLOYEE",
    isActive = true,
  ) {
    const s = `${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
    const email = `nra539-${s}@example.invalid`;
    const user = await app.prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        // The column value is irrelevant since #539: permissions come only from stored rows.
        role: "ADMIN",
        isActive,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: tenant.tenant.id,
        userId: user.id,
        employeeNumber: `N5-${s}`.slice(0, 20),
        firstName: label,
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    if (stored !== undefined) {
      await grantSystemRole(app.prisma, {
        tenantId: tenant.tenant.id,
        userId: user.id,
        role: stored,
      });
    }
    return { user, employee, email };
  }

  function login(email: string, password = PASSWORD) {
    return post("/api/v1/auth/login", { email, password });
  }

  function refreshRows(userId: string) {
    return app.prisma.refreshToken.findMany({
      where: { userId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  function loginRefusedRows(userId: string) {
    return auditRowsFor(app, "User", userId, "LOGIN_REFUSED");
  }

  beforeAll(async () => {
    app = await getTestApp();
    plain = await seedTestData(app, "nra539");
    twoFa = await seedTestData(app, "nra539f");
    await app.prisma.tenantConfig.update({
      where: { tenantId: twoFa.tenant.id },
      data: { twoFaEnabled: true },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, plain.tenant.id);
      await cleanupTestData(app, twoFa.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("login", () => {
    it("an active user with an Employee and no stored row: 403, the constant body, one LOGIN_REFUSED row, no LOGIN row, no token", async () => {
      const p = await createPerson(plain, "Ohne Rolle");

      const res = await login(p.email);

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body).toEqual(NO_ROLE_ASSIGNED_ERROR);
      expect(body.code).toBe("NO_ROLE_ASSIGNED");
      expect(body.accessToken).toBeUndefined();
      expect(body.refreshToken).toBeUndefined();

      const refused = await loginRefusedRows(p.user.id);
      expect(refused).toHaveLength(1);
      expect(refused[0].userId).toBe(p.user.id);
      expect((refused[0].newValue as { reason?: string } | null)?.reason).toBe("NO_ROLE_ASSIGNED");
      expect(await auditRowsFor(app, "User", p.user.id, "LOGIN")).toHaveLength(0);
      expect(await refreshRows(p.user.id)).toHaveLength(0);
    });

    it("the same refusal in a two-factor tenant comes BEFORE any OTP: no OtpToken row, sendOtp never called", async () => {
      const sendOtp = vi.spyOn(app.mailer, "sendOtp").mockResolvedValue(undefined as never);
      const p = await createPerson(twoFa, "Ohne Rolle 2FA");

      const res = await login(p.email);

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual(NO_ROLE_ASSIGNED_ERROR);
      expect(sendOtp).not.toHaveBeenCalled();
      expect(await app.prisma.otpToken.count({ where: { userId: p.user.id } })).toBe(0);
    });

    it("a wrong password keeps the unchanged 401 (no account-state oracle) and writes no LOGIN_REFUSED row", async () => {
      const p = await createPerson(plain, "Ohne Rolle Falsch");

      const res = await login(p.email, WRONG_PASSWORD);

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: "Ungültige Anmeldedaten" });
      expect(await loginRefusedRows(p.user.id)).toHaveLength(0);
    });

    it("a holder of an empty customer role (TENANT assignment, no permissions) is refused too", async () => {
      const p = await createPerson(plain, "Leere Rolle");
      const name = `Leer ${crypto.randomBytes(3).toString("hex")}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId: plain.tenant.id,
          name,
          nameKey: roleNameKey(name),
          permissions: normalizeRolePermissions([]),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: plain.tenant.id,
          userId: p.user.id,
          accessRoleId: role.id,
          scopeType: "TENANT",
          salonIds: [],
          employeeIds: [],
        },
      });
      // Non-vacuity: the user does hold a stored row, and still resolves to nothing.
      expect(await app.prisma.roleAssignment.count({ where: { userId: p.user.id } })).toBe(1);
      expect(await effectivePermissionKeysForUser(app.prisma, p.user.id, plain.tenant.id)).toEqual(
        [],
      );

      const res = await login(p.email);

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual(NO_ROLE_ASSIGNED_ERROR);
    });

    it("control: an assigned user signs in exactly as before, with a non-empty permissions list", async () => {
      const p = await createPerson(plain, "Mit Rolle", "EMPLOYEE");

      const res = await login(p.email);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.accessToken).toEqual(expect.any(String));
      expect(body.user.permissions.length).toBeGreaterThan(0);
      expect(await loginRefusedRows(p.user.id)).toHaveLength(0);
      expect(await auditRowsFor(app, "User", p.user.id, "LOGIN")).toHaveLength(1);
    });
  });

  describe("verify-otp", () => {
    it("an assigned user in a 2FA tenant gets 202; once its assignment is gone the mailed code yields 403 and no token", async () => {
      const codes: string[] = [];
      vi.spyOn(app.mailer, "sendOtp").mockImplementation((async (input: { code: string }) => {
        codes.push(input.code);
      }) as never);
      const p = await createPerson(twoFa, "OTP Entzogen", "EMPLOYEE");

      const first = await login(p.email);
      expect(first.statusCode).toBe(202);
      expect(codes).toHaveLength(1);

      await removeFixtureRoleAssignments(app.prisma, [p.user.id]);

      const res = await post("/api/v1/auth/verify-otp", { userId: p.user.id, code: codes[0] });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body).toEqual(NO_ROLE_ASSIGNED_ERROR);
      expect(body.accessToken).toBeUndefined();
      expect(await refreshRows(p.user.id)).toHaveLength(0);
    });

    it("control: the same flow with the assignment kept issues the tokens", async () => {
      const codes: string[] = [];
      vi.spyOn(app.mailer, "sendOtp").mockImplementation((async (input: { code: string }) => {
        codes.push(input.code);
      }) as never);
      const p = await createPerson(twoFa, "OTP Behalten", "EMPLOYEE");

      expect((await login(p.email)).statusCode).toBe(202);
      const res = await post("/api/v1/auth/verify-otp", { userId: p.user.id, code: codes[0] });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).accessToken).toEqual(expect.any(String));
    });
  });

  describe("refresh", () => {
    it("after the last role is revoked the refresh answers 403 and the stored token is neither revoked nor joined by a new one", async () => {
      const p = await createPerson(plain, "Refresh Entzogen", "EMPLOYEE");
      const signedIn = await login(p.email);
      expect(signedIn.statusCode).toBe(200);
      const refreshToken = JSON.parse(signedIn.body).refreshToken as string;

      const before = await refreshRows(p.user.id);
      expect(before).toHaveLength(1);
      expect(before[0].revokedAt).toBeNull();

      await removeFixtureRoleAssignments(app.prisma, [p.user.id]);

      const res = await post("/api/v1/auth/refresh", { refreshToken });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body).toEqual(NO_ROLE_ASSIGNED_ERROR);
      expect(body.accessToken).toBeUndefined();
      const after = await refreshRows(p.user.id);
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(before[0].id);
      expect(after[0].revokedAt).toBeNull();
      // Pattern of #551: only the login refusal writes an audit row.
      expect(await loginRefusedRows(p.user.id)).toHaveLength(0);
    });

    it("control: an assigned user's refresh rotates and returns the permissions list", async () => {
      const p = await createPerson(plain, "Refresh Behalten", "EMPLOYEE");
      const signedIn = await login(p.email);
      const refreshToken = JSON.parse(signedIn.body).refreshToken as string;

      const res = await post("/api/v1/auth/refresh", { refreshToken });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.accessToken).toEqual(expect.any(String));
      expect(body.permissions.length).toBeGreaterThan(0);
      expect((await refreshRows(p.user.id)).length).toBe(2);
    });
  });

  describe("reactivation", () => {
    it("a reactivated person without a stored role is refused until the admin sets a role, then signs in", async () => {
      const p = await createPerson(plain, "Reaktiviert", undefined, false);
      await app.prisma.employee.update({
        where: { id: p.employee.id },
        data: { exitDate: new Date("2025-01-01") },
      });

      const reactivate = await app.inject({
        method: "PATCH",
        url: `/api/v1/employees/${p.employee.id}/reactivate`,
        headers: { authorization: `Bearer ${plain.adminToken}` },
        payload: {},
        remoteAddress: uniqueAddress(),
      });
      expect(reactivate.statusCode).toBe(200);

      const refused = await login(p.email);
      expect(refused.statusCode).toBe(403);
      expect(JSON.parse(refused.body)).toEqual(NO_ROLE_ASSIGNED_ERROR);

      const setRole = await app.inject({
        method: "PATCH",
        url: `/api/v1/employees/${p.employee.id}`,
        headers: { authorization: `Bearer ${plain.adminToken}` },
        payload: { role: "EMPLOYEE" },
        remoteAddress: uniqueAddress(),
      });
      expect(setRole.statusCode).toBe(200);

      const allowed = await login(p.email);
      expect(allowed.statusCode).toBe(200);
      expect(JSON.parse(allowed.body).user.permissions.length).toBeGreaterThan(0);
    });
  });
});
