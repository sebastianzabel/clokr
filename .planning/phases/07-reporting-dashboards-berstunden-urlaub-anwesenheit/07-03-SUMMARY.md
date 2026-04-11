---
phase: 07-reporting-dashboards-berstunden-urlaub-anwesenheit
plan: 03
subsystem: ui
tags: [reporting, leave, urlaubsuebersicht, svelte5, role-guard, year-selector]

dependency_graph:
  requires:
    - phase: 07-01
      provides: "GET /reports/leave-overview endpoint with pendingDays field (RPT-02)"
    - phase: 07-02
      provides: "isManager role guard, section card pattern, and base /reports page state"
  provides:
    - "Urlaubsübersicht section on /reports — RPT-02 frontend"
  affects:
    - "None — this is the final plan in Phase 07"

tech-stack:
  added: []
  patterns:
    - "use:action directive for canvas refs in {#each} blocks — replaces deprecated function-form bind:this"
    - "onchange handler for year selector instead of $effect — avoids double-fetch on mount"
    - "$derived.by() with de-locale triple-sort (lastName, firstName, leaveType.name)"

key-files:
  created: []
  modified:
    - apps/web/src/routes/(app)/reports/+page.svelte

key-decisions:
  - "Year selector uses onchange={loadLeaveOverview} instead of $effect to avoid double-fetch on initial mount"
  - "Deadline column intentionally omitted — carryOverDeadline not selected in backend leave-overview endpoint; out of scope for RPT-02 v1"
  - "registerCanvas use:action replaces Plan 07-02's bind:this function-form which broke in rolldown/Vite 8 — Rule 1 auto-fix"
  - "Client-side sort: lastName asc → firstName asc → leaveType.name asc with de locale"

patterns-established:
  - "Year selector: <label class='year-selector'> with bind:value + onchange handler — reusable pattern for any year-gated data section"
  - "use:registerCanvas(empId) action for Map-based canvas ref tracking inside {#each} — replaces function-form bind:this"

requirements-completed:
  - RPT-02

duration: 12min
completed: "2026-04-11"
---

# Phase 07 Plan 03: Urlaubsübersicht Section Summary

**Manager-facing leave entitlement table added to /reports with year selector, 7 columns (Gesamt/Übertrag/Genommen/Geplant/Rest), and PENDING days pulled from Plan 07-01's extended leave-overview endpoint**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-04-11T21:45:00Z
- **Completed:** 2026-04-11T21:57:00Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Urlaubsübersicht section added to /reports page, hidden from EMPLOYEE role
- Year selector (defaults to current year) triggers reload via `onchange` handler — no double-fetch
- Table columns: Mitarbeiter, Nr., Urlaubsart, Gesamt, Übertrag, Genommen, Geplant, Rest
- `pendingDays` wired to "Geplant" column — shows sum of PENDING leave request days (from Plan 07-01)
- Client-side sort: lastName → firstName → leaveType.name, all de-locale
- Empty / loading / error states rendered inline
- Keyed `{#each}` using `employeeNumber + ":" + leaveType.id` for correct identity tracking
- CSS uses CSS custom properties throughout (no hex literals)
- Pre-existing bind:this build failure from Plan 07-02 auto-fixed (Rule 1)

## Task Commits

1. **Task 1: Urlaubsübersicht section with year selector (RPT-02)** - `867182a` (feat)

## Files Created/Modified

- `apps/web/src/routes/(app)/reports/+page.svelte` — Added LeaveOverviewRow type, leaveOverviewYear/leaveOverview/$derived state, loadLeaveOverview() and formatDays() functions, onMount integration, Urlaubsübersicht markup section with year selector + table, CSS for .year-selector and .leave-overview-table; also fixed pre-existing bind:this build error (use:registerCanvas action). Line delta: +172 lines, 1107 → 1278 total.

## Decisions Made

