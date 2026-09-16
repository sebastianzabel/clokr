/**
 * Saldo chain-integrity core — Phase 98 (AUDIT-CHAIN-01 / AUDIT-CHAIN-03).
 *
 * Pure, database-free module. Walks an already-fetched, already-ordered set of
 * SaldoSnapshot rows for a single employee and asserts the chain identity
 * `carryOver == carryOverIn + balanceMinutes` at every link, reporting each
 * deviation as a signed `delta`.
 *
 * `computeInjectedDelta` is the SINGLE source of truth for the delta formula
 * shared with `recalculateSnapshots()` (see `apps/api/src/utils/recalculate-snapshots.ts`,
 * which imports this exact function instead of re-deriving the arithmetic) —
 * a Phase 98 CONTEXT.md locked decision: the preservation path (v1.9.14) and
 * this detector must not be able to drift apart.
 *
 * This module performs NO I/O: no Prisma import, nothing async, no database
 * access. Callers are responsible for fetching rows and, where relevant, for
 * DB-aware exceptions (e.g. TRACK_ONLY zeroing — see `isTrackOnlySchedule` below).
 */
import { isBridgeSnapshot } from "./saldo-snapshot-cleanup";

export type ChainRow = {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  carryOver: number;
};

export type ChainLinkKind = "normal" | "bridge" | "duplicate_month";

export type ChainLink = {
  rowId: string;
  monthLabel: string; // "YYYY-MM", derived from periodEnd (see monthLabelFromPeriodEnd)
  periodStart: Date;
  periodEnd: Date;
  isFirstLink: boolean;
  kind: ChainLinkKind;
  carryOverIn: number; // previous active row's STORED carryOver; 0 for the first link
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  expectedCarryOver: number; // carryOverIn + balanceMinutes
  storedCarryOver: number; // the row's own stored carryOver
  delta: number; // storedCarryOver - expectedCarryOver
};

/**
 * The chain-identity remainder. 0 for every well-behaved row.
 * SINGLE SOURCE OF TRUTH — recalculate-snapshots.ts imports this exact function.
 * Do NOT re-derive this arithmetic anywhere else (Phase 98 CONTEXT.md locked decision).
 *
 * storedCarryIn: what this row's stored carryOver implies its carry-IN was, per
 * its own stored balanceMinutes. Kept as a two-step form (rather than collapsing
 * the arithmetic into one expression) so the extraction from
 * apps/api/src/utils/recalculate-snapshots.ts:160-168 stays traceable.
 */
export function computeInjectedDelta(
  row: { carryOver: number; balanceMinutes: number },
  prevStoredCarryOver: number,
): number {
  const storedCarryIn = row.carryOver - row.balanceMinutes;
  return storedCarryIn - prevStoredCarryOver;
}

/**
 * UTC "YYYY-MM" of a @db.Date periodEnd.
 *
 * Month attribution uses `periodEnd`, NEVER `periodStart` — `periodStart` carries
 * two coexisting conventions (TZ-converted = previous month's last day, e.g.
 * `2026-06-30` for July Europe/Berlin; legacy naive = the 1st, `2026-07-01`),
 * while `periodEnd` is the last day of the target month under BOTH. See
 * `apps/api/src/utils/saldo-snapshot-cleanup.ts:171-179` and
 * `apps/api/src/utils/snapshot-period.ts` for the reference on this ambiguity.
 */
export function monthLabelFromPeriodEnd(periodEnd: Date): string {
  return periodEnd.toISOString().slice(0, 7);
}

export function walkSaldoChain(rows: readonly ChainRow[]): ChainLink[] {
  if (rows.length === 0) return [];

  // Defensive copy + ascending sort — never mutate the caller's array.
  const sorted = [...rows].sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());

  // Pre-pass: any monthLabel occurring >= 2 times marks every row in that bucket
  // as duplicate_month — two active rows for one month make the chain unwalkable;
  // their deltas are noise, not evidence (see selectChainViolations below).
  const monthCounts = new Map<string, number>();
  for (const row of sorted) {
    const label = monthLabelFromPeriodEnd(row.periodEnd);
    monthCounts.set(label, (monthCounts.get(label) ?? 0) + 1);
  }

  const links: ChainLink[] = [];
  let prevStoredCarryOver = 0;
  sorted.forEach((row, index) => {
    const monthLabel = monthLabelFromPeriodEnd(row.periodEnd);
    const isFirstLink = index === 0;
    const carryOverIn = prevStoredCarryOver;
    const expectedCarryOver = carryOverIn + row.balanceMinutes;
    const delta = computeInjectedDelta(row, prevStoredCarryOver);
    const isDuplicateMonth = (monthCounts.get(monthLabel) ?? 0) >= 2;
    const kind: ChainLinkKind = isDuplicateMonth
      ? "duplicate_month"
      : isBridgeSnapshot(row)
        ? "bridge"
        : "normal";

    links.push({
      rowId: row.id,
      monthLabel,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      isFirstLink,
      kind,
      carryOverIn,
      workedMinutes: row.workedMinutes,
      expectedMinutes: row.expectedMinutes,
      balanceMinutes: row.balanceMinutes,
      expectedCarryOver,
      storedCarryOver: row.carryOver,
      delta,
    });

    // Always thread the STORED value forward — for every kind, including bridge and
    // duplicate_month rows. The audit asserts what is stored; deriving the carry-in
    // from a recomputed value would erase the very delta being detected.
    prevStoredCarryOver = row.carryOver;
  });

  return links;
}

/**
 * duplicate_month links are excluded because two active rows for one month make
 * the chain unwalkable — their deltas are noise, not evidence. They are reported
 * in their own bucket by selectDuplicateMonthLinks and still fail the audit (see
 * Plan 03 exit codes).
 */
export function selectChainViolations(links: readonly ChainLink[]): ChainLink[] {
  return links.filter((l) => l.kind !== "duplicate_month" && l.delta !== 0);
}

export function selectDuplicateMonthLinks(links: readonly ChainLink[]): ChainLink[] {
  return links.filter((l) => l.kind === "duplicate_month");
}

/**
 * `closeEmployeeMonth()` forces `carryOver = 0` for MONTHLY_HOURS/TRACK_ONLY
 * employees regardless of `carryOverIn + balanceMinutes`
 * (`apps/api/src/utils/close-employee-month.ts`, `isTrackOnly` zeroing) — so
 * their links violate the identity BY DESIGN and must be filtered out by the
 * caller, which needs a DB lookup (WorkSchedule) and therefore cannot happen
 * inside this pure module.
 */
export function isTrackOnlySchedule(
  schedule: { type?: unknown; overtimeMode?: unknown } | null | undefined,
): boolean {
  return schedule?.type === "MONTHLY_HOURS" && schedule?.overtimeMode === "TRACK_ONLY";
}
