/**
 * close-employee-month.ts
 *
 * Pure per-employee-per-month saldo core for the Monatsabschluss pipeline.
 *
 * PURITY CONTRACT:
 *   Pure function — no DB, no network, no side effects.
 *   Caller owns $transaction + app.audit(). All inputs are pre-fetched by the
 *   caller. Purity contract matches calcShiftBasedSaldo (shift-based-saldo.ts).
 *
 * SHIFT_BASED bsExpectedMinutes note (single shared path):
 *   This function includes bsExpectedMinutes for SHIFT_BASED. ALL saldo paths now route
 *   through it: manual close (P1, overtime.ts), cron close (P2, auto-close-month.ts),
 *   retroactive recalc (P3, recalculate-snapshots.ts), AND the live path
 *   (computeOvertimeBalanceHours / updateOvertimeAccount, time-entries.ts) since the
 *   Phase 76.39 consolidation. There is NO live-vs-closed bsExpectedMinutes divergence —
 *   an earlier "live-path gap" note here was stale and has been removed (v1.8.27).
 *
 * SHIFT_BASED BS single-count (v1.8.27 fix):
 *   A BS day is counted toward the contract Soll EXACTLY ONCE. contractSoll
 *   (calcExpectedMinutesTz → avgWorkMinutesCore) has no BS awareness and counts a BS day
 *   that lands on a normal workday as a contracted workday. The SHIFT_BASED sbAbsenceCredit
 *   loop therefore subtracts that day's Ø-Method average credit (like every other absence
 *   type) BEFORE bsExpectedMinutes re-adds the precise BBiG §15 slot credit. Before this
 *   fix the loop skipped VOCATIONAL_SCHOOL/PATTERN, double-counting each BS day's Soll
 *   (inflated Monats-Soll/Ist; prod-confirmed 247:00 on a 38h/week contract).
 *
 * Überstundenausgleich (issue #220, model B):
 *   Until this fix the function did not distinguish absence KINDS at all — `approvedLeave`
 *   carried no type discriminator, so an approved OVERTIME_COMP request reduced the Soll
 *   exactly like Urlaub. The unworked day's minus therefore vanished and the stored balance
 *   ROSE by the day's hours while the `OvertimeTransaction` journal row said it fell. Measured
 *   over the real endpoints on an 8h-Monday fixture: approval moved the stored balance by +8 h
 *   (journal: −8 h), cancellation by −8 h (journal: +8 h) — a 16 h error per compensated day
 *   against the booking intent.
 *   The fix keeps the Soll reduction (the Ausgleichstag IS paid and must not also produce a
 *   gap) and adds the withdrawal as a separate summand on the balance, taken from the very
 *   same per-row credit value that granted the credit (`calcLeaveAbsenceMinutesTz()` for the
 *   non-SHIFT branch; `shiftBasedLeaveCreditByDate()` for the SHIFT_BASED approvedLeave loop
 *   since Issue #429). Credit and withdrawal are therefore the same number by construction,
 *   for half days, holidays inside the range and D-15 overlap dedup alike.
 *
 * exitDate convention (D-03):
 *   exitDate is INCLUSIVE — last working day, per vocational-school-generator.ts:320
 *   precedent. effectiveEnd = min(exitDate, monthLastDay).
 *   Caller must skip employees whose exitDate < monthFirstDay (they left before
 *   the month started); the core clamps defensively but returns empty results in
 *   that edge case.
 *   Issue #447 (D-01): the exit clip now bounds Soll, holiday deduction, leave and
 *   absence reduction too, via `sollRangeEnd` — not only entries, shifts and gaps as
 *   before. `sollRangeEnd` equals the caller's `monthEnd` unless the exit day precedes
 *   it, so every no-exit input (and the live SHIFT_BASED roster proration) is unchanged.
 *
 * BS-doubling (pure inline computation):
 *   VOCATIONAL_SCHOOL absence dates are counted per ISO week from the provided
 *   absences array (no DB access). The same block-week cap logic from
 *   vocational-school-saldo.ts is reproduced inline: if ≥5 BS days in the same
 *   ISO week → distribute blockWeekly / N; otherwise use dailyDefault per day.
 *   tenantConfig.vocationalSchoolMinutesPerDay / vocationalSchoolBlockMinutesPerWeek
 *   configure the per-tenant caps (defaults: 480 / 2400 matching the DB @default values).
 *
 * References: RESEARCH.md §5.2, §2 (divergence table), §7 (helpers), §8 (patterns).
 */

import type { FastifyInstance } from "fastify";
import { findMissingWorkdays, type WorkdayGap } from "./find-missing-workdays";
import { calcShiftBasedSaldo } from "./shift-based-saldo";
import {
  getEffectiveBreakDuration, // Phase 101B (Issue #101, wave 8)
  getValidWorkedEntriesInRange, // Phase 100B Plan 08 — T1; THE SALDO INPUT (computeWeekProgress)
  getWorkedEntriesInRange, // Phase 71b (issue #71) — T2, feeds the holiday resolver (computeWeekProgress)
  getEffectiveSchedule, // computeWeekProgress's per-piece contract resolution
} from "../time-tracking";
import { holidaysAtWorkLocation } from "../platform"; // Phase 71b (issue #71) — central resolver (computeWeekProgress)
import { getShiftsInRange } from "../scheduling"; // Phase 100B Plan 05 — S1 (computeWeekProgress)
import {
  calcExpectedMinutesTz,
  calcLeaveAbsenceMinutesTz,
  calcMonthlyHoursHolidayMinutesTz, // Issue #433 (D-03/D-06)
  getDayHoursFromSchedule,
  getDayOfWeekInTz,
  dateStrInTz,
  iterateDaysInTz,
  getTenantTimezone, // computeWeekProgress
  monthRangeUtc, // computeWeekProgress
  weekRangeUtc, // computeWeekProgress
} from "./timezone";
import {
  buildSlotOverrideHierarchy,
  resolveBsTagSlot,
  contractWorkDaysPerWeekFrom, // Issue #429 (D-03/D-11) — the ONE fallback-chain implementation
  leaveDaysPerWeek, // Issue #429 (D-01/D-02) — the shared per-week leave-day count
  usualWorkDaysFrom, // Issue #436 (D-03) — the saldo side's one reader of the Angabe
  type WeekContext,
  getActiveLeaveOverlapping, // Issue #446 (D-02) — effective leave (computeWeekProgress)
  getAbsencesOverlapping, // Phase 100B Plan 12 — A4 (computeWeekProgress)
  loadBsSlotOverrides, // Phase 76.31 (D-06) — BS slot overrides (computeWeekProgress)
} from "../absence"; // Phase 101B (Issue #101, wave 7)
import {
  computeDailySollMinutes,
  normalizeUnterrichtsMinutenByDow,
} from "./vocational-school-saldo";
import { shiftBasedLeaveCreditByDate } from "./shift-based-leave-credit"; // Issue #429 (D-06)
import type { ScheduleType } from "@clokr/db";

// ── Public types ──────────────────────────────────────────────────────────────

export type CloseMonthInput = {
  employeeId: string;
  // Month to close
  monthStart: Date; // from monthRangeUtc — UTC timestamp
  monthEnd: Date; // from monthRangeUtc — UTC timestamp
  monthFirstDay: Date; // from monthDayBounds — @db.Date floor
  monthLastDay: Date; // from monthDayBounds — @db.Date ceil
  tz: string;
  carryOverIn: number; // minutes — previous snapshot carryOver (0 if first month)

  // Pre-fetched employee/schedule data
  schedule: Record<string, unknown>;
  hireDate: Date;
  exitDate: Date | null; // CLOSE-04: null = still employed
  isTimeTrackingExempt: boolean; // must be false (caller verifies)
  breakOver6hOverride: number | null;
  breakOver9hOverride: number | null;

  // Pre-fetched collections (PERF: caller batches these)
  entries: Array<{
    // WORK entries, deletedAt=null, endTime!=null, isInvalid=false
    date: Date;
    startTime: Date;
    endTime: Date;
    breakMinutes: bigint | number;
  }>;
  shifts: Array<{
    // SHIFT_BASED: deletedAt=null
    date: Date;
    startTime: string;
    endTime: string;
  }>;
  approvedLeave: Array<{
    startDate: Date;
    endDate: Date;
    halfDay: boolean;
    /**
     * Issue #220 — `true` exactly for `LeaveType.code === "OVERTIME_COMP"` rows
     * (Überstundenausgleich). NOT optional on purpose: a missing value here silently
     * degrades to "ordinary leave", which is the bug this field exists to close, so the
     * compiler must name every call site instead. Build the whole array through
     * {@link toCloseMonthApprovedLeave} rather than deriving the flag inline.
     *
     * Semantics: an OVERTIME_COMP day stays Soll-free like any other approved absence
     * (the day IS paid) AND additionally withdraws exactly that credited amount from the
     * account — see the `overtimeCompensationMinutes` accumulation below.
     */
    isOvertimeCompensation: boolean;
    /**
     * Issue #429 audit (PR #437) — how a SHIFT_BASED row relieves the Soll. NOT optional, for
     * the same reason as `isOvertimeCompensation`: build it through
     * {@link toCloseMonthApprovedLeave} / {@link leaveCreditBasisForCode}, never inline.
     *   - `"CONTRACT"`: the type replaces a contractual workday — contract-week formula
     *     (`leaveDaysPerWeek` × weeklyHours ÷ contract days), roster-independent.
     *   - `"ROSTER"`: the type only pays hours that were actually planned (Lohnausfallprinzip,
     *     § 4 EFZG / § 616 BGB) — the day's rostered shift netto minutes, 0 without a shift.
     * Read only by the SHIFT_BASED branch; every other schedule type ignores it.
     */
    creditBasis: LeaveCreditBasis;
  }>;
  absences: Array<{
    startDate: Date;
    endDate: Date;
    type: string;
    source: string;
    halfDay?: boolean;
    // Phase 76.38 (D-11): per-day Unterrichtszeit for duration-based BS slot
    // classification. NULL/undefined → Pattern fallback (below) or ordinal fallback.
    unterrichtsMinutes?: number | null;
  }>;
  holidayDateStrings: Set<string>; // YYYY-MM-DD in tenant TZ

  // Tenant config
  tenantConfig: {
    defaultBreakOver6h: number;
    defaultBreakOver9h: number;
    // Issue #429 (D-11): tenant fallback for the SHIFT_BASED contractWorkDaysPerWeek chain
    // (contractWorkDaysPerWeekFrom) when the schedule itself has neither
    // contractWorkDaysPerWeek nor a non-empty workDays. Absent → chain falls back to 5.
    // Also the MONTHLY_HOURS workday tier (Issue #433, D-05: workDays → defaultWorkDays →
    // Mo–Fr).
    defaultWorkDays?: number[] | null;
    vocationalSchoolMinutesPerDay?: number | null;
    vocationalSchoolBlockMinutesPerWeek?: number | null;
    // Phase 76.31 — BVaDiG-2024 slot-aware BS crediting (D-06 tenant layer).
    bsSlotFirstLongDayMinutes?: number | null;
    bsSlotSecondLongDayMinutes?: number | null;
    bsSlotShortDayMinutes?: number | null;
    bsSlotBlockWeekMinutes?: number | null;
  } | null;

  // Phase 76.31 — Employee/Pattern bsSlot* override rows (D-06 layers 1+2). Optional:
  // callers thread them in (plan 06 caller wiring). When null → the fallback resolves
  // to the individual daily Soll via the TenantConfig/legacy/daily-Soll layers.
  employeeSlots?: {
    bsSlotFirstLongDayMinutes: number | null;
    bsSlotSecondLongDayMinutes: number | null;
    bsSlotShortDayMinutes: number | null;
    bsSlotBlockWeekMinutes: number | null;
  } | null;
  patternSlots?: {
    bsSlotFirstLongDayMinutes: number | null;
    bsSlotSecondLongDayMinutes: number | null;
    bsSlotShortDayMinutes: number | null;
    bsSlotBlockWeekMinutes: number | null;
  } | null;

  // Phase 76.38 (D-11): active BS pattern's per-DOW Unterrichtszeit map (raw JSON,
  // {"1":300,"4":180}, DOW keys 0=Mo..6=So). Fallback for a BS date whose Absence has
  // no unterrichtsMinutes. Absent/null → ordinal fallback (backward compat).
  patternUnterrichtsMinutenByDow?: unknown;

  // Phase 76.39 (D-07): roster proration for the LIVE current-partial-month path ONLY.
  // Absent → full-month close behaviour (byte-identical parity with the P1/P2/P3/P5
  // close/cron/recalc callers that never pass it). Present only when updateOvertimeAccount
  // computes the open (not-yet-closed) partial month: the effective contract Soll used for
  // the §615 overtime clause is scaled by roster progress (rosterToDate ÷ rosterPeriodFull).
  // Read ONLY by the SHIFT_BASED branch — non-SHIFT never calls calcShiftBasedSaldo.
  // At month end rosterToDateMinutes == rosterPeriodMinutes → factor 1 → identical to close.
  rosterProration?: {
    rosterToDateMinutes: number; // R_toDate    = Σ active shift netto for shift-days ≤ effectiveEnd
    rosterPeriodMinutes: number; // R_periodFull = Σ active shift netto for the WHOLE open month
  };
};

