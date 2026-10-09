/**
 * break-finding-days.ts
 *
 * Issue #511 (D-12) — generalises Issue #80 (D-09b, D-15). The ONE place that defines "a day with
 * an unacknowledged § 4 ArbZG / § 11 JArbSchG break finding" for the month close (status listing,
 * manual close 409, auto-close defer, deferred-close reporter), the next-day notification job and
 * the dry run.
 *
 * A day qualifies when `hasAckableFinding()` holds for its evaluation — the cross-salon Satz-1
 * shortfall of Issue #80 plus any Satz-2 / Satz-3 placement finding with a certainty (VIOLATION or
 * UNCLEAR) — and nothing documents it: no current acknowledgement and no entry-level WAIVED. The
 * position-unknown hint (legacy entries with only a stored break sum) carries no certainty, so it
 * never qualifies: it never blocks, never defers and is never listed (A5).
 *
 * Deliberately NOT a copy of the Phase 92 gates:
 *   - It is NOT gated by `enforceBreakConfirmation` and NOT limited by schedule type. A statutory
 *     finding does not depend on whether a tenant opted into break confirmation or on whether the
 *     contract has a daily target. The only gate is the caller's own `blockMonthCloseOnUnconfirmedBreak`
 *     check, and only for the consumers that BLOCK.
 *   - Rows of a locked entry are skipped: a closed month is immutable and un-actionable, so listing
 *     it would be a dead-end nudge (Phase 92, Pitfall 1; #511 D-14). Only the dry run asks for them.
 *   - § 3 (daily sum above 10 h) never qualifies: an acknowledgement never touches § 3.
 *
 * The decision itself is `evaluateDayBreaks()` (day-break-rule.ts) under the day's regime; this
 * module only funnels candidate days, loads the data the kernel needs and applies the predicate.
 *
 * Query budget (PERF-V1814-01, D-15): the funnel is pure. The Break rows of all candidate entries
 * are read with ONE `loadBreaksOfEntries`; DayBreak / DayBreakAck are read with ONE
 * `loadDayBreakDataForDays` and only when some day has several entries or a first-pass finding that
 * an acknowledgement could resolve. With no candidate day no query is issued at all.
 *
 * IMPORT RULE: this module is re-exported by `contexts/time-tracking/index.ts` and consumed by
 * Arbeitszeitkonto, so it must not import `../absence` or `../working-time-account` (that would
 * join the measured import cycle, CI gate `--cycles --check`). The age decision therefore arrives
 * as the injected function `isMinorAt`; callers pass `isMinorAtDate` from `../../absence`.
 *
 * This module never reads or writes the saldo — it feeds only the month-close gates.
 */

import type { PrismaClient } from "@clokr/db";
import { formatInTimeZone } from "date-fns-tz";
import { breakRegimeFor, LOWEST_BREAK_DUTY_MIN } from "./break-regime";
import {
  evaluateDayBreaks,
  hasAckableFinding,
  type DayBreakEvaluation,
  type DayBreakRow,
} from "./day-break-rule";
import {
  closedWorkRowsInRange,
  loadBreaksOfEntries,
  loadDayBreakDataForDays,
  type DayBreakStoreDb,
} from "./day-break-store";

/**
 * The tenant-local calendar-day key ("YYYY-MM-DD") — the same format `dateStrInTz()` of the
 * Arbeitszeitkonto produces. It is formatted here directly on purpose: importing that context's
 * index back would add this module to the measured import cycle without any need.
 */
function dayKeyInTz(date: Date, tz: string): string {
  return formatInTimeZone(date, tz, "yyyy-MM-dd");
}

// ── Public types ──────────────────────────────────────────────────────────────

