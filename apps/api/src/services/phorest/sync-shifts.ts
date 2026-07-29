// Phase 85 (SS-01/SS-03/SS-05/SS-07) — The ONE shared Phorest→clokr shift sync.
//
// Both the cron (plugins/scheduler.ts) and the manual endpoint
// (routes/integrations.ts POST /phorest/sync-shifts) call this single function, killing
// the previous body duplication (SS-07 no-drift). Callers wrap it in withAdvisoryLock so
// cron and a manual click can't reconcile concurrently.
//
// This plan (01) is the production tracer: create-or-update (upsert) by externalId with
// origin=PHOREST, explicit mapping only (never name/email — that is UI-only suggest, SS-01),
// and one PhorestSyncRun history row per invocation. Windowed diff-based soft-cancel
// reconciliation is Plan 02's expansion — deliberately NOT implemented here (result.cancelled
// stays 0).

import type { FastifyInstance } from "fastify";
import { decryptSafe } from "../../utils/crypto";
import { todayInTz, dateStrInTz } from "../../utils/timezone";
import { phorestFetch } from "./client";
import { phorestShiftKey, type PhorestWorkTimeItem, type SyncOpts, type SyncResult } from "./types";

const DEFAULT_BASE_URL = "https://api.phorest.com/third-party-api-server";

