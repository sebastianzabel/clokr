/**
 * Retroactive snapshot recalculation.
 *
 * When saldo-relevant data changes (schedule, leave, holidays),
 * existing monthly snapshots must be recalculated so that carry-over
 * values stay consistent.
 *
 * Phase 76.26-05 — P3 retroactive recalc rewired to closeEmployeeMonth shared core.
 * The per-snapshot inline saldo block (old lines 85-459) is replaced by a
 * closeEmployeeMonth(input) call. The supersede-then-create $transaction, app.audit(),
 * locked-month immutability, and cross-month carryOver chaining are preserved.
 *
 * Four-path parity: manual (P1) + cron (P2) + recalc (P3) now all call
 * closeEmployeeMonth — byte-identical SaldoSnapshot values guaranteed.
 * Live path (P4, time-entries.ts) remains for SNAP-03 (76.27).
 */
import { FastifyInstance } from "fastify";
import { getEffectiveSchedule } from "../routes/time-entries";
import { getTenantTimezone, dateStrInTz, monthRangeUtc, monthDayBounds } from "./timezone";
import { getHolidays, STATE_MAP } from "./holidays";
import { closeEmployeeMonth } from "./close-employee-month"; // Phase 76.26 — shared pure saldo core
import { loadBsSlotOverrides } from "./load-bs-slot-overrides"; // Phase 76.31 — D-06 slot overrides
import { isBridgeSnapshot } from "./saldo-snapshot-cleanup"; // 2026-08 hardening — SNAP-04 bridge guard
import { computeInjectedDelta } from "./saldo-chain-integrity"; // Phase 98 — shared delta formula
import { getCarryOverBase } from "./carry-over-base"; // Phase 99 (OB-02) — shared chain-head seed
import { isSnapshotLocked } from "./snapshot-lock"; // Phase 99 (OB-03/D-09) — immutability after lock

// Phase 99 (D-09) — a closed month that recalc skipped, reported so a caller can
// surface it to a human instead of the change happening silently.
export type SkippedLockedMonth = { snapshotId: string; periodStart: Date; periodEnd: Date };
export type RecalcResult = { lockedMonthsSkipped: SkippedLockedMonth[] };

/**
 * Recalculate all MONTHLY SaldoSnapshots for an employee starting from `fromDate`.
 *
 * - Only updates snapshots that already exist (does not create new ones).
 * - Recalculates workedMinutes, expectedMinutes, balanceMinutes, carryOver.
 * - Updates the OvertimeAccount with the final carryOver.
 * - Creates audit log entries per recalculated snapshot.
 * - Phase 99 (D-09): a CLOSED (locked) month is never superseded or rewritten — it is
 *   skipped and reported via the returned RecalcResult.lockedMonthsSkipped.
 *
 * Safe to call multiple times (idempotent).
 */
