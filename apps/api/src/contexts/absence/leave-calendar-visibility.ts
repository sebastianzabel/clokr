/**
 * The ONE visibility decision behind an absence TYPE, shared by GET /overlap, GET /calendar
 * (Phase 262, GitHub issue #262, D-06) and the leave planner read (Issue #835, D-835-22): may this
 * viewer learn the type of this entry, or must it be masked to `null`?
 *
 * `canSeeAll` is `hasPermission(req, "leave-request:read:ZUGEWIESEN")`, computed once per request
 * by the caller (Phase 75b, Issue #75, D-13) rather than re-derived per row — mirrors the
 * reasoning in `apps/web/src/lib/leave/team-calendar-visibility.ts`'s `canSeeLeaveType` (Phase
 * 257, D-06 in 262-CONTEXT.md): the masking decision must not silently widen for an unexpected
 * value on the PERMISSIVE side — the side that leaks.
 *
 * Exported since Issue #835 — the leave planner read is the second caller. It is deliberately NOT
 * exported via `contexts/absence/index.ts`: both callers sit inside Abwesenheiten. A sick type is
 * masked more strictly by the planner on top of this rule (see `leave-plan/planner-read.ts`); this
 * function stays the calendar's rule, unchanged.
 *
 * Zero runtime imports, so it can never join the measured import cycle.
 */
export function canSeeLeaveType(isOwn: boolean, canSeeAll: boolean): boolean {
  return isOwn === true || canSeeAll;
}
