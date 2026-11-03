// Phase 76.2 (ARCH-V19-01) — Pure state machine for clock event resolution.
// No DB, no I/O — fully unit-testable. Resolver wires this to transactions.
import type { ClockState, ClockIntent, ClockDecision } from "./types";

export function decide(
  state: ClockState,
  intent: ClockIntent,
  source: string,
  presenceOnly = false,
): ClockDecision {
  // AUTO — toggle semantics (NFC tap, WIFI connected event)
  if (intent === "AUTO") {
    if (state.kind === "NO_OPEN_ENTRY") return { kind: "START" };
    // D-01: closed same-day entry → reopen instead of creating a 2nd row
    if (state.kind === "CLOSED_SAME_DAY_ENTRY") return { kind: "REOPEN", entryId: state.entryId };
    // Issue #818: a card tap is a human act and closes the open entry whatever trigger opened it
    // (phone, web, terminal). Only a PASSIVE presence signal, flagged by its adapter through
    // `presenceOnly`, confirms an entry another source already opened (CONTEXT.md D-02, WIFI
    // re-detecting a running presence); the same source still toggles. The rule reads the flag,
    // never a source name, so a new trigger stays one adapter file.
    return presenceOnly && state.source !== source
      ? { kind: "CONFIRM", entryId: state.entryId }
      : { kind: "STOP", entryId: state.entryId };
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
