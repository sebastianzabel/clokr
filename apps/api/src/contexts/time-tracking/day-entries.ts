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
// Neither selector hands out a row that is a pending Zeitnachtrag request, and a closed row it
// shadows is not handed out either (Issue #657, D-14; Issue #92 adds the TRAVEL skip next to it).
// `time-entry-day-lookup-guard.test.ts` fails the build if a day lookup appears anywhere else in
// apps/api/src.
import type { FastifyInstance } from "fastify";
import type { Prisma, TimeEntry } from "@clokr/db";
import { addWorkingMinutes } from "./entry-durations"; // Issue #70 (70b-04) — the one working-time fold

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
  /** Issue #92: a `TRAVEL` row is a trip between two salons, never a row a clock event acts on. */
  activityKind?: string;
  /** Issue #657: a row coupled to a Zeitnachtrag (Phase 96, `TimeEntry.retroRequestId @unique`). */
  retroRequestId?: string | null;
  isInvalid?: boolean;
  invalidReasonCode?: string | null;
}

/** The reason code the entry-first writer sets on a Zeitnachtrag row while its request is PENDING. */
const RETRO_PENDING_MARKER = "RETRO_APPROVAL_PENDING";

/**
 * Issue #657 (IN-01): the ONE spelling of the pending-Zeitnachtrag marker — the reason code alone.
 * It exists separately from {@link isPendingRetroRow} for a row that is only being PLANNED (the
 * travel neighbour check's `with` row has a reason code but no request id yet). Every reader of the
 * marker, `travel-entry.ts` included, goes through this function or `isPendingRetroRow`.
 */
export function hasPendingRetroMarker(row: { invalidReasonCode?: string | null }): boolean {
  return row.invalidReasonCode === RETRO_PENDING_MARKER;
}

/**
 * Issue #657 (D-07/D-14): true for a row that is a pending Zeitnachtrag REQUEST rather than a
 * recorded punch — it is coupled to a request (`retroRequestId`) AND carries the marker the
 * entry-first writer sets atomically with the request (`isInvalid` with the reason code, see
 * {@link hasPendingRetroMarker}). The approval clears the marker, a rejection or withdrawal
 * soft-deletes the row. `travel-entry.ts` (anchors) and the web page read the same marker (the
 * former through `hasPendingRetroMarker`, because it also judges rows not stored yet). An approved
 * Nachtrag row is an ordinary closed entry and is NOT pending.
 */
export function isPendingRetroRow(row: DayRowShape): boolean {
  return Boolean(row.retroRequestId) && row.isInvalid === true && hasPendingRetroMarker(row);
}

/**
 * The OPEN row of a day's entries (`endTime === null`), or `null`. The open-per-day index allows at
 * most one open non-deleted row per employee and day, so "the" open row is unambiguous.
 *
 * Issue #70 — together with `latestEndingClosed` the ONE place that answers "which entry of the day
 * does a clock event act on" (resolver REOPEN/STOP candidate, consolidation predecessor, clock
 * salon choice). Phase 92b (Fahrzeit between salons) adds its "skip TRAVEL rows" rule HERE, so every
 * clock path changes at once. A travel row is never open — it is closed by the database CHECK
 * `TimeEntry_travel_shape_check` (an end time is required) — so this selector never meets one and
 * needs no skip of its own (Issue #92, D-06).
 *
 * Issue #657 (D-14): an open row that is a pending Zeitnachtrag request is skipped — it is a request
 * without an end, never a running session a clock event may stop.
 */
export function openEntryOf<T extends DayRowShape>(entries: readonly T[]): T | null {
  return entries.find((e) => e.endTime === null && !isPendingRetroRow(e)) ?? null;
}

/**
 * The closed row with the LATEST end time. Ties (two rows ending at the same instant, e.g. a
 * zero-length artifact next to a real row) go to the later start time, then to the larger id, so
 * the choice is deterministic whatever order the list arrives in. `null` when no closed row exists.
 *
 * Issue #70 — the single place of the REOPEN candidate and of the consolidation predecessor
 * (see `openEntryOf`).
 *
 * Issue #92 (D-06): a row of the kind `TRAVEL` is skipped. A re-clock and the clock-salon answer
 * never act on a trip — extending it would turn salon time into travel time (or the reverse) — so
 * the REOPEN candidate, the fixed salon of a finished day and the consolidation predecessor are
 * always a salon row. A trip is anchored between two salon rows (T3), so a salon row always exists
 * on a day that holds one.
 *
 * Issue #657 (D-14): a pending Zeitnachtrag row is NOT skipped like a trip. A trip always has a
 * later salon row, a pending row has none, so "skip and take the next" would let a re-open of an
 * earlier row run over the requested interval. Pending rows therefore take part in the comparison
 * and, when the latest-ending one is pending, the answer is `null`; an open pending row (its
 * interval runs to the end of its day, after every closed row) also gives `null`. With no
 * candidate the clock starts a NEW entry, whose instant the START overlap check judges.
 */
export function latestEndingClosed<T extends DayRowShape>(entries: readonly T[]): T | null {
  if (entries.some((e) => e.endTime === null && isPendingRetroRow(e))) return null;
  let best: T | null = null;
  for (const e of entries) {
    if (e.endTime === null) continue;
    if (e.activityKind === "TRAVEL") continue;
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
  return best !== null && isPendingRetroRow(best) ? null : best;
}

/**
 * Issue #70 (Phase 70b-04, D-04): the working minutes the employee already has on `date` in OTHER
 * entries — the closed WORK rows of the day (the very row set `checkArbZG` evaluates), folded with
 * `addWorkingMinutes`, the one working-time formula of #79 — excluding `excludeEntryId` (the entry a
 * PUT or an approval is about to rewrite, so it is never counted against itself). Rounded to whole
 * minutes and never negative, like the JArbSchG plan values it is added to.
 *
 * § 9 Abs. 1 Nr. 2 JArbSchG is a DAY rule: the minor-protection pre-checks add this value to the
 * planned minutes of the entry being written (`checkJArbSchG` itself stays untouched). With no other
 * entry the result is 0, so a single-entry day keeps the value it always had.
 */
export async function otherWorkingMinutesOfDay(
  db: DayEntriesDb,
  params: { tenantId: string; employeeId: string; date: Date; excludeEntryId?: string },
): Promise<number> {
  const rows = await findEntriesOfDay(db, params);
  let sum = 0;
  for (const row of rows) {
    if (row.id === params.excludeEntryId) continue;
    if (row.endTime === null || row.type !== "WORK") continue;
    sum = addWorkingMinutes(sum, row);
  }
  return Math.max(0, Math.round(sum));
}
