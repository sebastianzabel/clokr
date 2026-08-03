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
//
// Plan 85.1-02 adds three refinements surfaced during the INT live-test:
//   - Vor-/Nachbereitungszeit (D-01/D-02/D-03): tenant-global prep/wrap-up padding on the STORED
//     Shift.startTime/endTime only — externalId/phorestShiftKey() stay on RAW Phorest times so a
//     puffer config change self-heals via the idempotent upsert update-branch (no cancel churn).
//   - "BS gewinnt" (D-06/D-07): a VOCATIONAL_SCHOOL day is skipped (not created/adopted) and
//     protected from the soft-cancel pass.
//   - "Phorest ist Master" (D-11/D-11a/D-11b): on a Phorest-covered day, EVERY other active shift
//     (including genuine origin=MANUAL rows — this SUPERSEDES the prior "MANUAL is never touched"
//     invariant for mapped employees on covered days) whose externalId is not in the fresh set is
//     soft-deleted (deletedReason "PHOREST_REPLACED"). Runs strictly AFTER the three-gate
//     guardrail and the soft-cancel loop, scoped per (employeeId, date), never tenant-wide.

import type { FastifyInstance } from "fastify";
import { decryptSafe } from "../../utils/crypto";
import { todayInTz, dateStrInTz } from "../../utils/timezone";
import { applyPrepWrapup } from "../../utils/time-arithmetic";
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

