// Phase 76.2 (ARCH-V19-01, sub-req B / TIME-V19-04) — Cross-source same-day consolidation.
// Extracted from time-entries.ts:286-345 (NFC-only handler) and generalized.
//
// Bug fix (TIME-V19-04 #1 / Pitfall 3): the original lookup ordered by endTime desc but did
// NOT filter `endTime <= openEntry.startTime`. Out-of-order writes can pick a wrong predecessor
// and the gapHours > 0 guard returns no-merge instead of merging with the actual predecessor.
// Fix: add `endTime: { lte: openEntry.startTime }` to the lookup.
import type { Prisma, TimeEntry } from "@clokr/db";
import type { FastifyBaseLogger } from "fastify";
import { MIN_MERGE_PREDECESSOR_DURATION_MS } from "./thresholds";
import { findEntriesOfDay, latestEndingClosed } from "../../contexts/time-tracking/day-entries"; // Phase 69b, Issue #70 (selector)
import type { ActivityShareInput } from "../../contexts/time-tracking/activity-minutes"; // Issue #81
import {
  materializeRemainder,
  activitySharesReplace,
} from "../../contexts/time-tracking/activity-shares"; // Issue #81
import { loadSharesOfEntry } from "../../contexts/time-tracking/activity-store"; // Issue #81

export function calcBreakMinutesLocal(breaks: { startTime: Date; endTime: Date }[]): number {
  return breaks.reduce((sum, b) => sum + (b.endTime.getTime() - b.startTime.getTime()) / 60000, 0);
}

export type ConsolidateResult =
  | { merged: false }
  | {
      merged: true;
      targetEntryId: string;
      breakId: string;
      // Issue #81: both sides carry the target's activity shares for the CLOCK_OUT audit.
      before: TimeEntry & { activityShares: ActivityShareInput[] };
      after: TimeEntry & { activityShares: ActivityShareInput[] };
      deletedEntryId: string;
      deletedEntryBefore: TimeEntry;
    };

