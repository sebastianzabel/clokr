/**
 * Track-only rule — Issue #494 (owner decision 06.10.2026; Unterbau-Semantikänderung of
 * `WorkSchedule.overtimeMode` / `monthlyHours`, ADR 0001-abweichungen Nachtrag Phase 494).
 *
 * THE one place the track-only rule lives (R4). A track-only contract records worked time but
 * never produces a saldo: the Monatsabschluss stores `carryOver` 0 and the live saldo shows 0.
 *
 * This is a saldo rule of Arbeitszeitkonto. It is deliberately NOT exported through
 * `contexts/platform` or the working-time-account `index.ts` (D-01).
 *
 * Stored `overtimeMode` values are never rewritten (D-02): the rule is authoritative on read.
 * Close / cron / recalc pass the contract valid in the month being closed, the live display
 * passes today's contract (D-04).
 *
 * Pure, dependency-free module: no imports, no I/O.
 */

/**
 * `monthlyHours` is a REQUIRED key (D-09): a caller that forgets it does not compile, because an
 * omitted key would read as 0 and silently widen the rule to every MONTHLY_HOURS contract.
 */
type TrackOnlyScheduleInput = {
  type?: unknown;
  overtimeMode?: unknown;
  monthlyHours: unknown;
};

/**
 * True for a MONTHLY_HOURS contract that is explicitly `TRACK_ONLY` OR has no monthly hours
 * (null, 0, negative, NaN or non-numeric). Every other schedule type is never track-only.
 *
 * "No monthly hours" uses the repo-wide "no target" expression `!(Number(x ?? 0) > 0)`, so a
 * Prisma Decimal ("0.00"), a numeric string, NaN and negative values all count as "no target"
 * without a separate branch.
 */
export function isTrackOnlySchedule(schedule: TrackOnlyScheduleInput | null | undefined): boolean {
  if (schedule?.type !== "MONTHLY_HOURS") return false;
  if (schedule.overtimeMode === "TRACK_ONLY") return true;
  return !(Number(schedule.monthlyHours ?? 0) > 0);
}

/**
 * D-11: a chain link on a track-only month is the by-design zeroing only when the stored
 * carry-over is 0 — a track-only close ALWAYS stores 0. A non-zero stored carry on a track-only
 * month is not the zeroing and must stay visible to the audit / migrate scripts.
 */
export function isTrackOnlyZeroingLink(
  link: { storedCarryOver: number },
  schedule: Parameters<typeof isTrackOnlySchedule>[0],
): boolean {
  return isTrackOnlySchedule(schedule) && link.storedCarryOver === 0;
}
