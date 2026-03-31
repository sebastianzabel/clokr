---
phase: 01-test-infrastructure
plan: 04
subsystem: testing
tags: [eslint, typescript, no-floating-promises, type-aware, lint]

# Dependency graph
requires:
  - phase: 01-test-infrastructure-01-01
    provides: silent .catch(() => {}) patterns removed, making no-floating-promises clean
provides:
  - Type-aware ESLint block in eslint.config.js scoped to **/*.ts
  - no-floating-promises enforced as blocking error on all TypeScript files
  - no-misused-promises enforced as blocking error on all TypeScript files
  - Five pre-existing floating promise bugs fixed in plugin files
affects:
  - all future TypeScript development in apps/api and apps/web

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Type-aware linting via parserOptions.project: true with tsconfigRootDir: import.meta.dirname"
    - "void operator for intentionally fire-and-forget promises (e.g., node-cron task.stop())"

key-files:
  created: []
  modified:
    - eslint.config.js
    - apps/api/src/index.ts
    - apps/api/src/plugins/attendance-checker.ts
    - apps/api/src/plugins/auto-close-month.ts
    - apps/api/src/plugins/data-retention.ts
    - apps/api/src/plugins/scheduler.ts

key-decisions:
  - "void operator used for node-cron task.stop() calls — ScheduledTask.stop() is typed as void | Promise<void>, void makes intent explicit without requiring await"
  - "void main() in index.ts — top-level async entry points should use void since errors are handled internally with process.exit(1)"

patterns-established:
  - "Floating promise fix: use void operator for intentional fire-and-forget (cron callbacks, top-level entry points)"
  - "Type-aware ESLint block scoped to **/*.ts only — Svelte files excluded (separate parser handles those)"

requirements-completed:
  - TEST-04

# Metrics
duration: 4min
completed: 2026-03-30
---

# Phase 01 Plan 04: no-floating-promises ESLint Rule Summary

**Type-aware ESLint block added enforcing `no-floating-promises` and `no-misused-promises` as errors for all TypeScript files, with five pre-existing floating promise bugs fixed in plugin shutdown hooks and server entry point.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-03-30T09:23:43Z
- **Completed:** 2026-03-30T09:28:00Z
- **Tasks:** 1
- **Files modified:** 6

## Accomplishments

- eslint.config.js now has a type-aware block (`parserOptions.project: true`) scoped to `**/*.ts` files
- `@typescript-eslint/no-floating-promises` set to `"error"` — any new unhandled promise blocks CI
- `@typescript-eslint/no-misused-promises` set to `"error"` — prevents async callbacks in void-expecting positions
- `pnpm lint` exits 0 across the full monorepo (0 errors, 192 warnings)
- Five pre-existing bugs fixed: floating promises in cron plugin shutdown hooks and server entry point

## Task Commits

Each task was committed atomically:

1. **Task 1: Add parserOptions.project and no-floating-promises to eslint.config.js** - `47fbafd` (feat)

## Files Created/Modified

- `eslint.config.js` - Added type-aware block with no-floating-promises/no-misused-promises as errors
- `apps/api/src/index.ts` - Changed `main()` to `void main()` for top-level async entry
- `apps/api/src/plugins/attendance-checker.ts` - Changed `task.stop()` to `void task.stop()` in onClose hook
- `apps/api/src/plugins/auto-close-month.ts` - Changed `t.stop()` to `void t.stop()` in forEach callback
- `apps/api/src/plugins/data-retention.ts` - Changed `t.stop()` to `void t.stop()` in forEach callback
- `apps/api/src/plugins/scheduler.ts` - Changed `task.stop()` to `void task.stop()` in both loop sites

## Decisions Made

- Used `void` operator for `node-cron` task.stop() calls: `ScheduledTask.stop()` is typed as `void | Promise<void>` — the void operator marks intentional non-await without needing to rewrite the shutdown hooks as async.
- Used `void main()` in index.ts: the function already has internal try/catch with `process.exit(1)`, so awaiting at the top level adds no safety value.
- Svelte files excluded from type-aware block: the Svelte parser handles `.svelte` files separately and `no-floating-promises` doesn't apply cleanly to Svelte component event handlers.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed floating promise: void main() in apps/api/src/index.ts**
- **Found during:** Task 1 (first lint run after adding rule)
- **Issue:** `main()` at line 17 returned an unhandled Promise — lint exited non-zero
- **Fix:** Changed to `void main()` to explicitly mark intent
- **Files modified:** apps/api/src/index.ts
- **Verification:** `pnpm --filter @clokr/api lint` shows 0 errors
- **Committed in:** 47fbafd (Task 1 commit)

**2. [Rule 1 - Bug] Fixed floating promise: task.stop() in attendance-checker.ts onClose**
- **Found during:** Task 1 (first lint run after adding rule)
- **Issue:** `ScheduledTask.stop()` returns `void | Promise<void>`; for-loop call was unhandled
- **Fix:** Changed to `void task.stop()`
- **Files modified:** apps/api/src/plugins/attendance-checker.ts
- **Verification:** No error on that line after fix
- **Committed in:** 47fbafd (Task 1 commit)

**3. [Rule 1 - Bug] Fixed misused promise: t.stop() in auto-close-month.ts forEach**
- **Found during:** Task 1 (first lint run after adding rule)
- **Issue:** Arrow function `(t) => t.stop()` returned a Promise in a void-expecting `forEach` callback
- **Fix:** Changed to `(t) => void t.stop()`
- **Files modified:** apps/api/src/plugins/auto-close-month.ts
- **Verification:** No error on that line after fix
- **Committed in:** 47fbafd (Task 1 commit)

**4. [Rule 1 - Bug] Fixed misused promise: t.stop() in data-retention.ts forEach**
- **Found during:** Task 1 (first lint run after adding rule)
- **Issue:** Same forEach pattern as auto-close-month.ts
- **Fix:** Changed to `(t) => void t.stop()`
- **Files modified:** apps/api/src/plugins/data-retention.ts
- **Verification:** No error on that line after fix
- **Committed in:** 47fbafd (Task 1 commit)

**5. [Rule 1 - Bug] Fixed floating promise: task.stop() in scheduler.ts (two sites)**
- **Found during:** Task 1 (first lint run after adding rule)
- **Issue:** Two for-loop sites calling `task.stop()` without void/await — in setupSchedules and onClose
- **Fix:** Changed both to `void task.stop()`
- **Files modified:** apps/api/src/plugins/scheduler.ts
- **Verification:** No errors on those lines after fix
- **Committed in:** 47fbafd (Task 1 commit)

---

**Total deviations:** 5 auto-fixed (5 Rule 1 bugs — all pre-existing floating promise patterns newly caught by the rule this plan enabled)

**Impact on plan:** All fixes necessary for correctness and to make lint pass. No scope creep — all violations were directly caused by adding the new rule.

## Issues Encountered

None — the plan executed cleanly after fixing the 5 pre-existing bugs surfaced by the new rule.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `no-floating-promises` is now a blocking error in CI (via `pnpm lint`)
- Any new TypeScript file with an unhandled Promise will fail lint
- Five shutdown-hook bugs fixed — plugin cleanup is now provably correct
- Plans 01-05 and 01-06 can proceed; this was a Wave 2 dependency

---
*Phase: 01-test-infrastructure*
*Completed: 2026-03-30*
