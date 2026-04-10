import { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import crypto, { createHash } from "crypto";
import { z } from "zod";
import { Role } from "@clokr/db";
import { JwtPayload } from "../middleware/auth";
import { validatePassword, loadPasswordPolicy } from "../utils/password-policy";

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
  const isTest = process.env.NODE_ENV === "test";

  app.post("/login", {
    config: { rateLimit: { max: isTest ? 1000 : 50, timeWindow: "1 minute" } },
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
        const attempts = user.failedLoginAttempts + 1;
        const lockData: {
          failedLoginAttempts: number;
          lastFailedLoginAt: Date;
          lockedUntil?: Date;
        } = {
          failedLoginAttempts: attempts,
          lastFailedLoginAt: new Date(),
        };

        // Lock account if max attempts reached
        if (attempts >= maxAttempts) {
          lockData.lockedUntil = new Date(Date.now() + lockoutMinutes * 60 * 1000);
          await app.audit({
            action: "ACCOUNT_LOCKED",
            entity: "User",
            entityId: user.id,
            newValue: { attempts, lockoutMinutes },
          });

          // Notify admins
          const admins = user.employee
            ? await app.prisma.user.findMany({
                where: {
                  role: "ADMIN",
                  isActive: true,
                  employee: { tenantId: user.employee.tenantId },
                },
                select: { id: true },
              })
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

      return issueTokens(app, req, reply, user);
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
        include: { employee: true },
      });

      if (!user || !user.isActive) {
        return reply.code(401).send({ error: "Benutzer nicht gefunden" });
      }

      return issueTokens(app, req, reply, user);
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
        include: { employee: true },
      });

      if (!user || !user.isActive) {
        return reply.code(404).send({ error: "Benutzer nicht gefunden" });
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
        include: { user: { include: { employee: true } } },
      });

      if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
        return reply.code(401).send({ error: "Ungültiger Refresh Token" });
      }

      // Rotate refresh token
      await app.prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      });

      const payload = {
        sub: stored.user.id,
        role: stored.user.role,
        tenantId: stored.user.employee?.tenantId ?? "",
        employeeId: stored.user.employee?.id,
      };

      const newAccessToken = app.jwt.sign(payload);
      // Add jti to ensure uniqueness even when payload and timestamp are identical
      const newRefreshToken = app.jwt.sign({ ...payload, jti: crypto.randomUUID() } as JwtPayload & { jti: string }, {
        expiresIn: "7d",
      });

      await app.prisma.refreshToken.create({
        data: {
          token: hashToken(newRefreshToken),
          userId: stored.user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      return { accessToken: newAccessToken, refreshToken: newRefreshToken };
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
        include: { employee: true },
      });

      // Always return success to avoid leaking user existence
      if (!user || !user.isActive) {
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
        include: { employee: true },
      });
      if (resetUser?.employee?.tenantId) {
        const policy = await loadPasswordPolicy(app, resetUser.employee.tenantId);
        const check = validatePassword(password, policy);
        if (!check.valid) {
          return reply.code(400).send({ error: check.errors.join(". ") });
        }
      }

      const passwordHash = await bcrypt.hash(password, 12);

      // Update password
      await app.prisma.user.update({
        where: { id: otpToken.userId },
        data: { passwordHash },
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
        include: { employee: true },
      });
      if (!user) return reply.code(404).send({ error: "Benutzer nicht gefunden" });

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
    role: Role;
    employee: { id: string; tenantId: string; firstName: string } | null;
  },
) {
  const tenantId = user.employee?.tenantId ?? "";

  // Load session config from tenant
  const tenantConfig = tenantId
    ? await app.prisma.tenantConfig.findUnique({ where: { tenantId } })
    : null;

  const rememberMe = (req.body as { rememberMe?: boolean })?.rememberMe === true;
  const refreshDays = rememberMe
    ? (tenantConfig?.rememberMeDays ?? 30)
    : (tenantConfig?.refreshTokenDays ?? 7);

  const payload = {
    sub: user.id,
    role: user.role,
    tenantId,
    employeeId: user.employee?.id,
  };

  const accessToken = app.jwt.sign(payload);
  const refreshToken = app.jwt.sign({ ...payload, jti: crypto.randomUUID() } as JwtPayload & { jti: string }, {
    expiresIn: `${refreshDays}d`,
  });

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
      role: user.role,
      employeeId: user.employee?.id ?? null,
      firstName: user.employee?.firstName ?? null,
    },
    sessionConfig: {
      sessionTimeoutMinutes: tenantConfig?.sessionTimeoutMinutes ?? 60,
      rememberMeEnabled: tenantConfig?.rememberMeEnabled ?? true,
    },
  });
}
