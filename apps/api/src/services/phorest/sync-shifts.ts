// Phase 85 (SS-03/SS-04/SS-06/SS-07) — The ONE shared Phorest→clokr shift sync.
//
// Both the cron (plugins/scheduler.ts) and the manual endpoint
// (routes/integrations.ts POST /phorest/sync-shifts) call this single function, killing
// the previous body duplication (SS-07 no-drift). Callers wrap it in withAdvisoryLock so
// cron and a manual click can't reconcile concurrently.
//
// Plan 01 delivered the production tracer: create-or-update (upsert) by externalId with
// origin=PHOREST, explicit mapping only, one PhorestSyncRun history row per invocation.
//
// Plan 02 (this file) expands it into the full reconciliation core:
//   - Windowed diff-based SOFT-CANCEL (SS-04): a PHOREST shift that vanished from the fresh
//     Phorest window is soft-deleted (deletedAt + deletedReason "PHOREST_REMOVED" + AuditLog),
//     which drops it from the §615 roster automatically (all roster reads filter deletedAt: null).
//   - A HARDENED three-gate deletion guardrail (T-85-05) so NO "successful" fetch can
//     false-mass-cancel:
//       GATE 1 fetch-ok           — any non-ok/throw ⇒ status ERROR, zero cancel, return.
//       GATE 2 pagination-complete — all pages read & merged before the fresh set is "complete".
//       GATE 3 plausibility floor  — empty in-window set + ≥1 prior active PHOREST shift
//                                    ⇒ status SUSPECT, zero cancel, audit note, return.
//   - Adopt-on-match dedup (SS-07): a legacy label="Phorest" MANUAL row (externalId null) that
//     the fresh window still contains is UPDATED in place (externalId + origin=PHOREST), never
//     duplicated.
//   - Configurable window (SS-06): windowEnd = windowStart + TenantConfig.phorestSyncWindowDays.

import type { FastifyInstance } from "fastify";
import { decryptSafe } from "../../utils/crypto";
import { todayInTz, dateStrInTz } from "../../utils/timezone";
import { phorestFetch } from "./client";
import {
  phorestShiftKey,
  extractWorkTimes,
  phorestHasMorePages,
  PHOREST_PAGE_SIZE,
  type PhorestWorkTimeItem,
  type SyncOpts,
  type SyncResult,
} from "./types";

const DEFAULT_BASE_URL = "https://api.phorest.com/third-party-api-server";
// Safety cap on the pagination loop so a misbehaving next-link can't spin forever.
const MAX_WTT_PAGES = 100;

