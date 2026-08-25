/**
 * Phase 99 Plan 03 (D-08/D-09) — DB-free unit proof of isSnapshotLocked(), the
 * ported "is this month closed?" primitive (rescued from
 * scripts/recalculate-snapshots-after-soll-fix.ts before that file is deleted in
 * Plan 05).
 *
 * Pure unit test against a hand-rolled recording stub reader — no getTestApp(), no
 * database connection, must run in milliseconds.
 *
 * No PII — no fixture data beyond synthetic ids/dates.
 */
import { describe, it, expect, vi } from "vitest";
import { isSnapshotLocked, type TimeEntryLockReader } from "../snapshot-lock";

function makeStub(countResult: number): {
  reader: TimeEntryLockReader;
  count: ReturnType<typeof vi.fn>;
} {
  const count = vi.fn().mockResolvedValue(countResult);
  return {
    reader: { timeEntry: { count } },
    count,
  };
}

describe("isSnapshotLocked — TimeEntry-derived lock signal (DB-free)", () => {
  const periodStart = new Date("2026-09-01T00:00:00Z");
  const periodEnd = new Date("2026-09-30T23:59:59.999Z");

  it("Test 1: at least one non-deleted TimeEntry with isLocked:true in the period → returns true", async () => {
    const { reader } = makeStub(1);

    const result = await isSnapshotLocked(reader, "emp-1", periodStart, periodEnd);

    expect(result).toBe(true);
  });

  it("Test 2: zero matching entries → returns false", async () => {
    const { reader } = makeStub(0);

    const result = await isSnapshotLocked(reader, "emp-2", periodStart, periodEnd);

    expect(result).toBe(false);
  });

  it("Test 3: the where clause includes deletedAt:null, isLocked:true and the date range — soft-deleted entries never fake a lock", async () => {
    const { reader, count } = makeStub(0);

    await isSnapshotLocked(reader, "emp-3", periodStart, periodEnd);

    expect(count).toHaveBeenCalledWith({
      where: {
        employeeId: "emp-3",
        deletedAt: null,
        date: { gte: periodStart, lte: periodEnd },
        isLocked: true,
      },
    });
  });

  it("Test 4 (documented limitation, pinned): a period with NO time entries at all returns false — 'locked' is TimeEntry-derived, not a SaldoSnapshot column", async () => {
    const { reader } = makeStub(0);

    const result = await isSnapshotLocked(reader, "emp-4", periodStart, periodEnd);

    expect(result).toBe(false);
  });
});
