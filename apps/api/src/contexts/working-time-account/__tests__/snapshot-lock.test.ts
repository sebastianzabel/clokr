/**
 * Phase 99 Plan 03 (D-08/D-09) — DB-free unit proof of isSnapshotLocked(), the
 * ported "is this month closed?" primitive (rescued from
 * scripts/recalculate-snapshots-after-soll-fix.ts before that file is deleted in
 * Plan 05).
 *
 * Pure unit test against a hand-rolled recording stub — no getTestApp(), no
 * database connection, must run in milliseconds.
 *
 * Phase 100B Plan 08 (T3): `isSnapshotLocked` now delegates to the `contexts/time-tracking`
 * facade's `countLockedEntries`, which requires a real `Prisma.TransactionClient` (D-07) rather
 * than the old duck-typed `TimeEntryLockReader`. The stub below is cast to that type instead of
 * relying on structural assignability — it stays DB-free (no Postgres connection, just a mocked
 * `count()`), only the TypeScript escape hatch changed.
 *
 * No PII — no fixture data beyond synthetic ids/dates.
 */
import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@clokr/db";
import { isSnapshotLocked } from "../snapshot-lock";

function makeStub(countResult: number): {
  db: Prisma.TransactionClient;
  count: ReturnType<typeof vi.fn>;
} {
  const count = vi.fn().mockResolvedValue(countResult);
  return {
    db: { timeEntry: { count } } as unknown as Prisma.TransactionClient,
    count,
  };
}

describe("isSnapshotLocked — TimeEntry-derived lock signal (DB-free)", () => {
  const tenantId = "tenant-1";
  const periodStart = new Date("2026-09-01T00:00:00Z");
  const periodEnd = new Date("2026-09-30T23:59:59.999Z");

  it("Test 1: at least one non-deleted TimeEntry with isLocked:true in the period → returns true", async () => {
    const { db } = makeStub(1);

    const result = await isSnapshotLocked(db, "emp-1", tenantId, periodStart, periodEnd);

    expect(result).toBe(true);
  });

  it("Test 2: zero matching entries → returns false", async () => {
    const { db } = makeStub(0);

    const result = await isSnapshotLocked(db, "emp-2", tenantId, periodStart, periodEnd);

    expect(result).toBe(false);
  });

  it("Test 3: the where clause includes deletedAt:null, isLocked:true, the tenant, and the date range — soft-deleted entries never fake a lock", async () => {
    const { db, count } = makeStub(0);

    await isSnapshotLocked(db, "emp-3", tenantId, periodStart, periodEnd);

    expect(count).toHaveBeenCalledWith({
      where: {
        employeeId: "emp-3",
        employee: { tenantId },
        deletedAt: null,
        date: { gte: periodStart, lte: periodEnd },
        isLocked: true,
      },
    });
  });

  it("Test 4 (documented limitation, pinned): a period with NO time entries at all returns false — 'locked' is TimeEntry-derived, not a SaldoSnapshot column", async () => {
    const { db } = makeStub(0);

    const result = await isSnapshotLocked(db, "emp-4", tenantId, periodStart, periodEnd);

    expect(result).toBe(false);
  });
});
