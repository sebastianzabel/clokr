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
// Plan 02 (this file) hardens the tracer's straight-insert into the full reconciliation core:
//   - A guarded transactional HARD-REPLACE per mapped window: one app.prisma.$transaction(
//     [ deleteMany(window scoped to mapped employees + employee.tenantId), createMany(fresh) ])
//     reached ONLY after the whole window fetched successfully (Pitfall 4: no crash-window where
//     the cache is left empty). Hard delete — this is a TRANSIENT cache, NOT audit data: run-level
//     counters only, no soft-delete, no per-row audit (Pitfall 7).
//   - A fail-closed 2-gate discipline (mirror of the Phase-85 shift guardrail, but SIMPLER — 2
//     gates, NO plausibility floor):
//       GATE-1 fetch-ok            — any PhorestApiError/throw ⇒ status ERROR, ZERO DB writes,
//                                    appointmentError recorded, the DB phase is never reached.
//       GATE-2 pagination-exhausted — every page of a date is read+merged before the window is
//                                    "complete"; MAX_APPT_PAGES cap ⇒ abort as failure (truncated
//                                    read must never drive a hard-replace).
//   - DELIBERATELY NO plausibility floor (Pitfall 3): an empty SUCCESSFUL fetch legitimately clears
//     a booking-free window — the appointment cache is cache-only + warn-only downstream.
//   - Horizon bound (SA-03): the per-date loop upper bound is today+horizon, so no out-of-window
//     date is ever fetched or stored.

import type { FastifyInstance } from "fastify";
import { decryptSafe } from "../../utils/crypto";
import { todayInTz, dateStrInTz } from "../../utils/timezone";
import { phorestFetch } from "./client";
import {
  extractAppointments,
  phorestAppointmentKey,
  phorestHasMorePages,
  PHOREST_PAGE_SIZE,
  type PhorestAppointmentItem,
  type AppointmentSyncOpts,
  type AppointmentSyncResult,
} from "./types";

const DEFAULT_BASE_URL = "https://api.phorest.com/third-party-api-server";
const DEFAULT_HORIZON_DAYS = 90;
// Safety cap on the per-date pagination loop so a misbehaving has-more envelope can't spin forever.
// Hitting it means the window read is truncated/untrustworthy ⇒ abort fail-closed (GATE-2).
const MAX_APPT_PAGES = 100;

