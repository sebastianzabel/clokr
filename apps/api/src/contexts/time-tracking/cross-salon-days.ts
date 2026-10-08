/**
 * cross-salon-days.ts
 *
 * Issue #80 (D-09b, D-15) — the ONE place that defines "a day of a month with an unacknowledged
 * cross-salon § 4 ArbZG violation" for the month close (status listing, manual close 409, auto-close
 * defer, deferred-close reporter) and for the next-day notification cron (plan 80-09).
 *
 * A sibling of `find-unconfirmed-break-days.ts` (Phase 92), deliberately NOT a copy of its gates:
 *   - It is NOT gated by `enforceBreakConfirmation` and NOT limited by schedule type. A statutory
 *     finding (§ 4 ArbZG) does not depend on whether a tenant opted into break confirmation or on
 *     whether the contract has a daily target (D-15). The only gate is the caller's own
 *     `blockMonthCloseOnUnconfirmedBreak` check, and only for the consumers that BLOCK.
 *   - Rows of a locked entry are skipped: a closed month is immutable and un-actionable, so listing
 *     it would be a dead-end nudge (Phase 92, Pitfall 1).
 *   - § 4 only (D-18): a day with only a § 3 finding (daily sum above 10 h) never appears here,
 *     because an acknowledgement never touches § 3.
 *
 * The decision itself is `evaluateDayBreaks()` (day-break-rule.ts): a day is listed when it is
 * cross-salon, has a § 4 break shortfall and its acknowledgement is not current (D-17: an
 * acknowledgement whose stored snapshot differs from the day's current state does not count).
 *
 * Query budget (PERF-V1814-01): the funnel is pure; with no candidate day (no employee has entries
 * in two salons on one day — today's data) no DayBreak/DayBreakAck query is issued at all.
 * Otherwise exactly one read per model over the candidate employees and the candidate date span.
 *
 * This module never reads or writes the saldo (D-05) — it feeds only the month-close gates.
 */

import type { PrismaClient } from "@clokr/db";
import { dateStrInTz } from "../working-time-account"; // Phase 101B
import { evaluateDayBreaks, type DayBreakEvaluation, type DayBreakRow } from "./day-break-rule";
import {
  closedWorkRowsInRange,
  loadDayBreakDataForDays,
  type DayBreakStoreDb,
} from "./day-break-store";

// ── Public types ──────────────────────────────────────────────────────────────

/** Minimal shape of a closed WORK row as the month-close consumers fetch it (T2). */
export type CrossSalonRow = {
  id: string;
  employeeId: string;
  /** `@db.Date` value: the UTC-midnight instant of the tenant-local calendar day. */
  date: Date;
  startTime: Date;
  /** Null only for an open entry, which the funnel skips (the evaluation needs closed rows). */
  endTime: Date | null;
  breakMinutes: number | bigint | null;
  breakStatus?: string | null;
  salonId: string;
  isLocked?: boolean | null;
};

/** One unacknowledged cross-salon § 4 violation day of one employee. */
export type CrossSalonViolationDay = {
  /** "YYYY-MM-DD" in the tenant timezone. */
  date: string;
  evaluation: DayBreakEvaluation;
  rows: {
    id: string;
    startTime: Date;
    endTime: Date;
    salonId: string;
    employeeId: string;
    date: Date;
  }[];
};

type Db = DayBreakStoreDb;

// ── Implementation ────────────────────────────────────────────────────────────

/** Rows of one employee-day, grouped by the funnel. */
type DayGroup = { employeeId: string; day: string; rows: CrossSalonRow[] };

/** Groups closed rows by employee and tenant-local day, keeping only days with >= 2 salons. */
function candidateGroups(rows: readonly CrossSalonRow[], tz: string): DayGroup[] {
  const byKey = new Map<string, DayGroup>();
  for (const row of rows) {
    if (row.endTime === null) continue; // open entries are not part of a day evaluation
    const day = dateStrInTz(row.date, tz);
    const key = `${row.employeeId}\u0000${day}`;
    let group = byKey.get(key);
    if (!group) {
      group = { employeeId: row.employeeId, day, rows: [] };
      byKey.set(key, group);
    }
    group.rows.push(row);
  }
  const out: DayGroup[] = [];
  for (const group of byKey.values()) {
    if (new Set(group.rows.map((r) => r.salonId)).size < 2) continue; // single salon: Phase 92 world
    if (group.rows.some((r) => r.isLocked === true)) continue; // closed months are un-actionable
    out.push(group);
  }
  return out;
}

/**
 * Pure funnel — no DB calls. Maps closed WORK rows to the sorted day keys per employee on which the
 * entries lie in two or more salons and none of them is locked. A cheap superset of the violation
 * days: whether a day is actually a violation is `evaluateDayBreaks()`'s decision.
 */
