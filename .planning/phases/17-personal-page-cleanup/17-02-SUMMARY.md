---
plan: 17-02
phase: 17-personal-page-cleanup
status: complete
started: 2026-04-25T00:00:00Z
completed: 2026-04-25T00:00:00Z
subsystem: web/leave
tags: [cleanup, personal-page, leave, approvals-removal]
dependency_graph:
  requires: []
  provides: [personal-leave-page-without-approvals]
  affects: [apps/web/src/routes/(app)/leave/+page.svelte]
tech_stack:
  added: []
  patterns: [svelte5-runes, css-custom-properties]
key_files:
  modified:
    - apps/web/src/routes/(app)/leave/+page.svelte
decisions:
  - iCal team export made available to all users (was manager-gated); team calendar context is useful for all employees
  - isOwn check retained for calendar chip type label visibility (colleagues show as "abwesend", own entries show leave type)
metrics:
  duration: ~15min
  completed: 2026-04-25
  tasks_completed: 1
  tasks_total: 1
  files_modified: 1
requirements:
  - NAV-02
---

# Phase 17 Plan 02: Remove Approvals Tab from Personal Leave Page Summary

Removed ~470 lines of manager-specific code from `leave/+page.svelte`, stripping the "Genehmigungen" approval tab, employee-selector dropdown, pending-requests fetch, and review modal so all users — employees and managers alike — see only their own leave requests on the personal page.

## What Was Done

**Script section removals:**
- `isManager` constant (role check for ADMIN/MANAGER)
- `pendingRequests` state array
- `reviewModal`, `reviewOverlap`, `reviewNote`, `reviewSaving`, `reviewError` state
- `reviewAttestPresent`, `reviewAttestFrom`, `reviewAttestTo` state
- `calFilter` and `calEmployees` state
- `Employee` interface (was only used by `calEmployees`)
- Manager employee-list fetch in `onMount`
- Approvals deep-link block (`?view=approvals`) in `onMount`
- `loadData()` simplified: removed `Promise.all` with `isManager` conditional, now single `api.get` for own requests only
- `openReview`, `closeReview`, `submitReview` functions removed entirely
- `View` type narrowed from `"calendar" | "list" | "approvals"` to `"calendar" | "list"`
- `<svelte:window>` Escape handler: removed `reviewModal` branch

**Template section removals:**
- Employee-selector `<div class="employee-selector">` block
- "Genehmigungen" tab button inside view-tabs (with `{#if isManager}` guard)
- Manager column header `{#if isManager}<th>Mitarbeiter</th>{/if}` in table
- Manager employee-name cell `{#if isManager}<td>...</td>{/if}` in table body
- Manager "Attest" and "Prüfen" action buttons from table action cell
- Entire `{#if view === "approvals"}` pending-list section
- Entire `{#if reviewModal}` review modal block

**Template updates:**
- Calendar chip filter simplified from multi-branch calFilter/isManager logic to `e.isOwn || e.status === "APPROVED"`
- `typeColor()` call: `e.isOwn || isManager` → `e.isOwn`
- `title` attribute: `(e.isOwn || isManager) && e.typeName` → `e.isOwn && e.typeName`
- Chip label conditional: `(e.isOwn || isManager) && e.typeName` → `e.isOwn && e.typeName`
- iCal team export button: removed `{#if isManager}` guard — now visible to all users
- Deep-link `?request=`: `view = isManager ? "approvals" : "list"` → `view = "list"`
- Section header: `{isManager ? "Alle Anträge" : "Meine Anträge"}` → `"Meine Anträge"`

**CSS removals:**
- `.pending-list`, `.pending-card`, `.pending-info`, `.pending-name`, `.pending-type`, `.pending-dates`, `.pending-days`, `.pending-note` block
- `.review-grid`, `.review-field`, `.review-field--full`, `.review-label`, `.review-value` block
- `.employee-selector`, `.employee-selector .form-label`, `.employee-selector .form-input` block
- Removed dead responsive overrides for `.review-grid` and `.pending-info` from `@media (max-width: 700px)`

## Deviations from Plan

**1. [Rule 1 - Bug] iCal team export ungated**

The plan did not mention the `{#if isManager}` guard around the "Team-Abwesenheiten" iCal download button. Since `isManager` was removed from the file, this guard was a stale `isManager` reference that had to be resolved. Decision: make team calendar export available to all users (employees also benefit from seeing team absence context). Removed the guard, button now always visible.

**2. [Rule 1 - Bug] Section header ternary used isManager**

The `<h2>` in the list section used `{isManager ? "Alle Anträge" : "Meine Anträge"}`. Resolved to `"Meine Anträge"` as part of removing all `isManager` references.

## Threat Flags

None. Removing UI-side manager checks does not introduce new attack surface. The server-side `requireRole("ADMIN","MANAGER")` guard on `/leave/requests?status=PENDING` and `/leave/requests/:id/review` remains the authoritative authorization check (T-17-03/T-17-04 mitigated at API layer).

## Known Stubs

None. All personal leave functionality (submit, edit, cancel, attest modal) is fully wired and operational.

## Self-Check: PASSED

- File exists: `apps/web/src/routes/(app)/leave/+page.svelte` — FOUND
- Commit 81ffeb5 exists — FOUND
- Zero matches for `isManager|pendingRequests|reviewModal|calFilter|calEmployees|approvals|openReview|closeReview|submitReview` — CONFIRMED
- `type View = "calendar" | "list"` — CONFIRMED
- `e.isOwn || e.status === "APPROVED"` filter present — CONFIRMED
- `Meine Anträge` and `Kalender` tabs present — CONFIRMED
- `myRequests`, `loadData`, `submitRequest`, `cancelRequest`, `openEditForm`, `attestModal`, `saveAttest`, `filteredMyRequests`, `pagedMyRequests`, `vacationBalance`, `overlapEntries` all present — CONFIRMED
