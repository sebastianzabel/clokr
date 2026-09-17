// Overtime-balance computation and persistence — lifted out of ../time-tracking/api/time-entries.ts
// in Phase 101B (Issue #101). computeOvertimeBalanceBreakdown/updateOvertimeAccount are
// Arbeitszeitkonto subject matter that had been sitting in a Zeiterfassung route file; the move
// was measured to be cycle-neutral (101B-ZYKLEN-BEFUND.md §4) and is made on domain grounds, not
// graph grounds. The bodies are unchanged — this was a relocation, not a rewrite.
//
// getEffectiveSchedule is imported from ../time-tracking (defined in entry-invariants.ts, the
// leaf, not defined here) — "which schedule applies to this employee on this day" is a
// Zeiterfassung question.
//
// Follow-up fix (Phase 101B): the move above turned the two TimeEntry reads inline in
// computeOvertimeBalanceBreakdown (the "has today's entries" cutoff check and the worked-minutes
// read) into a cross-context Prisma access — TimeEntry is owned by time-tracking. Both are now
// routed through time-tracking's own `getValidWorkedEntriesInRange` facade export (T1, "the saldo
// input" — see `time-tracking/facade/time-entries.ts`), the exact same read three other
// working-time-account call sites already use (month-saldo.ts, recalculate-snapshots.ts,
// auto-close-month.ts, overtime.ts). No `foreign-context-access-exceptions.json` entry needed.

import { FastifyInstance } from "fastify";
import {
  getAbsencesOverlapping, // Phase 100B Plan 12 — A4
  getApprovedLeaveOverlapping, // Phase 100B Plan 13 — A1
  loadBsSlotOverrides, // Phase 76.31 — D-06 slot overrides
} from "../absence"; // Phase 101B (Issue #101, wave 7) — merged from two deep imports (plan-04 carry-over row)
import { getHolidays, STATE_MAP } from "../platform";
import { getShiftsInRange } from "../scheduling"; // Phase 100B Plan 05 — S1
import { closeEmployeeMonth } from "./close-employee-month"; // SNAP-03 — Phase 76.27
import { getConfirmedCarryOver } from "./confirmed-saldo"; // Phase 97-06
import {
  getTenantTimezone,
  dateStrInTz,
  monthRangeUtc,
  monthDayBounds,
  calcExpectedMinutesTz,
} from "./timezone";
import { setOvertimeAccountBalance } from "./facade/overtime-account";
import {
  getValidWorkedEntriesInRange, // Phase 100B Plan 08 — T1
  getEffectiveBreakDuration,
  getEffectiveSchedule,
} from "../time-tracking"; // Phase 101B (Issue #101, wave 8) — merged from three deep imports (plan-04 carry-over)

// ── Hilfsfunktion: Überstundensaldo berechnen (snapshot-basiert, TZ-aware) ────
// Nutzt den letzten SaldoSnapshot als Basis und rechnet nur den offenen Zeitraum
// seit dem Snapshot neu. Ohne Snapshot: Fallback auf den aktuellen Monat.
//
// PURE READ (no DB write). Returns the LIFETIME running Überstundensaldo breakdown through the
// windowEnd cutoff (today only if today has completed entries, else yesterday — the same
// hasTodayEntries convention the §615 calendar header/cells use). Handles all schedule types:
//   - MONTHLY_HOURS TRACK_ONLY → totalHours 0, confirmedMinutes/openMonthMinutes both 0.
//   - SHIFT_BASED / FIXED_* / FLEXTIME / MONTHLY_HOURS(target>0) → live lifetime saldo.
// Lifetime-correct: totalHours = last-snapshot carryOver (or full history from hireDate when no
// snapshot) + Σ balances of ALL open months (complete + current partial) up to windowEnd. This is
// the SAME value updateOvertimeAccount persists — it is the single source of truth; the writer
// wraps this and upserts. Returns null for §18-exempt employees (caller: skip / no value).
//
// Phase 97-01 (TRACER, SALDO-DISP-01/03/07) — decomposes that SAME total into the
// "Bestätigt" (confirmedMinutes, from the closed-month SaldoSnapshot chain — see
// confirmed-saldo.ts) vs. "Laufender Monat (Prognose)" (openMonthMinutes) split, DERIVED
// as total − confirmed (never computed independently, per 97-CONTEXT — one computation
// path). `computeOvertimeBalanceHours` below is now a thin, signature-preserving wrapper
// around this breakdown — it MUST stay byte-behaviour-identical for its three external
// consumers (packages/mcp/src/index.ts, the `read:overtime` API-key scope, and
// updateOvertimeAccount just below).
export type OvertimeBalanceBreakdown = {
  totalHours: number;
  confirmedMinutes: number;
  openMonthMinutes: number;
  hasClosedMonth: boolean;
  /** SHIFT_BASED only, and only when the current month has an open partial period —
   *  undefined for every other schedule type/state (never a fabricated `false`). */
  rosterIncomplete?: boolean;
};

