---
phase: 260411-g4n
plan: "01"
type: quick
subsystem: web/ui
tags: [css, refactor, calendar, time-entries, leave, canonical-classes]
dependency_graph:
  requires: []
  provides: [canonical-calendar-css-classes]
  affects: [apps/web/src/routes/(app)/time-entries/+page.svelte, apps/web/src/routes/(app)/leave/+page.svelte, apps/web/src/app.css]
tech_stack:
  added: []
  patterns: [canonical-css-class-naming, global-shared-css-selectors]
key_files:
  created: []
  modified:
    - apps/web/src/routes/(app)/time-entries/+page.svelte
    - apps/web/src/routes/(app)/leave/+page.svelte
    - apps/web/src/app.css
decisions:
  - "No shared Svelte component — two calendars have fundamentally different content (time-entry data vs leave chips with drag-select); CSS class unification gives DRY benefit without brittle shared component"
  - "Canonical class set uses cal-cell prefix for wrapper and modifiers (cal-cell--ok, cal-cell--disabled) and unprefixed state modifiers (cal-today, cal-weekend, cal-holiday, cal-other, cal-current, cal-selected)"
  - "app.css rules guard with :not(.cal-other):not(.cal-selected) for holiday/weekend to preserve existing selective behavior"
metrics:
  duration_minutes: 15
  completed_date: "2026-04-11"
  tasks_completed: 2
  tasks_total: 3
  files_changed: 3
---

# Quick Task 260411-g4n: Build Shared Calendar Base Component Summary

**One-liner:** Unified CSS class naming across Zeiterfassung and Abwesenheiten calendars — canonical `cal-cell`/`cal-*` set, single selector per concept in app.css.

## What Was Done

Renamed all CSS classes in both calendar pages to a single canonical set, and consolidated the shared calendar rules in `app.css` so each concept (holiday background, weekend background, absence-type backgrounds) has exactly one selector instead of the previous dual-selector pattern.

### Canonical Class Name Set Established

| Concept             | Old (time-entries)  | Old (leave)          | Canonical (both) |
| ------------------- | ------------------- | -------------------- | ---------------- |
| Cell wrapper        | `.cal-day`          | `.cal-cell`          | `.cal-cell`      |
| Day number          | `.day-num`          | `.cal-day-num`       | `.cal-day-num`   |
| Holiday label       | `.day-holiday-name` | `.cal-holiday-label` | `.cal-holiday-label` |
| Weekend state       | `.is-weekend`       | `.cal-weekend`       | `.cal-weekend`   |
| Holiday state       | `.is-holiday`       | `.cal-holiday`       | `.cal-holiday`   |
| Other month state   | `.other-month`      | `.cal-other`         | `.cal-other`     |
| Today state         | `.is-today`         | `.cal-today`         | `.cal-today`     |
| Current month state | (none)              | `.cal-cell--current` | `.cal-current`   |
| Selected state      | `.is-selected`      | (none)               | `.cal-selected`  |
| Absence-type mod    | `.cal-day--abs-*`   | (none)               | `.cal-abs-*`     |
| Cell status mod     | `.cal-day--ok` etc. | (none)               | `.cal-cell--ok` etc. |

### Files Changed

**apps/web/src/routes/(app)/time-entries/+page.svelte** — 43 insertions, 42 deletions
- Template: wrapper class, class: directives, inner spans all renamed
- Added `class:cal-current` positive current-month state
- Scoped styles: all `.cal-day*`, `.day-num`, `.day-holiday-name`, `.day-abs-type`, `.is-today`, `.is-selected`, `.other-month` selectors updated
- `:global()` blocks updated with new class names
- Mobile `@media` block updated

**apps/web/src/routes/(app)/leave/+page.svelte** — minimal change
- Template: `class:cal-cell--current` → `class:cal-current`
- Styles: `.cal-cell--current` → `.cal-cell.cal-current` and `.cal-cell--current:hover` → `.cal-cell.cal-current:hover`

**apps/web/src/app.css** — 12 insertions, 14 deletions (lines 1685–1721)
- Replaced dual-selector calendar rules with single canonical selectors
- `.cal-day.is-holiday + .cal-holiday` → `.cal-cell.cal-holiday:not(.cal-other):not(.cal-selected)`
- `.cal-day.is-weekend + .cal-cell.cal-weekend` → `.cal-cell.cal-weekend:not(.cal-other):not(.cal-selected)`
- `.cal-day.cal-day--abs-*` → `.cal-cell.cal-abs-*` (all 6 leave-type backgrounds)

### Why No Shared Svelte Component

Per research findings documented in the plan: the two calendars have fundamentally different content (Zeiterfassung shows time-entry data, worked hours, ArbZG warnings, saldo; Abwesenheiten shows leave chips with drag-select). A shared component would require too many slots/props to be maintainable. CSS class unification delivers the DRY benefit in global styles without forcing a brittle abstraction.

## Commits

| Task | Commit  | Description                                              |
| ---- | ------- | -------------------------------------------------------- |
| 1    | 02d3511 | refactor(260411-g4n): migrate Zeiterfassung calendar to canonical CSS class names |
| 2    | 834fdd8 | refactor(260411-g4n): align leave calendar + consolidate app.css shared rules |

## Verification

- `svelte-check --threshold error` → 0 errors, 0 warnings (both before and after changes)
- `grep -c "class:is-today|class:is-weekend|..."` in time-entries → 0 (all old state classes renamed)
- `grep -c "cal-cell--current"` in leave → 0 (renamed to cal-current)
- `grep -n "\.cal-day\.is-holiday|\.cal-day\.cal-day--abs"` in app.css → no matches
- app.css now has single canonical `.cal-cell.*` selector per concept

## Requires Manual Visual Verification

Task 3 is a `checkpoint:human-verify` — the automated tasks are complete but visual verification across both calendars and all themes has not been performed. See the plan's Task 3 checklist for verification steps:

1. **Zeiterfassung calendar** (http://localhost:5173/time-entries): day numbers, today highlight, weekend grey, selected state, holiday tint, absence backgrounds, ArbZG warnings, before-hire dimming
2. **Abwesenheiten calendar** (http://localhost:5173/leave): chips, drag-select, weekend/today/holiday states
3. **Theme switching** across all 5 themes (pflaume, nacht, wald, schiefer, pro) on both pages
4. **Mobile viewport** (~390px) — no new regressions beyond known overflow issue
5. **Console** — no runtime errors

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- `apps/web/src/routes/(app)/time-entries/+page.svelte` — FOUND (modified)
- `apps/web/src/routes/(app)/leave/+page.svelte` — FOUND (modified)
- `apps/web/src/app.css` — FOUND (modified)
- Commit 02d3511 — FOUND
- Commit 834fdd8 — FOUND
