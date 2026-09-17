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
 *
 * Phase 100B Plan 08 (T3): the `TimeEntry.count` this predicate reads is a foreign access from
 * `working-time-account` into Zeiterfassung's own model — it now goes through
 * `contexts/time-tracking`'s `countLockedEntries(db, employeeId, tenantId, from, to)` facade
 * function instead of a direct `prisma.timeEntry.count`. `tenantId` is a NEW required parameter
 * (D-10/G4): both of this function's 2 callers already have it in scope before calling
 * (`shift-leave-recalc-resolver.ts`'s own `tenantId` parameter; `recalculate-snapshots.ts`'s
 * `employee.tenantId`, fetched immediately before). The generic `TimeEntryLockReader` duck type
 * is gone — `countLockedEntries` requires a real `Prisma.TransactionClient` (D-07), so
 * `__tests__/snapshot-lock.test.ts`'s DB-free mock now casts its stub reader to that type instead
 * of relying on structural typing; it stays DB-free (no real Postgres connection), only the
 * TypeScript escape hatch changed.
 */
import type { Prisma } from "@clokr/db";
import { countLockedEntries } from "../time-tracking"; // Phase 100B Plan 08 — T3

export async function isSnapshotLocked(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<boolean> {
  const lockedCount = await countLockedEntries(db, employeeId, tenantId, periodStart, periodEnd);
  return lockedCount > 0;
}
