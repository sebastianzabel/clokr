import { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import { Role } from "@clokr/db";

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

export async function authRoutes(app: FastifyInstance) {
  // POST /api/v1/auth/login
  app.post("/login", {
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

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        await app.audit({ action: "LOGIN_FAILED", entity: "User", entityId: user.id });
        return reply.code(401).send({ error: "Ungültige Anmeldedaten" });
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
        where: { token: refreshToken },
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
      const newRefreshToken = app.jwt.sign(payload, { expiresIn: "7d" });

      await app.prisma.refreshToken.create({
        data: {
          token: newRefreshToken,
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
    handler: async (req, reply) => {
      const { refreshToken } = refreshSchema.parse(req.body);
      await app.prisma.refreshToken.updateMany({
        where: { token: refreshToken },
        data: { revokedAt: new Date() },
      });
      return { success: true };
    },
  });
}

// ─── Helper ───────────────────────────────────────────────────────────────────

async function issueTokens(
  app: FastifyInstance,
  req: { ip: string; headers: Record<string, string | string[] | undefined> },
  reply: { send: (data: unknown) => unknown },
  user: { id: string; email: string; role: Role; employee: { id: string; tenantId: string } | null }
) {
  const payload = {
    sub: user.id,
    role: user.role,
    tenantId: user.employee?.tenantId ?? "",
    employeeId: user.employee?.id,
  };

  const accessToken = app.jwt.sign(payload);
  // Add jti (JWT ID) to ensure uniqueness even for same-second tokens
  const refreshToken = app.jwt.sign(
    { ...payload, jti: crypto.randomUUID() },
    { expiresIn: "7d" },
  );

  await app.prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId: user.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
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
    user: { id: user.id, email: user.email, role: user.role, employeeId: user.employee?.id ?? null },
  });
}