/** Minimal shape of a closed WORK row as the month-close consumers fetch it (T2). */
export type BreakFindingRow = {
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

/** The age decision, injected so this module never imports the absence context. */
export type IsMinorAt = (birthDate: Date | null, day: Date) => boolean;

/** One unacknowledged break-finding day of one employee. */
export type BreakFindingDay = {
  /** "YYYY-MM-DD" in the tenant timezone. */
  date: string;
  /** CROSS_SALON iff the day is cross-salon with a Satz-1 shortfall; every other finding day is PLACEMENT. */
  kind: "CROSS_SALON" | "PLACEMENT";
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

// ── Funnel ────────────────────────────────────────────────────────────────────

/** Rows of one employee-day, grouped by the funnel. */
type DayGroup = { employeeId: string; day: string; rows: BreakFindingRow[] };

/**
 * Groups closed rows by employee and tenant-local day and keeps the days where a break finding is
 * possible at all: entries in two or more salons, or a span from the first start to the last end
 * above the lowest working-time band that triggers a break duty under any regime. A group with a
 * locked row is dropped unless `includeLocked`.
 */
function candidateGroups(
  rows: readonly BreakFindingRow[],
  tz: string,
  includeLocked: boolean,
): DayGroup[] {
  const byKey = new Map<string, DayGroup>();
  for (const row of rows) {
    if (row.endTime === null) continue; // open entries are not part of a day evaluation
    const day = dayKeyInTz(row.date, tz);
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
    if (!includeLocked && group.rows.some((r) => r.isLocked === true)) continue;
    const salons = new Set(group.rows.map((r) => r.salonId));
    let first = Infinity;
    let last = -Infinity;
    for (const r of group.rows) {
      first = Math.min(first, r.startTime.getTime());
      last = Math.max(last, r.endTime!.getTime());
    }
    const spanMs = last - first;
    if (salons.size < 2 && !(spanMs > LOWEST_BREAK_DUTY_MIN * 60_000)) continue;
    out.push(group);
  }
  return out;
}

/**
 * Pure funnel — no DB calls. Maps closed WORK rows to the sorted day keys per employee on which a
 * break finding is possible and no entry is locked. A cheap superset of the finding days: whether
 * a day is actually a finding is the kernel's decision.
 */
export function breakFindingCandidateDays(
  rows: readonly BreakFindingRow[],
  tz: string,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const group of candidateGroups(rows, tz, false)) {
    const days = result.get(group.employeeId) ?? [];
    days.push(group.day);
    result.set(group.employeeId, days);
  }
  for (const days of result.values()) days.sort((a, b) => a.localeCompare(b));
  return result;
}

// ── Evaluation ────────────────────────────────────────────────────────────────

/** One evaluated candidate day. */
export type EvaluatedBreakDay = {
  employeeId: string;
  /** "YYYY-MM-DD" in the tenant timezone. */
  date: string;
  /** True when any entry of the day is locked (only returned with `includeLocked`). */
  locked: boolean;
  evaluation: DayBreakEvaluation;
  rows: BreakFindingDay["rows"];
};

/**
 * Evaluates every candidate day (hint-only days included) under the employee's regime on that day.
 *
 * ONE `loadBreaksOfEntries` over the candidate entries. A first pass runs without day breaks and
 * acknowledgements; days with several entries or an ackable first-pass finding get ONE
 * `loadDayBreakDataForDays` over their employees and date span and are re-evaluated with them.
 * `includeLocked` is for the dry run, which must also see closed months; every other caller keeps
 * the default and never re-evaluates a locked day.
 */
export async function evaluateBreakFindingDays(
  db: Db,
  opts: {
    tenantId: string;
    rows: readonly BreakFindingRow[];
    tz: string;
    birthDates?: ReadonlyMap<string, Date | null>;
    isMinorAt: IsMinorAt;
    includeLocked?: boolean;
  },
): Promise<EvaluatedBreakDay[]> {
  const groups = candidateGroups(opts.rows, opts.tz, opts.includeLocked === true);
  if (groups.length === 0) return [];

  const breaksByEntry = await loadBreaksOfEntries(db, {
    tenantId: opts.tenantId,
    entryIds: groups.flatMap((g) => g.rows.map((r) => r.id)),
  });

  const prepared = groups.map((group) => {
    // Start order, then id — the order the day lookup and the kernel use everywhere else.
    const ordered = [...group.rows].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime() || a.id.localeCompare(b.id),
    );
    const kernelRows = ordered.map((r): DayBreakRow => ({
      id: r.id,
      startTime: r.startTime,
      endTime: r.endTime!, // non-null: the funnel dropped open entries
      breakMinutes: r.breakMinutes,
      breakStatus: r.breakStatus,
      salonId: r.salonId,
      breaks: breaksByEntry.get(r.id) ?? [],
    }));
    const regime = breakRegimeFor(
      opts.isMinorAt(opts.birthDates?.get(group.employeeId) ?? null, ordered[0].date),
    );
    const firstPass = evaluateDayBreaks({ rows: kernelRows, dayBreaks: [], acks: [], regime });
    return { group, ordered, kernelRows, regime, firstPass };
  });

  // Only a day that can carry a day break or an acknowledgement needs the second read.
  const needsData = prepared.filter((p) => p.ordered.length >= 2 || hasAckableFinding(p.firstPass));
  const dayBreaksByKey = new Map<
    string,
    Awaited<ReturnType<typeof loadDayBreakDataForDays>>["dayBreaks"]
  >();
  const acksByKey = new Map<string, Awaited<ReturnType<typeof loadDayBreakDataForDays>>["acks"]>();
  if (needsData.length > 0) {
    const days = needsData.map((p) => p.group.day).sort((a, b) => a.localeCompare(b));
    const { dayBreaks, acks } = await loadDayBreakDataForDays(db, {
      tenantId: opts.tenantId,
      employeeIds: [...new Set(needsData.map((p) => p.group.employeeId))],
      from: new Date(`${days[0]}T00:00:00Z`),
      to: new Date(`${days[days.length - 1]}T00:00:00Z`),
    });
    for (const b of dayBreaks) {
      const key = `${b.employeeId}\u0000${dayKeyInTz(b.date, opts.tz)}`;
      dayBreaksByKey.set(key, [...(dayBreaksByKey.get(key) ?? []), b]);
    }
    for (const a of acks) {
      const key = `${a.employeeId}\u0000${dayKeyInTz(a.date, opts.tz)}`;
      acksByKey.set(key, [...(acksByKey.get(key) ?? []), a]);
    }
  }
  const needsDataSet = new Set(needsData);

  return prepared.map((p) => {
    const key = `${p.group.employeeId}\u0000${p.group.day}`;
    const evaluation = needsDataSet.has(p)
      ? evaluateDayBreaks({
          rows: p.kernelRows,
          dayBreaks: dayBreaksByKey.get(key) ?? [],
          acks: acksByKey.get(key) ?? [],
          regime: p.regime,
        })
      : p.firstPass;
    return {
      employeeId: p.group.employeeId,
      date: p.group.day,
      locked: p.ordered.some((r) => r.isLocked === true),
      evaluation,
      rows: p.ordered.map((r) => ({
        id: r.id,
        startTime: r.startTime,
        endTime: r.endTime!,
        salonId: r.salonId,
        employeeId: r.employeeId,
        date: r.date,
      })),
    };
  });
}

