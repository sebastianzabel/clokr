import crypto from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
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
import { carryoverWarningPlugin } from "./plugins/carryover-warning";
import { dataRetentionPlugin } from "./plugins/data-retention";
import { tokenCleanupPlugin } from "./plugins/token-cleanup";
import { vocationalSchoolGeneratorPlugin } from "./plugins/vocational-school-generator";
import { schoolHolidaysSyncPlugin } from "./plugins/school-holidays-sync";
import { autoCloseMonthPlugin } from "./plugins/auto-close-month";
import { storagePlugin } from "./plugins/storage";
import multipart from "@fastify/multipart";
import { notificationRoutes } from "./routes/notifications";
import { invitationRoutes } from "./routes/invitations";
import { auditLogRoutes } from "./routes/audit-logs";
import { activityRoutes } from "./routes/activity";
import { companyShutdownRoutes } from "./routes/company-shutdowns";
import { dashboardRoutes } from "./routes/dashboard";
import { shiftRoutes } from "./routes/shifts";
import { shiftPatternRoutes, shiftPatternTenantRoutes } from "./routes/shift-patterns";
import { vocationalSchoolPatternRoutes } from "./routes/vocational-school-pattern";
import { vocationalSchoolRoutes } from "./routes/vocational-school";
import { availabilityRoutes } from "./routes/availability";
import { integrationRoutes } from "./routes/integrations";
import { importRoutes } from "./routes/imports";
import { terminalRoutes } from "./routes/terminals";
import { specialLeaveRoutes } from "./routes/special-leave";
import { avatarRoutes } from "./routes/avatars";
import { apiKeyRoutes } from "./routes/api-keys";
import { presenceRoutes } from "./routes/presence";
import { adminPresenceSourcesRoutes } from "./routes/admin-presence-sources";
import { adminSchoolHolidaysRoutes } from "./routes/admin/school-holidays";
import { meRoutes } from "./routes/me";
import { testBootstrapRoutes } from "./routes/test-bootstrap";
import { requireAuth } from "./middleware/auth";

