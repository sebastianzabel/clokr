// Phase 307 Plan 01, Task 3 (D-06 confirmed) — two named constants, not one, for a 60-second
// floor that shows up in two different places in services/clock/ for two different reasons.
//
// Measured (RESEARCH.md Q2, CONTEXT.md's post-research addendum):
//
// - `resolver.ts`'s STOP branch measures `gapMs`: the elapsed time between the entry CURRENTLY
//   being closed's own `startTime` and the incoming STOP event's timestamp. It answers "is this
//   STOP happening too soon after THIS SAME entry's own start?" and is evaluated BEFORE any
//   write — it is PREVENTION: it stops a near-zero-duration row from ever being created on the
//   entry being acted on right now.
// - `consolidate.ts`'s cross-source merge measures `prevDurationMs`: the total start-to-end span
//   of `previousEntry` — a DIFFERENT, ALREADY-CLOSED row being evaluated as a candidate merge
//   predecessor for the entry the STOP branch just closed. It answers "is this OTHER,
//   already-existing closed row itself so short that it's presumptively an artifact left over
//   from a resolved double-tap, and therefore unsafe to extend/merge into?" and is evaluated in
//   a LATER pass, over a row that already exists — it is POST-HOC ARTIFACT DETECTION.
//
// Same real-world floor ("a work session shorter than ~1 minute is not a real, intentional clock
// session"), different operand, different evaluation point, different purpose. A single shared
// name would flatten "prevention, checked before the write, on the entry being closed" and
// "detection, checked in a later pass, on a different already-closed row" into one concept —
// exactly the regression D-06 itself warned against before this measurement confirmed it.
//
// Whoever comes here wanting to collapse these two into one constant: that is the
// Verschlechterung this docblock exists to name. Changing one of these two numbers is a decision
// about ONE of the two concepts above — it must never silently change the other.
export const DOUBLE_TAP_DEBOUNCE_MS = 60_000;
export const MIN_MERGE_PREDECESSOR_DURATION_MS = 60_000;
