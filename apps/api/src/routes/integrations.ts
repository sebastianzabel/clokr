import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../middleware/auth";
import { encrypt, decryptSafe } from "../utils/crypto";
import { withAdvisoryLock, tenantAdvisoryKey } from "../utils/with-advisory-lock";
import { phorestFetch, PhorestApiError } from "../services/phorest/client";
import { syncPhorestShifts } from "../services/phorest/sync-shifts";
import type { PhorestStaffItem, SyncResult } from "../services/phorest/types";

/**
 * Phorest API Integration
 *
 * Endpoints:
 *   GET  /api/business/{bid}/branch/{brid}/staff
 *   GET  /api/business/{bid}/branch/{brid}/staffworktimetables?start_date=&end_date=
 *   GET  /api/business/{bid}/branch/{brid}/appointment?appointmentDate=
 *
 * Auth: Basic Auth with "global/{email}" as username
 *
 * Phase 85: the Phorest HTTP client (phorestFetch) and the shift-sync body were promoted to
 * services/phorest/. This file keeps the config/test/staff routes and the manual sync trigger,
 * which now calls the shared syncPhorestShifts() under the per-tenant advisory lock (SS-07).
 */

const syncSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const mappingCreateSchema = z.object({
  phorestStaffId: z.string().min(1),
  employeeId: z.string().min(1),
});

const mappingParamSchema = z.object({
  phorestStaffId: z.string().min(1),
});

const syncRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  page: z.coerce.number().int().min(0).optional().default(0),
});

const configSchema = z.object({
  phorestBusinessId: z.string().min(1),
  phorestBranchId: z.string().min(1),
  phorestUsername: z.string().min(1),
  phorestPassword: z.string().min(1),
  phorestBaseUrl: z.string().url().optional(),
  phorestAutoSync: z.boolean().optional(),
  phorestSyncCron: z.string().optional(),
  // SS-05: configurable sync window (Zeitfenster) surfaced in the admin observability panel.
  phorestSyncWindowDays: z.coerce.number().int().min(1).max(90).optional(),
});

declare module "fastify" {
  interface FastifyInstance {
    refreshScheduler?: () => Promise<void>;
  }
}

