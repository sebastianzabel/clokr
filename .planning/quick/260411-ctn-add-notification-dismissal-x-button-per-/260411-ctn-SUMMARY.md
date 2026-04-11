---
quick_id: 260411-ctn
phase: quick
plan: 260411-ctn
subsystem: notifications
tags: [notifications, ui, dismiss, soft-delete, audit-proof, svelte5, fastify]
dependency_graph:
  requires: []
  provides: [NOTIF-DISMISS-01, NOTIF-DISMISS-02]
  affects: [notifications, leave, time-entries, layout]
tech_stack:
  added: []
  patterns: [soft-dismiss, optimistic-ui, auto-dismiss, dismissByRelated]
key_files:
  created: []
  modified:
    - packages/db/prisma/schema.prisma
    - apps/api/src/plugins/notify.ts
    - apps/api/src/routes/notifications.ts
    - apps/api/src/routes/leave.ts
    - apps/api/src/plugins/attendance-checker.ts
    - apps/api/src/routes/time-entries.ts
    - apps/api/src/__tests__/notifications.test.ts
    - apps/web/src/routes/(app)/+layout.svelte
decisions:
  - "Soft-dismiss via dismissedAt timestamp (not hard delete) — preserves Revisionssicherheit"
  - "Loose relatedType/relatedId reference (not FK) so one helper works across any entity"
  - "Wrapper div pattern instead of nested button (valid HTML semantics)"
  - "Optimistic UI dismiss with rollback on error"
  - "Auto-dismiss failures wrapped in try/catch with log.warn (never block business action)"
metrics:
  duration_seconds: 692
  tasks_completed: 3
  files_modified: 8
  completed_date: "2026-04-11"
---

# Quick Task 260411-ctn: Notification Dismissal X Button per Item

**One-liner:** Soft-dismiss notifications via dismissedAt timestamp with per-item X button, auto-dismiss on leave review and clock-out resolution.

## What Was Built

### Task 1 — Schema + Plugin + API Endpoints (commit: 9a9ebd4)

- Extended `Notification` Prisma model with three nullable columns:
  - `dismissedAt DateTime? @db.Timestamptz` — null = visible, set = soft-dismissed
  - `relatedType String?` — e.g. "LeaveRequest", "TimeEntry" (loose ref, no FK)
  - `relatedId String?` — id of the related entity
  - Added `@@index([userId, dismissedAt])` and `@@index([relatedType, relatedId])`
- Applied schema to test database via `prisma db push`
- Updated `notify.ts` plugin: `NotifyParams` extended with `relatedType?/relatedId?`; `dismissByRelated()` helper added and decorated on `FastifyInstance`
- Updated `GET /notifications`: filters `dismissedAt: null` so dismissed items never reappear
- Added `DELETE /notifications/:id`: soft-dismiss by userId scope (cross-user = 404)
- Added `DELETE /notifications/dismiss-all`: bulk soft-dismiss for future use

### Task 2 — Auto-Dismiss Wiring + Extended Tests (commit: ddc4403)

- `leave.ts` POST /requests: stamped `LEAVE_REQUEST` notifications with `relatedType: "LeaveRequest"`, `relatedId: request.id`
- `leave.ts` PATCH review handler: `dismissByRelated("LeaveRequest", existing.id)` called after all four status transitions (APPROVED, REJECTED, CANCELLATION→CANCELLED, CANCELLATION→reverted APPROVED)
- `attendance-checker.ts`: `CLOCK_OUT_REMINDER` stamped with `relatedType: "TimeEntry"`, `relatedId: entry.id`
- `time-entries.ts` POST /:id/clock-out: `dismissByRelated("TimeEntry", id)` called after clock-out
- `time-entries.ts` PATCH /:id: `dismissByRelated("TimeEntry", id)` called when endTime transitions null→set
- All auto-dismiss calls wrapped in `try/catch` with `app.log.warn` — never block business action
- 5 new test cases: dismiss own, cross-user 404, non-existent 404, already-dismissed 404, auto-dismiss on approve

### Task 3 — UI X Button (commit: adf6e08)

- Added `dismissNotification(id, wasUnread)` with optimistic UI (removes from list instantly, rolls back on API error)
- Refactored sidebar notification items: `<button class="notification-item">` → wrapper `<div class="notification-item-wrapper">` + inner button + dismiss button (avoids nested button HTML)
- Applied same pattern to mobile header dropdown (`.notification-dropdown--mobile`)
- `.notification-dismiss` X button: `opacity: 0` default, visible on wrapper hover / `focus-visible`
- `aria-label="Benachrichtigung schließen"` for screen reader accessibility
- `stopPropagation()` prevents dismiss click from triggering notification navigation
- All styles via CSS custom properties — no hardcoded hex colors added
- `notification-item-wrapper--unread` now controls unread highlight (moved from inner button)

## Test Results

- 9/9 notification tests pass (including 4 new DELETE tests + auto-dismiss integration test)
- 20/20 leave tests pass
- `svelte-check` shows no errors in `+layout.svelte` (pre-existing warnings in other files only)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] dotenv missing from API test dependencies**
- **Found during:** Task 1 test verification
- **Issue:** `vitest.setup.ts` imports `dotenv` but it was not listed as a dependency; tests failed with `ERR_MODULE_NOT_FOUND`
- **Fix:** Created symlink `apps/api/node_modules/dotenv` to pnpm store; added missing env vars (JWT_SECRET, JWT_REFRESH_SECRET, ENCRYPTION_KEY) to `apps/api/.env.test`
- **Files modified:** `apps/api/.env.test`
- **Commit:** Inline fix (part of test run setup, not committed to source)

**2. [Rule 2 - Missing functionality] unreadCount filter missing dismissedAt**
- **Found during:** Task 1 implementation review
- **Issue:** Original plan only mentioned filtering `GET` notifications by `dismissedAt: null`, but the `unreadCount` sub-query also needed the same filter (otherwise dismissed but unread notifications would inflate the badge count)
- **Fix:** Added `dismissedAt: null` to the `count` query in `GET /notifications`
- **Files modified:** `apps/api/src/routes/notifications.ts`

## Known Stubs

None — all endpoints are wired to real database operations, UI calls real API.

## Threat Flags

None — no new network endpoints beyond the scoped `DELETE /notifications/:id` which enforces userId = req.user.sub preventing cross-user dismissal.

## Self-Check: PASSED

- Schema file exists with dismissedAt, relatedType, relatedId: confirmed
- notify.ts has dismissByRelated: confirmed
- notifications.ts has DELETE /:id: confirmed
- All 9 notification tests pass: confirmed
- leave.ts has dismissByRelated calls: confirmed
- time-entries.ts has dismissByRelated on clock-out: confirmed
- layout.svelte has notification-item-wrapper + notification-dismiss: confirmed
- Commits exist: 9a9ebd4, ddc4403, adf6e08: confirmed