export async function computeOvertimeBalanceBreakdown(
  app: FastifyInstance,
  employeeId: string,
): Promise<OvertimeBalanceBreakdown | null> {
  const schedule = await getEffectiveSchedule(app, employeeId);

  // Tenant-Timezone laden + hireDate + federalState for holiday computation
  // v1.8.9: also fetch break overrides for SHIFT_BASED netto calculation.
  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      tenantId: true,
      hireDate: true,
      isTimeTrackingExempt: true, // Phase 76.7 (D-04, SALDO-V19-04)
      breakOver6hOverride: true, // v1.8.9 — SHIFT_BASED netto saldo
      breakOver9hOverride: true, // v1.8.9 — SHIFT_BASED netto saldo
      tenant: { select: { federalState: true } },
    },
  });

  // Phase 76.7 (D-04, D-10) — exempt employees never compute saldo.
  // We do NOT reset balanceHours to 0 (preserve audit-trail of prior value).
  if (employee?.isTimeTrackingExempt) {
    app.log.info(
      { employeeId, exempt: true },
      "computeOvertimeBalanceBreakdown skipped (isTimeTrackingExempt)",
    );
    return null;
  }

  const tz = await getTenantTimezone(app.prisma, employee?.tenantId ?? "");

  // Find the latest closed month (basis for the computation below). Phase 100B Plan 07
  // (W3 merge) — this used to be its own direct SaldoSnapshot query (getLatestClosedMonth);
  // it is now the SAME call as getConfirmedCarryOver (the "Bestätigt" figure), widened to
  // also carry periodEnd, so the two can never drift into two independently-computed answers
  // to the same question.
  const confirmed = await getConfirmedCarryOver(app.prisma, employeeId, employee?.tenantId ?? "");

  const now = new Date();
  const todayStr = dateStrInTz(now, tz);
  const todayDate = new Date(todayStr + "T00:00:00Z");
  const yesterdayDate = new Date(todayDate.getTime() - 86400000);

  // Berechne den offenen Zeitraum: ab Tag nach Snapshot-Ende bis heute
  // Ohne Snapshot: ab Monatsanfang (oder Eintrittsdatum)
  let rangeStart: Date;
  let snapshotCarryOver = 0;

  if (confirmed.hasClosedMonth) {
    // Start: Tag nach dem Snapshot-Ende
    rangeStart = new Date(confirmed.periodEnd!.getTime() + 86400000);
    snapshotCarryOver = confirmed.minutes;
  } else {
    // No non-superseded snapshot: recompute from hireDate so that reopen of the
    // only/earliest snapshot includes the full employment history (D-05 fix).
    // Using currentMonthFirstDay as rangeStart would exclude all history before the
    // current calendar month — the root cause of the reopen→0 saldo bug (SALDO-09).
    const hireDateNorm = employee?.hireDate
      ? new Date(dateStrInTz(employee.hireDate, tz) + "T00:00:00Z")
      : null;
    rangeStart = hireDateNorm ?? new Date(0); // epoch fallback if hireDate is null
  }

  // Determine cutoff: include today only if entries exist.
  // Routed through time-tracking's T1 facade read (see file header follow-up-fix note): its
  // `where` is byte-identical to the former inline query, and a single-day [todayDate, todayDate]
  // range is equivalent to the former exact-date match for a @db.Date column.
  const employeeScope = {
    kind: "employee" as const,
    employeeId,
    tenantId: employee?.tenantId ?? "",
  };
  const todayValidEntries = await getValidWorkedEntriesInRange(
    app.prisma,
    employeeScope,
    todayDate,
    todayDate,
  );
  const cutoffDate = todayValidEntries.length > 0 ? todayDate : yesterdayDate;
  const effectiveEnd = cutoffDate < rangeStart ? rangeStart : cutoffDate;

  // Worked minutes since snapshot (or month start). Same T1 facade read — every downstream use of
  // `entries` in this file only reads `date`/`startTime`/`endTime`/`breakMinutes`, exactly the
  // fields T1's `select` returns.
  const entries = await getValidWorkedEntriesInRange(
    app.prisma,
    employeeScope,
    rangeStart,
    effectiveEnd,
  );

  const workedMinutes = entries.reduce((sum, e) => {
    if (!e.endTime) return sum;
    return sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
  }, 0);

  // ── SNAP-03 (Phase 76.27): Per-month iteration via closeEmployeeMonth() ─────
  // ALL schedule models now use the unified per-month loop for COMPLETE open months,
  // calling closeEmployeeMonth() once per month. The current partial month is computed
  // inline (F-01 Option A — SHIFT_BASED: roster-prorated; non-SHIFT: flat calcExpectedMinutesTz).
  const scheduleType = String(schedule.type ?? "");

  // Tenant config + state code are needed by both holiday + closeEmployeeMonth branches
  const tenantConfig = await app.prisma.tenantConfig.findUnique({
    where: { tenantId: employee!.tenantId },
  });
  const updateStateCode = employee?.tenant
    ? (STATE_MAP[employee.tenant.federalState] ?? "NI")
    : "NI";

  // Hoisted holiday block — FULL-YEAR coverage (not filtered to [rangeStart, effectiveEnd]).
  //
  // SNAP-03 (76.27): closeEmployeeMonth() subtracts ALL holidays in the provided set from each
  // month's expected (no internal month-range filtering). To maintain parity with the close paths
  // (which use buildHolidaySet(year) = all year's holidays), the live path MUST pass the full
  // annual holiday set to closeEmployeeMonth() for each complete open month AND for the current
  // partial month close. Only covering holidays within [rangeStart, effectiveEnd] would cause the
  // live path to subtract fewer holidays than the close path, breaking parity.
  //
  // We therefore build the holiday set for ALL calendar years spanned by the open range (typically
  // just one year, but can span two). No date-range filtering — include all holidays for each year.
  //
  // DB manual holidays: still filter to [rangeStart, effectiveEnd] for the inline current-month
  // branch (those are already included in the year-wide computed set for the close calls).
  const rangeYear = rangeStart.getUTCFullYear();
  const effectiveEndYear = effectiveEnd.getUTCFullYear();
  const computedHolidaysByDate = new Map<string, { date: Date }>();
  for (let yr = rangeYear; yr <= effectiveEndYear; yr++) {
    for (const h of getHolidays(yr, updateStateCode)) {
      // Full year — NO date-range filter (SNAP-03: match close-path convention).
      computedHolidaysByDate.set(h.date, { date: new Date(h.date + "T00:00:00Z") });
    }
  }
  const dbHolidays = await app.prisma.publicHoliday.findMany({
    where: {
      tenant: { employees: { some: { id: employeeId } } },
      date: { gte: rangeStart, lte: effectiveEnd },
    },
  });
  const allHolidays: { date: Date }[] = [...computedHolidaysByDate.values()];
  for (const h of dbHolidays) {
    if (!computedHolidaysByDate.has(dateStrInTz(h.date, tz))) {
      allHolidays.push({ date: h.date });
    }
  }
  // D-06: holiday dates as tenant-TZ YYYY-MM-DD, passed to calcLeaveAbsenceMinutesTz so a
  // holiday inside approved leave/absence is NOT double-deducted (holidayMinutes already
  // subtracts it separately). Full-year set used for all closeEmployeeMonth calls.
  const holidayDateStrSet = new Set(allHolidays.map((h) => dateStrInTz(h.date, tz)));

  // ── SNAP-03 (Phase 76.27): Per-month iteration via closeEmployeeMonth() ────────
  //
  // Build the list of COMPLETE open months: all calendar months entirely before the
  // calendar month of effectiveEnd. The current (partial) month is handled inline below.
  // Uses monthRangeUtc + monthDayBounds (SNAP-05 — never raw Date math).
  //
  // Algorithm: iterate month-by-month from rangeStart's month up to (but not including)
  // the calendar month that contains effectiveEnd. Oldest-first.

  // Current month: the calendar month that contains TODAY (not effectiveEnd).
  //
  // SNAP-03-A fix: when effectiveEnd is the last day of the previous calendar month
  // (because today has no entries yet, so effectiveEnd = yesterday), using effectiveEnd's
  // month would classify that complete month as the "current partial" month and skip it
  // from the complete-months loop. Using todayDate ensures the month boundary is always
  // the ACTUAL current calendar month, so all complete prior months (including yesterday's
  // full month) are processed by closeEmployeeMonth().
  const currentMonthRange = monthRangeUtc(
    todayDate.getUTCFullYear(),
    todayDate.getUTCMonth() + 1,
    tz,
  );

  // Build complete open months list (all months before the current month).
  interface CompleteMonth {
    monthStart: Date;
    monthEnd: Date;
    monthFirstDay: Date;
    monthLastDay: Date;
  }
  const completeOpenMonths: CompleteMonth[] = [];
  {
    // Start from the calendar month containing rangeStart.
    const rsStr = dateStrInTz(rangeStart, tz);
    const [rsYear, rsMonth] = rsStr.split("-").map(Number);
    let cy = rsYear!;
    let cm = rsMonth!; // 1-based
    for (let i = 0; i < 240; i++) {
      const { start: mStart, end: mEnd } = monthRangeUtc(cy, cm, tz);
      // Stop when this month IS the current month (contains effectiveEnd).
      if (mStart >= currentMonthRange.start) break;
      // Only include months that overlap with rangeStart (first segment may start mid-month).
      if (mEnd >= rangeStart) {
        const { firstDay: mFirstDay, lastDay: mLastDay } = monthDayBounds(mStart, mEnd, tz);
        completeOpenMonths.push({
          monthStart: mStart,
          monthEnd: mEnd,
          monthFirstDay: mFirstDay,
          monthLastDay: mLastDay,
        });
      }
      cm++;
      if (cm > 12) {
        cm = 1;
        cy++;
      }
    }
  }

  // ── Range-wide pre-fetch (ONE query per collection) ───────────────────────────
  // Pre-fetch all data for [rangeStart, effectiveEnd] once. The per-month loop
  // and current-month computation filter inline — no N×DB-round-trips (RESEARCH §2.4).
  //
  // Compute @db.Date bounds for the full range so entry/shift queries use the correct
  // boundary type (SNAP-05). rangeStart and effectiveEnd are already @db.Date-compatible
  // UTC midnight values from the snapshot.periodEnd+1 calculation above.
  const rangeFirstDay = rangeStart; // Already a UTC-midnight @db.Date-compatible value
  const rangeLastDay = effectiveEnd; // Already a UTC-midnight @db.Date-compatible value

  // SHIFT_BASED roster fetch upper bound: include the WHOLE current calendar month, not just
  // rangeLastDay (= effectiveEnd = yesterday when today has no entries). The partial-month §615
  // block needs rosterPeriodMinutes = the FULL current-month roster (incl. future-planned shifts)
  // to prorate the contract Soll (R_toDate ÷ R_periodFull). Truncating at effectiveEnd made
  // R_periodFull == R_toDate → factor 1 → NO proration → the open partial month collapsed to ~0,
  // dropping the current month from the running total (Bug 5). Only the roster DENOMINATOR needs
  // future days; entries/leave/absences below keep the effectiveEnd bound, and the shift LIST fed
  // to closeEmployeeMonth is still clamped to effectiveEnd (only curMonthAllShifts widens).
  // currentMonthRange (computed above) is the calendar month containing today.
  const shiftRangeLastDay =
    currentMonthRange.end > rangeLastDay ? currentMonthRange.end : rangeLastDay;

  // Phase 100B Plan 05 — S1, contexts/scheduling facade.
  const allShifts =
    scheduleType === "SHIFT_BASED"
      ? await getShiftsInRange(
          app.prisma,
          { kind: "employee", employeeId, tenantId: employee?.tenantId ?? "" },
          rangeFirstDay,
          shiftRangeLastDay,
        )
      : [];

  // Upper bound = shiftRangeLastDay (= full current calendar month, NOT effectiveEnd).
  // The SHIFT_BASED partial-month C_net credit (closeEmployeeMonth uses monthEnd =
  // currentMonthRange.end) must see approved leave/absences that START LATER in the current
  // month than effectiveEnd (= yesterday when today has no entries). Truncating at effectiveEnd
  // dropped a future-in-month approved vacation → its Soll-credit was never subtracted from
  // C_net → the prorated effective Soll was inflated above W → the whole open-month §615
  // contribution collapsed to 0, diverging from the per-day cells (computeMonthSaldo, which
  // fetches the FULL month). This mirrors the shiftRangeLastDay widening above (Bug 5); the
  // leave/absence fetch was left at effectiveEnd — that asymmetry is the divergence root cause.
  // Non-SHIFT partial (monthEnd = effectiveEnd) ignores the extra rows (out of window) → no-op.
  // Phase 100B Plan 13 — A1, contexts/absence facade.
  const allApprovedLeave = await getApprovedLeaveOverlapping(
    app.prisma,
    { kind: "employee", employeeId, tenantId: employee?.tenantId ?? "" },
    rangeStart,
    shiftRangeLastDay,
  );

  // Phase 100B Plan 12 — A4, contexts/absence facade.
  const allAbsences = await getAbsencesOverlapping(
    app.prisma,
    { kind: "employee", employeeId, tenantId: employee?.tenantId ?? "" },
    rangeStart,
    shiftRangeLastDay,
  );

  // Build a full-range holidayDateStrings Set covering all years in [rangeStart, effectiveEnd].
  // (Already computed above as holidayDateStrSet — reuse it directly for closeEmployeeMonth calls.)

  // ── Complete open months loop: one closeEmployeeMonth() call per month ────────
  // For each COMPLETE open month (all months before the current partial month),
  // call closeEmployeeMonth() with the filtered data slice. Thread effectiveCarryOverOut
  // as carryOverIn for the next month. Accumulate balanceMinutes into openPeriodBalance.
  //
  // SHIFT_BASED: each complete month is full/close-equivalent (no rosterProration).
  // §615 applied per-month → eliminates the +64h lumping artifact (SNAP-03 fix).
  // FIXED/FLEXTIME/MONTHLY_HOURS: also go through closeEmployeeMonth() for uniformity
  // (RESEARCH §2.6 — all models benefit from per-month snapshot guarantee).

  let accumulatedCarryOver = snapshotCarryOver;
  let openPeriodBalance = 0;

  for (const cm of completeOpenMonths) {
    const { monthStart, monthEnd, monthFirstDay, monthLastDay } = cm;

    // Filter each pre-fetched collection to this month's range.
    // entries: @db.Date comparison (date >= monthFirstDay && date <= monthLastDay)
    const monthEntries = entries.filter((e) => e.date >= monthFirstDay && e.date <= monthLastDay);
    // shifts: same @db.Date filter
    const monthShifts = allShifts.filter((s) => s.date >= monthFirstDay && s.date <= monthLastDay);
    // leave/absences: range overlap (startDate <= monthEnd && endDate >= monthStart)
    const monthLeave = allApprovedLeave.filter(
      (lr) => lr.startDate <= monthEnd && lr.endDate >= monthStart,
    );
    const monthAbsences = allAbsences.filter(
      (ab) => ab.startDate <= monthEnd && ab.endDate >= monthStart,
    );

    // Filter holidays to this month's range only (matching the close-path convention in
    // auto-close-month.ts which filters to [empEffectiveStart, monthEnd]).
    // closeEmployeeMonth() has no internal month-range filtering — it subtracts ALL holidays
    // in the provided set. Passing the full-year set causes every complete month to subtract
    // ALL annual holidays, inflating expected by holidays from other months (saldo invariant
    // regression). Filter to [monthFirstDay, monthLastDay] to match the actual month bounds.
    const monthFirstDayStr = dateStrInTz(monthFirstDay, tz);
    const monthLastDayStr = dateStrInTz(monthLastDay, tz);
    const monthHolidaySet = new Set(
      [...holidayDateStrSet].filter((d) => d >= monthFirstDayStr && d <= monthLastDayStr),
    );
    // Phase 76.31 (D-06): load Employee + active-Pattern bsSlot* overrides for this
    // month so the complete-month recompute honors per-MA / per-pattern slot amounts.
    const { employeeSlots, patternSlots, patternUnterrichtsMinutenByDow } =
      await loadBsSlotOverrides(app.prisma, employeeId, monthFirstDay);
    const result = closeEmployeeMonth({
      employeeId,
      monthStart,
      monthEnd,
      monthFirstDay,
      monthLastDay,
      tz,
      carryOverIn: accumulatedCarryOver,
      schedule: schedule as Record<string, unknown>,
      hireDate: employee!.hireDate,
      exitDate: null, // live path — still employed
      isTimeTrackingExempt: false, // already guarded above
      breakOver6hOverride: employee?.breakOver6hOverride ?? null,
      breakOver9hOverride: employee?.breakOver9hOverride ?? null,
      entries: monthEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes ?? 0,
      })),
      shifts: monthShifts,
      approvedLeave: monthLeave.map((lr) => ({
        startDate: lr.startDate,
        endDate: lr.endDate,
        halfDay: lr.halfDay,
      })),
      absences: monthAbsences.map((ab) => ({
        startDate: ab.startDate,
        endDate: ab.endDate,
        type: ab.type,
        source: ab.source,
        halfDay: ab.halfDay,
        // Phase 76.39 (D-11 cleanup): thread per-day Unterrichtszeit for duration-based
        // BS slot classification (null → Pattern/ordinal fallback — no regression).
        unterrichtsMinutes: ab.unterrichtsMinutes ?? undefined,
      })),
      holidayDateStrings: monthHolidaySet,
      tenantConfig: tenantConfig
        ? {
            defaultBreakOver6h: tenantConfig.defaultBreakOver6h,
            defaultBreakOver9h: tenantConfig.defaultBreakOver9h,
            monthlyHoursHolidayDeduction: tenantConfig.monthlyHoursHolidayDeduction ?? undefined,
            vocationalSchoolMinutesPerDay: tenantConfig.vocationalSchoolMinutesPerDay ?? undefined,
            vocationalSchoolBlockMinutesPerWeek:
              tenantConfig.vocationalSchoolBlockMinutesPerWeek ?? undefined,
            // Phase 76.31 (D-06) — TenantConfig slot layer.
            bsSlotFirstLongDayMinutes: tenantConfig.bsSlotFirstLongDayMinutes ?? undefined,
            bsSlotSecondLongDayMinutes: tenantConfig.bsSlotSecondLongDayMinutes ?? undefined,
            bsSlotShortDayMinutes: tenantConfig.bsSlotShortDayMinutes ?? undefined,
            bsSlotBlockWeekMinutes: tenantConfig.bsSlotBlockWeekMinutes ?? undefined,
          }
        : null,
      // Phase 76.31 (D-06) — Employee/Pattern slot layers (null → fallback).
      employeeSlots,
      patternSlots,
      // Phase 76.39 (D-11 cleanup) — active pattern's per-DOW Unterrichtszeit map.
      patternUnterrichtsMinutenByDow,
    });

    // Thread carryOver for next month (§2.3 RESEARCH).
    accumulatedCarryOver = result.effectiveCarryOverOut;
    // Accumulate complete-month balance (already net — do NOT also add via leave/absence path).
    openPeriodBalance += result.balanceMinutes;
  }

  // ── Current partial month: ONE closeEmployeeMonth() call (Phase 76.39, D-07) ─
  //
  // The calendar month containing effectiveEnd is the CURRENT PARTIAL month. It is
  // computed by the SAME shared closeEmployeeMonth() core as every close/cron/recalc path
  // (Phase 76.39 consolidation), so BS handling — including the v1.8.27 single-count fix —
  // is identical live vs closed. An earlier note here claimed a "live-path bsExpectedMinutes
  // gap ... do NOT fix"; that gap no longer exists (the live path was rewired through the
  // shared core) and the stale note has been removed.
  // For SHIFT_BASED: roster-prorated via rosterProration (D-07).
  // For non-SHIFT: flat calcExpectedMinutesTz over the current-month open range only.
  //
  // currentMonthOpenStart: the later of rangeStart and the current month's UTC start.
  // If rangeStart is already within the current month (no complete open months), the
  // entire open range is the current partial month.

  const currentMonthOpenStart =
    currentMonthRange.start < rangeStart ? rangeStart : currentMonthRange.start;

  // Current-month leave and absences (filtered from pre-fetched collections)
  const curLeave = allApprovedLeave.filter(
    (lr) => lr.startDate <= currentMonthRange.end && lr.endDate >= currentMonthRange.start,
  );
  const curAbsences = allAbsences.filter(
    (ab) => ab.startDate <= currentMonthRange.end && ab.endDate >= currentMonthRange.start,
  );

  // ── Current partial month: ONE closeEmployeeMonth() call (Phase 76.39, D-07) ─
  //
  // Replaces the former ~400-line inline replica (SHIFT_BASED roster-proration +
  // non-SHIFT flat calc + a redundant SHIFT_BASED BS-doubling DB loop). The shared
  // core now computes the current partial month exactly like every close/cron/recalc
  // path, with two partial-month adaptations threaded via input:
  //   1. rosterProration (SHIFT_BASED only) — scales the effective Soll by roster
  //      progress (R_toDate ÷ R_periodFull), preserving the §615 open-month semantics.
  //   2. monthEnd/monthLastDay — for non-SHIFT, monthEnd = effectiveEnd so
  //      calcExpectedMinutesTz covers ONLY the open window; for SHIFT_BASED, monthEnd =
  //      currentMonthRange.end (full-month C_net) while monthLastDay = effectiveEnd
  //      (partial window for shift/entry clamping). See RESEARCH §8.1.
  //   3. holidayDateStrings = partialHolidayExclude — window-filtered so no out-of-window
  //      holiday inflates the partial expected (SNAP-01 guard, RESEARCH §4).
  //
  // BS-doubling (SHIFT_BASED + non-SHIFT) is now handled purely inside the core from the
  // pre-fetched absences (with unterrichtsMinutes) + employeeSlots/patternSlots — no more
  // per-day getVocationalSchoolMinutesForDate DB calls.

  // Phase 97-01 (SALDO-DISP-07) — set only inside the SHIFT_BASED branch below, right after
  // rosterProration is assigned. Stays undefined for every non-SHIFT_BASED schedule AND
  // whenever there is no open partial month at all (this whole block is skipped) — never a
  // fabricated `false` for a schedule type that has no roster proration.
  let rosterIncomplete: boolean | undefined;

  // effectiveEnd < currentMonthOpenStart → no open partial month (nothing to add).
  if (effectiveEnd >= currentMonthOpenStart) {
    const { firstDay: curMonthFirstDay, lastDay: curMonthLastDay } = monthDayBounds(
      currentMonthRange.start,
      currentMonthRange.end,
      tz,
    );

    // Load Employee + active-Pattern bsSlot* overrides + per-DOW Unterrichtszeit map for
    // the current month (same convention as the complete-months loop above).
    const { employeeSlots, patternSlots, patternUnterrichtsMinutenByDow } =
      await loadBsSlotOverrides(app.prisma, employeeId, curMonthFirstDay);

    // Pre-compute rosterProration for SHIFT_BASED (partial month only). R_toDate uses shifts
    // up to effectiveEnd (coveredDates for the open window); R_periodFull uses ALL current-
    // month shifts (coveredDates for the full month). getEffectiveBreakDuration/netto match
    // the core's shift-netto computation.
    let rosterProration: { rosterToDateMinutes: number; rosterPeriodMinutes: number } | undefined;
    if (scheduleType === "SHIFT_BASED") {
      const employeeBreakShape = {
        breakOver6hOverride: employee?.breakOver6hOverride ?? null,
        breakOver9hOverride: employee?.breakOver9hOverride ?? null,
      };
      const tenantConfigShape = {
        defaultBreakOver6h: tenantConfig?.defaultBreakOver6h ?? 30,
        defaultBreakOver9h: tenantConfig?.defaultBreakOver9h ?? 45,
      };
      const hmToMin = (hm: string) => {
        const [h, m] = hm.split(":").map(Number);
        return (h ?? 0) * 60 + (m ?? 0);
      };
      const sumShiftNetto = (
        list: { date: Date; startTime: string; endTime: string }[],
        covered: Set<string>,
      ): number => {
        let total = 0;
        for (const sh of list) {
          if (covered.has(dateStrInTz(sh.date, tz))) continue;
          let brutto = hmToMin(sh.endTime) - hmToMin(sh.startTime);
          if (brutto < 0) brutto += 24 * 60;
          if (brutto <= 0) continue;
          const breakMin = getEffectiveBreakDuration(employeeBreakShape, tenantConfigShape, brutto);
          total += Math.max(0, brutto - breakMin);
        }
        return total;
      };
      const buildCovered = (windowStart: Date, windowEnd: Date): Set<string> => {
        const set = new Set<string>();
        const add = (rangeStartD: Date, rangeEndD: Date) => {
          const s = rangeStartD < windowStart ? windowStart : rangeStartD;
          const e = rangeEndD > windowEnd ? windowEnd : rangeEndD;
          if (s > e) return;
          const cur = new Date(dateStrInTz(s, tz) + "T00:00:00Z");
          const last = new Date(dateStrInTz(e, tz) + "T00:00:00Z");
          while (cur <= last) {
            set.add(dateStrInTz(cur, tz));
            cur.setUTCDate(cur.getUTCDate() + 1);
          }
        };
        for (const lr of curLeave) add(lr.startDate, lr.endDate);
        for (const ab of curAbsences) add(ab.startDate, ab.endDate);
        return set;
      };

      const curMonthAllShifts = allShifts.filter(
        (s) => s.date >= curMonthFirstDay && s.date <= curMonthLastDay,
      );
      const curShiftsToDate = curMonthAllShifts.filter((s) => s.date <= effectiveEnd);
      const coveredToDate = buildCovered(currentMonthOpenStart, effectiveEnd);
      const monthCovered = buildCovered(currentMonthRange.start, currentMonthRange.end);
      rosterProration = {
        rosterToDateMinutes: sumShiftNetto(curShiftsToDate, coveredToDate),
        rosterPeriodMinutes: sumShiftNetto(curMonthAllShifts, monthCovered),
      };

      // Phase 97-01 (SALDO-DISP-07, 97-RESEARCH Q4 corrected signal) — the remainder of the
      // roster is unplanned when every EXISTING shift already lies in the past (rosterToDate
      // consumed the entire rosterPeriod) while today is still before the month's last day.
      // The `rosterPeriodMinutes > 0` guard is load-bearing: without it the pre-existing
      // "nothing rostered at all" zero-state (guarded separately in shift-based-saldo.ts,
      // contribution 0) would collide with this state because 0 === 0.
      //
      // WR-01 (code review) — this "days remain in the month" clause is intentionally
      // anchored to `todayStr` (literal calendar today), NOT `effectiveEnd`/windowEnd
      // (today-or-yesterday, whichever has a completed entry). computeMonthSaldo's own
      // rosterIncomplete (month-saldo.ts) is anchored to the SAME `todayStr` for the SAME
      // reason: the flag answers "is there still unplanned roster ahead of *now*", which
      // does not depend on whether today's own time entry happens to be logged yet. Using
      // windowEnd would make the two flags disagree on the last calendar day of a month
      // with no entry yet that day (windowEnd = yesterday, one day short of month-end) —
      // see overtime-live-vs-monthsaldo-parity.test.ts's "WR-01" describe block for the
      // regression case this anchor choice is pinned against.
      rosterIncomplete =
        rosterProration.rosterPeriodMinutes > 0 &&
        rosterProration.rosterToDateMinutes === rosterProration.rosterPeriodMinutes &&
        todayStr < dateStrInTz(curMonthLastDay, tz);
    }

    // Window-filtered holiday set (partial open window only — SNAP-01 guard).
    const openStartStr = dateStrInTz(currentMonthOpenStart, tz);
    const openEndStr = dateStrInTz(effectiveEnd, tz);
    const partialHolidayExclude = new Set(
      [...holidayDateStrSet].filter((d) => d >= openStartStr && d <= openEndStr),
    );

    // monthEnd: SHIFT_BASED → full-month end (C_net Soll); non-SHIFT → effectiveEnd
    // (partial-window expected). monthLastDay = effectiveEnd for shift/entry clamping.
    const partialMonthEnd = scheduleType === "SHIFT_BASED" ? currentMonthRange.end : effectiveEnd;

    const partialResult = closeEmployeeMonth({
      employeeId,
      monthStart: currentMonthRange.start,
      monthEnd: partialMonthEnd,
      monthFirstDay: curMonthFirstDay,
      monthLastDay: effectiveEnd, // partial window end
      tz,
      carryOverIn: accumulatedCarryOver,
      schedule: schedule as Record<string, unknown>,
      hireDate: employee!.hireDate,
      exitDate: null, // live path — still employed
      isTimeTrackingExempt: false,
      breakOver6hOverride: employee?.breakOver6hOverride ?? null,
      breakOver9hOverride: employee?.breakOver9hOverride ?? null,
      entries: entries
        .filter((e) => e.date >= curMonthFirstDay && e.date <= effectiveEnd)
        .map((e) => ({
          date: e.date,
          startTime: e.startTime,
          endTime: e.endTime!,
          breakMinutes: e.breakMinutes ?? 0,
        })),
      shifts: allShifts.filter((s) => s.date >= curMonthFirstDay && s.date <= effectiveEnd),
      approvedLeave: curLeave.map((lr) => ({
        startDate: lr.startDate,
        endDate: lr.endDate,
        halfDay: lr.halfDay,
      })),
      absences: curAbsences.map((ab) => ({
        startDate: ab.startDate,
        endDate: ab.endDate,
        type: ab.type,
        source: ab.source,
        halfDay: ab.halfDay,
        unterrichtsMinutes: ab.unterrichtsMinutes ?? undefined,
      })),
      holidayDateStrings: partialHolidayExclude,
      tenantConfig: tenantConfig
        ? {
            defaultBreakOver6h: tenantConfig.defaultBreakOver6h,
            defaultBreakOver9h: tenantConfig.defaultBreakOver9h,
            monthlyHoursHolidayDeduction: tenantConfig.monthlyHoursHolidayDeduction ?? undefined,
            vocationalSchoolMinutesPerDay: tenantConfig.vocationalSchoolMinutesPerDay ?? undefined,
            vocationalSchoolBlockMinutesPerWeek:
              tenantConfig.vocationalSchoolBlockMinutesPerWeek ?? undefined,
            bsSlotFirstLongDayMinutes: tenantConfig.bsSlotFirstLongDayMinutes ?? undefined,
            bsSlotSecondLongDayMinutes: tenantConfig.bsSlotSecondLongDayMinutes ?? undefined,
            bsSlotShortDayMinutes: tenantConfig.bsSlotShortDayMinutes ?? undefined,
            bsSlotBlockWeekMinutes: tenantConfig.bsSlotBlockWeekMinutes ?? undefined,
          }
        : null,
      employeeSlots,
      patternSlots,
      patternUnterrichtsMinutenByDow,
      rosterProration, // Phase 76.39 (D-07): SHIFT_BASED only; undefined for non-SHIFT
    });

    // The partial-month balance is added to openPeriodBalance. carryOver threading stops
    // here (the displayed saldo is snapshotCarryOver + openPeriodBalance — SNAP-01).
    openPeriodBalance += partialResult.balanceMinutes;
  }

  // totalBalanceHours = (snapshotCarryOver from lastSnapshot) + openPeriodBalance
  // (complete-months loop threads effectiveCarryOverOut, but the final balance displayed
  // to the user is always relative to the snapshotCarryOver base — SNAP-01).
  const totalBalanceHours = (snapshotCarryOver + openPeriodBalance) / 60;

  // D-06: TRACK_ONLY mode — display balance as 0 (hours are tracked but not accumulated)
  const isTrackOnly =
    String(schedule.type) === "MONTHLY_HOURS" && schedule.overtimeMode === "TRACK_ONLY";
  const effectiveBalanceHours = isTrackOnly ? 0 : totalBalanceHours;

  // Phase 97-01 (SALDO-DISP-01/03) — confirmed/forecast decomposition of the SAME total.
  // openMonthMinutes is ALWAYS total − confirmed (a subtraction, never a second call into the
  // saldo core) — 97-CONTEXT's "one computation path" rule (Phase 98 exists precisely because a
  // value once had two owners that diverged silently; do not repeat that shape here).
  const hasClosedMonth = confirmed.hasClosedMonth;
  // TRACK_ONLY already forces the reported total to 0 above; force BOTH split figures to 0 too
  // so a legacy non-zero snapshotCarryOver never surfaces as a phantom negative forecast
  // (naive 0 − confirmedMinutes would go negative). hasClosedMonth still reports the truth.
  const confirmedMinutes = isTrackOnly ? 0 : snapshotCarryOver;
  const openMonthMinutes = isTrackOnly
    ? 0
    : Math.round(effectiveBalanceHours * 60) - confirmedMinutes;

  return {
    totalHours: effectiveBalanceHours,
    confirmedMinutes,
    openMonthMinutes,
    hasClosedMonth,
    rosterIncomplete,
  };
}

