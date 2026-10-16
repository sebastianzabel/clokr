/**
 * activity-minutes.ts — Issue #81 (D-04).
 *
 * The ONE per-kind derivation of an entry's working time. The working minutes come only from
 * `entryDurations()` (Phase 79) — there is no second working-time formula here.
 *
 * The values are exact and unrounded (a caller rounds once, where it presents a figure). Nothing is
 * stored: the remainder is derived on every read, so a later time or break edit moves it and the
 * kinds always add up to the entry's working minutes.
 *
 * An open entry contributes 0 for every kind, also when it holds dormant shares left by a clock
 * re-open. The remainder (working minutes minus the share sum) belongs to the entry's own kind and
 * is never clamped: a value below zero can only come from inconsistent stored break data and is
 * reported as-is, never repaired silently (D-05).
 *
 * A travel entry's working time (Issue #92, D-05) lands in TRAVEL through its own kind
 * (`result[entry.activityKind]`), never through a share: TRAVEL is not a share kind.
 *
 * The working-time account never calls this (D-12): the activity kind is an evaluation dimension.
 */
import { entryDurations, type EntryDurationInput } from "./entry-durations";
import type { ActivityKind } from "@clokr/db";

/** One stored share: a whole-minute allocation to a kind different from the entry's own kind. */
export type ActivityShareInput = { kind: ActivityKind; minutes: number };

/** Minutes per activity kind. */
export type ActivityMinutes = Record<ActivityKind, number>;

export function activityMinutes(
  entry: EntryDurationInput & { activityKind: ActivityKind },
  shares: readonly ActivityShareInput[],
): ActivityMinutes {
  const result: ActivityMinutes = { UNSPECIFIED: 0, PRODUCTIVE: 0, SETUP_CLEANING: 0, TRAVEL: 0 };
  if (!entry.endTime) return result;
  let allocated = 0;
  for (const share of shares) {
    result[share.kind] += share.minutes;
    allocated += share.minutes;
  }
  result[entry.activityKind] += entryDurations(entry).workingMinutes - allocated;
  return result;
}
