// Phase 76.2 (ARCH-V19-01) — Pure state machine for clock event resolution.
// No DB, no I/O — fully unit-testable. Resolver wires this to transactions.
import type { ClockState, ClockIntent, ClockDecision } from "./types";

export function decide(state: ClockState, intent: ClockIntent, source: string): ClockDecision {
  // AUTO — toggle semantics (NFC tap, WIFI connected event)
  if (intent === "AUTO") {
    if (state.kind === "NO_OPEN_ENTRY") return { kind: "START" };
    // D-01: closed same-day entry → reopen instead of creating a 2nd row
    if (state.kind === "CLOSED_SAME_DAY_ENTRY") return { kind: "REOPEN", entryId: state.entryId };
    // Same source → close the open entry. Cross source → confirm presence (e.g. WIFI
    // re-detecting employee already clocked in via NFC; CONTEXT.md D-02 semantics).
    return state.source === source
      ? { kind: "STOP", entryId: state.entryId }
      : { kind: "CONFIRM", entryId: state.entryId };
  }
  // IN — explicit clock-in (web/mobile /clock-in route)
  if (intent === "IN") {
    if (state.kind === "NO_OPEN_ENTRY") return { kind: "START" };
    // D-01: closed same-day entry → reopen instead of creating a 2nd row
    if (state.kind === "CLOSED_SAME_DAY_ENTRY") return { kind: "REOPEN", entryId: state.entryId };
    return { kind: "CONFLICT", reason: "ALREADY_CLOCKED_IN" };
  }
  // OUT — only an OPEN_ENTRY can be stopped; closed same-day or none → NOT_CLOCKED_IN (Pitfall 4)
  return state.kind === "OPEN_ENTRY"
    ? { kind: "STOP", entryId: state.entryId }
    : { kind: "CONFLICT", reason: "NOT_CLOCKED_IN" };
}
