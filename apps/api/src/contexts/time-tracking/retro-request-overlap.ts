// Issue #657 (D-01/D-02/D-05/D-13) — the ONE place of the Zeitnachtrag interval rule.
//
// Since Issue #70 a day carries several entries, so a day may also carry several Zeitnachtrag
// requests, as long as their intervals do not overlap. This module decides "overlap" for requests:
//
//  - D-01: intervals are half-open on the tenant-local day. A request ending 12:00 and one starting
//    12:00 touch but do not overlap (the #70 convention of the entry overlap rule).
//  - D-02: a pending request WITHOUT times (a legacy row) covers the whole tenant-local day. No time is
//    ever invented for it, so it refuses every new request of that day.
//  - D-13: only PENDING requests refuse (a coupled one is judged by the interval of its non-deleted
//    coupled entry, because an own PUT moves the entry and never the request's HH:MM; an uncoupled
//    one by its HH:MM). APPROVED, REJECTED, USED and withdrawn (`deletedAt`) requests are ignored: a
//    decided request is no open question any more, and nothing in the product consumes or withdraws
//    an APPROVED one (an approved correction proposal, or an approved Nachtrag whose entry was
//    deleted later, would otherwise block its interval for good). A real collision with a recorded
//    time is caught by the entry overlap rule when an entry is written.
//
// The callers run the check inside the transaction whose FIRST statement is
// `lockEmployeeForEntryWrite()` (D-04), so a creation that waited on the lock sees the winner's
// committed request. The error text is neutral on purpose (no date, time or person), hence no reach
// decision is needed to word it.

import { fromZonedTime } from "date-fns-tz";
import type { Prisma } from "@clokr/db";

/** Control value of the refusal; the German text below is display only. */
export const RETRO_REQUEST_OVERLAP_CODE = "RETRO_REQUEST_OVERLAP";
export const RETRO_REQUEST_OVERLAP_MESSAGE =
  "Der Zeitraum überschneidet sich mit einem anderen Zeitnachtrag dieses Tages.";

/** Thrown inside a creation transaction; the route maps it to 409. Never classified by message. */
export class RetroRequestOverlapError extends Error {
  constructor() {
    super(RETRO_REQUEST_OVERLAP_CODE);
    this.name = "RetroRequestOverlapError";
  }
}

export interface RequestInterval {
  start: Date;
  end: Date;
}

/** The calendar day after `dateStr` (YYYY-MM-DD), by pure calendar arithmetic on the string. */
function nextDayStr(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}

/** The tenant-local calendar day as a half-open interval (23 or 25 h long on a DST day). */
export function wholeTenantDay(dateStr: string, tz: string): RequestInterval {
  return {
    start: fromZonedTime(`${dateStr}T00:00:00`, tz),
    end: fromZonedTime(`${nextDayStr(dateStr)}T00:00:00`, tz),
  };
}

/**
 * The interval a request occupies. Both HH:MM present: those two local times on the target day (the
 * derivation the approval branch uses). Start or end missing: the whole day (D-02).
 */
export function retroRequestInterval(
  request: {
    targetDateStr: string;
    startTime: string | null | undefined;
    endTime: string | null | undefined;
  },
  tz: string,
): RequestInterval {
  if (!request.startTime || !request.endTime) return wholeTenantDay(request.targetDateStr, tz);
  return {
    start: fromZonedTime(`${request.targetDateStr}T${request.startTime}:00`, tz),
    end: fromZonedTime(`${request.targetDateStr}T${request.endTime}:00`, tz),
  };
}

/** Half-open overlap: touching intervals do not overlap. */
export function intervalsOverlap(a: RequestInterval, b: RequestInterval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * The first pending request of the employee's day whose interval overlaps `interval`, else null.
 * `tenantId` is required (never optional) so the read cannot silently widen across tenants.
 */
export async function findOverlappingRetroRequest(
  db: Prisma.TransactionClient,
  params: {
    tenantId: string;
    employeeId: string;
    /** The `@db.Date` value (UTC midnight) of the day. */
    targetDate: Date;
    interval: RequestInterval;
    tz: string;
  },
): Promise<{ id: string } | null> {
  const targetDateStr = params.targetDate.toISOString().split("T")[0];
  const rows = await db.retroEntryRequest.findMany({
    where: {
      employeeId: params.employeeId,
      targetDate: params.targetDate,
      deletedAt: null,
      status: "PENDING",
      employee: { tenantId: params.tenantId },
    },
    select: {
      id: true,
      startTime: true,
      endTime: true,
      timeEntry: { select: { startTime: true, endTime: true, deletedAt: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  for (const row of rows) {
    const coupled = row.timeEntry && row.timeEntry.deletedAt === null ? row.timeEntry : null;
    let occupied: RequestInterval;
    if (coupled) {
      occupied = {
        start: coupled.startTime,
        end: coupled.endTime ?? wholeTenantDay(targetDateStr, params.tz).end,
      };
    } else {
      occupied = retroRequestInterval(
        { targetDateStr, startTime: row.startTime, endTime: row.endTime },
        params.tz,
      );
    }
    if (intervalsOverlap(occupied, params.interval)) return { id: row.id };
  }
  return null;
}
