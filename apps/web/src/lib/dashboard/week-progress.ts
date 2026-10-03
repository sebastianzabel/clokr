/**
 * Issue #451 (D-06) — the FLEXTIME "Diese Woche Soll" tile's delta. Pure, no `svelte`/`$app`
 * import so it is directly mountable in `vitest` (the dashboard page itself is not — see
 * `clock-out-result.ts`'s own docblock for why that behaviour-bearing logic lives here instead
 * of inline in `+page.svelte`).
 *
 * `workedToDateHours`/`targetToDateHours` are additive fields `GET /api/v1/dashboard` sends from
 * Phase 451-06 onward (both through yesterday, issue #438 — today never counts). An older cached
 * response that predates them has neither field, and this function degrades to the previous
 * `workedHours - targetHours` delta (the whole-week pair) in that case — never a crash on a
 * missing field, never a silent half-upgrade (one field present, the other not) either: BOTH
 * to-date fields must be present together to switch to the to-date pair.
 */

export interface WeekProgressInput {
  workedHours: number;
  targetHours: number;
  workedToDateHours?: number;
  targetToDateHours?: number;
}

export function weekProgressDelta(week: WeekProgressInput): number {
  const hasToDatePair =
    week.workedToDateHours !== undefined && week.targetToDateHours !== undefined;
  const worked = hasToDatePair ? week.workedToDateHours! : week.workedHours;
  const target = hasToDatePair ? week.targetToDateHours! : week.targetHours;
  return Math.round((worked - target) * 100) / 100;
}
