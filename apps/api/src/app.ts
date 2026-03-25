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
import { notificationRoutes } from "./routes/notifications";
import { invitationRoutes } from "./routes/invitations";
import { auditLogRoutes } from "./routes/audit-logs";
import { companyShutdownRoutes } from "./routes/company-shutdowns";
import { dashboardRoutes } from "./routes/dashboard";
import { shiftRoutes } from "./routes/shifts";
import { integrationRoutes } from "./routes/integrations";
import { importRoutes } from "./routes/imports";
import { terminalRoutes } from "./routes/terminals";

export async function buildApp() {
  const app = Fastify({
    ignoreTrailingSlash: true,
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
      transport:
        config.NODE_ENV !== "production"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
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
    max: 100,
    timeWindow: "1 minute",
  });

  // ── JWT ───────────────────────────────────────────────────
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: config.JWT_EXPIRES_IN },
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

  // ── Health ────────────────────────────────────────────────
  app.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  return app;
}
