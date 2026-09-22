// Phase 307 Plan 02, Task 1 (D-03/D-05 corrected) — builds the German message a DEBOUNCE_NOOP
// clock-out now carries in its 409 body.
//
// Why this is a standalone module and not an inline helper in the route file: route files in
// this codebase export exactly one `xxxRoutes` function per house convention (see CLAUDE.md §
// Function/Route Design); any helper defined inside one is module-private and therefore not
// independently testable. Since Phase 307 Plan 01 set `interactive: true` unconditionally on
// `/:id/clock-out`'s ClockEvent, the resolver's debounce guard is short-circuited on this route —
// the DEBOUNCE_NOOP branch that uses this message is defensive/unreachable from an HTTP call
// (D-08), so this module's own unit test is the ONLY honest verification surface for D-05.
//
// Uses DOUBLE_TAP_DEBOUNCE_MS (the same constant the resolver's debounce guard evaluates against)
// and timeStrInTz (already an established import in this context) so the message and the guard
// can never silently drift apart.
import { DOUBLE_TAP_DEBOUNCE_MS } from "../../services/clock/thresholds";
import { timeStrInTz } from "../working-time-account";

/**
 * Build the German message for a clock-out that the debounce guard rejected as a double-tap
 * no-op. Names BOTH the reason (double-tap protection) and the exact time from which clocking
 * out becomes possible, computed from the entry's own start time plus the debounce window,
 * formatted in the tenant's configured timezone.
 */
export function buildClockOutDebounceMessage(startTime: Date, tz: string): string {
  const startedAt = timeStrInTz(startTime, tz);
  const openAt = timeStrInTz(new Date(startTime.getTime() + DOUBLE_TAP_DEBOUNCE_MS), tz);
  return `Ausstempeln ist erst ab ${openAt} Uhr möglich — der Eintrag wurde gerade erst um ${startedAt} Uhr begonnen (Schutz vor Doppeltipp).`;
}