export async function syncPhorestShifts(
  app: FastifyInstance,
  tenantId: string,
  opts: SyncOpts = {},
): Promise<SyncResult> {
  // One run row per invocation (SS-05) — created RUNNING, finalized SUCCESS/SUSPECT/ERROR below.
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
    // Date bounds for the reconcile / plausibility queries (Shift.date is @db.Date — UTC midnight).
    const windowStartDate = new Date(startDate);
    const windowEndDate = new Date(endDate);

    app.log.info({ tenantId, startDate, endDate, runId: run.id }, "Phorest sync started");

    // ── GATE 1 (fetch-ok) ────────────────────────────────────────────
    // Every Phorest fetch below throws PhorestApiError on any non-ok/throw. Any throw lands in
    // the catch → run status ERROR, zero cancel, return — the reconcile pass is never reached
    // (locked deletion guardrail, Pitfall 2/7).

    // 1. Staff (for unmapped-warning names).
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

    // ── GATE 2 (pagination-complete) ─────────────────────────────────
    // 3. Worktimetables for the window — exhaust ALL pages before the fresh set is treated as
    //    complete. A failure on ANY page throws → GATE 1 error. A truncated read must NEVER
    //    drive a soft-cancel (a page-1-only read cannot cancel a page-2 shift).
    const workTimes: PhorestWorkTimeItem[] = [];
    let page = 0;
    for (;;) {
      const wttData = await phorestFetch(
        baseUrl,
        `/api/business/${biz}/branch/${branch}/staffworktimetables`,
        cfg.phorestUsername,
        password,
        {
          start_date: startDate,
          end_date: endDate,
          size: String(PHOREST_PAGE_SIZE),
          page: String(page),
        },
      );
      const pageEntries = extractWorkTimes(wttData);
      workTimes.push(...pageEntries);
      if (!phorestHasMorePages(wttData, page, pageEntries.length, PHOREST_PAGE_SIZE)) break;
      page++;
      if (page >= MAX_WTT_PAGES) {
        // GATE 2 invariant: a truncated read must NEVER drive a soft-cancel. Hitting the cap
        // means the fresh set is incomplete, so treat the read as untrustworthy — flag SUSPECT,
        // cancel ZERO, and return before the reconcile pass (mirror the plausibility-floor exit).
        app.log.error(
          { tenantId, runId: run.id, pages: page },
          "Phorest worktimetables pagination hit MAX_WTT_PAGES cap — aborting reconcile (truncated read)",
        );
        result.status = "SUSPECT";
        await app.audit({
          userId: opts.actorUserId,
          action: "UPDATE",
          entity: "PhorestSyncRun",
          entityId: run.id,
          newValue: {
            status: "SUSPECT",
            reason: "pagination cap hit — truncated worktimetables read",
            pages: page,
            window: { startDate, endDate },
            cancelled: 0,
          },
        });
        await finalizeRun(app, run.id, result);
        return result;
      }
    }

    // 4. Upsert / adopt each mapped entry, building the fresh in-window externalId set (SS-03/SS-07).
    const freshExternalIds = new Set<string>();
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
      freshExternalIds.add(externalId);

      // ── Adopt-on-match (SS-07 dedup) ─────────────────────────────
      // Before creating, look for a LEGACY Phorest-imported row already occupying this exact
      // slot (employeeId + date + startTime + endTime). Such a row is left by the old untested
      // sync (label="Phorest" origin=MANUAL, externalId null) and would NOT be found by the
      // externalId upsert → it would be duplicated (SS-07 violation, Open Question 4). If found
      // with a different/absent externalId, adopt it in place instead of inserting a second row.
      //
      // CRITICAL: the query is restricted to label="Phorest" so a GENUINE, hand-entered MANUAL
      // shift that happens to share the same slot is NEVER reclassified to origin=PHOREST — that
      // would make it eligible for auto soft-cancel, violating the locked invariant "MANUAL shifts
      // are NEVER touched by the sync" (85-CONTEXT <decisions>). A same-slot genuine-MANUAL
      // collision is left untouched here; parallel-shift collision handling is Phase 87.
      const occupant = await app.prisma.shift.findFirst({
        where: {
          employeeId,
          date: new Date(date),
          startTime: startH,
          endTime: endH,
          deletedAt: null,
          label: "Phorest",
        },
      });

      if (occupant && occupant.externalId !== externalId) {
        const adopted = await app.prisma.shift.update({
          where: { id: occupant.id },
          data: {
            origin: "PHOREST",
            externalId,
            label: occupant.label ?? "Phorest",
          },
        });
        result.updated++;
        await app.audit({
          userId: opts.actorUserId,
          action: "UPDATE",
          entity: "Shift",
          entityId: adopted.id,
          oldValue: { origin: occupant.origin, externalId: occupant.externalId },
          newValue: { source: "Phorest", origin: "PHOREST", externalId, adopted: true },
        });
        continue;
      }

      // No conflicting occupant → canonical upsert by externalId (create or update).
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

    // ── GATE 3 (plausibility floor) ──────────────────────────────────
    // An HTTP-200 fetch that yields an EMPTY in-window set while the DB still holds active
    // PHOREST shifts in the same window is almost certainly a wrong-branchId / dropped-connection
    // read — NOT a genuine "everything was deleted". Flag it SUSPECT, cancel ZERO, and return
    // before the delete pass. (An empty set with no prior active shifts is the legit "nothing
    // scheduled" case → stays SUCCESS, no cancel candidates.)
    if (freshExternalIds.size === 0) {
      const priorActive = await app.prisma.shift.count({
        where: {
          origin: "PHOREST",
          deletedAt: null,
          date: { gte: windowStartDate, lte: windowEndDate },
          employee: { tenantId },
        },
      });
      if (priorActive > 0) {
        result.status = "SUSPECT";
        app.log.warn(
          { tenantId, runId: run.id, priorActive, startDate, endDate },
          "Phorest sync SUSPECT: empty in-window fetch with prior active PHOREST shifts — zero cancel",
        );
        await app.audit({
          userId: opts.actorUserId,
          action: "UPDATE",
          entity: "PhorestSyncRun",
          entityId: run.id,
          newValue: {
            status: "SUSPECT",
            reason: "empty-window fetch with prior active PHOREST shifts",
            priorActive,
            window: { startDate, endDate },
            cancelled: 0,
          },
        });
        await finalizeRun(app, run.id, result);
        return result;
      }
    }

    // ── Soft-cancel reconciliation (SS-04) — all three gates passed ──
    // Candidates: active, in-window, origin=PHOREST shifts of this tenant whose externalId is
    // absent from the fresh set. MANUAL shifts and out-of-window shifts are structurally excluded.
    const staleCandidates = await app.prisma.shift.findMany({
      where: {
        origin: "PHOREST",
        deletedAt: null,
        date: { gte: windowStartDate, lte: windowEndDate },
        externalId: { notIn: [...freshExternalIds] },
        employee: { tenantId },
      },
    });

    for (const stale of staleCandidates) {
      await app.prisma.shift.update({
        where: { id: stale.id },
        data: { deletedAt: new Date(), deletedReason: "PHOREST_REMOVED" },
      });
      result.cancelled++;
      // Audit-proof: soft-delete only (never hard delete), one DELETE audit row per cancel.
      await app.audit({
        userId: opts.actorUserId,
        action: "DELETE",
        entity: "Shift",
        entityId: stale.id,
        oldValue: {
          origin: stale.origin,
          externalId: stale.externalId,
          date: stale.date,
          startTime: stale.startTime,
          endTime: stale.endTime,
          deletedAt: null,
        },
        newValue: { deletedReason: "PHOREST_REMOVED", deletedAt: new Date(), source: "Phorest" },
      });
    }

    await finalizeRun(app, run.id, result);

    app.log.info(
      {
        tenantId,
        runId: run.id,
        status: result.status,
        created: result.created,
        updated: result.updated,
        cancelled: result.cancelled,
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

/** Finalize the PhorestSyncRun row from a (SUCCESS | SUSPECT) result. */
async function finalizeRun(app: FastifyInstance, runId: string, result: SyncResult): Promise<void> {
  await app.prisma.phorestSyncRun.update({
    where: { id: runId },
    data: {
      status: result.status,
      finishedAt: new Date(),
      created: result.created,
      updated: result.updated,
      cancelled: result.cancelled,
      unmapped: result.unmapped,
    },
  });
}
