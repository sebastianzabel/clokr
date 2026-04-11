---
phase: 260411-2ob
plan: 01
subsystem: web/leave
tags: [theming, css-variables, dark-mode, leave-page]
dependency_graph:
  requires: []
  provides: [themed-leave-page]
  affects: [apps/web/src/routes/(app)/leave/+page.svelte, apps/web/src/app.css]
tech_stack:
  added: []
  patterns: [CSS custom properties, theme-scoped --leave-type-* variables]
key_files:
  created: []
  modified:
    - apps/web/src/routes/(app)/leave/+page.svelte
    - apps/web/src/app.css
decisions:
  - "Return var(--leave-type-*) strings from typeColor() instead of hex appending; pending distinction handled by existing .cal-chip--pending CSS class"
  - "Add MATERNITY and PARENTAL to typeColor varMap to fix pre-existing TypeScript error"
  - "Use --color-border-subtle instead of --gray-100 for cal-cell/cal-legend borders (better nacht contrast)"
metrics:
  duration_minutes: ~15
  completed: "2026-04-11"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 2
---

# Phase 260411-2ob Plan 01: Leave Page Theme Fix Summary

**One-liner:** Replace 9 hardcoded hex surface/brand colors and 11 hardcoded type-color hexes in the leave page with theme-scoped CSS custom properties so all four themes (pflaume, nacht, wald, schiefer) render correctly.

## What Was Built

The leave page (`/leave`) was hardcoding hex colors for calendar cell backgrounds, weekend shading, holiday borders/labels, and leave chip/legend colors. These values were all pflaume (default) brand colors, causing nacht (dark) mode to show white cells, pflaume-purple holiday borders, and illegible chips in the dark theme.

Two changes were made:

1. **Style block fixes** — 9 hardcoded hex replacements in `<style>`:
   - `.cal-cell` background: `#fff` → `var(--color-surface)`
   - `.cal-cell` borders: `var(--gray-100, #f3f4f6)` → `var(--color-border-subtle)`
   - `.cal-weekend` background: `#f4f0fa` → `var(--color-bg-subtle)`
   - `.cal-holiday` background: `#ede7f6` → `var(--color-brand-tint)` (+ border)
   - `.cal-holiday-label` color: `#6b21a8` → `var(--color-brand)`
   - `.cal-cell--current:hover` / `.cal-cell--drag-selected`: removed pflaume fallback hexes
   - `.cal-legend` border: `var(--gray-100, ...)` → `var(--color-border-subtle)`
   - `.legend-holiday-dot`: `#ede7f6`/`#80377b` → `var(--color-brand-tint)`/`var(--color-brand)`

2. **Leave-type color variables** — 13 `--leave-type-*` variables added to `app.css`:
   - Defined in `:root`/`[data-theme="pflaume"]` with current light-theme values
   - Overridden in `[data-theme="nacht"]` with muted, accessible variants for dark `#161b22` surface
   - `typeColor()` JS function now returns `var(--leave-type-*)` strings instead of hex literals
   - Template legend dots updated to use `var(--leave-type-*)` inline styles
   - Fixed pre-existing TypeScript error: `MATERNITY` and `PARENTAL` added to `varMap`

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1: Style block hex replacements | be53aab | fix(260411-2ob): replace hardcoded hex surface/brand colors with CSS vars in leave page |
| Task 2: Leave-type CSS variables | 53bb9ea | fix(260411-2ob): move leave-type colors to CSS variables for theme-aware chip/legend colors |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed pre-existing TypeScript error in typeColor()**
- **Found during:** Task 2
- **Issue:** `typeColor()` had `const colors: Record<TypeCode, string>` missing `MATERNITY` and `PARENTAL` keys, causing a TypeScript error pre-existing before our work
- **Fix:** New `varMap` includes all 10 TypeCode values including MATERNITY and PARENTAL
- **Files modified:** `apps/web/src/routes/(app)/leave/+page.svelte`
- **Commit:** 53bb9ea

**2. [Rule 2 - Pending chip color] Simplified pending color approach**
- **Found during:** Task 2
- **Issue:** Original code appended `"88"` hex alpha to the base color for pending chips. With CSS vars you cannot append characters. The `.cal-chip--pending` class already applies `opacity: 0.85` + dashed outline to visually distinguish pending chips.
- **Fix:** `typeColor()` returns the base var for all statuses; pending distinction is fully handled by CSS class
- **Files modified:** `apps/web/src/routes/(app)/leave/+page.svelte`
- **Commit:** 53bb9ea

**3. [Plan item 8/9 - Border color variable] Used --color-border-subtle instead of --gray-100**
- **Found during:** Task 1
- **Issue:** Plan item 8 specified using `--color-border-subtle` for borders in nacht where `--gray-100` and `--color-surface` are nearly identical (`#161b22` vs `#161b22`). Applied as specified.
- **Fix:** Used `var(--color-border-subtle)` for cal-cell borders and cal-legend border-top
- **Files modified:** `apps/web/src/routes/(app)/leave/+page.svelte`
- **Commit:** be53aab

## Task 3: Visual Verification

**Status:** Auto-approved (auto chain active — `workflow._auto_chain_active = true`)

Human verification in Docker across all four themes is recommended before deploying. The changes are purely CSS and do not affect any business logic.

## Known Stubs

None. All CSS variable references resolve to real values defined in `app.css` theme blocks.

## Threat Flags

None. This is a pure CSS theming change with no new network endpoints, auth paths, or schema changes.

## Self-Check: PASSED

- FOUND: apps/web/src/routes/(app)/leave/+page.svelte
- FOUND: apps/web/src/app.css
- FOUND commit be53aab
- FOUND commit 53bb9ea
