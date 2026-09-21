/**
 * deferred-month-close.ts — a deferred Monatsabschluss as a STATE, not an event.
 *
 * Phase 292 (GitHub issue #292). Before this module, "der Monatsabschluss wurde zurückgestellt"
 * existed only as a notification row written while the cron walked past. Nothing could be asked
 * afterwards: not how many employees were affected, not since when, not how many gap days were
 * behind it. A state nobody can query is a state nobody notices — measured on a production tenant
 * on 2026-09-21, four employees had been sitting unclosed since 31.05. for four months.
 *
 * This module answers the question at any time, from the data itself. It stores nothing and adds
 * no column: the deferral IS "the newest active MONTHLY snapshot is older than the newest month
 * whose retro window has closed". Deriving it rather than recording it is also what keeps it
 * honest — a stored flag would have to be cleared by whoever finally closes the month, and a flag
 * that is only as good as its clearing path is the same defect one layer up.
 *
 * ── Why the state is NOT keyed on "has gaps" ──────────────────────────────────────────────────
 * The cron's `closeMonthWithGapsAllowed=false` branch is the most common cause of a permanent
 * deferral, but it is not the only one: `MONTHLY_HOURS`/`FLEXTIME` employees have no daily gap
 * rule at all ({@link detectMonthGaps} returns `gapRuleApplies: false`), unconfirmed mandatory
 * breaks defer on their own branch, and a run that threw for one employee simply leaves the month
 * open. Keying the state on gaps would have reported three of the four measured employees and
 * silently dropped the fourth. The state is therefore "months past their window, still unclosed";
 * the CAUSE is reported alongside it as {@link DeferralReason}, best-effort.
 *
 * ── Severity ─────────────────────────────────────────────────────────────────────────────────
 * Urgency grows with age, not with repetition: one overdue month is a reminder, three or more is
 * an ArbZG § 16 Abs. 2 exposure (the employer must be able to produce the Arbeitszeitnachweis).
 * {@link severityForMonthsBehind} is the only place that mapping is stated.
 *
 * The entry point takes `PrismaClient`, not `Prisma.TransactionClient` — it is not a facade
 * module (`lint-facade-signatures`'s D-07 rule applies to `contexts/*\/facade/**`), and one of
 * its reads, `findUnconfirmedBreakDays()`, requires the full client. It is a read-only reporter
 * and is never called from inside a `$transaction`.
 */

import type { PrismaClient } from "@clokr/db";
import { findUnconfirmedBreakDays } from "../time-tracking";
import { STATE_MAP } from "../platform";
import { detectMonthGaps } from "./month-gap-check";
import {
  DEFAULT_RETRO_ENTRY_WINDOW_DAYS,
  buildMonthRange,
  computeFirstOpenMonth,
  isMonthPastItsWindow,
  type MonthKey,
} from "./month-close-window";
import { dateStrInTz, monthDayBounds, monthRangeUtc } from "./timezone";

export type DeferredMonthCloseSeverity = "NONE" | "INFO" | "WARNING" | "CRITICAL";

/** Why the oldest overdue month is still open, as far as it can be determined from the data. */
export type DeferralReason = "GAPS" | "UNCONFIRMED_BREAKS" | "UNKNOWN";

export type DeferredMonthCloseEmployee = {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  /** Oldest month that is past its retro window and has no active snapshot. */
  oldestOpenMonth: MonthKey;
  /** How many such months there are — 1 = one month behind, 4 = the measured production case. */
  monthsBehind: number;
  reason: DeferralReason;
  /** Gap days of `oldestOpenMonth`, "YYYY-MM-DD", ascending. Empty in summary mode. */
  gapDates: string[];
  gapCount: number;
};

export type DeferredMonthCloseState = {
  tenantId: string;
  /** Number of employees with at least one overdue, unclosed month. */
  employeeCount: number;
  /** Oldest overdue month across all affected employees — null when none are. */
  oldestOpenMonth: MonthKey | null;
  /** Largest `monthsBehind` across all affected employees. */
  monthsBehind: number;
  /** Sum of `gapCount`. 0 in summary mode — read `detailed` before interpreting it. */
  gapCount: number;
  severity: DeferredMonthCloseSeverity;
  /** true when gap days were resolved (full mode); false for the cheap summary. */
  detailed: boolean;
  employees: DeferredMonthCloseEmployee[];
};

/**
 * Age → urgency. The ONLY statement of this mapping.
 *
 * 1 month: the routine case — the window closed, somebody has to act this week.
 * 2 months: the routine case did not work; it is now a backlog.
 * 3+ months: an unproduceable Arbeitszeitnachweis for a full quarter (§ 16 Abs. 2 ArbZG).
 */
export function severityForMonthsBehind(monthsBehind: number): DeferredMonthCloseSeverity {
  if (monthsBehind <= 0) return "NONE";
  if (monthsBehind === 1) return "INFO";
  if (monthsBehind === 2) return "WARNING";
  return "CRITICAL";
}

type TenantRow = {
  id: string;
  federalState: string;
  config: {
    timezone: string | null;
    retroEntryWindowDays: number | null;
    enforceBreakConfirmation: boolean | null;
    blockMonthCloseOnUnconfirmedBreak: boolean | null;
  } | null;
};

/**
 * Compute the deferral state for one tenant.
 *
 * `detailed: false` (the default for dashboard-sized callers) skips per-month gap detection —
 * it answers "who and since when", not "which days". `detailed: true` additionally resolves the
 * gap days of each employee's oldest overdue month through {@link detectMonthGaps}, so the
 * escalation can link straight to them.
 */
