import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../../middleware/auth";
import { encrypt, decryptSafe } from "../../../utils/crypto";
import { withAdvisoryLock, tenantAdvisoryKey } from "../../../utils/with-advisory-lock";
import { phorestFetch, PhorestApiError } from "../../../services/phorest/client";
import {
  syncPhorestForTenant,
  aggregateSalonSyncResults,
  type SalonSyncResult,
} from "../../../services/phorest/sync-tenant";
import type { PhorestStaffItem } from "../../../services/phorest/types";
// Phase 65b (issue #65): every salon read from Schichtplanung goes through the Unterbau's public
// facade — never a direct `prisma.salon.*` call from this context (ADR 0001).
import { findSalon, listSalons, permissionReach, requirePermission } from "../../platform";

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
 * Since Phase 65b (issue #65) the trigger calls the orchestrator syncPhorestForTenant()
 * (services/phorest/sync-tenant.ts), which syncs every coupled ACTIVE salon under that one lock.
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
  // Phase 65b (issue #65, D-19): the branch moved to the salon's coupling. Optional — it is sent
  // only while the tenant has exactly one active salon (branchIdEditable); PUT re-checks that
  // count itself rather than trusting the client's decision to send or omit the key.
  branchId: z.string().trim().min(1).optional(),
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
  // Phase 85.1 (D-01): tenant-global Vor-/Nachbereitungszeit puffer, applied to every imported
  // Phorest shift's stored start/end times.
  phorestPrepMinutes: z.coerce.number().int().min(0).max(30).optional(),
  phorestWrapupMinutes: z.coerce.number().int().min(0).max(30).optional(),
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
    // Phase 65b (issue #65, D-18): optional deep-link salon for the range shape. Absent, the
    // resolver falls back to the tenant's single active coupling (graceful degrade — never a 400
    // here, the count/groupBy never depends on it).
    salonId: z.string().uuid().optional(),
  }),
  z.object({ shiftId: z.string().uuid() }),
]);

// ── Phorest Salon Coupling (Phase 65b, issue #65) ────────────────────────────────────────────
//
// D-14/D-15/D-16: a SalonCoupling is the branch a salon syncs against. `provider` is fixed to
// "PHOREST" by the routes below — a client never chooses it. There is deliberately NO update
// route (D-17): the only in-place update of a coupling is the single-salon admin-page path
// (PUT /phorest/config, Task 2) — everything else is create-or-delete.

const couplingCreateSchema = z.object({
  salonId: z.string().uuid(),
  externalBranchId: z.string().trim().min(1).max(100),
});

const couplingParamSchema = z.object({ salonId: z.string().uuid() });

// Fixed reply bodies shared by the coupling routes AND (Task 2) the salon-aware
// test/staff/collision resolver and the config PUT — one place for every wording.
const SALON_NOT_FOUND_REPLY = { status: 404 as const, body: { error: "Salon nicht gefunden" } };
const SALON_INACTIVE_REPLY = {
  status: 422 as const,
  body: { error: "Salon ist deaktiviert", code: "SALON_INACTIVE" as const },
};
const SALON_ALREADY_COUPLED_REPLY = {
  status: 409 as const,
  body: {
    error: "Dieser Salon ist bereits mit Phorest gekoppelt.",
    code: "SALON_ALREADY_COUPLED" as const,
  },
};
const BRANCH_ALREADY_COUPLED_REPLY = {
  status: 409 as const,
  body: {
    error: "Diese Phorest-Filiale ist bereits mit einem anderen Salon gekoppelt.",
    code: "BRANCH_ALREADY_COUPLED" as const,
  },
};
const COUPLING_NOT_FOUND_REPLY = {
  status: 404 as const,
  body: { error: "Kopplung nicht gefunden" },
};

/** Source: apps/api/src/contexts/platform/api/role-assignments.ts (structural P2002 idiom). */
function isPrismaErrorCode(err: unknown, code: string): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