/** The non-null row shape emitted by mapAppointment — the exact createMany payload (SA-02 closed set). */
type AppointmentRow = NonNullable<ReturnType<typeof mapAppointment>>;

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

    // ── GATE-1 (fetch-ok) ────────────────────────────────────────────
    // Every phorestFetch below throws PhorestApiError on any non-ok/timeout/network failure. Any
    // throw lands in the catch → status ERROR, appointmentError recorded, ZERO DB writes — the
    // hard-replace transaction below is never reached (fail-closed, T-86-06).
    //
    // Forward window today .. today+horizon (tenant TZ). Per-date fetch (Phorest appointment
    // endpoint is date-scoped via appointmentDate). SA-03: the loop upper bound is the ONLY
    // horizon enforcement — no out-of-window date is ever requested or stored.
    const fresh: AppointmentRow[] = [];
    const startBase = todayInTz(tz);
    for (let d = 0; d <= horizon; d++) {
      const day = new Date(startBase);
      day.setUTCDate(day.getUTCDate() + d);
      const dateStr = dateStrInTz(day, tz);

      // ── GATE-2 (pagination-exhausted) ────────────────────────────
      // Read EVERY page of this date before moving on — a page-1-only read is an INCOMPLETE
      // window and must never drive the hard-replace. A failure on ANY page throws → GATE-1.
      let page = 0;
      for (;;) {
        const data = await phorestFetch(
          baseUrl,
          `/api/business/${biz}/branch/${branch}/appointment`,
          cfg.phorestUsername,
          password,
          { appointmentDate: dateStr, size: String(PHOREST_PAGE_SIZE), page: String(page) },
        );

        const items = extractAppointments(data);
        for (const a of items) {
          const employeeId = mapping.get(a.staffId);
          if (!employeeId) continue; // unmapped ⇒ never stored (DSGVO + SA-01, T-86-09)
          const row = mapAppointment(a, employeeId, tz);
          if (row) fresh.push(row);
        }

        if (!phorestHasMorePages(data, page, items.length, PHOREST_PAGE_SIZE)) break;
        page++;
        if (page >= MAX_APPT_PAGES) {
          // GATE-2 invariant: hitting the cap means the window read is truncated/untrustworthy.
          // Throw so the catch records appointmentError and ZERO DB writes happen — a partial read
          // must NEVER replace the cached window (mirror sync-shifts.ts MAX_WTT_PAGES, T-86-06).
          throw new Error(
            `Phorest appointment pagination hit MAX_APPT_PAGES cap for ${dateStr} — truncated read, aborting`,
          );
        }
      }
    }

    // ── Guarded transactional HARD-REPLACE (GATE-1 + GATE-2 passed) ──
    // Reached ONLY after the ENTIRE window fetched successfully with pagination exhausted per date.
    // Scope the delete to the CURRENT mapping's employees (NOT to `fresh`) so a staff whose
    // appointments dropped to zero this run still gets its window cleared — the empty-window nuance
    // (Pitfall 3: a successful empty fetch SHOULD clear the window; no plausibility floor here).
    const mappedEmployeeIds = [...new Set(mapping.values())];
    const windowStart = new Date(dateStrInTz(startBase, tz));
    const windowEndDay = new Date(startBase);
    windowEndDay.setUTCDate(windowEndDay.getUTCDate() + horizon);
    const windowEnd = new Date(dateStrInTz(windowEndDay, tz));

    // De-duplicate `fresh` by the globally-unique externalId BEFORE the transaction (WR-01). Two
    // fetched items can legitimately collide on externalId: a genuinely double-booked slot (same
    // staff+window ⇒ same composite fallback key) or a page-boundary repeat of the same appointmentId.
    // Since externalId is @unique, an unfiltered createMany would throw a unique-constraint violation
    // that rolls back the WHOLE $transaction (incl. the deleteMany) → the run flips to ERROR and the
    // window's cache is left stale, recurring every sync until the duplicate clears. Hard-replace
    // makes externalId "a nice-to-have, not the reconcile key", so a collision must NOT abort the
    // replace. Dedupe-then-insert (keep first occurrence) keeps appointmentsStored honest — it counts
    // the rows actually written, not the raw fetched items (skipDuplicates alone would over-count).
    const dedupedFresh = [...new Map(fresh.map((r) => [r.externalId, r])).values()];

    // Hard delete + insert as ONE $transaction (Pitfall 4: no crash-window where the cache is left
    // empty). TRANSIENT cache, NOT audit data → hard delete, run-level counters only, no per-row
    // audit, no soft-delete (Pitfall 7). Delete scoped to window + mapped employees + tenant.
    // createMany also carries skipDuplicates as a belt-and-braces guard against any pre-existing
    // out-of-window row that shares an externalId (the delete is window-scoped, dedupe is not).
    const [removed] = await app.prisma.$transaction([
      app.prisma.phorestAppointment.deleteMany({
        where: {
          date: { gte: windowStart, lte: windowEnd },
          employee: { tenantId },
          employeeId: { in: mappedEmployeeIds.length ? mappedEmployeeIds : ["__none__"] },
        },
      }),
      app.prisma.phorestAppointment.createMany({ data: dedupedFresh, skipDuplicates: true }),
    ]);
    result.appointmentsRemoved = removed.count;
    result.appointmentsStored = dedupedFresh.length;

    // SA-03: record appointment counters onto the SHARED shift run row (best-effort — a counter
    // write failure must not fail the sync). status stays shift-owned; we only set counters +
    // clear any stale appointmentError here (this run's fetch succeeded).
    if (opts.runId) {
      await app.prisma.phorestSyncRun
        .update({
          where: { id: opts.runId },
          data: {
            appointmentsStored: result.appointmentsStored,
            appointmentsRemoved: result.appointmentsRemoved,
            appointmentError: null,
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
