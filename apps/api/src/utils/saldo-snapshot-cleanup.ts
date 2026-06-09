/**
 * TZ-duplicate SaldoSnapshot cleanup — Phase 76.6.
 *
 * One-off data-hygiene function. Identifies (employeeId, periodType, calendar-month-of-periodStart)
 * groups containing 2+ rows whose periodStart values differ by exactly the tenant TZ offset,
 * picks the tenant-TZ-anchored row as canonical (the one matching monthRangeUtc(year, month, tz).start),
 * and marks the other(s) `superseded: true` with an AuditLog trail.
 *
 * NEVER hard-deletes rows (Revisionssicherheit per CLAUDE.md).
 *
 * Origin: May 2026 pre-tracking-reset script created snapshots with
 *   `new Date("YYYY-MM-01")` (UTC midnight) instead of tenant-TZ-anchored UTC.
 *   For Europe/Berlin (UTC+2 summer), this is off by ~22h → the snapshot is
 *   stored on the PREVIOUS calendar day, breaking findFirst(orderBy: periodStart desc).
 *
 * Idempotent: re-runs skip groups where every row already has `superseded: true`
 *   OR the group has only one row.
 */
import type { PrismaClient } from "@clokr/db";
import { getTenantTimezone, monthRangeUtc } from "./timezone";

/**
 * UTC YYYY-MM-DD slice of a Date. Used to compare against @db.Date values, which
 * Postgres stores without a timezone and Prisma round-trips as JS Date at UTC
 * midnight. NEVER use dateStrInTz() against @db.Date values — the round-trip
 * strips the original UTC offset and the tenant-TZ string can shift by a day.
 */
function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * UTC YYYY-MM slice of a Date — for bucketing snapshots by stored calendar month.
 */
function utcMonthStr(d: Date): string {
  return d.toISOString().slice(0, 7);
}

export const SUPERSEDED_REASON = "TZ-duplicate cleanup — 2026-06-08 prod investigation";

export type CleanupOptions = {
  /** Required: AuditLog `userId` for every UPDATE row written. */
  actorId: string;
  /** Optional: scope to a single tenant. Default = all tenants. */
  tenantId?: string;
  /** If true, no writes are performed — only the report is returned. */
  dryRun: boolean;
};

export type DuplicateGroup = {
  employeeId: string;
  tenantId: string;
  tenantTz: string;
  periodType: "MONTHLY" | "YEARLY";
  year: number;
  month: number; // 1-based
  canonicalRowId: string;
  canonicalPeriodStart: Date;
  supersededRowIds: string[];
  supersededPeriodStarts: Date[];
};

export type CleanupReport = {
  scannedRowCount: number;
  groupsExamined: number;
  duplicateGroups: DuplicateGroup[];
  /** Total rows that were (or would be) marked superseded. */
  supersededRowCount: number;
  /** Total AuditLog rows that were (or would be) written. */
  auditLogRowCount: number;
  applied: boolean;
};

export type CleanupLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

/**
 * Run the cleanup.
 *
 * Algorithm (D-04):
 *   1. Load all non-superseded SaldoSnapshot rows (optionally tenant-scoped).
 *   2. Group by (employeeId, periodType, calendar-month-of-periodStart in tenant TZ).
 *   3. For each group with 2+ rows: pick canonical = the row whose periodStart === monthRangeUtc(year, month, tz).start.
 *      If no row matches the canonical UTC value (unexpected — log a warning and SKIP the group; do NOT pick arbitrarily).
 *   4. Mark non-canonical rows superseded=true inside a $transaction. AuditLog row written BEFORE the UPDATE in the same tx.
 */