export async function syncPhorestShifts(
  app: FastifyInstance,
  tenantId: string,
  opts: SyncOpts = {},
): Promise<SyncResult> {
  // One run row per invocation (SS-05) — created RUNNING, finalized SUCCESS/ERROR below.
  const run = await app.prisma.phorestSyncRun.create({
    data: { tenantId, status: "RUNNING" },
  });

  const result: SyncResult = {
    runId: run.id,
    status: "SUCCESS",
    created: 0,
    updated: 0,
    cancelled: 0,
    unmapped: 0,
    unmappedStaff: [],
  };

  try {
    const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
    const password = decryptSafe(cfg?.phorestPassword);
    if (!cfg?.phorestBusinessId || !cfg?.phorestUsername || !password) {
      throw new Error("Phorest nicht konfiguriert");
    }

    const baseUrl = cfg.phorestBaseUrl ?? DEFAULT_BASE_URL;
    const biz = cfg.phorestBusinessId;
    const branch = cfg.phorestBranchId;
    const tz = cfg.timezone ?? "Europe/Berlin";

    // Window: today .. today + phorestSyncWindowDays (tenant TZ), overridable per opts (SS-06).
    const windowDays = cfg.phorestSyncWindowDays ?? 7;
    const startBase = todayInTz(tz);
    const endBase = new Date(startBase);
    endBase.setUTCDate(endBase.getUTCDate() + windowDays);
    const startDate = opts.startDate ?? dateStrInTz(startBase, tz);
    const endDate = opts.endDate ?? dateStrInTz(endBase, tz);

    app.log.info({ tenantId, startDate, endDate, runId: run.id }, "Phorest sync started");

    // 1. Staff (for unmapped-warning names). A non-ok fetch throws → caught → run ERROR,
    //    no shift writes (guardrail).
    const staffData = await phorestFetch(
      baseUrl,
      `/api/business/${biz}/branch/${branch}/staff`,
      cfg.phorestUsername,
      password,
      { size: "200", page: "0" },
    );
    const phorestStaff = staffData._embedded?.staff ?? staffData.staff ?? [];
    const staffById = new Map(phorestStaff.map((s) => [s.staffId, s]));

    // 2. Explicit mapping ONLY (SS-01) — never name/email match in the sync path.
    const mappingRows = await app.prisma.phorestStaffMapping.findMany({ where: { tenantId } });
    const mapping = new Map(mappingRows.map((r) => [r.phorestStaffId, r.employeeId]));

    // 3. Worktimetables for the window.
    const wttData = await phorestFetch(
      baseUrl,
      `/api/business/${biz}/branch/${branch}/staffworktimetables`,
      cfg.phorestUsername,
      password,
      { start_date: startDate, end_date: endDate },
    );
    const entries =
      wttData._embedded?.staffWorkTimeTables ??
      wttData.staffWorkTimeTables ??
      (Array.isArray(wttData) ? (wttData as PhorestWorkTimeItem[]) : []);
    const workTimes: PhorestWorkTimeItem[] = Array.isArray(entries) ? entries : [];

    // 4. Upsert each mapped entry by externalId, origin=PHOREST (SS-03/SS-07).
    const seenUnmapped = new Set<string>();
    for (const wt of workTimes) {
      const employeeId = mapping.get(wt.staffId);
      if (!employeeId) {
        // Unmapped staff → warn, never silently skip and never name-match (SS-01).
        result.unmapped++;
        if (!seenUnmapped.has(wt.staffId)) {
          seenUnmapped.add(wt.staffId);
          const s = staffById.get(wt.staffId);
          result.unmappedStaff.push({
            phorestStaffId: wt.staffId,
            name: s ? `${s.firstName} ${s.lastName}` : undefined,
          });
        }
        continue;
      }

      const date = wt.date ?? (wt.startTime ? wt.startTime.split("T")[0] : null);
      if (!date) continue;

      const startH = wt.startTime ? new Date(wt.startTime).toISOString().slice(11, 16) : null;
      const endH = wt.endTime ? new Date(wt.endTime).toISOString().slice(11, 16) : null;
      if (!startH || !endH) continue;

      const externalId = phorestShiftKey(wt);

      // Pre-check to count created vs updated and to build the audit old/new value.
      const existing = await app.prisma.shift.findUnique({ where: { externalId } });

      const shift = await app.prisma.shift.upsert({
        where: { externalId },
        create: {
          employeeId,
          date: new Date(date),
          startTime: startH,
          endTime: endH,
          label: "Phorest",
          origin: "PHOREST",
          externalId,
          createdBy: opts.actorUserId,
        },
        update: {
          employeeId,
          date: new Date(date),
          startTime: startH,
          endTime: endH,
          // A re-appearing entry revives a previously soft-cancelled shift (idempotent, self-healing).
          deletedAt: null,
          deletedReason: null,
        },
      });

      if (existing) result.updated++;
      else result.created++;

      // Revisionssicherheit — audit every create/update. Cron actor is undefined (SYSTEM).
      await app.audit({
        userId: opts.actorUserId,
        action: existing ? "UPDATE" : "CREATE",
        entity: "Shift",
        entityId: shift.id,
        oldValue: existing
          ? { startTime: existing.startTime, endTime: existing.endTime, date: existing.date }
          : undefined,
        newValue: {
          source: "Phorest",
          origin: "PHOREST",
          externalId,
          date,
          startTime: startH,
          endTime: endH,
        },
      });
    }

    // NOTE: windowed diff-based soft-cancel reconciliation is Plan 02 — not implemented here.

    await app.prisma.phorestSyncRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        created: result.created,
        updated: result.updated,
        cancelled: result.cancelled,
        unmapped: result.unmapped,
      },
    });

    app.log.info(
      {
        tenantId,
        runId: run.id,
        created: result.created,
        updated: result.updated,
        unmapped: result.unmapped,
      },
      "Phorest sync finished",
    );
    return result;
  } catch (err) {
    result.status = "ERROR";
    result.error = err instanceof Error ? err.message : String(err);
    app.log.error({ err, tenantId, runId: run.id }, "Phorest sync failed");
    await app.prisma.phorestSyncRun
      .update({
        where: { id: run.id },
        data: {
          status: "ERROR",
          finishedAt: new Date(),
          error: result.error,
          created: result.created,
          updated: result.updated,
          cancelled: result.cancelled,
          unmapped: result.unmapped,
        },
      })
      .catch(() => {
        /* best-effort finalize */
      });
    return result;
  }
}
