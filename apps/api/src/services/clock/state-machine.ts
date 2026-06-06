// Phase 76.2 (ARCH-V19-01) — Pure state machine for clock event resolution.
// No DB, no I/O — fully unit-testable. Resolver wires this to transactions.
import type { ClockState, ClockIntent, ClockDecision } from "./types";

export function decide(state: ClockState, intent: ClockIntent, source: string): ClockDecision {
  // AUTO — toggle semantics (NFC tap, WIFI connected event)
  if (intent === "AUTO") {
    if (state.kind === "NO_OPEN_ENTRY") return { kind: "START" };
    // Same source → close the open entry. Cross source → confirm presence (e.g. WIFI
    // re-detecting employee already clocked in via NFC; CONTEXT.md D-02 semantics).
    return state.source === source
      ? { kind: "STOP", entryId: state.entryId }
      : { kind: "CONFIRM", entryId: state.entryId };
  }
  // IN — explicit clock-in (web/mobile /clock-in route)
  if (intent === "IN") {
    return state.kind === "NO_OPEN_ENTRY"
      ? { kind: "START" }
      : { kind: "CONFLICT", reason: "ALREADY_CLOCKED_IN" };
  }
  // OUT — explicit clock-out (/clock-out route, WIFI disconnected)
  return state.kind === "OPEN_ENTRY"
    ? { kind: "STOP", entryId: state.entryId }
    : { kind: "CONFLICT", reason: "NOT_CLOCKED_IN" };
}