export async function cleanupTzDuplicateSnapshots(
  prisma: PrismaClient,
  opts: CleanupOptions,
  log: CleanupLogger = console,
): Promise<CleanupReport> {
  // 1. Load non-superseded snapshots (tenant-scoped if requested).
  const snapshots = await prisma.saldoSnapshot.findMany({
    where: {
      superseded: false,
      ...(opts.tenantId ? { employee: { tenantId: opts.tenantId } } : {}),
    },
    include: {
      employee: { select: { tenantId: true } },
    },
    orderBy: [{ employeeId: "asc" }, { periodType: "asc" }, { periodStart: "asc" }],
  });

  const tzCache = new Map<string, string>();
  const getTz = async (tenantId: string): Promise<string> => {
    const cached = tzCache.get(tenantId);
    if (cached) return cached;
    const tz = await getTenantTimezone(prisma, tenantId);
    tzCache.set(tenantId, tz);
    return tz;
  };

  // 2. Group by (employeeId, periodType, UTC-calendar-month-of-periodEnd).
  //    periodEnd is the last day of the target month — its UTC calendar month
  //    is stable regardless of how periodStart was anchored (the bug variant we
  //    are cleaning up only shifts periodStart by ~22h, periodEnd stays in the
  //    same UTC month for any positive-offset TZ).
  type Key = string;
  const groups = new Map<Key, typeof snapshots>();
  for (const snap of snapshots) {
    const ym = utcMonthStr(snap.periodEnd); // "YYYY-MM" of stored periodEnd
    const key = `${snap.employeeId}::${snap.periodType}::${ym}`;
    const arr = groups.get(key) ?? [];
    arr.push(snap);
    groups.set(key, arr);
  }

  // 3. Identify duplicates + canonical row per group.
  const duplicateGroups: DuplicateGroup[] = [];
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    const [employeeId, periodType] = key.split("::");
    const tenantId = rows[0].employee.tenantId;
    const tz = await getTz(tenantId);

    // Derive (year, month) from the bucket's UTC month — periodEnd is the last
    // day of the target month, so this maps 1:1 to the tenant-TZ target month.
    const ym = utcMonthStr(rows[0].periodEnd);
    const [yearStr, monthStr] = ym.split("-");
    const year = Number(yearStr);
    const month = Number(monthStr);

    // Canonical row = the one whose periodStart matches the UTC date you get
    // when monthRangeUtc(year, month, tz).start is stored as @db.Date (which
    // Postgres truncates to the UTC calendar date, ignoring the 22:00 offset).
    const canonicalAnchorIso = monthRangeUtc(year, month, tz).start.toISOString();
    const canonicalUtcDateStr = canonicalAnchorIso.slice(0, 10);
    const canonicalRow = rows.find((r) => utcDateStr(r.periodStart) === canonicalUtcDateStr);

    if (!canonicalRow) {
      log.warn(
        `[saldo-snapshot-cleanup] Group ${key} has ${rows.length} rows but none match canonical ` +
          `UTC date ${canonicalUtcDateStr} (from monthRangeUtc(${year}, ${month}, ${tz}).start=` +
          `${canonicalAnchorIso}). Skipping group (manual review required).`,
      );
      continue;
    }

    const superseded = rows.filter((r) => r.id !== canonicalRow.id);
    duplicateGroups.push({
      employeeId,
      tenantId,
      tenantTz: tz,
      periodType: periodType as "MONTHLY" | "YEARLY",
      year,
      month,
      canonicalRowId: canonicalRow.id,
      canonicalPeriodStart: canonicalRow.periodStart,
      supersededRowIds: superseded.map((r) => r.id),
      supersededPeriodStarts: superseded.map((r) => r.periodStart),
    });
  }

  const supersededRowCount = duplicateGroups.reduce((sum, g) => sum + g.supersededRowIds.length, 0);

  log.info(
    `[saldo-snapshot-cleanup] scanned=${snapshots.length} groups=${groups.size} ` +
      `duplicates=${duplicateGroups.length} rows_to_supersede=${supersededRowCount} ` +
      `dry_run=${opts.dryRun}`,
  );

  if (opts.dryRun) {
    return {
      scannedRowCount: snapshots.length,
      groupsExamined: groups.size,
      duplicateGroups,
      supersededRowCount,
      auditLogRowCount: 0,
      applied: false,
    };
  }

  // 4. Apply — per-tenant transactions to keep tx scope bounded (T-76.6-03 DoS mitigation).
  let auditLogRowCount = 0;
  const groupsByTenant = new Map<string, DuplicateGroup[]>();
  for (const g of duplicateGroups) {
    const arr = groupsByTenant.get(g.tenantId) ?? [];
    arr.push(g);
    groupsByTenant.set(g.tenantId, arr);
  }

  for (const [, tenantGroups] of groupsByTenant) {
    await prisma.$transaction(async (tx) => {
      for (const g of tenantGroups) {
        for (const supersededId of g.supersededRowIds) {
          // Load full pre-state for AuditLog.oldValue (D-06 requires "full pre-update row JSON").
          const pre = await tx.saldoSnapshot.findUniqueOrThrow({
            where: { id: supersededId },
          });

          // AuditLog FIRST (audit-proof rule: never write the mutation before the audit trail).
          await tx.auditLog.create({
            data: {
              userId: opts.actorId,
              action: "UPDATE",
              entity: "SaldoSnapshot",
              entityId: supersededId,
              oldValue: {
                id: pre.id,
                employeeId: pre.employeeId,
                periodType: pre.periodType,
                periodStart: pre.periodStart.toISOString(),
                periodEnd: pre.periodEnd.toISOString(),
                workedMinutes: pre.workedMinutes,
                expectedMinutes: pre.expectedMinutes,
                balanceMinutes: pre.balanceMinutes,
                carryOver: pre.carryOver,
                closedAt: pre.closedAt.toISOString(),
                closedBy: pre.closedBy,
                note: pre.note,
                superseded: pre.superseded,
                supersededReason: pre.supersededReason,
              },
              newValue: {
                superseded: true,
                supersededReason: SUPERSEDED_REASON,
              },
              ipAddress: null,
              userAgent: "tsx apps/api/scripts/cleanup-tz-duplicate-snapshots.ts",
            },
          });
          auditLogRowCount++;

          await tx.saldoSnapshot.update({
            where: { id: supersededId },
            data: {
              superseded: true,
              supersededReason: SUPERSEDED_REASON,
            },
          });

          log.info(
            `[saldo-snapshot-cleanup] superseded id=${supersededId} ` +
              `employee=${g.employeeId} period=${g.year}-${String(g.month).padStart(2, "0")} ` +
              `canonical_id=${g.canonicalRowId}`,
          );
        }
      }
    });
  }

  return {
    scannedRowCount: snapshots.length,
    groupsExamined: groups.size,
    duplicateGroups,
    supersededRowCount,
    auditLogRowCount,
    applied: true,
  };
}
