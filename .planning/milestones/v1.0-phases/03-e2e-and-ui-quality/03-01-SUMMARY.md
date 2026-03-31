---
phase: 03-e2e-and-ui-quality
plan: "01"
subsystem: e2e-tests, web-ui
tags: [e2e, playwright, locked-month, clock-in, time-entries, ui-error-mapping]
dependency_graph:
  requires: []
  provides: [E2E-01, E2E-02, UI-02]
  affects: [apps/e2e/tests/core-flows.spec.ts, apps/e2e/tests/time-entries-flow.spec.ts, apps/web/src/routes/(app)/time-entries/+page.svelte]
tech_stack:
  added: []
  patterns: [playwright-page-route-mock, clock-state-reset-pattern, duck-type-ApiError]
key_files:
  created: []
  modified:
    - apps/web/src/routes/(app)/time-entries/+page.svelte
    - apps/e2e/tests/core-flows.spec.ts
    - apps/e2e/tests/time-entries-flow.spec.ts
decisions:
  - "Duck-type ApiError with (e as any)?.status === 403 — ApiError is not exported from client.ts"
  - "Use page.route() to mock 403 response for locked-month test — avoids need for a real locked month in test DB"
  - "State reset pattern (if isVisible) for clock tests — required to handle unknown initial clock state; not an optional assertion bypass"
metrics:
  duration: 113s
  completed: "2026-03-31"
  tasks_completed: 2
  files_modified: 3
---

# Phase 03 Plan 01: E2E Tests and Locked-Month UI Error Summary

## One-liner

Added HTTP 403 → "Monat ist gesperrt" mapping to time entries page and replaced scaffold E2E tests with substantive clock-in/out and CRUD flow assertions using Playwright hard expects and page.route() mocking.

## What Was Built

### Task 1: Locked-month German error message (UI-02)

Modified `apps/web/src/routes/(app)/time-entries/+page.svelte`:

- `saveEntry()` catch block: checks `(e as any)?.status === 403` first, sets `saveError = "Monat ist gesperrt"`, falls through to existing German message otherwise
- `deleteEntry()` catch block: same pattern, sets `error = "Monat ist gesperrt"` on 403
- `revalidateEntry()` catch block: unchanged (as specified)

The `ApiError` class is not exported from `client.ts`, so duck-typing `(e as any)?.status` is the correct approach.

### Task 2: Substantive E2E tests (E2E-01, E2E-02)

**core-flows.spec.ts** — replaced two scaffold tests ("command palette opens with Ctrl+K" and "theme switcher works") with two clock tests:

- "clock in and verify running state": resets to clocked-out state, clicks `.clock-btn--in`, asserts `.clock-btn--out` visible and "Eingestempelt seit" text visible
- "clock out and verify stopped state": ensures clocked-in state, clicks `.clock-btn--out`, asserts `.clock-btn--in` visible and "Eingestempelt seit" text not visible

**time-entries-flow.spec.ts** — replaced optional `if (await el.isVisible())` patterns with hard `await expect()` assertions:

- "create a manual time entry": clicks "Eintrag hinzufügen", fills date/time inputs, saves, asserts modal closes
- "edit an existing time entry": opens day cell or pencil icon, changes end time, saves, asserts modal closes
- "delete a time entry": opens entry, clicks delete, confirms "Ja", asserts modal gone
- "locked-month edit shows German error message": uses `page.route()` to intercept PUT calls and return 403, submits form, asserts "Monat ist gesperrt" is visible in DOM

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Duck-type `(e as any)?.status === 403` | `ApiError` is not exported from `client.ts` — this is the documented pattern from D-10 |
| `page.route()` for locked-month mock | Avoids dependency on a real locked month in the test database; deterministic |
| State reset `if (await btn.isVisible())` in clock tests | Plan requires handling unknown initial clock state; these are precondition setups, not assertion bypasses |

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written.

### Notes

The plan's acceptance criterion "No `if (await el.isVisible())` optional assertion pattern remains" conflicts with its own instruction to "Reset state: if `.clock-btn--out` is visible, click it". The state reset `if (await)` blocks in `core-flows.spec.ts` are required by the plan and are precondition setups, not assertion bypasses. All actual assertions use hard `await expect()`. The `time-entries-flow.spec.ts` has zero `if (await` patterns.

## Known Stubs

None — all test flows make real assertions. The edit/delete tests use a fallback selector for environments where `data-date` attribute is not present on day cells, but the primary flow uses the attribute.

## Self-Check

Checking files exist and commits are present...

## Self-Check: PASSED

- FOUND: apps/web/src/routes/(app)/time-entries/+page.svelte
- FOUND: apps/e2e/tests/core-flows.spec.ts
- FOUND: apps/e2e/tests/time-entries-flow.spec.ts
- FOUND: .planning/phases/03-e2e-and-ui-quality/03-01-SUMMARY.md
- FOUND: commit eae2ceb (feat(03-01): map HTTP 403 to 'Monat ist gesperrt')
- FOUND: commit f94f450 (feat(03-01): write substantive E2E tests)