// Re-export so amount-site callers/tests have a single import surface.
export { computeDailySollMinutes };

export type CloseMonthResult = {
  // SaldoSnapshot field values (caller writes to DB)
  workedMinutes: number;
  /**
   * Phase 125 (issue #125, D-01) — distinct calendar days (tenant TZ) inside
   * [effectiveStart, effectiveEnd] whose credited worked minutes are > 0.
   *
   * Produced by the SAME traversal as `workedMinutes` (step 5) plus the SAME BS loop
   * (step 6) that feeds it, so the pair can never disagree the way issue #125 reported
   * ("Ist 62:06 h" printed beside "1 Arbeitstage bisher"). Invariant, asserted in
   * close-employee-month.test.ts: workedMinutes > 0 <=> workedDays > 0.
   */
  workedDays: number;
  expectedMinutes: number; // C_net for SHIFT_BASED; netExpected otherwise
  balanceMinutes: number; // D-01 two-clause for SHIFT_BASED; flat diff otherwise
  carryOverOut: number; // carryOverIn + balanceMinutes (before TRACK_ONLY zeroing)
  effectiveCarryOverOut: number; // 0 if TRACK_ONLY; else = carryOverOut
  snapshotExpectedMinutes: number; // = expectedMinutes for SHIFT_BASED; netExpected otherwise

  /**
   * Issue #220 — the Überstundenausgleich WITHDRAWAL already subtracted from
   * `balanceMinutes` (and therefore from `carryOverOut`), in minutes, always >= 0.
   *
   * It is the sum of the SAME per-row credit values that credited those rows' Soll in the
   * loops below (`calcLeaveAbsenceMinutesTz()` for non-SHIFT; `shiftBasedLeaveCreditByDate()`
   * for the SHIFT_BASED approvedLeave loop since Issue #429) — not a second, independently
   * derived figure. Reported here so a caller/test can read the withdrawal without
   * re-deriving it; no production writer consumes it today.
   */
  overtimeCompensationMinutes: number;

  // Gap detection results (for warning UX in 76.28)
  gaps: WorkdayGap[];
  coveredDates: Set<string>;
};

/**
 * Issue #220 — the ONE derivation of {@link CloseMonthInput.approvedLeave}'s
 * `isOvertimeCompensation` flag, shared by all six `closeEmployeeMonth()` call sites.
 *
 * Centralised deliberately: six inline copies of `lr.leaveType?.code === "OVERTIME_COMP"`
 * are six places that can drift apart, and a drifted copy is invisible — it produces a
 * plausible saldo that is silently 2x the day's hours off (see #220's measurement:
 * approval moved the stored balance +8h where the journal said -8h).
 *
 * The discriminator is the stable `LeaveType.code` enum, never `LeaveType.name` —
 * CLAUDE.md § Context Boundaries forbids display strings as control values.
 */
export type LeaveCreditBasis = "CONTRACT" | "ROSTER";

/**
 * Issue #429 audit (PR #437) — the ONE mapping from `LeaveType.code` to the SHIFT_BASED Soll
 * relief basis. Principle: does the type replace a contractual workday (the obligation for that
 * day is gone, whatever the roster says), or does it only pay the hours that were actually
 * planned (Lohnausfallprinzip)?
 *
 *   ROSTER (pays planned hours only):
 *     - SICK, SICK_CHILD — § 4 Abs. 1 EFZG: continued pay for the working time that is lost; an
 *       unplanned day loses nothing. Kinderkrank (§ 45 SGB V) frees from planned work the same way.
 *     - SPECIAL (Sonderurlaub) — § 616 BGB: pay for a short hindrance during planned work time.
 *   CONTRACT (replaces a contractual workday):
 *     - VACATION — BUrlG; the only entitlement-consuming type (deductVacationDays).
 *     - OVERTIME_COMP — owner decision on issue #293: "the day IS the average contract day";
 *       its withdrawal (#220) must equal this credit.
 *     - EDUCATION — Bildungsurlaub is counted in workdays per year, like vacation.
 *     - UNPAID, MATERNITY, PARENTAL — the work obligation itself is suspended for the period.
 *     - OTHER — the pre-tracking bridge rows that neutralise Soll (leave-type.ts).
 *     - unknown / null code — keeps the pre-audit contract behaviour.
 *
 * Keyed by the stable code enum, never by a display name (CLAUDE.md § Context Boundaries).
 */
export function leaveCreditBasisForCode(code: string | null | undefined): LeaveCreditBasis {
  return code === "SICK" || code === "SICK_CHILD" || code === "SPECIAL" ? "ROSTER" : "CONTRACT";
}

export function toCloseMonthApprovedLeave(
  rows: ReadonlyArray<{
    startDate: Date;
    endDate: Date;
    halfDay: boolean | null;
    leaveType?: { code: string | null } | null;
  }>,
): CloseMonthInput["approvedLeave"] {
  return rows.map((lr) => ({
    startDate: lr.startDate,
    endDate: lr.endDate,
    halfDay: Boolean(lr.halfDay),
    isOvertimeCompensation: lr.leaveType?.code === "OVERTIME_COMP",
    creditBasis: leaveCreditBasisForCode(lr.leaveType?.code),
  }));
}

/**
 * Issue #433 (D-11) — the full calendar month's net Soll of a MONTHLY_HOURS employee,
 * computed BY the saldo core itself rather than by a hand-rolled copy in the composition
 * layer. Every server-side display of a MONTHLY_HOURS month Soll (the month-saldo endpoint,
 * the dashboard tile, the monthly report/PDFs) calls this ONE function, so they can never
 * disagree with each other or with Monatsabschluss — parity is by construction, not by three
 * independently-maintained formulas happening to agree.
 *
 * Returns `null` for every schedule type other than MONTHLY_HOURS, and for MONTHLY_HOURS with
 * `monthlyHours` null/0/negative (pure tracking, D-01) — never a fabricated 0, so a caller can
 * tell "no Soll applies here" apart from "the Soll is zero this month".
 *
 * Internally calls {@link closeEmployeeMonth} over the FULL calendar month
 * (`monthStart`..`monthLastDay`, never a partial window) with `carryOverIn: 0`,
 * `isTimeTrackingExempt: false`, no break overrides, no entries and no shifts — none of
 * those four inputs can change a MONTHLY_HOURS employee's `expectedMinutes` (BS credits
 * contribute to `workedMinutes` only, since `contributesToExpected` is false for MONTHLY_HOURS
 * in the BS loop; see this file's own D-04 comments), so passing the caller's real entries/
 * shifts/carry-over/BS slot overrides would do nothing except cost the caller a fetch they
 * don't need. Callers pass the SAME facade-fetched data the close paths use — effective-status
 * leave (`getActiveLeaveOverlapping`), non-deleted absences (`getAbsencesOverlapping`), and
 * work-location holidays (`holidaysAtWorkLocation`) — through `toCloseMonthApprovedLeave` /
 * the absences mapper below, never a reach-around into Prisma from this pure function.
 */
