---
plan: 17-01
phase: 17-personal-page-cleanup
status: complete
started: 2026-04-25T00:00:00Z
completed: 2026-04-25T00:00:00Z
subsystem: web/time-entries
tags: [frontend, svelte, cleanup, phase-17]
requirements: [NAV-01]

dependency_graph:
  requires: []
  provides: [personal-time-entries-own-data-only]
  affects: [apps/web/src/routes/(app)/time-entries/+page.svelte]

tech_stack:
  added: []
  patterns: [own-data-only personal page, direct ownEmployeeId usage]

key_files:
  modified:
    - apps/web/src/routes/(app)/time-entries/+page.svelte

decisions:
  - "Remove unlock button from personal page entirely — it was manager-only, moves to team pages in later phases"
  - "Remove btn-warning CSS block along with revalidate action — no longer needed on personal page"

metrics:
  duration: ~10 minutes
  completed: 2026-04-25
  tasks_completed: 1
  files_modified: 1
---

# Phase 17 Plan 01: Remove Manager Employee-Selector from Personal Zeiterfassung Page Summary

Personal Zeiterfassung page stripped of all manager-specific state, logic, and UI — now shows only the authenticated employee's own time entries with `ownEmployeeId` used directly throughout.

## What Was Done

Removed approximately 150 lines of manager-facing code from `apps/web/src/routes/(app)/time-entries/+page.svelte`:

**Script section:**
- `Employee` interface removed
- `employees: Employee[] = $state([])` state removed
- `selectedEmployeeId`, `isViewingOther`, `selectedEmployeeName` derived values removed
- `onMount` employee-fetch block for managers (API call to `/employees`) removed
- `empQuery` URL parameter logic removed from `loadAll()` — API now always fetches own entries without `&employeeId=` param
- `activeEmpId` now set directly to `ownEmployeeId` (no `selectedEmployeeId ?? ownEmployeeId` indirection)
- `onEmployeeChange` handler removed
- `isManager` derived removed
- `unlockMonth` function removed entirely (unlock moves to team pages in later phases)
- `isViewingOther` spread in `saveEntry()` POST body removed

**Template section:**
- Employee-selector HTML block (`{#if isManager && employees.length > 0}`) removed
- `{#if isManager}` unlock button block in month-summary removed
- Modal title simplified to `{editEntry ? "Eintrag bearbeiten" : "Neuen Eintrag hinzufügen"}`
- Manager-only `{:else if slot.isInvalid && isManager}` Freigeben branch in list view removed

**CSS section:**
- `.employee-selector` block removed
- `.viewing-other-hint` removed
- `.btn-warning` / `.btn-warning:hover` blocks removed (only used by Freigeben button)

## Deviations from Plan

None — plan executed exactly as written. The decision about removing the unlock button entirely (rather than keeping it unconditional) was already specified and resolved inline in the plan's action section.

## Known Stubs

None. The page fully functions for own-data display. The `revalidateEntry` function remains in script (dead code path now that the Freigeben button is removed from this page), but it causes no rendering or data issues and will be cleaned up when team pages are added.

## Threat Flags

None. Removing the employee list fetch from the personal page eliminates T-17-02 (full employee list loaded into browser memory) as intended.

## Self-Check

- [x] `apps/web/src/routes/(app)/time-entries/+page.svelte` exists and was modified
- [x] Commit `05a38ae` exists: `feat(17-01): remove manager employee-selector from personal Zeiterfassung page`
- [x] `grep "selectedEmployeeId|isViewingOther|isManager|employee-selector|empQuery|onEmployeeChange"` → 0 matches
- [x] `grep "ownEmployeeId"` → 2 matches (declaration + use in loadAll)
- [x] `grep "unlockMonth"` → 0 matches
- [x] Modal titles appear exactly once on line 1276

## Self-Check: PASSED
