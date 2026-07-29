import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../middleware/auth";
import { encrypt, decryptSafe } from "../utils/crypto";
import { withAdvisoryLock, tenantAdvisoryKey } from "../utils/with-advisory-lock";
import { phorestFetch } from "../services/phorest/client";
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

const configSchema = z.object({
  phorestBusinessId: z.string().min(1),
  phorestBranchId: z.string().min(1),
  phorestUsername: z.string().min(1),
  phorestPassword: z.string().min(1),
  phorestBaseUrl: z.string().url().optional(),
  phorestAutoSync: z.boolean().optional(),
  phorestSyncCron: z.string().optional(),
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

  // POST /phorest/test — Verbindung testen
  app.post("/phorest/test", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const cfg = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: req.user.tenantId },
      });
      const phorestPwd = decryptSafe(cfg?.phorestPassword);
      if (!cfg?.phorestBusinessId || !cfg?.phorestUsername || !phorestPwd) {
        return { success: false, error: "Phorest-Zugangsdaten nicht konfiguriert" };
      }

      try {
        const staff = await phorestFetch(
          cfg.phorestBaseUrl ?? "https://api.phorest.com/third-party-api-server",
          `/api/business/${cfg.phorestBusinessId}/branch/${cfg.phorestBranchId}/staff`,
          cfg.phorestUsername,
          phorestPwd,
          { size: "1", page: "0" },
        );
        return {
          success: true,
          message: `Verbindung erfolgreich. ${staff.totalElements ?? "?"} Mitarbeiter gefunden.`,
        };
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
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

      // Auto-Mapping über E-Mail
      const mapped = phorestStaff.map((ps) => {
        const match = clokrEmployees.find(
          (ce) =>
            ce.user.email.toLowerCase() === ps.email?.toLowerCase() ||
            (ce.firstName.toLowerCase() === ps.firstName.toLowerCase() &&
              ce.lastName.toLowerCase() === ps.lastName.toLowerCase()),
        );
        return {
          phorestStaffId: ps.staffId,
          phorestName: `${ps.firstName} ${ps.lastName}`,
          phorestEmail: ps.email,
          clokrEmployeeId: match?.id ?? null,
          clokrName: match ? `${match.firstName} ${match.lastName}` : null,
          autoMatched: !!match,
        };
      });

      return { staff: mapped };
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
