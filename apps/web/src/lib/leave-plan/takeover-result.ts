// Issue #835 (IN-01) — the takeover dialog runs the takeover a second time to send the limit
// exceptions; that run skips every wish the first run linked, so its answer alone would drop the
// first run's created and pending wishes from the result list. The two answers are merged per wish:
// a later entry replaces the earlier one (a limit-refused wish becomes created), the order is the
// first-seen order, and the plan status is the later run's.
import type { TakeoverResult } from "./types";

type Entry =
  | { bucket: "created"; value: TakeoverResult["created"][number] }
  | { bucket: "pending"; value: TakeoverResult["pending"][number] }
  | { bucket: "refused"; value: TakeoverResult["refused"][number] };

function entriesOf(result: TakeoverResult): Entry[] {
  return [
    ...result.created.map((value) => ({ bucket: "created" as const, value })),
    ...result.pending.map((value) => ({ bucket: "pending" as const, value })),
    ...result.refused.map((value) => ({ bucket: "refused" as const, value })),
  ];
}

export function mergeTakeoverResults(
  earlier: TakeoverResult,
  later: TakeoverResult,
): TakeoverResult {
  const byWish = new Map<string, Entry>();
  for (const entry of [...entriesOf(earlier), ...entriesOf(later)]) {
    // Map keeps the first insertion's position; a later entry only replaces the value.
    byWish.set(entry.value.wishId, entry);
  }
  const merged: TakeoverResult = {
    created: [],
    pending: [],
    refused: [],
    planStatus: later.planStatus,
  };
  for (const entry of byWish.values()) {
    if (entry.bucket === "created") merged.created.push(entry.value);
    else if (entry.bucket === "pending") merged.pending.push(entry.value);
    else merged.refused.push(entry.value);
  }
  return merged;
}
