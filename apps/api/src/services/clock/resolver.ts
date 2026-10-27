// Phase 76.2 (ARCH-V19-01) — Source-agnostic clock-event resolver.
// Single $transaction boundary. First statement: FOR UPDATE row lock on Employee
// (`lockEmployeeForEntryWrite`, the lock every writer of a TimeEntry interval shares — Issue #70).
// Generalizes 76.1's NFC-only lock to all sources (sub-requirement C).
// Calls state-machine to decide, audit-actor to emit AuditLog (closes #215 / sub-req A),
// consolidate to merge cross-source same-day entries (sub-req B / TIME-V19-04).
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ClockEvent, ClockResolution, ClockState } from "./types";
import { decide } from "./state-machine";
import { emitClockAudit } from "./audit-actor";
import { removeAutoBreaksOfEntry, auditRemovedAutoBreaks } from "./auto-break-replace"; // Issue #799
import { consolidateSameDayEntries, calcBreakMinutesLocal } from "./consolidate";
import { DOUBLE_TAP_DEBOUNCE_MS, CROSS_DAY_OPEN_ENTRY_FALLBACK_HOURS } from "./thresholds";
import { hasApprovedLeaveOnDate } from "../../contexts/absence"; // Phase 100b Plan 14 (AC-1) — index is the public surface
import {
  invalidReasonFields,
  CLEARED_INVALID_REASON,
} from "../../contexts/time-tracking/invalid-reason";
import {
  findEntriesOfDay,
  openEntryOf,
  latestEndingClosed,
} from "../../contexts/time-tracking/day-entries"; // Phase 69b, Issue #70 (selectors)
import { lockEmployeeForEntryWrite } from "../../contexts/time-tracking/entry-write-lock"; // Issue #70
import { checkOverlap } from "../../contexts/time-tracking/entry-invariants"; // Issue #70
import {
  isEntryOverlapViolation,
  isOpenEntryPerDayViolation,
} from "../../contexts/time-tracking/entry-overlap-error"; // Issue #70
import {
  getTenantTimezone,
  isMonthClosed,
  monthRangeUtc,
} from "../../contexts/working-time-account"; // Issue #70 (W8) — public surface only
import { resolveEntrySalon } from "../../contexts/time-tracking/entry-salon"; // Phase 68b
import {
  materializeRemainder,
  activitySharesReplace,
} from "../../contexts/time-tracking/activity-shares"; // Issue #81
import { loadSharesOfEntry } from "../../contexts/time-tracking/activity-store"; // Issue #81

// Issue #87 (D-12): maps the rejection status of `resolveEntrySalon` to the clock conflict reason.
function salonConflictReason(status: 404 | 400 | 409) {
  if (status === 404) return "SALON_NOT_FOUND" as const;
  if (status === 400) return "SALON_INACTIVE" as const;
  return "NO_ACTIVE_SALON" as const;
}

