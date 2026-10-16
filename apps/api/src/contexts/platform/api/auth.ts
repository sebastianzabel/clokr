import { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import crypto, { createHash } from "crypto";
import { z } from "zod";
import { JwtPayload } from "../../../middleware/auth";
import { validatePassword, loadPasswordPolicy } from "../password-policy";
import { NO_ROLE_ASSIGNED_ERROR, effectivePermissionKeysForUser } from "../request-permissions"; // Phase 378 (#378); #539 (D-14)
import { userIdsHoldingPermission, resolveScopedHolderIds } from "../facade/role-assignments"; // Phase 75b Plan 10 (#75), D-16/D-17; Phase 91b Plan 09 (#91), D-17
import { isStammsalonScopeMatch } from "../scope-filter"; // Phase 91b Plan 09 (#91), D-10/D-17
import { readTenantTimezone } from "../facade/salon-assignments";
import { dayToDate, tenantLocalDay } from "../salon-assignment-rules";
import { config } from "../../../config";
import {
  TENANT_DEACTIVATED_ERROR,
  TENANT_REQUIRED_ERROR,
  isBlankTenantId,
  isTenantRowActive,
} from "../tenant-status"; // Phase 88 (#88), AC-88-08; #551 (a principal without a tenant gets no token)

/** SHA-256 hash for tokens stored in DB (refresh tokens, reset tokens). */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const refreshSchema = z.object({
  refreshToken: z.string(),
});

const verifyOtpSchema = z.object({
  userId: z.string(),
  code: z.string().length(6),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

export async function authRoutes(app: FastifyInstance) {
  // POST /api/v1/auth/login
  app.post("/login", {
    config: { rateLimit: { max: config.NODE_ENV === "test" ? 1000 : 50, timeWindow: "1 minute" } },
    schema: {
      tags: ["Auth"],
      body: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const { email, password } = loginSchema.parse(req.body);

      const user = await app.prisma.user.findUnique({
        where: { email },
        include: { employee: { include: { tenant: { include: { config: true } } } } },
      });

      if (!user || !user.isActive) {
        return reply.code(401).send({ error: "Ungültige Anmeldedaten" });
      }

      // Account-Lockout check
      const tenantCfg = user.employee?.tenant?.config;
      const maxAttempts = tenantCfg?.loginMaxAttempts ?? 5;
      const lockoutMinutes = tenantCfg?.loginLockoutMinutes ?? 15;

      if (user.lockedUntil && user.lockedUntil > new Date()) {
        const remainingMs = user.lockedUntil.getTime() - Date.now();
        const remainingMin = Math.ceil(remainingMs / 60000);
        await app.audit({ action: "LOGIN_LOCKED", entity: "User", entityId: user.id });
        return reply.code(423).send({
          error: `Konto temporär gesperrt. Erneuter Versuch in ${remainingMin} Minuten.`,
          lockedUntil: user.lockedUntil.toISOString(),
          remainingMinutes: remainingMin,
        });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        // Reset counter (and clear the stale lockedUntil) if the previous lock window
        // has expired — keeps the policy time-windowed instead of permanently sticky
        // after the first lockout.
        let baseCount = user.failedLoginAttempts;
        const lockExpired = user.lockedUntil != null && user.lockedUntil <= new Date();
        if (lockExpired) {
          baseCount = 0;
        }
        const attempts = baseCount + 1;
        const lockData: {
          failedLoginAttempts: number;
          lastFailedLoginAt: Date;
          lockedUntil?: Date | null;
        } = {
          failedLoginAttempts: attempts,
          lastFailedLoginAt: new Date(),
        };
        if (lockExpired) {
          lockData.lockedUntil = null;
        }

        // Lock account if max attempts reached
        if (attempts >= maxAttempts) {
          lockData.lockedUntil = new Date(Date.now() + lockoutMinutes * 60 * 1000);
          await app.audit({
            action: "ACCOUNT_LOCKED",
            entity: "User",
            entityId: user.id,
            newValue: { attempts, lockoutMinutes },
          });

          // Notify admins. Phase 75b Plan 10 (#75), D-16/D-17: holders of
          // employee:manage-access (unlock is part of it) replace the legacy Admin-only role
          // predicate — the recorded recipient set is unchanged; the user.employee guard (no
          // tenant to scope by otherwise) is unchanged.
          const admins = user.employee
            ? await (async () => {
                const employeeManageAccessHolderIds = await userIdsHoldingPermission(
                  app.prisma,
                  user.employee!.tenantId,
                  "employee:manage-access:ZUGEWIESEN",
                );
                // Phase 91b Plan 09 (Issue #91), D-17: `employee` is a PERSON-relation
                // permission — narrow to holders whose OWN reach covers the LOCKED-OUT
                // employee, Stammsalon-only (D-10), Stichtag = today (a live access-management
                // action, no other natural period).
                const tz = await readTenantTimezone(app.prisma, user.employee!.tenantId);
                const todayDate = dayToDate(tenantLocalDay(new Date(), tz));
                const scopedEmployeeManageAccessHolderIds = await resolveScopedHolderIds(
                  app.prisma,
                  user.employee!.tenantId,
                  employeeManageAccessHolderIds,
                  "employee:manage-access:ZUGEWIESEN",
                  (reach) =>
                    isStammsalonScopeMatch(
                      app.prisma,
                      user.employee!.tenantId,
                      reach,
                      user.employee!.id,
                      todayDate,
                    ),
                );
                return app.prisma.user.findMany({
                  where: {
                    id: { in: scopedEmployeeManageAccessHolderIds },
                    isActive: true,
                    employee: { tenantId: user.employee!.tenantId },
                  },
                  select: { id: true },
                });
              })()
            : [];
          for (const admin of admins) {
            await app.notify({
              userId: admin.id,
              type: "ACCOUNT_LOCKED",
              title: "Konto gesperrt",
              message: `${user.email} wurde nach ${attempts} Fehlversuchen für ${lockoutMinutes} Minuten gesperrt.`,
              tenantId: user.employee?.tenantId,
            });
          }
        }

        await app.prisma.user.update({ where: { id: user.id }, data: lockData });
        await app.audit({ action: "LOGIN_FAILED", entity: "User", entityId: user.id });
        return reply.code(401).send({ error: "Ungültige Anmeldedaten" });
      }

      // Successful login — reset lockout counter
      if (user.failedLoginAttempts > 0 || user.lockedUntil) {
        await app.prisma.user.update({
          where: { id: user.id },
          data: { failedLoginAttempts: 0, lockedUntil: null, lastFailedLoginAt: null },
        });
      }

      // Phase 88 (AC-88-08): a deactivated tenant's users cannot sign in. The check sits AFTER the
      // password comparison on purpose — a wrong password keeps the unchanged 401, so an
      // unauthenticated caller learns nothing about the tenant's state. The refusal is the user's own
      // action, so it lands in the tenant AuditLog.
      if (!isTenantRowActive(user.employee?.tenant)) {
        await app.audit({
          userId: user.id,
          action: "LOGIN_REFUSED",
          entity: "User",
          entityId: user.id,
          newValue: { reason: "TENANT_DEACTIVATED" },
          request: { ip: req.ip, headers: req.headers },
        });
        return reply.code(403).send(TENANT_DEACTIVATED_ERROR);
      }

      // Issue #551 (D-02): a user without an Employee has no tenant and gets no token. Same position
      // as the refusal above — after the password matched (a wrong password keeps the unchanged 401,
      // no oracle) and before any OTP is created or mailed.
      if (isBlankTenantId(user.employee?.tenantId)) {
        await app.audit({
          userId: user.id,
          action: "LOGIN_REFUSED",
          entity: "User",
          entityId: user.id,
          newValue: { reason: "TENANT_REQUIRED" },
          request: { ip: req.ip, headers: req.headers },
        });
        return reply.code(403).send(TENANT_REQUIRED_ERROR);
      }

      // Issue #539 (D-14): an active account whose effective permission set is empty (no stored role
      // assignment, or only roles that grant nothing) is refused instead of being signed into an
      // app where every request answers 403. Same position as the #551 refusal above - after the
      // password matched (a wrong password keeps the unchanged 401, no account-state oracle) and
      // before any OTP is created or mailed. The list is computed once here and handed to
      // issueTokens.
      const permissions = await effectivePermissionKeysForUser(
        app.prisma,
        user.id,
        user.employee?.tenantId ?? "",
      );
      if (permissions.length === 0) {
        await app.audit({
          userId: user.id,
          action: "LOGIN_REFUSED",
          entity: "User",
          entityId: user.id,
          newValue: { reason: "NO_ROLE_ASSIGNED" },
          request: { ip: req.ip, headers: req.headers },
        });
        return reply.code(403).send(NO_ROLE_ASSIGNED_ERROR);
      }

      // 2FA prüfen
      const twoFaEnabled = user.employee?.tenant?.config?.twoFaEnabled ?? false;
      if (twoFaEnabled) {
        // Alte OTP-Tokens invalidieren
        await app.prisma.otpToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        });

        // Neuen Code generieren
        const code = Math.floor(100000 + crypto.randomInt(900000)).toString();
        const codeHash = await bcrypt.hash(code, 10);

        await app.prisma.otpToken.create({
          data: {
            userId: user.id,
            code: codeHash,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          },
        });

        // OTP-Mail senden (Fire-and-forget bei Mail-Fehler)
        try {
          await app.mailer.sendOtp({
            to: user.email,
            firstName: user.employee?.firstName ?? user.email,
            code,
            tenantId: user.employee?.tenantId ?? "",
          });
        } catch (err) {
          app.log.error({ err }, "OTP-Mail konnte nicht gesendet werden");
        }

        return reply.code(202).send({ requiresOtp: true, userId: user.id });
      }

      return issueTokens(app, req, reply, user, permissions);
    },
  });

  // POST /api/v1/auth/verify-otp
  app.post("/verify-otp", {
    config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
    schema: { tags: ["Auth"] },
    handler: async (req, reply) => {
      const { userId, code } = verifyOtpSchema.parse(req.body);

      const token = await app.prisma.otpToken.findFirst({
        where: { userId, usedAt: null },
        orderBy: { createdAt: "desc" },
      });

      if (!token) {
        return reply.code(401).send({ error: "Kein gültiger Code gefunden" });
      }

      if (token.expiresAt < new Date()) {
        return reply.code(410).send({ error: "Code abgelaufen. Bitte neu anmelden." });
      }

      const valid = await bcrypt.compare(code, token.code);
      if (!valid) {
        return reply.code(401).send({ error: "Ungültiger Code" });
      }

      await app.prisma.otpToken.update({
        where: { id: token.id },
        data: { usedAt: new Date() },
      });

      const user = await app.prisma.user.findUnique({
        where: { id: userId },
        include: { employee: { include: { tenant: { select: { deactivatedAt: true } } } } },
      });

      if (!user || !user.isActive) {
        return reply.code(401).send({ error: "Benutzer nicht gefunden" });
      }

      // Phase 88 (AC-88-08): the code matched, but a deactivated tenant gets no tokens.
      if (!isTenantRowActive(user.employee?.tenant)) {
        return reply.code(403).send(TENANT_DEACTIVATED_ERROR);
      }

      // Issue #551 (D-02): no token for a user without a tenant.
      if (isBlankTenantId(user.employee?.tenantId)) {
        return reply.code(403).send(TENANT_REQUIRED_ERROR);
      }

      // Issue #539 (D-14): the code matched, but an account without any effective permission gets no
      // tokens (e.g. its last role was revoked between login and code entry). No second audit row -
      // the login already wrote its own refusal (pattern of #551).
      const permissions = await effectivePermissionKeysForUser(
        app.prisma,
        user.id,
        user.employee?.tenantId ?? "",
      );
      if (permissions.length === 0) {
        return reply.code(403).send(NO_ROLE_ASSIGNED_ERROR);
      }

      return issueTokens(app, req, reply, user, permissions);
    },
  });

  // POST /api/v1/auth/resend-otp
  app.post("/resend-otp", {
    config: { rateLimit: { max: 3, timeWindow: "5 minutes" } },
    schema: { tags: ["Auth"] },
    handler: async (req, reply) => {
      const { userId } = z.object({ userId: z.string() }).parse(req.body);

      const user = await app.prisma.user.findUnique({
        where: { id: userId },
        include: { employee: { include: { tenant: { select: { deactivatedAt: true } } } } },
      });

      if (!user || !user.isActive) {
        return reply.code(404).send({ error: "Benutzer nicht gefunden" });
      }

      // Phase 88 (AC-88-08): refuse before a code is created or any mail is sent.
      if (!isTenantRowActive(user.employee?.tenant)) {
        return reply.code(403).send(TENANT_DEACTIVATED_ERROR);
      }

      // Issue #551 (D-02): same ordering — no code is created and no mail is sent for a user without
      // a tenant.
      if (isBlankTenantId(user.employee?.tenantId)) {
        return reply.code(403).send(TENANT_REQUIRED_ERROR);
      }

      // Alte Tokens invalidieren
      await app.prisma.otpToken.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: new Date() },
      });

      const code = Math.floor(100000 + crypto.randomInt(900000)).toString();
      const codeHash = await bcrypt.hash(code, 10);

      await app.prisma.otpToken.create({
        data: {
          userId,
          code: codeHash,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      try {
        await app.mailer.sendOtp({
          to: user.email,
          firstName: user.employee?.firstName ?? user.email,
          code,
          tenantId: user.employee?.tenantId ?? "",
        });
      } catch (err) {
        app.log.error({ err }, "OTP-Mail konnte nicht gesendet werden");
        return reply.code(502).send({ error: "E-Mail konnte nicht gesendet werden" });
      }

      return { success: true };
    },
  });

  // POST /api/v1/auth/refresh
  app.post("/refresh", {
    schema: { tags: ["Auth"] },
    handler: async (req, reply) => {
      const { refreshToken } = refreshSchema.parse(req.body);

      const stored = await app.prisma.refreshToken.findUnique({
        where: { token: hashToken(refreshToken) },
        include: {
          user: {
            include: { employee: { include: { tenant: { select: { deactivatedAt: true } } } } },
          },
        },
      });

      if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
        return reply.code(401).send({ error: "Ungültiger Refresh Token" });
      }

      // Phase 88 (AC-88-08): a deactivated tenant's session cannot be renewed. Checked BEFORE the
      // rotation below, so the stored token is left exactly as it was.
      if (!isTenantRowActive(stored.user.employee?.tenant)) {
        return reply.code(403).send(TENANT_DEACTIVATED_ERROR);
      }

      // Issue #551 (D-02): a user without a tenant cannot renew a session either. Also BEFORE the
      // rotation, so the stored token stays exactly as it was (neither revoked nor rotated).
      if (isBlankTenantId(stored.user.employee?.tenantId)) {
        return reply.code(403).send(TENANT_REQUIRED_ERROR);
      }

      // Issue #539 (D-14): a session whose last role was revoked cannot be renewed. Computed BEFORE
      // the rotation (like the refusals above), so the stored token stays exactly as it was - the
      // role revocation itself was audited. The same list is returned below.
      // The #551 refusal above guarantees an Employee, hence a non-blank tenant.
      const tenantId = stored.user.employee?.tenantId ?? "";
      const permissions = await effectivePermissionKeysForUser(
        app.prisma,
        stored.user.id,
        tenantId,
      );
      if (permissions.length === 0) {
        return reply.code(403).send(NO_ROLE_ASSIGNED_ERROR);
      }

      // Rotate refresh token
      await app.prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      });

      // Phase 408 (#408): /auth/refresh is the only round-trip a running or restored session makes
      // by itself, so it carries the same effective-permissions list login/verify-otp already
      // compute (see the #539 refusal above).

      // Issue #539 (D-05): no role claim - an old refresh token's claim is not carried over.
      const payload: JwtPayload = {
        sub: stored.user.id,
        tenantId,
        employeeId: stored.user.employee?.id,
      };

      const newAccessToken = app.jwt.sign(payload);
      // Add jti to ensure uniqueness even when payload and timestamp are identical
      const newRefreshToken = app.jwt.sign(
        { ...payload, jti: crypto.randomUUID() } as JwtPayload & { jti: string },
        {
          expiresIn: "7d",
        },
      );

      await app.prisma.refreshToken.create({
        data: {
          token: hashToken(newRefreshToken),
          userId: stored.user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      return { accessToken: newAccessToken, refreshToken: newRefreshToken, permissions };
    },
  });

  // POST /api/v1/auth/logout
  app.post("/logout", {
    schema: { tags: ["Auth"] },
    handler: async (req, _reply) => {
      const { refreshToken } = refreshSchema.parse(req.body);
      await app.prisma.refreshToken.updateMany({
        where: { token: hashToken(refreshToken) },
        data: { revokedAt: new Date() },
      });
      return { success: true };
    },
  });

  // POST /api/v1/auth/forgot-password
  app.post("/forgot-password", {
    config: { rateLimit: { max: 3, timeWindow: "15 minutes" } },
    schema: { tags: ["Auth"] },
    handler: async (req, _reply) => {
      const { email } = forgotPasswordSchema.parse(req.body);

      const user = await app.prisma.user.findUnique({
        where: { email },
        include: { employee: { include: { tenant: { select: { deactivatedAt: true } } } } },
      });

      // Always return success to avoid leaking user existence
      if (!user || !user.isActive) {
        return { success: true };
      }

      // Phase 88 (AC-88-08): a deactivated tenant's user gets no reset mail and no stored token. The
      // answer stays the same `{ success: true }`, so the no-enumeration property holds.
      if (!isTenantRowActive(user.employee?.tenant)) {
        return { success: true };
      }

      // Invalidate previous reset tokens
      await app.prisma.otpToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      // Generate reset token — store hash, send raw
      const rawToken = crypto.randomBytes(32).toString("hex");

      await app.prisma.otpToken.create({
        data: {
          userId: user.id,
          code: hashToken(rawToken),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
        },
      });

      // Send reset email (fire-and-forget on mail error)
      try {
        await app.mailer.sendPasswordReset({
          to: user.email,
          firstName: user.employee?.firstName ?? user.email,
          token: rawToken,
          tenantId: user.employee?.tenantId ?? "",
        });
      } catch (err) {
        app.log.error({ err }, "Passwort-Reset-Mail konnte nicht gesendet werden");
      }

      return { success: true };
    },
  });

  // POST /api/v1/auth/reset-password
  app.post("/reset-password", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    schema: { tags: ["Auth"] },
    handler: async (req, reply) => {
      const { token, password } = resetPasswordSchema.parse(req.body);

      const otpToken = await app.prisma.otpToken.findFirst({
        where: { code: hashToken(token), usedAt: null },
      });

      if (!otpToken) {
        return reply.code(400).send({ error: "Ungültiger oder abgelaufener Link" });
      }

      if (otpToken.expiresAt < new Date()) {
        return reply
          .code(410)
          .send({ error: "Der Link ist abgelaufen. Bitte fordern Sie einen neuen an." });
      }

      // Load tenant password policy for the user
      const resetUser = await app.prisma.user.findUnique({
        where: { id: otpToken.userId },
        include: { employee: { include: { tenant: { select: { deactivatedAt: true } } } } },
      });
      // Phase 88 (AC-88-08): a reset token issued before the deactivation must not set a password.
      if (resetUser && !isTenantRowActive(resetUser.employee?.tenant)) {
        return reply.code(403).send(TENANT_DEACTIVATED_ERROR);
      }
      if (resetUser?.employee?.tenantId) {
        const policy = await loadPasswordPolicy(app, resetUser.employee.tenantId);
        const check = validatePassword(password, policy);
        if (!check.valid) {
          return reply.code(400).send({ error: check.errors.join(". ") });
        }
      }

      const passwordHash = await bcrypt.hash(password, 12);

      // Update password and clear any active lock state so the user can log in immediately
      await app.prisma.user.update({
        where: { id: otpToken.userId },
        data: {
          passwordHash,
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastFailedLoginAt: null,
        },
      });

      // Mark token as used
      await app.prisma.otpToken.update({
        where: { id: otpToken.id },
        data: { usedAt: new Date() },
      });

      // Revoke all refresh tokens for user
      await app.prisma.refreshToken.updateMany({
        where: { userId: otpToken.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await app.audit({
        userId: otpToken.userId,
        action: "PASSWORD_RESET",
        entity: "User",
        entityId: otpToken.userId,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return { success: true };
    },
  });

  // GET /api/v1/auth/password-policy — public, returns policy for the default tenant
  // Used by invitation/reset pages to show password requirements
  app.get("/password-policy", {
    schema: { tags: ["Auth"] },
    handler: async () => {
      const tenant = await app.prisma.tenant.findFirst({
        include: { config: true },
      });
      const cfg = tenant?.config;
      return {
        passwordMinLength: cfg?.passwordMinLength ?? 12,
        passwordRequireUpper: cfg?.passwordRequireUpper ?? true,
        passwordRequireLower: cfg?.passwordRequireLower ?? true,
        passwordRequireDigit: cfg?.passwordRequireDigit ?? true,
        passwordRequireSpecial: cfg?.passwordRequireSpecial ?? true,
      };
    },
  });

  // POST /api/v1/auth/change-password — authenticated user changes own password
  app.post("/change-password", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    schema: { tags: ["Auth"], security: [{ bearerAuth: [] }] },
    preHandler: async (req, reply) => {
      try {
        await req.jwtVerify();
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      // Issue #551 (D-02): this route has its own preHandler and bypasses `requireAuth`, so it is the
      // one tenant-token route the central gate does not cover. A token without a tenant is refused
      // here with the same body.
      if (isBlankTenantId((req.user as { tenantId?: unknown }).tenantId)) {
        return reply.code(403).send(TENANT_REQUIRED_ERROR);
      }
    },
    handler: async (req, reply) => {
      const body = z
        .object({
          currentPassword: z.string().min(1),
          newPassword: z.string().min(8),
        })
        .parse(req.body);

      const user = await app.prisma.user.findUnique({
        where: { id: req.user.sub },
        include: { employee: { include: { tenant: { select: { deactivatedAt: true } } } } },
      });
      if (!user) return reply.code(404).send({ error: "Benutzer nicht gefunden" });

      // Phase 88 (AC-88-08): the access token is still signature-valid after a deactivation, so the
      // credential change is refused here.
      if (!isTenantRowActive(user.employee?.tenant)) {
        return reply.code(403).send(TENANT_DEACTIVATED_ERROR);
      }

      const valid = await bcrypt.compare(body.currentPassword, user.passwordHash);
      if (!valid) return reply.code(400).send({ error: "Aktuelles Passwort ist falsch" });

      // Validate against tenant password policy
      if (user.employee?.tenantId) {
        const policy = await loadPasswordPolicy(app, user.employee.tenantId);
        const check = validatePassword(body.newPassword, policy);
        if (!check.valid) {
          return reply.code(400).send({ error: check.errors.join(". ") });
        }
      }

      const passwordHash = await bcrypt.hash(body.newPassword, 12);
      await app.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

      await app.audit({
        userId: user.id,
        action: "PASSWORD_CHANGE",
        entity: "User",
        entityId: user.id,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return { success: true };
    },
  });
}

// ─── Helper ───────────────────────────────────────────────────────────────────

async function issueTokens(
  app: FastifyInstance,
  req: { ip: string; headers: Record<string, string | string[] | undefined>; body?: unknown },
  reply: { send: (data: unknown) => unknown },
  user: {
    id: string;
    email: string;
    employee: { id: string; tenantId: string; firstName: string } | null;
  },
  // Issue #539 (D-14): the effective permission keys, computed ONCE by the caller (which refused an
  // empty set with NO_ROLE_ASSIGNED before getting here).
  permissions: readonly string[],
) {
  const tenantId = user.employee?.tenantId ?? "";
  // Issue #551 (D-02): never sign a token without a tenant. Both callers (login, verify-otp) refuse
  // such a user earlier with 403 TENANT_REQUIRED, so reaching this is a programming error (→ the
  // global 500 handler), not a client condition.
  if (isBlankTenantId(tenantId)) {
    throw new Error("issueTokens: refusing to sign a token without a tenant (#551)");
  }

  // Load session config from tenant
  const tenantConfig = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });

  const rememberMe = (req.body as { rememberMe?: boolean })?.rememberMe === true;
  const refreshDays = rememberMe
    ? (tenantConfig?.rememberMeDays ?? 30)
    : (tenantConfig?.refreshTokenDays ?? 7);

  // Issue #539 (D-05): the token and the body carry no role. The web decides by the effective
  // permission list (Phase 378, #378), computed by the caller at login/OTP-verify AND on every
  // `/auth/refresh` (Phase 408, #408).
  const payload: JwtPayload = {
    sub: user.id,
    tenantId,
    employeeId: user.employee?.id,
  };

  const accessToken = app.jwt.sign(payload);
  const refreshToken = app.jwt.sign(
    { ...payload, jti: crypto.randomUUID() } as JwtPayload & { jti: string },
    {
      expiresIn: `${refreshDays}d`,
    },
  );

  // Enforce max sessions per user
  const maxSessions = tenantConfig?.maxSessionsPerUser ?? 0;
  if (maxSessions > 0) {
    const activeSessions = await app.prisma.refreshToken.findMany({
      where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "asc" },
    });
    // Revoke oldest sessions if over limit (keep maxSessions - 1 to make room for new one)
    if (activeSessions.length >= maxSessions) {
      const toRevoke = activeSessions.slice(0, activeSessions.length - maxSessions + 1);
      await app.prisma.refreshToken.updateMany({
        where: { id: { in: toRevoke.map((s) => s.id) } },
        data: { revokedAt: new Date() },
      });
    }
  }

  await app.prisma.refreshToken.create({
    data: {
      token: hashToken(refreshToken),
      userId: user.id,
      expiresAt: new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000),
    },
  });

  await app.prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  await app.audit({
    userId: user.id,
    action: "LOGIN",
    entity: "User",
    entityId: user.id,
    request: { ip: req.ip, headers: req.headers as Record<string, string> },
  });

  return reply.send({
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      employeeId: user.employee?.id ?? null,
      firstName: user.employee?.firstName ?? null,
      // Phase 378 (#378): effective permission keys, for web-side visibility decisions.
      permissions,
    },
    sessionConfig: {
      sessionTimeoutMinutes: tenantConfig?.sessionTimeoutMinutes ?? 60,
      rememberMeEnabled: tenantConfig?.rememberMeEnabled ?? true,
    },
  });
}
