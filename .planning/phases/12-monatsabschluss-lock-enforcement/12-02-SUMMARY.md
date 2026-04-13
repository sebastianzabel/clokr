---
phase: 12-monatsabschluss-lock-enforcement
plan: 02
subsystem: ui
tags: [svelte5, lock-enforcement, calendar, time-entries, monatsabschluss]

# Dependency graph
requires:
  - phase: 12-monatsabschluss-lock-enforcement
    plan: 01
    provides: "unlock-month API endpoint (POST /overtime/unlock-month)"
provides:
  - "TimeEntry.isLocked field in frontend interface"
  - "monthIsLocked derived (from loaded entries, no extra API call)"
  - "lockedDateSet derived for calendar cell indicators"
  - "unlockMonth() function calling POST /overtime/unlock-month"
  - "Abgeschlossen badge and Entsperren button in month summary bar"
  - "Hidden edit/delete controls for locked entries in list view"
  - "Lock icon in calendar cells for days with locked entries"
affects:
  - 12-monatsabschluss-lock-enforcement

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Lock state derived from already-loaded entry data (no extra API request)"
    - "First-branch {#if slot.isLocked} pattern to short-circuit action rendering for locked rows"
    - "lockedDateSet = new Set(filtered entries) for O(1) calendar cell lookups"

key-files:
  created: []
  modified:
    - apps/web/src/routes/(app)/time-entries/+page.svelte

key-decisions:
  - "monthIsLocked and lockedDateSet both derived from already-loaded entries — avoids a separate API call for lock status"
  - "Lock branch is the FIRST {#if} in action-cell — ensures locked entries never render edit/delete even as fallback"
  - "Entsperren button gated by {#if isManager} in template AND enforced server-side (defense-in-depth per STRIDE T-12-07)"

patterns-established:
  - "Lock badge pattern: msummary-lock item with SVG + label + conditional unlock button after Gesamt-Saldo block"
  - "Calendar lock icon: cal-lock-icon span rendered before day-worked span when lockedDateSet.has(day.dateStr)"

requirements-completed:
  - BUG-02

# Metrics
duration: 15min
completed: 2026-04-13
---

# Phase 12 Plan 02: Zeiterfassung Lock UI Indicators Summary

**Proactive lock feedback in the time-entries page: Abgeschlossen badge, Entsperren button for managers, hidden edit/delete for locked rows, and lock icon in calendar cells — all derived from already-loaded entry data.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-13T15:56:00Z
- **Completed:** 2026-04-13T16:11:25Z
- **Tasks:** 2 (Task 1 in prior commit 2aa721f, Task 2 in this execution)
- **Files modified:** 1

## Accomplishments

- Extended TimeEntry interface with `isLocked?: boolean` and added `unlockMonth()` function (Task 1, commit 2aa721f)
- Derived `monthIsLocked` and `lockedDateSet` from already-loaded entries — zero extra API requests for lock status
- Month summary bar shows "Abgeschlossen" badge with lock SVG when any entry in the month is locked; ADMIN/MANAGER users see "Entsperren" button
- List view action-cell: locked entries render nothing (no edit/delete) via first-branch `{#if slot.isLocked}` guard
- Calendar cells show a 10px lock SVG icon for days that have a locked entry

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend TimeEntry interface and add monthIsLocked derived + unlockMonth function** - `2aa721f` (feat)
2. **Task 2: Add lock badge, Entsperren button, hide locked-entry controls, lock icon in calendar cells** - `93e4f3c` (feat)

## Files Created/Modified

- `apps/web/src/routes/(app)/time-entries/+page.svelte` - Added isLocked to TimeEntry interface, monthIsLocked/lockedDateSet deriveds, unlockMonth function, lock badge in summary bar, action-cell lock guard, calendar lock icons, and CSS for all new elements

## Decisions Made

- Lock state is derived from already-loaded `entries` array — no additional API call needed. This is consistent with D-06 in the plan.
- `lockedDateSet` uses `Set<string>` for O(1) lookups per calendar cell iteration.
- First-branch `{#if slot.isLocked}` in the action-cell ensures hidden controls cannot appear as a fallback even if later branches change.
- Entsperren button is gated by `{#if isManager}` in template (defense-in-depth); actual enforcement is on server side.

## Deviations from Plan

None - plan executed exactly as written. All 4 sub-changes applied as specified in Task 2.

## Issues Encountered

None - svelte-check passed without new errors or warnings after all changes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Lock UI indicators are complete. Users see "Abgeschlossen" when a month is locked and cannot accidentally trigger edit/delete on locked entries.
- Plan 12-03 (grace period) and the API-side lock enforcement (Plan 12-01) can now be tested end-to-end with visible UI feedback.

---
*Phase: 12-monatsabschluss-lock-enforcement*
*Completed: 2026-04-13*