export function monthlyHoursMonthSollMinutes(input: {
  employeeId: string;
  schedule: Record<string, unknown>;
  monthStart: Date;
  monthEnd: Date;
  monthFirstDay: Date;
  monthLastDay: Date;
  tz: string;
  hireDate: Date;
  exitDate: Date | null;
  leave: Parameters<typeof toCloseMonthApprovedLeave>[0];
  absences: ReadonlyArray<{
    startDate: Date;
    endDate: Date;
    type: string;
    source: string;
    halfDay?: boolean | null;
    unterrichtsMinutes?: number | null;
  }>;
  holidayDateStrings: Set<string>;
  defaultWorkDays: number[] | null | undefined;
}): number | null {
  const scheduleType = String(input.schedule.type ?? "");
  const mh = Number(input.schedule.monthlyHours ?? 0);
  if (scheduleType !== "MONTHLY_HOURS" || !(mh > 0)) return null;

  const result = closeEmployeeMonth({
    employeeId: input.employeeId,
    monthStart: input.monthStart,
    monthEnd: input.monthEnd,
    monthFirstDay: input.monthFirstDay,
    monthLastDay: input.monthLastDay,
    tz: input.tz,
    carryOverIn: 0,
    schedule: input.schedule,
    hireDate: input.hireDate,
    exitDate: input.exitDate,
    isTimeTrackingExempt: false,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    entries: [],
    shifts: [],
    approvedLeave: toCloseMonthApprovedLeave(input.leave),
    absences: input.absences.map((ab) => ({
      startDate: ab.startDate,
      endDate: ab.endDate,
      type: ab.type,
      source: ab.source,
      halfDay: Boolean(ab.halfDay),
      unterrichtsMinutes: ab.unterrichtsMinutes ?? null,
    })),
    holidayDateStrings: input.holidayDateStrings,
    tenantConfig: {
      defaultBreakOver6h: 30,
      defaultBreakOver9h: 45,
      defaultWorkDays: input.defaultWorkDays,
    },
  });
  return result.expectedMinutes;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Phase 104 (D-15) — day-based Soll deduplication.
 *
 * Until this phase, leave/absence Soll was summed PER REQUEST. Two APPROVED rows
 * covering the same calendar day deducted that day twice. That never happened in
 * production only because the overlap guard in routes/leave.ts:220-229 blocked it —
 * the guard plan 104-05 deliberately opens for § 9 BUrlG ("krank im Urlaub"), which
 * makes the overlap the NORMAL case for every § 9 record. Counting a day once is
 * therefore a precondition of that change, not a cleanup.
 *
 * Mechanism: reuse the existing `excludeHolidays: Set<string>` hook on
 * calcLeaveAbsenceMinutesTz / avgWorkMinutesCore — it already means "skip these
 * YYYY-MM-DD dates". We accumulate the dates each processed row has already claimed
 * and pass them in on subsequent rows. No signature change anywhere in timezone.ts.
 *
 * Processing order is deterministic AND semantically chosen:
 *   1. full-day rows before half-day rows  (halfDay ? 1 : 0)
 *   2. then startDate ascending
 *   3. then id ascending (stable tiebreak)
 * Rule 1 resolves OPEN-01: a half-day VACATION overlapped by a full-day SICK must
 * reduce the FULL day's Soll — the employee was sick all day and worked none of it.
 * Crediting only half would silently inflate the Soll on exactly the § 9 target case.
 * (The ENTITLEMENT side is unaffected: D-08 returns 0.5 vacation days, because 0.5
 * is what was charged.)
 *
 * BERUFSSCHULE (v1.8.27 / v1.8.28 subtract-then-recredit) IS DELIBERATELY EXCLUDED:
 * VOCATIONAL_SCHOOL + source=PATTERN absences neither consume nor are blocked by
 * claimedDates. Their Ø-method credit MUST still be subtracted so that
 * bsExpectedMinutes can re-add the precise BBiG-§15 slot credit — suppressing that
 * subtraction while still adding the recredit would inflate Soll.
 *
 * Issue #448 (D-03, owner decision 01.10.2026): a leave row MAY now span a Berufsschultag —
 * the former assumption that the generator's conflict checks kept the two apart no longer
 * holds (resolveLeaveDays() prices a range containing BS days at 0 leave days for them, D-02,
 * but the range itself is still a single approved request). Both leave loops below therefore
 * skip every date in `bsDatesInMonth` (ANY source, PATTERN or MANUAL — see that Set's own
 * comment) for credit AND for claiming, so the day's only Soll reduction is the BS credit
 * (subtract-then-recredit above) — "Berufsschule hat Vorrang". `isBsAbsence()` itself keeps
 * its narrower PATTERN-only scope below; it only decides the ABSENCE-loop carve-out, which is
 * unrelated to and unchanged by this rule.
 */
type DedupRow = { id?: string; startDate: Date; endDate: Date; halfDay?: boolean | null };

function sortForDedup<T extends DedupRow>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (a.halfDay ? 1 : 0) - (b.halfDay ? 1 : 0) ||
      a.startDate.getTime() - b.startDate.getTime() ||
      (a.id ?? "").localeCompare(b.id ?? ""),
  );
}

/**
 * Adds every tenant-local calendar day in [from, to] to `into`. Issue #448 (D-03): `skip`
 * (optional) names dates that must NOT be claimed — a date kept out of `into` can still be
 * claimed by a LATER row's own credit computation instead of being silently excluded by this
 * one's claim. Used for Berufsschultage: a leave row spanning a BS date must not seed that
 * date into sbClaimed/nsClaimed, or a MANUAL-source BS Absence row touching the SAME date
 * would lose its own Ø-Method credit to the (unrelated) dedup this set exists for.
 */
function claimDays(from: Date, to: Date, tz: string, into: Set<string>, skip?: Set<string>): void {
  iterateDaysInTz(from, to, tz, (_dow, dateStr) => {
    if (skip?.has(dateStr)) return;
    into.add(dateStr);
  });
}

/**
 * PATTERN-only Berufsschultag check — used ONLY by the absence-loop carve-out below (deciding
 * whether an absence row claims a day / is excluded by the dedup set). Issue #448 (D-01): the
 * WIDER "does a Berufsschultag exist on this date" question (both PATTERN and MANUAL source)
 * is answered by `bsDatesInMonth` below, which the two LEAVE loops use to make a Berufsschultag
 * win over a leave day regardless of which source produced it.
 */
function isBsAbsence(ab: { type?: string | null; source?: string | null }): boolean {
  return ab.type === "VOCATIONAL_SCHOOL" && ab.source === "PATTERN";
}

/**
 * Pure per-employee-per-month saldo core.
 *
 * Produces byte-identical SaldoSnapshot values to today's manual close (P1,
 * overtime.ts), cron close (P2, auto-close-month.ts), and retroactive recalc
 * (P3, recalculate-snapshots.ts). The four-path parity assertion in
 * close-employee-month.test.ts is the primary regression gate.
 *
 * The function reconciles ALL divergences from RESEARCH.md §2:
 *   - SHIFT_BASED bsExpectedMinutes: INCLUDED (matching P1/P2/P3; live-path gap documented above)
 *   - exitDate handling: effectiveEnd = min(exitDate, monthLastDay) — CLOSE-04; since Issue #447
 *     (D-01) the same clip (as `sollRangeEnd`) also bounds Soll, holidays, leave and absences
 *   - General absence subtraction from netExpected: DONE for non-SHIFT (Issue #433:
 *     MONTHLY_HOURS joined this loop too, no longer excluded)
 *   - SHIFT_BASED leave credit: Issue #429 — derived from shiftBasedLeaveCreditByDate()
 *     (contract-based, via leaveDaysPerWeek()), which passes an EMPTY holiday set (D-05) —
 *     SHIFT_BASED contract Soll stays un-holiday-reduced, exactly as before this change
 *   - snapshotExpectedMinutes sentinel: SHIFT_BASED → C_net, else → netExpected
 *
 * @see CloseMonthInput for parameter documentation.
 * @see RESEARCH.md §5.2 for the full specification this implements.
 */