export async function resolveClockEvent(
  app: FastifyInstance,
  event: ClockEvent,
  req?: FastifyRequest,
): Promise<ClockResolution> {
  app.log.info(
    {
      employeeId: event.employeeId,
      source: event.source,
      intent: event.intent,
      date: event.dateStr,
    },
    "clock_event_received",
  );

  try {
    return await app.prisma.$transaction(async (tx) => {
      // FIRST statement: pessimistic per-employee row lock (sub-req C — generalizes 76.1's
      // pattern to all 4 routes). Lock released at commit/rollback. Since Issue #70 it is the lock
      // shared with every manual writer (tenant clause included), so a clock event and a manual
      // write of the same employee queue on one row.
      await lockEmployeeForEntryWrite(tx, event.tenantId, event.employeeId);

      // § 8 BUrlG leave check (single call site replacing 2 per-route copies)
      const leaveCheck = await hasApprovedLeaveOnDate(tx, event.employeeId, event.dateStr);
      if (leaveCheck?.status === "APPROVED") {
        app.log.warn(
          { employeeId: event.employeeId, date: event.dateStr, reason: "LEAVE_APPROVED" },
          "clock_event_conflict",
        );
        return { kind: "CONFLICT", reason: "LEAVE_APPROVED" } as const;
      }

      // Current state lookup. Filters on `deletedAt: null` (CLAUDE.md — mandatory for
      // soft-delete-capable models) and `endTime` — deliberately NOT `isInvalid`.
      //
      // Phase 118 (D-01): `isInvalid` is a business-domain flag on the row, not a
      // clock state. The write path creates `isInvalid` rows itself (the START branch below for
      // CANCELLATION_REQUESTED, § 8 BUrlG; `attendance-checker.ts` after `autoDeleteOpenHours`).
      // The open-per-day index `TimeEntry_employeeId_date_open_unique` (Issue #70; it replaced the
      // one-row-per-day index of Phase 118) is partial on `deletedAt IS NULL` and does NOT know
      // about `isInvalid` — an invalid open row still occupies the day's single open slot.
      // Hiding that row from the resolver produced both halves of issue #124 at once: the
      // permanently open entry (OUT → NOT_CLOCKED_IN → 409 "already clocked out") and the P2002 on
      // the next IN (→ 500). Do not reintroduce this filter.
      // Phase 69b (Issue #69): the day is read once through findEntriesOfDay; open/closed are
      // picked from that list with the same rules the two former queries used.
      const dayEntries = await findEntriesOfDay(tx, {
        tenantId: event.tenantId,
        employeeId: event.employeeId,
        date: event.date,
      });
      // Issue #70 (D-11): the clock state is "the open row of the day" — the open-per-day index
      // guarantees there is at most one, so STOP always knows which entry it closes. The choice
      // lives in `openEntryOf` (the one place Phase 92b adds its TRAVEL skip).
      const sameDayOpenEntry = openEntryOf(dayEntries);

      // Phase 376 (Issue #376, D-01/D-02): a shift crossing local midnight (23:30 clock-in,
      // 00:30 clock-out tap) computes `event.date` as the NEW day — the same-day lookup above
      // finds nothing even though the previous day's entry is still open. Only checked when
      // today has no open entry; calls the SAME findEntriesOfDay() wrapper a second time (never
      // a new raw day-predicate query — time-entry-day-lookup-guard.test.ts stays compliant).
      // Issue #70: the cross-day candidate is "the open row of the PREVIOUS day", picked with the
      // same `openEntryOf` as the same-day one.
      let crossDayOpenEntry: (typeof dayEntries)[number] | null = null;
      if (!sameDayOpenEntry) {
        const previousDate = new Date(event.date);
        previousDate.setUTCDate(previousDate.getUTCDate() - 1);
        const previousDayEntries = await findEntriesOfDay(tx, {
          tenantId: event.tenantId,
          employeeId: event.employeeId,
          date: previousDate,
        });
        const candidate = openEntryOf(previousDayEntries);
        if (candidate) {
          // D-02: bound the lookback by elapsed time so an unrelated tap days after a genuinely
          // forgotten clock-out can never silently close it with a wrong endTime. Reuses the
          // tenant's own staleness threshold (same field attendance-checker.ts already uses);
          // `0`/missing config falls back to the fixed 24h cap — never "search back forever".
          const tenantConfig = await tx.tenantConfig.findUnique({
            where: { tenantId: event.tenantId },
          });
          const boundHours =
            tenantConfig?.autoDeleteOpenHours || CROSS_DAY_OPEN_ENTRY_FALLBACK_HOURS;
          const elapsedMs = event.timestamp.getTime() - candidate.startTime.getTime();
          if (elapsedMs <= boundHours * 3600_000) {
            crossDayOpenEntry = candidate;
          }
        }
      }
      // D-03: an in-bound previous-day open row outranks a same-day closed row — at most one
      // clock session can be genuinely active per employee. D-04: no new ClockState/
      // ClockDecision variant — the cross-day candidate is folded into the existing OPEN_ENTRY
      // shape below, so decide() runs unchanged.
      const openEntry = sameDayOpenEntry ?? crossDayOpenEntry;

      // D-01: when no open entry, look for a closed non-deleted same-day entry to potentially reopen.
      // Selected WITHOUT isLocked filter so the REOPEN branch can return explicit MONTH_LOCKED CONFLICT.
      // Issue #70 (D-02/D-11): REOPEN extends the latest-ending closed row of the day (`L`);
      // whether a new IN re-opens it or starts a new entry in another salon is decided below,
      // after the Nachtrag guard. The choice of `L` lives in `latestEndingClosed`.
      const closedEntry = !openEntry ? latestEndingClosed(dayEntries) : null;

      // Phase 118 (D-02/D-03): a row coupled to a still-PENDING Zeitnachtrag
      // (Phase 96, `TimeEntry.retroRequestId @unique`) is a REQUEST, not a punch.
      // It is closed (startTime+endTime come from the request) and would be read
      // above as CLOSED_SAME_DAY_ENTRY — a tap would REOPEN it to `endTime: null`
      // and the approval flow would then release a corrupted entry. This is
      // genuinely reachable: `createRetroRequestSchema` (retro-entry-requests.ts:20-42)
      // has no past-date limit, `targetDate = today` is accepted.
      //
      // Qualified on "request still PENDING": the approve branch
      // (retro-entry-requests.ts:363-365) sets `isInvalid` to `false` but leaves
      // `retroRequestId` set — an approved Nachtrag row is a perfectly ordinary
      // closed entry and must remain usable via REOPEN. The reject branch (:466-473)
      // soft-deletes the row; it already falls out via `deletedAt: null`.
      const retroCandidate = openEntry ?? closedEntry;
      if (retroCandidate?.retroRequestId) {
        const pendingRetro = await tx.retroEntryRequest.findFirst({
          where: { id: retroCandidate.retroRequestId, status: "PENDING", deletedAt: null },
          select: { id: true },
        });
        if (pendingRetro) {
          app.log.warn(
            {
              employeeId: event.employeeId,
              source: event.source,
              intent: event.intent,
              entryId: retroCandidate.id,
              retroRequestId: retroCandidate.retroRequestId,
              reason: "RETRO_PENDING",
            },
            "clock_event_conflict",
          );
          return { kind: "CONFLICT", reason: "RETRO_PENDING" } as const;
        }
      }

      // Issue #70 (D-02/D-11): with no open entry, a finished day and an explicitly chosen salon,
      // the salon is validated FIRST — a foreign and an unknown id answer the identical 404 and an
      // inactive one 400 (T-100-09), before any state decision and before the locked guard — and a
      // validated salon that differs from `L`'s starts a NEW entry in that salon instead of
      // re-opening `L` (the former differing-salon 409 no longer exists). Without a salon (NFC,
      // WIFI, web without a choice) or with `L`'s own salon the latest entry is re-opened as
      // before. The state machine stays pure: "start in another salon" is simply presented to
      // `decide()` as a day without a re-openable entry. With an OPEN entry the answer stays
      // ALREADY_CLOCKED_IN whatever salon is named (identical for foreign and unknown ids).
      let startInOtherSalon = false;
      if (!openEntry && closedEntry && event.salonId !== undefined) {
        const chosen = await resolveEntrySalon(tx, {
          tenantId: event.tenantId,
          employeeId: event.employeeId,
          startTime: event.timestamp,
          explicitSalonId: event.salonId,
        });
        if (!chosen.ok) {
          app.log.warn(
            {
              employeeId: event.employeeId,
              source: event.source,
              entryId: closedEntry.id,
              reason: salonConflictReason(chosen.status),
            },
            "clock_event_conflict",
          );
          return { kind: "CONFLICT", reason: salonConflictReason(chosen.status) } as const;
        }
        startInOtherSalon = chosen.salonId !== closedEntry.salonId;
      }

      const state: ClockState = openEntry
        ? { kind: "OPEN_ENTRY", entryId: openEntry.id, source: openEntry.source }
        : closedEntry && !startInOtherSalon
          ? {
              kind: "CLOSED_SAME_DAY_ENTRY",
              entryId: closedEntry.id,
              endTime: closedEntry.endTime!,
              isLocked: closedEntry.isLocked,
            }
          : { kind: "NO_OPEN_ENTRY" };

      const decision = decide(state, event.intent, event.source);

      switch (decision.kind) {
        case "START": {
          // Phase 68b (issue #68, D-08/D-09): the salon of a NEW entry is resolved here, inside
          // the transaction, from the punch INSTANT (never `event.date`). The explicit salon of the
          // web clock-in (Issue #87, D-01) is validated by the same rule; without one the pattern
          // -> default salon chain applies (D-07: NFC and WIFI never send one). REOPEN, STOP,
          // CONFIRM and consolidation never re-derive the salon of an existing entry.
          const salon = await resolveEntrySalon(tx, {
            tenantId: event.tenantId,
            employeeId: event.employeeId,
            startTime: event.timestamp,
            ...(event.salonId !== undefined && { explicitSalonId: event.salonId }),
          });
          if (!salon.ok) {
            app.log.warn(
              {
                employeeId: event.employeeId,
                source: event.source,
                intent: event.intent,
                reason: salonConflictReason(salon.status),
              },
              "clock_event_conflict",
            );
            return { kind: "CONFLICT", reason: salonConflictReason(salon.status) } as const;
          }
          // Issue #70 (D-06, W8, Revisionssicherheit): with several entries per day an existing
          // entry no longer implies the day is settled, so a START refuses on its own account when
          // the day holds a locked entry or its month has a closed SaldoSnapshot — before the
          // overlap check and before any write. `isMonthClosed` is the canonical Monatsabschluss
          // signal and the month is the tenant-local month of `event.date` (the same computation as
          // the manual writers' month-lock step in entry-invariants.ts).
          const tz = await getTenantTimezone(app.prisma, event.tenantId);
          const { start: monthStart } = monthRangeUtc(
            event.date.getUTCFullYear(),
            event.date.getUTCMonth() + 1,
            tz,
          );
          if (
            dayEntries.some((e) => e.isLocked) ||
            (await isMonthClosed(tx, event.employeeId, event.tenantId, monthStart))
          ) {
            app.log.warn(
              { employeeId: event.employeeId, date: event.dateStr, reason: "MONTH_LOCKED" },
              "clock_event_conflict",
            );
            return { kind: "CONFLICT", reason: "MONTH_LOCKED" } as const;
          }
          // Issue #70 (D-10, T-70b-11): a new entry is open, i.e. it runs to the end of its day
          // (`checkOverlap` semantics since v1.8.13), so its instant must lie after every closed
          // entry of the employee — also a LATER closed entry of the same day. The exclusion
          // constraint cannot see an open entry; this check, under the Employee lock taken above,
          // is what closes that gap. The work between two closed entries is recorded through the
          // manual form, never by a clock-in.
          const conflict = await checkOverlap(
            tx,
            event.employeeId,
            event.timestamp,
            null,
            undefined,
            event.date,
          );
          if (conflict) {
            app.log.warn(
              {
                employeeId: event.employeeId,
                source: event.source,
                intent: event.intent,
                conflictEntryId: conflict.id,
                reason: "ENTRY_OVERLAP",
              },
              "clock_event_conflict",
            );
            return { kind: "CONFLICT", reason: "ENTRY_OVERLAP" } as const;
          }
          const entry = await tx.timeEntry.create({
            data: {
              salonId: salon.salonId,
              employeeId: event.employeeId,
              date: event.date,
              startTime: event.timestamp,
              source: event.source as never, // widened at boundary; DB enforces enum
              isInvalid: leaveCheck?.status === "CANCELLATION_REQUESTED",
              ...(leaveCheck
                ? invalidReasonFields("LEAVE_CANCELLATION_PENDING")
                : CLEARED_INVALID_REASON),
              note: event.note,
            },
          });
          const audit = await emitClockAudit(tx, {
            action: "CLOCK_IN",
            entity: "TimeEntry",
            entityId: entry.id,
            newValue: entry,
            actor: event.actor,
            req,
          });
          app.log.info(
            {
              employeeId: event.employeeId,
              source: event.source,
              kind: "CLOCKED_IN",
              entryId: entry.id,
            },
            "clock_event_resolved",
          );
          return { kind: "CLOCKED_IN", entry, audit } as const;
        }

        case "REOPEN": {
          // Issue #70 (D-02/D-11): a re-clock-in without a salon, or with the salon of the latest
          // entry, re-opens that entry and never changes its salon (Phase 68b D-09); a differing
          // explicit salon was already turned into a START above, after its validation. Nothing is
          // written before this point.
          // D-01b: locked-month guard (mirrors STOP branch — never mutate a locked entry)
          if (closedEntry!.isLocked) {
            app.log.warn(
              { employeeId: event.employeeId, entryId: closedEntry!.id, reason: "MONTH_LOCKED" },
              "clock_event_conflict",
            );
            return { kind: "CONFLICT", reason: "MONTH_LOCKED" } as const;
          }
          // Issue #70 (T-70b-14): `L` ends after the event instant — a re-open would write a
          // NEGATIVE gap break (end before start) and let the entry run over time that is already
          // recorded. Refused before any write; the missing time is recorded through the form.
          if (closedEntry!.endTime! > event.timestamp) {
            app.log.warn(
              {
                employeeId: event.employeeId,
                source: event.source,
                entryId: closedEntry!.id,
                reason: "ENTRY_OVERLAP",
              },
              "clock_event_conflict",
            );
            return { kind: "CONFLICT", reason: "ENTRY_OVERLAP" } as const;
          }
          const gapBreakStart = closedEntry!.endTime!; // old endTime = start of gap break
          // Issue #81 (D-07): the classified remainder of the CLOSED entry (values before the gap
          // break) becomes an explicit share, so the time worked after the re-open is never
          // attributed to a kind nobody chose. Null for an unclassified entry — then nothing changes.
          const sharesBefore = await loadSharesOfEntry(tx, event.tenantId, decision.entryId);
          const materialized = materializeRemainder({
            kind: closedEntry!.activityKind,
            shares: sharesBefore,
            startTime: closedEntry!.startTime,
            endTime: closedEntry!.endTime,
            breakMinutes: closedEntry!.breakMinutes,
          });
          // 0. Issue #799: a recorded gap replaces the automatic break of the earlier stop.
          const removedAuto = await removeAutoBreaksOfEntry(tx, closedEntry!);
          await auditRemovedAutoBreaks(tx, {
            entryId: decision.entryId,
            removed: removedAuto,
            actor: event.actor,
            req,
          });
          // 1. Create Break for the gap (old endTime → new START timestamp)
          const breakRow = await tx.break.create({
            data: {
              timeEntryId: decision.entryId,
              startTime: gapBreakStart,
              endTime: event.timestamp,
            },
          });
          // 2. Recompute breakMinutes from ALL Break rows, then reopen + update in one round-trip
          const allBreaks = await tx.break.findMany({ where: { timeEntryId: decision.entryId } });
          const totalBreakMins = Math.round(calcBreakMinutesLocal(allBreaks));
          const reopened = await tx.timeEntry.update({
            where: { id: decision.entryId },
            data: {
              endTime: null,
              breakMinutes: totalBreakMins,
              ...(removedAuto.length > 0 && { breakStatus: "CONFIRMED" as const }),
              ...(materialized && {
                activityKind: materialized.kind,
                activityShares: activitySharesReplace(materialized.shares),
              }),
            },
          });
          // D-01c: audit the reopen with the dedicated CLOCK_REOPEN action
          const audit = await emitClockAudit(tx, {
            action: "CLOCK_REOPEN",
            entity: "TimeEntry",
            entityId: reopened.id,
            oldValue: {
              endTime: gapBreakStart.toISOString(),
              ...(materialized && {
                activityKind: closedEntry!.activityKind,
                activityShares: sharesBefore,
              }),
            },
            newValue: {
              endTime: null,
              gapBreakId: breakRow.id,
              breakMinutes: totalBreakMins,
              ...(materialized && {
                activityKind: materialized.kind,
                activityShares: materialized.shares,
              }),
            },
            actor: event.actor,
            req,
          });
          app.log.info(
            {
              employeeId: event.employeeId,
              source: event.source,
              kind: "REOPENED",
              entryId: reopened.id,
            },
            "clock_event_resolved",
          );
          return { kind: "CLOCKED_IN", entry: reopened, audit } as const;
        }

        case "STOP": {
          // WR-01/WR-02: reuse `openEntry` from the state lookup (already loaded with
          // `deletedAt: null` and protected by the FOR-UPDATE lock on Employee).
          // Replaces an earlier redundant findUnique that omitted the deletedAt filter.
          // Phase 118 (D-01/D-04): this entry CAN be `isInvalid: true` — exactly the
          // case from issue #124. The clock path closes it and leaves
          // `isInvalid`/`invalidReason` untouched: invalidity belongs to whoever set
          // it (the cancellation approval auto-revalidates — CLAUDE.md § 8 BUrlG; the
          // attendance checker sets it). Silently revalidating on clock-out would be
          // a "silent overwrite" per the Revisionssicherheit rules.
          const target = openEntry!;
          // D-02: 60s server double-tap debounce. A STOP within 60s of START is an accidental
          // double-tap → NO-OP: leave the entry open, produce no zero/near-zero-duration row.
          //
          // Phase 307 Plan 01 (D-01 corrected): gated on `event.interactive`, not on
          // `event.source` — a source-literal list here would be exactly the resolver-internal
          // special-casing future-source.test.ts forbids ("adding a sixth source is one new
          // adapter file, no resolver changes"). `event.interactive` is set by the adapter that
          // built this event; a missing/false value takes the conservative (debounced) branch.
          const gapMs = event.timestamp.getTime() - target.startTime.getTime();
          if (!event.interactive && gapMs < DOUBLE_TAP_DEBOUNCE_MS) {
            app.log.info(
              {
                entryId: target.id,
                gapMs,
                source: event.source,
                interactive: Boolean(event.interactive),
                reason: "DEBOUNCE_NOOP",
              },
              "clock_event_noop",
            );
            return { kind: "DEBOUNCE_NOOP" } as const;
          }
          if (target.isLocked) {
            app.log.warn(
              { employeeId: event.employeeId, entryId: target.id, reason: "MONTH_LOCKED" },
              "clock_event_conflict",
            );
            return { kind: "CONFLICT", reason: "MONTH_LOCKED" } as const;
          }

          const updated = await tx.timeEntry.update({
            where: { id: decision.entryId },
            data: { endTime: event.timestamp },
          });

          // Cross-source consolidation (sub-req B). Read tenant-specific gap window.
          const tenantConfig = await tx.tenantConfig.findUnique({
            where: { tenantId: event.tenantId },
          });
          const gapHoursMax = tenantConfig?.consolidationGapHours ?? 4;

          const merge = await consolidateSameDayEntries(
            tx,
            event.tenantId,
            updated,
            gapHoursMax,
            app.log,
          );

          if (merge.merged) {
            const audit = await emitClockAudit(tx, {
              action: "CLOCK_OUT",
              entity: "TimeEntry",
              entityId: merge.targetEntryId,
              oldValue: merge.before,
              newValue: merge.after,
              actor: event.actor,
              req,
            });
            await auditRemovedAutoBreaks(tx, {
              entryId: merge.targetEntryId,
              removed: merge.removedAutoBreaks,
              actor: event.actor,
              req,
            });
            await emitClockAudit(tx, {
              action: "DELETE",
              entity: "TimeEntry",
              entityId: merge.deletedEntryId,
              oldValue: merge.deletedEntryBefore,
              actor: event.actor,
              req,
            });
            app.log.info(
              {
                employeeId: event.employeeId,
                source: event.source,
                kind: "CONSOLIDATED",
                targetEntryId: merge.targetEntryId,
              },
              "clock_event_resolved",
            );
            return {
              kind: "CONSOLIDATED",
              entry: merge.after,
              breakId: merge.breakId,
              audit,
            } as const;
          }

          const audit = await emitClockAudit(tx, {
            action: "CLOCK_OUT",
            entity: "TimeEntry",
            entityId: updated.id,
            oldValue: { ...target, endTime: null },
            newValue: updated,
            actor: event.actor,
            req,
          });
          app.log.info(
            {
              employeeId: event.employeeId,
              source: event.source,
              kind: "CLOCKED_OUT",
              entryId: updated.id,
            },
            "clock_event_resolved",
          );
          return { kind: "CLOCKED_OUT", entry: updated, audit } as const;
        }

        case "CONFIRM": {
          const audit = await emitClockAudit(tx, {
            action: "WIFI_PRESENCE_CONFIRMED",
            entity: "TimeEntry",
            entityId: decision.entryId,
            newValue: { source: event.source, timestamp: event.timestamp.toISOString() },
            actor: event.actor,
            req,
          });
          app.log.info(
            {
              employeeId: event.employeeId,
              source: event.source,
              kind: "CONFIRMED",
              entryId: decision.entryId,
            },
            "clock_event_resolved",
          );
          return { kind: "CONFIRMED", entryId: decision.entryId, audit } as const;
        }

        case "CONFLICT": {
          app.log.warn(
            { employeeId: event.employeeId, source: event.source, reason: decision.reason },
            "clock_event_conflict",
          );
          return { kind: "CONFLICT", reason: decision.reason } as const;
        }
      }
    });
  } catch (err: unknown) {
    // Phase 118 (D-06) / Issue #70: the partial open-per-day index
    // `TimeEntry_employeeId_date_open_unique` catches a concurrent same-day open entry that slipped
    // past the resolver's FOR-UPDATE lock (e.g. a manual open entry via POST /api/v1/time-entries).
    // It is the race backstop and stays a business conflict, not a server error (P2002 →
    // ALREADY_CLOCKED_IN). The exclusion constraint `TimeEntry_no_overlap_closed` is the backstop
    // for closed intervals (a clock-out or an extension that would overlap a neighbour): its
    // refusal is ENTRY_OVERLAP. Both recognitions read structured error fields, never the message.
    //
    // The catch deliberately sits OUTSIDE the transaction callback: once a
    // statement inside a Postgres transaction fails, the transaction is aborted;
    // any further query on the same `tx` (e.g. emitClockAudit) would also fail.
    if (isOpenEntryPerDayViolation(err)) {
      app.log.warn(
        {
          employeeId: event.employeeId,
          source: event.source,
          intent: event.intent,
          reason: "ALREADY_CLOCKED_IN",
          cause: "P2002",
        },
        "clock_event_conflict",
      );
      return { kind: "CONFLICT", reason: "ALREADY_CLOCKED_IN" } as const;
    }
    if (isEntryOverlapViolation(err)) {
      app.log.warn(
        {
          employeeId: event.employeeId,
          source: event.source,
          intent: event.intent,
          reason: "ENTRY_OVERLAP",
          cause: "P2039",
        },
        "clock_event_conflict",
      );
      return { kind: "CONFLICT", reason: "ENTRY_OVERLAP" } as const;
    }
    throw err;
  }
}