export async function recalculateSnapshots(
  app: FastifyInstance,
  employeeId: string,
  fromDate: Date,
): Promise<RecalcResult> {
  const lockedMonthsSkipped: SkippedLockedMonth[] = [];

  // Find all MONTHLY snapshots at or after fromDate
  const snapshots = await app.prisma.saldoSnapshot.findMany({
    where: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: { gte: fromDate },
      superseded: false,
    },
    orderBy: { periodStart: "asc" },
  });

  if (snapshots.length === 0) return { lockedMonthsSkipped };

  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      tenantId: true,
      hireDate: true,
      exitDate: true, // CLOSE-04: needed by closeEmployeeMonth
      isTimeTrackingExempt: true, // Phase 76.7 (D-06, SALDO-V19-04b)
      breakOver6hOverride: true, // SHIFT_BASED netto (parity with overtime.ts close-month)
      breakOver9hOverride: true,
      tenant: { select: { federalState: true } },
    },
  });
  if (!employee) return { lockedMonthsSkipped };
  // Phase 76.7 (D-06) — exempt employees never get snapshot recalcs.
  if (employee.isTimeTrackingExempt) return { lockedMonthsSkipped };

  const tz = await getTenantTimezone(app.prisma, employee.tenantId);
  const tenantConfig = await app.prisma.tenantConfig.findUnique({
    where: { tenantId: employee.tenantId },
  });

  // Get the carry-over from the snapshot immediately before the first affected one
  const prevSnapshot = await app.prisma.saldoSnapshot.findFirst({
    where: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: { lt: snapshots[0].periodStart },
      superseded: false,
    },
    orderBy: { periodStart: "desc" },
  });
  // Phase 99 (OB-02) — chain-head seed. getCarryOverBase() resolves
  // prevSnapshot?.carryOver ?? openingBalance?.minutes ?? 0: the opening balance is
  // consulted ONLY when there is no predecessor at all (a true chain head). Computed
  // ONCE here and reused below for the v1.9.14 guard's frozen base — NEVER call this
  // helper a second time for the same chain, or the two sites could resolve to
  // different bases if the underlying data changes between calls.
  const carryOverBase = await getCarryOverBase(app.prisma, employeeId, prevSnapshot);
  let runningCarryOver = carryOverBase;

  // ── 2026-08 hardening, round 2: unexplained-delta preservation ─────────────────
  //
  // The isBridgeSnapshot() skip below (kept — see its own comment for why) only
  // protects rows with NO real activity. It is blind to a row that has genuine
  // worked/expected activity AND also carries a hand-injected carry-over correction
  // on top (e.g. "Vor-Tracking-Leistung restore": an operator adds N minutes of
  // pre-Clokr overtime directly onto an already-real month's carryOver). Such a row
  // does not match the zero-activity shape, so the old guard let it fall through to
  // full recomputation — which silently overwrote the injection. This happened on
  // prod: a real-activity April snapshot went from a corrected 5216 down to 4200
  // (≈17h lost) via exactly this loop, tagged "retroactive recalculation".
  //
  // Fix: for every row, derive how much of its STORED carryOver is NOT explained by
  // "previous month's stored carryOver + this month's own stored balance". That
  // unexplained remainder — injectedDelta — is by definition the hand-injected part.
  // Recompute the row normally (legitimate worked/expected/balance), then add
  // injectedDelta back on top of the freshly computed carryOver. injectedDelta is 0
  // for every well-behaved row (its carryOver is fully explained by the chain), so
  // this is a mathematical no-op for the vast majority of snapshots.
  //
  // CRITICAL: injectedDelta MUST be computed from the ORIGINAL, pre-mutation stored
  // values — never from a row this same loop has already superseded/recreated.
  // Deriving "previous month's carryOver" from an already-recomputed row would erase
  // exactly the delta we're trying to preserve (the bug again, one level removed).
  // `snapshots` here is the raw findMany() result from above and is never written to
  // inside this loop (we only ever create NEW rows in the DB and track values in
  // local variables) — but we freeze it explicitly into its own map, rather than
  // relying on that invariant holding forever under future refactors.
  //
  // Phase 99 (OB-07) — KEPT DELIBERATELY, not left behind.
  // Once opening balances live in the OpeningBalance model, this guard becomes a no-op for
  // them (injectedDelta collapses to 0 — see the base rewire below). It is retained anyway:
  // it is the only protection against the OTHER class of path that caused the 2026-06-10
  // incident — one-off scripts that re-thread the chain outside this function entirely. The
  // value was destroyed once precisely because it had a single guardian. Retiring this guard
  // would be a tidy-up side effect, never a decision; if it ever becomes a burden that must be
  // its own reasoned change.
  // Also unchanged: the base MUST come from the ORIGINAL, pre-mutation stored values. Deriving
  // it from a row this loop has already superseded/recreated reintroduces the bug one level
  // removed. `carryOverBase` above is read once, before the loop, for exactly that reason.
  //
  // Phase 99 (OB-02) — WHY SITE B IS NOT OPTIONAL (do not "simplify" this back to `?? 0`):
  // injectedDelta = (storedCarryOver - balanceMinutes) - prevStoredCarryOver, and the guard
  // below adds that delta back on top of the freshly computed carryOver. For a migrated
  // employee the head row's stored carryOver ALREADY contains the opening balance. If the
  // chain-head seed above is seeded with the opening balance but this frozen base still used
  // `0`, then:
  //   - the legitimate recompute produces carryOver = OB + balance (correct), and
  //   - injectedDelta evaluates to OB - 0 = OB (non-zero), and
  //   - the guard adds OB a second time -> the displayed saldo silently DOUBLES the opening
  //     balance. It looks plausible (right sign, right rough magnitude) which is exactly why
  //     it is dangerous — see the OB-06 regression test, which pins an exact integer for
  //     precisely this reason.
  // Both sites resolve from the SAME `carryOverBase` local computed above. With both rewired,
  // injectedDelta collapses to 0 for exactly those head rows — the opening balance stops being
  // an "unexplained delta" and becomes an explained input.
  //
  // Phase 99 Plan 06 (OB-03) — head-row baseline refinement, found while building the admin
  // endpoint's Test 7 (an OpeningBalance created via the endpoint for an employee who ALREADY
  // has an existing, not-yet-recomputed head snapshot). Site B above assumes the stored head row
  // was already computed/patched WITH the current OpeningBalance in mind (true for an OB-04
  // migration-patched row, and true on the SECOND+ recalc after this fix runs once) — but a row
  // that predates the OpeningBalance entirely (S_old == B_old, i.e. its implied predecessor is
  // exactly 0 — the pristine "no carry-in at all" shape) does NOT meet that assumption. Using
  // carryOverBase as the delta baseline for such a row computes injectedDelta = -carryOverBase,
  // which then CANCELS the freshly-applied opening balance back to net zero — the admin's new
  // value silently vanishes from the very first recalc after creating it.
  //
  // Fix: only fall back to carryOverBase when the row's OWN implied predecessor
  // (storedCarryOver - storedBalanceMinutes) is non-zero — i.e. some value (an unrelated hand
  // injection, OR an already-applied opening balance) is actually present to preserve. When the
  // implied predecessor is exactly 0, there is nothing to preserve: use 0 as the baseline so the
  // recompute's own carryOverBase (which already resolves the OB) applies cleanly. This is a
  // NARROWING of the guard (it only stops protecting a delta that is provably absent), never a
  // relaxation — a genuine unrelated hand injection with a non-zero implied predecessor still
  // falls through to the original carryOverBase baseline, byte-identical to before this change.
  const frozenPrevStoredCarryOverById = new Map<string, number>();
  snapshots.forEach((s, i) => {
    if (i === 0) {
      const impliedPredecessor = s.carryOver - s.balanceMinutes;
      frozenPrevStoredCarryOverById.set(s.id, impliedPredecessor === 0 ? 0 : carryOverBase);
    } else {
      frozenPrevStoredCarryOverById.set(s.id, snapshots[i - 1].carryOver);
    }
  });

  for (const snapshot of snapshots) {
    // ── 2026-08 hardening: bridge/opening-balance rows MUST NOT be superseded ──
    // A bridge is a manually-injected carry-in for a previously-untracked period
    // (expectedMinutes==0 && workedMinutes==0 && balanceMinutes==0 && carryOver!=0 —
    // see isBridgeSnapshot() in saldo-snapshot-cleanup.ts, the single source of truth).
    //
    // Prod incident: this loop unconditionally supersedes+recreates every snapshot in
    // range with recomputed values. For a bridge row, "recomputed" means expected=0,
    // worked=0, balance=0, carryOver=0 (there is no activity to compute — the row only
    // exists to seed an opening balance). That silently ZEROED ~102h of legitimately
    // earned pre-tracking overtime on prod; the value had to be manually re-injected
    // into a later month, which was then equally exposed to the same bug.
    //
    // auto-close-month.ts's SNAP-02/SNAP-04 backfill loop never hits this problem
    // because its idempotency check (existingSnap lookup) skips ANY month that already
    // has an active snapshot — bridges included, as a side effect of "already closed".
    // This loop's entire purpose is to touch already-existing snapshots, so it needs
    // this explicit shape check instead. Mirror auto-close-month.ts's threading exactly:
    // skip the row entirely (no supersede, no recreate, no audit entry — nothing
    // changed, so nothing to log) and carry its stored carryOver forward unchanged as
    // the carry-in for the next month in the chain.
    //
    // KEPT deliberately alongside injectedDelta preservation below (NOT redundant):
    // a pure zero-activity bridge row, if allowed through to full recompute, risks
    // getEffectiveSchedule() conjuring a real (often large) Soll for a period that was
    // never meant to be tracked at all (e.g. any FIXED_WEEKLY/FLEXTIME/MONTHLY_HOURS
    // schedule already validFrom-active before the bridge period would produce a
    // nonzero expectedMinutes against zero real workedMinutes — a fabricated deficit).
    // injectedDelta preservation only protects the carryOver figure; it does nothing
    // to stop a fabricated Soll/Ist from being computed and stored for the row's own
    // month. The full-row freeze remains the only safe handling for genuine
    // zero-activity bridges; injectedDelta preservation below handles the DIFFERENT
    // case of a real-activity row with an injected correction on top.
    if (isBridgeSnapshot(snapshot)) {
      runningCarryOver = snapshot.carryOver;
      continue;
    }

    // Phase 99 (D-09) — immutability after lock. Until now this loop superseded EVERY
    // month in range, closed ones included, against CLAUDE.md's "Once a month is
    // closed, entries MUST NOT be editable — not even by admins". A closed month is
    // skipped and reported, never rewritten: its stored carryOver threads forward
    // unchanged (same handling as a bridge row), so the chain stays continuous and the
    // following months still recalculate correctly.
    if (await isSnapshotLocked(app.prisma, employeeId, snapshot.periodStart, snapshot.periodEnd)) {
      lockedMonthsSkipped.push({
        snapshotId: snapshot.id,
        periodStart: snapshot.periodStart,
        periodEnd: snapshot.periodEnd,
      });
      app.log.info(
        {
          employeeId: employeeId.slice(0, 8), // truncated, no PII (Phase 98 DSGVO convention)
          periodStart: snapshot.periodStart.toISOString().slice(0, 10),
          periodEnd: snapshot.periodEnd.toISOString().slice(0, 10),
        },
        "[recalculateSnapshots] skipped a locked month (immutability after lock)",
      );
      runningCarryOver = snapshot.carryOver;
      continue;
    }

    const prevStoredCarryOver = frozenPrevStoredCarryOverById.get(snapshot.id) ?? 0;
    // Phase 98: the delta formula now lives in ONE place (saldo-chain-integrity.ts) so the
    // v1.9.14 preservation path and the AUDIT-CHAIN-01 detector cannot drift apart. The
    // arithmetic is unchanged: (carryOver - balanceMinutes) - prevStoredCarryOver.
    const injectedDelta = computeInjectedDelta(snapshot, prevStoredCarryOver);

    const oldValues = {
      workedMinutes: snapshot.workedMinutes,
      expectedMinutes: snapshot.expectedMinutes,
      balanceMinutes: snapshot.balanceMinutes,
      carryOver: snapshot.carryOver,
    };

    // Derive the CANONICAL month range from the stored period instead of using
    // periodStart/periodEnd directly:
    //   - periodStart is convention-ambiguous (TZ-converted rows store the previous
    //     month's last day, e.g. 2026-05-31 for June/Berlin; legacy UTC-naive rows
    //     store the 1st). Iterating expected from the raw periodStart added ONE
    //     EXTRA Soll day for TZ-converted rows.
    //   - the mid-period instant is safely inside the month under BOTH conventions.
    const midMonth = new Date((snapshot.periodStart.getTime() + snapshot.periodEnd.getTime()) / 2);
    const { start: monthStart, end: monthEnd } = monthRangeUtc(
      midMonth.getUTCFullYear(),
      midMonth.getUTCMonth() + 1,
      tz,
    );
    const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
      monthStart,
      monthEnd,
      tz,
    );

    // Get the effective schedule for the middle of this month
    const schedule = await getEffectiveSchedule(app, employeeId, midMonth);

    // ── Phase 76.26-05: assemble CloseMonthInput and call the shared pure core ──
    //
    // P3 retroactive recalc rewire: the inline saldo block (old lines 85-459) is replaced
    // by closeEmployeeMonth(input). effectiveStart is now computed inside the core
    // (max(hireDate, monthFirstDay) — TZ-normalized). The phase-2 bsExpectedMinutes fold
    // (old lines 404-437) is now owned by the core (no inline bsExpectedMinutes here).
    //
    // Pre-fetch pattern mirrors P1 (overtime.ts) and P2 (auto-close-month.ts) rewires
    // from Plans 03 and 04.

    // Build holiday set: merge computed German Feiertage + DB-stored manual holidays.
    // Year from MID-month — monthStart.getUTCFullYear() is the PREVIOUS year for
    // January in UTC+ timezones (2025-12-31T23:00Z), which silently skipped all
    // January holidays (Neujahr) in the recalc.
    const snapYear = midMonth.getUTCFullYear();
    const snapStateCode = employee.tenant
      ? (STATE_MAP[employee.tenant.federalState] ?? "NI")
      : "NI";

    // Effective start: hire date or first day of month, whichever is later — used for
    // the holiday filter to match the inline path's filter (byte-identical query range).
    const hireDateNorm = employee.hireDate
      ? new Date(dateStrInTz(employee.hireDate, tz) + "T00:00:00Z")
      : null;
    const effectiveStartForHolidayFilter =
      hireDateNorm && hireDateNorm > monthFirstDay ? hireDateNorm : monthFirstDay;

    const computedHolidays = getHolidays(snapYear, snapStateCode).filter(
      (h) =>
        h.date >= dateStrInTz(effectiveStartForHolidayFilter, tz) &&
        h.date <= dateStrInTz(monthEnd, tz),
    );
    const computedDateSet = new Set(computedHolidays.map((h) => h.date));
    const dbSnapHolidays = await app.prisma.publicHoliday.findMany({
      where: {
        tenant: { employees: { some: { id: employeeId } } },
        date: { gte: effectiveStartForHolidayFilter, lte: monthLastDay },
      },
    });
    const holidayDateStrings = new Set<string>([
      ...computedHolidays.map((h) => h.date),
      ...dbSnapHolidays
        .filter((h) => !computedDateSet.has(dateStrInTz(h.date, tz)))
        .map((h) => dateStrInTz(h.date, tz)),
    ]);

    // Pre-fetch all collections needed by closeEmployeeMonth (parallel for PERF).
    // SHIFT_BASED: shifts also fetched for non-SHIFT; core ignores them for non-SHIFT types.
    const [closeEntries, closeShifts, closeApprovedLeave, closeAbsences] = await Promise.all([
      // WORK entries (effectiveStart..monthLastDay, soft-delete + isInvalid filter)
      app.prisma.timeEntry.findMany({
        where: {
          employeeId,
          deletedAt: null,
          date: { gte: effectiveStartForHolidayFilter, lte: monthLastDay },
          endTime: { not: null },
          type: "WORK",
          isInvalid: false,
        },
        select: { date: true, startTime: true, endTime: true, breakMinutes: true },
      }),
      // Shifts (SHIFT_BASED — soft-deleted shifts excluded, Phase 67.2)
      app.prisma.shift.findMany({
        where: {
          employeeId,
          date: { gte: effectiveStartForHolidayFilter, lte: monthLastDay },
          deletedAt: null,
        },
        select: { date: true, startTime: true, endTime: true },
      }),
      // Approved leave
      app.prisma.leaveRequest.findMany({
        where: {
          employeeId,
          deletedAt: null, // required by soft-delete convention
          status: "APPROVED",
          startDate: { lte: monthEnd },
          endDate: { gte: monthStart },
        },
        select: { startDate: true, endDate: true, halfDay: true },
      }),
      // All absences (including VOCATIONAL_SCHOOL — BS-doubling handled in closeEmployeeMonth core).
      // Phase 63: const bsAbsences = await app.prisma.absence.findMany (type:"VOCATIONAL_SCHOOL")
      // is now inside closeEmployeeMonth via the full absences array (all types included).
      app.prisma.absence.findMany({
        where: {
          employeeId,
          deletedAt: null, // required by soft-delete convention
          startDate: { lte: monthEnd },
          endDate: { gte: effectiveStartForHolidayFilter },
        },
        select: {
          startDate: true,
          endDate: true,
          type: true,
          source: true,
          halfDay: true,
          // Phase 76.38 (D-11) — per-day Unterrichtszeit for duration-based BS slot.
          unterrichtsMinutes: true,
        },
      }),
    ]);

    // ── Call the shared pure saldo core ──────────────────────────────────────
    // carryOverIn = runningCarryOver from the previous snapshot in this iteration chain
    // (or the pre-existing prevSnapshot carryOver for the first snapshot — initialized above).
    // carryOverOut is threaded back into runningCarryOver after the $transaction.
    //
    // Phase 76.26-05 D-01: Phase-2 bsExpectedMinutes fold (old :404-437) is now
    // handled inside closeEmployeeMonth — REMOVED from the caller.
    //
    // Phase 76.31 (D-06): load Employee + active-Pattern bsSlot* overrides so the
    // recompute honors per-MA / per-pattern slot amounts (null → fallback).
    const { employeeSlots, patternSlots, patternUnterrichtsMinutenByDow } =
      await loadBsSlotOverrides(app.prisma, employeeId, monthFirstDay);

    const r = closeEmployeeMonth({
      employeeId,
      monthStart,
      monthEnd,
      monthFirstDay,
      monthLastDay,
      tz,
      carryOverIn: runningCarryOver,
      schedule: schedule as Record<string, unknown>,
      hireDate: employee.hireDate,
      exitDate: employee.exitDate ?? null,
      isTimeTrackingExempt: false, // already short-circuited above via employee.isTimeTrackingExempt
      breakOver6hOverride: employee.breakOver6hOverride ?? null,
      breakOver9hOverride: employee.breakOver9hOverride ?? null,
      entries: closeEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes,
      })),
      shifts: closeShifts.map((sh) => ({
        date: sh.date,
        startTime: sh.startTime,
        endTime: sh.endTime,
      })),
      approvedLeave: closeApprovedLeave.map((lr) => ({
        startDate: lr.startDate,
        endDate: lr.endDate,
        halfDay: Boolean(lr.halfDay),
      })),
      // Phase 76.12 D-14: halfDay: Boolean(lr.halfDay) and calcLeaveAbsenceMinutesTz
      // are now inside closeEmployeeMonth; the mapping above preserves the halfDay field.
      // Phase 76.32.1 (Wave 4): halfDay: ab.halfDay threaded through absence mapper.
      absences: closeAbsences.map((ab) => ({
        startDate: ab.startDate,
        endDate: ab.endDate,
        type: ab.type,
        source: ab.source,
        halfDay: ab.halfDay,
        unterrichtsMinutes: ab.unterrichtsMinutes ?? null,
      })),
      holidayDateStrings,
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
      // Phase 76.38 (D-11) — Pattern per-DOW Unterrichtszeit fallback.
      patternUnterrichtsMinutenByDow,
    });

    const {
      workedMinutes,
      balanceMinutes,
      carryOverOut,
      effectiveCarryOverOut,
      snapshotExpectedMinutes,
    } = r;

    // Apply the preserved injectedDelta on top of the freshly recomputed carryOver.
    // Exception: MONTHLY_HOURS/TRACK_ONLY employees never carry ANY saldo — closeEmployeeMonth
    // forces effectiveCarryOverOut to 0 for them regardless of carryOverIn+balanceMinutes
    // (see close-employee-month.ts's isTrackOnly zeroing). Detect that zeroing by comparing
    // effectiveCarryOverOut against the pre-zeroing carryOverOut; if it fired, preserve the
    // 0 (matching the existing TRACK_ONLY contract) instead of re-introducing a carryOver via
    // injectedDelta. A nonzero injectedDelta on a TRACK_ONLY employee is a data anomaly on its
    // own (an opening balance was seeded for someone who structurally can't carry one) — surface
    // it via the same log line below rather than silently dropping or silently applying it.
    const isTrackOnlyZeroed = effectiveCarryOverOut !== carryOverOut;
    const carryOver = isTrackOnlyZeroed
      ? effectiveCarryOverOut
      : effectiveCarryOverOut + injectedDelta;

    // Non-zero injectedDelta must be visible, not silent — this is exactly the class of value
    // that got silently destroyed on prod. Log it (truncated employeeId — no PII) so a
    // preserved (or, for TRACK_ONLY, dropped-with-warning) injection is traceable.
    if (injectedDelta !== 0) {
      const logPayload = {
        employeeId: employeeId.slice(0, 8),
        periodStart: snapshot.periodStart.toISOString().slice(0, 10),
        periodEnd: snapshot.periodEnd.toISOString().slice(0, 10),
        injectedDelta,
        trackOnlyZeroed: isTrackOnlyZeroed,
      };
      if (isTrackOnlyZeroed) {
        app.log.warn(
          logPayload,
          "[recalculateSnapshots] non-zero injectedDelta on a TRACK_ONLY snapshot — dropped, not carried (TRACK_ONLY employees never hold a saldo)",
        );
      } else {
        app.log.info(
          logPayload,
          "[recalculateSnapshots] preserved a hand-injected carryOver delta across recompute",
        );
      }
    }

    // COMP-V1814-04: supersede the old snapshot, then create a fresh active row.
    // Never update in-place — closed history is immutable (Revisionssicherheit).
    // CR-01: wrap both operations in a single transaction so a crash between them
    // cannot orphan the period (old superseded, new never created → carry-over gap).
    await app.prisma.$transaction(async (tx) => {
      await tx.saldoSnapshot.update({
        where: { id: snapshot.id },
        data: { superseded: true, supersededReason: "retroactive recalculation" },
      });

      await tx.saldoSnapshot.create({
        data: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: snapshot.periodStart,
          periodEnd: snapshot.periodEnd,
          workedMinutes,
          expectedMinutes: snapshotExpectedMinutes,
          balanceMinutes,
          carryOver,
          closedAt: snapshot.closedAt,
          closedBy: snapshot.closedBy,
          note: snapshot.note,
          // superseded defaults to false (new active row)
        },
      });
    });

    // Audit log with old/new values
    await app.audit({
      userId: undefined, // system-initiated recalculation
      action: "SUPERSEDE",
      entity: "SaldoSnapshot",
      entityId: snapshot.id,
      oldValue: oldValues,
      newValue: {
        workedMinutes,
        expectedMinutes: snapshotExpectedMinutes,
        balanceMinutes,
        carryOver,
        superseded: true,
        reason: "retroactive recalculation",
        // 2026-08 hardening: always recorded (0 for the well-behaved majority) so the
        // audit trail makes an unexplained-delta preservation traceable, not mysterious.
        injectedDelta,
      },
    });

    // Thread carryOver chain: each month's carryOverIn = prior month's DELTA-ADJUSTED
    // carryOver (not the raw effectiveCarryOverOut) — the next iteration's injectedDelta
    // is computed from stored values anyway, but runningCarryOver feeds carryOverIn for
    // the *legitimate* part of the next month's recompute, which must reflect this
    // month's preserved value, not the delta-stripped one.
    runningCarryOver = carryOver;
  }

  // Update the OvertimeAccount with the final carry-over.
  // Note: P3 upsert is OUTSIDE the per-snapshot $tx (existing behaviour per RESEARCH §2 last row —
  // preserved intentionally; do NOT change atomicity in this phase).
  await app.prisma.overtimeAccount.upsert({
    where: { employeeId },
    create: { employeeId, balanceHours: runningCarryOver / 60 },
    update: { balanceHours: runningCarryOver / 60 },
  });

  return { lockedMonthsSkipped };
}
