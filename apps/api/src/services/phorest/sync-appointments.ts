// Phase 86 (SA-01/SA-02/SA-03) — DSGVO-minimal Phorest appointment cache sync.
//
// Sibling to sync-shifts.ts (whose internals are NOT modified here). Both the cron
// (plugins/scheduler.ts) and the manual endpoint (routes/integrations.ts POST /phorest/sync-shifts)
// call this AFTER syncPhorestShifts, INSIDE the same per-tenant withAdvisoryLock body, passing the
// shift run's { runId } so appointment counters land on the SAME PhorestSyncRun row (SA-03). Shift
// sync owns the run `status`; an appointment-fetch failure records onto `appointmentError`, never
// touching `status`.
//
// DSGVO (load-bearing, SA-02): the ONLY write path is the closed mapAppointment() object literal,
// which reads ONLY staffId + start/end and emits ONLY { employeeId, date, startTime, endTime,
// externalId }. The raw Phorest payload (which carries customer/service/price) is NEVER spread into
// the return or into prisma.create — every non-staff/non-time field is unreachable by construction.
// Combined with PhorestAppointment having no PII columns, minimization is structural.
//
// NOTE (functionality gap, not architectural): this plan's tracer does a straight insert of the
// fresh window. The guarded transactional hard-replace + fail-closed multi-gate discipline (mirror
// of the Phase-85 shift guardrail) is Plan 02.

import type { FastifyInstance } from "fastify";
import { decryptSafe } from "../../utils/crypto";
import { todayInTz, dateStrInTz } from "../../utils/timezone";
import { phorestFetch } from "./client";
import {
  extractAppointments,
  phorestAppointmentKey,
  PHOREST_PAGE_SIZE,
  type PhorestAppointmentItem,
  type AppointmentSyncOpts,
  type AppointmentSyncResult,
} from "./types";

const DEFAULT_BASE_URL = "https://api.phorest.com/third-party-api-server";
const DEFAULT_HORIZON_DAYS = 90;

/**
 * The DSGVO minimization boundary (SA-02). A CLOSED pure function: it reads ONLY staff + start/end
 * from the (PII-carrying) upstream item and returns a CLOSED object literal with ONLY the five
 * allowed fields. Returns null when date/start/end cannot be derived (the item is then skipped).
 * NEVER spread `a` into the return — that is what makes customer/service/price unreachable.
 */
export function mapAppointment(
  a: PhorestAppointmentItem,
  employeeId: string,
  tz: string,
): {
  employeeId: string;
  date: Date;
  startTime: string;
  endTime: string;
  externalId: string;
} | null {
  void tz; // reserved for future tz-aware derivation; UTC-slice mirrors sync-shifts.ts for now
  const date = a.startTime ? a.startTime.split("T")[0] : null;
  const startTime = a.startTime ? new Date(a.startTime).toISOString().slice(11, 16) : null;
  const endTime = a.endTime ? new Date(a.endTime).toISOString().slice(11, 16) : null;
  if (!date || !startTime || !endTime) return null;
  return {
    employeeId,
    date: new Date(date),
    startTime,
    endTime,
    externalId: phorestAppointmentKey(a),
  };
}

export async function syncPhorestAppointments(
  app: FastifyInstance,
  tenantId: string,
  opts: AppointmentSyncOpts = {},
): Promise<AppointmentSyncResult> {
  const result: AppointmentSyncResult = {
    status: "SUCCESS",
    appointmentsStored: 0,
    appointmentsRemoved: 0,
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
    const horizon = opts.horizonDays ?? cfg.phorestAppointmentHorizonDays ?? DEFAULT_HORIZON_DAYS;

    // Explicit mapping ONLY (SS-01 discipline carries over) — never name/email match, never store
    // an unmapped staff's (branch-wide customer) appointment (T-86-02).
    const mappingRows = await app.prisma.phorestStaffMapping.findMany({ where: { tenantId } });
    const mapping = new Map(mappingRows.map((r) => [r.phorestStaffId, r.employeeId]));

    app.log.info({ tenantId, horizon, runId: opts.runId }, "Phorest appointment sync started");

    // Forward window today .. today+horizon (tenant TZ). Per-date fetch (Phorest appointment
    // endpoint is date-scoped via appointmentDate).
    const fresh: ReturnType<typeof mapAppointment>[] = [];
    const startBase = todayInTz(tz);
    for (let d = 0; d <= horizon; d++) {
      const day = new Date(startBase);
      day.setUTCDate(day.getUTCDate() + d);
      const dateStr = dateStrInTz(day, tz);

      const data = await phorestFetch(
        baseUrl,
        `/api/business/${biz}/branch/${branch}/appointment`,
        cfg.phorestUsername,
        password,
        { appointmentDate: dateStr, size: String(PHOREST_PAGE_SIZE), page: "0" },
      );

      for (const a of extractAppointments(data)) {
        const employeeId = mapping.get(a.staffId);
        if (!employeeId) continue; // unmapped ⇒ never stored (DSGVO + SA-01)
        const row = mapAppointment(a, employeeId, tz);
        if (row) fresh.push(row);
      }
    }

    // Tracer: straight insert of the fresh window (Plan 02 adds guarded hard-replace).
    for (const row of fresh) {
      if (!row) continue;
      await app.prisma.phorestAppointment.create({ data: row });
      result.appointmentsStored++;
    }

    // SA-03: record appointment counters onto the SHARED shift run row (best-effort — a counter
    // write failure must not fail the sync). status stays shift-owned; we only set counters here.
    if (opts.runId) {
      await app.prisma.phorestSyncRun
        .update({
          where: { id: opts.runId },
          data: {
            appointmentsStored: result.appointmentsStored,
            appointmentsRemoved: result.appointmentsRemoved,
          },
        })
        .catch(() => {
          /* best-effort counter write */
        });
    }

    app.log.info(
      { tenantId, runId: opts.runId, appointmentsStored: result.appointmentsStored },
      "Phorest appointment sync finished",
    );
    return result;
  } catch (err) {
    result.status = "ERROR";
    result.error = err instanceof Error ? err.message : String(err);
    app.log.error({ err, tenantId, runId: opts.runId }, "Phorest appointment sync failed");
    // Record the appointment error onto the shared run WITHOUT touching the shift-owned status.
    if (opts.runId) {
      await app.prisma.phorestSyncRun
        .update({ where: { id: opts.runId }, data: { appointmentError: result.error } })
        .catch(() => {
          /* best-effort error write */
        });
    }
    return result;
  }
}
