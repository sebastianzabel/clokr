import type { PrismaClient } from "@clokr/db";
import type { FastifyBaseLogger } from "fastify";

/**
 * Distributed-cron leader-election helper (OPS-V1814-03 / F-H7).
 *
 * Every API replica runs the same node-cron schedule. Without coordination, two
 * replicas would both execute a job window (double Monatsabschluss snapshots,
 * duplicate notifications, double retention purges). This helper elects a single
 * leader per job window using a PostgreSQL advisory lock.
 *
 * WHY `pg_try_advisory_xact_lock` (transaction-scoped) and NOT the session-level
 * `pg_try_advisory_lock` + `pg_advisory_unlock` pair:
 *   The Prisma client runs over a POOLED pg connection (PrismaPg adapter). A
 *   session-level unlock issued later could be routed to a DIFFERENT pooled
 *   connection than the one that acquired the lock, silently failing to release
 *   it and leaking the lock for the lifetime of the pool. The transaction-scoped
 *   variant auto-releases on transaction COMMIT/ROLLBACK — no manual unlock, no
 *   leak, pool-safe.
 *
 * WHY the 10-minute transaction timeout:
 *   Prisma's default interactive-transaction timeout is 5s. `auto-close-month`
 *   runs for minutes (per-tenant, per-employee snapshot work), which would throw
 *   `P2028 Transaction already closed`. The transaction here only exists to PIN
 *   the lock connection for the duration of `fn()`; `fn()` itself uses the OUTER
 *   `prisma` (not `tx`), so its own queries are not part of this transaction and
 *   are not rolled back if the lock connection is torn down.
 */

/**
 * Stable advisory-lock keys, one per cron family. Distinct integers so unrelated
 * jobs never contend for the same lock. Range 1001-1012 (see also
 * {@link tenantAdvisoryKey} for per-tenant derived keys).
 */
export const ADVISORY_LOCK_KEYS = {
  AUTO_CLOSE_MONTH: 1001n,
  CARRYOVER_WARNING: 1002n,
  ATTENDANCE_CLOCK_OUT: 1003n,
  ATTENDANCE_AUTO_INVALIDATE: 1004n,
  ATTENDANCE_MISSING: 1005n,
  ATTENDANCE_PENDING_LEAVE: 1006n,
  ATTENDANCE_UPCOMING: 1007n,
  ATTENDANCE_EXPIRY: 1008n,
  DATA_RETENTION: 1009n,
  DATA_RETENTION_PURGE: 1010n,
  SCHOOL_HOLIDAYS_SYNC: 1011n,
  VOCATIONAL_SCHOOL_GEN: 1012n,
  TOKEN_CLEANUP: 1013n,
} as const;

/**
 * Derive a per-tenant advisory-lock key for tasks scheduled once PER TENANT
 * (scheduler.ts Phorest sync registers one cron task per tenant, so each tenant's
 * sync must be independently leader-locked).
 *
 * Takes the first 15 hex chars (60 bits) of the tenant UUID → fits int8 (63-bit
 * signed). Collision risk across tenants is negligible (60-bit space) and a
 * collision would at worst serialize two unrelated tenants' syncs, never corrupt.
 */
export function tenantAdvisoryKey(tenantId: string): bigint {
  return BigInt("0x" + tenantId.replace(/-/g, "").slice(0, 15));
}

/**
 * Run `fn` only if this replica wins the advisory lock `lockKey`. If the lock is
 * already held by another replica (or another in-process tick), `fn` is skipped
 * and a message is logged. The lock auto-releases when the wrapping transaction
 * ends.
 *
 * @param prisma  The pooled Prisma client (`app.prisma`).
 * @param lockKey Stable integer key from {@link ADVISORY_LOCK_KEYS} or {@link tenantAdvisoryKey}.
 * @param fn      The cron body to run under the lock. Uses the OUTER `prisma`.
 * @param logger  Optional logger for the skip message.
 */
export async function withAdvisoryLock(
  prisma: PrismaClient,
  lockKey: bigint,
  fn: () => Promise<void>,
  logger?: Pick<FastifyBaseLogger, "info" | "error">,
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${lockKey}::bigint) AS acquired
      `;
      const acquired = rows[0]?.acquired === true;
      if (!acquired) {
        logger?.info(`Advisory lock ${lockKey}: not acquired — skipping run`);
        return;
      }
      // fn() runs on the OUTER prisma; the transaction only pins the lock connection.
      await fn();
    },
    { timeout: 10 * 60 * 1000 },
  );
}
