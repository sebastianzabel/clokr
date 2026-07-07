// Phase 76.2 (ARCH-V19-01, sub-req B / TIME-V19-04) — Cross-source same-day consolidation.
// Extracted from time-entries.ts:286-345 (NFC-only handler) and generalized.
//
// Bug fix (TIME-V19-04 #1 / Pitfall 3): the original lookup ordered by endTime desc but did
// NOT filter `endTime <= openEntry.startTime`. Out-of-order writes can pick a wrong predecessor
// and the gapHours > 0 guard returns no-merge instead of merging with the actual predecessor.
// Fix: add `endTime: { lte: openEntry.startTime }` to the lookup.
import type { Prisma, TimeEntry } from "@clokr/db";
import type { FastifyBaseLogger } from "fastify";

export function calcBreakMinutesLocal(breaks: { startTime: Date; endTime: Date }[]): number {
  return breaks.reduce((sum, b) => sum + (b.endTime.getTime() - b.startTime.getTime()) / 60000, 0);
}

export type ConsolidateResult =
  | { merged: false }
  | {
      merged: true;
      targetEntryId: string;
      breakId: string;
      before: TimeEntry;
      after: TimeEntry;
      deletedEntryId: string;
      deletedEntryBefore: TimeEntry;
    };

export async function consolidateSameDayEntries(
  tx: Prisma.TransactionClient,
  openEntry: TimeEntry,
  gapHoursMax: number,
  log: FastifyBaseLogger,
): Promise<ConsolidateResult> {
  if (!openEntry.endTime) {
    log.info({ entryId: openEntry.id, reason: "no_end_time" }, "merge_skipped");
    return { merged: false };
  }

  // TIME-V19-04 bug #1 fix: filter endTime <= openEntry.startTime to prevent
  // out-of-order writes from selecting a later sibling as the predecessor.
  const previousEntry = await tx.timeEntry.findFirst({
    where: {
      employeeId: openEntry.employeeId,
      deletedAt: null,
      date: openEntry.date,
      id: { not: openEntry.id },
      endTime: { not: null, lte: openEntry.startTime },
    },
    orderBy: { endTime: "desc" },
  });

  if (!previousEntry || !previousEntry.endTime) {
    log.info(
      { employeeId: openEntry.employeeId, date: openEntry.date, reason: "no_predecessor" },
      "merge_skipped",
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

  try {
    // 1. Create Break row for the gap
    const breakRow = await tx.break.create({
      data: {
        timeEntryId: previousEntry.id,
        startTime: previousEntry.endTime,
        endTime: openEntry.startTime,
      },
    });

    // 2. Recompute total breakMinutes from Break rows (single source of truth)
    const allBreaks = await tx.break.findMany({
      where: { timeEntryId: previousEntry.id },
    });
    const totalBreakMins = Math.round(calcBreakMinutesLocal(allBreaks));

    // 3. Extend previous entry's endTime to current entry's endTime
    const after = await tx.timeEntry.update({
      where: { id: previousEntry.id },
      data: {
        endTime: openEntry.endTime,
        breakMinutes: totalBreakMins,
      },
    });

    // 4. Soft-delete the just-closed short entry (CLAUDE.md audit-proof: NEVER hard-delete)
    await tx.timeEntry.update({
      where: { id: openEntry.id },
      data: { deletedAt: new Date() },
    });

    return {
      merged: true,
      targetEntryId: previousEntry.id,
      breakId: breakRow.id,
      before: previousEntry,
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
