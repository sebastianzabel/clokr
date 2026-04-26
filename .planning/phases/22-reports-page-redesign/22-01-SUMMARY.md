---
plan: 22-01
phase: 22-reports-page-redesign
status: complete
started: 2026-04-25T21:00:00Z
completed: 2026-04-25T21:16:38Z
subsystem: web/reports
tags: [ui, reports, glass-cards, period-selector, export-buttons]
requirements: [RPT-01, RPT-02]
dependency_graph:
  requires: [21-per-employee-export-api]
  provides: [reports-page-redesign]
  affects: [apps/web/src/routes/(app)/reports/+page.svelte, apps/api/src/routes/reports.ts]
tech_stack:
  added: []
  patterns: [glass-card, widget-header/widget-title, card-animate, $effect-reactive-reload, per-employee-blob-download]
key_files:
  modified:
    - apps/web/src/routes/(app)/reports/+page.svelte
    - apps/api/src/routes/reports.ts
decisions:
  - "Used shared selectedMonth/selectedYear state driving all three manager loaders via $effect — eliminates leaveOverviewYear and makes the period selector the single source of truth"
  - "Added employee.id to leave-overview Prisma select in reports.ts rather than keying on employeeNumber — enables correct routing to /reports/monthly/pdf endpoint which requires UUID"
  - "Pre-existing svelte-check error (employees on never, line 123) is in the original codebase and was not introduced by this plan — documented as out-of-scope"
metrics:
  duration_minutes: 16
  tasks_completed: 2
  tasks_total: 2
  files_modified: 2
---

# Phase 22 Plan 01: Reports Page Redesign Summary

Glass-card widget layout with shared period selector and per-employee PDF + DATEV export buttons wired to Phase 21 endpoints.

## What Was Built

**Task 1 — Glass-card layout + shared period selector:**
- Added `selectedMonth` / `selectedYear` shared state replacing `leaveOverviewYear`
- Inserted `.period-bar.card.card-body.card-animate` above the reports grid with month + year selects
- Converted all three manager widget sections (`section.section.card-animate`) to `section.widget-card.card.card-body.card-animate` with `.widget-header` / `.widget-title` / `.widget-actions` structure
- Added `card-animate` class to all three export download cards
- Replaced one-shot `onMount` loader calls with a `$effect` that reacts to `selectedMonth`/`selectedYear` changes and calls all three loaders
- Updated `loadLeaveOverview` to use `selectedYear` instead of `leaveOverviewYear`
- Removed old `.year-selector` styles and replaced with `.period-select` / `.period-label` styles
- DATEV export card now shows a "Zeitraum" hint reflecting the shared period (no separate month/year selects in the card)

**Task 2 — Per-employee export buttons:**
- Added `id: true` to the `employee` select in `/reports/leave-overview` Prisma query (reports.ts)
- Updated `LeaveOverviewRow` type to include `employee.id: string`
- Added `empDownloadErrors` state (`Record<string, string>`) for per-row error display
- Added `downloadEmployeePdf(employeeId, name)` — uses existing `downloadPdf()` helper
- Added `downloadEmployeeDatev(employeeId, name)` — authenticated fetch + blob download
- Added `Aktionen` column with PDF + TXT buttons to Überstunden-Übersicht table
- Added `Aktionen` column with PDF button to Urlaubsübersicht table
- Columns hidden on mobile via `@media (max-width: 720px)`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] DATEV export card had its own month/year selects that would conflict with the shared period selector**
- **Found during:** Task 1
- **Issue:** The original DATEV card had `bind:value={datevMonth}` / `bind:value={datevYear}` selects. After introducing the shared selector, keeping these would create two separate period controls for DATEV, contradicting the "single shared selector" design.
- **Fix:** Replaced the DATEV card's month/year selects with a read-only `.report-period-hint` paragraph showing the shared period. `downloadDatev()` now uses `selectedMonth`/`selectedYear` directly.
- **Files modified:** `apps/web/src/routes/(app)/reports/+page.svelte`
- **Commit:** 616eb44

### Pre-existing Issues (Out of Scope)

- `svelte-check` error: `Property 'employees' does not exist on type 'never'` at `+page.svelte` line 123 — present in the original file before this plan, not introduced by changes. Logged for deferred fix.

## Known Stubs

None — all export buttons wire to live Phase 21 API endpoints. Period selector drives reactive data loads.

## Self-Check: PASSED

- FOUND: `apps/web/src/routes/(app)/reports/+page.svelte`
- FOUND: `apps/api/src/routes/reports.ts`
- FOUND: commit `616eb44`
- FOUND: `period-bar` div in template
- FOUND: `selectedMonth` / `selectedYear` bound to selects
- FOUND: all three widget sections use `widget-card card card-body card-animate`
- FOUND: `widget-header` / `widget-title` inside each section
- FOUND: `card-animate` on export download cards
- FOUND: `downloadEmployeePdf` and `downloadEmployeeDatev` functions
- FOUND: `empDownloadErrors` state var
- FOUND: `Aktionen` column with PDF+TXT in Überstunden table
- FOUND: `Aktionen` column with PDF in Urlaubsübersicht table
- FOUND: `use:registerCanvas` action preserved
- API tsc: 0 errors (verified via temp swap)
- svelte-check: pre-existing error not introduced by this plan
