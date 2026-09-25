// Phase 65b (issue #65, D-07) — the ONE Phorest orchestrator both triggers call.
//
// The cron (contexts/scheduling/plugins/scheduler.ts) and the manual endpoint
// (contexts/scheduling/api/integrations.ts POST /phorest/sync-shifts) both call
// syncPhorestForTenant(), so neither can drift from the other (SS-07 no-drift). The CALLER holds
// withAdvisoryLock(tenantAdvisoryKey(tenantId)) around the WHOLE call — one lock per tenant, not
// per salon — so a cron tick and a manual click can never reconcile the same tenant concurrently.
//
// A tenant has 0..n salons coupled to a Phorest branch (SalonCoupling, one per salon). For every
// coupled ACTIVE salon, in listSalons order (createdAt, id), this runs the shift sync and then the
// appointment sync for that salon's branch, sequentially — one PhorestSyncRun row per salon. One
// salon's ERROR/SUSPECT never aborts the next salon. Salons come ONLY through the Unterbau facade
// (contexts/platform/index.ts), never through prisma.salon from this context.

import type { FastifyInstance } from "fastify";
import { listSalons } from "../../contexts/platform";
import { syncPhorestShifts } from "./sync-shifts";
import { syncPhorestAppointments } from "./sync-appointments";
import type { AppointmentSyncResult, PhorestSyncTarget, SyncOpts, SyncResult } from "./types";

/** One coupled salon's outcome: its shift run, plus the appointment sync on the same run row. */
export type SalonSyncResult = SyncResult & {
  salonId: string;
  salonName: string;
  appointments: AppointmentSyncResult;
};

/**
 * Runs the Phorest sync once per coupled ACTIVE salon of the tenant. Returns `[]` — without a run
 * row and without a single fetch — when no active salon is coupled.
 */
export async function syncPhorestForTenant(
  app: FastifyInstance,
  tenantId: string,
  opts: SyncOpts = {},
): Promise<SalonSyncResult[]> {
  const salons = await listSalons(app.prisma, tenantId, { includeInactive: false });
  const couplings = await app.prisma.salonCoupling.findMany({
    where: { tenantId, provider: "PHOREST" },
  });
  const branchBySalon = new Map(couplings.map((c) => [c.salonId, c.externalBranchId]));

  // listSalons order is the run order; an uncoupled salon is simply not in the list.
  const targets: { salonName: string; target: PhorestSyncTarget }[] = [];
  for (const s of salons) {
    const externalBranchId = branchBySalon.get(s.id);
    if (externalBranchId === undefined) continue;
    targets.push({ salonName: s.name, target: { salonId: s.id, externalBranchId } });
  }

  if (targets.length === 0) {
    app.log.info({ tenantId }, "Phorest sync: no coupled active salon — nothing to sync");
    return [];
  }

  const results: SalonSyncResult[] = [];
  for (const { salonName, target } of targets) {
    try {
      const shifts = await syncPhorestShifts(app, tenantId, target, opts);
      const appointments = await syncPhorestAppointments(app, tenantId, target, {
        runId: shifts.runId,
        actorUserId: opts.actorUserId,
      });
      results.push({ ...shifts, salonId: target.salonId, salonName, appointments });
    } catch (err) {
      // Both services record their own failures on the run and return; this only catches a throw
      // that escaped them (e.g. the run row itself could not be created). One salon never aborts
      // the next.
      const message = err instanceof Error ? err.message : String(err);
      app.log.error(
        { err, tenantId, salonId: target.salonId },
        "Phorest sync: salon run failed unexpectedly — continuing with the next salon",
      );
      results.push({
        runId: "",
        status: "ERROR",
        created: 0,
        updated: 0,
        cancelled: 0,
        unmapped: 0,
        unmappedStaff: [],
        skippedVocationalSchool: 0,
        replaced: 0,
        protectedPendingLeave: 0,
        leaveRecalcFailures: 0,
        skippedOtherSalon: 0,
        error: message,
        salonId: target.salonId,
        salonName,
        appointments: {
          status: "ERROR",
          appointmentsStored: 0,
          appointmentsRemoved: 0,
          error: message,
        },
      });
    }
  }
  return results;
}

/**
 * The manual trigger's response (D-13): the backward-compatible top-level aggregate the admin page
 * reads, plus the per-salon results.
 */
export type PhorestSyncResponse = Omit<SyncResult, "runId"> & {
  results: SalonSyncResult[];
};

const STATUS_RANK: Record<SyncResult["status"], number> = { SUCCESS: 0, SUSPECT: 1, ERROR: 2 };

/**
 * Pure aggregate over the per-salon results (D-13): worst status (ERROR > SUSPECT > SUCCESS),
 * summed counters, `unmappedStaff` deduplicated by phorestStaffId (first occurrence wins).
 * `error`: with exactly ONE result that result's error unchanged (single-salon parity — the admin
 * page shows it verbatim); with several, every erroring result as "<salonName>: <error>" joined by
 * "; "; omitted when no result has an error.
 */
export function aggregateSalonSyncResults(results: SalonSyncResult[]): PhorestSyncResponse {
  let status: SyncResult["status"] = "SUCCESS";
  const unmappedStaff: SyncResult["unmappedStaff"] = [];
  const seenStaff = new Set<string>();
  const response: PhorestSyncResponse = {
    status,
    created: 0,
    updated: 0,
    cancelled: 0,
    unmapped: 0,
    unmappedStaff,
    skippedVocationalSchool: 0,
    replaced: 0,
    protectedPendingLeave: 0,
    leaveRecalcFailures: 0,
    skippedOtherSalon: 0,
    results,
  };

  for (const r of results) {
    if (STATUS_RANK[r.status] > STATUS_RANK[status]) status = r.status;
    response.created += r.created;
    response.updated += r.updated;
    response.cancelled += r.cancelled;
    response.unmapped += r.unmapped;
    response.skippedVocationalSchool += r.skippedVocationalSchool;
    response.replaced += r.replaced;
    response.protectedPendingLeave += r.protectedPendingLeave;
    response.leaveRecalcFailures += r.leaveRecalcFailures;
    response.skippedOtherSalon += r.skippedOtherSalon;
    for (const s of r.unmappedStaff) {
      if (seenStaff.has(s.phorestStaffId)) continue;
      seenStaff.add(s.phorestStaffId);
      unmappedStaff.push(s);
    }
  }
  response.status = status;

  if (results.length === 1) {
    if (results[0].error !== undefined) response.error = results[0].error;
  } else {
    const errors = results.filter((r) => r.error).map((r) => `${r.salonName}: ${r.error}`);
    if (errors.length > 0) response.error = errors.join("; ");
  }
  return response;
}
