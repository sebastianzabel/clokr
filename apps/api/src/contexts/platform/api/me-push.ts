/**
 * Issue #608 (D-01, D-06, P-608-02/03/04/08) - own-data routes of the person's push devices.
 *
 * `GET /config` always answers (it tells the web whether to offer push at all); every other route
 * is registered only when the instance has a VAPID set, so without keys the surface does not exist
 * (Fastify's own 404, the operator-surface pattern). All routes are `requireAuth` and JWT only (an
 * API key has no devices -> 400); no catalog permission, a person manages their own devices. The
 * tenant and the user come from `req.user`, never from the body, and the route file holds no
 * Prisma call - reads and writes live in the services.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../../middleware/auth";
import { API_KEY_SUBJECT_PREFIX } from "../access-context";
import { isAllowedPushEndpoint, pushEndpointHost } from "../push-endpoint-guard";
import { sendTestPush } from "../push-dispatch";
import { pushConfiguration } from "../push-sender";
import { subscribeDevice } from "../push-subscriptions";

// ── Schemas ──────────────────────────────────────────────────────────────────

/** A base64url string that decodes to exactly `bytes` bytes (optionally with a fixed first byte). */
function base64UrlBytes(bytes: number, firstByte?: number) {
  return z.string().refine((value) => {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length !== bytes) return false;
    return firstByte === undefined || decoded[0] === firstByte;
  }, "Ungültiger Schlüssel");
}

// The shape of the browser's PushSubscription.toJSON().
const subscribeBodySchema = z.object({
  endpoint: z.string().min(1).max(2048),
  expirationTime: z.number().nullable().optional(), // accepted and ignored
  keys: z.object({
    p256dh: base64UrlBytes(65, 0x04),
    auth: base64UrlBytes(16),
  }),
});

const NO_DEVICES_FOR_API_KEYS = "API-Keys haben keine Push-Geräte";

function isApiKeyCaller(sub: string): boolean {
  return sub.startsWith(API_KEY_SUBJECT_PREFIX);
}

// ── Routes ───────────────────────────────────────────────────────────────────

export async function mePushRoutes(app: FastifyInstance) {
  // GET /api/v1/me/push/config
  app.get("/config", {
    preHandler: requireAuth,
    schema: {
      tags: ["Profil"],
      description:
        "Whether this instance offers web push, and the public VAPID key to subscribe with",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      if (isApiKeyCaller(req.user.sub)) {
        return reply.code(400).send({ error: NO_DEVICES_FOR_API_KEYS });
      }
      const push = pushConfiguration();
      return { enabled: push !== null, publicKey: push ? push.publicKey : null };
    },
  });

  // Without the VAPID set nothing below exists (D-01).
  if (!pushConfiguration()) return;

  // POST /api/v1/me/push/subscriptions
  app.post("/subscriptions", {
    preHandler: requireAuth,
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    schema: {
      tags: ["Profil"],
      description:
        "Register the calling device for web push (explicit opt-in of the signed-in person)",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      if (isApiKeyCaller(req.user.sub)) {
        return reply.code(400).send({ error: NO_DEVICES_FOR_API_KEYS });
      }
      const body = subscribeBodySchema.parse(req.body);
      if (!isAllowedPushEndpoint(body.endpoint)) {
        // The host only: the full URL is a capability and must not reach a log.
        req.log.warn({ host: pushEndpointHost(body.endpoint) }, "Push endpoint refused");
        return reply.code(400).send({
          error: "Dieser Push-Dienst wird nicht unterstützt.",
          code: "PUSH_ENDPOINT_NOT_ALLOWED",
        });
      }
      const result = await subscribeDevice(app, {
        tenantId: req.user.tenantId,
        userId: req.user.sub,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent: req.headers["user-agent"],
        request: req,
      });
      if (result.kind === "CONFLICT") {
        return reply.code(409).send({
          error: "Dieses Gerät ist bereits für Push eingerichtet.",
          code: "PUSH_ENDPOINT_CONFLICT",
        });
      }
      return reply.code(201).send(result.device);
    },
  });

  // POST /api/v1/me/push/test
  app.post("/test", {
    preHandler: requireAuth,
    config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
    schema: {
      tags: ["Profil"],
      description: "Send the neutral test message to every push device of the calling person",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      if (isApiKeyCaller(req.user.sub)) {
        return reply.code(400).send({ error: NO_DEVICES_FOR_API_KEYS });
      }
      const devices = await sendTestPush(app, {
        tenantId: req.user.tenantId,
        userId: req.user.sub,
      });
      return { devices };
    },
  });
}
