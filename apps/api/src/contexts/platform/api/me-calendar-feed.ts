/**
 * Issue #597 — the own calendar-feed token: status, create/rotate, revoke (`/api/v1/me/calendar-feed`).
 *
 * Own data only: the caller manages their own token; nobody can read or reset another person's.
 * Creating a feed needs at least one of the own-read permissions the feed is built from
 * (`shift:read:EIGENE`, `leave-request:read:EIGENE`), the same rule the feed applies on every poll
 * (`resolveCalendarFeedToken`). Every change is audited without the token; the token is returned
 * once, in the create/rotate response, never again. API keys have no person and get 400.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../../../config";
import { requireAuth } from "../../../middleware/auth";
import { API_KEY_SUBJECT_PREFIX } from "../access-context";
import { hasPermission } from "../request-permissions";
import {
  CALENDAR_FEED_PATH,
  calendarFeedTokenState,
  issueCalendarFeedToken,
  revokeCalendarFeedToken,
} from "../calendar-feed-token";

const NO_FEED_FOR_API_KEYS = "API-Keys haben keinen Kalender";
const NO_EMPLOYEE = "Zu deinem Zugang gehört kein Mitarbeiterprofil.";

/** The public feed URL (the web proxies `/api/*` to this API). */
export function calendarFeedUrls(token: string): { url: string; webcalUrl: string } {
  const url = `${config.APP_URL.replace(/\/$/, "")}${CALENDAR_FEED_PATH}?token=${token}`;
  return { url, webcalUrl: url.replace(/^https?:\/\//, "webcal://") };
}

export async function meCalendarFeedRoutes(app: FastifyInstance) {
  // GET /api/v1/me/calendar-feed — is a feed active, since when, last fetched (never the URL)
  app.get("/", {
    preHandler: requireAuth,
    schema: {
      tags: ["Profil"],
      description: "State of the own calendar feed (never the secret URL)",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      if (req.user.sub.startsWith(API_KEY_SUBJECT_PREFIX)) {
        return reply.code(400).send({ error: NO_FEED_FOR_API_KEYS });
      }
      return calendarFeedTokenState(app.prisma, req.user.tenantId, req.user.sub);
    },
  });

  // POST /api/v1/me/calendar-feed — create the feed, or rotate it (the old link stops working)
  app.post("/", {
    preHandler: requireAuth,
    config: { rateLimit: { max: 10, timeWindow: "10 minutes" } },
    schema: {
      tags: ["Profil"],
      description: "Create or rotate the own calendar feed; returns the secret URL once",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      if (req.user.sub.startsWith(API_KEY_SUBJECT_PREFIX)) {
        return reply.code(400).send({ error: NO_FEED_FOR_API_KEYS });
      }
      if (!req.user.employeeId) return reply.code(400).send({ error: NO_EMPLOYEE });
      const canShifts = await hasPermission(req, "shift:read:EIGENE");
      const canLeave = await hasPermission(req, "leave-request:read:EIGENE");
      if (!canShifts && !canLeave) return reply.code(403).send({ error: "Forbidden" });

      const issued = await app.prisma.$transaction(async (tx) => {
        const result = await issueCalendarFeedToken(tx, req.user.tenantId, req.user.sub);
        await app.audit({
          tx,
          userId: req.user.sub,
          action: result.rotated ? "UPDATE" : "CREATE",
          entity: "CalendarFeedToken",
          entityId: result.id,
          newValue: { rotated: result.rotated },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return result;
      });
      const state = await calendarFeedTokenState(app.prisma, req.user.tenantId, req.user.sub);
      return reply
        .code(issued.rotated ? 200 : 201)
        .header("Cache-Control", "no-store")
        .send({ ...state, ...calendarFeedUrls(issued.token) });
    },
  });

  // DELETE /api/v1/me/calendar-feed — revoke: the link stops working at once
  app.delete("/", {
    preHandler: requireAuth,
    schema: {
      tags: ["Profil"],
      description: "Revoke the own calendar feed",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      if (req.user.sub.startsWith(API_KEY_SUBJECT_PREFIX)) {
        return reply.code(400).send({ error: NO_FEED_FOR_API_KEYS });
      }
      await app.prisma.$transaction(async (tx) => {
        const id = await revokeCalendarFeedToken(tx, req.user.tenantId, req.user.sub);
        if (id) {
          await app.audit({
            tx,
            userId: req.user.sub,
            action: "DELETE",
            entity: "CalendarFeedToken",
            entityId: id,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        }
      });
      return reply.code(204).send();
    },
  });
}
