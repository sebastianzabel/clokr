/**
 * Frozen pre-Phase-79 working-time arithmetic — Issue #79 (R5/R6), D-10/D-12 reference fixture.
 *
 * VERBATIM copies of the twelve working-time expressions that existed inline before the duration
 * kernel (`entry-durations.ts`) replaced them, taken with `git show f1fbb71f:<path>` (commit
 * `f1fbb71f`, the last commit before Phase 79 touched any of these files) — never from an edited
 * file. The sources (all under `apps/api/src/`):
 *
 *   S1  contexts/working-time-account/close-employee-month.ts:692-693   per-entry
 *   S2  contexts/working-time-account/overtime-balance.ts:194-197       left fold
 *   S3  contexts/working-time-account/month-saldo.ts:194-197            left fold
 *   S4  composition/dashboard.ts:113-119                                loop, per-entry +=
 *   S5  composition/dashboard.ts:167-173                                loop, per-entry +=
 *   S6  composition/dashboard.ts:553-560                                loop, per-entry +=
 *   S7  composition/dashboard.ts:1193-1200                              left fold
 *   S8  composition/reports.ts:312-318                                  per-entry, rounded by the caller
 *   S9  composition/reports.ts:520-525                                  left fold (DATEV)
 *   S10 contexts/time-tracking/arbzg.ts:168-175                         per-slot loop
 *   S11 contexts/time-tracking/arbzg.ts:337-340                         left fold
 *   S12 contexts/time-tracking/arbzg.ts:401-404                         left fold
 *
 * The arithmetic statements are token-identical to the sources; only an enclosing function, the
 * parameter types and the result `return` were added, and formatting may be reflowed by prettier.
 * The operation ORDER is the contract: floats are not associative, and `a + b - c` is
 * `(a + b) - c`, which differs in the last bit from `a + (b - c)` for millisecond-precision rows.
 *
 * NEVER edit this file to make a test pass. NEVER import it from production code.
 */

/** Structural row type shared by all twelve shapes (the Prisma rows carry more fields). */
export type LegacyEntryRow = {
  startTime: Date;
  endTime: Date | null;
  breakMinutes: number | bigint | null;
  isInvalid?: boolean;
};

/** S1 — one closed entry, as typed in close-employee-month.ts (`breakMinutes: bigint | number`). */
export function legacyCloseEmployeeMonthNetMinutes(e: {
  startTime: Date;
  endTime: Date;
  breakMinutes: bigint | number;
}): number {
  const netMinutes = (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
  return netMinutes;
}

/** S2 — overtime-balance.ts left fold; an open entry leaves the sum unchanged. */
export function legacyOvertimeBalanceWorkedMinutes(entries: LegacyEntryRow[]): number {
  const workedMinutes = entries.reduce((sum, e) => {
    if (!e.endTime) return sum;
    return sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
  }, 0);
  return workedMinutes;
}

/** S3 — month-saldo.ts left fold via a `slotMin` local (the caller's Math.round is not part of it). */
export function legacyMonthSaldoWorkedMinutes(entries: LegacyEntryRow[]): number {
  const workedMinutes = entries.reduce((sum, e) => {
    const slotMin = e.endTime ? (e.endTime.getTime() - e.startTime.getTime()) / 60000 : 0;
    return sum + slotMin - Number(e.breakMinutes ?? 0);
  }, 0);
  return workedMinutes;
}

/** S4 — dashboard.ts "today" loop. */
export function legacyDashboardTodayMinutes(todayEntries: LegacyEntryRow[]): number {
  let todayMinutes = 0;
  for (const e of todayEntries) {
    if (e.endTime) {
      todayMinutes +=
        (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
    }
  }
  return todayMinutes;
}

/** S5 — dashboard.ts period loop. */
export function legacyDashboardPeriodWorkedMinutes(periodEntries: LegacyEntryRow[]): number {
  let periodWorkedMinutes = 0;
  for (const e of periodEntries) {
    if (e.endTime) {
      periodWorkedMinutes +=
        (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
    }
  }
  return periodWorkedMinutes;
}

/** S6 — dashboard.ts team-week day loop; only valid (non-invalid) closed entries count. */
export function legacyDashboardTeamWeekDayMinutes(dayEntries: LegacyEntryRow[]): number {
  let workedMinutes = 0;
  for (const e of dayEntries) {
    if (!e.isInvalid && e.endTime) {
      workedMinutes +=
        (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
    }
  }
  return workedMinutes;
}

/** S7 — dashboard.ts my-week day left fold (`|| 0` on the break). */
export function legacyDashboardMyWeekDayMinutes(dayEntries: LegacyEntryRow[]): number {
  const workedMin = dayEntries.reduce((sum: number, e) => {
    if (!e.endTime) return sum;
    return (
      sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes || 0)
    );
  }, 0);
  return workedMin;
}

/** S8 — reports.ts per-entry netHours, including the caller's rounding and the open -> 0 branch. */
export function legacyReportsNetHours(e: LegacyEntryRow): number {
  const netHours = e.endTime
    ? Math.round(
        (((e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes ?? 0)) /
          60) *
          100,
      ) / 100
    : 0;
  return netHours;
}

/** S9 — reports.ts DATEV left fold (`?? 0` on the break). */
export function legacyDatevWorkedMinutes(entries: LegacyEntryRow[]): number {
  const workedMinutes = entries.reduce((sum, e) => {
    if (!e.endTime) return sum;
    return (
      sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes ?? 0)
    );
  }, 0);
  return workedMinutes;
}

/** S10 — arbzg.ts per-slot loop of the daily check; closed rows only (`endTime!`). */
export function legacyArbzgDaySlotTotals(daySlots: LegacyEntryRow[]): {
  netWorkedMin: number;
  explicitBreakMin: number;
} {
  let netWorkedMin = 0;
  let explicitBreakMin = 0;

  for (const slot of daySlots) {
    const slotMin = (slot.endTime!.getTime() - slot.startTime.getTime()) / 60000;
    explicitBreakMin += Number(slot.breakMinutes ?? 0);
    netWorkedMin += slotMin - Number(slot.breakMinutes ?? 0);
  }
  return { netWorkedMin, explicitBreakMin };
}

/** S11 — arbzg.ts weekly check left fold; closed rows only (`endTime!`). */
export function legacyArbzgWeeklyNetMinutes(weekSlots: LegacyEntryRow[]): number {
  const weeklyNetMin = weekSlots.reduce((sum, e) => {
    const slotMin = (e.endTime!.getTime() - e.startTime.getTime()) / 60000;
    return sum + slotMin - Number(e.breakMinutes ?? 0);
  }, 0);
  return weeklyNetMin;
}

/** S12 — arbzg.ts 24-week average check left fold; closed rows only (`endTime!`). */
export function legacyArbzgAverageNetMinutes(avgEntries: LegacyEntryRow[]): number {
  const totalNetMin = avgEntries.reduce((sum, e) => {
    const slotMin = (e.endTime!.getTime() - e.startTime.getTime()) / 60000;
    return sum + slotMin - Number(e.breakMinutes ?? 0);
  }, 0);
  return totalNetMin;
}
