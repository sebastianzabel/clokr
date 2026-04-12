---
phase: 09-widget-menu-page-redesign-clockodeo
plan: 02
subsystem: ui
tags: [svelte, dashboard, widgets, css, clockodeo]

# Dependency graph
requires:
  - phase: 09-01
    provides: .widget-action CSS in app.css (used by widget-action links added in this plan)
provides:
  - Uniform .widget-header blocks across all dashboard widgets
  - Widget action links (Zeiterfassung, Alle anzeigen, Urlaube) in relevant widgets
  - Updated cell-badge--holiday using brand-tint colors
  - Updated cell-badge--absent using purple tokens
  - Today-column inset box-shadow ring in Meine Woche table
affects:
  - 09-03
  - 09-04

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Widget header pattern: .widget-header > .widget-title + optional .widget-action anchor"
    - "Today-column ring: inset box-shadow instead of background-tint for precise cell highlight"

key-files:
  created: []
  modified:
    - apps/web/src/routes/(app)/dashboard/+page.svelte

key-decisions:
  - "Remove myWeekOffset state and nav functions — Meine Woche no longer supports week-by-week navigation; static link to /time-entries replaces the prev/today/next buttons"
  - "cell-badge--holiday changed from blue to brand-tint/brand to align with calendar cell convention (Phase 9 D-08)"
  - "cell-badge--absent changed from yellow to purple tokens per UI-SPEC Meine Woche color map"
  - "Today column: inset box-shadow ring chosen over background-tint so cell-badge colors inside are not obscured"

patterns-established:
  - "Widget header pattern: all dashboard widgets use <div class='widget-header'><h3 class='widget-title'>...</h3>[<a class='widget-action'>]</div>"
  - "Chart widgets (informational): widget-header with no action link"
  - "Action widgets: widget-header with .widget-action anchor linking to the relevant page"

requirements-completed:
  - D-01
  - D-02
  - D-06
  - D-08

# Metrics
duration: 12min
completed: 2026-04-13
---

# Phase 09 Plan 02: Widget Header Standardization Summary

**Dashboard widget headers unified to Clockodeo title-left/action-right pattern with upgraded cell-badge semantic colors and today-column ring highlight**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-04-13T00:00:00Z
- **Completed:** 2026-04-13T00:12:00Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments

- All dashboard widgets now use uniform `.widget-header` + `.widget-title` markup (replaced standalone `h3.chart-title`)
- Action links added: "Zeiterfassung →" (Meine Woche), "Alle anzeigen →" (Offene Vorgänge), "Urlaube →" (Anstehende Urlaube)
- Chart widgets (Arbeitsstunden, Überstunden-Trend, Krankheitstage) get widget-header container with no action link per copywriting contract
- `.cell-badge--holiday` changed from blue (`--color-blue-bg` / `--color-blue`) to brand-tint (`--color-brand-tint` / `--color-brand`) — aligns with calendar cell convention
- `.cell-badge--absent` changed from yellow to purple tokens (`--color-purple-bg`, `--color-purple`, `--color-purple-border`)
- Today column in Meine Woche now uses `box-shadow: inset 0 0 0 2px var(--color-brand)` ring instead of background-tint
- Removed week navigation (prev/today/next buttons) from Meine Woche — replaced by static link; cleaned up `myWeekOffset` state and nav functions

## Task Commits

Each task was committed atomically:

1. **Task 1: Standardize widget headers and add action links** - `c7cf27d` (feat)
2. **Task 2: Upgrade cell-badge colors and add today-column ring** - `e26346d` (feat)

**Plan metadata:** [docs commit follows]

## Files Created/Modified

- `apps/web/src/routes/(app)/dashboard/+page.svelte` - Widget header markup + CSS color upgrades

## Decisions Made

- Removed `myWeekOffset`, `myWeekPrev`, `myWeekNext`, `myWeekCurrent` — since the week navigation buttons were removed, there's no longer any point in maintaining an offset state. `loadMyWeek()` simplified to always load current week.
- Purple tokens (`--color-purple-bg`, `--color-purple`, `--color-purple-border`) confirmed to exist in all three themes in `app.css` — used directly without fallback values.
- `.chart-title` CSS left in place (per plan instruction) for backward compatibility, though no markup uses it for headings anymore.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## Known Stubs

None — all widget action links point to real routes (`/time-entries`, `/leave?view=approvals`, `/leave`). All cell-badge color tokens are defined in `app.css`.

## Next Phase Readiness

- Dashboard widget header pattern is fully standardized and ready for Phase 09 verifier
- Cell-badge semantic colors align with UI-SPEC color map
- Today-column ring is visually precise and non-interfering with inner badge colors

---
*Phase: 09-widget-menu-page-redesign-clockodeo*
*Completed: 2026-04-13*
