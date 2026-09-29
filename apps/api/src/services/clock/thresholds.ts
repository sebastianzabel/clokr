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

// Phase 376 (Issue #376, D-02) — the fallback bound for the resolver's cross-day open-entry
// lookback (a shift crossing local midnight, e.g. 23:30 clock-in / 00:30 clock-out tap).
//
// The lookback's PRIMARY bound is the tenant's own `TenantConfig.autoDeleteOpenHours` — the same
// field `attendance-checker.ts`'s `autoInvalidateOpenEntries()` already uses to decide "this open
// entry is presumptively stale" (reusing it rather than inventing a second, competing notion of
// staleness). This constant is ONLY consulted when that field cannot serve as the bound — it is
// `0` (the tenant explicitly disabled stale-open-entry auto-invalidation) or the tenant's
// TenantConfig row is missing entirely. In BOTH cases `0`/missing must read as "use this fixed
// 24h cap", never as "search back forever": an unrelated clock event days after a genuinely
// forgotten clock-out must never silently close it with a fabricated, wrong `endTime` — exactly
// what issue #376's "Vorgehen" section warns against.
export const CROSS_DAY_OPEN_ENTRY_FALLBACK_HOURS = 24;
