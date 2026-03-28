import crypto from "crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { config } from "./config";
import { authRoutes } from "./routes/auth";
import { employeeRoutes } from "./routes/employees";
import { timeEntryRoutes } from "./routes/time-entries";
import { leaveRoutes } from "./routes/leave";
import { overtimeRoutes } from "./routes/overtime";
import { reportRoutes } from "./routes/reports";
import { settingsRoutes } from "./routes/settings";
import { holidayRoutes } from "./routes/holidays";
import { auditPlugin } from "./plugins/audit";
import { prismaPlugin } from "./plugins/prisma";
import { mailerPlugin } from "./plugins/mailer";
import { notifyPlugin } from "./plugins/notify";
import { schedulerPlugin } from "./plugins/scheduler";
import { attendanceCheckerPlugin } from "./plugins/attendance-checker";
import { dataRetentionPlugin } from "./plugins/data-retention";
import { autoCloseMonthPlugin } from "./plugins/auto-close-month";
import { storagePlugin } from "./plugins/storage";
import multipart from "@fastify/multipart";
import { notificationRoutes } from "./routes/notifications";
import { invitationRoutes } from "./routes/invitations";
import { auditLogRoutes } from "./routes/audit-logs";
import { companyShutdownRoutes } from "./routes/company-shutdowns";
import { dashboardRoutes } from "./routes/dashboard";
import { shiftRoutes } from "./routes/shifts";
import { integrationRoutes } from "./routes/integrations";
import { importRoutes } from "./routes/imports";
import { terminalRoutes } from "./routes/terminals";
import { specialLeaveRoutes } from "./routes/special-leave";
import { avatarRoutes } from "./routes/avatars";
import { apiKeyRoutes } from "./routes/api-keys";

