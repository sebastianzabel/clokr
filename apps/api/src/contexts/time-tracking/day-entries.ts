// Phase 69b (Issue #69) — the ONE place that asks "which time entries does employee X have on
// day D". Every former day lookup (ArbZG rest/break checks, the one-per-day invariant, the clock
// resolver, consolidation, the WIFI presence adapter) calls this and applies its own extra filter
// (open/closed, source, predecessor, type) to the returned list in memory.
//
// Today the list holds 0 or 1 rows: the partial unique index
// `TimeEntry_employeeId_date_unique_not_deleted` (schema.prisma, `WHERE "deletedAt" IS NULL`)
// allows at most one non-deleted row per employee and day. The function nevertheless returns a
// LIST so that allowing several entries per day (#70) means changing the index and this module,
// not hunting scattered `findFirst` calls. `time-entry-day-lookup-guard.test.ts` fails the build if
// a day lookup appears anywhere else in apps/api/src.
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
  // MULTI-ENTRY: returns every row of the day; with the unique index gone (#70) callers that pick
  // "the" row (resolver, presence, one-per-day) must decide which one they mean.
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
