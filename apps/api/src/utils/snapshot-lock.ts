/**
 * Phase 99 (D-08/D-09) — the "is this month closed?" primitive, rescued into shared
 * code before its original home (`scripts/recalculate-snapshots-after-soll-fix.ts`,
 * a frozen v1.8.4 migration artifact) is deleted in Plan 05.
 *
 * Ported verbatim (semantics unchanged) from
 * `apps/api/scripts/recalculate-snapshots-after-soll-fix.ts:133-148`.
 *
 * `SaldoSnapshot` has no `isLocked` column of its own, so "locked" is not a column
 * read — it is derived: at least one non-deleted `TimeEntry` in the snapshot's period
 * has `isLocked: true` (set by Monatsabschluss, see CLAUDE.md "Immutability after
 * lock"). That is the canonical signal used tenant-wide for "this month is closed".
 *
 * Known, deliberately-recorded limitation: a closed month that contains ZERO time
 * entries at all does not register as locked by this predicate (there is nothing to
 * find `isLocked: true` on). This is recorded honestly rather than worked around —
 * inventing a second definition of "locked" here (e.g. a snapshot-level flag) would
 * be exactly the kind of divergence Phase 98 spent a phase eliminating.
 */
export type TimeEntryLockReader = {
  timeEntry: {
    count(args: { where: Record<string, unknown> }): Promise<number>;
  };
};

export async function isSnapshotLocked(
  prisma: TimeEntryLockReader,
  employeeId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<boolean> {
  const lockedCount = await prisma.timeEntry.count({
    where: {
      employeeId,
      deletedAt: null,
      date: { gte: periodStart, lte: periodEnd },
      isLocked: true,
    },
  });
  return lockedCount > 0;
}