export async function buildApp() {
  // ── Logger configuration ──────────────────────────────────
  const logLevel = config.LOG_LEVEL ?? (config.NODE_ENV === "production" ? "info" : "debug");
  const logFormat = config.LOG_FORMAT ?? (config.NODE_ENV === "production" ? "json" : "pretty");

  const loggerConfig: Record<string, unknown> = { level: logLevel };

  if (logFormat === "pretty") {
    loggerConfig.transport = { target: "pino-pretty", options: { colorize: true } };
  } else if (logFormat === "ecs") {
    // ECS format: use pino-based serializers for Elastic Common Schema
    loggerConfig.messageKey = "message";
    loggerConfig.timestamp = () => `,"@timestamp":"${new Date().toISOString()}"`;
    loggerConfig.formatters = {
      level: (label: string) => ({ "log.level": label }),
    };
    loggerConfig.base = { "service.name": "clokr-api" };
  } else {
    // "json" format: use string level labels instead of numeric
    loggerConfig.formatters = {
      level: (label: string) => ({ level: label }),
    };
  }

  // File output (in addition to stdout)
  if (config.LOG_FILE) {
    loggerConfig.transport = {
      targets: [
        ...(logFormat === "pretty"
          ? [{ target: "pino-pretty", options: { colorize: true }, level: logLevel }]
          : [{ target: "pino/file", options: { destination: 1 }, level: logLevel }]), // stdout
        {
          target: "pino-roll",
          options: { file: config.LOG_FILE, frequency: "daily", mkdir: true },
          level: logLevel,
        },
      ],
    };
  }

  const app = Fastify({
    ignoreTrailingSlash: true,
    logger: loggerConfig,
    genReqId: () => crypto.randomUUID(), // Consistent request IDs
  });

  // ── Security ──────────────────────────────────────────────
  // Global error handler: ZodErrors → 400 with German field messages
  app.setErrorHandler(
    (
      error: Error & { statusCode?: number; issues?: Array<{ path: string[]; message: string }> },
      _req,
      reply,
    ) => {
      if (error.name === "ZodError" || error.issues) {
        let parsed: { path: string[]; message: string }[];
        try {
          parsed = JSON.parse(error.message);
        } catch {
          parsed = [{ path: [], message: error.message }];
        }
        const fieldErrors = parsed.map(
          (i: { path: string[]; message: string }) => `${i.path.join(".") || "Feld"}: ${i.message}`,
        );
        return reply.code(400).send({
          error: "Validierungsfehler",
          message: fieldErrors.join("; "),
          details: parsed,
        });
      }
      app.log.error(error);
      return reply
        .code(error.statusCode ?? 500)
        .send({ error: error.message ?? "Interner Serverfehler" });
    },
  );

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 500,
    timeWindow: "1 minute",
  });

  // ── JWT ───────────────────────────────────────────────────
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: config.JWT_EXPIRES_IN },
  });

  // ── Request Context Logging ──────────────────────────────
  app.addHook("onRequest", (req, _reply, done) => {
    // Enrich log context with user/tenant info (from JWT if available)
    const user = (req as { user?: { sub?: string; tenantId?: string; role?: string } }).user;
    if (user) {
      req.log = req.log.child({
        userId: user.sub,
        tenantId: user.tenantId,
        role: user.role,
      });
    }
    done();
  });

  app.addHook("onResponse", (req, reply, done) => {
    req.log.info({
      msg: "request completed",
      http: {
        method: req.method,
        url: req.url,
        status_code: reply.statusCode,
        response_time: reply.elapsedTime,
      },
    });
    done();
  });

  // ── OpenAPI / Swagger ─────────────────────────────────────
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Clokr API",
        description: "Time tracking & team management API",
        version: "1.0.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list" },
  });

  // ── Plugins ───────────────────────────────────────────────
  await app.register(prismaPlugin);
  await app.register(auditPlugin);
  await app.register(mailerPlugin);
  await app.register(notifyPlugin);
  await app.register(schedulerPlugin);
  await app.register(attendanceCheckerPlugin);
  await app.register(dataRetentionPlugin);
  await app.register(autoCloseMonthPlugin);
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 } });
  await app.register(storagePlugin);

  // ── Routes ────────────────────────────────────────────────
  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(employeeRoutes, { prefix: "/api/v1/employees" });
  await app.register(timeEntryRoutes, { prefix: "/api/v1/time-entries" });
  await app.register(leaveRoutes, { prefix: "/api/v1/leave" });
  await app.register(overtimeRoutes, { prefix: "/api/v1/overtime" });
  await app.register(reportRoutes, { prefix: "/api/v1/reports" });
  await app.register(settingsRoutes, { prefix: "/api/v1/settings" });
  await app.register(holidayRoutes, { prefix: "/api/v1/holidays" });
  await app.register(invitationRoutes, { prefix: "/api/v1/invitations" });
  await app.register(auditLogRoutes, { prefix: "/api/v1/audit-logs" });
  await app.register(companyShutdownRoutes, { prefix: "/api/v1/company-shutdowns" });
  await app.register(dashboardRoutes, { prefix: "/api/v1/dashboard" });
  await app.register(notificationRoutes, { prefix: "/api/v1/notifications" });
  await app.register(shiftRoutes, { prefix: "/api/v1/shifts" });
  await app.register(integrationRoutes, { prefix: "/api/v1/integrations" });
  await app.register(importRoutes, { prefix: "/api/v1/imports" });
  await app.register(terminalRoutes, { prefix: "/api/v1/terminals" });
  await app.register(specialLeaveRoutes, { prefix: "/api/v1/special-leave" });
  await app.register(avatarRoutes, { prefix: "/api/v1/avatars" });
  await app.register(apiKeyRoutes, { prefix: "/api/v1/api-keys" });

  // ── Client Error Logging ─────────────────────────────────
  app.post("/api/v1/logs/client", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    schema: { tags: ["Logs"] },
    handler: async (req) => {
      const body = req.body as {
        level?: string;
        message?: string;
        stack?: string;
        url?: string;
        userAgent?: string;
        userId?: string;
        extra?: Record<string, unknown>;
      };
      const level = body.level === "error" || body.level === "warn" ? body.level : "warn";
      app.log[level]({
        msg: `[CLIENT] ${body.message ?? "Unknown error"}`,
        client: {
          stack: body.stack,
          url: body.url,
          userAgent: body.userAgent,
          userId: body.userId,
          ...body.extra,
        },
      });
      return { ok: true };
    },
  });

  // ── Health ────────────────────────────────────────────────
  app.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  return app;
}