export async function consolidateSameDayEntries(
  tx: Prisma.TransactionClient,
  tenantId: string,
  openEntry: TimeEntry,
  gapHoursMax: number,
  log: FastifyBaseLogger,
): Promise<ConsolidateResult> {
  if (!openEntry.endTime) {
    log.info({ entryId: openEntry.id, reason: "no_end_time" }, "merge_skipped");
    return { merged: false };
  }

  // Phase 69b (Issue #69): the day is read through findEntriesOfDay; the predecessor rule is
  // applied in memory, unchanged:
  // - TIME-V19-04 bug #1 fix: endTime <= openEntry.startTime, so out-of-order writes cannot select
  //   a later sibling as the predecessor.
  // - Phase 118 (D-08): a row coupled to a Zeitnachtrag (Phase 96, `retroRequestId @unique`) is
  //   off-limits as a predecessor. Merging would either extend it or soft-delete it, breaking the
  //   1:1 coupling to the RetroEntryRequest — the approval flow would then release no entry, or a
  //   corrupted one. `isInvalid` is deliberately NOT filtered here (consistent with D-01: an
  //   invalidated row is a real attendance row).
  // - The latest-ending candidate wins.
  // - Issue #70 (D-03): with several entries per day the predecessor is the closed candidate with
  //   the latest end (`latestEndingClosed`, the one place of that choice), and consolidation never
  //   merges across salons — see the salon guard below — nor across a travel entry (Issue #92,
  //   `travel_row` guard below). An entry that carries a recorded activity
  //   allocation is never merged away (Issue #81).
  const dayEntries = await findEntriesOfDay(tx, {
    tenantId,
    employeeId: openEntry.employeeId,
    date: openEntry.date,
  });
  const previousEntry = latestEndingClosed(
    dayEntries.filter(
      (e) =>
        e.id !== openEntry.id &&
        e.endTime !== null &&
        e.retroRequestId === null &&
        e.endTime <= openEntry.startTime,
    ),
  );

  if (!previousEntry || !previousEntry.endTime) {
    log.info(
      { employeeId: openEntry.employeeId, date: openEntry.date, reason: "no_predecessor" },
      "merge_skipped",
    );
    return { merged: false };
  }

  // Issue #92 (D-06): never merge into or across a trip. The selector above skips TRAVEL rows, so
  // when a trip lies between the chosen predecessor and the row just closed, extending the
  // predecessor over the successor would cover the trip — the database refuses that overlap and the
  // clock-out would fail. The rows stay as they are, the clock-out itself is kept. A trip is anchored
  // between two salon rows of different salons, so the salon guard below would end an ordinary
  // merge anyway; this guard is checked BEFORE it so the reason is the trip, and it still holds for
  // data that bypassed `validateTravelEntry` (same salon on both sides of the trip).
  const tripBetween = dayEntries.some(
    (e) =>
      e.activityKind === "TRAVEL" &&
      e.endTime !== null &&
      e.endTime > previousEntry.endTime! &&
      e.endTime <= openEntry.startTime,
  );
  if (tripBetween) {
    log.info(
      {
        employeeId: openEntry.employeeId,
        date: openEntry.date,
        previousEntryId: previousEntry.id,
        openEntryId: openEntry.id,
        reason: "travel_row",
      },
      "merge_skipped",
    );
    return { merged: false };
  }

  // Issue #70 (D-03): a merge extends the predecessor over the successor's time and soft-deletes the
  // successor, so the merged time would be booked to the PREDECESSOR's salon. When the two rows
  // belong to different salons that would book salon-B time to salon A (holiday basis § 2 EFZG,
  // salon views, activity evaluation) — the rows stay as they are, the clock-out itself is kept.
  if (previousEntry.salonId !== openEntry.salonId) {
    log.info(
      {
        employeeId: openEntry.employeeId,
        date: openEntry.date,
        previousEntryId: previousEntry.id,
        openEntryId: openEntry.id,
        reason: "different_salon",
      },
      "merge_skipped",
    );
    return { merged: false };
  }

  // WR-01: reject zero/sub-minute artifacts as predecessor. An NFC double-tap can produce a
  // startTime == endTime row that pre-dates the real entry. Once the real entry is reopened
  // (endTime → null), only the artifact has a closed endTime ≤ real entry's startTime, making
  // it the sole predecessor candidate. Extending the artifact would carry the wrong startTime
  // into the canonical record — a Revisionssicherheit violation. Prefer no-merge over that.
  const prevDurationMs = previousEntry.endTime.getTime() - previousEntry.startTime.getTime();
  if (prevDurationMs < MIN_MERGE_PREDECESSOR_DURATION_MS) {
    log.warn(
      { previousEntryId: previousEntry.id, prevDurationMs, reason: "artifact_sub_minute" },
      "merge_skipped_artifact",
    );
    return { merged: false };
  }

  const gapMs = openEntry.startTime.getTime() - previousEntry.endTime.getTime();
  const gapHours = gapMs / 3600000;

  log.info(
    {
      employeeId: openEntry.employeeId,
      date: openEntry.date,
      gap_hours: gapHours,
      gap_hours_max: gapHoursMax,
      previousEntryId: previousEntry.id,
      openEntryId: openEntry.id,
    },
    "merge_attempted",
  );

  if (gapHours <= 0 || gapHours > gapHoursMax) {
    log.info(
      {
        employeeId: openEntry.employeeId,
        date: openEntry.date,
        gap_hours: gapHours,
        gap_hours_max: gapHoursMax,
        reason: gapHours <= 0 ? "negative_gap" : "gap_exceeded",
      },
      "merge_skipped",
    );
    return { merged: false };
  }

  // Issue #81 (D-07): decided before any write. Soft-deleting an entry that carries a recorded
  // allocation would drop it from every evaluation, so the merge is skipped; the clock-out itself
  // has already been written, only the merge does not happen.
  const openShares = await loadSharesOfEntry(tx, tenantId, openEntry.id);
  if (openEntry.activityKind !== "UNSPECIFIED" || openShares.length > 0) {
    log.info(
      {
        employeeId: openEntry.employeeId,
        date: openEntry.date,
        previousEntryId: previousEntry.id,
        openEntryId: openEntry.id,
        reason: "activity_allocated",
      },
      "merge_skipped",
    );
    return { merged: false };
  }
  // Issue #81 (D-07): the target's classified remainder (values before the extension) becomes an
  // explicit share, so the merged-in time is never attributed to a kind nobody chose.
  const targetShares = await loadSharesOfEntry(tx, tenantId, previousEntry.id);
  const materialized = materializeRemainder({
    kind: previousEntry.activityKind,
    shares: targetShares,
    startTime: previousEntry.startTime,
    endTime: previousEntry.endTime,
    breakMinutes: previousEntry.breakMinutes,
  });

  try {
    // Issue #70: the database refuses an overlap of two non-deleted closed entries after EVERY
    // statement (exclusion constraint `TimeEntry_no_overlap_closed`, not deferrable). Extending the
    // predecessor over the successor's interval while the successor is still live would overlap it,
    // so the successor is soft-deleted FIRST (CLAUDE.md audit-proof: NEVER hard-delete) and only
    // then is the predecessor extended into the freed interval. The Break row of the gap lies
    // inside the predecessor's extended range and never touches another entry.
    // 1. Soft-delete the just-closed short entry
    await tx.timeEntry.update({
      where: { id: openEntry.id },
      data: { deletedAt: new Date() },
    });

    // 2. Create Break row for the gap
    const breakRow = await tx.break.create({
      data: {
        timeEntryId: previousEntry.id,
        startTime: previousEntry.endTime,
        endTime: openEntry.startTime,
      },
    });

    // 3. Recompute total breakMinutes from Break rows (single source of truth)
    const allBreaks = await tx.break.findMany({
      where: { timeEntryId: previousEntry.id },
    });
    const totalBreakMins = Math.round(calcBreakMinutesLocal(allBreaks));

    // 4. Extend previous entry's endTime to current entry's endTime
    const after = await tx.timeEntry.update({
      where: { id: previousEntry.id },
      data: {
        endTime: openEntry.endTime,
        breakMinutes: totalBreakMins,
        ...(materialized && {
          activityKind: materialized.kind,
          activityShares: activitySharesReplace(materialized.shares),
        }),
      },
      include: {
        activityShares: { select: { kind: true, minutes: true }, orderBy: { kind: "asc" } },
      },
    });

    return {
      merged: true,
      targetEntryId: previousEntry.id,
      breakId: breakRow.id,
      before: { ...previousEntry, activityShares: targetShares },
      after,
      deletedEntryId: openEntry.id,
      deletedEntryBefore: openEntry,
    };
  } catch (err) {
    log.error(
      { err, previousEntryId: previousEntry.id, openEntryId: openEntry.id },
      "merge_failed",
    );
    throw err;
  }
}
