import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { formatEntry, putAvailabilitySchema, replaceAvailability } from "./availability";
import { isAvailabilityEnabled } from "../utils/tenant-availability";

// ── Schemas ──────────────────────────────────────────────────────────────────

const skinEnum = z.enum(["editorial", "modern"]);
const themeEnum = z.enum(["pflaume", "nacht", "wald", "schiefer"]);
const modeEnum = z.enum(["light", "dark"]);
const densityEnum = z.enum(["comfortable", "compact"]);
const languageEnum = z.enum(["de", "en"]);

const updatePreferencesSchema = z.object({
  skin: skinEnum.optional(),
  theme: themeEnum.optional(),
  mode: modeEnum.optional(),
  density: densityEnum.optional(),
  language: languageEnum.optional(),
});

// ── Types ────────────────────────────────────────────────────────────────────

interface UiPreferences {
  skin: z.infer<typeof skinEnum>;
  theme: z.infer<typeof themeEnum>;
  mode: z.infer<typeof modeEnum>;
  density: z.infer<typeof densityEnum>;
  language: z.infer<typeof languageEnum>;
}

const DEFAULT_PREFERENCES: UiPreferences = {
  skin: "editorial",
  theme: "pflaume",
  mode: "light",
  density: "comfortable",
  language: "de",
};

/**
 * Merge stored preferences over defaults. Ignores unknown keys and falls back to
 * defaults when a stored value is invalid (e.g. after a config rollback).
 */
function mergePreferences(stored: unknown): UiPreferences {
  if (!stored || typeof stored !== "object") return { ...DEFAULT_PREFERENCES };
  const partial = stored as Record<string, unknown>;
  return {
    skin: skinEnum.safeParse(partial.skin).success
      ? (partial.skin as UiPreferences["skin"])
      : DEFAULT_PREFERENCES.skin,
    theme: themeEnum.safeParse(partial.theme).success
      ? (partial.theme as UiPreferences["theme"])
      : DEFAULT_PREFERENCES.theme,
    mode: modeEnum.safeParse(partial.mode).success
      ? (partial.mode as UiPreferences["mode"])
      : DEFAULT_PREFERENCES.mode,
    density: densityEnum.safeParse(partial.density).success
      ? (partial.density as UiPreferences["density"])
      : DEFAULT_PREFERENCES.density,
    language: languageEnum.safeParse(partial.language).success
      ? (partial.language as UiPreferences["language"])
      : DEFAULT_PREFERENCES.language,
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

export async function meRoutes(app: FastifyInstance) {
  // GET /api/v1/me/preferences
  app.get("/preferences", {
    preHandler: requireAuth,
    schema: {
      tags: ["Mein Bereich"],
      description: "Get the current user's UI preferences merged with defaults",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const userId = req.user.sub;
      // API keys (clk_ prefix) are not real users; reject early.
      if (userId.startsWith("apikey:")) {
        return reply.code(400).send({ error: "API-Keys haben keine Benutzerpräferenzen" });
      }
      const user = await app.prisma.user.findUnique({
        where: { id: userId },
        select: { uiPreferences: true },
      });
      if (!user) {
        return reply.code(404).send({ error: "Benutzer nicht gefunden" });
      }
      return mergePreferences(user.uiPreferences);
    },
  });

  // PUT /api/v1/me/preferences
  app.put("/preferences", {
    preHandler: requireAuth,
    schema: {
      tags: ["Mein Bereich"],
      description: "Update the current user's UI preferences (partial update, merge semantics)",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const userId = req.user.sub;
      if (userId.startsWith("apikey:")) {
        return reply.code(400).send({ error: "API-Keys haben keine Benutzerpräferenzen" });
      }
      const body = updatePreferencesSchema.parse(req.body);

      const user = await app.prisma.user.findUnique({
        where: { id: userId },
        select: { uiPreferences: true },
      });
      if (!user) {
        return reply.code(404).send({ error: "Benutzer nicht gefunden" });
      }

      // Merge into existing preferences (partial update)
      const current = mergePreferences(user.uiPreferences);
      const next: UiPreferences = { ...current, ...body };

      await app.prisma.user.update({
        where: { id: userId },
        data: { uiPreferences: next as unknown as Record<string, string> },
      });

      return next;
    },
  });

  // ── Availability (Phase 46) ─────────────────────────────────────────────────
  // Shortcut for the caller's own availability, resolved from JWT.employeeId.
  // Mirrors GET/PUT /api/v1/employees/:id/availability but without the id param.

  // GET /api/v1/me/availability
  app.get("/availability", {
    preHandler: requireAuth,
    schema: {
      tags: ["Verfügbarkeit"],
      description: "Get the caller's availability entries (resolved from JWT.employeeId)",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const employeeId = req.user.employeeId;
      if (!employeeId) {
        return reply.code(404).send({ error: "Kein Mitarbeiterkonto verknüpft" });
      }

      // Tenant-scoped lookup to confirm employee still exists in the caller's tenant
      const employee = await app.prisma.employee.findFirst({
        where: { id: employeeId, tenantId: req.user.tenantId },
        select: { id: true },
      });
      if (!employee) {
        return reply.code(404).send({ error: "Kein Mitarbeiterkonto verknüpft" });
      }

      // Phase 47.3 — Feature toggle: 410 Gone when disabled (truthful, not 404).
      const featureOn = await isAvailabilityEnabled(app.prisma, req.user.tenantId);
      if (!featureOn) {
        return reply.code(410).send({
          error: "Verfügbarkeits-System deaktiviert",
          code: "AVAILABILITY_FEATURE_DISABLED",
        });
      }

      const entries = await app.prisma.employeeAvailability.findMany({
        where: { employeeId },
        orderBy: [{ date: "asc" }, { dayOfWeek: "asc" }],
      });

      return reply.code(200).send({ entries: entries.map(formatEntry) });
    },
  });

  // PUT /api/v1/me/availability
  app.put("/availability", {
    preHandler: requireAuth,
    schema: {
      tags: ["Verfügbarkeit"],
      description: "Replace the caller's availability entries (REPLACE semantics)",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const employeeId = req.user.employeeId;
      if (!employeeId) {
        return reply.code(404).send({ error: "Kein Mitarbeiterkonto verknüpft" });
      }

      const body = putAvailabilitySchema.parse(req.body);

      // Tenant-scoped lookup to confirm employee still exists in the caller's tenant
      const employee = await app.prisma.employee.findFirst({
        where: { id: employeeId, tenantId: req.user.tenantId },
        select: { id: true },
      });
      if (!employee) {
        return reply.code(404).send({ error: "Kein Mitarbeiterkonto verknüpft" });
      }

      // Phase 47.3 — Feature toggle: 410 Gone when disabled (truthful, not 404).
      const featureOn = await isAvailabilityEnabled(app.prisma, req.user.tenantId);
      if (!featureOn) {
        return reply.code(410).send({
          error: "Verfügbarkeits-System deaktiviert",
          code: "AVAILABILITY_FEATURE_DISABLED",
        });
      }

      // Audit before-snapshot
      const oldEntries = await app.prisma.employeeAvailability.findMany({
        where: { employeeId },
      });

      const created = await replaceAvailability(app, employeeId, body.entries, req.user.sub);

      await app.audit({
        userId: req.user.sub,
        action: "REPLACE",
        entity: "EmployeeAvailability",
        entityId: employeeId,
        oldValue: { entries: oldEntries.map(formatEntry) },
        newValue: { entries: created.map(formatEntry) },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(200).send({ entries: created.map(formatEntry) });
    },
  });
}
