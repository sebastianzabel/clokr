// Phase 69b (Issue #69) — the ONE place that asks "which time entries does employee X have on
// day D". Every former day lookup (ArbZG rest/break checks, the clock resolver, consolidation, the
// WIFI presence adapter) calls this and applies its own extra filter (open/closed, source,
// predecessor, type) to the returned list in memory.
//
// Since Issue #70 the list may hold SEVERAL rows: an employee can have more than one non-deleted
// entry per day, as long as the closed ones never overlap (exclusion constraint
// `TimeEntry_no_overlap_closed`) and at most one is open (partial unique index
// `TimeEntry_employeeId_date_open_unique`). The function returns a LIST; the two selectors below
// answer the question every clock path asks of that list — "which entry does this event act on".
// `time-entry-day-lookup-guard.test.ts` fails the build if a day lookup appears anywhere else in
// apps/api/src.
import type { FastifyInstance } from "fastify";
import type { Prisma, TimeEntry } from "@clokr/db";

/** `app.prisma` or the `tx` handle inside `$transaction(async (tx) => …)`. */
export type DayEntriesDb = FastifyInstance["prisma"] | Prisma.TransactionClient;

/**
 * All non-deleted time entries of `employeeId` on the calendar day `date`, bound to `tenantId`,
 * ordered by start time (then id, for a deterministic order).
 *
 * `date` is compared by equality against the `@db.Date` column — pass the UTC-midnight `Date` of
 * the tenant-local calendar day, exactly as it is stored in `TimeEntry.date`.
 */
export async function findEntriesOfDay(
  db: DayEntriesDb,
  params: { tenantId: string; employeeId: string; date: Date },
): Promise<TimeEntry[]> {
  // Every row of the day, in start order. Callers that need "the" row use the selectors below
  // instead of picking one themselves.
  return db.timeEntry.findMany({
    where: {
      employeeId: params.employeeId,
      date: params.date,
      deletedAt: null,
      employee: { tenantId: params.tenantId },
    },
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
  });
}

/** The minimum a day row must expose for the selectors below. */
interface DayRowShape {
  id: string;
  startTime: Date;
  endTime: Date | null;
}

/**
 * The OPEN row of a day's entries (`endTime === null`), or `null`. The open-per-day index allows at
 * most one open non-deleted row per employee and day, so "the" open row is unambiguous.
 *
 * Issue #70 — together with `latestEndingClosed` the ONE place that answers "which entry of the day
 * does a clock event act on" (resolver REOPEN/STOP candidate, consolidation predecessor, clock
 * salon choice). Phase 92b (Fahrzeit between salons) adds its "skip TRAVEL rows" rule HERE, so every
 * clock path changes at once; no travel logic exists yet (#92).
 */
export function openEntryOf<T extends DayRowShape>(entries: readonly T[]): T | null {
  return entries.find((e) => e.endTime === null) ?? null;
}

/**
 * The closed row with the LATEST end time. Ties (two rows ending at the same instant, e.g. a
 * zero-length artifact next to a real row) go to the later start time, then to the larger id, so
 * the choice is deterministic whatever order the list arrives in. `null` when no closed row exists.
 *
 * Issue #70 — the single place of the REOPEN candidate and of the consolidation predecessor
 * (see `openEntryOf`; Phase 92b adds the TRAVEL skip here).
 */
export function latestEndingClosed<T extends DayRowShape>(entries: readonly T[]): T | null {
  let best: T | null = null;
  for (const e of entries) {
    if (e.endTime === null) continue;
    if (best === null) {
      best = e;
      continue;
    }
    const diff = e.endTime.getTime() - best.endTime!.getTime();
    if (diff > 0) best = e;
    else if (diff === 0) {
      const startDiff = e.startTime.getTime() - best.startTime.getTime();
      if (startDiff > 0 || (startDiff === 0 && e.id > best.id)) best = e;
    }
  }
  return best;
}