/**
 * Bulk detector: from the already-fetched closed WORK rows of any number of employees, the
 * unacknowledged break-finding days per employee (key = employeeId, days ascending, locked days
 * excluded).
 *
 * A day is listed when `hasAckableFinding(evaluation) && !evaluation.waived`. On a cross-salon day
 * `waived` equals "acknowledged" (an entry-level WAIVED never waives it, identical to Issue #80);
 * on a single-salon day an entry-level WAIVED ("durchgearbeitet") also resolves it. A stale
 * acknowledgement (moved break, changed day) leaves the day listed.
 */
export async function findUnacknowledgedBreakFindingDays(
  db: Db,
  opts: {
    tenantId: string;
    rows: readonly BreakFindingRow[];
    tz: string;
    birthDates?: ReadonlyMap<string, Date | null>;
    isMinorAt: IsMinorAt;
  },
): Promise<Map<string, BreakFindingDay[]>> {
  const result = new Map<string, BreakFindingDay[]>();
  const evaluated = await evaluateBreakFindingDays(db, opts);
  for (const day of evaluated) {
    if (!hasAckableFinding(day.evaluation) || day.evaluation.waived) continue;
    const list = result.get(day.employeeId) ?? [];
    list.push({
      date: day.date,
      kind:
        day.evaluation.crossSalon && day.evaluation.breakShortfall ? "CROSS_SALON" : "PLACEMENT",
      evaluation: day.evaluation,
      rows: day.rows,
    });
    result.set(day.employeeId, list);
  }
  for (const list of result.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return result;
}

/**
 * Single-employee convenience for the manual close, the auto-close and the deferred-close reporter:
 * the month's unacknowledged break-finding days. One closed-row range read, one tenant-bound
 * birth-date read, then the bulk detector (no further query when the employee has no candidate day).
 */
export async function findUnacknowledgedBreakFindingDaysForEmployee(
  db: PrismaClient,
  opts: {
    tenantId: string;
    employeeId: string;
    monthFirstDay: Date;
    monthLastDay: Date;
    tz: string;
    isMinorAt: IsMinorAt;
  },
): Promise<Array<{ date: string; kind: BreakFindingDay["kind"] }>> {
  const rows = await closedWorkRowsInRange(
    db,
    { kind: "employee", employeeId: opts.employeeId, tenantId: opts.tenantId },
    opts.monthFirstDay,
    opts.monthLastDay,
  );
  const employee = await db.employee.findFirst({
    where: { id: opts.employeeId, tenantId: opts.tenantId },
    select: { birthDate: true },
  });
  const map = await findUnacknowledgedBreakFindingDays(db, {
    tenantId: opts.tenantId,
    rows,
    tz: opts.tz,
    birthDates: new Map([[opts.employeeId, employee?.birthDate ?? null]]),
    isMinorAt: opts.isMinorAt,
  });
  return (map.get(opts.employeeId) ?? []).map((d) => ({ date: d.date, kind: d.kind }));
}