// Phase 69 (DEVOPS-V8-02): bake version from package.json at module init.
// Image content is the source of truth per Memory feedback_image_content_is_source_of_truth.
// Do NOT read from APP_VERSION env var — env vars drift; image content does not.
const PKG_VERSION = (() => {
  const pkgPath = resolve(__dirname, "../package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
  return pkg.version;
})();

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
    // OPS-V1814-04 (F-H8): trust the SvelteKit proxy's X-Forwarded-For so req.ip
    // resolves to the real client IP (AuditLog + per-IP rate limiting) instead of
    // the Docker container IP. The proxy overwrites x-real-ip and appends the real
    // getClientAddress() to XFF on every request, so a client-forged XFF cannot
    // masquerade as the last hop. Residual (direct-API exposure) is an infra concern.
    trustProxy: true,
  });

  // ── Content-Type Parser ───────────────────────────────────
  // Handle DELETE (and other) requests that send Content-Type: application/json with empty body.
  // External API clients (MCP tools, Postman, curl) commonly set this header on all requests.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    if (typeof body === "string" && body.trim() === "") {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
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

  await app.register(helmet, {
    contentSecurityPolicy: false, // API is JSON-only; no HTML served (Swagger UI excluded)
    hsts:
      config.NODE_ENV === "production"
        ? { maxAge: 31536000, includeSubDomains: true, preload: false }
        : false,
  });
  await app.register(cors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
  });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
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
  await app.register(carryoverWarningPlugin);
  await app.register(dataRetentionPlugin);
  await app.register(tokenCleanupPlugin);
  await app.register(vocationalSchoolGeneratorPlugin);
  await app.register(schoolHolidaysSyncPlugin);
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
  await app.register(activityRoutes, { prefix: "/api/v1/activity" });
  await app.register(companyShutdownRoutes, { prefix: "/api/v1/company-shutdowns" });
  await app.register(dashboardRoutes, { prefix: "/api/v1/dashboard" });
  await app.register(notificationRoutes, { prefix: "/api/v1/notifications" });
  await app.register(shiftRoutes, { prefix: "/api/v1/shifts" });
  // Phase 43 — recurring shift patterns live under the employees namespace
  // (GET/PUT /api/v1/employees/:id/shift-patterns)
  await app.register(shiftPatternRoutes, { prefix: "/api/v1/employees" });
  // Phase 48 — tenant-wide bulk read for the pattern-editor matrix UI
  // (GET /api/v1/shift-patterns/tenant)
  await app.register(shiftPatternTenantRoutes, { prefix: "/api/v1/shift-patterns" });
  // Phase 62 — Berufsschultag patterns live under the employees namespace
  // (GET/PUT /api/v1/employees/:id/vocational-school-pattern)
  await app.register(vocationalSchoolPatternRoutes, { prefix: "/api/v1/employees" });
  // Phase 46 — employee availability declarations live under the employees namespace
  // (GET/PUT /api/v1/employees/:id/availability)
  await app.register(availabilityRoutes, { prefix: "/api/v1/employees" });
  await app.register(integrationRoutes, { prefix: "/api/v1/integrations" });
  await app.register(importRoutes, { prefix: "/api/v1/imports" });
  await app.register(terminalRoutes, { prefix: "/api/v1/terminals" });
  await app.register(specialLeaveRoutes, { prefix: "/api/v1/special-leave" });
  // Phase 62 — Berufsschultag manual trigger + preview
  // (POST /api/v1/vocational-school/generate, GET /api/v1/vocational-school/preview)
  await app.register(vocationalSchoolRoutes, { prefix: "/api/v1/vocational-school" });
  await app.register(avatarRoutes, { prefix: "/api/v1/avatars" });
  await app.register(apiKeyRoutes, { prefix: "/api/v1/api-keys" });
  await app.register(presenceRoutes, { prefix: "/api/v1/presence" });
  await app.register(adminPresenceSourcesRoutes, { prefix: "/api/v1/admin/presence-sources" });
  await app.register(adminSchoolHolidaysRoutes, { prefix: "/api/v1/admin/school-holidays" });
  await app.register(meRoutes, { prefix: "/api/v1/me" });

  // Phase 73-01 + 74-03 (D-05): test-only bootstrap + X-Test-Now header.
  // The plugin self-gates on ALLOW_TEST_BOOTSTRAP; registering it
  // unconditionally is safe — it no-ops on int + prod. See T-74-01.
  await app.register(testBootstrapRoutes, { prefix: "/api/v1/test" });

  // ── Client Error Logging ─────────────────────────────────
  // SEC-V1814-04: requireAuth gate (T-76.16-19/21), JWT-bound userId (T-76.16-18),
  // payload length caps (T-76.16-20), rate limit tightened 20→5/min (T-76.16-19).
  app.post("/api/v1/logs/client", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    schema: { tags: ["Logs"] },
    preHandler: requireAuth,
    handler: async (req) => {
      const body = req.body as {
        level?: string;
        message?: string;
        stack?: string;
        url?: string;
        userAgent?: string;
        extra?: Record<string, unknown>;
      };
      const level = body.level === "error" ? "error" : "warn";
      // Spread caller-supplied `extra` FIRST so the trusted fields below always win —
      // otherwise `extra: { userId }` would override the JWT-bound userId (attribution forgery).
      app.log[level]({
        msg: `[CLIENT] ${String(body.message ?? "Unknown error").slice(0, 1000)}`,
        client: {
          ...body.extra,
          stack: typeof body.stack === "string" ? body.stack.slice(0, 2000) : undefined,
          url: typeof body.url === "string" ? body.url.slice(0, 500) : undefined,
          userAgent: typeof body.userAgent === "string" ? body.userAgent.slice(0, 500) : undefined,
          userId: req.user.sub, // JWT-bound; wins over any body.extra.userId to prevent attribution forgery
        },
      });
      return { ok: true };
    },
  });

  // ── Health ────────────────────────────────────────────────
  // OPS-V1814-05 (F-M10): a real DB ping so a wedged DB/pool yields 503 (degraded)
  // instead of a phantom-healthy 200. Bounded by a short timeout so a slow/hung DB
  // does not hang the probe. The orchestrator can then restart/deschedule the container.
  const DB_PING_TIMEOUT_MS = 2_000;
  async function dbPingHandler(_req: FastifyRequest, reply: FastifyReply) {
    try {
      await Promise.race([
        app.prisma.$queryRaw`SELECT 1`,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("DB ping timed out")), DB_PING_TIMEOUT_MS),
        ),
      ]);
      return { status: "ok", timestamp: new Date().toISOString() };
    } catch {
      return reply.code(503).send({ status: "degraded", timestamp: new Date().toISOString() });
    }
  }
  app.get("/health", dbPingHandler);
  // /api/v1/health — non-breaking alias of /health (D-05). Phase 70 smoke tests use this path.
  // Identical payload; keep /health for Docker/k8s healthcheck + prod-host LB backwards compat.
  app.get("/api/v1/health", dbPingHandler);

  // ── Version (Phase 69 / DEVOPS-V8-02) ─────────────────────
  // Public endpoint (no requireAuth — same posture as /health per D-04).
  // Returns ONLY { version: string } per D-02 — forward-compatible minimal shape.
  app.get("/api/v1/version", async () => ({ version: PKG_VERSION }));

  return app;
}
