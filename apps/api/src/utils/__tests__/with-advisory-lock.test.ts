/**
 * Unit tests for the advisory-lock helper (OPS-V1814-03 / F-H7).
 *
 * Covers the three behaviors of withAdvisoryLock with a fully mocked
 * $transaction/$queryRaw — no database required:
 *   - skip path: lock NOT acquired → fn() not called, logger.info logged.
 *   - run path:  lock acquired → fn() called exactly once.
 *   - error path: fn() throws → error propagates (helper does not swallow).
 */
import { vi, describe, it, expect } from "vitest";
import type { PrismaClient } from "@clokr/db";
import { withAdvisoryLock, ADVISORY_LOCK_KEYS, tenantAdvisoryKey } from "../with-advisory-lock";

/**
 * Build a fake PrismaClient whose $transaction invokes its callback with a fake
 * `tx` whose $queryRaw resolves to the configured advisory-lock result.
 */
function makeFakePrisma(acquired: boolean) {
  const queryRaw = vi.fn().mockResolvedValue([{ acquired }]);
  const $transaction = vi.fn(async (cb: (tx: { $queryRaw: typeof queryRaw }) => Promise<void>) => {
    return cb({ $queryRaw: queryRaw });
  });
  return { $transaction, $queryRaw: queryRaw } as unknown as PrismaClient & {
    $queryRaw: typeof queryRaw;
  };
}

describe("withAdvisoryLock", () => {
  it("skip path: does NOT call fn and logs when the lock is not acquired", async () => {
    const prisma = makeFakePrisma(false);
    const fn = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), error: vi.fn() };

    await withAdvisoryLock(prisma, ADVISORY_LOCK_KEYS.AUTO_CLOSE_MONTH, fn, logger);

    expect(fn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).toContain("not acquired");
  });

  it("run path: calls fn exactly once when the lock is acquired", async () => {
    const prisma = makeFakePrisma(true);
    const fn = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), error: vi.fn() };

    await withAdvisoryLock(prisma, ADVISORY_LOCK_KEYS.CARRYOVER_WARNING, fn, logger);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("error path: propagates an error thrown by fn (does not swallow)", async () => {
    const prisma = makeFakePrisma(true);
    const boom = new Error("boom");
    const fn = vi.fn().mockRejectedValue(boom);

    await expect(withAdvisoryLock(prisma, ADVISORY_LOCK_KEYS.DATA_RETENTION, fn)).rejects.toThrow(
      "boom",
    );
  });

  it("passes a 10-minute transaction timeout to $transaction", async () => {
    const prisma = makeFakePrisma(true);
    const fn = vi.fn().mockResolvedValue(undefined);

    await withAdvisoryLock(prisma, ADVISORY_LOCK_KEYS.AUTO_CLOSE_MONTH, fn);

    const txMock = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
    const opts = txMock.mock.calls[0][1] as { timeout: number };
    expect(opts.timeout).toBe(10 * 60 * 1000);
  });

  // 76.28-03 added ATTENDANCE_GAP_EMPLOYEE (1014n) and ATTENDANCE_GAP_MANAGER (1015n),
  // bringing the registry from 13 to 15 distinct keys. Phase 92-05 added
  // ATTENDANCE_BREAK_UNCONFIRMED (1016n), bringing it to 16.
  it("registry exposes 16 distinct keys and tenantAdvisoryKey derives a bigint", () => {
    const values = Object.values(ADVISORY_LOCK_KEYS);
    expect(values).toHaveLength(16);
    expect(new Set(values).size).toBe(16);
    const key = tenantAdvisoryKey("123e4567-e89b-12d3-a456-426614174000");
    expect(typeof key).toBe("bigint");
    // Deterministic + stable across calls.
    expect(tenantAdvisoryKey("123e4567-e89b-12d3-a456-426614174000")).toBe(key);
  });
});
