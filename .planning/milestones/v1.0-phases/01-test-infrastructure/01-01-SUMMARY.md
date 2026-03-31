---
phase: 01-test-infrastructure
plan: 01
subsystem: api
tags: [fastify, logging, pino, error-handling, promise]

# Dependency graph
requires: []
provides:
  - All 4 silent .catch(() => {}) patterns replaced with structured app.log.error logging
  - API key lastUsedAt failure logging in auth.ts (via req.server.log.error)
  - Overtime account recalculation failure logging in overtime.ts
  - NFC card lastUsedAt failure logging in time-entries.ts
  - Terminal API key lastUsedAt failure logging in terminals.ts
affects: [01-04-eslint-no-floating-promises]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Logged fire-and-forget: .catch((err: unknown) => app.log.error({ err }, 'context message')) for silent async side-effects"
    - "Middleware logger ref: req.server.log.error (not app.log.error) in auth middleware that lacks app scope"

key-files:
  created: []
  modified:
    - apps/api/src/middleware/auth.ts
    - apps/api/src/routes/overtime.ts
    - apps/api/src/routes/time-entries.ts
    - apps/api/src/routes/terminals.ts

key-decisions:
  - "Use req.server.log.error instead of app.log.error in auth middleware (no app in scope)"
  - "Type catch callback err as unknown for TypeScript strict compliance"

patterns-established:
  - "Logged fire-and-forget: preserve async semantics while adding error visibility"

requirements-completed: [AUDIT-01]

# Metrics
duration: 8min
completed: 2026-03-30
---

# Phase 01 Plan 01: Silent Catch Elimination Summary

**4 silent `.catch(() => {})` patterns replaced with structured `app.log.error` / `req.server.log.error` logging across API middleware and routes**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-30T09:10:49Z
- **Completed:** 2026-03-30T09:18:30Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Replaced all 4 silent catch blocks in apps/api/src — zero `.catch(() => {})` patterns remain
- API key `lastUsedAt` update failures now logged with structured context via `req.server.log.error`
- Overtime account recalculation failures now logged via `app.log.error`
- NFC card and terminal API key `lastUsedAt` failures now logged via `app.log.error`

## Task Commits

Each task was committed atomically:

1. **Task 1: Replace silent catches in auth.ts and overtime.ts** - `2f1622c` (fix)
2. **Task 2: Replace silent catches in time-entries.ts and terminals.ts; fix auth.ts logger ref** - `c4f7d5e` (fix)

**Plan metadata:** (committed with final docs commit)

## Files Created/Modified

- `apps/api/src/middleware/auth.ts` - API key lastUsedAt error logging via req.server.log.error
- `apps/api/src/routes/overtime.ts` - Overtime account recalculation error logging
- `apps/api/src/routes/time-entries.ts` - NFC card lastUsedAt error logging
- `apps/api/src/routes/terminals.ts` - Terminal API key lastUsedAt error logging

## Decisions Made

- Used `req.server.log.error` in `auth.ts` middleware rather than `app.log.error` because auth middleware functions receive `req: FastifyRequest` / `reply: FastifyReply` parameters without access to the `app` FastifyInstance directly. The server is accessible via `req.server`.
- Added explicit `err: unknown` type annotation on catch callback parameters to satisfy TypeScript strict mode (`noImplicitAny`).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected logger reference in auth.ts**
- **Found during:** Task 2 verification (TypeScript typecheck)
- **Issue:** Plan specified `app.log.error` for auth.ts, but the middleware function has no `app` variable in scope — only `req` and `reply`. TypeScript reported `TS2304: Cannot find name 'app'`.
- **Fix:** Changed to `req.server.log.error({ err }, "Failed to update API key lastUsedAt")`. Added `err: unknown` type annotation to resolve `TS7006: Parameter 'err' implicitly has an 'any' type`.
- **Files modified:** apps/api/src/middleware/auth.ts
- **Verification:** `pnpm --filter @clokr/api typecheck` — no new errors introduced by this change
- **Committed in:** `c4f7d5e` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug in plan's suggested code)
**Impact on plan:** Single necessary correction to make the plan's intent work correctly. No scope creep.

## Issues Encountered

- TypeScript typecheck reveals 34 pre-existing errors in the codebase (Prisma model mismatches in `api-keys.ts`, `auth.ts`, `settings.ts` — `ApiKey` model missing from generated client). These are pre-existing and out of scope for this plan.

## Known Stubs

None - all changes are complete implementations, no stubs or placeholders.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Zero silent catch blocks in apps/api/src — prerequisite for enabling `no-floating-promises` ESLint rule (Plan 04) is now met
- Pattern established: fire-and-forget async side-effects use `.catch((err: unknown) => logger.error({ err }, "context"))` for error visibility without blocking the main request

## Self-Check: PASSED

- FOUND: apps/api/src/middleware/auth.ts
- FOUND: apps/api/src/routes/overtime.ts
- FOUND: apps/api/src/routes/time-entries.ts
- FOUND: apps/api/src/routes/terminals.ts
- FOUND commit: 2f1622c
- FOUND commit: c4f7d5e
- CONFIRMED: Zero silent catch blocks
- CONFIRMED: log.error present in all 4 modified files

---
*Phase: 01-test-infrastructure*
*Completed: 2026-03-30*