// Phase 65b (issue #65, D-18): every route that talks to Phorest on a tenant's behalf resolves
// its branch through this ONE function — never re-implemented per route.
type CouplingResolution =
  | { kind: "ok"; salonId: string; externalBranchId: string }
  | { kind: "none" }
  | { kind: "reject"; status: 400 | 404; body: Record<string, unknown> };

/**
 * Resolves which salon's Phorest branch a request should use.
 *
 * - An EXPLICIT `salonId`: `findSalon` null → reject 404 `SALON_NOT_FOUND` (foreign ≡ unknown, same
 *   shape everywhere in this file). A found salon without a coupling → reject 404 with the "salon
 *   not coupled to Phorest" message (see `SALON_NOT_FOUND_REPLY`'s sibling literal below) —
 *   deliberately NOT gated on `isActive` here: an explicit id may name an inactive own salon (the
 *   caller asked for it by name), unlike the no-`salonId` path below, whose "exactly one" rule
 *   counts ACTIVE salons only.
 * - No `salonId`: among the tenant's ACTIVE salons (D-18), the ones with a PHOREST coupling —
 *   exactly one → `ok`; zero → `none` (existing "not configured" shapes); more than one → reject
 *   400 `SALON_REQUIRED`.
 */
async function resolvePhorestCoupling(
  app: FastifyInstance,
  tenantId: string,
  salonId: string | null | undefined,
): Promise<CouplingResolution> {
  if (salonId) {
    const salon = await findSalon(app.prisma, tenantId, salonId);
    if (!salon) {
      return {
        kind: "reject",
        status: SALON_NOT_FOUND_REPLY.status,
        body: SALON_NOT_FOUND_REPLY.body,
      };
    }
    const coupling = await app.prisma.salonCoupling.findFirst({
      where: { salonId, tenantId, provider: "PHOREST" },
    });
    if (!coupling) {
      return {
        kind: "reject",
        status: 404,
        body: { error: "Salon ist nicht mit Phorest gekoppelt." },
      };
    }
    return { kind: "ok", salonId: coupling.salonId, externalBranchId: coupling.externalBranchId };
  }

  const activeSalons = await listSalons(app.prisma, tenantId, { includeInactive: false });
  const activeSalonIds = activeSalons.map((s) => s.id);
  const couplings =
    activeSalonIds.length === 0
      ? []
      : await app.prisma.salonCoupling.findMany({
          where: { tenantId, provider: "PHOREST", salonId: { in: activeSalonIds } },
        });

  if (couplings.length === 0) return { kind: "none" };
  if (couplings.length > 1) {
    return {
      kind: "reject",
      status: 400,
      body: {
        error: "Bitte einen Salon angeben — der Mandant hat mehrere Phorest-Kopplungen.",
        code: "SALON_REQUIRED",
      },
    };
  }
  const [only] = couplings;
  return { kind: "ok", salonId: only.salonId, externalBranchId: only.externalBranchId };
}

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
 *
 * Phase 65b (issue #65): `branchId` is now the RESOLVED coupling's external branch id — the
 * salon-level concept — not the deprecated tenant-level column; the parameter name changed to match.
 */
function buildPhorestCalendarDeepLink(
  _cfg: {
    businessId: string | null;
    branchId: string | null;
    baseUrl: string | null;
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
  // ── Phorest Salon Coupling (Phase 65b, issue #65, D-14/D-15/D-16) ──────

  // GET /phorest/couplings — the tenant's couplings, one row per coupled salon.
  app.get("/phorest/couplings", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("integration:manage:ZUGEWIESEN"),
    handler: async (req) => {
      const tenantId = req.user.tenantId;
      const salons = await listSalons(app.prisma, tenantId, { includeInactive: true });
      const couplings = await app.prisma.salonCoupling.findMany({ where: { tenantId } });
      const couplingBySalon = new Map(couplings.map((c) => [c.salonId, c]));

      const result = [];
      for (const salon of salons) {
        const coupling = couplingBySalon.get(salon.id);
        if (!coupling) continue;
        result.push({
          id: coupling.id,
          salonId: salon.id,
          salonName: salon.name,
          salonIsActive: salon.isActive,
          provider: coupling.provider,
          externalBranchId: coupling.externalBranchId,
          createdAt: coupling.createdAt,
        });
      }
      return { couplings: result };
    },
  });

  // POST /phorest/couplings — couple a salon to a Phorest branch (provider fixed by the route).
  app.post("/phorest/couplings", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("integration:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const tenantId = req.user.tenantId;
      const body = couplingCreateSchema.parse(req.body);

      const salon = await findSalon(app.prisma, tenantId, body.salonId);
      if (!salon) {
        return reply.code(SALON_NOT_FOUND_REPLY.status).send(SALON_NOT_FOUND_REPLY.body);
      }
      if (!salon.isActive) {
        return reply.code(SALON_INACTIVE_REPLY.status).send(SALON_INACTIVE_REPLY.body);
      }
      const salonAlreadyCoupled = await app.prisma.salonCoupling.findFirst({
        where: { salonId: body.salonId, tenantId },
      });
      if (salonAlreadyCoupled) {
        return reply
          .code(SALON_ALREADY_COUPLED_REPLY.status)
          .send(SALON_ALREADY_COUPLED_REPLY.body);
      }
      const branchAlreadyCoupled = await app.prisma.salonCoupling.findFirst({
        where: { tenantId, provider: "PHOREST", externalBranchId: body.externalBranchId },
      });
      if (branchAlreadyCoupled) {
        return reply
          .code(BRANCH_ALREADY_COUPLED_REPLY.status)
          .send(BRANCH_ALREADY_COUPLED_REPLY.body);
      }

      let coupling;
      try {
        coupling = await app.prisma.salonCoupling.create({
          data: {
            tenantId,
            salonId: body.salonId,
            provider: "PHOREST",
            externalBranchId: body.externalBranchId,
          },
        });
      } catch (err: unknown) {
        if (isPrismaErrorCode(err, "P2002")) {
          // A concurrent identical POST won the race — re-check which unique constraint the
          // loser (this request) hit and answer the SAME 409 a sequential retry would get.
          const bySalon = await app.prisma.salonCoupling.findFirst({
            where: { salonId: body.salonId, tenantId },
          });
          if (bySalon) {
            return reply
              .code(SALON_ALREADY_COUPLED_REPLY.status)
              .send(SALON_ALREADY_COUPLED_REPLY.body);
          }
          return reply
            .code(BRANCH_ALREADY_COUPLED_REPLY.status)
            .send(BRANCH_ALREADY_COUPLED_REPLY.body);
        }
        throw err;
      }

      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "SalonCoupling",
        entityId: coupling.id,
        newValue: {
          salonId: coupling.salonId,
          provider: coupling.provider,
          externalBranchId: coupling.externalBranchId,
        },
      });

      return reply.code(201).send({
        coupling: {
          id: coupling.id,
          salonId: coupling.salonId,
          provider: coupling.provider,
          externalBranchId: coupling.externalBranchId,
        },
      });
    },
  });

  // DELETE /phorest/couplings/:salonId — remove a salon's coupling (hard delete: configuration,
  // not time data — owner decision, issue #65). Shifts, appointments and sync runs are untouched;
  // the FK on those points at the SALON, not the coupling.
  //
  // T-100-09 (D-16): ONE tenant-scoped lookup makes a foreign salon, an unknown id, and an own
  // salon that was never coupled indistinguishable by construction — see
  // `apps/api/scripts/lint-t100-09-routes.json`'s entry for this route.
  app.delete("/phorest/couplings/:salonId", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("integration:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const tenantId = req.user.tenantId;
      const { salonId } = couplingParamSchema.parse(req.params);

      const existing = await app.prisma.salonCoupling.findFirst({ where: { salonId, tenantId } });
      if (!existing) {
        return reply.code(COUPLING_NOT_FOUND_REPLY.status).send(COUPLING_NOT_FOUND_REPLY.body);
      }

      await app.prisma.salonCoupling.delete({ where: { id: existing.id } });

      await app.audit({
        userId: req.user.sub,
        action: "DELETE",
        entity: "SalonCoupling",
        entityId: existing.id,
        oldValue: {
          salonId: existing.salonId,
          provider: existing.provider,
          externalBranchId: existing.externalBranchId,
        },
      });

      return { success: true };
    },
  });

  // ── Phorest Config ────────────────────────────────────────────────────

  // GET /phorest/config — aktuelle Phorest-Konfiguration
  //
  // Phase 65b (issue #65, D-19): `branchId` is the sole active salon's coupling (null otherwise),
  // `branchIdEditable` is true iff the tenant has exactly one active salon. The deprecated
  // TenantConfig column is no longer selected.
  app.get("/phorest/config", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("integration:manage:ZUGEWIESEN"),
    handler: async (req) => {
      const tenantId = req.user.tenantId;
      const cfg = await app.prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: {
          phorestBusinessId: true,
          phorestUsername: true,
          phorestBaseUrl: true,
          phorestAutoSync: true,
          phorestSyncCron: true,
          phorestSyncWindowDays: true,
          phorestPrepMinutes: true,
          phorestWrapupMinutes: true,
          // Passwort nicht zurückgeben
        },
      });

      const activeSalons = await listSalons(app.prisma, tenantId, { includeInactive: false });
      const branchIdEditable = activeSalons.length === 1;
      let branchId: string | null = null;
      if (branchIdEditable) {
        const coupling = await app.prisma.salonCoupling.findFirst({
          where: { salonId: activeSalons[0].id, tenantId, provider: "PHOREST" },
        });
        branchId = coupling?.externalBranchId ?? null;
      }

      return {
        configured: !!(cfg?.phorestBusinessId && cfg?.phorestUsername),
        ...cfg,
        branchId,
        branchIdEditable,
      };
    },
  });

  // PUT /phorest/config — Phorest-Zugangsdaten speichern
  //
  // Phase 65b (issue #65, D-19): `branchId` creates or in-place-updates the sole active salon's
  // coupling, in the SAME transaction as the TenantConfig write. Refused (400 BRANCH_PER_SALON)
  // unless the tenant has exactly one active salon; a same-tenant branch collision answers 409
  // BRANCH_ALREADY_COUPLED. The PhorestConfig audit no longer carries a branch.
  app.put("/phorest/config", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("integration:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const tenantId = req.user.tenantId;
      const body = configSchema.parse(req.body);

      let soleActiveSalonId: string | undefined;
      if (body.branchId !== undefined) {
        const activeSalons = await listSalons(app.prisma, tenantId, { includeInactive: false });
        if (activeSalons.length !== 1) {
          return reply.code(400).send({
            error: "Mehrere aktive Salons: die Phorest-Filiale wird je Salon gekoppelt.",
            code: "BRANCH_PER_SALON",
          });
        }
        soleActiveSalonId = activeSalons[0].id;

        const branchUsedElsewhere = await app.prisma.salonCoupling.findFirst({
          where: {
            tenantId,
            provider: "PHOREST",
            externalBranchId: body.branchId,
            salonId: { not: soleActiveSalonId },
          },
        });
        if (branchUsedElsewhere) {
          return reply
            .code(BRANCH_ALREADY_COUPLED_REPLY.status)
            .send(BRANCH_ALREADY_COUPLED_REPLY.body);
        }
      }

      try {
        await app.prisma.$transaction(async (tx) => {
          await tx.tenantConfig.update({
            where: { tenantId },
            data: {
              phorestBusinessId: body.phorestBusinessId,
              phorestUsername: body.phorestUsername,
              // Only re-encrypt/overwrite when a new password was actually supplied (see schema note).
              ...(body.phorestPassword ? { phorestPassword: encrypt(body.phorestPassword) } : {}),
              ...(body.phorestBaseUrl ? { phorestBaseUrl: body.phorestBaseUrl } : {}),
              ...(body.phorestAutoSync !== undefined
                ? { phorestAutoSync: body.phorestAutoSync }
                : {}),
              ...(body.phorestSyncCron ? { phorestSyncCron: body.phorestSyncCron } : {}),
              ...(body.phorestSyncWindowDays !== undefined
                ? { phorestSyncWindowDays: body.phorestSyncWindowDays }
                : {}),
              ...(body.phorestPrepMinutes !== undefined
                ? { phorestPrepMinutes: body.phorestPrepMinutes }
                : {}),
              ...(body.phorestWrapupMinutes !== undefined
                ? { phorestWrapupMinutes: body.phorestWrapupMinutes }
                : {}),
            },
          });

          if (soleActiveSalonId !== undefined && body.branchId !== undefined) {
            const existingCoupling = await tx.salonCoupling.findFirst({
              where: { salonId: soleActiveSalonId, tenantId },
            });
            if (!existingCoupling) {
              const created = await tx.salonCoupling.create({
                data: {
                  tenantId,
                  salonId: soleActiveSalonId,
                  provider: "PHOREST",
                  externalBranchId: body.branchId,
                },
              });
              await app.audit({
                userId: req.user.sub,
                action: "CREATE",
                entity: "SalonCoupling",
                entityId: created.id,
                newValue: {
                  salonId: created.salonId,
                  provider: created.provider,
                  externalBranchId: created.externalBranchId,
                },
                tx,
              });
            } else if (existingCoupling.externalBranchId !== body.branchId) {
              const updated = await tx.salonCoupling.update({
                where: { id: existingCoupling.id },
                data: { externalBranchId: body.branchId },
              });
              await app.audit({
                userId: req.user.sub,
                action: "UPDATE",
                entity: "SalonCoupling",
                entityId: updated.id,
                oldValue: { externalBranchId: existingCoupling.externalBranchId },
                newValue: { externalBranchId: updated.externalBranchId },
                tx,
              });
            }
          }

          await app.audit({
            userId: req.user.sub,
            action: "UPDATE",
            entity: "PhorestConfig",
            newValue: {
              businessId: body.phorestBusinessId,
              autoSync: body.phorestAutoSync,
            },
            tx,
          });
        });
      } catch (err: unknown) {
        if (isPrismaErrorCode(err, "P2002")) {
          return reply
            .code(BRANCH_ALREADY_COUPLED_REPLY.status)
            .send(BRANCH_ALREADY_COUPLED_REPLY.body);
        }
        throw err;
      }

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
    preHandler: requirePermission("integration:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const tenantId = req.user.tenantId;
      // `.optional().nullable()` — Clokr frontends send an explicit `null` for an empty optional
      // field (CLAUDE.md "Zod .optional() vs .nullable()"); plain `.optional()` would 400 that.
      const { salonId } = z
        .object({ salonId: z.string().uuid().optional().nullable() })
        .parse(req.body ?? {});

      const resolution = await resolvePhorestCoupling(app, tenantId, salonId);
      if (resolution.kind === "reject") {
        return reply.code(resolution.status).send(resolution.body);
      }

      const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      const phorestPwd = decryptSafe(cfg?.phorestPassword);
      if (
        resolution.kind === "none" ||
        !cfg?.phorestBusinessId ||
        !cfg?.phorestUsername ||
        !phorestPwd
      ) {
        return {
          ok: false,
          reason: "not-configured",
          message: "Phorest-Zugangsdaten nicht konfiguriert.",
        };
      }

      try {
        const staff = await phorestFetch(
          cfg.phorestBaseUrl ?? "https://api-gateway-eu.phorest.com/third-party-api-server",
          `/api/business/${cfg.phorestBusinessId}/branch/${resolution.externalBranchId}/staff`,
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
    preHandler: requirePermission("integration:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const tenantId = req.user.tenantId;
      const { salonId } = z.object({ salonId: z.string().uuid().optional() }).parse(req.query);

      const resolution = await resolvePhorestCoupling(app, tenantId, salonId);
      if (resolution.kind === "reject") {
        return reply.code(resolution.status).send(resolution.body);
      }

      const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      const staffPwd = decryptSafe(cfg?.phorestPassword);
      if (
        resolution.kind === "none" ||
        !cfg?.phorestBusinessId ||
        !cfg?.phorestUsername ||
        !staffPwd
      ) {
        return { error: "Phorest nicht konfiguriert" };
      }

      // Phorest-Mitarbeiter laden
      const phorestData = await phorestFetch(
        cfg.phorestBaseUrl ?? "https://api-gateway-eu.phorest.com/third-party-api-server",
        `/api/business/${cfg.phorestBusinessId}/branch/${resolution.externalBranchId}/staff`,
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
    preHandler: requirePermission("integration:manage:ZUGEWIESEN"),
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
    preHandler: requirePermission("integration:manage:ZUGEWIESEN"),
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
    preHandler: requirePermission("integration:manage:ZUGEWIESEN"),
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
  //
  // Phase 65b (issue #65, D-21): every run row is enriched with `salonName`, resolved via the
  // Unterbau facade (a run's salon may since have been deactivated, so `includeInactive: true`).
  app.get("/phorest/sync-runs", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("integration:manage:ZUGEWIESEN"),
    handler: async (req) => {
      const tenantId = req.user.tenantId;
      const { limit, page } = syncRunsQuerySchema.parse(req.query);
      const where = { tenantId };

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

      const salons = await listSalons(app.prisma, tenantId, { includeInactive: true });
      const salonNameById = new Map(salons.map((s) => [s.id, s.name]));
      const withSalonName = <T extends { salonId: string }>(run: T) => ({
        ...run,
        salonName: salonNameById.get(run.salonId) ?? null,
      });

      return {
        latest: latest ? withSalonName(latest) : null,
        history: history.map(withSalonName),
        total,
        page,
        limit,
      };
    },
  });

  // ── Phorest Sync ──────────────────────────────────────────────────────

  // POST /phorest/sync-shifts — Schichten aus Phorest importieren
  app.post("/phorest/sync-shifts", {
    schema: { tags: ["Integrationen"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("integration:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { startDate, endDate } = syncSchema.parse(req.body);

      const tenantId = req.user.tenantId;

      // SS-07: the manual trigger takes the SAME per-tenant advisory lock as the cron so a
      // manual click can't race the scheduled sync. Both call the ONE shared orchestrator
      // (Phase 65b, D-13), which syncs every coupled ACTIVE salon inside this one lock.
      let results: SalonSyncResult[] | undefined;
      await withAdvisoryLock(
        app.prisma,
        tenantAdvisoryKey(tenantId),
        async () => {
          results = await syncPhorestForTenant(app, tenantId, {
            startDate,
            endDate,
            actorUserId: req.user.sub,
          });
        },
        app.log,
      );

      if (results === undefined) {
        // Lock not acquired — another sync (cron or a concurrent manual click) is running.
        return reply
          .code(409)
          .send({ error: "Ein Phorest-Sync läuft bereits. Bitte später erneut versuchen." });
      }

      if (results.length === 0) {
        return reply.code(409).send({
          error: "Kein aktiver Salon ist mit Phorest gekoppelt.",
          code: "NO_PHOREST_COUPLING",
        });
      }

      // Backward-compatible top-level aggregate (the admin page reads it) plus per-salon results.
      return aggregateSalonSyncResults(results);
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
      const tenantId = req.user.tenantId;
      // One permissionReach feeds both decisions below (issue #75, D-13): the shiftId shape's
      // manager-only gate and the range shape's foreign-employeeId gate.
      const shiftReadReach = await permissionReach(req, "shift:read");
      if (shiftReadReach === null) {
        return reply.code(403).send({ error: "Keine Berechtigung" });
      }
      const isManager = shiftReadReach === "ZUGEWIESEN";

      // Resolve the tenant-proven employeeId + inclusive [from,to] window for both input shapes.
      let employeeId: string;
      let from: Date;
      let to: Date;
      // The salon whose coupling backs the deep link (Phase 65b, D-18). Left undefined only for
      // the range shape without an explicit salonId — resolved via the graceful fallback below.
      let deepLinkSalonId: string | undefined;

      if ("shiftId" in q) {
        // Shift removal is a manager/admin action (mirrors DELETE /shifts/:id = requireRole ADMIN,MANAGER).
        if (!isManager) {
          return reply.code(403).send({ error: "Keine Berechtigung" });
        }
        // Tenant gate: the shift MUST belong to an employee of the caller's tenant (else 404).
        const shift = await app.prisma.shift.findFirst({
          where: { id: q.shiftId, employee: { tenantId }, deletedAt: null },
          select: { employeeId: true, date: true, salonId: true },
        });
        if (!shift) {
          return reply.code(404).send({ error: "Schicht nicht gefunden" });
        }
        employeeId = shift.employeeId;
        from = shift.date;
        to = shift.date; // single-day window
        deepLinkSalonId = shift.salonId;
      } else {
        // A non-manager may only pre-check their OWN leave window.
        if (q.employeeId !== req.user.employeeId && !isManager) {
          return reply.code(403).send({ error: "Keine Berechtigung" });
        }
        // Tenant gate: this scoped lookup IS the isolation boundary (404 on cross-tenant / unknown id).
        const emp = await app.prisma.employee.findFirst({
          where: { id: q.employeeId, tenantId },
          select: { id: true },
        });
        if (!emp) {
          return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
        }
        employeeId = emp.id;
        from = new Date(q.from);
        to = new Date(q.to);

        if (q.salonId) {
          // Phase 65b (issue #65, D-18): an explicit salonId on the range shape IS validated —
          // foreign/unknown answers the same byte-identical 404 as every other salon lookup here.
          // This is the one case that DOES fail the request on salon resolution; the no-salonId
          // fallback below never does.
          const salon = await findSalon(app.prisma, tenantId, q.salonId);
          if (!salon) {
            return reply.code(SALON_NOT_FOUND_REPLY.status).send(SALON_NOT_FOUND_REPLY.body);
          }
          deepLinkSalonId = salon.id;
        }
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

      // Deep-link (graceful degrade, D-18): resolving the salon for the link NEVER fails the
      // collision check itself — a missing coupling, or (range shape, no salonId) more than one
      // active coupling, just means no link, never a 400/404 for THIS reason.
      let externalBranchId: string | null = null;
      if (deepLinkSalonId) {
        const coupling = await app.prisma.salonCoupling.findFirst({
          where: { salonId: deepLinkSalonId, tenantId, provider: "PHOREST" },
        });
        externalBranchId = coupling?.externalBranchId ?? null;
      } else if (!("shiftId" in q)) {
        const resolution = await resolvePhorestCoupling(app, tenantId, undefined);
        if (resolution.kind === "ok") externalBranchId = resolution.externalBranchId;
      }

      // Load the tenant's Phorest identifiers and hand them to the builder, which currently
      // returns null (owner-gated: the web-calendar URL shape is not exposed by the v3 API) but
      // keeps the response contract stable (`deepLink: string | null`) for when the real calendar
      // URL format is pinned.
      const cfg = await app.prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: { phorestBusinessId: true, phorestBaseUrl: true },
      });
      const deepLink = buildPhorestCalendarDeepLink(
        {
          businessId: cfg?.phorestBusinessId ?? null,
          branchId: externalBranchId,
          baseUrl: cfg?.phorestBaseUrl ?? null,
        },
        employeeId,
        from,
      );

      return { total, collisions, deepLink };
    },
  });
}