export function crossSalonCandidateDays(
  rows: readonly CrossSalonRow[],
  tz: string,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const group of candidateGroups(rows, tz)) {
    const days = result.get(group.employeeId) ?? [];
    days.push(group.day);
    result.set(group.employeeId, days);
  }
  for (const days of result.values()) days.sort((a, b) => a.localeCompare(b));
  return result;
}

/**
 * Bulk detector: from the already-fetched closed WORK rows of any number of employees, the
 * unacknowledged cross-salon § 4 violation days per employee (key = employeeId, days ascending).
 *
 * No candidate day -> empty map and NO query. Otherwise one `loadDayBreakDataForDays` call over the
 * candidate employees and the candidate date span (one read per model), then `evaluateDayBreaks`
 * per candidate day; a day is kept when it is cross-salon, has a § 4 shortfall and is not
 * acknowledged by a CURRENT snapshot.
 */
export async function findUnacknowledgedCrossSalonDays(
  db: Db,
  opts: { tenantId: string; rows: readonly CrossSalonRow[]; tz: string },
): Promise<Map<string, CrossSalonViolationDay[]>> {
  const result = new Map<string, CrossSalonViolationDay[]>();
  const groups = candidateGroups(opts.rows, opts.tz);
  if (groups.length === 0) return result;

  const employeeIds = [...new Set(groups.map((g) => g.employeeId))];
  const days = groups.map((g) => g.day).sort((a, b) => a.localeCompare(b));
  const from = new Date(`${days[0]}T00:00:00Z`);
  const to = new Date(`${days[days.length - 1]}T00:00:00Z`);

  const { dayBreaks, acks } = await loadDayBreakDataForDays(db, {
    tenantId: opts.tenantId,
    employeeIds,
    from,
    to,
  });
  const breaksByKey = new Map<string, typeof dayBreaks>();
  for (const b of dayBreaks) {
    const key = `${b.employeeId}\u0000${dateStrInTz(b.date, opts.tz)}`;
    breaksByKey.set(key, [...(breaksByKey.get(key) ?? []), b]);
  }
  const acksByKey = new Map<string, typeof acks>();
  for (const a of acks) {
    const key = `${a.employeeId}\u0000${dateStrInTz(a.date, opts.tz)}`;
    acksByKey.set(key, [...(acksByKey.get(key) ?? []), a]);
  }

  for (const group of groups) {
    const key = `${group.employeeId}\u0000${group.day}`;
    // Start order, then id — the order the day lookup and the kernel use everywhere else.
    const ordered = [...group.rows].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime() || a.id.localeCompare(b.id),
    );
    const evaluation = evaluateDayBreaks({
      rows: ordered.map((r): DayBreakRow => ({
        id: r.id,
        startTime: r.startTime,
        endTime: r.endTime!, // non-null: the funnel dropped open entries
        breakMinutes: r.breakMinutes,
        breakStatus: r.breakStatus,
        salonId: r.salonId,
      })),
      dayBreaks: breaksByKey.get(key) ?? [],
      acks: acksByKey.get(key) ?? [],
    });
    // D-18: § 4 only; D-17: a stale acknowledgement leaves `acknowledged` false.
    if (!evaluation.crossSalon || !evaluation.breakShortfall || evaluation.acknowledged) continue;

    const list = result.get(group.employeeId) ?? [];
    list.push({
      date: group.day,
      evaluation,
      rows: ordered.map((r) => ({
        id: r.id,
        startTime: r.startTime,
        endTime: r.endTime!,
        salonId: r.salonId,
        employeeId: r.employeeId,
        date: r.date,
      })),
    });
    result.set(group.employeeId, list);
  }
  for (const list of result.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return result;
}

/**
 * Single-employee convenience for the manual close, the auto-close and the deferred-close reporter:
 * the day keys of the month with an unacknowledged cross-salon § 4 violation. One closed-row range
 * read, then the bulk detector (no further query when the employee has no two-salon day).
 */
export async function findUnacknowledgedCrossSalonDaysForEmployee(
  db: PrismaClient,
  opts: {
    tenantId: string;
    employeeId: string;
    monthFirstDay: Date;
    monthLastDay: Date;
    tz: string;
  },
): Promise<string[]> {
  const rows = await closedWorkRowsInRange(
    db,
    { kind: "employee", employeeId: opts.employeeId, tenantId: opts.tenantId },
    opts.monthFirstDay,
    opts.monthLastDay,
  );
  const map = await findUnacknowledgedCrossSalonDays(db, {
    tenantId: opts.tenantId,
    rows,
    tz: opts.tz,
  });
  return (map.get(opts.employeeId) ?? []).map((d) => d.date);
}
