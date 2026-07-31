import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole, requireAuth } from "../middleware/auth";
import { encrypt, decryptSafe } from "../utils/crypto";
import { withAdvisoryLock, tenantAdvisoryKey } from "../utils/with-advisory-lock";
import { phorestFetch, PhorestApiError } from "../services/phorest/client";
import { syncPhorestShifts } from "../services/phorest/sync-shifts";
import { syncPhorestAppointments } from "../services/phorest/sync-appointments";
import type { PhorestStaffItem, SyncResult } from "../services/phorest/types";

/**
 * Phorest API Integration
 *
 * Host (EU gateway, default): https://api-gateway-eu.phorest.com/third-party-api-server
 *
 * Endpoints (real v3 "Third Party API" wire-shape — CONFIRMED from the OpenAPI spec, see
 * services/phorest/types.ts + ref/phorest-openapi-v3.json):
 *   GET  /api/business/{bid}/branch/{brid}/staff?size=&page=
 *   GET  /api/business/{bid}/branch/{brid}/staff/worktimetable?from_date=&to_date=&size=&page=
 *   GET  /api/business/{bid}/branch/{brid}/appointment?from_date=&to_date=&staff_id=&size=&page=
 * Staff live under `_embedded.staffs`; the paged envelope is `page{size,totalElements,totalPages,number}`.
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
  // Password is OPTIONAL on update: GET /phorest/config never returns it (masked), so an admin who
  // edits any OTHER field and re-saves would otherwise be forced to re-type it. The masked field
  // submits an EMPTY STRING (not undefined) when left blank, so we must accept "" too — `.min(1)`
  // here would ZodError-400 the whole save (BUG-3). We keep the stored (encrypted) password
  // untouched unless a non-empty value is sent; only then is it re-encrypted and persisted below.
  phorestPassword: z.string().optional(),
  phorestBaseUrl: z.string().url().optional(),
  phorestAutoSync: z.boolean().optional(),
  phorestSyncCron: z.string().optional(),
  // SS-05: configurable sync window (Zeitfenster) surfaced in the admin observability panel.
  phorestSyncWindowDays: z.coerce.number().int().min(1).max(90).optional(),
});

// Phase 87 (CO-01/CO-02/CO-03): read-only appointment-collision pre-check.
// Two mutually-exclusive input shapes (GET query params arrive as STRINGS — validate, don't coerce dates):
//   A) { employeeId, from, to } — a leave/sick/absence date window
//   B) { shiftId }              — shift removal (resolves shift → employee + single day)
const collisionQuerySchema = z.union([
  z.object({
    employeeId: z.string().uuid(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.object({ shiftId: z.string().uuid() }),
]);

/**
 * Build the Phorest web-calendar deep-link for a staff member on a date, or null when it cannot be
 * built (graceful degrade — the UI omits the link).
 *
 * OWNER-GATE (Phase-87 deep-link, out of scope here): `phorestBaseUrl` is the THIRD-PARTY API host
 * (api-gateway-eu.phorest.com/third-party-api-server), NOT a user-facing calendar URL, and there is no
 * calendar-URL config field today. The real v3 API access (which closed the 85-05 wire-shape gate) does
 * NOT expose a web-calendar URL — that stays a separate owner decision. Until the owner pins the real
 * Phorest web-calendar URL shape, this returns null. The function signature already carries everything a
 * real URL needs (business/branch + employee + date), so a URL can be dropped in here WITHOUT changing
 * the endpoint's `deepLink: string | null` response contract.
 */
