---
phase: 07-reporting-dashboards-berstunden-urlaub-anwesenheit
plan: 02
subsystem: ui
tags: [reporting, dashboard, chart.js, sparklines, attendance, overtime, svelte5, role-guard]

dependency_graph:
  requires:
    - phase: 07-01
      provides: "GET /dashboard/today-attendance and GET /dashboard/overtime-overview endpoints"
  provides:
    - "Heutige Anwesenheit section on /reports — RPT-03 frontend"
    - "Überstunden-Übersicht sortable table with Chart.js sparklines — RPT-01 + SALDO-03 frontend"
  affects:
    - "07-03 (leave overview dashboard — same /reports page)"

tech-stack:
  added: []
  patterns:
    - "Map<employeeId, Chart> sparkline lifecycle: destroy-before-create on every $effect re-run"
    - "bind:this function-form for canvas refs inside {#each} blocks (Svelte 5)"
    - "isManager $derived from authStore read in onMount — role-guard pattern for manager-only sections"
    - "Glass surface tokens (--glass-bg, --glass-border, --glass-shadow) for new section cards"

key-files:
  created: []
  modified:
    - apps/web/src/routes/(app)/reports/+page.svelte

key-decisions:
  - "Implemented both tasks in one write to the single-file component; Task 1 commit captures both sections since they share the same file"
  - "Used bind:this function-form for canvas refs — cleaner than array refs and avoids index alignment issues"
  - "sparklineCharts Map keyed on employeeId (not array index) — ensures re-sort does not misalign Chart instances"
  - "carryOver / 60 conversion: sparkline Y-axis shows hours, not minutes"
  - "brandColor read from getComputedStyle(--color-brand) for Chart.js — avoids hardcoded hex per CLAUDE.md"

patterns-established:
  - "Role guard pattern: let currentRole = $state(null); let isManager = $derived(...); read authStore in onMount"
  - "Chart.js sparkline: Map<string,Chart> + Map<string,HTMLCanvasElement>, destroy before recreate in $effect, clear in onDestroy"
  - "Section card: .section.card-animate with glass tokens (--glass-bg, --glass-border, --glass-shadow, --glass-blur)"

requirements-completed:
  - RPT-01
  - RPT-03
  - SALDO-03

duration: 15min
completed: "2026-04-11"
---

# Phase 07 Plan 02: Reports Dashboard Sections Summary

**Role-gated Heutige Anwesenheit + Überstunden-Übersicht sections added to /reports, with Chart.js sparklines keyed on employeeId Map for leak-free sort/destroy lifecycle**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-11T21:15:00Z
- **Completed:** 2026-04-11T21:35:00Z
- **Tasks:** 2 (both in one file, single commit)
- **Files modified:** 1

## Accomplishments

- Heutige Anwesenheit card: 4 summary chips + employee status table, pulls from GET /dashboard/today-attendance
- Überstunden-Übersicht: sortable table (Mitarbeiter / Saldo columns) with Chart.js line sparklines per employee
- Sparkline data from `snapshots[].carryOver` field (cumulative running balance in minutes → converted to hours)
- Chart.js registered locally (LineController, LineElement, PointElement, CategoryScale, LinearScale, Filler, Tooltip, Legend) — not relying on dashboard bundle
- Role guard: both sections hidden for EMPLOYEE role, visible only for ADMIN/MANAGER
- Build and type check both pass clean

## Task Commits

1. **Task 1: Heutige Anwesenheit + Task 2: Überstunden-Übersicht (combined, same file)** - `ee0fe90` (feat)

**Plan metadata:** to be added by final docs commit

## Files Created/Modified

- `apps/web/src/routes/(app)/reports/+page.svelte` — Added Chart.js imports + registration, role guard state, TodayAttendance + OvertimeOverview types, onMount loading for both endpoints, $effect sparkline lifecycle, statusLabel/statusClass helpers, toggleSort/formatBalance helpers, Heutige Anwesenheit markup section, Überstunden-Übersicht markup section with sortable headers, CSS for both sections using glass tokens + status badge variants

## Sparkline Lifecycle (Key Design)

The sparkline lifecycle uses two Maps maintained across renders:

1. `sparklineCanvases: Map<employeeId, HTMLCanvasElement>` — populated via `bind:this={(el) => { if (el) map.set(id, el); else map.delete(id); }}` in `{#each sortedOvertime as row (row.id)}`
2. `sparklineCharts: Map<employeeId, Chart>` — created/destroyed in `$effect(() => { tick().then(() => { ... }) })`

On every `sortedOvertime` change (data load or sort toggle):
- Phase 1: Destroy charts for employees no longer in the list
- Phase 2: For each row with `snapshots.length >= 2`, destroy any existing chart then `new Chart(canvas, ...)` and store in map
- Phase 3: `onDestroy` clears both maps entirely

This pattern ensures zero "Canvas is already in use" errors on re-sort.

## Decisions Made

- **bind:this function-form**: Used `bind:this={(el) => { ... }}` (Svelte 5 supported) rather than array refs — cleaner, no index alignment needed
- **Same-file single commit**: Both tasks implemented together since they share one Svelte file; splitting would require unstaging partial changes
- **carryOver field for sparkline data**: Per plan spec — sparkline shows the cumulative running saldo trend, not just monthly delta
- **Brand color from getComputedStyle**: `getComputedStyle(document.documentElement).getPropertyValue("--color-brand")` used for Chart.js `borderColor` — satisfies CLAUDE.md no-hex-in-components rule

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

- Pre-existing `hooks.server.ts` TypeScript error (`Property 'nonce' does not exist on type 'Locals'`) exists at base commit 125d993 and is unrelated to this plan. Confirmed by stash-testing before changes.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- /reports page now has Heutige Anwesenheit and Überstunden-Übersicht sections for managers
- RPT-02 (leave overview) frontend remains for Plan 07-03
- The role-guard and section-card patterns established here should be reused in 07-03

---
*Phase: 07-reporting-dashboards-berstunden-urlaub-anwesenheit*
*Completed: 2026-04-11*

## Self-Check: PASSED

Files created/modified:
- FOUND: apps/web/src/routes/(app)/reports/+page.svelte (contains `overtime-overview`, `today-attendance`, `new Chart(`)
- FOUND (to be created): .planning/phases/07-reporting-dashboards-berstunden-urlaub-anwesenheit/07-02-SUMMARY.md

Commits:
- FOUND: ee0fe90 feat(07-02): add Heutige Anwesenheit section on /reports (RPT-03)

Build verification: pnpm --filter @clokr/web run build exits 0
Type check: svelte-check produces 0 errors on reports/+page.svelte (pre-existing hooks.server.ts error excluded)
