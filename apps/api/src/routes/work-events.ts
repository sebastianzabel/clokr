// Phase 77 Plan 04 — /api/v1/work-events route stubs (WORKEVENT-V19-01).
//
// CRITICAL DESIGN CONSTRAINT (PITFALLS.md E-1/E-2/E-3):
// /mine and / (management) are STRUCTURALLY SEPARATE endpoints. No role-branched
// scoping on a single endpoint — that pattern caused the v1.8.12 cross-employee
// leak. Self-view: GET /mine, always self-scoped from req.user.employeeId,
// ignores any ?employeeId= query param. Management: GET / + POST/PATCH/DELETE,
// requireRole("ADMIN", "MANAGER"), supports ?employeeId= filter.
//
// Phase 79 fills the handler bodies. This phase ships the route plumbing only —
// every handler returns 501 Not Implemented with a German message.
//
// Payload validation (Phase 79): workEventPayloadSchema.parse(req.body.payload)
// at handler entry. See ./work-event-payload-schema.ts.
//
// Adapter for Saldo reads (Phase 78): loadWorkEventsForRange(prisma, employeeId,
// from, to). See ../utils/work-event.ts.

import { FastifyInstance } from "fastify";
import { requireAuth, requireRole } from "../middleware/auth";
import { config } from "../config";
// Type-only import — Phase 79 will use the schema for runtime validation in
// POST/PATCH handler bodies via workEventPayloadSchema.parse(req.body.payload).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { WorkEventPayload } from "./work-event-payload-schema";

const NOT_IMPLEMENTED = {
  error: "Nicht implementiert",
  message: "WorkEvent endpoints werden in Phase 79 verkabelt",
};

const isTest = config.NODE_ENV === "test";
const READ_RATE_LIMIT = { max: isTest ? 1000 : 100, timeWindow: "1 minute" };
const WRITE_RATE_LIMIT = { max: isTest ? 1000 : 20, timeWindow: "1 minute" };

export async function workEventRoutes(app: FastifyInstance) {
  // Per-route preHandler (NOT global addHook) — CodeQL js/missing-rate-limiting
  // detects rate limiting reliably when auth + rateLimit live on the same route
  // definition (matches the time-entries.ts pattern).

  // ── GET /api/v1/work-events/mine — self-view (any authenticated user) ──────
  // E-1/E-2/E-3 mitigation: structurally separate from the management surface.
  // Phase 79: list req.user.employeeId's WorkEvents in [from, to). Ignores any
  // ?employeeId= query param — self-scope is enforced by the URL path, not by a
  // role branch. No role guard beyond requireAuth: ADMIN, MANAGER, and EMPLOYEE
  // all land in the same self-scoped handler.
  app.get("/mine", {
    schema: { tags: ["WorkEvents"], security: [{ bearerAuth: [] }] },
    config: { rateLimit: READ_RATE_LIMIT },
    preHandler: requireAuth,
    handler: async (_req, reply) => {
      return reply.code(501).send(NOT_IMPLEMENTED);
    },
  });

  // ── GET /api/v1/work-events — management list (ADMIN/MANAGER) ──────────────
  // Phase 79: tenant-scoped list, supports ?employeeId= filter for narrowing
  // to a single employee within the caller's tenant.
  app.get("/", {
    schema: { tags: ["WorkEvents"], security: [{ bearerAuth: [] }] },
    config: { rateLimit: READ_RATE_LIMIT },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (_req, reply) => {
      return reply.code(501).send(NOT_IMPLEMENTED);
    },
  });

  // ── POST /api/v1/work-events — manual create (ADMIN/MANAGER) ───────────────
  // Phase 79:
  //   const { employeeId, date, type, source, payload } = req.body;
  //   workEventPayloadSchema.parse(payload);  // discriminated-union validation
  //   await assertMonthNotLocked(employeeId, date);  // S-5 lock semantic
  //   await app.prisma.workEvent.create({ ... });  // P2002 → HTTP 409
  //   await app.audit({ action: "WORK_EVENT_CREATED", ... });
  app.post("/", {
    schema: { tags: ["WorkEvents"], security: [{ bearerAuth: [] }] },
    config: { rateLimit: WRITE_RATE_LIMIT },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (_req, reply) => {
      return reply.code(501).send(NOT_IMPLEMENTED);
    },
  });

  // ── PATCH /api/v1/work-events/:id — edit (ADMIN/MANAGER) ───────────────────
  // Phase 79: locked-month gate, optional payload re-validation via
  // workEventPayloadSchema.parse, AuditLog action WORK_EVENT_UPDATED with
  // before/after snapshot, return updated row.
  app.patch("/:id", {
    schema: { tags: ["WorkEvents"], security: [{ bearerAuth: [] }] },
    config: { rateLimit: WRITE_RATE_LIMIT },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (_req, reply) => {
      return reply.code(501).send(NOT_IMPLEMENTED);
    },
  });

  // ── DELETE /api/v1/work-events/:id — soft-delete (ADMIN/MANAGER) ───────────
  // Phase 79: set deletedAt (no hard delete — Revisionssicherheit), AuditLog
  // action WORK_EVENT_DELETED with oldValue snapshot, 204 No Content.
  app.delete("/:id", {
    schema: { tags: ["WorkEvents"], security: [{ bearerAuth: [] }] },
    config: { rateLimit: WRITE_RATE_LIMIT },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (_req, reply) => {
      return reply.code(501).send(NOT_IMPLEMENTED);
    },
  });
}