function buildPhorestCalendarDeepLink(
  _cfg: {
    phorestBusinessId: string | null;
    phorestBranchId: string | null;
    phorestBaseUrl: string | null;
  } | null,
  _employeeId: string,
  _date: Date,
): string | null {
  return null; // TODO(owner-gate): construct once the Phorest web-calendar URL format is pinned.
}

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
          // Only re-encrypt/overwrite when a new password was actually supplied (see schema note).
          ...(body.phorestPassword ? { phorestPassword: encrypt(body.phorestPassword) } : {}),
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
          cfg.phorestBaseUrl ?? "https://api-gateway-eu.phorest.com/third-party-api-server",
          `/api/business/${cfg.phorestBusinessId}/branch/${cfg.phorestBranchId}/staff`,
          cfg.phorestUsername,
          phorestPwd,
          { size: "1", page: "0" },
        );

        // v3: staff live under _embedded.staffs; archived staff are skipped in the fallback count
        // (consistent with the sync/preview paths — see sync-shifts.ts). NOTE: this is a size=1
        // connectivity probe, so `page.totalElements` (the upstream total, archived-inclusive) stays
        // the authoritative count when present — the archived-excluded headcount is surfaced by the
        // full GET /phorest/staff preview, not by this lightweight test.
        const staffArr = (staff._embedded?.staffs ?? staff.staffs ?? []).filter(
          (s) => s.archived !== true,
        );
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
        cfg.phorestBaseUrl ?? "https://api-gateway-eu.phorest.com/third-party-api-server",
        `/api/business/${cfg.phorestBusinessId}/branch/${cfg.phorestBranchId}/staff`,
        cfg.phorestUsername,
        staffPwd,
        { size: "200", page: "0" },
      );

      // v3: staff live under _embedded.staffs; archived staff are skipped so they can't be mapped
      // (consistent with the sync path — see sync-shifts.ts).
      const phorestStaff: PhorestStaffItem[] = (
        phorestData._embedded?.staffs ??
        phorestData.staffs ??
        []
      )
        .filter((s) => s.archived !== true)
        .map((s) => ({
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
          // Phase 86 (SA-03): appointment sync runs inside the SAME lock, recording onto the SAME
          // run row (result.runId). Appointment counters live on the run; the endpoint response
          // stays the shift SyncResult (surfacing appointment counts here is out of scope).
          await syncPhorestAppointments(app, req.user.tenantId, {
            runId: result.runId,
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

  // ── Phorest Appointment Collision Pre-Check (CO-01/CO-02/CO-03) ────────
  //
  // GET /phorest/appointment-collisions?employeeId=&from=&to=   (range shape)
  //                                     ?shiftId=               (shift-removal shape)
  //
  // Read-only, DSGVO-minimized: returns ONLY { total, collisions:[{date,count}], deepLink }.
  // The response is the DSGVO boundary — it NEVER carries customer/service/price PII (the model has
  // no such columns; the groupBy selects only date + _count). Tenant scope is via employee.tenantId
  // (PhorestAppointment has no tenantId column). Authorization is in-handler: a non-manager may
  // pre-check ONLY their own employeeId; any {shiftId} or another employeeId requires ADMIN/MANAGER.
  app.get("/phorest/appointment-collisions", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const q = collisionQuerySchema.parse(req.query);
      const isManager = req.user.role === "ADMIN" || req.user.role === "MANAGER";

      // Resolve the tenant-proven employeeId + inclusive [from,to] window for both input shapes.
      let employeeId: string;
      let from: Date;
      let to: Date;

      if ("shiftId" in q) {
        // Shift removal is a manager/admin action (mirrors DELETE /shifts/:id = requireRole ADMIN,MANAGER).
        if (!isManager) {
          return reply.code(403).send({ error: "Keine Berechtigung" });
        }
        // Tenant gate: the shift MUST belong to an employee of the caller's tenant (else 404).
        const shift = await app.prisma.shift.findFirst({
          where: { id: q.shiftId, employee: { tenantId: req.user.tenantId }, deletedAt: null },
          select: { employeeId: true, date: true },
        });
        if (!shift) {
          return reply.code(404).send({ error: "Schicht nicht gefunden" });
        }
        employeeId = shift.employeeId;
        from = shift.date;
        to = shift.date; // single-day window
      } else {
        // A non-manager may only pre-check their OWN leave window.
        if (q.employeeId !== req.user.employeeId && !isManager) {
          return reply.code(403).send({ error: "Keine Berechtigung" });
        }
        // Tenant gate: this scoped lookup IS the isolation boundary (404 on cross-tenant / unknown id).
        const emp = await app.prisma.employee.findFirst({
          where: { id: q.employeeId, tenantId: req.user.tenantId },
          select: { id: true },
        });
        if (!emp) {
          return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
        }
        employeeId = emp.id;
        from = new Date(q.from);
        to = new Date(q.to);
      }

      // Overlap: PhorestAppointment.date is @db.Date (UTC midnight). gte/lte is inclusive on both ends.
      // NARROW groupBy — never findMany-spread appointment rows into the response (DSGVO boundary).
      const grouped = await app.prisma.phorestAppointment.groupBy({
        by: ["date"],
        where: { employeeId, date: { gte: from, lte: to } },
        _count: { _all: true },
        orderBy: { date: "asc" },
      });

      const collisions = grouped.map((g) => ({
        date: g.date.toISOString().slice(0, 10), // "YYYY-MM-DD" — no PII
        count: g._count._all,
      }));
      const total = collisions.reduce((sum, c) => sum + c.count, 0);

      // Deep-link (graceful degrade). Load the tenant's Phorest identifiers and hand them to the
      // builder, which currently returns null (owner-gated: the web-calendar URL shape is not exposed
      // by the v3 API) but keeps the response contract stable (`deepLink: string | null`) for when the
      // real calendar URL format is pinned.
      const cfg = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: req.user.tenantId },
        select: { phorestBusinessId: true, phorestBranchId: true, phorestBaseUrl: true },
      });
      const deepLink = buildPhorestCalendarDeepLink(cfg, employeeId, from);

      return { total, collisions, deepLink };
    },
  });
}
