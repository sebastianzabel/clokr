---
phase: 01-test-infrastructure
plan: 02
subsystem: infra
tags: [docker, typescript, prisma, seed, pnpm]

# Dependency graph
requires: []
provides:
  - packages/db/tsconfig.seed.json for deterministic CJS seed compilation
  - seed:build script in packages/db/package.json
  - Dockerfile uses pnpm --filter @clokr/db run seed:build (no silent suppression)
  - docker-entrypoint.sh fails loudly if dist/src/seed.js is missing
affects: [docker-build, seed-execution, ci]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dedicated tsconfig.seed.json (rootDir=., module=commonjs) avoids broken relative imports from src/ after compilation"
    - "pnpm workspace filter for build steps keeps seed compilation consistent with monorepo conventions"

key-files:
  created:
    - packages/db/tsconfig.seed.json
  modified:
    - packages/db/package.json
    - apps/api/Dockerfile
    - apps/api/docker-entrypoint.sh

key-decisions:
  - "rootDir=. (not src) preserves ../generated/client import path in compiled dist/src/seed.js output"
  - "Remove tsx fallback from entrypoint — compilation failure at build time must surface loudly, not at runtime"

patterns-established:
  - "Seed compilation: always via package script (seed:build), never inline tsc with error suppression"

requirements-completed:
  - AUDIT-03

# Metrics
duration: 8min
completed: 2026-03-30
---

# Phase 01 Plan 02: Docker Seed Compilation Fix Summary

**Replaced silently-suppressed inline tsc seed compilation with a dedicated tsconfig.seed.json + package script, and hardened entrypoint to exit 1 instead of falling back to tsx**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-30T09:30:00Z
- **Completed:** 2026-03-30T09:38:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Created `packages/db/tsconfig.seed.json` with `module: commonjs`, `rootDir: .` so the compiled `dist/src/seed.js` retains the correct relative path to `../generated/client`
- Added `seed:build` script to `packages/db/package.json` — Dockerfile now invokes it via `pnpm --filter @clokr/db run seed:build`
- Removed the `2>/dev/null || true` suppression from the Dockerfile seed compile step — build now fails loudly on TypeScript errors
- Removed `npx tsx` fallback from `docker-entrypoint.sh` — entrypoint exits 1 with a clear message if `dist/src/seed.js` is absent

## Task Commits

Each task was committed atomically:

1. **Task 1: Add tsconfig.seed.json and seed:build script to packages/db** - `c0ecd6d` (chore)
2. **Task 2: Update Dockerfile and docker-entrypoint.sh to use seed:build** - `91ab00f` (fix)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `packages/db/tsconfig.seed.json` - Dedicated CJS tsconfig for seed compilation with rootDir=. and outDir=dist
- `packages/db/package.json` - Added seed:build script
- `apps/api/Dockerfile` - Replaced inline tsc + suppression with pnpm filter seed:build
- `apps/api/docker-entrypoint.sh` - Changed seed path from dist/seed.js to dist/src/seed.js; removed tsx fallback; added exit 1 on missing file

## Decisions Made
- `rootDir: "."` instead of `"src"` — seed.ts imports `../generated/client`; with rootDir=src that relative path would be broken in the compiled output. rootDir=. preserves the `src/` level, outputting to `dist/src/seed.js`.
- Remove tsx fallback entirely — a missing compiled seed means the Docker build silently failed. Failing at runtime is worse than failing at build time. Entrypoint now exits loudly so the problem is caught immediately.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Docker build now fails loudly if seed TypeScript compilation fails — surfaces errors at build time, not runtime
- Entrypoint hardened: `dist/src/seed.js` must exist or container startup fails with a clear error message
- Ready for other Phase 01 plans — no dependencies blocked by this change

---
*Phase: 01-test-infrastructure*
*Completed: 2026-03-30*
