// Phase 67.2 — Sync-Plugin: pulls OpenHolidays data into SchoolHolidayPeriod cache.
//
// Architecture:
//   - Cron `0 3 * * 6` (Saturday 03:00 server time) — weekly sync for every tenant
//     that has at least one active EmployeeVocationalSchoolPattern. Non-BS tenants
//     are skipped entirely (zero API calls for them).
//   - syncSchoolHolidaysForTenant() exported as a stand-alone helper so the admin
//     refresh endpoint AND Plan 67.2-03 (vocational-school generator) can call it
//     synchronously on first-pattern-create — without waiting for the cron.
//
// Stale-Cache Policy (RESEARCH §126-130):
//   On API failure, EXISTING rows are kept intact (upsert semantics — we never
//   delete-then-refetch). The result object surfaces a per-state status
//   ('OK' | 'STALE' | 'FAILED') so callers can warn the admin when the cache is
//   older than STALE_THRESHOLD_MS (default 30 days).
//
// Audit-Proofness: All upserts use the schema's @@unique key, so re-running
// produces zero side effects beyond updating `fetchedAt`. No cascade deletes
// happen here.

import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";
import { withAdvisoryLock, ADVISORY_LOCK_KEYS } from "../utils/with-advisory-lock";
import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "@clokr/db";
import { FederalState } from "@clokr/db";
import { fetchSchoolHolidays, SchoolHolidaysApiError } from "../utils/school-holidays-client";
import { federalStateToIso } from "../utils/federal-state-iso";

const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage

export type SyncStatus = "OK" | "STALE" | "FAILED";

export interface SyncPerStateResult {
  federalState: FederalState;
  upserts: number;
  status: SyncStatus;
  error?: string;
}

export interface SyncResult {
  syncedAt: Date;
  perState: SyncPerStateResult[];
}

/**
 * Minimal logger shape the helper needs. Fastify's `app.log` matches this
 * structurally, so we can pass either app.log or a custom mock.
 */
export interface SyncLogger {
  warn: (obj: object, msg?: string) => void;
  info: (obj: object, msg?: string) => void;
}

/**
 * Pulls Schulferien data for the given (tenantId, federalStates, yearRange) into
 * the SchoolHolidayPeriod cache. Idempotent: re-running with the same inputs is
 * a no-op beyond `fetchedAt` updates. On per-state failure, existing rows are
 * preserved and `status` reflects FAILED (recent cache) or STALE (>30d).
 */
export async function syncSchoolHolidaysForTenant(
  prisma: PrismaClient,
  tenantId: string,
  federalStates: FederalState[],
  yearRange: { from: number; to: number },
  logger: SyncLogger,
): Promise<SyncResult> {
  const syncedAt = new Date();
  const perState: SyncPerStateResult[] = [];

  for (const fs of federalStates) {
    const iso = federalStateToIso(fs);
    try {
      const dtos = await fetchSchoolHolidays(iso, yearRange.from, yearRange.to);
      let upserts = 0;
      for (const dto of dtos) {
        await prisma.schoolHolidayPeriod.upsert({
          where: {
            tenantId_federalState_startDate_endDate_source: {
              tenantId,
              federalState: fs,
              startDate: dto.startDate,
              endDate: dto.endDate,
              source: "OPENHOLIDAYS_API",
            },
          },
          update: {
            fetchedAt: syncedAt,
            externalId: dto.externalId,
            name: dto.name,
          },
          create: {
            tenantId,
            federalState: fs,
            startDate: dto.startDate,
            endDate: dto.endDate,
            name: dto.name,
            source: "OPENHOLIDAYS_API",
            externalId: dto.externalId,
            fetchedAt: syncedAt,
          },
        });
        upserts++;
      }
      perState.push({ federalState: fs, upserts, status: "OK" });
    } catch (err) {
      const isApiErr = err instanceof SchoolHolidaysApiError;
      const status = isApiErr ? (err as SchoolHolidaysApiError).status : "UNKNOWN";
      const errMsg = (err as Error).message;

      logger.warn(
        { tenantId, federalState: fs, iso, status },
        `school-holidays sync failed for ${iso}: ${errMsg}`,
      );

      // Determine staleness based on the most recent existing row.
      const newest = await prisma.schoolHolidayPeriod.findFirst({
        where: { tenantId, federalState: fs },
        orderBy: { fetchedAt: "desc" },
        select: { fetchedAt: true },
      });
      const isStale =
        !newest || syncedAt.getTime() - newest.fetchedAt.getTime() > STALE_THRESHOLD_MS;

      perState.push({
        federalState: fs,
        upserts: 0,
        status: isStale ? "STALE" : "FAILED",
        error: errMsg,
      });
    }
  }

  return { syncedAt, perState };
}

/**
 * Helper to surface the Fastify logger as a SyncLogger for the cron callback.
 */
function asSyncLogger(log: FastifyBaseLogger): SyncLogger {
  return {
    warn: (obj, msg) => log.warn(obj, msg),
    info: (obj, msg) => log.info(obj, msg),
  };
}

declare module "fastify" {
  interface FastifyInstance {
    runSchoolHolidaysSync?: () => Promise<void>;
  }
}

export const schoolHolidaysSyncPlugin = fp(
  async (app: FastifyInstance) => {
    const tasks: ScheduledTask[] = [];

    async function runAllTenants() {
      app.log.info("school-holidays cron: starting weekly sync");

      const tenants = await app.prisma.tenant.findMany({
        where: {
          employees: {
            some: {
              vocationalSchoolPatterns: { some: { isActive: true } },
            },
          },
        },
        include: {
          employees: {
            include: {
              vocationalSchoolPatterns: {
                where: { isActive: true },
                select: { federalStateOverride: true },
              },
            },
          },
        },
      });

      const now = new Date();
      const yearRange = { from: now.getFullYear(), to: now.getFullYear() + 1 };

      for (const t of tenants) {
        const needed = new Set<FederalState>([t.federalState]);
        for (const e of t.employees) {
          for (const p of e.vocationalSchoolPatterns) {
            if (p.federalStateOverride) needed.add(p.federalStateOverride);
          }
        }
        try {
          await syncSchoolHolidaysForTenant(
            app.prisma,
            t.id,
            [...needed],
            yearRange,
            asSyncLogger(app.log),
          );
        } catch (err) {
          app.log.error(
            { err, tenantId: t.id },
            "school-holidays sync: unexpected error per tenant",
          );
        }
      }
    }

    app.decorate("runSchoolHolidaysSync", runAllTenants);

    // Weekly: Saturday 03:00 Berlin time.
    const task = cron.schedule(
      "0 3 * * 6",
      () => {
        withAdvisoryLock(
          app.prisma,
          ADVISORY_LOCK_KEYS.SCHOOL_HOLIDAYS_SYNC,
          () => runAllTenants(),
          app.log,
        ).catch((err) => app.log.error({ err }, "school-holidays cron failed"));
      },
      { timezone: "Europe/Berlin", noOverlap: true },
    );
    tasks.push(task);
    app.log.info("school-holidays sync: weekly Sa 03:00 scheduled");

    app.addHook("onClose", () => {
      tasks.forEach((t) => void t.stop());
    });
  },
  { name: "school-holidays-sync" },
);
