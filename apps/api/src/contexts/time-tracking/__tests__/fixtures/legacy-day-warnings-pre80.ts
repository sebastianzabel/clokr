/**
 * Frozen pre-Phase-80 day warnings — Issue #80 (80-AC6) reference fixture.
 *
 * VERBATIM copy of the day-level § 4 / § 3 statements that sat inline in `checkArbZG` before the
 * day kernel (`day-break-rule.ts`) replaced them: `apps/api/src/contexts/time-tracking/arbzg.ts`
 * lines 166-216, from `const dayIsWaived` through the closing brace of the `dailyTotalMin > 10 * 60`
 * block, taken with `git show 73838040:apps/api/src/contexts/time-tracking/arbzg.ts` (commit
 * `73838040`, the last commit before Phase 80 touched the file) — never from an edited file.
 *
 * The statements are token-identical to the source; only an enclosing function, the parameter
 * types, the local `warnings` array and the `return` were added, formatting may be reflowed by
 * prettier, and the German comments of the source were left out (the comment-language gate admits
 * no new ones). The operation ORDER is the contract: floats are not associative.
 *
 * NEVER edit this file to make a test pass. NEVER import it from production code.
 */
import { entryDurations } from "../../entry-durations";

/** The fields of a closed WORK entry the frozen day statements read. */
export type LegacyDaySlot = {
  startTime: Date;
  endTime: Date | null;
  breakMinutes: number | bigint | null;
  breakStatus?: string | null;
};

/** The shape of a day warning as the frozen statements push it. */
export type LegacyDayWarning = {
  code: "BREAK_TOO_SHORT" | "MAX_DAILY_EXCEEDED";
  severity: "warning" | "error";
  message: string;
  waived?: boolean;
};

/** The pre-80 § 4 / § 3 day warnings of one day's closed WORK slots (start order). */
export function legacyDayWarningsPre80(
  daySlots: LegacyDaySlot[],
  bsMinutesToday: number,
): LegacyDayWarning[] {
  const warnings: LegacyDayWarning[] = [];

  const dayIsWaived = daySlots.some((s) => s.breakStatus === "WAIVED");

  let netWorkedMin = 0;
  let explicitBreakMin = 0;

  for (const slot of daySlots) {
    const d = entryDurations(slot);
    explicitBreakMin += d.breakMinutes;
    netWorkedMin += d.workingMinutes;
  }

  let gapBreakMin = 0;
  for (let i = 1; i < daySlots.length; i++) {
    const gap = (daySlots[i].startTime.getTime() - daySlots[i - 1].endTime!.getTime()) / 60000;
    if (gap > 0 && gap <= 120) gapBreakMin += gap;
  }

  const totalBreakMin = explicitBreakMin + gapBreakMin;

  if (netWorkedMin > 9 * 60 && totalBreakMin < 45) {
    warnings.push({
      code: "BREAK_TOO_SHORT",
      severity: dayIsWaived ? "warning" : "error",
      message: `§ 4 ArbZG: Bei über 9 Stunden Arbeitszeit sind mindestens 45 Minuten Pause vorgeschrieben. Erfasst: ${Math.round(totalBreakMin)} Min.`,
      ...(dayIsWaived ? { waived: true } : {}),
    });
  } else if (netWorkedMin > 6 * 60 && totalBreakMin < 30) {
    warnings.push({
      code: "BREAK_TOO_SHORT",
      severity: "warning",
      message: `§ 4 ArbZG: Bei über 6 Stunden Arbeitszeit sind mindestens 30 Minuten Pause vorgeschrieben. Erfasst: ${Math.round(totalBreakMin)} Min.`,
      ...(dayIsWaived ? { waived: true } : {}),
    });
  }

  const dailyTotalMin = netWorkedMin + bsMinutesToday;
  if (dailyTotalMin > 10 * 60) {
    warnings.push({
      code: "MAX_DAILY_EXCEEDED",
      severity: "error",
      message: `§ 3 ArbZG: Tägliche Höchstarbeitszeit von 10 Stunden überschritten. Erfasst: ${(dailyTotalMin / 60).toFixed(1)} h.`,
    });
  }

  return warnings;
}
