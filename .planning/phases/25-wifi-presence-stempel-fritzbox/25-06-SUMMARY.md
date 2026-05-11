---
phase: 25-wifi-presence-stempel-fritzbox
plan: "06"
subsystem: ui
tags: [svelte5, wifi-presence, fritzbox, admin, presence-sources, api-client]

# Dependency graph
requires:
  - phase: 25-wifi-presence-stempel-fritzbox
    provides: "Backend presence-sources CRUD routes (plans 25-03/25-04) used by this UI"
provides:
  - "Admin WiFi-Presence page at /admin/wifi-presence/ with three-block layout"
  - "Typed API client module apps/web/src/lib/api/presence.ts with six named exports"
  - "WiFi-Präsenz tab in admin navigation (ADMIN-only)"
affects:
  - phase-25-settings-profile  # plan 25-07 adds employee self-service MACs in /settings

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Presence API client module pattern: typed helpers wrapping api.get/post/delete in $lib/api/"
    - "Three-block admin page pattern: section-label + glass card per feature block"
    - "Device status dot: CSS class (.status-dot / .status-dot--online) avoiding inline hex"

key-files:
  created:
    - apps/web/src/lib/api/presence.ts
    - apps/web/src/routes/(app)/admin/wifi-presence/+page.svelte
  modified:
    - apps/web/src/routes/(app)/admin/+layout.svelte

key-decisions:
  - "Device status dot uses CSS classes (status-dot, status-dot--online) instead of inline style to avoid hardcoded hex — maps to var(--color-green) / var(--color-text-muted)"
  - "clearAssignment() extracted as named function to avoid inline arrow in {#each} for Bearbeiten button"
  - "sourcesLoading/optInLoading set to false after parallel Promise.all in onMount to avoid partial loading states"

patterns-established:
  - "API client modules in $lib/api/<domain>.ts: typed interfaces + named async functions using api.get/post/delete"
  - "Admin page three-block layout: section-label (card-animate) + card (card-body settings-card card-animate) per block"

requirements-completed: [WIFI-02, WIFI-05]

# Metrics
duration: 3min
completed: 2026-05-11
---

# Phase 25 Plan 06: WiFi-Presence Admin UI Summary

**Three-block admin UI for WiFi presence management: PresenceSource key CRUD with raw-key reveal, live FritzBox device list with MAC-to-employee assignment, and read-only opt-in overview — plus a typed presence.ts API client and ADMIN-only nav tab.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-05-11T19:24:16Z
- **Completed:** 2026-05-11T19:27:00Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- Created `apps/web/src/lib/api/presence.ts` with six typed exports (listSources, createSource, revokeSource, listDevices, mapDevice, listOptedInEmployees) using the existing api client
- Created `apps/web/src/routes/(app)/admin/wifi-presence/+page.svelte` (528 lines) with all three blocks, card-animate entrance animations, glass-card surfaces, aria-live alert for new key reveal, and colored dot + text for device online/offline status
- Added `{ href: "/admin/wifi-presence", label: "WiFi-Präsenz", show: isAdmin }` to admin navigation tabs — consistent with Import and Audit Log ADMIN-only tabs

## Task Commits

1. **Task 1: Create typed presence API client module** - `5c93fd5` (feat)
2. **Task 2: Create admin WiFi-Presence page (three-block layout)** - `13ed884` (feat)
3. **Task 3: Add WiFi-Präsenz tab to admin navigation** - `a81c0a5` (feat)

## Files Created/Modified

- `apps/web/src/lib/api/presence.ts` — Six typed API client helpers for all presence endpoints
- `apps/web/src/routes/(app)/admin/wifi-presence/+page.svelte` — Three-block admin page: PresenceSource keys, FritzBox devices, opt-in overview
- `apps/web/src/routes/(app)/admin/+layout.svelte` — Added WiFi-Präsenz tab (ADMIN-only)

## Decisions Made

- Device status dot implemented as CSS classes (`status-dot`, `status-dot--online`) rather than inline `background: {dev.online ? hex : hex}` — avoids hardcoded colors and satisfies the CLAUDE.md constraint
- `clearAssignment()` extracted as a named function to avoid inline arrow function complexity inside `{#each}` blocks
- `sourcesLoading` and `optInLoading` set to `false` only after the parallel `Promise.all([loadSources(), loadOptedIn()])` resolves — prevents partial loading states where one block shows content while the other still skeletons
- Employee list fetched with `pageSize=500` (non-fatal fallback) to populate the device-assignment dropdown without a separate paginated API

## Deviations from Plan

None — plan executed exactly as written. The only micro-adjustment was extracting `clearAssignment()` as a named function (plan had inline arrow) to improve readability and avoid lint warnings.

## Issues Encountered

None. `svelte-check` confirmed zero errors in new files (30 pre-existing errors in unrelated files were noted and are out-of-scope per deviation rules).

## Known Stubs

None. All data is loaded from live API endpoints. The device list requires an active FritzBox adapter to populate (by design — shows empty state otherwise).

## Threat Flags

None beyond the threat model in the plan. The page calls only authenticated `/admin/presence-sources/*` endpoints; the ADMIN-only tab provides client-side defense in depth consistent with the API's `requireRole('ADMIN')` server enforcement.

## Next Phase Readiness

- Admin WiFi-Presence management UI is complete and ready for testing once the backend plans 25-01 through 25-04 are deployed
- Plan 25-07 (employee self-service MAC entry in `/settings/+page.svelte`) can now proceed independently
- No blockers

---
*Phase: 25-wifi-presence-stempel-fritzbox*
*Completed: 2026-05-11*