const DEFAULT_BASE_URL = "https://api-gateway-eu.phorest.com/third-party-api-server";
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
    skippedVocationalSchool: 0,
    replaced: 0,
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
    // v3: staff live under _embedded.staffs; archived staff are skipped (never mapped/synced).
    const phorestStaff = (staffData._embedded?.staffs ?? staffData.staffs ?? []).filter(
      (s) => s.archived !== true,
    );
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
        `/api/business/${biz}/branch/${branch}/staff/worktimetable`,
        cfg.phorestUsername,
        password,
        {
          from_date: startDate,
          to_date: endDate,
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
    // Phase 85.1 (D-01/D-02): tenant-global Vor-/Nachbereitungszeit puffer, read once outside the
    // loop. Padding is applied ONLY to the STORED Shift.startTime/endTime below (D-02) — the
    // externalId / phorestShiftKey() and the adopt-on-match occupant lookup stay on the RAW
    // wt.startTime/endTime the whole way through (D-03, key-stability across puffer changes).
    const prepMin = cfg.phorestPrepMinutes ?? 0;
    const wrapMin = cfg.phorestWrapupMinutes ?? 0;

    // Phase 85.1 (D-06/D-07/D-09): "BS gewinnt" — bulk-load VOCATIONAL_SCHOOL absences for all
    // mapped employees in the window in ONE query (mirrors vocational-school-generator.ts's
    // bulk-fetch idiom), then look up per-slot via a Set — never a per-slot query inside the loop.
    const mappedEmployeeIds = [...new Set(mappingRows.map((r) => r.employeeId))];
    const bsAbsences = await app.prisma.absence.findMany({
      where: {
        employeeId: { in: mappedEmployeeIds },
        type: "VOCATIONAL_SCHOOL",
        deletedAt: null,
        startDate: { gte: windowStartDate, lte: windowEndDate },
      },
      select: { employeeId: true, startDate: true },
    });
    const bsSet = new Set(
      bsAbsences.map((a) => `${a.employeeId}|${a.startDate.toISOString().slice(0, 10)}`),
    );
    // Consumed below by the soft-cancel exclusion (D-07) and Task 3's replace pass (D-11b).
    const bsSkippedDays = new Set<string>();

    // Phase 85.1.1 (D-02) — bulk-load per-employee Phorest puffer overrides for all mapped
    // employees (mirrors the D-09 BS-absence bulk-load idiom directly above). One query, not N.
    const employeeOverrides = await app.prisma.employee.findMany({
      where: { id: { in: mappedEmployeeIds } },
      select: {
        id: true,
        phorestPrepMinutesOverride: true,
        phorestWrapupMinutesOverride: true,
      },
    });
    const overrideById = new Map(employeeOverrides.map((e) => [e.id, e]));

    const freshExternalIds = new Set<string>();
    const seenUnmapped = new Set<string>();
    // Phase 85.1 (D-11) — every (employeeId, date) that received an upserted/adopted WORKING slot
    // this run. Feeds the Phorest-master replace pass below (never skipped/unmapped days).
    const freshCoveredDays = new Set<string>();
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

      // v3: the slot `date` is already "yyyy-MM-dd" (no ISO datetime to split).
      const date = wt.date ?? null;
      if (!date) continue;

      // Phase 85.1 (D-06) — "BS gewinnt": a VOCATIONAL_SCHOOL day is never overwritten by a
      // Phorest shift. Skip BEFORE parsing raw slot times — the raw wt is never touched for a
      // skipped day. Ferien are auto-covered: the Ferien-aware BS generator produces no BS row
      // during school holidays, so bsSet simply has no entry for those dates.
      if (bsSet.has(`${employeeId}|${date}`)) {
        result.skippedVocationalSchool++;
        bsSkippedDays.add(`${employeeId}|${date}`);
        await app.audit({
          userId: opts.actorUserId,
          action: "UPDATE",
          entity: "Shift",
          newValue: { source: "Phorest", skipped: "VOCATIONAL_SCHOOL", employeeId, date },
        });
        continue;
      }

      // v3 slot times are Joda LocalTime "HH:mm:ss" (bare local wall-clock, NOT ISO). Slice the
      // first 5 chars to the stored "HH:mm". NEVER new Date(...) a LocalTime — that would apply a
      // TZ offset and corrupt both the Shift time and the composite externalId (T-85-06-01).
      const startH = wt.startTime ? wt.startTime.slice(0, 5) : null;
      const endH = wt.endTime ? wt.endTime.slice(0, 5) : null;
      if (!startH || !endH) continue;

      const externalId = phorestShiftKey(wt);
      freshExternalIds.add(externalId);

      // Phase 85.1.1 (D-02) — per-employee override wins over tenant default. `??` (NOT `||`) so
      // an explicit 0 override is honoured (0 || default would silently fall back — the exact
      // Merle bug: a tight-contract employee's padded roster must be able to equal her raw hours).
      const override = overrideById.get(employeeId);
      const effectivePrep = override?.phorestPrepMinutesOverride ?? prepMin;
      const effectiveWrapup = override?.phorestWrapupMinutesOverride ?? wrapMin;

      // Phase 85.1 (D-02/D-05): pad the STORED window only — NEVER feed padded values into
      // phorestShiftKey() or the adopt-on-match occupant WHERE (both stay on raw startH/endH).
      // D-05 edge (documented, not covered by code): Phorest models a break as
      // timeOffStart/EndTime WITHIN one slot and extractWorkTimes drops NON_WORKING slots, so one
      // contiguous slot/day is the norm — but two adjacent same-day slots could, in principle,
      // overlap after padding (e.g. 11:45 & 12:15). No merge logic is built in this phase.
      const { startTime: paddedStart, endTime: paddedEnd } = applyPrepWrapup(
        startH,
        endH,
        effectivePrep,
        effectiveWrapup,
      );

      // ── Adopt-on-match (SS-07 dedup) ─────────────────────────────
      // Before creating, look for a LEGACY Phorest-imported row already occupying this exact
      // slot (employeeId + date + startTime + endTime). Such a row is left by the old untested
      // sync (label="Phorest" origin=MANUAL, externalId null) and would NOT be found by the
      // externalId upsert → it would be duplicated (SS-07 violation, Open Question 4). If found
      // with a different/absent externalId, adopt it in place instead of inserting a second row.
      //
      // CRITICAL: the query is restricted to label="Phorest" so a GENUINE, hand-entered MANUAL
      // shift that happens to share the same slot is NEVER reclassified (adopted) to
      // origin=PHOREST here. Phase 85.1 (D-11) CHANGES what happens to that surviving duplicate
      // afterwards, though: on a Phorest-covered day, the replace pass below now soft-deletes it
      // (deletedReason "PHOREST_REPLACED") — the 85-CONTEXT "MANUAL shifts are NEVER touched"
      // invariant is explicitly superseded for mapped employees on Phorest-covered days (see
      // 85.1-CONTEXT D-11). It is NOT reclassified/adopted here, just soft-deleted later.
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
            // Phase 85.1 (D-02): an adopted legacy row's STORED time is padded too, same as a
            // fresh create/update — only the occupant WHERE lookup above stays on raw times.
            startTime: paddedStart,
            endTime: paddedEnd,
          },
        });
        result.updated++;
        freshCoveredDays.add(`${employeeId}|${date}`);
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
          startTime: paddedStart,
          endTime: paddedEnd,
          label: "Phorest",
          origin: "PHOREST",
          externalId,
          createdBy: opts.actorUserId,
        },
        update: {
          employeeId,
          date: new Date(date),
          startTime: paddedStart,
          endTime: paddedEnd,
          // A re-appearing entry revives a previously soft-cancelled shift (idempotent, self-healing).
          deletedAt: null,
          deletedReason: null,
        },
      });

      if (existing) result.updated++;
      else result.created++;
      freshCoveredDays.add(`${employeeId}|${date}`);

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
          startTime: paddedStart,
          endTime: paddedEnd,
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
    // Phase 85.1 (D-07): a day deliberately skipped this run for "BS gewinnt" must NOT be treated
    // as "vanished from Phorest" — exclude every (employeeId, date) in bsSkippedDays. An empty NOT
    // array is a harmless Prisma no-op when no day was skipped.
    const staleCandidates = await app.prisma.shift.findMany({
      where: {
        origin: "PHOREST",
        deletedAt: null,
        date: { gte: windowStartDate, lte: windowEndDate },
        externalId: { notIn: [...freshExternalIds] },
        employee: { tenantId },
        NOT: [...bsSkippedDays].map((key) => {
          const [eid, d] = key.split("|");
          return { employeeId: eid, date: new Date(d) };
        }),
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

    // ── Phorest-master replace pass (D-11) — runs ONLY after all three gates passed ──
    // For every (employeeId, date) this run actually upserted/adopted a WORKING slot for
    // (freshCoveredDays), soft-delete every OTHER active shift on that exact day whose externalId
    // is not in the fresh set — regardless of origin/label (this REACHES genuine origin=MANUAL
    // rows, unlike the origin=PHOREST-scoped soft-cancel above). D-11a: this block is textually
    // AFTER both GATE-3 return-early exits and the soft-cancel loop, so a fetch-error/SUSPECT run
    // never reaches it (zero deletes). D-11b: a BS-skipped day is excluded — BS wins, leave it
    // alone. Scoped per Phorest-covered day only — never a tenant-wide delete (Pitfall 2).
    for (const key of freshCoveredDays) {
      if (bsSkippedDays.has(key)) continue;
      const [employeeId, dateStr] = key.split("|");
      const replaceCandidates = await app.prisma.shift.findMany({
        where: {
          employeeId,
          date: new Date(dateStr),
          deletedAt: null,
          employee: { tenantId },
          // MANUAL rows carry externalId=null; Prisma `notIn` does NOT match NULL, so the null
          // branch is OR'd in explicitly (regardless of origin/label — this is the whole point
          // of D-11: reach MANUAL rows too, not just origin=PHOREST ones).
          OR: [{ externalId: null }, { externalId: { notIn: [...freshExternalIds] } }],
        },
      });
      for (const dup of replaceCandidates) {
        await app.prisma.shift.update({
          where: { id: dup.id },
          data: { deletedAt: new Date(), deletedReason: "PHOREST_REPLACED" },
        });
        result.replaced++;
        await app.audit({
          userId: opts.actorUserId,
          action: "DELETE",
          entity: "Shift",
          entityId: dup.id,
          oldValue: {
            origin: dup.origin,
            externalId: dup.externalId,
            label: dup.label,
            date: dup.date,
            startTime: dup.startTime,
            endTime: dup.endTime,
            deletedAt: null,
          },
          newValue: { deletedReason: "PHOREST_REPLACED", deletedAt: new Date(), source: "Phorest" },
        });
      }
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
          skippedVocationalSchool: result.skippedVocationalSchool,
          replaced: result.replaced,
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
      skippedVocationalSchool: result.skippedVocationalSchool,
      replaced: result.replaced,
    },
  });
}
