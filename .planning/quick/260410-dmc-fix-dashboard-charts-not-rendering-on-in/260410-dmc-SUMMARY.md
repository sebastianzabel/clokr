---
phase: 260410-dmc-fix-dashboard-charts-not-rendering-on-in
plan: 01
subsystem: ui
tags: [svelte5, chart.js, dashboard, tick, dom-lifecycle]

requires: []
provides:
  - "Dashboard charts (weekly hours, overtime trend, sick days) render on initial page load"
affects: []

tech-stack:
  added: []
  patterns:
    - "tick() after chartsLoading=false ensures canvas bind:this refs are populated before Chart.js instantiation"

key-files:
  created: []
  modified:
    - apps/web/src/routes/(app)/dashboard/+page.svelte

key-decisions:
  - "Restructure loadCharts() into 4 phases: fetch data, flip loading flag + await tick(), instantiate charts, side fetches — instead of a single monolithic try/finally"
  - "tick import added from svelte to ensure DOM is settled after reactive state change"

requirements-completed: [QUICK-260410-DMC]

duration: 10min
completed: 2026-04-09
---

# Quick Task 260410-dmc: Fix Dashboard Charts Not Rendering on Initial Load

**`loadCharts()` restructured so `chartsLoading=false` + `await tick()` runs before Chart.js canvas instantiation, fixing all three dashboard charts being invisible on first page load.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-04-09T00:00:00Z
- **Completed:** 2026-04-09T00:10:00Z
- **Tasks:** 1 (checkpoint skipped per constraints — fix confirmed clear)
- **Files modified:** 1

## Root Cause

`loadCharts()` had this structure:

```
try {
  // ... data fetching ...
  // chart creation ← runs HERE when chartsLoading is still true
  //   weeklyChartEl, overtimeChartEl, sickChartEl are all undefined
  //   because {#if chartsLoading}...{:else}<canvas>...{/if} hides the canvases
} catch (err) {...}
finally {
  chartsLoading = false;  // too late — Chart.js already ran, found no canvas
}
```

The `{:else}` branch containing the `<canvas>` elements is only rendered when `chartsLoading` is `false`. Because the `finally` block (which sets `chartsLoading = false`) runs AFTER the chart creation code, all three `bind:this` refs were `undefined` when `new Chart(canvasEl, ...)` was called. The `if (weeklyChartEl)` guards are falsy, so no chart is ever created on first load.

## Fix Applied

Restructured `loadCharts()` into four phases:

1. **Phase 1 (try/finally):** Fetch 6 months of `/reports/monthly` data, build `reports[]`, `labels[]`, `brandColor`. The `finally` block sets `chartsLoading = false` — this is the ONLY place `chartsLoading` is set, and it runs before any chart work.

2. **Phase 2:** `await tick()` — waits for Svelte to commit the DOM update (render the `{:else}` branch with canvases) so that all three `bind:this` refs are populated.

3. **Phase 3:** Chart instantiation — `weeklyChart`, `overtimeChart`, `sickChart` are created. Each is guarded by `if (canvasEl)` and preceded by `existingChart?.destroy()` to handle re-runs (theme switch, data refresh) cleanly.

4. **Phase 4:** Side fetches — "Load own next leave" and the manager `upcomingLeaves` / `pendingApprovalCount` blocks. Logic unchanged, just moved outside the outer try/finally.

Added `tick` to the existing svelte import line:
```ts
import { onMount, onDestroy, tick } from "svelte";
```

## Task Commits

1. **Task 1: Flip chartsLoading + await tick() before Chart.js instantiation** — `7849cb2` (fix)

## Files Created/Modified

- `apps/web/src/routes/(app)/dashboard/+page.svelte` — `tick` added to svelte import; `loadCharts()` restructured into 4 phases so canvas refs are populated before Chart.js instantiation

## Decisions Made

- Used `tick()` rather than `setTimeout` or other workarounds — this is the idiomatic Svelte 5 approach per CLAUDE.md "Svelte 5 Gotchas"
- Kept per-month inner try/catch unchanged so partial API failures still produce a chart with zero-filled data
- The `if (isManager)` block and the leave side-fetches remain outside the outer try/finally (Phase 4) — their logic is unchanged, only their position moved

## Deviations from Plan

None — plan executed exactly as written. The checkpoint (Task 2) was skipped per task constraints (fix is clear and confirmed).

## Verification

- `svelte-check` reports 0 errors for `apps/web/src/routes/(app)/dashboard/+page.svelte`
- All 17 errors reported by svelte-check are pre-existing errors in unrelated files (`admin/special-leave`, `admin/system`, `admin/vacation`, `leave`, `time-entries`, `auth/login`, `auth/otp`)
- Structural review confirms:
  - `import { onMount, onDestroy, tick } from "svelte"` present
  - `chartsLoading = false` is in the `finally` block that closes BEFORE any `new Chart(...)` call
  - `await tick()` appears exactly once, immediately after that `finally` block
  - All three chart creation blocks live outside the outer try/finally
  - `weeklyChart?.destroy()`, `overtimeChart?.destroy()`, `sickChart?.destroy()` still called before each `new Chart(...)`
  - Leave side-fetches still execute after chart creation with unchanged logic

## Issues Encountered

None.

## Self-Check

- [x] File exists: `apps/web/src/routes/(app)/dashboard/+page.svelte` — FOUND
- [x] Commit exists: `7849cb2` — FOUND
- [x] `tick` in import line — FOUND
- [x] `chartsLoading = false` in finally before chart creation — FOUND
- [x] `await tick()` after finally, before chart instantiation — FOUND

## Self-Check: PASSED

---
*Quick task: 260410-dmc*
*Completed: 2026-04-09*
