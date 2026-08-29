// Phase 76.2 (ARCH-V19-01) — Source-agnostic clock-event resolver.
// Single $transaction boundary. First statement: FOR UPDATE row lock on Employee.
// Generalizes 76.1's NFC-only lock to all sources (sub-requirement C).
// Calls state-machine to decide, audit-actor to emit AuditLog (closes #215 / sub-req A),
// consolidate to merge cross-source same-day entries (sub-req B / TIME-V19-04).
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ClockEvent, ClockResolution, ClockState } from "./types";
import { decide } from "./state-machine";
import { emitClockAudit } from "./audit-actor";
import { consolidateSameDayEntries, calcBreakMinutesLocal } from "./consolidate";
import { hasApprovedLeaveOnDate } from "../../utils/leave-check";

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

  return app.prisma.$transaction(async (tx) => {
    // FIRST statement: pessimistic per-employee row lock (sub-req C — generalizes 76.1's
    // pattern to all 4 routes). Lock released at commit/rollback.
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${event.employeeId} FOR UPDATE`;

    // § 8 BUrlG leave check (single call site replacing 2 per-route copies)
    const leaveCheck = await hasApprovedLeaveOnDate(tx, event.employeeId, event.dateStr);
    if (leaveCheck?.status === "APPROVED") {
      app.log.warn(
        { employeeId: event.employeeId, date: event.dateStr, reason: "LEAVE_APPROVED" },
        "clock_event_conflict",
      );
      return { kind: "CONFLICT", reason: "LEAVE_APPROVED" } as const;
    }

    // Current state lookup. Gefiltert wird `deletedAt: null` (CLAUDE.md, Pflicht fuer
    // soft-delete-faehige Modelle) und `endTime` — bewusst NICHT `isInvalid`.
    //
    // Phase 118 (D-01): `isInvalid` ist eine fachliche Markierung am Eintrag, kein
    // Clock-State. Der Schreibpfad erzeugt `isInvalid`-Zeilen selbst (:82-91 bei
    // CANCELLATION_REQUESTED, § 8 BUrlG; `attendance-checker.ts:296-303` nach
    // `autoDeleteOpenHours`). Der Tages-Eindeutigkeitsindex
    // `TimeEntry_employeeId_date_unique_not_deleted` ist partiell auf `deletedAt IS NULL`
    // und kennt `isInvalid` NICHT — es gibt pro Mitarbeiter und Tag also hoechstens EINE
    // nicht-geloeschte Zeile. Diese Zeile vor dem Resolver zu verstecken erzeugte beide
    // Haelften von Issue #124 gleichzeitig: den ewig offenen Eintrag (OUT → NOT_CLOCKED_IN
    // → 409 "Bereits ausgestempelt") und den P2002 beim naechsten IN (→ 500).
    // Diesen Filter NICHT wieder einfuehren.
    const openEntry = await tx.timeEntry.findFirst({
      where: {
        employeeId: event.employeeId,
        deletedAt: null,
        date: event.date,
        endTime: null,
      },
    });

    // D-01: when no open entry, look for a closed non-deleted same-day entry to potentially reopen.
    // Query WITHOUT isLocked filter so the REOPEN branch can return explicit MONTH_LOCKED CONFLICT.
    const closedEntry = !openEntry
      ? await tx.timeEntry.findFirst({
          where: {
            employeeId: event.employeeId,
            deletedAt: null,
            date: event.date,
            endTime: { not: null },
          },
          orderBy: { endTime: "desc" },
        })
      : null;

    // Phase 118 (D-02/D-03): eine an einen noch PENDING Zeitnachtrag gekoppelte Zeile
    // (Phase 96, `TimeEntry.retroRequestId @unique`) ist ein ANTRAG, keine Stempelung.
    // Sie ist geschlossen (startTime+endTime aus dem Antrag) und wuerde oben als
    // CLOSED_SAME_DAY_ENTRY gelesen — ein Tap wuerde sie per REOPEN auf `endTime: null`
    // setzen und der Genehmigungs-Flow gaebe anschliessend einen kaputten Eintrag frei.
    // Real erreichbar: `createRetroRequestSchema` (retro-entry-requests.ts:20-42) hat keine
    // Vergangenheitsgrenze, `targetDate = heute` wird akzeptiert.
    //
    // Qualifiziert auf "Antrag noch PENDING": der Approve-Zweig
    // (retro-entry-requests.ts:363-365) setzt `isInvalid` auf `false`, laesst `retroRequestId`
    // aber gesetzt — eine freigegebene Nachtrag-Zeile ist ein ganz normaler geschlossener
    // Eintrag und muss weiter per REOPEN benutzbar bleiben. Der Reject-Zweig (:466-473)
    // soft-loescht die Zeile; sie faellt schon durch `deletedAt: null` heraus.
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

    const state: ClockState = openEntry
      ? { kind: "OPEN_ENTRY", entryId: openEntry.id, source: openEntry.source }
      : closedEntry
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
        const entry = await tx.timeEntry.create({
          data: {
            employeeId: event.employeeId,
            date: event.date,
            startTime: event.timestamp,
            source: event.source as never, // widened at boundary; DB enforces enum
            isInvalid: leaveCheck?.status === "CANCELLATION_REQUESTED",
            invalidReason: leaveCheck ? "Urlaubsstornierung ausstehend" : null,
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
        // D-01b: locked-month guard (mirrors STOP branch — never mutate a locked entry)
        if (closedEntry!.isLocked) {
          app.log.warn(
            { employeeId: event.employeeId, entryId: closedEntry!.id, reason: "MONTH_LOCKED" },
            "clock_event_conflict",
          );
          return { kind: "CONFLICT", reason: "MONTH_LOCKED" } as const;
        }
        const gapBreakStart = closedEntry!.endTime!; // old endTime = start of gap break
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
          data: { endTime: null, breakMinutes: totalBreakMins },
        });
        // D-01c: audit the reopen with the dedicated CLOCK_REOPEN action
        const audit = await emitClockAudit(tx, {
          action: "CLOCK_REOPEN",
          entity: "TimeEntry",
          entityId: reopened.id,
          oldValue: { endTime: gapBreakStart.toISOString() },
          newValue: { endTime: null, gapBreakId: breakRow.id, breakMinutes: totalBreakMins },
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
        // WR-01/WR-02: `openEntry` aus dem State-Lookup wiederverwenden (bereits mit
        // `deletedAt: null` geladen und ueber den FOR-UPDATE-Lock auf Employee geschuetzt).
        // Ein frueheres redundantes findUnique ohne deletedAt-Filter wurde dadurch ersetzt.
        // Phase 118 (D-01/D-04): dieser Eintrag KANN `isInvalid: true` sein — genau das ist
        // der Fall aus Issue #124. Der Clock-Pfad schliesst ihn und laesst
        // `isInvalid`/`invalidReason` unangetastet: die Invaliditaet gehoert ihrem Erzeuger
        // (die Stornierungs-Genehmigung revalidiert automatisch — CLAUDE.md § 8 BUrlG; der
        // Attendance-Checker setzt sie). Stilles Revalidieren beim Ausstempeln waere ein
        // "silent overwrite" im Sinne der Revisionssicherheits-Regeln.
        const target = openEntry!;
        // D-02: 60s server double-tap debounce. A STOP within 60s of START is an accidental
        // double-tap → NO-OP: leave the entry open, produce no zero/near-zero-duration row.
        const gapMs = event.timestamp.getTime() - target.startTime.getTime();
        if (gapMs < 60_000) {
          app.log.info(
            { entryId: target.id, gapMs, source: event.source, reason: "DEBOUNCE_NOOP" },
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

        const merge = await consolidateSameDayEntries(tx, updated, gapHoursMax, app.log);

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
}
