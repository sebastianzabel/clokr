# Phase 1: Test Infrastructure - Context

**Gathered:** 2026-03-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Establish reliable test infrastructure: isolate test database, wire Playwright storageState for auth reuse, enforce Vitest coverage thresholds, enable blocking ESLint `no-floating-promises`, eliminate all silent `.catch(() => {})` patterns, and fix the Docker seed script (#119).

</domain>

<decisions>
## Implementation Decisions

### Test Database Isolation

- **D-01:** Use the same PostgreSQL instance with a separate schema (not a separate container). Local dev uses `test` schema via `TEST_DATABASE_URL` with `?schema=test` parameter.
- **D-02:** Production deployment is on k3s cluster via GitHub Actions — CI test isolation follows the same pattern (same PG, separate schema).

### Test Cleanup Strategy

- **D-03:** Claude's choice — select the best cleanup approach based on Prisma 7 compatibility. Research should evaluate truncate-per-suite vs transaction rollback given Prisma's connection model and the audit-proof requirement (audit log assertions must survive test transactions).

### Coverage Thresholds

- **D-04:** Measure baseline first, then set thresholds slightly above current coverage. Don't set aspirational targets that break CI immediately.

### ESLint Hardening

- **D-05:** Enable `@typescript-eslint/no-floating-promises` as error (not warn). This directly addresses the known `.catch(() => {})` tech debt.

### Silent Failure Elimination

- **D-06:** Replace all `.catch(() => {})` with `app.log.error({ err }, "context message")` at the 4 confirmed locations plus any others found during implementation.

### Docker Seed Fix (GitHub #119)

- **D-07:** Fix seed compilation for pnpm@10 + Prisma 7. Must work in both local Docker and k3s production images.

### Claude's Discretion

- Exact coverage threshold numbers (after baseline measurement)
- Additional ESLint rules beyond `no-floating-promises` if beneficial
- Playwright `storageState` implementation details
- Test cleanup approach (truncate vs rollback)

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Test Setup

- `apps/api/src/__tests__/setup.ts` — Current shared test setup (app instance, seeding, cleanup)
- `apps/api/vitest.config.ts` — Vitest configuration
- `apps/e2e/playwright.config.ts` — Playwright configuration
- `apps/e2e/tests/helpers.ts` — E2E login/logout helpers (to be replaced by storageState)

### ESLint

- `eslint.config.js` — Root ESLint flat config

### Docker

- `docker-compose.yml` — Docker Compose configuration
- `packages/db/prisma/schema.prisma` — Prisma schema (for test DB setup)

### Known Issues

- `.planning/codebase/CONCERNS.md` — Tech debt details (silent failures, shared test DB)
- `.planning/research/PITFALLS.md` — Research on common mistakes

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `apps/api/src/__tests__/setup.ts` — Test lifecycle management (needs modification for schema isolation)
- `apps/e2e/tests/helpers.ts` — Login helper (will be replaced by storageState but pattern is useful)
- `eslint.config.js` — Existing flat config to extend

### Established Patterns

- Vitest with `fileParallelism: false` (workaround for shared DB — can be re-evaluated after isolation)
- Fastify `app.inject()` for route-level integration tests
- Prisma client singleton in tests via setup.ts
- Husky pre-commit hook runs lint-staged (ESLint + Prettier)

### Integration Points

- `docker-compose.yml` — May need test service or schema setup
- `packages/db/prisma/schema.prisma` — Schema push to test schema
- `.env` / `.env.test` — TEST_DATABASE_URL configuration
- `apps/api/package.json` — Test scripts
- `apps/e2e/package.json` — E2E scripts

</code_context>

<specifics>
## Specific Ideas

- Local dev and CI both use same PG with separate schema — keep it simple
- Production is on k3s, deployed via GitHub Actions
- Docker seed fix is for GitHub #119 specifically

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

_Phase: 01-test-infrastructure_
_Context gathered: 2026-03-30_
