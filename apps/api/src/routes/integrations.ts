import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../middleware/auth";
import { encrypt, decryptSafe } from "../utils/crypto";

/**
 * Phorest API Integration
 *
 * Endpoints:
 *   GET  /api/business/{bid}/branch/{brid}/staff
 *   GET  /api/business/{bid}/branch/{brid}/staffworktimetables?start_date=&end_date=
 *   GET  /api/business/{bid}/branch/{brid}/appointment?appointmentDate=
 *
 * Auth: Basic Auth with "global/{email}" as username
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

interface PhorestStaff {
  staffId: string;
  firstName: string;
  lastName: string;
  email?: string;
}

interface PhorestWorkTimeEntry {
  staffId: string;
  date: string; // ISO date
  startTime: string; // ISO datetime
  endTime: string; // ISO datetime
}

interface PhorestApiResponse {
  totalElements?: unknown;
  _embedded?: { staff?: PhorestStaffRaw[]; staffWorkTimeTables?: PhorestWorkTimeEntry[] };
  staff?: PhorestStaffRaw[];
  staffWorkTimeTables?: PhorestWorkTimeEntry[];
  [key: string]: unknown;
}

interface PhorestStaffRaw {
  staffId: string;
  firstName: string;
  lastName: string;
  email?: string;
}

async function phorestFetch(
  baseUrl: string,
  path: string,
  username: string,
  password: string,
  query?: Record<string, string>,
): Promise<PhorestApiResponse> {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }

  const auth = Buffer.from(`global/${username}:${password}`).toString("base64");

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Phorest API error ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json() as Promise<PhorestApiResponse>;
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

      const phorestStaff: PhorestStaff[] = (
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

      const cfg = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: req.user.tenantId },
      });
      const syncPwd = decryptSafe(cfg?.phorestPassword);
      if (!cfg?.phorestBusinessId || !cfg?.phorestUsername || !syncPwd) {
        return reply.code(400).send({ error: "Phorest nicht konfiguriert" });
      }

      const baseUrl = cfg.phorestBaseUrl ?? "https://api.phorest.com/third-party-api-server";
      const biz = cfg.phorestBusinessId;
      const branch = cfg.phorestBranchId;

      // 1. Staff-Mapping: Phorest staffId → Clokr employeeId
      const phorestData = await phorestFetch(
        baseUrl,
        `/api/business/${biz}/branch/${branch}/staff`,
        cfg.phorestUsername,
        syncPwd,
        { size: "200", page: "0" },
      );

      const phorestStaff: PhorestStaff[] = phorestData._embedded?.staff ?? phorestData.staff ?? [];

      const clokrEmployees = await app.prisma.employee.findMany({
        where: { tenantId: req.user.tenantId },
        include: { user: { select: { email: true } } },
      });

      const staffMap = new Map<string, string>(); // phorestStaffId → clokrEmployeeId
      for (const ps of phorestStaff) {
        const match = clokrEmployees.find(
          (ce) =>
            ce.user.email.toLowerCase() === (ps.email ?? "").toLowerCase() ||
            (ce.firstName.toLowerCase() === ps.firstName.toLowerCase() &&
              ce.lastName.toLowerCase() === ps.lastName.toLowerCase()),
        );
        if (match) staffMap.set(ps.staffId, match.id);
      }

      // 2. WorkTimeTables aus Phorest laden
      let wttData;
      try {
        wttData = await phorestFetch(
          baseUrl,
          `/api/business/${biz}/branch/${branch}/staffworktimetables`,
          cfg.phorestUsername,
          syncPwd,
          { start_date: startDate, end_date: endDate },
        );
      } catch (err: unknown) {
        app.log.error({ err }, "Fehler beim Laden der Phorest WorkTimeTables");
        return reply
          .code(502)
          .send({ error: `Phorest WorkTimeTables nicht abrufbar: ${err instanceof Error ? err.message : String(err)}` });
      }
      // Phorest gibt ein Array von Arbeitszeiteinträgen zurück
      const entries =
        wttData._embedded?.staffWorkTimeTables ?? wttData.staffWorkTimeTables ?? wttData ?? [];
      const workTimes: PhorestWorkTimeEntry[] = Array.isArray(entries) ? entries : [];

      // 3. Schichten in Clokr erstellen
      let created = 0;
      let skipped = 0;
      let unmapped = 0;
      const errors: string[] = [];

      for (const wt of workTimes) {
        const employeeId = staffMap.get(wt.staffId);
        if (!employeeId) {
          unmapped++;
          continue;
        }

        // Datum und Zeiten extrahieren
        const date = wt.date ?? (wt.startTime ? wt.startTime.split("T")[0] : null);
        if (!date) {
          skipped++;
          continue;
        }

        const startH = wt.startTime ? new Date(wt.startTime).toISOString().slice(11, 16) : null;
        const endH = wt.endTime ? new Date(wt.endTime).toISOString().slice(11, 16) : null;
        if (!startH || !endH) {
          skipped++;
          continue;
        }

        // Prüfen ob Schicht schon existiert (gleicher MA, Tag, Zeiten)
        const existing = await app.prisma.shift.findFirst({
          where: {
            employeeId,
            date: new Date(date),
            startTime: startH,
            endTime: endH,
          },
        });
        if (existing) {
          skipped++;
          continue;
        }

        try {
          await app.prisma.shift.create({
            data: {
              employeeId,
              date: new Date(date),
              startTime: startH,
              endTime: endH,
              label: "Phorest",
              createdBy: req.user.sub,
            },
          });
          created++;
        } catch (err: unknown) {
          errors.push(`${date} ${startH}-${endH}: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`);
        }
      }

      await app.audit({
        userId: req.user.sub,
        action: "IMPORT",
        entity: "Shift",
        newValue: {
          source: "Phorest",
          startDate,
          endDate,
          created,
          skipped,
          unmapped,
          errors: errors.length,
        },
      });

      return {
        total: workTimes.length,
        created,
        skipped,
        unmapped,
        errors: errors.length,
        errorDetails: errors.slice(0, 10),
        staffMapped: staffMap.size,
        staffTotal: phorestStaff.length,
      };
    },
  });
}