export function closeEmployeeMonth(input: CloseMonthInput): CloseMonthResult {
  const {
    monthEnd,
    monthFirstDay,
    monthLastDay,
    tz,
    carryOverIn,
    schedule,
    hireDate,
    exitDate,
    breakOver6hOverride,
    breakOver9hOverride,
    entries,
    shifts,
    approvedLeave,
    absences,
    holidayDateStrings,
    tenantConfig,
    employeeSlots,
    patternSlots,
    patternUnterrichtsMinutenByDow,
  } = input;

  const scheduleType = String(schedule.type ?? "");

  /**
   * Issue #220 — Überstundenausgleich WITHDRAWAL accumulator (minutes, >= 0).
   *
   * Filled by BOTH leave loops below (SHIFT_BASED and non-SHIFT) from the value that
   * loop has just credited for the very same row, and subtracted from `balanceMinutes`
   * once, after the branch. Taking the credited value rather than recomputing is the
   * whole point: credit and withdrawal cannot then diverge on half days, on holidays
   * inside the range, or on the D-15 overlap dedup — whatever the Soll reduction was
   * worth is exactly what leaves the account.
   *
   * Model B of #220's two candidate models (owner decision 2026-09-21): the Ausgleichstag
   * stays Soll-free (it is paid), and the withdrawal is booked on top, so the
   * `OvertimeTransaction` journal row and the stored balance move together — a
   * `REDUCTION` row now corresponds to a balance that actually fell.
   *
   * Issue #433 (owner decision 2026-10-03): MONTHLY_HOURS now reaches the non-SHIFT
   * leave loop too (the prior "never reaches either loop" exemption is gone), so the
   * invariant "withdrawal == credit" holds there the SAME way it does for
   * FIXED/FLEXTIME — via the shared rowCredit capture below, not by staying at 0.
   */
  let overtimeCompensationMinutes = 0;

  // ── Step 1: Compute effectiveStart and effectiveEnd ───────────────────────
  //
  // effectiveStart = max(hireDate, monthFirstDay) — TZ-normalized.
  // effectiveEnd   = min(exitDate if within month, monthLastDay) — D-03.
  // exitDate is INCLUSIVE (last working day). If exitDate < monthFirstDay, the
  // caller should skip this employee; the core clamps defensively here.

  const hireDateNorm = new Date(dateStrInTz(hireDate, tz) + "T00:00:00Z");
  const effectiveStart = hireDateNorm > monthFirstDay ? hireDateNorm : monthFirstDay;

  let effectiveEnd = monthLastDay;
  // Issue #447 (D-01/D-13) — hoisted out of the `if` block below so it is visible to the
  // sollRangeEnd computation that follows. `null` means "still employed" (CLOSE-04) or
  // "exit does not fall before monthLastDay" (effectiveEnd already covers both).
  let exitDateNorm: Date | null = null;
  if (exitDate !== null) {
    exitDateNorm = new Date(dateStrInTz(exitDate, tz) + "T00:00:00Z");
    if (exitDateNorm < monthFirstDay) {
      // Employee left before this month — return zeroed result.
      return {
        workedMinutes: 0,
        workedDays: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOverOut: carryOverIn,
        effectiveCarryOverOut: carryOverIn,
        snapshotExpectedMinutes: 0,
        overtimeCompensationMinutes: 0,
        gaps: [],
        coveredDates: new Set<string>(),
      };
    }
    if (exitDateNorm < monthLastDay) {
      effectiveEnd = exitDateNorm;
    }
  }

  // Issue #447 (D-01/D-13) — the upper bound of every Soll, holiday, leave and absence
  // computation of this month, mirroring effectiveStart on the hire side. Without an exit
  // before monthEnd it IS the caller's monthEnd (the same Date object), so every no-exit
  // caller — including the live SHIFT_BASED roster proration, which needs the full-month
  // C_net — is byte-identical. With an exit before monthEnd, every site below clips to it.
  const sollRangeEnd = exitDateNorm !== null && exitDateNorm < monthEnd ? exitDateNorm : monthEnd;

  // ── Step 2: Compute entry dates set ──────────────────────────────────────
  //
  // Only entries within [effectiveStart, effectiveEnd] are relevant.
  // The entries array is pre-filtered by the caller (deletedAt=null, type=WORK,
  // isInvalid=false, endTime!=null). We apply the employment-span filter here.

  const entryDates = new Set<string>();
  for (const e of entries) {
    const ds = dateStrInTz(e.date, tz);
    if (ds >= dateStrInTz(effectiveStart, tz) && ds <= dateStrInTz(effectiveEnd, tz)) {
      entryDates.add(ds);
    }
  }

  // ── Step 3: Build rosterDates for SHIFT_BASED ────────────────────────────
  //
  // SHIFT_BASED: expected days = Shift.date set (not getDayHoursFromSchedule — pitfall A4 fix).
  // Non-SHIFT: rosterDates not needed (findMissingWorkdays uses getDayHoursFromSchedule).

  const rosterDates =
    scheduleType === "SHIFT_BASED"
      ? new Set(
          shifts
            .map((sh) => dateStrInTz(sh.date, tz))
            .filter(
              (ds) => ds >= dateStrInTz(effectiveStart, tz) && ds <= dateStrInTz(effectiveEnd, tz),
            ),
        )
      : undefined;

  // ── Step 4: Call findMissingWorkdays ONCE ────────────────────────────────
  //
  // Pitfall A1 fix: the returned coveredDates is REUSED by the SHIFT_BASED
  // roster-exclusion loop below — one covered-date computation, no drift.
  //
  // approvedLeave and absences for gap detection are bounded to [effectiveStart, effectiveEnd]
  // by findMissingWorkdays internally (span guard).

  const gapResult = findMissingWorkdays({
    schedule,
    effectiveStart,
    effectiveEnd,
    tz,
    entryDates,
    approvedLeave: approvedLeave.map((lr) => ({
      startDate: lr.startDate,
      endDate: lr.endDate,
      halfDay: lr.halfDay,
    })),
    absences: absences.map((ab) => ({
      startDate: ab.startDate,
      endDate: ab.endDate,
      halfDay: ab.halfDay,
    })),
    holidayDateStrings,
    rosterDates,
  });

  const { gaps, coveredDates } = gapResult;

  // ── Step 5: Compute workedMinutes ─────────────────────────────────────────
  //
  // Sum net durations (endTime - startTime - breakMinutes) for all entries within
  // [effectiveStart, effectiveEnd]. The entry pre-filter at step 2 already ensures
  // all entries in the set are within the employment span.

  const effectiveStartStr = dateStrInTz(effectiveStart, tz);
  const effectiveEndStr = dateStrInTz(effectiveEnd, tz);

  // Phase 125 (D-01): one traversal, two outputs. This per-day minute map (below) tracks
  // net minutes so `workedDays` (step 8) is derived from the SAME filtered entry set that
  // produces `workedMinutes` — the divergence issue #125 reported is not repaired here, it is
  // made unconstructible.
  //
  // The step-2 distinct-days Set above was deliberately NOT reused, although it spans the
  // identical day range: it is built BEFORE the net duration is known, so it would also count a
  // day whose entries net to 0 minutes (contradicting D-03's "days with worked minutes > 0"), and
  // it knows nothing about the Berufsschule credit that step 6 adds to the SAME returned
  // `workedMinutes` (step 8: totalWorked = workedMinutes + bsWorkedMinutes). That Set keeps its
  // own job — gap detection via findMissingWorkdays — untouched.
  const workedMinutesByDate = new Map<string, number>();

  let workedMinutes = 0;
  for (const e of entries) {
    const ds = dateStrInTz(e.date, tz);
    if (ds < effectiveStartStr || ds > effectiveEndStr) continue;
    const netMinutes =
      (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
    workedMinutes += netMinutes;
    workedMinutesByDate.set(ds, (workedMinutesByDate.get(ds) ?? 0) + netMinutes);
  }

  // ── Step 6: Compute BS-doubling (pure inline, no DB) ──────────────────────
  //
  // VOCATIONAL_SCHOOL absence dates are collected from the provided absences array.
  // ISO-week counts are computed from the same array (no DB access needed for the
  // block-week cap). This replicates the semantics of getVocationalSchoolMinutesForDate
  // but operates on the pre-fetched data.
  //
  // D-01: BS minutes add to BOTH workedMinutes AND expectedMinutes for Soll-bearing
  // types (FIXED/FLEXTIME/SHIFT_BASED), keeping the balance neutral.
  // D-04: MONTHLY_HOURS adds to workedMinutes ONLY (no Soll target).
  //
  // v1.8.27: VOCATIONAL_SCHOOL / PATTERN absences are INCLUDED in the leave/absence Soll-
  // credit loop (subtract-then-recredit — the day's Ø-Method average is removed from
  // contractSoll, then the precise §15 slot credit is re-added via bsExpectedMinutes) so a
  // BS day's Soll is counted exactly once. All four saldo paths share this single core.

  // Phase 76.31 (B): slot-aware BS amount. The FIRST_LONG_DAY credit is the individual
  // daily Soll (round(weeklyHours*60/workDaysPerWeek), e.g. 38h/4-day → 570), NOT the flat
  // 480 pauschal. Build the D-06 4-layer hierarchy once (Employee ?? Pattern ?? TenantConfig
  // ?? legacy ?? daily-Soll); resolve each BS date via resolveBsTagSlot (block-week wins).
  const bsDailySollMinutes = computeDailySollMinutes(
    schedule as Parameters<typeof computeDailySollMinutes>[0],
  );
  const bsHierarchy = buildSlotOverrideHierarchy({
    employee: employeeSlots ?? null,
    pattern: patternSlots ?? null,
    tenantConfig: {
      bsSlotFirstLongDayMinutes: tenantConfig?.bsSlotFirstLongDayMinutes ?? null,
      bsSlotSecondLongDayMinutes: tenantConfig?.bsSlotSecondLongDayMinutes ?? null,
      bsSlotShortDayMinutes: tenantConfig?.bsSlotShortDayMinutes ?? null,
      bsSlotBlockWeekMinutes: tenantConfig?.bsSlotBlockWeekMinutes ?? null,
      vocationalSchoolMinutesPerDay: tenantConfig?.vocationalSchoolMinutesPerDay ?? null,
      vocationalSchoolBlockMinutesPerWeek:
        tenantConfig?.vocationalSchoolBlockMinutesPerWeek ?? null,
    },
    dailySollMinutes: bsDailySollMinutes,
  });

  // Build set of distinct VOCATIONAL_SCHOOL dates within [effectiveStart, effectiveEnd]
  // from the provided absences array. Group by ISO week (Mon–Sun, UTC-based per
  // vocational-school-saldo.ts:41–52 semantics).
  const bsDatesInMonth = new Set<string>();
  for (const ab of absences) {
    if (ab.type !== "VOCATIONAL_SCHOOL") continue;
    const abStart = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
    const abEnd = ab.endDate > monthEnd ? monthEnd : ab.endDate;
    if (abStart > abEnd) continue;
    const cur = new Date(abStart.getTime());
    while (true) {
      const ds = dateStrInTz(cur, tz);
      if (ds > dateStrInTz(abEnd, tz)) break;
      if (ds >= effectiveStartStr && ds <= effectiveEndStr) {
        bsDatesInMonth.add(ds);
      }
      cur.setTime(cur.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  // Group BS dates by ISO week key ("YYYY-Www") for block-week cap computation.
  // ISO week: Monday-based. Monday = day 1 (0=Sun → 6=Sat in Date.getUTCDay).
  function isoWeekKey(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00Z");
    const dow = d.getUTCDay(); // 0=Sun…6=Sat
    const daysSinceMon = (dow + 6) % 7;
    const monday = new Date(d.getTime());
    monday.setUTCDate(d.getUTCDate() - daysSinceMon);
    // Use ISO year-week: year of the Monday + week number
    const year = monday.getUTCFullYear();
    const startOfYear = new Date(Date.UTC(year, 0, 1));
    const weekNum = Math.ceil(
      ((monday.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getUTCDay() + 1) / 7,
    );
    return `${year}-W${String(weekNum).padStart(2, "0")}`;
  }

  // Count distinct BS dates per ISO week (using the full absences array, not just
  // bsDatesInMonth, to match the DB version which counts ALL BS days in the same
  // ISO week — including days outside the effective span that may be in the same week).
  // Phase 76.38 (D-11): per-date Unterrichtszeit for duration-based BS slot
  // classification. Absence.unterrichtsMinutes (per-day override) ?? Pattern
  // unterrichtsMinutenByDow[dow] ?? null. Null entries → ordinal fallback (closed
  // months unchanged, since their Absence rows carry NULL unterrichtsMinutes).
  const patternDowMap = normalizeUnterrichtsMinutenByDow(patternUnterrichtsMinutenByDow);
  const bsDurationByDate = new Map<string, number | null>();

  const bsDatesAllByWeek = new Map<string, Set<string>>();
  for (const ab of absences) {
    if (ab.type !== "VOCATIONAL_SCHOOL") continue;
    const cur = new Date(ab.startDate.getTime());
    const endLimit = ab.endDate;
    while (true) {
      const ds = dateStrInTz(cur, tz);
      if (ds > dateStrInTz(endLimit, tz)) break;
      const wk = isoWeekKey(ds);
      if (!bsDatesAllByWeek.has(wk)) bsDatesAllByWeek.set(wk, new Set());
      bsDatesAllByWeek.get(wk)!.add(ds);
      // Duration: per-day Absence override wins; else Pattern DOW fallback; else null.
      // A multi-day VOCATIONAL_SCHOOL row shares one unterrichtsMinutes across its span.
      if (ab.unterrichtsMinutes != null) {
        bsDurationByDate.set(ds, ab.unterrichtsMinutes);
      } else {
        const dow = (new Date(ds + "T00:00:00Z").getUTCDay() + 6) % 7; // 0=Mo..6=So
        bsDurationByDate.set(ds, patternDowMap[dow] ?? null);
      }
      cur.setTime(cur.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  let bsWorkedMinutes = 0;
  let bsExpectedMinutes = 0;
  for (const ds of bsDatesInMonth) {
    const wk = isoWeekKey(ds);
    const weekSet = bsDatesAllByWeek.get(wk) ?? new Set([ds]);
    // Sorted distinct BS dates in this ISO week → 1-based ordinal for the slot resolver.
    const bsDatesInWeek = Array.from(weekSet).sort();
    const daysInWeek = bsDatesInWeek.length;
    const ordinalInWeek = bsDatesInWeek.indexOf(ds) + 1; // 1-based
    // Phase 76.38 (D-11): per-date Unterrichtszeit map for this ISO week (null → ordinal).
    const unterrichtsMinutesByDate: Record<string, number | null> = {};
    for (const d of bsDatesInWeek) {
      unterrichtsMinutesByDate[d] = bsDurationByDate.get(d) ?? null;
    }
    const weekContext: WeekContext = {
      bsDatesInWeek,
      isBlockWeek: daysInWeek >= 5,
      unterrichtsMinutesByDate,
    };

    const res = resolveBsTagSlot(
      new Date(ds + "T00:00:00Z"),
      ordinalInWeek,
      weekContext,
      bsHierarchy,
      scheduleType as ScheduleType,
    );

    bsWorkedMinutes += res.creditedMinutes;
    // Phase 125 (D-01): step 8 returns totalWorked = workedMinutes + bsWorkedMinutes, so a BS day
    // carrying a BBiG-§15 credit IS a worked day for this count. Without this line the invariant
    // "workedMinutes > 0 <=> workedDays > 0" would break for an Azubi whose month contains only
    // Berufsschule days: minutes > 0, days == 0.
    workedMinutesByDate.set(ds, (workedMinutesByDate.get(ds) ?? 0) + res.creditedMinutes);
    // D-04: MONTHLY_HOURS credits worked only (contributesToExpected === false).
    if (res.contributesToExpected) {
      bsExpectedMinutes += res.creditedMinutes;
    }
  }

  // ── Step 7: Branch on schedule type ──────────────────────────────────────
  //
  // SHIFT_BASED: Model B + §615 via calcShiftBasedSaldo.
  //   R = Σ netto active shifts (deletedAt=null, coveredDates excluded) — reusing
  //       the SAME coveredDates from findMissingWorkdays (pitfall A1 fix).
  //   C_net = calcExpectedMinutesTz − leave credits − absence credits (incl. BS/PATTERN,
  //           v1.8.27 subtract-then-recredit) + bsExpectedMinutes.
  //   No rosterProration (close = full month, not live open month).
  //   expectedMinutes = C_net (stored in SaldoSnapshot.expectedMinutes — not R, D-07).
  //   shiftBalanceOverride = balanceDelta + (bsWorkedMinutes − bsExpectedMinutes)  (Phase 76.31 (A):
  //     BS day net-neutral — worked==expected, contributes 0 outside the §615 floors).
  //
  // Non-SHIFT (FIXED/FLEXTIME/MONTHLY_HOURS):
  //   netExpected = calcExpectedMinutesTz − holidayMinutes − leaveMinutes − absenceMinutes.
  //   Add bsExpectedMinutes to expectedMinutes.
  //   balanceMinutes = totalWorked − netExpected.

  let expectedMinutes: number;
  let holidayMinutes = 0;
  let leaveMinutes = 0;
  let absenceMinutes = 0;
  let shiftBalanceOverride: number | null = null;

  if (scheduleType === "SHIFT_BASED") {
    // ── SHIFT_BASED branch ────────────────────────────────────────────────

    // R = Σ netto active shifts (deletedAt=null already pre-filtered; coveredDates excluded).
    // Reuse coveredDates from findMissingWorkdays (pitfall A1 fix — one covered-date set).
    const hmToMin = (hm: string): number => {
      const [h, m] = hm.split(":").map(Number);
      return (h ?? 0) * 60 + (m ?? 0);
    };
    const employeeBreakShape = {
      breakOver6hOverride: breakOver6hOverride ?? null,
      breakOver9hOverride: breakOver9hOverride ?? null,
    };
    const tenantBreakShape = {
      defaultBreakOver6h: tenantConfig?.defaultBreakOver6h ?? 30,
      defaultBreakOver9h: tenantConfig?.defaultBreakOver9h ?? 45,
    };

    let shiftMinutes = 0; // R = Σ netto active shifts
    // Issue #429 audit: planned netto minutes per day INCLUDING covered days — the relief a
    // ROSTER-basis leave row (sick, Sonderurlaub) gets on that day. Same netto rule as R.
    const plannedNettoByDate = new Map<string, number>();
    for (const sh of shifts) {
      const shDs = dateStrInTz(sh.date, tz);
      // Only count shifts within effective span
      if (shDs < effectiveStartStr || shDs > effectiveEndStr) continue;
      let brutto = hmToMin(sh.endTime) - hmToMin(sh.startTime);
      if (brutto < 0) brutto += 24 * 60; // cross-midnight (e.g. 22:00–06:00)
      if (brutto <= 0) continue;
      const breakMin = getEffectiveBreakDuration(employeeBreakShape, tenantBreakShape, brutto);
      const netto = Math.max(0, brutto - breakMin);
      plannedNettoByDate.set(shDs, (plannedNettoByDate.get(shDs) ?? 0) + netto);
      // Exclude shifts on covered dates from R (leave/absence/holiday — Ausfallprinzip)
      if (coveredDates.has(shDs)) continue;
      shiftMinutes += netto;
    }

    // C_net = contract Ø-Methode Soll (via calcExpectedMinutesTz) minus leave/absence credits
    // (Ausfallprinzip). VOCATIONAL_SCHOOL + source=PATTERN excluded from credit loop — handled
    // via bsExpectedMinutes (D-06, Phase 63). Holiday credit included automatically by
    // calcExpectedMinutesTz. No excludeHolidays passed (consistent with all four paths; see
    // RESEARCH.md §2 "SHIFT_BASED leave credit excludeHolidays" row).
    // Issue #447 (D-13): sollRangeEnd is the caller's monthEnd unless the exit day precedes
    // it, so the live roster proration keeps its full-month C_net for every still-employed
    // month and its period ends at the exit date otherwise.
    const contractSoll = calcExpectedMinutesTz(schedule, effectiveStart, sollRangeEnd, tz);

    // Phase 104 (D-15): sbClaimed accumulates the calendar days already credited by a
    // processed leave/absence row, shared across BOTH loops below, so a day covered by
    // two overlapping APPROVED rows is deducted exactly once. See sortForDedup/claimDays/
    // isBsAbsence doc block above for the full rationale (processing order, OPEN-01, and
    // why BS rows neither consume nor are excluded by this set).
    const sbClaimed = new Set<string>();

    // Issue #429 (D-06..D-09): the SHIFT_BASED approvedLeave credit no longer goes through
    // the Ø-Methode helper (which credits weeklyHours ÷ workDays.length, only on `workDays`
    // days — wrong for "N contract days a week, the roster decides which"). Instead,
    // shiftBasedLeaveCreditByDate() derives a per-date credit map from the SAME
    // contract-based week count Abwesenheiten uses for entitlement (leaveDaysPerWeek,
    // D-01/D-02), capped per ISO-week-part at that part's own contract Soll (D-08). The
    // per-row loop below is UNCHANGED in shape (sortForDedup, sbClaimed dedup,
    // Math.round-per-row, OVERTIME_COMP withdrawal, claimDays) — only where a row's credit
    // comes from has changed (a lookup into this map, not a fresh per-row calculation).
    // See shift-based-leave-credit.ts's own docblock for the algorithm and D-05's "no holidays
    // on this side" reasoning.
    const contractWorkDaysPerWeek = contractWorkDaysPerWeekFrom(
      schedule as { contractWorkDaysPerWeek?: number | null; workDays?: number[] | null },
      tenantConfig?.defaultWorkDays ?? null,
    );
    const sbLeaveCreditByDate = shiftBasedLeaveCreditByDate(
      // Full, unclipped startDate/endDate (D-07) — clipping happens inside. D-05: EMPTY
      // holiday set on the saldo side (see shift-based-leave-credit.ts's docblock).
      // Issue #429 audit: only CONTRACT-basis rows count toward the contract week; a sick day
      // must not turn a fragment into a whole week or shift the week's shares. Phase 436 (D-03):
      // the contract-week count honours the Angabe for fragment weeks exactly like entitlement.
      leaveDaysPerWeek(
        // `!== "ROSTER"` (not `=== "CONTRACT"`): a row built without the field (untyped test
        // fixtures, legacy callers) keeps the contract behaviour, matching the row loop below.
        approvedLeave.filter((lr) => lr.creditBasis !== "ROSTER"),
        contractWorkDaysPerWeek,
        // Issue #448 (D-03): a Berufsschultag is excluded from the per-week day count and
        // distribution exactly like a holiday would be — this is what makes a Mo-Fr leave row
        // spanning a BS Tuesday credit the SAME 4 days, with the SAME per-date share, as two
        // separate rows priced around the BS date (the D-03 equivalence oracle). D-05's "no
        // statutory holidays on this side" is unaffected — this Set carries ONLY Berufsschultage.
        bsDatesInMonth,
        usualWorkDaysFrom(schedule as { type?: string | null; usualWorkDays?: number[] | null }),
      ),
      contractWorkDaysPerWeek,
      schedule,
      effectiveStart,
      sollRangeEnd,
      tz,
    );

    let sbLeaveCredit = 0;
    for (const lr of sortForDedup(approvedLeave)) {
      const leaveStart = lr.startDate < effectiveStart ? effectiveStart : lr.startDate;
      const leaveEnd = lr.endDate > sollRangeEnd ? sollRangeEnd : lr.endDate;
      if (leaveStart > leaveEnd) continue;
      // D-09: a date already claimed by an EARLIER row in this same sorted loop contributes
      // nothing to THIS row ("first to claim" — mirrors the old excludeHolidays: sbClaimed
      // mechanism, now applied to the per-date credit map instead of to avgWorkMinutesCore).
      // Issue #429 audit: a ROSTER-basis row (sick, Sonderurlaub) relieves the day's planned
      // shift netto (half of it for a half day), 0 on an unplanned day — § 4 EFZG. The same
      // first-claim rule applies to both bases, so a mixed sick + vacation day is reduced once.
      // Issue #448 (D-03): a Berufsschultag contributes NO leave credit either — it is type-
      // agnostic, so this skip covers BOTH credit bases (the CONTRACT lookup above already
      // excludes it via bsDatesInMonth in leaveDaysPerWeek; the ROSTER planned-netto lookup
      // does not exclude it on its own, so this explicit check is load-bearing for ROSTER rows).
      let rowCredit = 0;
      iterateDaysInTz(leaveStart, leaveEnd, tz, (_dow, dateStr) => {
        if (sbClaimed.has(dateStr) || bsDatesInMonth.has(dateStr)) return;
        rowCredit +=
          lr.creditBasis === "ROSTER"
            ? (plannedNettoByDate.get(dateStr) ?? 0) * (lr.halfDay ? 0.5 : 1)
            : (sbLeaveCreditByDate.get(dateStr) ?? 0);
      });
      rowCredit = Math.round(rowCredit); // D-09: round once, per row
      sbLeaveCredit += rowCredit;
      // Issue #220: the withdrawal is THIS row's credit, not a second computation of it.
      if (lr.isOvertimeCompensation) overtimeCompensationMinutes += rowCredit;
      // Issue #448 (D-03): do NOT claim a Berufsschultag into sbClaimed — a MANUAL-source BS
      // Absence row touching the same date must still receive its own Ø-Method credit below
      // (isBsAbsence() is PATTERN-only, so a MANUAL BS row is NOT exempted from the sbClaimed
      // exclusion there; seeding the date here would silently erase that row's own credit).
      claimDays(leaveStart, leaveEnd, tz, sbClaimed, bsDatesInMonth);
    }

    let sbAbsenceCredit = 0;
    for (const ab of sortForDedup(absences)) {
      // v1.8.27 (BS double-count fix): ALL absence types are credited here — including
      // VOCATIONAL_SCHOOL / source=PATTERN. contractSoll (avgWorkMinutesCore) has NO BS
      // awareness: it counts every {day}Hours>0 calendar day as a contracted workday,
      // so a BS day that lands on a normal workday IS already inside contractSoll once
      // (at the Ø-Method daily average). We therefore subtract that same Ø-Method day
      // credit here, then re-add the precise BBiG-§15 slot credit via bsExpectedMinutes
      // below — so each BS day's Soll appears EXACTLY ONCE (subtract-then-recredit).
      // This makes the SHIFT_BASED branch symmetric with the non-SHIFT branch's
      // `absenceMinutes` reduce (below), which never excluded BS days and was therefore
      // never affected by the double-count. Previously this loop skipped
      // VOCATIONAL_SCHOOL/PATTERN, leaving the BS day in contractSoll AND adding
      // bsExpectedMinutes on top → inflated Soll/Ist (prod: 247:00 on a 38h contract).
      //
      // Phase 104 (D-15) BS-exclusion: a VOCATIONAL_SCHOOL/PATTERN row neither claims a
      // day into sbClaimed NOR is excluded by a day another row already claimed — see the
      // isBsAbsence() doc block above. Every other absence participates in the same
      // day-based dedup as approvedLeave.
      const absStart = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
      const absEnd = ab.endDate > sollRangeEnd ? sollRangeEnd : ab.endDate;
      if (absStart > absEnd) continue;
      const bs = isBsAbsence(ab);
      sbAbsenceCredit += calcLeaveAbsenceMinutesTz(schedule, absStart, absEnd, tz, {
        halfDay: Boolean(ab.halfDay),
        excludeHolidays: bs ? undefined : sbClaimed,
      });
      if (!bs) claimDays(absStart, absEnd, tz, sbClaimed);
    }

    // C_net: contract Soll net of leave/absence credits (incl. the BS day's Ø-Method day
    // credit, subtracted above) + bsExpectedMinutes (the precise BBiG §15 BS slot credit).
    // BS day = Arbeitstag: its Soll now appears exactly ONCE — the Ø-Method average removed
    // from contractSoll, the §15 slot credit added back. When the §15 slot credit equals the
    // Ø-Method day average (the common no-slot-override case) the two cancel and cNet is
    // unchanged by the BS day; when they differ (block-week / FIRST_LONG_DAY / duration slots)
    // cNet correctly reflects the §15 credit instead of the flat average.
    const cNet = Math.max(0, contractSoll - sbLeaveCredit - sbAbsenceCredit) + bsExpectedMinutes;

    // Pass W = workedMinutes (entries only) AND bsWorkedMinutes into calcShiftBasedSaldo.
    // bsExpectedMinutes is folded into C_net above (sets expectedMinutes = C_net so the stored
    // snapshot worked/expected pair stays balanced). v1.8.28 (§615 BS-overtime-swallow fix): the
    // BS §15 credit is now pooled into the OVERTIME clause via bsWorkedMinutes so it cancels the
    // bsExpectedMinutes inside C_net — a BS day stays Soll-neutral, but genuine overtime on
    // non-BS (salon) days is no longer swallowed by the BS-inflated threshold. Previously W was
    // passed WITHOUT bsWorkedMinutes and BS was applied as a separate (bsWorked − bsExpected)
    // override term OUTSIDE the §615 floors; for SHIFT_BASED bsWorked === bsExpected (both are
    // resolveBsTagSlot.creditedMinutes, contributesToExpected=true), so that term was structurally
    // always 0 and the BS credit never reached the worked side → salon overtime measured against
    // a Soll that already included the BS Soll, yielding +0. See shift-based-saldo.ts header.
    const sbSaldo = calcShiftBasedSaldo({
      contractSollMinutes: cNet,
      rosterMinutes: shiftMinutes,
      workedMinutes: workedMinutes,
      bsWorkedMinutes: bsWorkedMinutes,
      // Phase 76.39 (D-07): live current-partial-month path passes rosterProration to scale
      // the effective Soll by roster progress. Absent (close/cron/recalc) → full-month
      // behaviour, byte-identical to before. See CloseMonthInput.rosterProration doc.
      rosterProration: input.rosterProration,
    });

    expectedMinutes = sbSaldo.expectedMinutes; // = C_net (stored in SaldoSnapshot — not R, D-07)
    // balanceDelta already reflects BS neutrality via the pooled overtime clause (bsWorked in the
    // numerator cancels bsExpected inside C_net). No separate BS override term is added.
    shiftBalanceOverride = sbSaldo.balanceDelta;

    // leaveMinutes / absenceMinutes / holidayMinutes stay 0:
    // Credits are folded into C_net. Leaving them 0 prevents double-deduction at
    // the netExpected site (which SHIFT_BASED bypasses via shiftBalanceOverride anyway).
    leaveMinutes = 0;
    absenceMinutes = 0;
    holidayMinutes = 0;
  } else {
    // ── Non-SHIFT branch (FIXED_SCHEDULE, FIXED_WEEKLY, FLEXTIME, MONTHLY_HOURS) ──

    // Issue #447 (D-01/D-02): sollRangeEnd clips the Soll at the exit date.
    // Issue #433 (D-05): defaultWorkDays threaded through for MONTHLY_HOURS — every
    // other schedule type ignores this argument.
    expectedMinutes = calcExpectedMinutesTz(
      schedule,
      effectiveStart,
      sollRangeEnd,
      tz,
      undefined,
      tenantConfig?.defaultWorkDays,
    );

    // Holiday subtraction: holidayDateStrings is pre-computed by the caller (merged
    // computed Feiertage + DB manual holidays).
    //
    // Issue #433 (D-03/D-06, owner decision 2026-10-03): for MONTHLY_HOURS a holiday on
    // a contractual workday ALWAYS reduces the Soll by the Ø-rate value — the retired
    // per-tenant holiday-deduction switch (Issue #433, D-04) is no longer read anywhere
    // in this function (§ 2 Abs. 1 / § 12 EFZG is unabdingbar; a tenant cannot opt out).
    // `calcMonthlyHoursHolidayMinutesTz` owns the day-membership test (D-05: workDays ->
    // defaultWorkDays -> Mo-Fr, never {day}Hours) and the full-calendar-month denominator
    // (D-06), shared with the full-Soll and leave/absence branches above/below. Every
    // other non-SHIFT type keeps the existing per-holiday {day}Hours loop, byte-identical.
    if (scheduleType === "MONTHLY_HOURS") {
      const filteredHolidayDateStrings = new Set<string>();
      for (const hDateStr of holidayDateStrings) {
        // Issue #447 — holidays after the exit date are not deducted. Callers already
        // pre-filter holidayDateStrings to [effectiveStart, monthEnd], so a no-exit
        // input (effectiveEndStr === monthEnd's date) is unaffected by this guard.
        if (hDateStr < effectiveStartStr || hDateStr > effectiveEndStr) continue;
        filteredHolidayDateStrings.add(hDateStr);
      }
      holidayMinutes = calcMonthlyHoursHolidayMinutesTz(
        schedule,
        filteredHolidayDateStrings,
        effectiveStart,
        sollRangeEnd,
        tz,
        tenantConfig?.defaultWorkDays,
      );
    } else {
      for (const hDateStr of holidayDateStrings) {
        // Issue #447 — holidays after the exit date are not deducted. Callers already
        // pre-filter holidayDateStrings to [effectiveStart, monthEnd], so a no-exit input
        // (effectiveEndStr === monthEnd's date) is unaffected by this guard.
        if (hDateStr < effectiveStartStr || hDateStr > effectiveEndStr) continue;
        const hDate = new Date(hDateStr + "T00:00:00Z");
        const dow = getDayOfWeekInTz(hDate, tz);
        holidayMinutes += getDayHoursFromSchedule(schedule, dow) * 60;
      }
    }

    // D-06: holiday dates as Set<string> for excludeHolidays inside leave/absence Soll-reduction,
    // so a holiday inside an approved leave/absence range is NOT double-deducted.
    // holidayDateStrings is already YYYY-MM-DD in tenant TZ from the caller.
    const holidayExcludeSet = holidayDateStrings;

    // Issue #433 (D-07, owner decision 2026-10-03): the leave/absence loops below now
    // run for MONTHLY_HOURS too — the previous "holiday/absence deductions do NOT apply"
    // exemption guard is gone. The loop bodies are unchanged except for the one BS skip
    // added inside the absence loop below (a MONTHLY_HOURS Berufsschultag is already
    // credited by the BS loop above, so it must not ALSO reduce the Soll here).
    //
    // Phase 104 (D-15): nsClaimed starts as a COPY of holidayExcludeSet (D-06 holidays +
    // D-15 claimed days) — a COPY, not an alias, so claiming a leave/absence day here can
    // never mutate the caller-owned holidayDateStrings Set. Seeding from the holiday set is
    // harmless: a holiday was already excluded, and adding a leave day to the same set is
    // exactly the intended semantics (skip this YYYY-MM-DD for whichever reason it's in the
    // set). Shared across BOTH loops below so an overlapping leave+absence day on the same
    // date is deducted exactly once. See sortForDedup/claimDays/isBsAbsence doc block above.
    const nsClaimed = new Set<string>(holidayExcludeSet);

    for (const lr of sortForDedup(approvedLeave)) {
      const leaveStart = lr.startDate < effectiveStart ? effectiveStart : lr.startDate;
      // Issue #447 (D-01): sollRangeEnd clips the leave credit at the exit date.
      const leaveEnd = lr.endDate > sollRangeEnd ? sollRangeEnd : lr.endDate;
      if (leaveStart > leaveEnd) continue;
      // Issue #448 (D-03): a per-row union (never a mutation of nsClaimed, which is shared
      // and re-read by every later row) — a Berufsschultag inside this row's range credits
      // nothing here, its Soll reduction coming exclusively from the BS credit above. A
      // half-day request is a single date (#449): when that date is a Berufsschultag, `raw`
      // (computed over the excluded range) is already 0 before the halfDay halving runs, so
      // no separate half-day override is needed here (unlike the pricing-side kernels).
      const rowCredit = calcLeaveAbsenceMinutesTz(schedule, leaveStart, leaveEnd, tz, {
        halfDay: Boolean(lr.halfDay),
        excludeHolidays: new Set([...nsClaimed, ...bsDatesInMonth]), // D-06 holidays + D-15 claimed days + D-03 BS days
        defaultWorkDays: tenantConfig?.defaultWorkDays, // Issue #433 (D-05) — MONTHLY_HOURS only
      });
      leaveMinutes += rowCredit;
      // Issue #220: the withdrawal is THIS row's credit, not a second computation of it.
      if (lr.isOvertimeCompensation) overtimeCompensationMinutes += rowCredit;
      // Issue #448 (D-03): do not claim a Berufsschultag into nsClaimed — see the matching
      // comment on the SHIFT_BASED leave loop above for why (a MANUAL BS Absence row must
      // keep its own Ø-Method credit).
      claimDays(leaveStart, leaveEnd, tz, nsClaimed, bsDatesInMonth);
    }

    for (const ab of sortForDedup(absences)) {
      // Phase 104 (D-15) BS-exclusion: a VOCATIONAL_SCHOOL/PATTERN row neither claims a day
      // into nsClaimed nor is excluded by a day another row already claimed — see the
      // isBsAbsence() doc block above. This branch never special-cased BS before (unlike the
      // SHIFT_BASED subtract-then-recredit above), so the carve-out here simply keeps that
      // pre-existing behaviour unchanged while every other absence participates in dedup.
      const absStart = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
      // Issue #447 (D-01): sollRangeEnd clips the absence credit at the exit date.
      const absEnd = ab.endDate > sollRangeEnd ? sollRangeEnd : ab.endDate;
      if (absStart > absEnd) continue;
      // Issue #433 (D-07): for MONTHLY_HOURS a Berufsschultag is already credited to
      // workedMinutes by the BS loop above (res.contributesToExpected === false there,
      // Phase 76.x D-04) — reducing the Soll here too would count the day twice ("a day
      // reduces Soll exactly once"). This skip is MONTHLY_HOURS-only and covers any
      // VOCATIONAL_SCHOOL row regardless of source (PATTERN or MANUAL); FIXED/FLEXTIME
      // keep the existing subtract-then-recredit behaviour via isBsAbsence() below.
      if (scheduleType === "MONTHLY_HOURS" && ab.type === "VOCATIONAL_SCHOOL") continue;
      const bs = isBsAbsence(ab);
      absenceMinutes += calcLeaveAbsenceMinutesTz(schedule, absStart, absEnd, tz, {
        halfDay: Boolean(ab.halfDay),
        excludeHolidays: bs ? holidayExcludeSet : nsClaimed, // D-06 holidays (+ D-15 for non-BS)
        defaultWorkDays: tenantConfig?.defaultWorkDays, // Issue #433 (D-05) — MONTHLY_HOURS only
      });
      if (!bs) claimDays(absStart, absEnd, tz, nsClaimed);
    }

    // Add bsExpectedMinutes to expectedMinutes for non-MONTHLY_HOURS Soll-bearing types.
    // For MONTHLY_HOURS (D-04): bsExpectedMinutes stays 0 — forced by `res.contributesToExpected`
    // being false for MONTHLY_HOURS in the BS credit loop above (Step 6), not by this branch.
    expectedMinutes += bsExpectedMinutes;
  }

  // ── Step 8: Compute final saldo values ────────────────────────────────────

  // netExpected: valid for non-SHIFT branches.
  // For SHIFT_BASED, expectedMinutes is already C_net (set by calcShiftBasedSaldo);
  // shiftBalanceOverride is the D-01 two-clause balance (bypasses netExpected formula).
  const netExpected = Math.max(
    0,
    scheduleType !== "SHIFT_BASED"
      ? expectedMinutes - holidayMinutes - leaveMinutes - absenceMinutes
      : expectedMinutes, // SHIFT_BASED: expectedMinutes = C_net, not used for balance
  );

  const totalWorked = workedMinutes + bsWorkedMinutes;

  // Phase 125 (D-03): "days with worked minutes > 0". Counted over the accumulated per-day map,
  // so the day set and `totalWorked` above are two readings of one traversal.
  let workedDays = 0;
  for (const dayMinutes of workedMinutesByDate.values()) {
    if (dayMinutes > 0) workedDays++;
  }

  // Phase 76.22: SHIFT_BASED uses D-01 two-clause formula via shiftBalanceOverride.
  // Non-SHIFT branches use the flat totalWorked − netExpected subtraction.
  const grossBalanceMinutes =
    shiftBalanceOverride !== null
      ? Math.round(shiftBalanceOverride)
      : Math.round(totalWorked - netExpected);

  // Issue #220 — Überstundenausgleich withdrawal, applied ONCE for both branches.
  //
  // Deliberately OUTSIDE calcShiftBasedSaldo's § 615 clauses: this is an account
  // MOVEMENT (the employee spends banked overtime), not a statement about how much work
  // was owed or offered that month. Folding it into the Soll would change the § 615
  // Annahmeverzug comparison itself; subtracting it here leaves `expectedMinutes` /
  // `snapshotExpectedMinutes` exactly as before — the Ausgleichstag remains a paid,
  // Soll-free day — and moves only the balance.
  const withdrawalMinutes = Math.round(overtimeCompensationMinutes);
  const balanceMinutes = grossBalanceMinutes - withdrawalMinutes;

  const carryOverOut = carryOverIn + balanceMinutes;

  // TRACK_ONLY zeroing: MONTHLY_HOURS with overtimeMode=TRACK_ONLY → effectiveCarryOverOut = 0.
  // Mirrors overtime.ts:1268–1269, auto-close-month.ts:618–620, recalculate-snapshots.ts:461.
  const isTrackOnly = scheduleType === "MONTHLY_HOURS" && schedule.overtimeMode === "TRACK_ONLY";
  const effectiveCarryOverOut = isTrackOnly ? 0 : carryOverOut;

  // snapshotExpectedMinutes sentinel (RESEARCH §2 last row):
  //   SHIFT_BASED → C_net (= expectedMinutes, already set to calcShiftBasedSaldo.expectedMinutes)
  //   else        → netExpected (the post-deduction Soll stored in the snapshot)
  // Mirrors overtime.ts:1273–1274, auto-close-month.ts:624–625, recalculate-snapshots.ts:470–471.
  const snapshotExpectedMinutes =
    shiftBalanceOverride !== null ? Math.round(expectedMinutes) : Math.round(netExpected);

  return {
    workedMinutes: Math.round(totalWorked),
    workedDays,
    expectedMinutes: Math.round(scheduleType === "SHIFT_BASED" ? expectedMinutes : netExpected),
    balanceMinutes,
    carryOverOut,
    effectiveCarryOverOut,
    snapshotExpectedMinutes,
    overtimeCompensationMinutes: withdrawalMinutes,
    gaps,
    coveredDates,
  };
}

// ── computeWeekProgress (Issue #451, D-06; relocated here 451-08 — cycle fix) ─────────────────
//
// Issue #451 (D-06) — the dashboard week target is the Soll of the WHOLE week (Mon-Sun, tenant
// timezone) after leave, absence, Berufsschule and holiday reduction — the same saldo core
// (closeEmployeeMonth, above in this file) the Monatsabschluss uses, never a composition-layer
// `{day}Hours` walk. A full vacation week therefore shows target 0, not a flat Mon..today walk
// minus nothing (the issue's literal example: -40h instead of 0).
//
// Progress through the week compares worked vs. Soll only up to YESTERDAY (issue #438: today
// never counts) — the `toDateSollMinutes`/`toDateWorkedMinutes` pair below.
//
// Contract resolution mirrors Phase 451-05's per-month rule for the live lifetime saldo
// (`getEffectiveSchedule(app, employeeId, <that month's midpoint>)`, the close paths' own rule):
// a week is split into at most two contiguous calendar-month pieces (Mon-Sun straddles at most
// one month boundary), and each piece resolves ITS OWN contract before any prefetch. Any piece
// under a MONTHLY_HOURS contract degrades the whole result to `null` — that schedule type keeps
// its own month view, never a week view (dashboard.ts does not even call this function for a
// MONTHLY_HOURS employee's TODAY contract, but a contract change mid-week could still make one
// piece MONTHLY_HOURS while the other is not, so the guard lives here too).
//
// Window convention (mirrors this file's own day-by-day partial loop and overtime-balance.ts's
// partial-month block): per piece, `closeEmployeeMonth` is called TWICE — once over the WHOLE
// piece with no entries (the piece's own Soll, carryOverIn 0, no rosterProration), and once over
// the piece clipped to <= yesterday WITH its entries (to-date Soll and Ist). `monthStart` is
// unused by `closeEmployeeMonth` itself (its only consumers are callers' own bookkeeping) — any
// valid Date satisfies the type.
//
// Pure read: no write, ever.
//
// Relocation note (451-08, cycle fix): this function previously lived in its own file,
// `working-time-account/week-progress.ts`. It needs the SAME cross-context facade imports
// (`../time-tracking`, `../absence`, `../scheduling`, `../platform`) `closeEmployeeMonth` (this
// file) already contributes to the pre-existing absence/scheduling/time-tracking/
// working-time-account import cycle — a standalone file re-exported from this context's
// `index.ts` and importing an already-in-cycle sibling (even `close-employee-month.ts` itself)
// unavoidably joins the same SCC as a NEW graph node (`measure-context-boundary-imports.ts
// --cycles`: 24 -> 25 when it was a separate file). Relocating the function's body into THIS
// file — already a cycle member, already exported via `index.ts` — adds no new node: the file
// count drops back by one with zero behavior change (no file outside this context ever imported
// `week-progress.ts` directly; `index.ts` is the only importer, updated alongside this move).

export type WeekProgress = {
  /** The whole week's (Mon-Sun) net Soll, after leave/absence/BS/holiday reduction. */
  weekSollMinutes: number;
  /** The Soll of the part of the week up to and including yesterday (issue #438). */
  toDateSollMinutes: number;
  /** The Ist of the part of the week up to and including yesterday (issue #438). */
  toDateWorkedMinutes: number;
};

type WeekMonthPiece = { start: string; end: string };

/**
 * Split a Monday..Sunday run of tenant-local "YYYY-MM-DD" day strings into contiguous
 * calendar-month pieces. A Mon-Sun week straddles at most one month boundary (it can never span
 * three calendar months), so this returns one or two pieces.
 */
function splitWeekIntoMonthPieces(days: readonly string[]): WeekMonthPiece[] {
  const pieces: WeekMonthPiece[] = [];
  let pieceStart = days[0]!;
  for (let i = 1; i < days.length; i++) {
    if (days[i]!.slice(0, 7) !== days[i - 1]!.slice(0, 7)) {
      pieces.push({ start: pieceStart, end: days[i - 1]! });
      pieceStart = days[i]!;
    }
  }
  pieces.push({ start: pieceStart, end: days[days.length - 1]! });
  return pieces;
}

/**
 * Issue #451 (D-06) — the dashboard week block's whole-week Soll and to-date Soll/Ist, both from
 * the saldo core. Returns `null` for a missing/exempt employee, or when any day of the week falls
 * under a MONTHLY_HOURS contract (that schedule type keeps its own month view).
 */
export async function computeWeekProgress(
  app: FastifyInstance,
  employeeId: string,
  now: Date,
): Promise<WeekProgress | null> {
  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      tenantId: true,
      hireDate: true,
      exitDate: true,
      isTimeTrackingExempt: true,
      breakOver6hOverride: true,
      breakOver9hOverride: true,
    },
  });
  if (!employee || employee.isTimeTrackingExempt) return null;

  const tz = await getTenantTimezone(app.prisma, employee.tenantId);
  const { start: weekStart, end: weekEnd, days } = weekRangeUtc(now, tz);

  // Issue #438 — today never counts; the to-date cursor always ends yesterday.
  const todayStr = dateStrInTz(now, tz);
  const todayDate = new Date(todayStr + "T00:00:00Z");
  const yesterdayDate = new Date(todayDate.getTime() - 86400000);
  const yesterdayStr = dateStrInTz(yesterdayDate, tz);

  const pieces = splitWeekIntoMonthPieces(days);

  // Issue #451 (D-04/D-05 carry-over from Phase 451-05) — resolve EACH piece's own contract via
  // its calendar month's midpoint (the close paths' rule) before any prefetch, so a piece in a
  // different calendar month can never reuse another piece's (or "today's") contract.
  const midpointOf = (a: Date, b: Date) => new Date((a.getTime() + b.getTime()) / 2);
  const pieceSchedules = await Promise.all(
    pieces.map(async (piece) => {
      const [y, m] = piece.start.split("-").map(Number) as [number, number];
      const { start: calMonthStart, end: calMonthEnd } = monthRangeUtc(y, m, tz);
      const schedule = await getEffectiveSchedule(
        app,
        employeeId,
        midpointOf(calMonthStart, calMonthEnd),
      );
      return { piece, calMonthStart, schedule };
    }),
  );

  // Any part of the week under a MONTHLY_HOURS contract — that schedule type keeps its own
  // month view; this function answers no week question for it.
  if (pieceSchedules.some((p) => String(p.schedule.type ?? "") === "MONTHLY_HOURS")) {
    return null;
  }

  const anyPieceShiftBased = pieceSchedules.some(
    (p) => String(p.schedule.type ?? "") === "SHIFT_BASED",
  );

  const employeeScope = { kind: "employee" as const, employeeId, tenantId: employee.tenantId };

  // ── ONE prefetch for the whole week ──────────────────────────────────────────────────────
  const [weekWorkEntries, toDateEntries, weekLeave, weekAbsences, tenantConfig] = await Promise.all(
    [
      // T2 — closed WORK entries, carries salonId; feeds the holiday resolver (§ 2 EFZG).
      getWorkedEntriesInRange(app.prisma, employeeScope, weekStart, weekEnd),
      // T1 — THE SALDO INPUT, Monday..yesterday only (today never counts, issue #438).
      getValidWorkedEntriesInRange(
        app.prisma,
        employeeScope,
        weekStart,
        new Date(yesterdayStr + "T00:00:00Z"),
      ),
      getActiveLeaveOverlapping(app.prisma, employeeScope, weekStart, weekEnd),
      getAbsencesOverlapping(app.prisma, employeeScope, weekStart, weekEnd),
      app.prisma.tenantConfig.findUnique({ where: { tenantId: employee.tenantId } }),
    ],
  );

  const weekShifts = anyPieceShiftBased
    ? await getShiftsInRange(app.prisma, employeeScope, weekStart, weekEnd)
    : [];

  const workLocationEntries = weekWorkEntries.map((e) => ({
    employeeId,
    date: e.date,
    startTime: e.startTime,
    salonId: e.salonId,
  }));
  const employeeHolidaysMap = await holidaysAtWorkLocation(
    app.prisma,
    employee.tenantId,
    [employeeId],
    dateStrInTz(weekStart, tz),
    dateStrInTz(weekEnd, tz),
    workLocationEntries,
  );
  const weekHolidayDateStrings = new Set<string>(employeeHolidaysMap.get(employeeId)?.keys() ?? []);

  const tenantCfg = tenantConfig
    ? {
        defaultBreakOver6h: tenantConfig.defaultBreakOver6h,
        defaultBreakOver9h: tenantConfig.defaultBreakOver9h,
        defaultWorkDays: tenantConfig.defaultWorkDays ?? undefined,
        vocationalSchoolMinutesPerDay: tenantConfig.vocationalSchoolMinutesPerDay ?? undefined,
        vocationalSchoolBlockMinutesPerWeek:
          tenantConfig.vocationalSchoolBlockMinutesPerWeek ?? undefined,
        bsSlotFirstLongDayMinutes: tenantConfig.bsSlotFirstLongDayMinutes ?? undefined,
        bsSlotSecondLongDayMinutes: tenantConfig.bsSlotSecondLongDayMinutes ?? undefined,
        bsSlotShortDayMinutes: tenantConfig.bsSlotShortDayMinutes ?? undefined,
        bsSlotBlockWeekMinutes: tenantConfig.bsSlotBlockWeekMinutes ?? undefined,
      }
    : null;

  const approvedLeaveInput = toCloseMonthApprovedLeave(weekLeave);
  const absencesInput = weekAbsences.map((ab) => ({
    startDate: ab.startDate,
    endDate: ab.endDate,
    type: ab.type,
    source: ab.source,
    halfDay: Boolean(ab.halfDay),
    unterrichtsMinutes: ab.unterrichtsMinutes ?? null,
  }));

  let weekSollMinutes = 0;
  let toDateSollMinutes = 0;
  let toDateWorkedMinutes = 0;

  for (const { piece, calMonthStart, schedule } of pieceSchedules) {
    const pieceStartDate = new Date(piece.start + "T00:00:00Z");
    const pieceEndDate = new Date(piece.end + "T00:00:00Z");

    // Phase 76.31 (D-06) — BS slot overrides for the piece's own calendar month.
    const { employeeSlots, patternSlots, patternUnterrichtsMinutenByDow } =
      await loadBsSlotOverrides(app.prisma, employeeId, calMonthStart);

    const pieceHolidays = new Set(
      [...weekHolidayDateStrings].filter((d) => d >= piece.start && d <= piece.end),
    );
    const pieceShifts = weekShifts
      .filter(
        (sh) => dateStrInTz(sh.date, tz) >= piece.start && dateStrInTz(sh.date, tz) <= piece.end,
      )
      .map((sh) => ({ date: sh.date, startTime: sh.startTime, endTime: sh.endTime }));

    const sharedPieceInput = {
      employeeId,
      monthStart: pieceStartDate,
      monthFirstDay: pieceStartDate,
      tz,
      carryOverIn: 0,
      schedule: schedule as Record<string, unknown>,
      hireDate: employee.hireDate,
      exitDate: employee.exitDate ?? null,
      isTimeTrackingExempt: false as const,
      breakOver6hOverride: employee.breakOver6hOverride ?? null,
      breakOver9hOverride: employee.breakOver9hOverride ?? null,
      shifts: pieceShifts,
      approvedLeave: approvedLeaveInput,
      absences: absencesInput,
      tenantConfig: tenantCfg,
      employeeSlots,
      patternSlots,
      patternUnterrichtsMinutenByDow,
    };

    // Whole piece, no entries — the piece's own Soll (D-06: the WHOLE week's net Soll).
    const wholePieceResult = closeEmployeeMonth({
      ...sharedPieceInput,
      monthEnd: pieceEndDate,
      monthLastDay: pieceEndDate,
      entries: [],
      holidayDateStrings: pieceHolidays,
    });
    weekSollMinutes += wholePieceResult.expectedMinutes;

    // The piece clipped to <= yesterday, with its entries — to-date Soll and Ist (issue #438:
    // today never counts). A piece entirely after yesterday (a future piece of the current
    // week) contributes nothing to the to-date pair.
    if (piece.start > yesterdayStr) continue;
    const clippedEndStr = piece.end <= yesterdayStr ? piece.end : yesterdayStr;
    const clippedEndDate = new Date(clippedEndStr + "T00:00:00Z");
    const pieceEntries = toDateEntries
      .filter(
        (e) => dateStrInTz(e.date, tz) >= piece.start && dateStrInTz(e.date, tz) <= clippedEndStr,
      )
      .map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes,
      }));
    const clippedHolidays = new Set([...pieceHolidays].filter((d) => d <= clippedEndStr));

    const toDateResult = closeEmployeeMonth({
      ...sharedPieceInput,
      monthEnd: clippedEndDate,
      monthLastDay: clippedEndDate,
      entries: pieceEntries,
      holidayDateStrings: clippedHolidays,
    });
    toDateSollMinutes += toDateResult.expectedMinutes;
    toDateWorkedMinutes += toDateResult.workedMinutes;
  }

  return { weekSollMinutes, toDateSollMinutes, toDateWorkedMinutes };
}
