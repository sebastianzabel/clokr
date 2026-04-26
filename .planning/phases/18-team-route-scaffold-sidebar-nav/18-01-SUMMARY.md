---
plan: 18-01
phase: 18-team-route-scaffold-sidebar-nav
status: complete
started: 2026-04-25T20:18:00Z
completed: 2026-04-25T20:20:26Z
subsystem: web/navigation
tags: [navigation, sidebar, manager, team]
requires: []
provides: [team-nav-items]
affects: [apps/web/src/routes/(app)/+layout.svelte]
tech-stack:
  added: []
  patterns: [svelte5-derived, inline-svg-snippet]
key-files:
  modified:
    - apps/web/src/routes/(app)/+layout.svelte
decisions:
  - Team nav items inserted before Berichte/Admin so team tools are discoverable first
metrics:
  duration: 2m
  completed: 2026-04-25T20:20:26Z
  tasks: 1
  files: 1
requirements: [NAV-05]
---

# Phase 18 Plan 01: Team Route Scaffold & Sidebar Nav Summary

Extended `managerNavItems` with Team-Zeiten (/team/time-entries) and Team-Abwesenheiten (/team/leave) as the first two manager nav items, plus added `users` and `calendar-check` SVG icon branches to the inline `navSvgIcon` snippet.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Extend managerNavItems and add icon cases for Team nav | 950dc9a | apps/web/src/routes/(app)/+layout.svelte |

## Changes

**managerNavItems** now has 4 entries in this order:
1. Team-Zeiten — `/team/time-entries` — icon: `users`
2. Team-Abwesenheiten — `/team/leave` — icon: `calendar-check`
3. Berichte — `/reports` — icon: `bar-chart-3`
4. Admin — `/admin` — icon: `settings`

**navSvgIcon snippet** gained two new `{:else if}` branches:
- `name === "users"` — Lucide Users icon SVG paths
- `name === "calendar-check"` — Lucide CalendarCheck icon SVG paths

Mobile bottom nav automatically includes the new team items via the existing `[...employeeNavItems, ...managerNavItems]` spread on line 552 — no additional changes needed.

Employee users (EMPLOYEE role) see no change: `isManager` guard remains unchanged, so the MANAGER nav group stays hidden.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or trust boundary changes introduced. Nav items only expose route paths already guarded server-side by requireRole middleware.

## Self-Check: PASSED

- Modified file exists: apps/web/src/routes/(app)/+layout.svelte
- Commit 950dc9a verified in git log
- All 6 acceptance criteria verified via grep
