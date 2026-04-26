---
plan: 20-01
phase: 20-team-leave-page
status: complete
started: 2026-04-25T20:46:39Z
completed: 2026-04-25T20:50:26Z
subsystem: web/team-leave
tags: [svelte, leave, approval, manager, ui]
requirements: [TEAM-03]

dependency_graph:
  requires: []
  provides: [team-leave-page]
  affects: [leave/+page.svelte (source reference only)]

tech_stack:
  added: []
  patterns:
    - Svelte 5 runes ($state, $derived, $effect)
    - Three-tab layout with tab badge
    - Review modal with self-approval block
    - CANCELLATION_REQUESTED flow in same modal

key_files:
  created:
    - apps/web/src/routes/(app)/team/leave/+page.svelte
  modified: []

decisions:
  - Kept typeColor(e.isOwn) so manager's own calendar entries show type-specific colors
  - Removed month-overlap filter from Anträge tab (team page shows all requests, not clamped to month)
  - Single iCal button (Team-Abwesenheiten only) — personal download not needed on team page
  - fmtH helper removed (not used on team page — no overtime balance display)

metrics:
  duration_minutes: 4
  tasks_completed: 2
  files_created: 1
  files_modified: 0
---

# Phase 20 Plan 01: Team Leave Page Summary

Full team leave management page with three-tab layout, read-only team calendar, all-requests table with Prüfen action, pending approval queue with live count badge, and review modal with self-approval block, sick-leave attest controls, and CANCELLATION_REQUESTED handling.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Page skeleton, header, tabs, read-only calendar | 827725f | apps/web/src/routes/(app)/team/leave/+page.svelte |
| 2 | Anträge table, Genehmigungen tab, review modal, self-approval block | 827725f | apps/web/src/routes/(app)/team/leave/+page.svelte |

## Key Features Delivered

- **Kalender tab**: Read-only team absences calendar (no drag-select, no form). Month/year picker navigation. iCal export button for team calendar.
- **Anträge tab**: Full data table of all team requests. Columns: Mitarbeiter, Art, Von, Bis, Umfang, Status, Anmerkung. Filter by status and leave type. Pagination. Prüfen button on PENDING/CANCELLATION_REQUESTED rows.
- **Genehmigungen tab**: Pending-only card list with live count badge on tab. Stornierung prüfen variant for CANCELLATION_REQUESTED.
- **Review modal**: Employee details, overlap colleagues section, optional attest section for SICK/SICK_CHILD, optional reviewNote input, approve/reject buttons with CANCELLATION_REQUESTED variants.
- **Self-approval block**: Genehmigen/Ablehnen buttons hidden when `reviewModal.employeeId === $authStore.user?.employeeId`. Informational message shown instead.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all data is live from API endpoints.

## Threat Flags

None — no new network endpoints, auth paths, or trust boundary changes introduced. All API calls use pre-existing endpoints scoped by tenant via requireAuth middleware.

## Self-Check: PASSED

- File exists: `apps/web/src/routes/(app)/team/leave/+page.svelte` — 1484 lines (> 600 minimum)
- Commit exists: 827725f
- ESLint: passes with 0 errors, 0 warnings
- No form-dialog, showForm, or vacationBalance references in file
- All three tabs present: Kalender, Anträge, Genehmigungen
- Self-approval guard `employeeId !== $authStore.user?.employeeId` present
- `SICK_CODES.includes(reviewModal.typeCode)` gates attest section
- Tab badge conditional on `pendingRequests.length > 0`