export async function getDeferredMonthCloseState(
  db: PrismaClient,
  tenantId: string,
  opts: { now?: Date; detailed?: boolean } = {},
): Promise<DeferredMonthCloseState> {
  const now = opts.now ?? new Date();
  const detailed = opts.detailed ?? false;

  const tenant = (await db.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      federalState: true,
      config: {
        select: {
          timezone: true,
          retroEntryWindowDays: true,
          enforceBreakConfirmation: true,
          blockMonthCloseOnUnconfirmedBreak: true,
        },
      },
    },
  })) as TenantRow | null;

  const empty: DeferredMonthCloseState = {
    tenantId,
    employeeCount: 0,
    oldestOpenMonth: null,
    monthsBehind: 0,
    gapCount: 0,
    severity: "NONE",
    detailed,
    employees: [],
  };
  if (!tenant) return empty;

  const tz = tenant.config?.timezone ?? "Europe/Berlin";
  const retroWindowDays = tenant.config?.retroEntryWindowDays ?? DEFAULT_RETRO_ENTRY_WINDOW_DAYS;
  const stateCode = STATE_MAP[tenant.federalState] ?? "NI";

  // Ceiling = previous calendar month in tenant TZ — the current month is never closable.
  const zonedNow = new Date(dateStrInTz(now, tz) + "T12:00:00Z");
  let prevYear = zonedNow.getUTCFullYear();
  let prevMonth = zonedNow.getUTCMonth(); // 0-based getter on a 1-based month → previous month
  if (prevMonth === 0) {
    prevMonth = 12;
    prevYear -= 1;
  }
  const { end: prevMonthEnd } = monthRangeUtc(prevYear, prevMonth, tz);

  const employees = await db.employee.findMany({
    where: {
      tenantId,
      user: { isActive: true },
      isTimeTrackingExempt: false, // parity with auto-close-month.ts (D-02)
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      employeeNumber: true,
      hireDate: true,
      workSchedules: { orderBy: { validFrom: "desc" } },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  const affected: DeferredMonthCloseEmployee[] = [];

  for (const emp of employees) {
    if (emp.hireDate > prevMonthEnd) continue;

    const lastSnap = await db.saldoSnapshot.findFirst({
      where: { employeeId: emp.id, periodType: "MONTHLY", superseded: false },
      orderBy: { periodStart: "desc" },
      select: { periodStart: true },
    });

    const firstOpen = computeFirstOpenMonth(emp.hireDate, lastSnap, tz);
    if (firstOpen === null) continue;

    const overdue = buildMonthRange(firstOpen, { year: prevYear, month: prevMonth }).filter((m) =>
      isMonthPastItsWindow(m.year, m.month, tz, retroWindowDays, now),
    );
    if (overdue.length === 0) continue;

    const oldestOpenMonth = overdue[0];
    let reason: DeferralReason = "UNKNOWN";
    let gapDates: string[] = [];

    if (detailed) {
      const { start: oldestStart, end: oldestEnd } = monthRangeUtc(
        oldestOpenMonth.year,
        oldestOpenMonth.month,
        tz,
      );
      const scheduleForMonth = emp.workSchedules.find((ws) => ws.validFrom <= oldestEnd);
      if (scheduleForMonth) {
        const gapResult = await detectMonthGaps(db, {
          tenantId,
          employeeId: emp.id,
          hireDate: emp.hireDate,
          schedule: scheduleForMonth as unknown as Record<string, unknown>,
          month: oldestOpenMonth,
          tz,
          stateCode,
        });
        gapDates = gapResult.gapDates;
        if (gapDates.length > 0) {
          reason = "GAPS";
        } else if (tenant.config?.blockMonthCloseOnUnconfirmedBreak) {
          const { firstDay, lastDay } = monthDayBounds(oldestStart, oldestEnd, tz);
          const unconfirmed = await findUnconfirmedBreakDays(db, {
            employeeId: emp.id,
            monthFirstDay: firstDay,
            monthLastDay: lastDay,
            tz,
            scheduleType: String(scheduleForMonth.type),
            enforceBreakConfirmation: tenant.config?.enforceBreakConfirmation ?? false,
          });
          if (unconfirmed.length > 0) {
            reason = "UNCONFIRMED_BREAKS";
            gapDates = unconfirmed;
          }
        }
      }
    }

    affected.push({
      employeeId: emp.id,
      employeeName: `${emp.firstName} ${emp.lastName}`,
      employeeNumber: emp.employeeNumber,
      oldestOpenMonth,
      monthsBehind: overdue.length,
      reason,
      gapDates,
      gapCount: gapDates.length,
    });
  }

  if (affected.length === 0) return empty;

  const monthsBehind = Math.max(...affected.map((a) => a.monthsBehind));
  const oldestOpenMonth = affected
    .map((a) => a.oldestOpenMonth)
    .reduce((oldest, m) =>
      m.year < oldest.year || (m.year === oldest.year && m.month < oldest.month) ? m : oldest,
    );

  return {
    tenantId,
    employeeCount: affected.length,
    oldestOpenMonth,
    monthsBehind,
    gapCount: affected.reduce((sum, a) => sum + a.gapCount, 0),
    severity: severityForMonthsBehind(monthsBehind),
    detailed,
    employees: affected,
  };
}
