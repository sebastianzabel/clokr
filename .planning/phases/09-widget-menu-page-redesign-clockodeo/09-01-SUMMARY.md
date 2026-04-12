---
phase: 09-widget-menu-page-redesign-clockodeo
plan: "01"
subsystem: web-ui
tags: [navigation, sidebar, css, layout]
dependency_graph:
  requires: []
  provides: [nav-group-label CSS, .nav-group CSS, .widget-action CSS, split nav arrays]
  affects: [apps/web/src/app.css, apps/web/src/routes/(app)/+layout.svelte]
tech_stack:
  added: []
  patterns: [Svelte 5 $derived arrays, CSS scoped style block, global CSS custom properties]
key_files:
  created: []
  modified:
    - apps/web/src/app.css
    - apps/web/src/routes/(app)/+layout.svelte
decisions:
  - "Used explicit flex-column .nav-group layout instead of display:contents — more reliable, avoids browser quirks with :first-child selector"
  - "nav-group-label CSS placed in scoped <style> block of +layout.svelte (not app.css) since it's sidebar-specific, bound to dark sidebar bg color"
  - ".widget-action placed in app.css as global rule — used across dashboard and other pages"
metrics:
  duration: "~8 minutes"
  completed_date: "2026-04-13"
  tasks_completed: 2
  files_changed: 2
---

# Phase 09 Plan 01: Nav Group Labels and Widget Action CSS Summary

Split sidebar navigation into MITARBEITER and MANAGER groups with uppercase section labels, and added global `.widget-action` CSS for widget link styling.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Add `.widget-action` and `.widget-action:hover` CSS to app.css | b0c04fc |
| 2 | Restructure +layout.svelte: split navItems, add group markup, update mobile nav, add scoped CSS | c790c4e |

## What Was Built

**Task 1 — app.css:**
Added global `.widget-action` CSS rule block before the `@media (prefers-reduced-motion)` section:
- `font-size: 0.8125rem` (13px), `font-weight: 400`, `color: var(--color-brand)`
- `transition: opacity 150ms ease-out`, `white-space: nowrap`
- `.widget-action:hover` → `opacity: 0.75`

**Task 2 — +layout.svelte:**
- Replaced single `navItems` `$derived` array with two separate arrays:
  - `employeeNavItems`: Dashboard, Zeiterfassung, Abwesenheiten (always shown)
  - `managerNavItems`: Berichte, Admin (shown when `isManager` — ADMIN or MANAGER role)
- Sidebar nav restructured into two `<div class="nav-group">` wrappers, each with a `<span class="nav-group-label">` (MITARBEITER / MANAGER)
- Manager group wrapped in `{#if isManager}` conditional
- Mobile bottom nav iterates `[...employeeNavItems, ...managerNavItems]` flat, no group labels
- Scoped `<style>` block updated with `.nav-group` (flex-column, 0.125rem gap), `.nav-group + .nav-group` (0.5rem margin-top), `.nav-group-label` (11px, uppercase, 0.08em letter-spacing, rgba(255,255,255,0.35)), and `.nav-group:first-child .nav-group-label` (reduced padding-top)
- `.sidebar-nav` `gap` changed from `0.125rem` to `0` (gap now delegated to `.nav-group`)

## Deviations from Plan

None — plan executed exactly as written, choosing the "second approach" (explicit flex-column) as explicitly recommended in the plan.

## Known Stubs

None.

## Threat Flags

None. Changes are CSS-only and UI restructuring. API enforcement on /admin and /reports routes is unchanged.

## Self-Check: PASSED

- [x] `apps/web/src/app.css` contains `.widget-action` and `.widget-action:hover` (lines 1723, 1731)
- [x] `apps/web/src/routes/(app)/+layout.svelte` uses `employeeNavItems` and `managerNavItems` (lines 184, 193)
- [x] Sidebar nav renders two `.nav-group` divs with `MITARBEITER` (line 364) and `MANAGER` (line 385) labels
- [x] Manager group rendered conditionally with `{#if isManager}` (line 383)
- [x] Mobile nav iterates `[...employeeNavItems, ...managerNavItems]` (line 552)
- [x] `.nav-group` and `.nav-group-label` CSS in layout's scoped style block (lines 840–864)
- [x] No `navItems` variable remains in the layout file (removed)
- [x] No `/overtime` href in layout file
- [x] Commits b0c04fc and c790c4e exist in git log
