/**
 * TZ-duplicate SaldoSnapshot cleanup — Phase 76.6 / hardened Phase 76.25.
 *
 * One-off data-hygiene function. Identifies (employeeId, periodType, calendar-month-of-periodEnd)
 * groups containing 2+ rows whose periodStart values differ by exactly the tenant TZ offset,
 * picks the tenant-TZ-anchored row as canonical (the one matching monthRangeUtc(year, month, tz).start),
 * and marks the other(s) `superseded: true` with an AuditLog trail.
 *
 * Phase 76.25 hardening: before the anchor-based canonical selection, detects opening-balance /
 * reset bridge rows via the shape heuristic (expectedMinutes==0 && workedMinutes==0 &&
 * balanceMinutes==0 && carryOver!=0). When exactly one bridge is present in a group, the bridge
 * is retained as canonical (preserving its opening carryOver) and the spurious auto-close rows are
 * superseded. Ambiguous groups (>1 bridge candidate) are skipped with a warning. No-bridge groups
 * keep the existing anchor-based selection byte-identical.
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

/**
 * Returns true if this SaldoSnapshot is an opening-balance / reset bridge row.
 *
 * Heuristic: a bridge has all three work/expected/balance fields zero but a
 * non-zero carryOver — it was set by a human operator as a carry-in value for a
 * previously-untracked period and MUST NOT be superseded by the cleanup.
 *
 * No explicit bridge/reset/opening marker column exists on SaldoSnapshot (Phase 76.25 D-02).
 * This shape heuristic is the authoritative signal, aligned with the same heuristic in
 * apps/api/scripts/recalculate-snapshots-after-shift-soll-fix.ts (Phase 76.22 D-08).
 *
 * Limitation: a legitimate "no activity, zero carry" month satisfies carryOver==0
 * and is correctly excluded. A bridge with non-zero activity cannot be detected by
 * shape alone — an explicit schema column would be needed for that case (out of scope).
 *
 * Exported (2026-08 hardening, prod incident): recalculate-snapshots.ts's retroactive
 * recalc loop also needs this predicate — it must skip bridge rows the same way
 * auto-close-month.ts's SNAP-04 idempotency check does. This is the single source of
 * truth; do not fork/copy the shape check elsewhere.
 */
export function isBridgeSnapshot(snap: {
  expectedMinutes: number;
  workedMinutes: number;
  balanceMinutes: number;
  carryOver: number;
}): boolean {
  return (
    snap.expectedMinutes === 0 &&
    snap.workedMinutes === 0 &&
    snap.balanceMinutes === 0 &&
    snap.carryOver !== 0
  );
}

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
  /**
   * Number of groups where a single bridge row was retained as canonical
   * (Phase 76.25 hardening). Counts classification, not writes — populated
   * in both dry-run and applied returns.
   */
  bridgePreservedGroups: number;
  applied: boolean;
};

export type CleanupLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

/**
 * Run the cleanup.
 *
 * Algorithm:
 *   1. Load all non-superseded SaldoSnapshot rows (optionally tenant-scoped).
 *   2. Group by (employeeId, periodType, UTC-calendar-month-of-periodEnd).
 *      periodEnd is used because the TZ bug only shifts periodStart by ~22h;
 *      periodEnd stays in the correct UTC calendar month for positive-offset TZs.
 *   3a. Phase 76.25 (D-01/D-03): For each group, scan for bridge rows
 *       (expectedMinutes==0 && workedMinutes==0 && balanceMinutes==0 && carryOver!=0).
 *       - Exactly one bridge → bridge is canonical; all other rows superseded (D-01).
 *       - More than one bridge → skip group (warn, nothing superseded) (D-03).
 *   3b. No bridge rows (D-04) → anchor-based selection: canonical = the row whose
 *       periodStart matches monthRangeUtc(year, month, tz).start.
 *       If no row matches the canonical UTC value (unexpected — log a warning and SKIP
 *       the group; do NOT pick arbitrarily).
 *   4. Mark non-canonical rows superseded=true inside a $transaction. AuditLog row
 *      written BEFORE the UPDATE in the same tx.
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
  let bridgePreservedGroups = 0;
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

    // ── Phase 76.25: Bridge-preferred canonical selection ─────────────────────
    // Before the anchor-based find, detect opening-balance / reset bridge rows.
    // A bridge: expectedMinutes==0 && workedMinutes==0 && balanceMinutes==0 && carryOver!=0.
    // This shape is the authoritative signal (no explicit schema marker — D-02).
    const bridges = rows.filter(isBridgeSnapshot);

    if (bridges.length > 1) {
      // D-03: Ambiguous — more than one bridge candidate. Refuse + flag.
      // Mirror the existing no-anchor-match skip posture: warn + continue, supersede nothing.
      log.warn(
        `[saldo-snapshot-cleanup] Group ${key} has ${rows.length} rows and ${bridges.length} ` +
          `bridge candidates — multiple bridge candidates, manual review required (nothing superseded).`,
      );
      continue;
    }

    if (bridges.length === 1) {
      // D-01: Exactly one bridge. Retain the bridge as canonical; supersede all other rows.
      // The bridge's carryOver (opening carry-in) is preserved — the spurious auto-close
      // row(s) are superseded regardless of the TZ anchor.
      const bridgeRow = bridges[0];
      const superseded = rows.filter((r) => r.id !== bridgeRow.id);
      duplicateGroups.push({
        employeeId,
        tenantId,
        tenantTz: tz,
        periodType: periodType as "MONTHLY" | "YEARLY",
        year,
        month,
        canonicalRowId: bridgeRow.id,
        canonicalPeriodStart: bridgeRow.periodStart,
        supersededRowIds: superseded.map((r) => r.id),
        supersededPeriodStarts: superseded.map((r) => r.periodStart),
      });
      bridgePreservedGroups++;
      continue;
    }

    // D-04: Zero bridge rows — fall through to the existing anchor-based selection
    // byte-identical. No behaviour change for non-bridge groups.

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
      `bridge_preserved=${bridgePreservedGroups} dry_run=${opts.dryRun}`,
  );

  if (opts.dryRun) {
    return {
      scannedRowCount: snapshots.length,
      groupsExamined: groups.size,
      duplicateGroups,
      supersededRowCount,
      auditLogRowCount: 0,
      bridgePreservedGroups,
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
    bridgePreservedGroups,
    applied: true,
  };
}