// Thin, signature-preserving wrapper around computeOvertimeBalanceBreakdown (Phase 97-01) — MUST
// stay byte-behaviour-identical to the pre-Phase-97 computeOvertimeBalanceHours for its three
// external consumers (packages/mcp/src/index.ts, the `read:overtime` API-key scope, and
// updateOvertimeAccount just below). Never add logic here; extend the breakdown instead.
export async function computeOvertimeBalanceHours(
  app: FastifyInstance,
  employeeId: string,
): Promise<number | null> {
  const breakdown = await computeOvertimeBalanceBreakdown(app, employeeId);
  if (breakdown === null) return null;
  return breakdown.totalHours;
}

// ── Überstundensaldo berechnen UND persistieren (event-driven writer) ─────────
// Thin wrapper around computeOvertimeBalanceHours (single source of truth): recomputes the live
// lifetime saldo through windowEnd and upserts OvertimeAccount.balanceHours. Called on every
// time-entry mutation + month close/unlock. Exempt employees (compute → null) are skipped without
// resetting the stored value (preserve audit trail).
export async function updateOvertimeAccount(app: FastifyInstance, employeeId: string) {
  const effectiveBalanceHours = await computeOvertimeBalanceHours(app, employeeId);
  if (effectiveBalanceHours === null) return; // §18-exempt — do not touch stored balance

  // Phase 100B Plan 06 (D-10/G4): setOvertimeAccountBalance requires a tenantId parameter for
  // facade signature uniformity, even though this caller-facing function's own signature stays
  // (app, employeeId) unchanged (many call sites, out of this plan's scope) — so it resolves the
  // employee's tenantId itself, once, right before the write.
  const emp = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: { tenantId: true },
  });
  const account = await setOvertimeAccountBalance(
    app.prisma,
    employeeId,
    emp?.tenantId ?? "",
    effectiveBalanceHours,
  );

  const schedule = await getEffectiveSchedule(app, employeeId);
  const threshold = Number(schedule.overtimeThreshold);
  if (Number(account.balanceHours) >= threshold) {
    app.log.warn(
      `⚠️  Mitarbeiter ${employeeId} hat ${account.balanceHours}h Überstunden (Threshold: ${threshold}h)`,
    );
  }
}