- **Deadline column omitted**: The plan explicitly excluded `carryOverDeadline` as out of scope for v1 — the backend `leave-overview` endpoint does not currently select that field from `LeaveEntitlement`. If required, Plan 07-01 backend would need to be extended first.
- **onchange over $effect**: Using `onchange={loadLeaveOverview}` on the select element instead of a reactive `$effect` avoids a double-fetch on initial mount (effect would fire immediately after `onMount` load). This pattern matches Svelte 5 best practices for user-triggered side effects.
- **use:registerCanvas action**: Plan 07-02 used `bind:this={(el) => {...}}` function-form which broke with rolldown/Vite 8 (`RolldownError: Can only bind to an Identifier or MemberExpression`). Replaced with a `use:` action that registers the canvas element in the Map on mount and deletes on destroy.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed pre-existing bind:this function-form build error from Plan 07-02**
- **Found during:** Task 1 — build verification
- **Issue:** `bind:this={(el: HTMLCanvasElement | null) => {...}}` in Überstunden sparkline canvas is rejected by rolldown's Svelte compiler (`RolldownError: bind_invalid_expression`). Plan 07-02 passed build in its worktree but the build is now broken in the shared node_modules environment.
- **Fix:** Replaced function-form `bind:this` with `use:registerCanvas={row.id}` action directive. Added `registerCanvas(el, empId)` function that sets/deletes from `sparklineCanvases` Map on mount/destroy.
- **Files modified:** `apps/web/src/routes/(app)/reports/+page.svelte`
- **Verification:** `pnpm build` exits 0 (previously failed with exit 1)
- **Committed in:** `867182a` (included in Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug fix)
**Impact on plan:** Fix was necessary to make `pnpm build` pass. No scope creep. The sparkline lifecycle logic is unchanged — only the canvas ref binding pattern changed.

## Issues Encountered

- `bind:this` with function expression form (`bind:this={(el) => {...}}`) was introduced in Plan 07-02 and cited as "Svelte 5 supported" in the 07-02 summary. The current build environment (rolldown@1.0.0-rc.15, vite@8.0.8) rejects this form with `RolldownError: bind_invalid_expression`. The `{get, set}` pair form (alternative suggested by Svelte docs) also failed. The `use:` action directive approach works correctly and is the idiomatic Svelte solution for tracking DOM elements inside `{#each}` blocks.

## Scope Note: Deadline Column

The Urlaubsübersicht table has 7 columns (not 8). The plan explicitly deferred the "Deadline" column because:
1. The backend `GET /reports/leave-overview` does not currently select `carryOverDeadline` from `LeaveEntitlement`
2. RPT-02 spec lists Resturlaub, genommen, and geplant — not deadline
3. Adding it would require extending Plan 07-01's backend first

If deadline is needed: re-open Plan 07-01 to add `carryOverDeadline` to the endpoint's select, then add the column here.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Phase 07 is now complete: RPT-01, RPT-02, RPT-03, and SALDO-03 all delivered
- `/reports` shows three manager-only sections: Heutige Anwesenheit, Überstunden-Übersicht (with sparklines), and Urlaubsübersicht
- The `use:registerCanvas` pattern established here replaces the function-form `bind:this` for future canvas-in-each usage
- If the `bind:this` fix needs to be applied to the main branch (not just worktree), a post-merge verification step should check the build

---
*Phase: 07-reporting-dashboards-berstunden-urlaub-anwesenheit*
*Completed: 2026-04-11*

## Self-Check: PASSED

Files created/modified:
- FOUND: apps/web/src/routes/(app)/reports/+page.svelte (contains `leaveOverviewYear`, `Urlaubsübersicht`, `pendingDays`, `leave-overview-table`, `formatDays`, `isManager`)
- FOUND: .planning/phases/07-reporting-dashboards-berstunden-urlaub-anwesenheit/07-03-SUMMARY.md

Commits:
- FOUND: 867182a feat(07-03): add Urlaubsübersicht section on /reports (RPT-02)

Build verification: pnpm build exits 0 (in worktree with node_modules symlinked from main repo)
