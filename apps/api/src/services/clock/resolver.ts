// Phase 76.2 (ARCH-V19-01) — Source-agnostic clock-event resolver.
// Single $transaction boundary. First statement: FOR UPDATE row lock on Employee.
// Generalizes 76.1's NFC-only lock to all sources (sub-requirement C).
// Calls state-machine to decide, audit-actor to emit AuditLog (closes #215 / sub-req A),
// consolidate to merge cross-source same-day entries (sub-req B / TIME-V19-04).
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ClockEvent, ClockResolution, ClockState } from "./types";
import { decide } from "./state-machine";
import { emitClockAudit } from "./audit-actor";
import { consolidateSameDayEntries } from "./consolidate";
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

    // Current state lookup (filtered deletedAt + endTime + isInvalid per CLAUDE.md contracts)
    const openEntry = await tx.timeEntry.findFirst({
      where: {
        employeeId: event.employeeId,
        deletedAt: null,
        date: event.date,
        endTime: null,
        isInvalid: false,
      },
    });

    const state: ClockState = openEntry
      ? { kind: "OPEN_ENTRY", entryId: openEntry.id, source: openEntry.source }
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

      case "STOP": {
        // WR-01/WR-02 fix: reuse `openEntry` from the state lookup (already filtered with
        // deletedAt: null and isInvalid: false). The previous redundant findUnique omitted
        // the deletedAt filter — replaced by direct reference to the already-locked row.
        const target = openEntry!;
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