export async function integrationRoutes(app: FastifyInstance) {
  // ── Phorest Config ────────────────────────────────────────────────────

  // GET /phorest/config — aktuelle Phorest-Konfiguration
  app.get("/phorest/config", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const cfg = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: req.user.tenantId },
        select: {
          phorestBusinessId: true,
          phorestBranchId: true,
          phorestUsername: true,
          phorestBaseUrl: true,
          phorestAutoSync: true,
          phorestSyncCron: true,
          phorestSyncWindowDays: true,
          // Passwort nicht zurückgeben
        },
      });
      return {
        configured: !!(cfg?.phorestBusinessId && cfg?.phorestUsername),
        ...cfg,
      };
    },
  });

  // PUT /phorest/config — Phorest-Zugangsdaten speichern
  app.put("/phorest/config", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const body = configSchema.parse(req.body);
      await app.prisma.tenantConfig.update({
        where: { tenantId: req.user.tenantId },
        data: {
          phorestBusinessId: body.phorestBusinessId,
          phorestBranchId: body.phorestBranchId,
          phorestUsername: body.phorestUsername,
          phorestPassword: encrypt(body.phorestPassword),
          ...(body.phorestBaseUrl ? { phorestBaseUrl: body.phorestBaseUrl } : {}),
          ...(body.phorestAutoSync !== undefined ? { phorestAutoSync: body.phorestAutoSync } : {}),
          ...(body.phorestSyncCron ? { phorestSyncCron: body.phorestSyncCron } : {}),
          ...(body.phorestSyncWindowDays !== undefined
            ? { phorestSyncWindowDays: body.phorestSyncWindowDays }
            : {}),
        },
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "PhorestConfig",
        newValue: {
          businessId: body.phorestBusinessId,
          branchId: body.phorestBranchId,
          autoSync: body.phorestAutoSync,
        },
      });

      // Scheduler neu laden wenn Auto-Sync geändert
      if (body.phorestAutoSync !== undefined && app.refreshScheduler) {
        await app.refreshScheduler();
      }

      return { success: true };
    },
  });

  // POST /phorest/test — Verbindung testen (klassifiziert: SS-02, UI-SPEC Block B)
  //
  // Returns a structured result the UI renders directly:
  //   { ok: true, staffCount, branchName? }
  //   { ok: false, reason: "not-configured" | "auth-invalid" | "unreachable" | "error", message, status? }
  // T-85-11: the raw upstream body / password is NEVER echoed — only classified German reason codes.
  app.post("/phorest/test", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const cfg = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: req.user.tenantId },
      });
      const phorestPwd = decryptSafe(cfg?.phorestPassword);
      if (!cfg?.phorestBusinessId || !cfg?.phorestUsername || !phorestPwd) {
        return {
          ok: false,
          reason: "not-configured",
          message: "Phorest-Zugangsdaten nicht konfiguriert.",
        };
      }

      try {
        const staff = await phorestFetch(
          cfg.phorestBaseUrl ?? "https://api.phorest.com/third-party-api-server",
          `/api/business/${cfg.phorestBusinessId}/branch/${cfg.phorestBranchId}/staff`,
          cfg.phorestUsername,
          phorestPwd,
          { size: "1", page: "0" },
        );

        const staffArr = staff._embedded?.staff ?? staff.staff ?? [];
        const staffCount =
          typeof staff.totalElements === "number" ? staff.totalElements : staffArr.length;
        const branchName = typeof staff.branchName === "string" ? staff.branchName : undefined;

        return { ok: true, staffCount, ...(branchName ? { branchName } : {}) };
      } catch (err: unknown) {
        // Classify via the typed PhorestApiError.status (SS-02): auth vs unreachable.
        if (err instanceof PhorestApiError) {
          if (err.status === 401 || err.status === 403) {
            return {
              ok: false,
              reason: "auth-invalid",
              message:
                "Verbindung fehlgeschlagen: Zugangsdaten ungültig. Prüfen Sie Benutzername und Passwort.",
            };
          }
          if (err.status === "NETWORK" || err.status === "TIMEOUT") {
            return {
              ok: false,
              reason: "unreachable",
              message:
                "Verbindung fehlgeschlagen: Phorest ist nicht erreichbar. Prüfen Sie Business-/Branch-ID und versuchen Sie es erneut.",
            };
          }
          // Other non-ok HTTP status — surface the status code, never the raw body.
          return {
            ok: false,
            reason: "error",
            status: err.status,
            message: `Verbindung fehlgeschlagen: Phorest-Fehler (Status ${err.status}).`,
          };
        }
        return {
          ok: false,
          reason: "error",
          message: "Verbindung fehlgeschlagen: Unbekannter Fehler.",
        };
      }
    },
  });

  // ── Phorest Staff Mapping ─────────────────────────────────────────────

  // GET /phorest/staff — Phorest-Mitarbeiter abrufen + Mapping anzeigen
  app.get("/phorest/staff", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const cfg = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: req.user.tenantId },
      });
      const staffPwd = decryptSafe(cfg?.phorestPassword);
      if (!cfg?.phorestBusinessId || !cfg?.phorestUsername || !staffPwd) {
        return { error: "Phorest nicht konfiguriert" };
      }

      // Phorest-Mitarbeiter laden
      const phorestData = await phorestFetch(
        cfg.phorestBaseUrl ?? "https://api.phorest.com/third-party-api-server",
        `/api/business/${cfg.phorestBusinessId}/branch/${cfg.phorestBranchId}/staff`,
        cfg.phorestUsername,
        staffPwd,
        { size: "200", page: "0" },
      );

      const phorestStaff: PhorestStaffItem[] = (
        phorestData._embedded?.staff ??
        phorestData.staff ??
        []
      ).map((s) => ({
        staffId: s.staffId,
        firstName: s.firstName,
        lastName: s.lastName,
        email: s.email,
      }));

      // Clokr-Mitarbeiter laden
      const clokrEmployees = await app.prisma.employee.findMany({
        where: { tenantId: req.user.tenantId },
        include: { user: { select: { email: true } } },
      });

      // Persistierte, explizite Zuordnungen laden (SS-01) — die einzige Quelle, der der Sync folgt.
      const savedMappings = await app.prisma.phorestStaffMapping.findMany({
        where: { tenantId: req.user.tenantId },
      });
      const savedByStaffId = new Map(savedMappings.map((m) => [m.phorestStaffId, m.employeeId]));

      // RESEARCH Pattern 4: die alte implizite E-Mail/Name-Zuordnung ist hier NUR noch ein
      // beratender Vorschlag (suggestedEmployeeId). Sie ist niemals maßgeblich für den Sync —
      // dieser verwendet ausschließlich die persistierte PhorestStaffMapping.
      const mapped = phorestStaff.map((ps) => {
        const suggestion = clokrEmployees.find(
          (ce) =>
            ce.user.email.toLowerCase() === ps.email?.toLowerCase() ||
            (ce.firstName.toLowerCase() === ps.firstName.toLowerCase() &&
              ce.lastName.toLowerCase() === ps.lastName.toLowerCase()),
        );
        return {
          phorestStaffId: ps.staffId,
          name: `${ps.firstName} ${ps.lastName}`,
          email: ps.email ?? null,
          savedEmployeeId: savedByStaffId.get(ps.staffId) ?? null,
          suggestedEmployeeId: suggestion?.id ?? null,
        };
      });

      return { staff: mapped };
    },
  });

  // ── Phorest Staff Mapping CRUD (SS-01) ────────────────────────────────

  // GET /phorest/mappings — persistierte Zuordnungen des Mandanten
  app.get("/phorest/mappings", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const mappings = await app.prisma.phorestStaffMapping.findMany({
        where: { tenantId: req.user.tenantId },
        include: { employee: { select: { firstName: true, lastName: true } } },
        orderBy: { createdAt: "asc" },
      });
      return {
        mappings: mappings.map((m) => ({
          id: m.id,
          phorestStaffId: m.phorestStaffId,
          employeeId: m.employeeId,
          employeeName: `${m.employee.firstName} ${m.employee.lastName}`,
        })),
      };
    },
  });

  // POST /phorest/mappings — Zuordnung anlegen/aktualisieren (upsert)
  app.post("/phorest/mappings", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const body = mappingCreateSchema.parse(req.body);

      // T-85-09: der Mitarbeiter MUSS zum Mandanten des Aufrufers gehören (kein Cross-Tenant-Map).
      const emp = await app.prisma.employee.findFirst({
        where: { id: body.employeeId, tenantId: req.user.tenantId },
        select: { id: true },
      });
      if (!emp) {
        return reply
          .code(400)
          .send({ error: "Mitarbeiter nicht gefunden oder gehört nicht zu diesem Mandanten." });
      }

      const existing = await app.prisma.phorestStaffMapping.findUnique({
        where: {
          tenantId_phorestStaffId: {
            tenantId: req.user.tenantId,
            phorestStaffId: body.phorestStaffId,
          },
        },
      });

      const mapping = await app.prisma.phorestStaffMapping.upsert({
        where: {
          tenantId_phorestStaffId: {
            tenantId: req.user.tenantId,
            phorestStaffId: body.phorestStaffId,
          },
        },
        create: {
          tenantId: req.user.tenantId,
          phorestStaffId: body.phorestStaffId,
          employeeId: body.employeeId,
        },
        update: { employeeId: body.employeeId },
      });

      await app.audit({
        userId: req.user.sub,
        action: existing ? "UPDATE" : "CREATE",
        entity: "PhorestStaffMapping",
        entityId: mapping.id,
        oldValue: existing
          ? { phorestStaffId: existing.phorestStaffId, employeeId: existing.employeeId }
          : undefined,
        newValue: { phorestStaffId: mapping.phorestStaffId, employeeId: mapping.employeeId },
      });

      return {
        mapping: {
          id: mapping.id,
          phorestStaffId: mapping.phorestStaffId,
          employeeId: mapping.employeeId,
        },
      };
    },
  });

  // DELETE /phorest/mappings/:phorestStaffId — Zuordnung aufheben
  app.delete("/phorest/mappings/:phorestStaffId", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { phorestStaffId } = mappingParamSchema.parse(req.params);

      const existing = await app.prisma.phorestStaffMapping.findUnique({
        where: {
          tenantId_phorestStaffId: { tenantId: req.user.tenantId, phorestStaffId },
        },
      });
      if (!existing) {
        return reply.code(404).send({ error: "Zuordnung nicht gefunden." });
      }

      await app.prisma.phorestStaffMapping.delete({ where: { id: existing.id } });

      await app.audit({
        userId: req.user.sub,
        action: "DELETE",
        entity: "PhorestStaffMapping",
        entityId: existing.id,
        oldValue: { phorestStaffId: existing.phorestStaffId, employeeId: existing.employeeId },
      });

      return { success: true };
    },
  });

  // ── Phorest Sync-Run History (SS-05) ──────────────────────────────────

  // GET /phorest/sync-runs — letzter Lauf + Verlauf (Observability)
  app.get("/phorest/sync-runs", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const { limit, page } = syncRunsQuerySchema.parse(req.query);
      const where = { tenantId: req.user.tenantId };

      const [latest, history, total] = await Promise.all([
        app.prisma.phorestSyncRun.findFirst({ where, orderBy: { startedAt: "desc" } }),
        app.prisma.phorestSyncRun.findMany({
          where,
          orderBy: { startedAt: "desc" },
          take: limit,
          skip: page * limit,
        }),
        app.prisma.phorestSyncRun.count({ where }),
      ]);

      return { latest, history, total, page, limit };
    },
  });

  // ── Phorest Sync ──────────────────────────────────────────────────────

  // POST /phorest/sync-shifts — Schichten aus Phorest importieren
  app.post("/phorest/sync-shifts", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { startDate, endDate } = syncSchema.parse(req.body);

      // SS-07: the manual trigger takes the SAME per-tenant advisory lock as the cron so a
      // manual click can't race the scheduled sync. Both call the ONE shared service.
      let result: SyncResult | undefined;
      await withAdvisoryLock(
        app.prisma,
        tenantAdvisoryKey(req.user.tenantId),
        async () => {
          result = await syncPhorestShifts(app, req.user.tenantId, {
            startDate,
            endDate,
            actorUserId: req.user.sub,
          });
        },
        app.log,
      );

      if (!result) {
        // Lock not acquired — another sync (cron or a concurrent manual click) is running.
        return reply
          .code(409)
          .send({ error: "Ein Phorest-Sync läuft bereits. Bitte später erneut versuchen." });
      }

      return result;
    },
  });
}
